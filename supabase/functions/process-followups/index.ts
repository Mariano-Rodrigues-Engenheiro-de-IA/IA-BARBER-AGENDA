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

/** Compara dois telefones brasileiros tolerando o "9" extra do celular
 * (5561983012868 vs 556183012868), mesma regra usada no webhook. */
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

  // ===== Auth guard: shared secret OR service-role bearer =====
  const cronSecret = Deno.env.get("CRON_SECRET");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const providedSecret = req.headers.get("x-cron-secret") || req.headers.get("x-webhook-secret");
  const authHeader = req.headers.get("Authorization") || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  const secretOk = cronSecret && providedSecret && providedSecret === cronSecret;
  const serviceOk = bearer && bearer === serviceRoleKey;

  if (!secretOk && !serviceOk) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    serviceRoleKey
  );

  try {
    // ===== PASS 1: detect post-send conversions =====
    // Para cada follow-up "sent" recente, se o cliente respondeu DEPOIS do envio,
    // marca como "confirmed" (= Convertido / Resgatado).
    let postSendConversions = 0;
    try {
      const sinceSent = new Date(Date.now() - 30 * 86400000).toISOString();
      const { data: sentFollowUps } = await supabase
        .from("follow_ups")
        .select("id, tenant_id, phone_number, sent_at")
        .eq("status", "sent")
        .gte("sent_at", sinceSent)
        .limit(500);

      for (const f of sentFollowUps ?? []) {
        if (!f.sent_at) continue;
        const { data: replies } = await supabase
          .from("chat_messages")
          .select("id")
          .eq("tenant_id", f.tenant_id)
          .eq("phone_number", f.phone_number)
          .eq("role", "user")
          .gt("created_at", f.sent_at)
          .limit(1);
        if (replies && replies.length > 0) {
          await supabase.from("follow_ups").update({
            status: "confirmed",
            confirmed_at: new Date().toISOString(),
          }).eq("id", f.id);
          postSendConversions++;
        }
      }
    } catch (e) {
      console.error("post-send conversion scan failed:", e);
    }

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
      return new Response(JSON.stringify({ status: "no_pending", count: 0, postSendConversions }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`Processing ${pendingFollowUps.length} pending follow-ups (post-send conversions: ${postSendConversions})`);

    let sent = 0, errors = 0, skipped = 0, chained = 0;

    // 🔒 Anti-loop: números de instâncias da própria plataforma nunca recebem
    // follow-up (senão duas IAs nossas conversam entre si).
    const { data: allTenantsRaw } = await supabase
      .from("tenants")
      .select("id, name, whatsapp_number");
    const instanceNumbers: Array<{ name: string; number: string }> = (allTenantsRaw ?? [])
      .filter((t: any) => t.whatsapp_number)
      .map((t: any) => ({ name: t.name, number: String(t.whatsapp_number) }));

    // Cache dos IDs de etiqueta "IA OFF" por tenant (mesma fonte usada pelo webhook:
    // crm_boards.columns com type="flag", com fallback pro kanban_columns legado).
    const iaOffCache = new Map<string, string[]>();
    async function loadIaOffLabelIds(tenantId: string, legacyCols: any): Promise<string[]> {
      if (iaOffCache.has(tenantId)) return iaOffCache.get(tenantId)!;
      const cols: any[] = [];
      const { data: boards } = await supabase
        .from("crm_boards")
        .select("columns")
        .eq("tenant_id", tenantId);
      for (const b of boards ?? []) if (Array.isArray(b.columns)) cols.push(...b.columns);
      if (cols.length === 0 && Array.isArray(legacyCols)) cols.push(...legacyCols);
      const ids = cols
        .filter((c: any) => c?.type === "flag" && /ia\s*off/i.test(String(c?.name ?? "")))
        .map((c: any) => String(c.label_id));
      iaOffCache.set(tenantId, ids);
      return ids;
    }

    /** Cancela o follow-up registrando o motivo (nunca descartar em silêncio). */
    async function cancelFollowUp(id: string, reason: string, logLine: string) {
      console.log(logLine);
      await supabase.from("follow_ups").update({
        status: "expired",
        cancelled_at: new Date().toISOString(),
        cancel_reason: reason,
      }).eq("id", id);
      skipped++;
    }

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

      // 🔒 Anti-loop: nunca mandar follow-up pro número de outra instância nossa.
      const selfInstance = instanceNumbers.find((t) => tolerantPhoneMatch(followUp.phone_number, t.number));
      if (selfInstance) {
        await cancelFollowUp(
          followUp.id,
          "self_instance_loop",
          `[AntiLoop] Follow-up ${followUp.id} cancelado: ${followUp.phone_number} é o número da instância "${selfInstance.name}".`,
        );
        continue;
      }

      // 🔒 IA OFF: se o contato está etiquetado como IA OFF, a IA não fala com ele
      // — inclusive em follow-up automático.
      const iaOffLabelIds = await loadIaOffLabelIds(followUp.tenant_id, tenant.kanban_columns);
      const { data: leadRow } = await supabase
        .from("crm_leads")
        .select("flag_labels")
        .eq("tenant_id", followUp.tenant_id)
        .eq("phone_number", followUp.phone_number)
        .limit(1);
      const leadFlags: string[] = (leadRow?.[0]?.flag_labels ?? []).map((f: any) => String(f));
      const hasIaOff = leadFlags.some((f) => iaOffLabelIds.includes(f) || /ia\s*off/i.test(f));
      if (hasIaOff) {
        await cancelFollowUp(
          followUp.id,
          "ia_off",
          `[IA OFF] Follow-up ${followUp.id} cancelado: ${followUp.phone_number} está com etiqueta IA OFF (flags=${JSON.stringify(leadFlags)}).`,
        );
        continue;
      }

      // 🔒 Conversa pausada manualmente (atendimento humano em andamento).
      const { data: pauseRow } = await supabase
        .from("conversation_pauses")
        .select("paused")
        .eq("tenant_id", followUp.tenant_id)
        .eq("phone_number", followUp.phone_number)
        .maybeSingle();
      if (pauseRow?.paused) {
        await cancelFollowUp(
          followUp.id,
          "conversation_paused",
          `[Paused] Follow-up ${followUp.id} cancelado: conversa com ${followUp.phone_number} está pausada.`,
        );
        continue;
      }


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
