// 2 modos de chamada:
//  - Cron (sem tenant_id no body): chamado por pg_cron 1x/dia, processa
//    TODOS os tenants com celcash_billing_config.active=true OU
//    due_today_active=true. Autenticação: header `apikey` =
//    SUPABASE_PUBLISHABLE_KEY (padrão pg_cron).
//  - Sob demanda (body { tenant_id: "uuid" }): botão "Cobrar agora" no
//    painel do cliente. Autenticação: JWT do próprio usuário logado
//    (Authorization: Bearer), verificado como pertencente a esse tenant
//    (ou admin). Roda a MESMA lógica de decisão do cron — o botão não
//    ignora a configuração, só executa na hora em vez de esperar o cron
//    do dia seguinte.
//
// ⚠️ Adicionado (17/09): 2 disparos distintos, cada um com seu próprio
// liga/desliga e mensagem:
//   1. "Vence hoje" (due_today) — lembrete pra quem vence EXATAMENTE
//      hoje, mensagem mais leve. Manda no máximo 1x por vencimento (não
//      repete, cada mês tem uma data nova).
//   2. "Atrasados" (overdue) — a cobrança já existente, agora excluindo
//      quem vence hoje (esses só recebem o lembrete acima, não os dois)
//      e com um teto configurável de dias em atraso (overdue_max_days —
//      null = sem teto).
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

