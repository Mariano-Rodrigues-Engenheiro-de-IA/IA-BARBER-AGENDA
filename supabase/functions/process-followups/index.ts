import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

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
      .limit(50);

    if (fetchError) {
      console.error("Error fetching follow-ups:", fetchError.message);
      return new Response(JSON.stringify({ error: fetchError.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!pendingFollowUps?.length) {
      console.log("No pending follow-ups to process");
      return new Response(JSON.stringify({ status: "no_pending", count: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`Processing ${pendingFollowUps.length} pending follow-ups`);

    let sent = 0;
    let errors = 0;
    let skipped = 0;

    for (const followUp of pendingFollowUps) {
      const tenant = followUp.tenants;
      if (!tenant) {
        console.error(`Follow-up ${followUp.id}: tenant not found`);
        errors++;
        continue;
      }

      if (tenant.status !== "active") {
        console.log(`Follow-up ${followUp.id}: tenant ${tenant.name} is ${tenant.status}, skipping`);
        await supabase
          .from("follow_ups")
          .update({ status: "expired" })
          .eq("id", followUp.id);
        continue;
      }

      const uazapiUrl = tenant.uazapi_url || Deno.env.get("UAZAPI_URL");
      const uazapiToken = tenant.uazapi_token || Deno.env.get("UAZAPI_TOKEN");

      if (!uazapiUrl || !uazapiToken) {
        console.error(`Follow-up ${followUp.id}: no UAZAPI config for tenant ${tenant.name}`);
        errors++;
        continue;
      }

      // Check if the client sent any message after the follow-up was created
      // This handles both "after_no_reply" (client replied = cancel) and "after_link_sent" (client confirmed)
      const { data: recentMessages } = await supabase
        .from("chat_messages")
        .select("content, role, created_at")
        .eq("tenant_id", followUp.tenant_id)
        .eq("phone_number", followUp.phone_number)
        .gt("created_at", followUp.created_at)
        .eq("role", "user")
        .order("created_at", { ascending: false })
        .limit(10);

      // Check if any message indicates confirmation (for after_link_sent)
      const confirmationPatterns = [
        /agend(ei|ado|ou)/i, /marqu?e(i|ado|ou)/i, /confirm(ei|ado|ou)/i,
        /fiz\s*(o\s*)?(meu\s*)?(agendamento|horário|reserva)/i,
        /já\s*(agend|marqu)/i, /pronto.*agend/i, /feito/i,
        /consegui.*agend/i, /reserv(ei|ado|ou)/i,
      ];

      const hasConfirmed = recentMessages?.some((msg) =>
        confirmationPatterns.some((pattern) => pattern.test(msg.content))
      );

      if (hasConfirmed) {
        console.log(`Follow-up ${followUp.id}: client confirmed, marking as confirmed`);
        await supabase
          .from("follow_ups")
          .update({ status: "confirmed", confirmed_at: new Date().toISOString() })
          .eq("id", followUp.id);
        continue;
      }

      // For "after_no_reply" type: if the client sent ANY message after the follow-up was created,
      // it means they replied → cancel the follow-up
      if (recentMessages && recentMessages.length > 0) {
        console.log(`Follow-up ${followUp.id}: client replied (${recentMessages.length} msgs), expiring`);
        await supabase
          .from("follow_ups")
          .update({ status: "expired" })
          .eq("id", followUp.id);
        skipped++;
        continue;
      }

      // Send follow-up message
      const message = followUp.follow_up_message ||
        "Oi! Vi que te mandei o link pra agendar, conseguiu marcar certinho? Se tiver qualquer dúvida, tô aqui! 😊";

      try {
        const sendRes = await fetch(`${uazapiUrl}/send/text`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "token": uazapiToken,
          },
          body: JSON.stringify({ number: followUp.phone_number, text: message }),
        });

        const sendData = await sendRes.json();
        console.log(`Follow-up ${followUp.id}: sent to ${followUp.phone_number}`, JSON.stringify(sendData).slice(0, 200));

        await supabase
          .from("follow_ups")
          .update({ status: "sent", sent_at: new Date().toISOString() })
          .eq("id", followUp.id);

        await supabase.from("chat_messages").insert({
          tenant_id: followUp.tenant_id,
          phone_number: followUp.phone_number,
          role: "assistant",
          content: message,
        });

        sent++;
      } catch (sendErr) {
        console.error(`Follow-up ${followUp.id}: send failed:`, sendErr);
        errors++;
      }
    }

    console.log(`Follow-ups processed: ${sent} sent, ${skipped} skipped (replied), ${errors} errors`);

    return new Response(JSON.stringify({ status: "ok", sent, skipped, errors, total: pendingFollowUps.length }), {
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
