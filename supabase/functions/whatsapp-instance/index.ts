// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function uaz(url: string, token: string, path: string, init: RequestInit = {}) {
  const base = url.replace(/\/+$/, "");
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      token,
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { data: tu } = await admin
      .from("tenant_users")
      .select("tenant_id")
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (!tu?.tenant_id) return json({ error: "No tenant" }, 403);

    const { data: tenant } = await admin
      .from("tenants")
      .select("uazapi_url, uazapi_token")
      .eq("id", tu.tenant_id)
      .single();
    if (!tenant?.uazapi_url || !tenant?.uazapi_token) {
      return json({ error: "Credenciais UAZAPI não configuradas" }, 400);
    }

    const body = await req.json().catch(() => ({}));
    const action = body?.action as string;

    switch (action) {
      case "status": {
        const r = await uaz(tenant.uazapi_url, tenant.uazapi_token, "/instance/status");
        return json(r.data, r.status);
      }
      case "connect": {
        const r = await uaz(tenant.uazapi_url, tenant.uazapi_token, "/instance/connect", {
          method: "POST",
          body: JSON.stringify(body.phone ? { phone: body.phone } : {}),
        });
        return json(r.data, r.status);
      }
      case "disconnect": {
        const r = await uaz(tenant.uazapi_url, tenant.uazapi_token, "/instance/disconnect", {
          method: "POST",
        });
        return json(r.data, r.status);
      }
      case "profile-image": {
        const number = String(body.number ?? "").replace(/\D/g, "");
        if (!number) return json({ error: "missing number" }, 400);
        const r = await uaz(tenant.uazapi_url, tenant.uazapi_token, "/chat/details", {
          method: "POST",
          body: JSON.stringify({ number, preview: true }),
        });
        if (!r.ok) return json({ image: null }, 200);
        const image = r.data?.imagePreview || r.data?.image || null;
        const name = r.data?.wa_name || r.data?.name || r.data?.lead_name || null;
        return json({ image, name }, 200);
      }
      default:
        return json({ error: "Unknown action" }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
