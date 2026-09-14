// Gera um link mágico de acesso (Supabase Auth magic link) para o
// usuário do tenant vinculado a um barbershop_id do CRM Zaylo — permite
// que o cliente clique "Acessar minha IA" dentro do CRM e caia direto,
// já logado, no painel dele aqui, sem precisar digitar senha.
//
// Protegida por chave secreta compartilhada (CRM_BRIDGE_SHARED_SECRET,
// mesma usada nas outras pontes entre os dois projetos) — nunca pública.
//
// Performance: cada uma das 4 chamadas externas tem timeout próprio e é
// medida em ms (log estruturado "sso-access-link timings"). Se o backend
// (banco ou auth) estiver lento/indisponível, a função responde 504 com
// a etapa culpada em poucos segundos, em vez de pendurar o chamador até
// o gateway cortar em 20s.
import { createClient } from "npm:@supabase/supabase-js@2";

const STEP_TIMEOUT_MS = 6000;

/** Executa uma etapa medindo o tempo e falhando rápido se estourar. */
async function timedStep<T>(
  name: string,
  timings: Record<string, number>,
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new StepTimeoutError(name)), STEP_TIMEOUT_MS)
      ),
    ]);
  } finally {
    timings[name] = Date.now() - started;
  }
}

class StepTimeoutError extends Error {
  constructor(public step: string) {
    super(`step_timeout:${step}`);
    this.name = "StepTimeoutError";
  }
}

Deno.serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type, x-shared-secret",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const requestStarted = Date.now();
  const timings: Record<string, number> = {};
  const json = (body: unknown, status = 200) => {
    timings.total = Date.now() - requestStarted;
    console.log("sso-access-link timings", JSON.stringify(timings));
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  };

  const sharedSecret = Deno.env.get("CRM_BRIDGE_SHARED_SECRET");
  if (!sharedSecret || req.headers.get("x-shared-secret") !== sharedSecret) {
    return json({ error: "Unauthorized" }, 401);
  }

  try {
    const { barbershop_id } = await req.json();
    if (!barbershop_id || typeof barbershop_id !== "string") {
      return json({ error: "barbershop_id ausente" }, 400);
    }

    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    const { data: tenant } = await timedStep("tenants", timings, async () =>
      await supa
        .from("tenants")
        .select("id, name")
        .eq("crm_barbershop_id", barbershop_id)
        .maybeSingle()
    );

    if (!tenant) {
      return json(
        { error: "not_linked", message: "Essa barbearia ainda não foi vinculada a uma conta da IA." },
        404,
      );
    }

    // Pega o usuário mais antigo vinculado ao tenant (o "principal").
    const { data: tenantUser } = await timedStep("tenant_users", timings, async () =>
      await supa
        .from("tenant_users")
        .select("user_id")
        .eq("tenant_id", tenant.id)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle()
    );

    if (!tenantUser) {
      return json(
        { error: "no_user", message: "Esse tenant não tem nenhum usuário cadastrado ainda." },
        404,
      );
    }

    const { data: userData, error: userErr } = await timedStep("get_user", timings, async () =>
      await supa.auth.admin.getUserById(tenantUser.user_id)
    );
    if (userErr || !userData?.user?.email) {
      return json(
        { error: "user_email_missing", message: "Não foi possível encontrar o e-mail do usuário." },
        500,
      );
    }

    const appUrl = Deno.env.get("APP_PUBLIC_URL") || "https://zayloia.com";
    // ?from=crm sinaliza pro front-end que esse acesso veio do CRM Zaylo —
    // usado pra decidir pra onde mandar o usuário quando ele clicar em
    // "Sair" (de volta pro CRM, não pra tela de login própria, que
    // confundiria já que ele nunca teve senha nessa conta).
    const redirectUrl = `${appUrl}${appUrl.includes("?") ? "&" : "?"}from=crm`;
    const { data: linkData, error: linkErr } = await timedStep("generate_link", timings, async () =>
      await supa.auth.admin.generateLink({
        type: "magiclink",
        email: userData.user!.email!,
        options: { redirectTo: redirectUrl },
      })
    );
    if (linkErr || !linkData?.properties?.action_link) {
      return json(
        { error: "link_generation_failed", message: linkErr?.message ?? "Falha ao gerar link" },
        500,
      );
    }

    return json({ found: true, action_link: linkData.properties.action_link });
  } catch (e) {
    if (e instanceof StepTimeoutError) {
      return json(
        {
          error: "backend_timeout",
          step: e.step,
          message: `O backend não respondeu na etapa "${e.step}" em ${STEP_TIMEOUT_MS}ms. Tente novamente.`,
        },
        504,
      );
    }
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