function formatCentsBRL(cents: number | null | undefined): string {
  if (!cents) return "";
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatDateBR(dateStr: string | null | undefined): string {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("pt-BR");
}

function renderMessage(template: string, sub: { name: string | null; next_due_date?: string | null; overdue_amount_cents?: number | null }): string {
  const safeName = (sub.name || "").trim().split(/\s+/)[0] || "";
  const vencimento = formatDateBR(sub.next_due_date);
  const valor = formatCentsBRL(sub.overdue_amount_cents);
  return template
    .replace(/\{\{nome\}\}/gi, safeName || "tudo bem?")
    .replace(/\{nome\}/gi, safeName || "tudo bem?")
    .replace(/\{\{vencimento\}\}/gi, vencimento)
    .replace(/\{vencimento\}/gi, vencimento)
    .replace(/\{\{valor\}\}/gi, valor)
    .replace(/\{valor\}/gi, valor);
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

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

async function sendOne(
  supabase: any,
  uazapiUrl: string,
  uazapiToken: string,
  tenant: any,
  sub: any,
  message: string,
  messageType: "due_today" | "overdue",
): Promise<"sent" | "error"> {
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
      return "error";
    }

    await supabase.from("celcash_billing_sent_log").insert({
      tenant_id: tenant.id,
      celcash_customer_id: sub.celcash_customer_id,
      phone_e164: sub.phone_e164,
      overdue_amount_cents_at_send: sub.overdue_amount_cents,
      next_due_date_at_send: sub.next_due_date,
      message_sent: message,
      message_type: messageType,
    });

    await supabase.from("chat_messages").insert({
      tenant_id: tenant.id,
      phone_number: phoneDigits,
      role: "assistant",
      content: message,
    });

    return "sent";
  } catch (sendErr) {
    console.error(`[CelCashBilling] exceção ao enviar pra ${sub.phone_e164}:`, sendErr);
    return "error";
  }
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
    .select("celcash_customer_id, sent_at, message_type, next_due_date_at_send")
    .eq("tenant_id", tenant.id)
    .in("celcash_customer_id", customerIds)
    .order("sent_at", { ascending: false });

  // Último envio de "atrasado" por cliente — guarda também o vencimento
  // que foi cobrado, pra diferenciar "já cobrei essa MESMA dívida" (aplica
  // days_after_due/repeat_every_days) de "isso é uma dívida NOVA, com
  // vencimento diferente da última vez" (trata como primeira cobrança
  // desse período, não bloqueia por 'já mandei uma vez pra esse cliente').
  // ⚠️ Corrigido (18/09, caso real de teste do usuário): antes só guardava
  // sent_at, sem o vencimento — um cliente que já tinha recebido cobrança
  // de uma dívida ANTIGA nunca mais receberia nada, mesmo caindo em atraso
  // de novo depois (dívida nova), se repeat_every_days estivesse vazio.
  const lastOverdueSentByCustomer = new Map<string, { sentAt: string; dueDate: string | null }>();
  // Já mandou o lembrete de "vence hoje" pra ESSE vencimento específico?
  const dueTodayAlreadySent = new Set<string>();
  for (const row of sentLogRows ?? []) {
    if (row.message_type === "overdue") {
      if (!lastOverdueSentByCustomer.has(row.celcash_customer_id)) {
        lastOverdueSentByCustomer.set(row.celcash_customer_id, { sentAt: row.sent_at, dueDate: row.next_due_date_at_send });
      }
    } else if (row.message_type === "due_today") {
      dueTodayAlreadySent.add(`${row.celcash_customer_id}::${row.next_due_date_at_send}`);
    }
  }

  const today = todayStr();
  const dueToday = overdueList.filter((o: any) => o.next_due_date === today);
  const pastDue = overdueList.filter((o: any) => o.next_due_date !== today);

  // ===== Grupo 1: vence hoje =====
  if (config.due_today_active) {
    for (const sub of dueToday) {
      const key = `${sub.celcash_customer_id}::${sub.next_due_date}`;
      if (dueTodayAlreadySent.has(key)) { skipped++; continue; }

      const selfInstance = instanceNumbers.find((t) => tolerantPhoneMatch(sub.phone_e164, t.number));
      if (selfInstance) { skipped++; continue; }

      const message = renderMessage(config.due_today_message_template, sub);
      const result = await sendOne(supabase, uazapiUrl, uazapiToken, tenant, sub, message, "due_today");
      if (result === "sent") sent++; else errors++;
    }
  }

  // ===== Grupo 2: atrasados (exclui quem vence hoje, respeita teto de dias) =====
  if (config.active) {
    for (const sub of pastDue) {
      const daysOverdue = daysSince(sub.next_due_date);
      if (daysOverdue === null || daysOverdue < config.days_after_due) { skipped++; continue; }
      if (config.overdue_max_days != null && daysOverdue > config.overdue_max_days) { skipped++; continue; }

      const lastSent = lastOverdueSentByCustomer.get(sub.celcash_customer_id);
      // Só bloqueia/aplica repetição se for a MESMA dívida (mesmo
      // vencimento) já cobrada antes. Vencimento diferente = dívida nova,
      // trata como primeira cobrança desse período — não fica preso pra
      // sempre por causa de uma cobrança antiga já resolvida.
      if (lastSent && lastSent.dueDate === sub.next_due_date) {
        if (config.repeat_every_days == null) { skipped++; continue; }
        const daysSinceLastSent = daysSince(lastSent.sentAt.slice(0, 10));
        if (daysSinceLastSent === null || daysSinceLastSent < config.repeat_every_days) { skipped++; continue; }
      }

      const selfInstance = instanceNumbers.find((t) => tolerantPhoneMatch(sub.phone_e164, t.number));
      if (selfInstance) {
        console.log(`[CelCashBilling] Pulado ${sub.phone_e164}: é o número da instância "${selfInstance.name}".`);
        skipped++;
        continue;
      }

      const message = renderMessage(config.message_template, sub);
      const result = await sendOne(supabase, uazapiUrl, uazapiToken, tenant, sub, message, "overdue");
      if (result === "sent") sent++; else errors++;
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
      .or("active.eq.true,due_today_active.eq.true")
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
  const expectedKeys = [
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY"),
    Deno.env.get("SUPABASE_ANON_KEY"),
  ].filter((k): k is string => !!k);
  let cronAuthorized = !!apikey && expectedKeys.includes(apikey);
  // Token interno do agendador (mesmo padrão do audit-monitor: guardado no banco)
  const providedSecret = req.headers.get("x-cron-secret");
  if (!cronAuthorized && providedSecret) {
    const cronSecret = Deno.env.get("CRON_SECRET");
    if (cronSecret && providedSecret === cronSecret) {
      cronAuthorized = true;
    } else {
      const { data: internalToken } = await supabase.rpc("get_internal_cron_token");
      cronAuthorized = typeof internalToken === "string" && providedSecret === internalToken;
    }
  }
  if (!cronAuthorized) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let sent = 0, skipped = 0, errors = 0;

  try {
    const { data: configs, error: cfgErr } = await supabase
      .from("celcash_billing_config")
      .select("*, tenants(*)")
      .or("active.eq.true,due_today_active.eq.true");

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
