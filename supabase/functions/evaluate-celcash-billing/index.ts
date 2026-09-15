// 2 modos de chamada:
//  - Cron (sem tenant_id no body): chamado por pg_cron 1x/dia, processa
//    TODOS os tenants com celcash_billing_config.active=true. Autenticação:
//    header `apikey` = SUPABASE_PUBLISHABLE_KEY (padrão pg_cron).
//  - Sob demanda (body { tenant_id: "uuid" }): botão "Cobrar agora" no
//    painel do cliente. Autenticação: JWT do próprio usuário logado
//    (Authorization: Bearer), verificado como pertencente a esse tenant
//    (ou admin). Roda a MESMA lógica de decisão do cron (respeita
//    days_after_due / repeat_every_days e exige config.active=true) — o
//    botão não ignora a configuração, só executa na hora em vez de esperar
//    o cron do dia seguinte.
//
// Para cada tenant processado, busca os inadimplentes conhecidos
// (celcash_overdue_subscribers) e dispara a mensagem configurada para quem
// já passou de days_after_due e ainda não foi cobrado dentro do período
// (repeat_every_days, se configurado).
//
// ⚠️ Decisão explícita do usuário: cobrança automática NÃO respeita a
// etiqueta "IA OFF" nem "conversa pausada" (atendimento humano em
// andamento) — diferente do follow-up comum, cobrança sempre sai. Só a
// proteção anti-loop (nunca mandar pro número de outra instância da
// própria plataforma) continua valendo.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };

/** Compara dois telefones brasileiros tolerando o "9" extra do celular. */
function tolerantPhoneMatch(a: string, b: string): boolean {
  const da = String(a ?? "").replace(/\D/g, "");
  const db = String(b ?? "").replace(/\D/g, "");
  if (!da || !db) return false;
  if (da === db) return true;
  const strip9 = (v: string) => (v.length === 13 && v.startsWith("55") ? v.slice(0, 4) + v.slice(5) : v);
  return strip9(da) === strip9(db);
}

function renderMessage(template: string, name: string | null): string {
  const safeName = (name || "").trim().split(/\s+/)[0] || "";
  return template.replace(/\{nome\}/gi, safeName || "tudo bem?").replace(/\{\{nome\}\}/gi, safeName || "tudo bem?");
}

function daysSince(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr + (dateStr.length === 10 ? "T00:00:00" : ""));
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  return Math.round((today.getTime() - d.getTime()) / 86400000);
}

