// Chamado por pg_cron 1x/dia (mesmo padrão de process-followups/dispatch-jobs).
// Para cada tenant com celcash_billing_config.active=true, busca os
// inadimplentes conhecidos (celcash_overdue_subscribers) e dispara a
// mensagem configurada para quem já passou de days_after_due e ainda não
// foi cobrado dentro do período (repeat_every_days, se configurado).
//
// ⚠️ Decisão explícita do usuário: cobrança automática NÃO respeita a
// etiqueta "IA OFF" nem "conversa pausada" (atendimento humano em
// andamento) — diferente do follow-up comum, cobrança sempre sai. Só a
// proteção anti-loop (nunca mandar pro número de outra instância da
// própria plataforma) continua valendo.
//
// Autenticação: header `apikey` = SUPABASE_PUBLISHABLE_KEY (padrão pg_cron).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*" } });

  const apikey = req.headers.get("apikey") ?? "";
  const expected = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
  if (!apikey || apikey !== expected) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  let sent = 0, skipped = 0, errors = 0;

  try {
    const { data: configs, error: cfgErr } = await supabase
      .from("celcash_billing_config")
      .select("*, tenants(*)")
      .eq("active", true);

    if (cfgErr) {
      return new Response(JSON.stringify({ ok: false, error: cfgErr.message }), {
        status: 500, headers: { "Content-Type": "application/json" },
      });
    }

    if (!configs?.length) {
      return new Response(JSON.stringify({ ok: true, sent: 0, skipped: 0, errors: 0, note: "no_active_configs" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Anti-loop: números de instâncias da própria plataforma nunca recebem
    // cobrança (senão duas IAs nossas conversam entre si).
    const { data: allTenantsRaw } = await supabase.from("tenants").select("id, name, whatsapp_number");
    const instanceNumbers: Array<{ name: string; number: string }> = (allTenantsRaw ?? [])
      .filter((t: any) => t.whatsapp_number)
      .map((t: any) => ({ name: t.name, number: String(t.whatsapp_number) }));

    for (const config of configs) {
      const tenant = config.tenants as any;
      if (!tenant || tenant.status !== "active") continue;

      const uazapiUrl = tenant.uazapi_url || Deno.env.get("UAZAPI_URL");
      const uazapiToken = tenant.uazapi_token || Deno.env.get("UAZAPI_TOKEN");
      if (!uazapiUrl || !uazapiToken) { errors++; continue; }

      const { data: overdueList, error: odErr } = await supabase
        .from("celcash_overdue_subscribers")
        .select("*")
        .eq("tenant_id", tenant.id)
        .not("phone_e164", "is", null)
        .limit(500);
      if (odErr || !overdueList?.length) continue;

      // Último envio por cliente, pra checar days_after_due/repeat_every_days.
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
          if (config.repeat_every_days == null) { skipped++; continue; } // já mandou 1x, não repete
          const daysSinceLastSent = daysSince(lastSent.slice(0, 10));
          if (daysSinceLastSent === null || daysSinceLastSent < config.repeat_every_days) { skipped++; continue; }
        }

        // 🔒 Anti-loop: nunca mandar pro número de outra instância nossa.
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
    }

    return new Response(JSON.stringify({ ok: true, sent, skipped, errors }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("[CelCashBilling] erro geral:", e);
    return new Response(JSON.stringify({ ok: false, error: e.message || String(e) }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
