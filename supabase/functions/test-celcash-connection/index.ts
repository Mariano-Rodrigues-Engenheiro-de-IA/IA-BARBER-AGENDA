import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const ALLOWED_ORIGINS = ["https://zayloia.com", "https://www.zayloia.com"];
function buildCorsHeaders(origin: string | null) {
  const allowOrigin = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
}

function baseUrl(env: string) {
  return env === "production"
    ? "https://api-celcash.celcoin.com.br/v2"
    : "https://api-celcash.sandbox.cel.cash/v2";
}

Deno.serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const anonClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await anonClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: isAdmin } = await supabase.rpc("has_role", {
      _user_id: user.id, _role: "admin",
    });
    if (!isAdmin) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { tenant_id } = await req.json();
    if (!tenant_id) {
      return new Response(JSON.stringify({ error: "tenant_id is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: tenant, error: tErr } = await supabase
      .from("tenants")
      .select("celcash_galax_id, celcash_galax_hash, celcash_env, celcash_enabled, name")
      .eq("id", tenant_id)
      .single();

    if (tErr || !tenant) {
      return new Response(JSON.stringify({ error: "Tenant not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!tenant.celcash_galax_id || !tenant.celcash_galax_hash) {
      return new Response(JSON.stringify({
        success: false,
        message: "Credenciais CelCash não configuradas (galaxId/galaxHash).",
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const env = tenant.celcash_env || "sandbox";
    const url = `${baseUrl(env)}/token`;
    const basic = btoa(`${tenant.celcash_galax_id}:${tenant.celcash_galax_hash}`);

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${basic}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        scope: "customers.read subscriptions.read transactions.read charges.read",
      }),
    });

    const rawText = await resp.text();
    let payload: any = rawText;
    try { payload = JSON.parse(rawText); } catch { /* keep text */ }

    if (resp.ok && payload?.access_token) {
      return new Response(JSON.stringify({
        success: true,
        message: `Conexão CelCash (${env}) bem-sucedida! Token válido por ${payload.expires_in || 600}s.`,
        env,
        expires_in: payload.expires_in,
        scope: payload.scope,
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({
      success: false,
      message: `Falha CelCash (HTTP ${resp.status}). ${typeof payload === "object" ? (payload?.error_description || payload?.error || JSON.stringify(payload)) : String(payload).slice(0, 200)}`,
      status: resp.status,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message || "Internal server error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