async function processTenant(
  supabase: any,
  config: any,
  instanceNumbers: Array<{ name: string; number: string }>,
): Promise<{ sent: number; skipped: number; errors: number }> {
  let sent = 0, skipped = 0, errors = 0;
  const tenant = config.tenants;
  if (!tenant || tenant.status !== "active") return { sent, skipped, errors };

  const uazapiUrl = tenant.uazapi_url || Deno.env.get("UAZAPI_URL");
  const uazapiToken = tenant.uazapi_token || Deno.env.get("UAZAPI_TOKEN");
  if (!uazapiUrl || !uazapiToken) return { sent, skipped, errors: errors + 1 };

  const { data: overdueList, error: odErr } = await supabase
    .from("celcash_overdue_subscribers")
    .select("*")
    .eq("tenant_id", tenant.id)
    .not("phone_e164", "is", null)
    .limit(500);
  if (odErr || !overdueList?.length) return { sent, skipped, errors };

  const customerIds = overdueList.map((o: any) => o.celcash_customer_id);
  const { data: sentLogRows } = await supabase
    .from("celcash_billing_sent_log")
    .select("celcash_customer_id, sent_at")
    .eq("tenant_id", tenant.id)
    .in("celcash_customer_id", customerIds)
    .order("sent_at", { ascending: false });
  const lastSentByCustomer = new Map<string, string>();
  for (const row of sentLogRows ?? []) {
    if (!lastSentByCustomer.has(row.celcash_customer_id)) {
      lastSentByCustomer.set(row.celcash_customer_id, row.sent_at);
    }
  }

  for (const sub of overdueList) {
    const daysOverdue = daysSince(sub.next_due_date);
    if (daysOverdue === null || daysOverdue < config.days_after_due) { skipped++; continue; }

    const lastSent = lastSentByCustomer.get(sub.celcash_customer_id);
    if (lastSent) {
      if (config.repeat_every_days == null) { skipped++; continue; }
      const daysSinceLastSent = daysSince(lastSent.slice(0, 10));
      if (daysSinceLastSent === null || daysSinceLastSent < config.repeat_every_days) { skipped++; continue; }
    }

    const selfInstance = instanceNumbers.find((t) => tolerantPhoneMatch(sub.phone_e164, t.number));
    if (selfInstance) {
      console.log(`[CelCashBilling] Pulado ${sub.phone_e164}: é o número da instância "${selfInstance.name}".`);
      skipped++;
      continue;
    }

    const message = renderMessage(config.message_template, sub.name);

    try {
      const phoneDigits = String(sub.phone_e164).replace(/\D/g, "");
      const sendRes = await fetch(`${uazapiUrl}/send/text`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json", "token": uazapiToken },
        body: JSON.stringify({ number: phoneDigits, text: message }),
      });
      const sendData = await sendRes.json().catch(() => ({}));
      if (!sendRes.ok) {
        console.error(`[CelCashBilling] falha ao enviar pra ${phoneDigits}:`, JSON.stringify(sendData).slice(0, 150));
        errors++;
        continue;
      }

      await supabase.from("celcash_billing_sent_log").insert({
        tenant_id: tenant.id,
        celcash_customer_id: sub.celcash_customer_id,
        phone_e164: sub.phone_e164,
        overdue_amount_cents_at_send: sub.overdue_amount_cents,
        next_due_date_at_send: sub.next_due_date,
        message_sent: message,
      });

      await supabase.from("chat_messages").insert({
        tenant_id: tenant.id,
        phone_number: phoneDigits,
        role: "assistant",
        content: message,
      });

      sent++;
    } catch (sendErr) {
      console.error(`[CelCashBilling] exceção ao enviar pra ${sub.phone_e164}:`, sendErr);
      errors++;
    }
  }

  return { sent, skipped, errors };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const body = await req.json().catch(() => ({}));
  const requestedTenantId = typeof body.tenant_id === "string" ? body.tenant_id : null;

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  if (requestedTenantId) {
    // ===== Modo sob demanda: botão "Cobrar agora" =====
    const authHeader = req.headers.get("Authorization") || "";
    const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!bearer) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
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
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: isAdmin } = await supabase.rpc("has_role", { _user_id: user.id, _role: "admin" });
    let allowed = !!isAdmin;
    if (!allowed) {
      const { data: membership } = await supabase
        .from("tenant_users")
        .select("tenant_id")
        .eq("user_id", user.id)
        .eq("tenant_id", requestedTenantId)
        .maybeSingle();
      allowed = !!membership;
    }
    if (!allowed) {
      return new Response(JSON.stringify({ ok: false, error: "forbidden" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: config, error: cfgErr } = await supabase
      .from("celcash_billing_config")
      .select("*, tenants(*)")
      .eq("tenant_id", requestedTenantId)
      .eq("active", true)
      .maybeSingle();
    if (cfgErr) {
      return new Response(JSON.stringify({ ok: false, error: cfgErr.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!config) {
      return new Response(JSON.stringify({ ok: true, sent: 0, skipped: 0, errors: 0, note: "config_inactive_or_missing" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: allTenantsRaw } = await supabase.from("tenants").select("id, name, whatsapp_number");
    const instanceNumbers = (allTenantsRaw ?? [])
      .filter((t: any) => t.whatsapp_number)
      .map((t: any) => ({ name: t.name, number: String(t.whatsapp_number) }));

    const result = await processTenant(supabase, config, instanceNumbers);
    return new Response(JSON.stringify({ ok: true, ...result }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ===== Modo cron: todos os tenants =====
  const apikey = req.headers.get("apikey") ?? "";
  const expected = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
  if (!apikey || apikey !== expected) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let sent = 0, skipped = 0, errors = 0;

  try {
    const { data: configs, error: cfgErr } = await supabase
      .from("celcash_billing_config")
      .select("*, tenants(*)")
      .eq("active", true);

    if (cfgErr) {
      return new Response(JSON.stringify({ ok: false, error: cfgErr.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!configs?.length) {
      return new Response(JSON.stringify({ ok: true, sent: 0, skipped: 0, errors: 0, note: "no_active_configs" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: allTenantsRaw } = await supabase.from("tenants").select("id, name, whatsapp_number");
    const instanceNumbers = (allTenantsRaw ?? [])
      .filter((t: any) => t.whatsapp_number)
      .map((t: any) => ({ name: t.name, number: String(t.whatsapp_number) }));

    for (const config of configs) {
      const r = await processTenant(supabase, config, instanceNumbers);
      sent += r.sent;
      skipped += r.skipped;
      errors += r.errors;
    }

    return new Response(JSON.stringify({ ok: true, sent, skipped, errors }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("[CelCashBilling] erro geral:", e);
    return new Response(JSON.stringify({ ok: false, error: e.message || String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
