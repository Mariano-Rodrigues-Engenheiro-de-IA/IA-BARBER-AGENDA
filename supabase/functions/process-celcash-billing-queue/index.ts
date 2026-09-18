// Processa a fila de cobrança CelCash (celcash_billing_queue), enviando
// só quem já está na hora agendada (scheduled_at <= agora). Roda via
// pg_cron a cada 1 minuto — é essa função que faz o envio de verdade
// pro WhatsApp; evaluate-celcash-billing só decide QUEM entra na fila e
// QUANDO, sem mandar nada diretamente (ver comentário lá pra entender
// por que: função com limite de tempo não aguenta esperar 1-2min entre
// dezenas de mensagens).
//
// Autenticação: mesmo padrão do modo cron de evaluate-celcash-billing —
// header `apikey` = SUPABASE_PUBLISHABLE_KEY.

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Mesmo padrão de autenticação do modo cron de evaluate-celcash-billing:
  // apikey (publishable/anon) ou x-cron-secret (CRON_SECRET ou token
  // interno guardado no banco). Fail-closed.
  const apikey = req.headers.get("apikey") ?? "";
  const expectedKeys = [
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY"),
    Deno.env.get("SUPABASE_ANON_KEY"),
  ].filter((k): k is string => !!k);
  let authorized = !!apikey && expectedKeys.includes(apikey);
  const providedSecret = req.headers.get("x-cron-secret");
  if (!authorized && providedSecret) {
    const cronSecret = Deno.env.get("CRON_SECRET");
    if (cronSecret && providedSecret === cronSecret) {
      authorized = true;
    } else {
      const { data: internalToken } = await supabase.rpc("get_internal_cron_token");
      authorized = typeof internalToken === "string" && providedSecret === internalToken;
    }
  }
  if (!authorized) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let sent = 0, errors = 0;
  const deadline = Date.now() + 50_000; // roda a cada 1min, nunca deve chegar perto disso

  try {
    const { data: dueRows, error: qErr } = await supabase
      .from("celcash_billing_queue")
      .select("*, tenants:tenant_id(*)")
      .eq("status", "pending")
      .lte("scheduled_at", new Date().toISOString())
      .order("scheduled_at", { ascending: true })
      .limit(100);

    if (qErr) {
      return new Response(JSON.stringify({ ok: false, error: qErr.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!dueRows?.length) {
      return new Response(JSON.stringify({ ok: true, sent: 0, errors: 0, note: "queue_empty" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: allTenantsRaw } = await supabase.from("tenants").select("id, name, whatsapp_number");
    const instanceNumbers = (allTenantsRaw ?? [])
      .filter((t: any) => t.whatsapp_number)
      .map((t: any) => ({ name: t.name, number: String(t.whatsapp_number) }));

    for (const row of dueRows) {
      if (Date.now() > deadline) break; // resto fica pendente, próxima rodada (1min depois) pega

      const tenant = row.tenants;
      const uazapiUrl = tenant?.uazapi_url || Deno.env.get("UAZAPI_URL");
      const uazapiToken = tenant?.uazapi_token || Deno.env.get("UAZAPI_TOKEN");
      if (!tenant || tenant.status !== "active" || !uazapiUrl || !uazapiToken) {
        await supabase.from("celcash_billing_queue")
          .update({ status: "error", error_message: "tenant inativo ou sem credenciais UAZAPI" })
          .eq("id", row.id);
        errors++;
        continue;
      }

      const selfInstance = instanceNumbers.find((t) => tolerantPhoneMatch(row.phone_e164, t.number));
      if (selfInstance) {
        await supabase.from("celcash_billing_queue")
          .update({ status: "error", error_message: `número da instância "${selfInstance.name}"` })
          .eq("id", row.id);
        errors++;
        continue;
      }

      try {
        const phoneDigits = String(row.phone_e164).replace(/\D/g, "");
        const sendRes = await fetch(`${uazapiUrl}/send/text`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json", "token": uazapiToken },
          body: JSON.stringify({ number: phoneDigits, text: row.message_text }),
        });
        const sendData = await sendRes.json().catch(() => ({}));
        if (!sendRes.ok) {
          await supabase.from("celcash_billing_queue")
            .update({ status: "error", error_message: JSON.stringify(sendData).slice(0, 500) })
            .eq("id", row.id);
          errors++;
          continue;
        }

        await supabase.from("celcash_billing_sent_log").insert({
          tenant_id: row.tenant_id,
          celcash_customer_id: row.celcash_customer_id,
          phone_e164: row.phone_e164,
          overdue_amount_cents_at_send: row.overdue_amount_cents_at_send,
          next_due_date_at_send: row.next_due_date_at_send,
          message_sent: row.message_text,
          message_type: row.message_type,
        });
        await supabase.from("chat_messages").insert({
          tenant_id: row.tenant_id,
          phone_number: phoneDigits,
          role: "assistant",
          content: row.message_text,
        });
        await supabase.from("celcash_billing_queue")
          .update({ status: "sent", sent_at: new Date().toISOString() })
          .eq("id", row.id);
        sent++;
      } catch (sendErr: any) {
        await supabase.from("celcash_billing_queue")
          .update({ status: "error", error_message: String(sendErr?.message ?? sendErr).slice(0, 500) })
          .eq("id", row.id);
        errors++;
      }
    }

    return new Response(JSON.stringify({ ok: true, sent, errors }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("[CelCashBillingQueue] erro geral:", e);
    return new Response(JSON.stringify({ ok: false, error: e.message || String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
