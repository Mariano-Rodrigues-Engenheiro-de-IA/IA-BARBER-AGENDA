// Sincroniza assinantes da CelCash para a tabela local celcash_subscribers.
// Modos:
//  - { tenant_id: "uuid" }  -> sincroniza um tenant (admin only)
//  - { all: true }          -> sincroniza todos tenants com celcash_enabled=true (cron / service role)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function baseUrl(env: string) {
  return env === "production"
    ? "https://api-celcash.celcoin.com.br/v2"
    : "https://api-celcash.sandbox.cel.cash/v2";
}

function normalizePhone(raw?: string | null): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;
  // BR-centric: if starts with 55 keep, if 10/11 digits assume BR, prepend 55
  if (digits.length === 10 || digits.length === 11) return `+55${digits}`;
  if (digits.startsWith("55") && digits.length >= 12) return `+${digits}`;
  return `+${digits}`;
}

function pickPhone(obj: any): string | null {
  if (!obj || typeof obj !== "object") return null;
  // CelCash returns "phones" as an array of numbers; prefer the longest (mobile)
  if (Array.isArray(obj.phones) && obj.phones.length) {
    const sorted = [...obj.phones].map(String).sort((a, b) => b.length - a.length);
    return sorted[0];
  }
  return (
    obj.phone || obj.mobile || obj.cellphone || obj.cell_phone ||
    obj.telefone || obj.celular || obj.phone_number || obj.phoneNumber ||
    obj.contact?.phone || obj.contact?.mobile || null
  );
}

async function getToken(env: string, galaxId: string, galaxHash: string) {
  const url = `${baseUrl(env)}/token`;
  const basic = btoa(`${galaxId}:${galaxHash}`);
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Authorization": `Basic ${basic}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      scope: "customers.read subscriptions.read transactions.read charges.read",
    }),
  });
  const text = await resp.text();
  let json: any; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!resp.ok || !json.access_token) {
    throw new Error(`CelCash token failed: HTTP ${resp.status} ${text.slice(0, 200)}`);
  }
  return json.access_token as string;
}

