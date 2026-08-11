import { createClient } from "npm:@supabase/supabase-js@2";

// v2 — forçando redeploy: esta função tinha 18 tentativas com 0% de
// sucesso, presa numa versão de 15 dias atrás sem a correção de CORS.
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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

Deno.serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req.headers.get("origin"));
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization" }, 401);


    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: isAdmin } = await admin.rpc("has_role", {
      _user_id: userData.user.id, _role: "admin",
    });
    if (!isAdmin) return json({ error: "Apenas administradores" }, 403);

    const body = await req.json();
    const { action, tenant_id, user_id, password } = body ?? {};

    if (action === "list") {
      if (!tenant_id) return json({ error: "tenant_id obrigatório" }, 400);
      const { data: links } = await admin
        .from("tenant_users").select("user_id,created_at").eq("tenant_id", tenant_id);
      const ids = (links ?? []).map((l: any) => l.user_id);
      const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
      const byId = new Map((list?.users ?? []).map((u) => [u.id, u.email]));
      const users = (links ?? []).map((l: any) => ({
        user_id: l.user_id,
        created_at: l.created_at,
        email: byId.get(l.user_id) ?? null,
      }));
      return json({ users });
    }

    if (action === "delete") {
      if (!tenant_id || !user_id) return json({ error: "tenant_id e user_id obrigatórios" }, 400);
      await admin.from("tenant_users").delete().eq("tenant_id", tenant_id).eq("user_id", user_id);
      await admin.from("user_roles").delete().eq("user_id", user_id).eq("role", "client");
      const { error: delErr } = await admin.auth.admin.deleteUser(user_id);
      if (delErr) return json({ error: delErr.message }, 400);
      await admin.from("audit_logs").insert({
        tenant_id, user_id: userData.user.id, actor_role: "admin",
        action: "delete_client_user", entity: "auth.users", entity_id: user_id,
      });
      return json({ ok: true });
    }

    if (action === "set_password") {
      if (!user_id || !password) return json({ error: "user_id e password obrigatórios" }, 400);
      if (typeof password !== "string" || password.length < 6) {
        return json({ error: "Senha deve ter pelo menos 6 caracteres" }, 400);
      }
      const { error: updErr } = await admin.auth.admin.updateUserById(user_id, { password });
      if (updErr) {
        const msg = /weak|pwned|known to be/i.test(updErr.message)
          ? "Senha muito fraca ou já vazada em outros sites. Escolha uma senha mais forte (use letras, números e símbolos)."
          : updErr.message;
        return json({ error: msg }, 400);
      }
      await admin.from("audit_logs").insert({
        tenant_id: tenant_id ?? null, user_id: userData.user.id, actor_role: "admin",
        action: "set_client_user_password", entity: "auth.users", entity_id: user_id,
      });
      return json({ ok: true });
    }

    return json({ error: "Ação inválida" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
