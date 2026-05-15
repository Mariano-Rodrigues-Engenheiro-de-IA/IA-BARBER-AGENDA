import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function adjustToBusinessHours(at: Date, start: string, end: string, timezone: string): Date {
  try {
    const [sh, sm] = start.split(":").map(Number);
    const [eh, em] = end.split(":").map(Number);
    const fmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: timezone });
    const parts = fmt.formatToParts(at);
    const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    const cur = hh * 60 + mm;
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    if (cur >= startMin && cur < endMin) return at;
    const diff = cur < startMin ? (startMin - cur) : ((24 * 60 - cur) + startMin);
    return new Date(at.getTime() + diff * 60 * 1000);
  } catch {
    return at;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const { data: pendingFollowUps, error: fetchError } = await supabase
      .from("follow_ups")
      .select("*, tenants(*)")
      .eq("status", "pending")
      .lte("follow_up_at", new Date().toISOString())
      .limit(100);

    if (fetchError) {
      console.error("Error fetching follow-ups:", fetchError.message);
      return new Response(JSON.stringify({ error: fetchError.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!pendingFollowUps?.length) {
      return new Response(JSON.stringify({ status: "no_pending", count: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`Processing ${pendingFollowUps.length} pending follow-ups`);

    let sent = 0, errors = 0, skipped = 0, chained = 0;

    for (const followUp of pendingFollowUps) {
      const tenant = followUp.tenants;
      if (!tenant) { errors++; continue; }

      if (tenant.status !== "active") {
        await supabase.from("follow_ups").update({
          status: "expired", cancelled_at: new Date().toISOString(), cancel_reason: "tenant_inactive"
        }).eq("id", followUp.id);
        continue;
      }

      const uazapiUrl = tenant.uazapi_url || Deno.env.get("UAZAPI_URL");
      const uazapiToken = tenant.uazapi_token || Deno.env.get("UAZAPI_TOKEN");
      if (!uazapiUrl || !uazapiToken) { errors++; continue; }

      // Check if client replied since this follow-up was created
      const { data: recentMessages } = await supabase
        .from("chat_messages")
        .select("content, role, created_at")
        .eq("tenant_id", followUp.tenant_id)
        .eq("phone_number", followUp.phone_number)
        .gt("created_at", followUp.created_at)
        .eq("role", "user")
        .order("created_at", { ascending: false })
        .limit(10);

      const confirmationPatterns = [
        /agend(ei|ado|ou)/i, /marqu?e(i|ado|ou)/i, /confirm(ei|ado|ou)/i,
        /fiz\s*(o\s*)?(meu\s*)?(agendamento|horário|reserva)/i,
        /já\s*(agend|marqu)/i, /pronto.*agend/i, /feito/i,
        /consegui.*agend/i, /reserv(ei|ado|ou)/i,
      ];
      const hasConfirmed = recentMessages?.some((msg) =>
        confirmationPatterns.some((p) => p.test(msg.content))
      );

      if (hasConfirmed) {
        await supabase.from("follow_ups").update({
          status: "confirmed", confirmed_at: new Date().toISOString()
        }).eq("id", followUp.id);
        continue;
      }

      // If lead replied at all → cancel (sequences AND legacy)
      if (recentMessages && recentMessages.length > 0) {
        await supabase.from("follow_ups").update({
          status: "expired", cancelled_at: new Date().toISOString(), cancel_reason: "lead_replied"
        }).eq("id", followUp.id);
        skipped++;
        continue;
      }

      const message = followUp.follow_up_message ||
        "Oi! Vi que te mandei o link pra agendar, conseguiu marcar certinho? Se tiver qualquer dúvida, tô aqui! 😊";

      try {
        const sendRes = await fetch(`${uazapiUrl}/send/text`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json", "token": uazapiToken },
          body: JSON.stringify({ number: followUp.phone_number, text: message }),
        });
        const sendData = await sendRes.json();
        console.log(`Follow-up ${followUp.id}: sent`, JSON.stringify(sendData).slice(0, 150));

        await supabase.from("follow_ups").update({
          status: "sent", sent_at: new Date().toISOString()
        }).eq("id", followUp.id);

        await supabase.from("chat_messages").insert({
          tenant_id: followUp.tenant_id,
          phone_number: followUp.phone_number,
          role: "assistant",
          content: message,
        });

        sent++;

        // ===== SEQUENCE CHAINING: schedule next step if exists =====
        if (followUp.sequence_id && followUp.step_order) {
          const { data: seq } = await supabase
            .from("follow_up_sequences")
            .select("*, follow_up_steps(*)")
            .eq("id", followUp.sequence_id)
            .maybeSingle();

          if (seq && seq.enabled) {
            const steps = (seq.follow_up_steps || []).sort((a: any, b: any) => a.step_order - b.step_order);
            const nextStep = steps.find((s: any) => s.step_order > followUp.step_order);
            if (nextStep) {
              let triggerAt = new Date(Date.now() + (nextStep.delay_minutes || 30) * 60 * 1000);
              const bh = seq.business_hours || {};
              if (bh.enabled) {
                triggerAt = adjustToBusinessHours(triggerAt, bh.start || "08:00", bh.end || "21:00", bh.timezone || "America/Sao_Paulo");
              }
              await supabase.from("follow_ups").insert({
                tenant_id: followUp.tenant_id,
                phone_number: followUp.phone_number,
                follow_up_at: triggerAt.toISOString(),
                follow_up_message: nextStep.message,
                sequence_id: seq.id,
                step_order: nextStep.step_order,
                matched_keyword: followUp.matched_keyword,
              });
              chained++;
              console.log(`[Chain] Scheduled step ${nextStep.step_order} of "${seq.name}" for ${followUp.phone_number}`);
            } else {
              console.log(`[Chain] Sequence "${seq.name}" completed for ${followUp.phone_number}`);
            }
          }
        }
      } catch (sendErr) {
        console.error(`Follow-up ${followUp.id}: send failed:`, sendErr);
        errors++;
      }
    }

    console.log(`Processed: ${sent} sent, ${chained} chained, ${skipped} skipped, ${errors} errors`);
    return new Response(JSON.stringify({ status: "ok", sent, chained, skipped, errors, total: pendingFollowUps.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("process-followups error:", error);
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
