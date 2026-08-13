import { createClient } from "npm:@supabase/supabase-js@2";

// v2 — forçando redeploy: a versão anterior desta função ficou presa há
// 15 dias no Supabase, sem refletir a correção de CORS aplicada hoje.
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
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing Authorization" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Verifica que o caller é admin — valida o JWT com o cliente de servico
    // (nao depende de SUPABASE_ANON_KEY, ausente no runtime das Edge Functions).
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const authClient = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: userData, error: userErr } = await authClient.auth.getUser(token);
    if (userErr || !userData.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: isAdmin } = await admin.rpc("has_role", {
      _user_id: userData.user.id, _role: "admin",
    });
    if (!isAdmin) {
      return new Response(JSON.stringify({ error: "Apenas administradores" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { tenant_id, email, password } = body ?? {};
    if (!tenant_id || !email) {
      return new Response(JSON.stringify({ error: "tenant_id e email obrigatórios" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const tempPassword = password || generatePassword();

    // Cria ou reaproveita usuário
    let userId: string | null = null;
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email, password: tempPassword, email_confirm: true,
    });
    if (createErr) {
      // Pode já existir; tenta achar
      const { data: list } = await admin.auth.admin.listUsers();
      const existing = list?.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
      if (!existing) {
        return new Response(JSON.stringify({ error: createErr.message }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      userId = existing.id;
      // reset password
      await admin.auth.admin.updateUserById(userId, { password: tempPassword });
    } else {
      userId = created.user!.id;
    }

    // Garante role 'client'
    await admin.from("user_roles").upsert(
      { user_id: userId, role: "client" },
      { onConflict: "user_id,role" } as any,
    );

    // Vínculo tenant_users (1:1, UNIQUE em user_id)
    const { error: linkErr } = await admin
      .from("tenant_users")
      .upsert({ user_id: userId, tenant_id }, { onConflict: "user_id" });
    if (linkErr) {
      return new Response(JSON.stringify({ error: linkErr.message }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Permissões padrão (integrations = read_only; resto = editable)
    const modules = [
      { module: "overview", visibility: "editable" },
      { module: "conversations", visibility: "editable" },
      { module: "followups", visibility: "editable" },
      { module: "crm", visibility: "editable" },
      { module: "ai_prompt", visibility: "editable" },
      { module: "ai_knowledge", visibility: "editable" },
      { module: "integrations", visibility: "read_only" },
      { module: "company_data", visibility: "editable" },
      { module: "tools", visibility: "editable" },
      { module: "connection", visibility: "editable" },
    ].map((m) => ({ tenant_id, ...m }));
    await admin.from("tenant_permissions").upsert(modules, { onConflict: "tenant_id,module" });

    await admin.from("audit_logs").insert({
      tenant_id, user_id: userData.user.id, actor_role: "admin",
      action: "create_client_user", entity: "auth.users", entity_id: userId,
      after: { email },
    });

    return new Response(
      JSON.stringify({ user_id: userId, email, password: tempPassword }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function generatePassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let p = "";
  const arr = new Uint32Array(12);
  crypto.getRandomValues(arr);
  for (const n of arr) p += chars[n % chars.length];
  return p;
}
