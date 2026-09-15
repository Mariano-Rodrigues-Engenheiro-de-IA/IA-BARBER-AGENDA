// Sincroniza assinantes INADIMPLENTES da CelCash para celcash_overdue_subscribers.
//
// ⚠️ Função separada de propósito, não uma extensão de sync-celcash-subscribers:
// aquela tabela é um snapshot só de assinantes ATIVOS, usado pela IA de
// atendimento pra decidir preço de clube ("achou = é assinante ativo").
// Trazer inadimplentes pra lá quebraria essa lógica em produção. Esta função
// busca os mesmos dados da CelCash de novo (custo de 1 chamada extra à API),
// mas grava numa tabela própria, sem tocar em nada existente.
//
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
  if (digits.length === 10 || digits.length === 11) return `+55${digits}`;
  if (digits.startsWith("55") && digits.length >= 12) return `+${digits}`;
  return `+${digits}`;
}

function pickPhone(obj: any): string | null {
  if (!obj || typeof obj !== "object") return null;
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
      scope: "customers.read subscriptions.read transactions.read charges.read plans.read",
    }),
  });
  const text = await resp.text();
  let json: any; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!resp.ok || !json.access_token) {
    throw new Error(`CelCash token failed: HTTP ${resp.status} ${text.slice(0, 200)}`);
  }
  return json.access_token as string;
}

