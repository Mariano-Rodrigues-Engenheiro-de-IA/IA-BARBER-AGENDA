import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// Ferramenta de diagnóstico ADMIN-ONLY: faz GET em endpoints do AppBarber
// (whitelist) usando as credenciais do tenant, sem nunca devolver a API key.
function buildCorsHeaders(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

const DEFAULT_BASE_URL = "https://proxy.zayloia.com";
const ALLOWED_PREFIXES = [
  "/v1/invoice",
  "/v1/services",
  "/v1/professional-list",
  "/v1/availability",
  "/v1/appointments",
  "/v1/client",
  "/v1/customer",
  "/v1/person",
  // Diagnóstico do cadastro de cliente (GET /v1/establishment/clients).
  "/v1/establishment/clients",
];

Deno.serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const anonClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await anonClient.auth.getUser();
    if (!user) return json({ error: "Unauthorized" }, 401);
    const { data: isAdmin } = await supabase.rpc("has_role", { _user_id: user.id, _role: "admin" });
    if (!isAdmin) return json({ error: "Forbidden" }, 403);

    const body = await req.json().catch(() => ({}));
    const { tenant_id, requests } = body as {
      tenant_id?: string;
      requests?: Array<{ path: string; query?: Record<string, string | number>; method?: string; payload?: Record<string, unknown> }>;
    };
    if (!tenant_id || !Array.isArray(requests) || requests.length === 0) {
      return json({ error: "tenant_id e requests[] são obrigatórios" }, 400);
    }

    const { data: tenant } = await supabase
      .from("tenants")
      .select("appbarber_api_key, appbarber_establishment_code, appbarber_base_url")
      .eq("id", tenant_id)
      .single();
    if (!tenant) return json({ error: "Tenant não encontrado" }, 404);

    const apiKey = (tenant.appbarber_api_key || "").trim();
    const estCode = (tenant.appbarber_establishment_code || "").trim();
    const baseUrl = ((tenant.appbarber_base_url || DEFAULT_BASE_URL).trim()).replace(/\/+$/, "");
    if (!apiKey || !estCode) return json({ error: "Credenciais AppBarber incompletas" }, 400);

    const out: any[] = [];
    for (const r of requests.slice(0, 12)) {
      const path = String(r.path || "");
      if (!ALLOWED_PREFIXES.some((p) => path.startsWith(p))) {
        out.push({ path, error: "path fora da whitelist" });
        continue;
      }
      const filterPhone = String((r.query as any)?._filter_phone || "");
      const filterName = String((r.query as any)?._filter_name || "").toLowerCase();
      const params = new URLSearchParams();
      params.set("establishment_code", estCode);
      for (const [k, v] of Object.entries(r.query || {})) {
        if (k === "_filter_phone" || k === "_filter_name") continue;
        if (v === undefined || v === null || v === "") continue;
        params.set(k, String(v));
      }
      const url = `${baseUrl}${path}?${params.toString()}`;
      const method = String(r.method || "GET").toUpperCase();
      if (!["GET", "POST", "PUT", "DELETE"].includes(method)) {
        out.push({ path, error: "método não permitido" });
        continue;
      }
      try {
        const res = await fetch(url, {
          method,
          headers: {
            "X-API-Key": apiKey,
            Accept: "application/json",
            ...(method === "GET" ? {} : { "Content-Type": "application/json" }),
          },
          ...(method === "GET" ? {} : { body: JSON.stringify(r.payload ?? {}) }),
        });
        const text = await res.text();
        if (filterName) {
          let parsed: any = null;
          try { parsed = JSON.parse(text); } catch { /* noop */ }
          const rows: any[] = Array.isArray(parsed?.data) ? parsed.data : [];
          const matches = rows.filter((row) => JSON.stringify(row).toLowerCase().includes(filterName));
          out.push({ path, query: r.query || {}, status: res.status, total_rows: rows.length, matches });
        } else if (filterPhone) {
          const core = filterPhone.replace(/\D/g, "").slice(-8);
          let parsed: any = null;
          try { parsed = JSON.parse(text); } catch { /* noop */ }
          const rows: any[] = Array.isArray(parsed?.data) ? parsed.data : [];
          const matches = rows.filter((row) => String(row?.client_phone || "").replace(/\D/g, "").slice(-8) === core);
          out.push({ path, query: r.query || {}, status: res.status, total_rows: rows.length, filter_core: core, matches });
        } else {
          out.push({ path, query: r.query || {}, status: res.status, body: text.slice(0, 4000) });
        }
      } catch (e: any) {
        out.push({ path, query: r.query || {}, error: e?.message || String(e) });
      }
    }

    return json({ base_url: baseUrl, establishment_code: estCode, results: out });
  } catch (err: any) {
    return json({ error: err?.message || String(err) }, 500);
  }
});
