// Proxy para GET /api/public/ai/funnels do CRM Zetta, pensado para ser
// chamado pelo painel do CLIENTE (não admin) — recebe só o tenant_id, busca
// o token internamente com service role, e nunca deixa o token trafegar de
// volta pro navegador do cliente. Diferente de crm-zetta-list-funnels
// (usada no admin, que já tem o token em mãos pra testar antes de salvar).
import { createClient } from "npm:@supabase/supabase-js@2.49.1";

const ZETTA_API_BASE = "https://crm.zayloia.com";

function buildCorsHeaders(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    Vary: "Origin",
  };
}

Deno.serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const authClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const jwt = authHeader.replace("Bearer ", "");
  const { data: userData, error: userErr } = await authClient.auth.getUser(jwt);
  if (userErr || !userData?.user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const { tenant_id } = await req.json();
    if (!tenant_id || typeof tenant_id !== "string") {
      return new Response(JSON.stringify({ error: "tenant_id ausente" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const svc = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Confirma que o usuário logado tem acesso a esse tenant (cliente
    // vinculado, ou admin) — sem isso, qualquer usuário logado poderia
    // consultar o CRM de qualquer outro estabelecimento só sabendo o id.
    const { data: isAdmin } = await svc.rpc("has_role", { _user_id: userData.user.id, _role: "admin" });
    if (!isAdmin) {
      const { data: link } = await svc
        .from("tenant_users")
        .select("id")
        .eq("tenant_id", tenant_id)
        .eq("user_id", userData.user.id)
        .maybeSingle();
      if (!link) {
        return new Response(JSON.stringify({ error: "Sem acesso a este estabelecimento" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const { data: tenant } = await svc.from("tenants").select("crm_zetta_token").eq("id", tenant_id).maybeSingle();
    const token = tenant?.crm_zetta_token;
    if (!token) {
      return new Response(JSON.stringify({ error: "Nenhum token configurado para este estabelecimento ainda." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const safeToken = String(token).replace(/[^\x21-\x7E]/g, "");
    if (!safeToken) {
      return new Response(JSON.stringify({ error: "Token do CRM inválido" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const res = await fetch(`${ZETTA_API_BASE}/api/public/ai/funnels`, {
      headers: { Authorization: `Bearer ${safeToken}` },
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = { ok: false, error: text.slice(0, 300) };
    }
    if (!res.ok || json?.ok === false) {
      return new Response(JSON.stringify({ error: json?.error || `Falha ao consultar o CRM (HTTP ${res.status})` }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Nunca devolve o token — só a lista de funis.
    return new Response(JSON.stringify({ funnels: json.funnels ?? [] }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