async function fetchAllSubscriptions(env: string, token: string) {
  const all: any[] = [];
  const limit = 100;
  let startAt = 0;
  for (let i = 0; i < 500; i++) {
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

async function fetchPlansMap(env: string, token: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const limit = 100;
  let startAt = 0;
  for (let i = 0; i < 100; i++) {
    const url = `${baseUrl(env)}/plans?limit=${limit}&startAt=${startAt}`;
    const resp = await fetch(url, {
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    });
    const text = await resp.text();
    let json: any; try { json = JSON.parse(text); } catch { json = null; }
    if (!resp.ok) {
      console.warn(`[CelCashOverdue] /plans HTTP ${resp.status}: ${text.slice(0, 200)}`);
      break;
    }
    const items: any[] =
      json?.Plans || json?.plans || json?.data || json?.items || (Array.isArray(json) ? json : []);
    if (!items.length) break;
    for (const p of items) {
      const name = p.name || p.Name || p.title || null;
      if (!name) continue;
      const keys = [p.galaxPayId, p.GalaxPayId, p.myId, p.MyId, p.id].filter((x) => x !== undefined && x !== null);
      for (const k of keys) map.set(String(k), String(name));
    }
    if (items.length < limit) break;
    startAt += items.length;
  }
  return map;
}

function deriveStatus(sub: any): { status: string; isOverdue: boolean; overdueCents: number } {
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

async function syncTenantOverdue(supabase: any, tenant: any) {
  try {
    if (!tenant.celcash_galax_id || !tenant.celcash_galax_hash) {
      throw new Error("Credenciais CelCash ausentes");
    }
    const env = tenant.celcash_env || "sandbox";
    const token = await getToken(env, tenant.celcash_galax_id, tenant.celcash_galax_hash);
    const subs = await fetchAllSubscriptions(env, token);
    const planMap = await fetchPlansMap(env, token);

    const rows = subs.map((s: any) => {
      const customer = s.Customer || s.customer || s.client || s.payer || {};
      const phoneRaw = pickPhone(customer) || pickPhone(s);
      const phoneE164 = normalizePhone(phoneRaw);
      const { status, isOverdue, overdueCents } = deriveStatus(s);
      const customerEmail = Array.isArray(customer.emails) ? customer.emails[0] : (customer.email || null);
      const planIdRaw = s.planGalaxPayId ?? s.PlanGalaxPayId ?? s.planMyId ?? s.PlanMyId ?? s.plan_id ?? s.Plan?.galaxPayId ?? s.plan?.id ?? null;
      const planIdStr = planIdRaw !== null && planIdRaw !== undefined ? String(planIdRaw) : null;
      const planNameFromMap = planIdStr ? planMap.get(planIdStr) : null;
      const planNameFromMap2 = planMap.get(String(s.planMyId ?? "")) || planMap.get(String(s.planGalaxPayId ?? ""));
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
        plan_id: planIdStr,
        plan_name: s.Plan?.name || s.plan?.name || s.plan_name || s.planName || planNameFromMap || planNameFromMap2 || null,
        overdue_amount_cents: overdueCents,
        next_due_date: s.next_due_date || s.nextDueDate || s.firstPayDayDate || null,
        last_payment_date: s.last_payment_date || s.lastPaymentDate || null,
        raw_payload: s,
        synced_at: new Date().toISOString(),
        _isOverdue: isOverdue,
      };
    }).filter((r) => r.celcash_customer_id && r.celcash_customer_id !== "undefined" && r.celcash_customer_id !== "");

    // Só inadimplentes — o oposto do filtro em sync-celcash-subscribers.
    const overdueRows = rows.filter((r) => r._isOverdue).map(({ _isOverdue, ...r }) => r);

    const byCustomer = new Map<string, any>();
    for (const r of overdueRows) byCustomer.set(`${r.tenant_id}::${r.celcash_customer_id}`, r);
    const dedupedRows = Array.from(byCustomer.values());

    let upserted = 0;
    const chunkSize = 50;
    for (let i = 0; i < dedupedRows.length; i += chunkSize) {
      const chunk = dedupedRows.slice(i, i + chunkSize);
      const { error } = await supabase
        .from("celcash_overdue_subscribers")
        .upsert(chunk, { onConflict: "tenant_id,celcash_customer_id" });
      if (error) throw new Error(`Upsert error: ${error.message}`);
      upserted += chunk.length;
    }

    // Remove quem não veio neste sync (voltou a ficar em dia, ou cancelou).
    const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: removedRows } = await supabase
      .from("celcash_overdue_subscribers")
      .delete()
      .eq("tenant_id", tenant.id)
      .lt("synced_at", cutoff)
      .select("id");
    const removed = removedRows?.length || 0;

    return { tenant_id: tenant.id, fetched: subs.length, overdue_upserted: upserted, removed };
  } catch (e: any) {
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
      const cronSecret = Deno.env.get("CRON_SECRET");
      const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const providedSecret = req.headers.get("x-cron-secret") || req.headers.get("x-webhook-secret");
      const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      const secretOk = !!(cronSecret && providedSecret && providedSecret === cronSecret);
      const serviceOk = !!(bearer && bearer === serviceRoleKey);
      if (!secretOk && !serviceOk) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data } = await supabase
        .from("tenants")
        .select("id, name, celcash_galax_id, celcash_galax_hash, celcash_env, celcash_enabled")
        .eq("celcash_enabled", true);
      tenants = data || [];
    } else {
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
      if (!body.tenant_id) {
        return new Response(JSON.stringify({ error: "tenant_id is required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // ⚠️ Adicionado (16/09): antes só admin podia chamar essa sincronização
      // sob demanda. Botão "Sincronizar agora" no painel do cliente precisa
      // que o próprio dono do tenant também consiga, sem depender de acesso
      // admin nem de credenciais do Supabase (que a Lovable gerencia, o
      // cliente não tem acesso). Mesmo padrão já usado em
      // evaluate-celcash-billing e lookup-celcash-subscriber.
      const { data: isAdmin } = await supabase.rpc("has_role", { _user_id: user.id, _role: "admin" });
      let allowed = !!isAdmin;
      if (!allowed) {
        const { data: membership } = await supabase
          .from("tenant_users")
          .select("tenant_id")
          .eq("user_id", user.id)
          .eq("tenant_id", body.tenant_id)
          .maybeSingle();
        allowed = !!membership;
      }
      if (!allowed) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
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
    for (const t of tenants) results.push(await syncTenantOverdue(supabase, t));

    return new Response(JSON.stringify({ success: true, results }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message || "Internal error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
