// Proxy para GET /api/public/ai/funnels do CRM Zetta (crm.zayloia.com).
// Existe porque o navegador bloqueia a chamada direta por CORS (a API do
// Zetta só libera origem do WhatsApp Web / extensão Chrome) — essa function
// roda do lado do servidor, sem essa restrição.
import { createClient } from "npm:@supabase/supabase-js@2.49.1";

const ALLOWED_ORIGINS = ["https://zayloia.com", "https://www.zayloia.com"];
const ZETTA_API_BASE = "https://crm.zayloia.com";

function buildCorsHeaders(origin: string | null) {
  const allowOrigin = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
}

Deno.serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // ===== AUTHENTICATION ===== (mesmo padrão de move-crm-lead)
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
    const { crm_zetta_token } = await req.json();
    if (!crm_zetta_token || typeof crm_zetta_token !== "string") {
      return new Response(JSON.stringify({ error: "Token do CRM ausente" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const res = await fetch(`${ZETTA_API_BASE}/api/public/ai/funnels`, {
      headers: { Authorization: `Bearer ${crm_zetta_token}` },
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
