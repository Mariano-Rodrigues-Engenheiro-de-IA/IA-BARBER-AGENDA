import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

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
  };
}

const DEFAULT_BASE_URL = "https://proxy.zayloia.com";

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

    const body = await req.json().catch(() => ({}));
    const { tenant_id } = body;
    if (!tenant_id) {
      return new Response(JSON.stringify({ error: "tenant_id is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: tenant, error: tErr } = await supabase
      .from("tenants")
      .select("appbarber_api_key, appbarber_establishment_code, appbarber_base_url")
      .eq("id", tenant_id)
      .single();

    if (tErr || !tenant) {
      return new Response(JSON.stringify({ success: false, message: "Tenant não encontrado" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const apiKey = (tenant.appbarber_api_key || "").trim();
    const estCode = (tenant.appbarber_establishment_code || "").trim();
    const baseUrl = ((tenant.appbarber_base_url || DEFAULT_BASE_URL).trim()).replace(/\/+$/, "");

    if (!apiKey || !estCode) {
      return new Response(JSON.stringify({
        success: false,
        message: "Credenciais AppBarber incompletas (x-api-key e establishment_code são obrigatórios).",
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Try listing services as a smoke test
    const url = `${baseUrl}/v1/services?establishment_code=${encodeURIComponent(estCode)}`;
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: {
          "X-API-Key": apiKey,
          "Accept": "application/json",
        },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({
        success: false,
        message: `Falha de rede ao chamar ${url}: ${e?.message || e}`,
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const elapsed = Date.now() - started;
    const text = await res.text();
    const snippet = text.length > 600 ? text.slice(0, 600) + "…" : text;

    if (res.status === 403 || /Attention Required|Cloudflare/i.test(text)) {
      return new Response(JSON.stringify({
        success: false,
        message: `IP ainda bloqueado pelo AppBarber (HTTP ${res.status}, ${elapsed}ms). Aguardando whitelist do IP do proxy.`,
        details: snippet,
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (!res.ok) {
      return new Response(JSON.stringify({
        success: false,
        message: `HTTP ${res.status} do AppBarber (${elapsed}ms).`,
        details: snippet,
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Try parse to detect placeholder [{}]
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch {}
    const isPlaceholder = Array.isArray(parsed) && parsed.length === 1 &&
      parsed[0] && typeof parsed[0] === "object" && Object.keys(parsed[0]).length === 0;

    if (isPlaceholder) {
      return new Response(JSON.stringify({
        success: false,
        message: `Resposta vazia/placeholder do AppBarber (HTTP 200, ${elapsed}ms). Verifique se a URL base e o endpoint /v1/services estão corretos.`,
        details: snippet,
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const count = Array.isArray(parsed) ? parsed.length : (parsed?.data?.length ?? "—");
    return new Response(JSON.stringify({
      success: true,
      message: `Conexão AppBarber OK (HTTP 200, ${elapsed}ms). Serviços retornados: ${count}.`,
      details: snippet,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
