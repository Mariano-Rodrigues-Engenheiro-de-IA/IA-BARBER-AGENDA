// Diagnostic edge function — tests Frizzar API connectivity for a given tenant.
// Calls a few read-only endpoints with the tenant's stored token and returns the results.
import { createClient } from "npm:@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { tenantId } = await req.json();
    if (!tenantId) {
      return new Response(JSON.stringify({ error: "tenantId required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: tenant, error } = await supabase
      .from("tenants").select("id, name, frizzar_token").eq("id", tenantId).single();

    if (error || !tenant) {
      return new Response(JSON.stringify({ error: "tenant not found", details: error?.message }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const rawToken = (tenant.frizzar_token || "").trim();
    if (!rawToken) {
      return new Response(JSON.stringify({ error: "tenant has no frizzar_token" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const auth = rawToken.toLowerCase().startsWith("basic ") ? rawToken : `Basic ${rawToken}`;
    const headers = { Authorization: auth, Accept: "application/json" };
    const base = "https://api.frizzar.com.br/api/bot";

    async function probe(label: string, path: string) {
      const t0 = Date.now();
      try {
        const r = await fetch(`${base}${path}`, { headers });
        const text = await r.text();
        let body: any = text;
        try { body = JSON.parse(text); } catch { /* keep text */ }
        return {
          label, path, status: r.status, ok: r.ok, ms: Date.now() - t0,
          body: typeof body === "string" ? body.slice(0, 800) :
                Array.isArray(body) ? { _isArray: true, length: body.length, sample: body.slice(0, 3) } :
                body,
        };
      } catch (e) {
        return { label, path, error: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 };
      }
    }

    const results = {
      tenant: { id: tenant.id, name: tenant.name, tokenLen: rawToken.length, tokenPreview: `${rawToken.slice(0,6)}...${rawToken.slice(-4)}` },
      tests: [
        await probe("verificabot", "/verificabot"),
        await probe("listar_servicos", "/listar/servicos"),
        await probe("listaridentidadeia", "/listaridentidadeia"),
      ],
    };

    return new Response(JSON.stringify(results, null, 2), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
