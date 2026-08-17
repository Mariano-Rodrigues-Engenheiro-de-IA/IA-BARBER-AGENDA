// Gera um link mágico de acesso (Supabase Auth magic link) para o
// usuário do tenant vinculado a um barbershop_id do CRM Zaylo — permite
// que o cliente clique "Acessar minha IA" dentro do CRM e caia direto,
// já logado, no painel dele aqui, sem precisar digitar senha.
//
// Protegida por chave secreta compartilhada (CRM_BRIDGE_SHARED_SECRET,
// mesma usada nas outras pontes entre os dois projetos) — nunca pública.
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type, x-shared-secret",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const sharedSecret = Deno.env.get("CRM_BRIDGE_SHARED_SECRET");
  if (!sharedSecret || req.headers.get("x-shared-secret") !== sharedSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const { barbershop_id } = await req.json();
    if (!barbershop_id) {
      return new Response(JSON.stringify({ error: "barbershop_id ausente" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: tenant } = await supa
      .from("tenants")
      .select("id, name")
      .eq("crm_barbershop_id", barbershop_id)
      .maybeSingle();

    if (!tenant) {
      return new Response(JSON.stringify({ error: "not_linked", message: "Essa barbearia ainda não foi vinculada a uma conta da IA." }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Pega o usuário mais antigo vinculado ao tenant (o "principal").
    const { data: tenantUser } = await supa
      .from("tenant_users")
      .select("user_id")
      .eq("tenant_id", tenant.id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (!tenantUser) {
      return new Response(JSON.stringify({ error: "no_user", message: "Esse tenant não tem nenhum usuário cadastrado ainda." }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: userData, error: userErr } = await supa.auth.admin.getUserById(tenantUser.user_id);
    if (userErr || !userData?.user?.email) {
      return new Response(JSON.stringify({ error: "user_email_missing", message: "Não foi possível encontrar o e-mail do usuário." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const appUrl = Deno.env.get("APP_PUBLIC_URL") || "https://zayloia.com";
    const { data: linkData, error: linkErr } = await supa.auth.admin.generateLink({
      type: "magiclink",
      email: userData.user.email,
      options: { redirectTo: appUrl },
    });
    if (linkErr || !linkData?.properties?.action_link) {
      return new Response(JSON.stringify({ error: "link_generation_failed", message: linkErr?.message ?? "Falha ao gerar link" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ found: true, action_link: linkData.properties.action_link }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