// Tenta listar assinaturas paginando. CelCash usa limit + startAt (offset).
async function fetchAllSubscriptions(env: string, token: string) {
  const all: any[] = [];
  const limit = 100;
  let startAt = 0;
  for (let i = 0; i < 500; i++) { // hard cap 50k
    const url = `${baseUrl(env)}/subscriptions?limit=${limit}&startAt=${startAt}`;
    const resp = await fetch(url, {
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    });
    const text = await resp.text();
    let json: any; try { json = JSON.parse(text); } catch { json = null; }
    if (!resp.ok) {
      throw new Error(`CelCash subscriptions HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    const items: any[] =
      json?.Subscriptions || json?.subscriptions || json?.data || json?.items || (Array.isArray(json) ? json : []);
    if (!items.length) break;
    all.push(...items);
    if (items.length < limit) break;
    startAt += items.length;
  }
  return all;
}

function deriveStatus(sub: any): { status: string; isOverdue: boolean; overdueCents: number } {
  // CelCash subscription statuses: active, closed, notStarted, dontBilled, waitingPayment, outOfBilling
  const rawStatus = String(sub.status || sub.subscription_status || sub.situation || "").toLowerCase();
  let status = "unknown";
  if (rawStatus === "active" || /ativ/.test(rawStatus)) status = "active";
  else if (rawStatus === "closed" || /cancel/.test(rawStatus)) status = "canceled";
  else if (rawStatus === "waitingpayment" || /overdue|atras|inadimpl/.test(rawStatus)) status = "overdue";
  else if (rawStatus === "notstarted") status = "pending";
  else if (rawStatus === "dontbilled" || rawStatus === "outofbilling") status = "paused";
  else if (/trial/.test(rawStatus)) status = "trial";
  else if (/pend/.test(rawStatus)) status = "pending";
  else if (rawStatus) status = rawStatus;

  const overdueCents = Number(
    sub.overdue_value || sub.overdueValue || sub.amount_overdue || sub.totalOverdue || 0
  );
  const isOverdue = status === "overdue" || overdueCents > 0;
  return { status, isOverdue, overdueCents: Math.round(overdueCents) };
}

async function syncTenant(supabase: any, tenant: any) {
  const { data: run } = await supabase
    .from("celcash_sync_runs")
    .insert({ tenant_id: tenant.id, status: "running" })
    .select().single();

  try {
    if (!tenant.celcash_galax_id || !tenant.celcash_galax_hash) {
      throw new Error("Credenciais CelCash ausentes");
    }
    const env = tenant.celcash_env || "sandbox";
    const token = await getToken(env, tenant.celcash_galax_id, tenant.celcash_galax_hash);
    const subs = await fetchAllSubscriptions(env, token);

    const rows = subs.map((s: any) => {
      const customer = s.Customer || s.customer || s.client || s.payer || {};
      const phoneRaw = pickPhone(customer) || pickPhone(s);
      const phoneE164 = normalizePhone(phoneRaw);
      const { status, isOverdue, overdueCents } = deriveStatus(s);
      const customerEmail = Array.isArray(customer.emails) ? customer.emails[0] : (customer.email || null);
      return {
        tenant_id: tenant.id,
        celcash_customer_id: String(
          customer.galaxPayId ?? customer.id ?? customer.myId ?? s.customer_id ?? s.payer_id ?? ""
        ),
        celcash_subscription_id: String(s.galaxPayId ?? s.id ?? s.myId ?? s.subscription_id ?? ""),
        phone_e164: phoneE164,
        phone_raw: phoneRaw ? String(phoneRaw) : null,
        name: customer.name || customer.fullName || customer.full_name || s.name || null,
        email: customerEmail,
        document: customer.document || customer.cpf || customer.cnpj || null,
        plan_id: String(s.PlanMyId ?? s.planMyId ?? s.plan_id ?? s.Plan?.galaxPayId ?? s.plan?.id ?? "") || null,
        plan_name: s.Plan?.name || s.plan?.name || s.plan_name || s.planName || null,
        status,
        is_overdue: isOverdue,
        overdue_amount_cents: overdueCents,
        next_due_date: s.next_due_date || s.nextDueDate || s.firstPayDayDate || null,
        last_payment_date: s.last_payment_date || s.lastPaymentDate || null,
        raw_payload: s,
        synced_at: new Date().toISOString(),
      };
    }).filter((r) => r.celcash_customer_id && r.celcash_customer_id !== "undefined" && r.celcash_customer_id !== "");

    // Dedupe por customer: mantém a "melhor" assinatura (active > overdue > pending > paused > trial > canceled > unknown)
    const rank: Record<string, number> = {
      active: 6, overdue: 5, pending: 4, paused: 3, trial: 2, canceled: 1, unknown: 0,
    };
    const byCustomer = new Map<string, any>();
    for (const r of rows) {
      const key = `${r.tenant_id}::${r.celcash_customer_id}`;
      const existing = byCustomer.get(key);
      if (!existing || (rank[r.status] ?? 0) > (rank[existing.status] ?? 0)) {
        byCustomer.set(key, r);
      }
    }
    const dedupedRows = Array.from(byCustomer.values());

    let upserted = 0;
    const chunkSize = 200;
    for (let i = 0; i < dedupedRows.length; i += chunkSize) {
      const chunk = dedupedRows.slice(i, i + chunkSize);
      const { error } = await supabase
        .from("celcash_subscribers")
        .upsert(chunk, { onConflict: "tenant_id,celcash_customer_id" });
      if (error) throw new Error(`Upsert error: ${error.message}`);
      upserted += chunk.length;
    }

    // Marca como canceled quem não veio neste sync
    const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { count: marked } = await supabase
      .from("celcash_subscribers")
      .update({ status: "canceled", is_overdue: false })
      .eq("tenant_id", tenant.id)
      .lt("synced_at", cutoff)
      .neq("status", "canceled")
      .select("id", { count: "exact", head: true });

    await supabase.from("celcash_sync_runs").update({
      status: "success",
      finished_at: new Date().toISOString(),
      total_fetched: subs.length,
      total_upserted: upserted,
      total_marked_canceled: marked || 0,
    }).eq("id", run.id);

    return { tenant_id: tenant.id, fetched: subs.length, upserted, marked_canceled: marked || 0 };
  } catch (e: any) {
    await supabase.from("celcash_sync_runs").update({
      status: "error",
      finished_at: new Date().toISOString(),
      error_message: e.message || String(e),
    }).eq("id", run.id);
    return { tenant_id: tenant.id, error: e.message || String(e) };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const body = await req.json().catch(() => ({}));
    const authHeader = req.headers.get("Authorization") || "";
    const isCronCall = body.all === true;

    let tenants: any[] = [];

    if (isCronCall) {
      const { data } = await supabase
        .from("tenants")
        .select("id, name, celcash_galax_id, celcash_galax_hash, celcash_env, celcash_enabled")
        .eq("celcash_enabled", true);
      tenants = data || [];
    } else {
      // Admin-only path
      if (!authHeader.startsWith("Bearer ")) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const anonClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: authHeader } } }
      );
      const { data: { user } } = await anonClient.auth.getUser();
      if (!user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data: isAdmin } = await supabase.rpc("has_role", { _user_id: user.id, _role: "admin" });
      if (!isAdmin) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!body.tenant_id) {
        return new Response(JSON.stringify({ error: "tenant_id is required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data } = await supabase
        .from("tenants")
        .select("id, name, celcash_galax_id, celcash_galax_hash, celcash_env, celcash_enabled")
        .eq("id", body.tenant_id)
        .single();
      if (!data) {
        return new Response(JSON.stringify({ error: "Tenant not found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      tenants = [data];
    }

    const results = [];
    for (const t of tenants) results.push(await syncTenant(supabase, t));

    return new Response(JSON.stringify({ success: true, results }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message || "Internal error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
