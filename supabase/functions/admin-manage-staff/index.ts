import { createClient } from "npm:@supabase/supabase-js@2";

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

function generatePassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let p = "";
  const arr = new Uint32Array(12);
  crypto.getRandomValues(arr);
  for (const n of arr) p += chars[n % chars.length];
  return p;
}

Deno.serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization" }, 401);

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Valida o JWT com getClaims (compatível com signing keys assimétricas);
    // getUser() falhava com 401 nos tokens novos.
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: claimsData, error: claimsErr } = await userClient.auth.getClaims(token);
    const callerId = claimsData?.claims?.sub;
    if (claimsErr || typeof callerId !== "string") {
      return json({ error: "Sessão inválida ou expirada" }, 401);
    }
    const userData = { user: { id: callerId } };

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    // Admin sempre pode; colaborador só se o módulo "staff" estiver marcado
    // manualmente no painel (staff_has_module já devolve true para admin).
    const { data: allowed } = await admin.rpc("staff_has_module", {
      _user_id: userData.user.id, _module: "staff",
    });
    if (!allowed) return json({ error: "Sem permissão para gerenciar colaboradores" }, 403);
    const { data: isAdmin } = await admin.rpc("has_role", {
      _user_id: userData.user.id, _role: "admin",
    });

    const body = await req.json();
    const { action, email, password, user_id } = body ?? {};

    if (action === "list_staff") {
      const { data: roles } = await admin
        .from("user_roles").select("user_id,created_at").eq("role", "staff");
      const ids = new Set((roles ?? []).map((r: any) => r.user_id));
      const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
      const users = (list?.users ?? [])
        .filter((u) => ids.has(u.id))
        .map((u) => {
          const row = (roles ?? []).find((r: any) => r.user_id === u.id);
          return { user_id: u.id, email: u.email ?? null, created_at: row?.created_at ?? u.created_at };
        });
      return json({ users });
    }

    if (action === "resolve_users") {
      const ids: string[] = Array.isArray(body?.user_ids) ? body.user_ids.filter((s: any) => typeof s === "string") : [];
      if (ids.length === 0) return json({ users: {} });
      const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
      const map: Record<string, string | null> = {};
      for (const u of list?.users ?? []) if (ids.includes(u.id)) map[u.id] = u.email ?? null;
      return json({ users: map });
    }

    if (action === "invite") {
      if (!email) return json({ error: "email obrigatório" }, 400);
      if (password && (typeof password !== "string" || password.length < 6)) {
        return json({ error: "Senha deve ter pelo menos 6 caracteres" }, 400);
      }
      const tempPassword = password || generatePassword();
      let userId: string | null = null;
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email, password: tempPassword, email_confirm: true,
      });
      if (createErr) {
        const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
        const existing = list?.users.find((u) => u.email?.toLowerCase() === String(email).toLowerCase());
        if (!existing) return json({ error: createErr.message }, 400);
        userId = existing.id;
        await admin.auth.admin.updateUserById(userId, { password: tempPassword });
      } else {
        userId = created.user!.id;
      }
      await admin.from("user_roles").upsert(
        { user_id: userId, role: "staff" }, { onConflict: "user_id,role" } as any
      );
      await admin.from("audit_logs").insert({
        user_id: userData.user.id, actor_role: "admin",
        action: "invite_staff", entity: "auth.users", entity_id: userId, after: { email },
      });
      return json({ user_id: userId, email, password: tempPassword });
    }

    if (action === "delete") {
      if (!user_id) return json({ error: "user_id obrigatório" }, 400);
      await admin.from("staff_tenant_access").delete().eq("user_id", user_id);
      await admin.from("user_roles").delete().eq("user_id", user_id).eq("role", "staff");
      // Only remove the auth user if they have no other roles left
      const { data: leftover } = await admin.from("user_roles").select("role").eq("user_id", user_id);
      if (!leftover || leftover.length === 0) {
        const { error: delErr } = await admin.auth.admin.deleteUser(user_id);
        if (delErr) return json({ error: delErr.message }, 400);
      }
      await admin.from("audit_logs").insert({
        user_id: userData.user.id, actor_role: "admin",
        action: "delete_staff", entity: "auth.users", entity_id: user_id,
      });
      return json({ ok: true });
    }

    return json({ error: "Ação inválida" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
