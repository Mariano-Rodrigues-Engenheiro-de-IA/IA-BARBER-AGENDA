import { createClient } from "npm:@supabase/supabase-js@2";
import { getDefaultProviderPrompt } from "../_shared/provider-prompts.ts";

// A seguranca real dessas funcoes vem da autenticacao (JWT + checagem de
// admin, verificada dentro do handler) - o CORS aqui so existe pra
// permitir a chamada do navegador, entao ecoa a origem real da chamada em
// vez de manter uma lista fixa de dominios (que estava causando bloqueio
// silencioso: o dominio real do painel - preview da Lovable - nunca batia
// com a lista fixa "zayloia.com").
function buildCorsHeaders(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

const PROVIDERS = ["global", "auditor", "trinks", "onebeleza", "frizzar", "bemp", "appbarber", "none"];

const PROVIDER_LABELS: Record<string, string> = {
  global: "🌐 Global (todas as IAs)",
  auditor: "🕵️ Monitor 24h (IA auditora)",
  trinks: "Trinks",
  onebeleza: "One Beleza",
  frizzar: "Frizzar",
  bemp: "Bemp",
  appbarber: "AppBarber",
  none: "Sem API (link de agendamento)",
};

Deno.serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    if (!authHeader.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
    const token = authHeader.replace("Bearer ", "");

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    let userId: string | null = null;
    const auth = userClient.auth as typeof userClient.auth & {
      getClaims?: (jwt?: string) => Promise<{ data: { claims?: { sub?: string } } | null; error: unknown }>;
    };

    if (typeof auth.getClaims === "function") {
      const { data: claimsData, error: claimsErr } = await auth.getClaims(token);
      if (!claimsErr && claimsData?.claims?.sub) userId = claimsData.claims.sub;
    }

    if (!userId) {
      const { data: userData, error: userErr } = await userClient.auth.getUser(token);
      if (!userErr && userData?.user?.id) userId = userData.user.id;
    }

    if (!userId) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(supabaseUrl, serviceKey);
    const { data: roleRows } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", userId);
    const roles = new Set((roleRows || []).map((r: any) => r.role));
    const isAdmin = roles.has("admin");
    let allowed = isAdmin;
    if (!allowed && roles.has("staff")) {
      const { data: mod } = await admin
        .from("staff_module_access")
        .select("module")
        .eq("user_id", userId)
        .eq("module", "prompts")
        .maybeSingle();
      allowed = !!mod;
    }
    if (!allowed) return json({ error: "Forbidden" }, 403);
    // Escrita liberada para quem tem o módulo "prompts" marcado no painel
    // (admin sempre; colaborador só se o admin marcar).
    void isAdmin;

    if (req.method === "GET") {
      const { data: rows } = await admin.from("provider_prompts").select("*");
      const map = new Map<string, any>((rows || []).map((r: any) => [r.provider, r]));
      const result = PROVIDERS.map((p) => {
        const row = map.get(p);
        return {
          provider: p,
          label: PROVIDER_LABELS[p],
          default_content: getDefaultProviderPrompt(p),
          override_content: row?.content || "",
          has_override: !!(row?.content && String(row.content).trim().length > 0),
          updated_at: row?.updated_at || null,
        };
      });
      return json({ providers: result });
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const provider = String(body?.provider || "").trim();
      const content = typeof body?.content === "string" ? body.content : "";
      if (!PROVIDERS.includes(provider)) return json({ error: "Invalid provider" }, 400);

      const { error } = await admin
        .from("provider_prompts")
        .upsert({
          provider,
          content,
          updated_by: userId,
          updated_at: new Date().toISOString(),
        }, { onConflict: "provider" });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (req.method === "DELETE") {
      const body = await req.json().catch(() => ({}));
      const provider = String(body?.provider || "").trim();
      if (!PROVIDERS.includes(provider)) return json({ error: "Invalid provider" }, 400);
      const { error } = await admin.from("provider_prompts").delete().eq("provider", provider);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (e: any) {
    return json({ error: e?.message || "Unknown error" }, 500);
  }
});
