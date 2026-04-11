import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, token",
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
    const payload = await req.json();
    console.log("Webhook received:", JSON.stringify(payload).slice(0, 1000));

    const event = payload.EventType || payload.event || payload.type;
    console.log("Event type:", event);

    if (event === "messages.upsert" || event === "message" || event === "messages") {
      const msg = payload.message || payload.data?.message || payload.data || payload;

      // Detect message type
      const messageType = msg.messageType || msg.type || payload.messageType || "";
      const isAudioMessage = /audio|ptt/i.test(messageType);
      const isImageMessage = /image/i.test(messageType);
      const hasMedia = isAudioMessage || isImageMessage;

      const messageContent = msg.conversation || msg.text || msg.body ||
        msg?.extendedTextMessage?.text || msg?.message?.conversation ||
        msg?.message?.extendedTextMessage?.text ||
        payload.text || payload.body ||
        msg?.imageMessage?.caption || msg?.message?.imageMessage?.caption || "";

      const remoteJid = extractRemoteJid(payload, msg);
      const phoneMatch = extractPhoneNumber(payload, msg);
      const phoneNumber = phoneMatch?.phone ?? normalizePhoneNumber(remoteJid);

      const fromMe = payload.fromMe === true ||
        msg.fromMe === true ||
        msg.key?.fromMe === true ||
        payload.chat?.lastMessage_fromMe === true ||
        (payload.sender && payload.owner && payload.sender === payload.owner);
      const isGroupMessage = String(remoteJid || "").endsWith("@g.us");

      console.log(
        "Parsed - remoteJid:", remoteJid,
        "phoneNumber:", phoneNumber,
        "phoneSource:", phoneMatch?.source,
        "fromMe:", fromMe,
        "messageType:", messageType,
        "hasMedia:", hasMedia,
        "content:", messageContent?.slice(0, 100)
      );

      if (fromMe || !phoneNumber || isGroupMessage) {
        return new Response(JSON.stringify({ status: "skipped" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (!messageContent && !hasMedia) {
        console.log("No text content or media in message, skipping");
        return new Response(JSON.stringify({ status: "no_text" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const messageId = msg.key?.id || msg.id || payload.key?.id || payload.id || payload.chat?.lastMessage_id;
      console.log(`Message from ${phoneNumber}: ${messageContent}`, "messageId:", messageId, "msg.key:", JSON.stringify(msg.key || {}));

      // ===== TENANT LOOKUP: match by whatsapp_number =====
      const { data: tenants, error: tenantError } = await supabase
        .from("tenants")
        .select("*")
        .eq("status", "active");

      if (tenantError || !tenants?.length) {
        console.error("No tenant found:", tenantError);
        return new Response(JSON.stringify({ error: "No tenant configured" }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // 1) Match by UAZAPI BaseUrl from payload (most reliable for multi-tenant)
      const incomingBaseUrl = (payload.BaseUrl || "").replace(/\/+$/, "").toLowerCase();
      let tenant = incomingBaseUrl
        ? tenants.find((t: any) => {
            if (!t.uazapi_url) return false;
            return t.uazapi_url.replace(/\/+$/, "").toLowerCase() === incomingBaseUrl;
          })
        : null;

      // 2) Match by whatsapp_number
      if (!tenant) {
        tenant = tenants.find((t: any) => {
          if (!t.whatsapp_number) return false;
          const normalized = t.whatsapp_number.replace(/\D/g, "");
          return phoneNumber.includes(normalized) || normalized.includes(phoneNumber);
        });
      }

      // 3) Match from owner/receiving number in payload
      if (!tenant) {
        const ownerNumber = payload.owner || payload.to || payload.chat?.owner || "";
        const ownerDigits = String(ownerNumber).replace(/\D/g, "");
        if (ownerDigits) {
          tenant = tenants.find((t: any) => {
            if (!t.whatsapp_number) return false;
            const normalized = t.whatsapp_number.replace(/\D/g, "");
            return ownerDigits.includes(normalized) || normalized.includes(ownerDigits);
          });
        }
      }

      if (!tenant) tenant = tenants[0]; // fallback

      const provider: string = tenant.api_provider || "trinks";
      console.log(`Tenant matched: ${tenant.name} (${tenant.id}), provider: ${provider}`);

      if (messageId) {
        const { data: existing } = await supabase
          .from("chat_messages")
          .select("id")
          .eq("message_id", messageId)
          .limit(1);
        if (existing?.length) {
          return new Response(JSON.stringify({ status: "duplicate" }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      // ❌ = reset memory for this user
      if (messageContent.trim() === "❌") {
        const { error: delError } = await supabase
          .from("chat_messages")
          .delete()
          .eq("tenant_id", tenant.id)
          .eq("phone_number", phoneNumber);
        console.log(`Memory reset for ${phoneNumber}:`, delError ? delError.message : "OK");

        const uazapiUrl = tenant.uazapi_url || Deno.env.get("UAZAPI_URL");
        const uazapiToken = tenant.uazapi_token || Deno.env.get("UAZAPI_TOKEN");
        await fetch(`${uazapiUrl}/send/text`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json", "token": uazapiToken },
          body: JSON.stringify({ number: phoneNumber, text: "🔄 Memória limpa! Pode começar uma nova conversa." }),
        });

        return new Response(JSON.stringify({ status: "memory_reset" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Download media if present
      let mediaBase64: string | null = null;
      let mediaMimeType: string | null = null;

      if (hasMedia && messageId) {
        try {
          const uazapiUrlMedia = tenant.uazapi_url || Deno.env.get("UAZAPI_URL");
          const uazapiTokenMedia = tenant.uazapi_token || Deno.env.get("UAZAPI_TOKEN");

          console.log(`Downloading media for messageId: ${messageId}`);

          let gotMedia = false;

          // UAZAPI v2: POST /message/download with {id} in JSON body
          try {
            const dlRes = await fetch(`${uazapiUrlMedia}/message/download`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "Accept": "application/json", "token": uazapiTokenMedia },
              body: JSON.stringify({ id: messageId }),
            });
            console.log(`POST /message/download status: ${dlRes.status}`);
            if (dlRes.ok) {
              const ct = dlRes.headers.get("content-type") || "";
              if (ct.includes("json")) {
                const dlData = await dlRes.json();
                console.log("message/download JSON keys:", Object.keys(dlData || {}));
                const base64Content = dlData?.base64 || dlData?.data || dlData?.file || dlData?.content;
                if (base64Content && typeof base64Content === "string" && base64Content.length > 100) {
                  if (base64Content.startsWith("data:")) {
                    const [header, data] = base64Content.split(",", 2);
                    mediaMimeType = header.match(/data:([^;]+)/)?.[1] || (isAudioMessage ? "audio/ogg" : "image/jpeg");
                    mediaBase64 = data;
                  } else {
                    mediaBase64 = base64Content;
                    mediaMimeType = dlData?.mimetype || dlData?.mimeType || (isAudioMessage ? "audio/ogg" : "image/jpeg");
                  }
                  gotMedia = true;
                  console.log(`Media via POST /message/download (json): ${mediaMimeType}, size: ${mediaBase64!.length} chars`);
                }
                // Check if response has a URL instead of base64
                const mediaUrl = dlData?.url || dlData?.fileUrl || dlData?.link || dlData?.mediaUrl;
                if (!gotMedia && mediaUrl) {
                  const mediaRes = await fetch(mediaUrl);
                  if (mediaRes.ok) {
                    const mediaBuffer = await mediaRes.arrayBuffer();
                    const bytes = new Uint8Array(mediaBuffer);
                    let binary = "";
                    for (let i = 0; i < bytes.length; i++) {
                      binary += String.fromCharCode(bytes[i]);
                    }
                    mediaBase64 = btoa(binary);
                    mediaMimeType = dlData?.mimetype || dlData?.mimeType || mediaRes.headers.get("content-type") || (isAudioMessage ? "audio/ogg" : "image/jpeg");
                    gotMedia = true;
                    console.log(`Media via POST /message/download (url): ${mediaMimeType}, size: ${mediaBase64.length} chars`);
                  }
                }
              } else {
                // Binary response
                const buf = await dlRes.arrayBuffer();
                if (buf.byteLength > 100) {
                  const bytes = new Uint8Array(buf);
                  let binary = "";
                  for (let i = 0; i < bytes.length; i++) {
                    binary += String.fromCharCode(bytes[i]);
                  }
                  mediaBase64 = btoa(binary);
                  mediaMimeType = ct || (isAudioMessage ? "audio/ogg" : "image/jpeg");
                  gotMedia = true;
                  console.log(`Media via POST /message/download (binary): ${mediaMimeType}, size: ${mediaBase64.length} chars`);
                }
              }
            }
          } catch (e) {
            console.log("POST /message/download failed:", e);
          }

          // Fallback: GET /message/download/{id}
          if (!gotMedia) {
            try {
              const dlRes2 = await fetch(`${uazapiUrlMedia}/message/download/${messageId}`, {
                headers: { "token": uazapiTokenMedia },
              });
              console.log(`GET /message/download/${messageId} status: ${dlRes2.status}`);
              if (dlRes2.ok) {
                const ct = dlRes2.headers.get("content-type") || "";
                if (ct.includes("json")) {
                  const dlData = await dlRes2.json();
                  const base64Content = dlData?.base64 || dlData?.data || dlData?.file || dlData?.content;
                  if (base64Content && typeof base64Content === "string" && base64Content.length > 100) {
                    if (base64Content.startsWith("data:")) {
                      const [header, data] = base64Content.split(",", 2);
                      mediaMimeType = header.match(/data:([^;]+)/)?.[1] || (isAudioMessage ? "audio/ogg" : "image/jpeg");
                      mediaBase64 = data;
                    } else {
                      mediaBase64 = base64Content;
                      mediaMimeType = dlData?.mimetype || dlData?.mimeType || (isAudioMessage ? "audio/ogg" : "image/jpeg");
                    }
                    gotMedia = true;
                    console.log(`Media via GET /message/download (json): ${mediaMimeType}, size: ${mediaBase64!.length} chars`);
                  }
                } else {
                  const buf = await dlRes2.arrayBuffer();
                  if (buf.byteLength > 100) {
                    const bytes = new Uint8Array(buf);
                    let binary = "";
                    for (let i = 0; i < bytes.length; i++) {
                      binary += String.fromCharCode(bytes[i]);
                    }
                    mediaBase64 = btoa(binary);
                    mediaMimeType = ct || (isAudioMessage ? "audio/ogg" : "image/jpeg");
                    gotMedia = true;
                    console.log(`Media via GET /message/download (binary): ${mediaMimeType}, size: ${mediaBase64.length} chars`);
                  }
                }
              }
            } catch (e) {
              console.log("GET /message/download fallback failed:", e);
            }
          }

          if (!gotMedia) {
            console.error("All media download methods failed for messageId:", messageId);
          }
        } catch (mediaErr) {
          console.error("Error downloading media:", mediaErr);
        }
      }

      // Build text content for storage
      const storedContent = isAudioMessage 
        ? (messageContent || "[Áudio recebido]") 
        : isImageMessage 
          ? (messageContent || "[Imagem recebida]") 
          : messageContent;

      // Save message as unprocessed for debounce queue
      await supabase.from("chat_messages").insert({
        tenant_id: tenant.id,
        phone_number: phoneNumber,
        role: "user",
        content: storedContent,
        message_id: messageId,
        processed: false,
      });

      // ===== DEBOUNCE: Wait for more messages, then claim atomically =====
      const DEBOUNCE_MS = 10_000;
      console.log(`Debounce: waiting ${DEBOUNCE_MS / 1000}s for ${phoneNumber}...`);
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS));

      const { data: unclaimed, error: unclaimedErr } = await supabase
        .from("chat_messages")
        .select("id, content, created_at")
        .eq("tenant_id", tenant.id)
        .eq("phone_number", phoneNumber)
        .eq("role", "user")
        .eq("processed", false)
        .order("created_at", { ascending: true });

      console.log(`Debounce: found ${unclaimed?.length || 0} unclaimed messages for ${phoneNumber}`, unclaimedErr ? `error: ${unclaimedErr.message}` : "");

      if (!unclaimed?.length) {
        console.log(`Debounce: no unclaimed messages for ${phoneNumber}, another webhook handled them`);
        return new Response(JSON.stringify({ status: "debounce_skip" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const unclaimedIds = unclaimed.map((m: any) => m.id);
      const { data: claimed, error: claimErr } = await supabase
        .from("chat_messages")
        .update({ processed: true })
        .in("id", unclaimedIds)
        .eq("processed", false)
        .select("id");

      console.log(`Debounce: claimed ${claimed?.length || 0} of ${unclaimed.length} messages`, claimErr ? `error: ${claimErr.message}` : "");

      if (!claimed?.length) {
        console.log(`Debounce: claim race lost for ${phoneNumber}, another webhook got them`);
        return new Response(JSON.stringify({ status: "debounce_skip" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const claimedIds = new Set(claimed.map((c: any) => c.id));
      const claimedMessages = unclaimed.filter((m: any) => claimedIds.has(m.id));
      const combinedContent = claimedMessages.map((m: any) => m.content).join("\n");
      console.log(`Debounce: processing ${claimedMessages.length} messages combined for ${phoneNumber}`);

      const { data: historyRaw } = await supabase
        .from("chat_messages")
        .select("role, content, processed")
        .eq("tenant_id", tenant.id)
        .eq("phone_number", phoneNumber)
        .or("role.eq.assistant,processed.eq.true")
        .order("created_at", { ascending: false })
        .limit(60);
      const history = (historyRaw || []).reverse();

      // Provider-specific direct handlers
      let directResponse: string | null = null;
      if (provider === "trinks") {
        directResponse = await maybeHandleDirectCancellationConfirmation(tenant, phoneNumber, history || [], combinedContent);
      }

      let aiResponse: string;
      let agentResult: AgentResult | null = null;

      if (directResponse) {
        aiResponse = directResponse;
      } else {
        agentResult = await callAIAgent(tenant, phoneNumber, history || [], combinedContent, provider, mediaBase64, mediaMimeType);
        aiResponse = agentResult.response;
      }

      // Log to agent_logs
      await supabase.from("agent_logs").insert({
        tenant_id: tenant.id,
        phone_number: phoneNumber,
        user_message: combinedContent,
        ai_response: aiResponse,
        tool_calls: agentResult?.toolCalls || [],
        errors: agentResult?.errors || [],
        model_used: agentResult?.model || "direct_handler",
        duration_ms: agentResult?.durationMs || 0,
        session_blocked: agentResult?.sessionBlocked || false,
      }).then(({ error }) => {
        if (error) console.error("Failed to log agent execution:", error.message);
      });

      await supabase.from("chat_messages").insert({
        tenant_id: tenant.id,
        phone_number: phoneNumber,
        role: "assistant",
        content: aiResponse,
      });

      // ===== SPLIT RESPONSE: Send each paragraph as a separate message =====
      const uazapiUrl = tenant.uazapi_url || Deno.env.get("UAZAPI_URL");
      const uazapiToken = tenant.uazapi_token || Deno.env.get("UAZAPI_TOKEN");

      const messageParts = splitIntoMessages(aiResponse);

      for (let i = 0; i < messageParts.length; i++) {
        const part = messageParts[i].trim();
        if (!part) continue;

        if (i > 0) {
          await new Promise((r) => setTimeout(r, 1500));
        }

        const sendResult = await fetch(`${uazapiUrl}/send/text`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "token": uazapiToken,
          },
          body: JSON.stringify({ number: phoneNumber, text: part }),
        });
        const sendData = await sendResult.json();
        console.log(`UAZAPI send part ${i + 1}/${messageParts.length}:`, JSON.stringify(sendData).slice(0, 200));
      }

      return new Response(JSON.stringify({ status: "ok", parts: messageParts.length }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ status: "ignored", event }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Webhook error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// ===================== AI AGENT =====================

interface AgentResult {
  response: string;
  toolCalls: { name: string; args: any; result: any; blocked?: boolean }[];
  errors: string[];
  model: string;
  durationMs: number;
  sessionBlocked: boolean;
}

interface OneBelezaServiceOption {
  servicosId: number;
  descricao: string;
}

interface OneBelezaProfessionalOption {
  servicosId: number | null;
  profissionalId: number;
  nomeProfissional: string;
}

interface OneBelezaSlotOption {
  date: string;
  servicoId: number;
  profissionalId: number;
  horarioInicio: string;
  horarioFim: string;
}

interface AgentSessionState {
  criarAgendamentoSuccessId: number | null;
  validAgendasIds: number[];
  oneBelezaServiceOptions: OneBelezaServiceOption[];
  oneBelezaProfessionalOptions: OneBelezaProfessionalOption[];
  oneBelezaSlotOptions: OneBelezaSlotOption[];
}

function parseToolArguments(rawArgs?: string): any {
  try {
    return JSON.parse(rawArgs || "{}");
  } catch {
    return {};
  }
}

function toPositiveInteger(value: unknown): number | null {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;

  const parsed = parseInt(normalized, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// Reconcile a hallucinated agendasId to the correct one from validAgendasIds
function reconcileOneBelezaAgendaId(
  hallucinated: number,
  sessionState: AgentSessionState,
  messages: any[],
): number | null {
  const validIds = sessionState.validAgendasIds;
  const agendaOptions = (sessionState as any).oneBelezaAgendaOptions as any[] | undefined;

  if (validIds.length === 1) return validIds[0];

  if (agendaOptions && agendaOptions.length > 0) {
    const lastAssistantMsg = [...messages].reverse().find((m: any) => m.role === "assistant" && typeof m.content === "string");
    const assistantText = lastAssistantMsg?.content || "";

    const timeMatch = assistantText.match(/(\d{1,2})[h:](\d{2})/);
    if (timeMatch) {
      const mentionedTime = `${timeMatch[1].padStart(2, "0")}:${timeMatch[2]}`;
      const matchByTime = agendaOptions.find((a: any) => (a.horarioInicio || "").substring(0, 5) === mentionedTime);
      if (matchByTime) return matchByTime.agendasId;
    }

    for (const agenda of agendaOptions) {
      if (agenda.descricaoServico && assistantText.toLowerCase().includes(agenda.descricaoServico.toLowerCase())) {
        const serviceMatches = agendaOptions.filter((a: any) => a.descricaoServico?.toLowerCase() === agenda.descricaoServico.toLowerCase());
        if (serviceMatches.length === 1) return serviceMatches[0].agendasId;
      }
    }
  }

  console.log(`[OneBeleza] reconcileAgendaId: fallback to first valid ID ${validIds[0]}`);
  return validIds[0];
}

function dedupeByKey<T>(items: T[], getKey: (item: T) => string): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];

  for (const item of items) {
    const key = getKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

function normalizeOneBelezaDate(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";

  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return normalized;
  }

  const brMatch = normalized.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (brMatch) {
    const [, day, month, year] = brMatch;
    return `${year}-${month}-${day}`;
  }

  return normalized;
}

function normalizeOneBelezaTime(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";

  if (/^\d{2}:\d{2}$/.test(normalized)) {
    return `${normalized}:00`;
  }

  return normalized;
}

function extractOneBelezaServiceOptions(toolResult: any): OneBelezaServiceOption[] {
  if (!Array.isArray(toolResult)) return [];

  const options: OneBelezaServiceOption[] = [];

  for (const groupOrService of toolResult) {
    const groupedServices = Array.isArray(groupOrService?.servicos)
      ? groupOrService.servicos
      : [groupOrService];

    for (const service of groupedServices) {
      const servicosId = toPositiveInteger(service?.servicosId ?? service?.servicoId ?? service?.id);
      if (!servicosId) continue;

      options.push({
        servicosId,
        descricao: String(service?.descricao || groupOrService?.descricao || `Serviço ${servicosId}`),
      });
    }
  }

  return dedupeByKey(options, (option) => String(option.servicosId));
}

function extractOneBelezaProfessionalOptions(toolResult: any, args: any): OneBelezaProfessionalOption[] {
  if (!Array.isArray(toolResult)) return [];

  const servicosId = toPositiveInteger(args?.servicosId ?? args?.servicoId ?? args?.servicoid);
  const options = toolResult.flatMap((item: any) => {
    const profissionalId = toPositiveInteger(item?.profissionalId ?? item?.id);
    if (!profissionalId) return [];

    return [{
      servicosId,
      profissionalId,
      nomeProfissional: String(item?.nomeProfissional || item?.nome || item?.descricao || `Profissional ${profissionalId}`),
    }];
  });

  return dedupeByKey(options, (option) => `${option.servicosId ?? "any"}:${option.profissionalId}`);
}

function extractOneBelezaSlotOptions(toolResult: any, args: any): OneBelezaSlotOption[] {
  if (!Array.isArray(toolResult)) return [];

  const date = normalizeOneBelezaDate(args?.date ?? args?.dataNumero ?? args?.dataAg ?? args?.data);
  const fallbackServiceId = toPositiveInteger(args?.servicoId ?? args?.servicoid ?? args?.servicosId);
  const fallbackProfessionalId = toPositiveInteger(args?.ProfissionalId ?? args?.profissionalId ?? args?.profissionalid);
  const slots: OneBelezaSlotOption[] = [];

  const pushSlot = (
    servicoIdValue: unknown,
    profissionalIdValue: unknown,
    horarioInicioValue: unknown,
    horarioFimValue: unknown,
  ) => {
    const servicoId = toPositiveInteger(servicoIdValue);
    const profissionalId = toPositiveInteger(profissionalIdValue);
    const horarioInicio = String(horarioInicioValue ?? "").trim();
    const horarioFim = String(horarioFimValue ?? "").trim();

    if (!date || !servicoId || !profissionalId || !horarioInicio || !horarioFim) return;

    slots.push({
      date,
      servicoId,
      profissionalId,
      horarioInicio,
      horarioFim,
    });
  };

  for (const item of toolResult) {
    if (Array.isArray(item?.disponibilidades)) {
      const itemServiceId = toPositiveInteger(item?.servicoId ?? item?.servicosId ?? fallbackServiceId);

      for (const disponibilidade of item.disponibilidades) {
        const itemProfessionalId = toPositiveInteger(disponibilidade?.profissionalId ?? fallbackProfessionalId);
        const horarios = Array.isArray(disponibilidade?.horarios) ? disponibilidade.horarios : [];

        for (const horario of horarios) {
          pushSlot(
            itemServiceId,
            itemProfessionalId,
            horario?.horarioInicio,
            horario?.horarioFinal ?? horario?.horarioFim,
          );
        }
      }
    }

    pushSlot(
      item?.servicoId ?? fallbackServiceId,
      item?.profissionalId ?? fallbackProfessionalId,
      item?.horarioInicio,
      item?.horarioFinal ?? item?.horarioFim,
    );
  }

  return dedupeByKey(
    slots,
    (slot) => `${slot.date}:${slot.servicoId}:${slot.profissionalId}:${slot.horarioInicio}:${slot.horarioFim}`,
  );
}

function buildNormalizedOneBelezaAgendarArgs(parsedArgs: any, slot: OneBelezaSlotOption): any {
  return {
    ...parsedArgs,
    dataNumero: slot.date,
    servicoid: String(slot.servicoId),
    profissionalId: String(slot.profissionalId),
    horarioInicio: slot.horarioInicio,
    horarioFim: slot.horarioFim,
  };
}

function reconcileOneBelezaSchedulingArgs(
  parsedArgs: any,
  sessionState: AgentSessionState,
): { args: any; adjusted: boolean; corrected: boolean } {
  const servicoId = toPositiveInteger(parsedArgs?.servicoid ?? parsedArgs?.servicoId ?? parsedArgs?.servicosId);
  const profissionalId = toPositiveInteger(parsedArgs?.profissionalId ?? parsedArgs?.ProfissionalId ?? parsedArgs?.profissionalid);
  const dataNumero = normalizeOneBelezaDate(parsedArgs?.dataNumero ?? parsedArgs?.dataAg ?? parsedArgs?.date ?? parsedArgs?.data);
  const horarioInicio = normalizeOneBelezaTime(parsedArgs?.horarioInicio);
  const horarioFim = normalizeOneBelezaTime(parsedArgs?.horarioFim ?? parsedArgs?.horarioFinal);

  const normalizedArgs = {
    ...parsedArgs,
    ...(dataNumero ? { dataNumero } : {}),
    ...(servicoId ? { servicoid: String(servicoId) } : {}),
    ...(profissionalId ? { profissionalId: String(profissionalId) } : {}),
    ...(horarioInicio ? { horarioInicio } : {}),
    ...(horarioFim ? { horarioFim } : {}),
  };

  if (!servicoId || !profissionalId || !dataNumero || !horarioInicio) {
    return {
      args: normalizedArgs,
      adjusted: JSON.stringify(normalizedArgs) !== JSON.stringify(parsedArgs),
      corrected: false,
    };
  }

  const validSlotOptions = sessionState.oneBelezaSlotOptions.filter((slot) => {
    if (slot.servicoId !== servicoId) return false;
    if (slot.profissionalId !== profissionalId) return false;
    if (slot.date !== dataNumero) return false;
    return true;
  });

  if (validSlotOptions.length === 0) {
    return {
      args: normalizedArgs,
      adjusted: JSON.stringify(normalizedArgs) !== JSON.stringify(parsedArgs),
      corrected: false,
    };
  }

  const exactMatch = validSlotOptions.find(
    (slot) => slot.horarioInicio === horarioInicio && slot.horarioFim === horarioFim,
  );
  if (exactMatch) {
    const exactArgs = buildNormalizedOneBelezaAgendarArgs(normalizedArgs, exactMatch);
    return {
      args: exactArgs,
      adjusted: JSON.stringify(exactArgs) !== JSON.stringify(parsedArgs),
      corrected: false,
    };
  }

  const startOnlyMatch = validSlotOptions.find((slot) => slot.horarioInicio === horarioInicio);
  if (!startOnlyMatch) {
    return {
      args: normalizedArgs,
      adjusted: JSON.stringify(normalizedArgs) !== JSON.stringify(parsedArgs),
      corrected: false,
    };
  }

  return {
    args: buildNormalizedOneBelezaAgendarArgs(normalizedArgs, startOnlyMatch),
    adjusted: true,
    corrected: horarioFim !== startOnlyMatch.horarioFim,
  };
}

function buildOneBelezaSchedulingValidationResult(
  parsedArgs: any,
  sessionState: AgentSessionState,
): any | null {
  if (sessionState.oneBelezaServiceOptions.length === 0) {
    return {
      error: "Antes de agendar, execute buscar_servicos nesta interação e use um servicosId real do retorno.",
      blocked: true,
    };
  }

  if (sessionState.oneBelezaProfessionalOptions.length === 0) {
    return {
      error: "Antes de agendar, execute buscar_barbeiros_por_servico nesta interação e use um profissionalId real do retorno.",
      blocked: true,
    };
  }

  if (sessionState.oneBelezaSlotOptions.length === 0) {
    return {
      error: "Antes de agendar, execute buscar_horarios nesta interação e use exatamente um horário retornado.",
      blocked: true,
    };
  }

  const servicoId = toPositiveInteger(parsedArgs?.servicoid ?? parsedArgs?.servicoId ?? parsedArgs?.servicosId);
  const profissionalId = toPositiveInteger(parsedArgs?.profissionalId ?? parsedArgs?.ProfissionalId ?? parsedArgs?.profissionalid);
  const dataNumero = normalizeOneBelezaDate(parsedArgs?.dataNumero ?? parsedArgs?.dataAg ?? parsedArgs?.date ?? parsedArgs?.data);
  const horarioInicio = normalizeOneBelezaTime(parsedArgs?.horarioInicio);
  const horarioFim = normalizeOneBelezaTime(parsedArgs?.horarioFim ?? parsedArgs?.horarioFinal);

  if (!servicoId || !sessionState.oneBelezaServiceOptions.some((option) => option.servicosId === servicoId)) {
    return {
      error: `servicoId ${servicoId ?? "(ausente)"} inválido. Use APENAS um servicosId real retornado por buscar_servicos nesta interação.`,
      validServiceOptions: sessionState.oneBelezaServiceOptions,
      blocked: true,
    };
  }

  const validProfessionalOptions = dedupeByKey(
    sessionState.oneBelezaProfessionalOptions.filter((option) => option.servicosId === servicoId || option.servicosId === null),
    (option) => String(option.profissionalId),
  );

  if (
    validProfessionalOptions.length > 0 &&
    (!profissionalId || !validProfessionalOptions.some((option) => option.profissionalId === profissionalId))
  ) {
    return {
      error: `profissionalId ${profissionalId ?? "(ausente)"} inválido para o serviço ${servicoId}. Use APENAS um profissionalId real retornado por buscar_barbeiros_por_servico nesta interação.`,
      validProfessionalOptions,
      blocked: true,
    };
  }

  if (!dataNumero || !horarioInicio || !horarioFim) {
    return {
      error: "dataNumero, horarioInicio e horarioFim são obrigatórios e devem vir EXATAMENTE do retorno de buscar_horarios.",
      validSlotOptions: sessionState.oneBelezaSlotOptions.slice(0, 20),
      blocked: true,
    };
  }

  const validSlotOptions = sessionState.oneBelezaSlotOptions.filter((slot) => {
    if (slot.servicoId !== servicoId) return false;
    if (profissionalId && slot.profissionalId !== profissionalId) return false;
    if (slot.date !== dataNumero) return false;
    return true;
  });

  if (validSlotOptions.length === 0) {
    return {
      error: `A combinação serviço=${servicoId}, profissional=${profissionalId ?? "(ausente)"} e data=${dataNumero || "(ausente)"} não foi retornada por buscar_horarios nesta interação.`,
      validSlotOptions: sessionState.oneBelezaSlotOptions.slice(0, 20),
      blocked: true,
    };
  }

  const matchingSlot = validSlotOptions.find(
    (slot) => slot.horarioInicio === horarioInicio && slot.horarioFim === horarioFim,
  );

  if (!matchingSlot) {
    return {
      error: `Horário ${horarioInicio} → ${horarioFim} inválido para serviço=${servicoId}, profissional=${profissionalId ?? "(ausente)"} e data=${dataNumero}. Use APENAS uma combinação EXATA retornada por buscar_horarios nesta interação.`,
      validSlotOptions: validSlotOptions.slice(0, 20),
      blocked: true,
    };
  }

  return null;
}

async function hydrateOneBelezaSessionStateFromProvider(
  tenant: any,
  parsedArgs: any,
  sessionState: AgentSessionState,
): Promise<void> {
  const servicoId = toPositiveInteger(parsedArgs?.servicoid ?? parsedArgs?.servicoId ?? parsedArgs?.servicosId);
  const profissionalId = toPositiveInteger(parsedArgs?.profissionalId ?? parsedArgs?.ProfissionalId ?? parsedArgs?.profissionalid);
  const dataNumero = normalizeOneBelezaDate(parsedArgs?.dataNumero ?? parsedArgs?.dataAg ?? parsedArgs?.date ?? parsedArgs?.data);

  if (!servicoId) return;

  const hasService = sessionState.oneBelezaServiceOptions.some((option) => option.servicosId === servicoId);
  if (!hasService) {
    const serviceResult = await executeOneBelezaTool(
      tenant,
      { function: { name: "buscar_servicos", arguments: "{}" } },
    );
    const serviceOptions = extractOneBelezaServiceOptions(serviceResult);
    if (serviceOptions.length > 0) {
      sessionState.oneBelezaServiceOptions = dedupeByKey(
        [...sessionState.oneBelezaServiceOptions, ...serviceOptions],
        (option) => String(option.servicosId),
      );
      console.log(`Hydrated OneBeleza service IDs: [${sessionState.oneBelezaServiceOptions.map((option) => option.servicosId).join(", ")}]`);
    }
  }

  if (profissionalId) {
    const hasProfessional = sessionState.oneBelezaProfessionalOptions.some(
      (option) => option.profissionalId === profissionalId && (option.servicosId === servicoId || option.servicosId === null),
    );

    if (!hasProfessional) {
      const professionalArgs = { servicosId: String(servicoId) };
      const professionalResult = await executeOneBelezaTool(
        tenant,
        {
          function: {
            name: "buscar_barbeiros_por_servico",
            arguments: JSON.stringify(professionalArgs),
          },
        },
      );
      const professionalOptions = extractOneBelezaProfessionalOptions(professionalResult, professionalArgs);
      if (professionalOptions.length > 0) {
        sessionState.oneBelezaProfessionalOptions = dedupeByKey(
          [...sessionState.oneBelezaProfessionalOptions, ...professionalOptions],
          (option) => `${option.servicosId ?? "any"}:${option.profissionalId}`,
        );
        console.log(`Hydrated OneBeleza professional IDs: [${sessionState.oneBelezaProfessionalOptions.map((option) => option.profissionalId).join(", ")}]`);
      }
    }
  }

  if (profissionalId && dataNumero) {
    const hasSlot = sessionState.oneBelezaSlotOptions.some(
      (slot) => slot.servicoId === servicoId && slot.profissionalId === profissionalId && slot.date === dataNumero,
    );

    if (!hasSlot) {
      const slotArgs = {
        date: dataNumero,
        servicoId: String(servicoId),
        ProfissionalId: String(profissionalId),
      };
      const slotResult = await executeOneBelezaTool(
        tenant,
        {
          function: {
            name: "buscar_horarios",
            arguments: JSON.stringify(slotArgs),
          },
        },
      );
      const slotOptions = extractOneBelezaSlotOptions(slotResult, slotArgs);
      if (slotOptions.length > 0) {
        sessionState.oneBelezaSlotOptions = dedupeByKey(
          [...sessionState.oneBelezaSlotOptions, ...slotOptions],
          (slot) => `${slot.date}:${slot.servicoId}:${slot.profissionalId}:${slot.horarioInicio}:${slot.horarioFim}`,
        );
        console.log(`Hydrated OneBeleza slot options: ${sessionState.oneBelezaSlotOptions.length}`);
      }
    }
  }
}

async function callAIAgent(
  tenant: any,
  phoneNumber: string,
  history: { role: string; content: string }[],
  userMessage: string,
  provider: string,
  mediaBase64?: string | null,
  mediaMimeType?: string | null,
): Promise<AgentResult> {
  const startTime = Date.now();
  const logToolCalls: AgentResult["toolCalls"] = [];
  const logErrors: string[] = [];
  let sessionBlocked = false;
  const modelUsed = "google/gemini-2.5-flash";
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

  const systemPrompt = buildSystemPrompt(tenant, phoneNumber, provider);
  const messages: any[] = [
    { role: "system", content: systemPrompt },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];

  // Build the user message — multimodal if media is present
  const lastMsg = messages[messages.length - 1];
  const alreadyHasUserMsg = lastMsg?.role === "user" && lastMsg?.content === userMessage;

  if (mediaBase64 && mediaMimeType) {
    const contentParts: any[] = [];

    if (mediaMimeType.startsWith("audio/")) {
      contentParts.push({
        type: "image_url",
        image_url: { url: `data:${mediaMimeType};base64,${mediaBase64}` },
      });
      contentParts.push({
        type: "text",
        text: userMessage || "O cliente enviou um áudio. Transcreva o que foi dito e responda ao conteúdo. NÃO peça para o cliente repetir em texto.",
      });
    } else if (mediaMimeType.startsWith("image/")) {
      contentParts.push({
        type: "image_url",
        image_url: { url: `data:${mediaMimeType};base64,${mediaBase64}` },
      });
      contentParts.push({
        type: "text",
        text: userMessage || "O cliente enviou uma imagem. Descreva o que vê e responda adequadamente.",
      });
    }

    if (alreadyHasUserMsg) {
      messages[messages.length - 1] = { role: "user", content: contentParts };
    } else {
      messages.push({ role: "user", content: contentParts });
    }
  } else if (!alreadyHasUserMsg) {
    messages.push({ role: "user", content: userMessage });
  }

  // ===== PROVIDER DISPATCHER: build tools based on provider =====
  const tools = buildToolsForProvider(provider, tenant);

  let response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LOVABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages,
      tools,
      tool_choice: "auto",
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error("AI gateway error:", response.status, errText);
    logErrors.push(`AI gateway error: ${response.status} ${errText.slice(0, 200)}`);
    return { response: "Desculpe, estou com dificuldades técnicas no momento. Por favor, tente novamente em instantes.", toolCalls: logToolCalls, errors: logErrors, model: modelUsed, durationMs: Date.now() - startTime, sessionBlocked };
  }

  let result = await response.json();
  let assistantMessage = result.choices?.[0]?.message;

  // Handle tool calls (up to 8 rounds)
  let rounds = 0;
  const sessionState: AgentSessionState = {
    criarAgendamentoSuccessId: null,
    validAgendasIds: [],
    oneBelezaServiceOptions: [],
    oneBelezaProfessionalOptions: [],
    oneBelezaSlotOptions: [],
  };

  while (assistantMessage?.tool_calls && rounds < 8) {
    rounds++;
    messages.push(assistantMessage);

    for (const toolCall of assistantMessage.tool_calls) {
      let parsedArgs = parseToolArguments(toolCall.function.arguments);
      const originalParsedArgs = JSON.parse(JSON.stringify(parsedArgs || {}));
      let toolCallToExecute = toolCall;
      console.log(`Tool call: ${toolCall.function.name}`, toolCall.function.arguments);

      let toolResult: any;
      let wasBlocked = false;

      // Block duplicate scheduling across all providers
      const isSchedulingTool = ["criar_agendamento", "agendar"].includes(toolCall.function.name);
      if (isSchedulingTool && sessionState.criarAgendamentoSuccessId) {
        console.log(`${toolCall.function.name} BLOCKED: already created id=${sessionState.criarAgendamentoSuccessId} in this session`);
        toolResult = {
          id: sessionState.criarAgendamentoSuccessId,
          message: "Agendamento já foi criado com sucesso nesta interação. NÃO crie outro. Confirme o agendamento existente ao cliente.",
          blocked: true,
        };
        wasBlocked = true;
        sessionBlocked = true;
      } else {
        // Auto-correct desmarcar/confirmar agendasId
        const isAgendaIdTool = ["desmarcar_agendamento", "confirmar_agendamento"].includes(toolCall.function.name);
        if (isAgendaIdTool && provider === "onebeleza") {
          // If validAgendasIds is empty (new invocation), auto-fetch agendamentos
          if (sessionState.validAgendasIds.length === 0) {
            console.log(`[OneBeleza] ${toolCall.function.name}: validAgendasIds empty, auto-fetching agendamentos...`);
            const today = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().split("T")[0];
            const fetchResult = await executeToolForProvider(provider, tenant, {
              ...toolCall,
              function: { name: "buscar_agendamentos_dia", arguments: JSON.stringify({ date: today }) },
            }, phoneNumber);
            if (Array.isArray(fetchResult)) {
              sessionState.validAgendasIds = fetchResult.map((a: any) => a.agendasId).filter((id: any) => typeof id === "number");
              // Also store full agenda data for smart matching
              (sessionState as any).oneBelezaAgendaOptions = fetchResult;
              console.log(`[OneBeleza] Auto-fetched validAgendasIds: [${sessionState.validAgendasIds}]`);
            }
          }

          const usedId = toPositiveInteger(parsedArgs.agendasId);
          if (usedId && sessionState.validAgendasIds.length > 0 && !sessionState.validAgendasIds.includes(usedId)) {
            // Try to find the best match from conversation context
            const correctedId = reconcileOneBelezaAgendaId(usedId, sessionState, messages);
            if (correctedId) {
              console.log(`[OneBeleza] ${toolCall.function.name} auto-corrected agendasId: ${usedId} → ${correctedId}`);
              parsedArgs.agendasId = String(correctedId);
              toolCallToExecute = {
                ...toolCall,
                function: { ...toolCall.function, arguments: JSON.stringify(parsedArgs) },
              };
            } else {
              console.log(`${toolCall.function.name} BLOCKED: agendasId ${usedId} not in valid list [${sessionState.validAgendasIds}], no match found`);
              toolResult = {
                error: `agendasId ${usedId} é inválido. Os IDs reais são: ${sessionState.validAgendasIds.join(", ")}. Use APENAS esses IDs.`,
                validIds: sessionState.validAgendasIds,
                blocked: true,
              };
              wasBlocked = true;
              sessionBlocked = true;
            }
          } else if (usedId && sessionState.validAgendasIds.length === 0) {
            console.log(`${toolCall.function.name} WARNING: no valid agenda IDs found, proceeding with AI's ID ${usedId}`);
          }
        }

        if (!toolResult && provider === "onebeleza" && toolCall.function.name === "agendar") {
          await hydrateOneBelezaSessionStateFromProvider(tenant, parsedArgs, sessionState);
          const reconciledSchedulingArgs = reconcileOneBelezaSchedulingArgs(parsedArgs, sessionState);
          parsedArgs = reconciledSchedulingArgs.args;

          if (reconciledSchedulingArgs.adjusted) {
            toolCallToExecute = {
              ...toolCall,
              function: {
                ...toolCall.function,
                arguments: JSON.stringify(parsedArgs),
              },
            };
          }

          if (reconciledSchedulingArgs.corrected) {
            console.log(
              `[OneBeleza] agendar auto-corrected slot args:`,
              JSON.stringify({
                originalArgs: originalParsedArgs,
                resolvedArgs: parsedArgs,
              }).slice(0, 1000),
            );
          }

          toolResult = buildOneBelezaSchedulingValidationResult(parsedArgs, sessionState);

          if (toolResult) {
            console.log(`[OneBeleza] agendar BLOCKED by session validation:`, JSON.stringify(toolResult).slice(0, 1000));
            wasBlocked = true;
            sessionBlocked = true;
          }
        }

        if (!toolResult) {
          // ===== PROVIDER DISPATCHER: execute tool based on provider =====
          toolResult = await executeToolForProvider(provider, tenant, toolCallToExecute, phoneNumber);
        }

        // Track successful creation
        if (isSchedulingTool && toolResult?.id && !toolResult?.error && !toolResult?.blocked) {
          sessionState.criarAgendamentoSuccessId = toolResult.id;
          console.log(`${toolCall.function.name}: session locked with id=${toolResult.id}`);
        }

        // Track valid agendasIds from buscar_agendamentos_dia
        if (toolCall.function.name === "buscar_agendamentos_dia" && Array.isArray(toolResult)) {
          sessionState.validAgendasIds = toolResult.map((a: any) => a.agendasId).filter((id: any) => typeof id === "number");
          (sessionState as any).oneBelezaAgendaOptions = toolResult;
          console.log(`Tracked validAgendasIds: [${sessionState.validAgendasIds}]`);
        }

        if (provider === "onebeleza" && toolCall.function.name === "buscar_servicos") {
          sessionState.oneBelezaServiceOptions = extractOneBelezaServiceOptions(toolResult);
          console.log(`Tracked OneBeleza service IDs: [${sessionState.oneBelezaServiceOptions.map((option) => option.servicosId).join(", ")}]`);
        }

        if (provider === "onebeleza" && toolCall.function.name === "buscar_barbeiros_por_servico") {
          const professionalOptions = extractOneBelezaProfessionalOptions(toolResult, parsedArgs);
          sessionState.oneBelezaProfessionalOptions = dedupeByKey(
            [...sessionState.oneBelezaProfessionalOptions, ...professionalOptions],
            (option) => `${option.servicosId ?? "any"}:${option.profissionalId}`,
          );
          console.log(`Tracked OneBeleza professional IDs: [${sessionState.oneBelezaProfessionalOptions.map((option) => option.profissionalId).join(", ")}]`);
        }

        if (provider === "onebeleza" && toolCall.function.name === "buscar_horarios") {
          const slotOptions = extractOneBelezaSlotOptions(toolResult, parsedArgs);
          sessionState.oneBelezaSlotOptions = dedupeByKey(
            [...sessionState.oneBelezaSlotOptions, ...slotOptions],
            (slot) => `${slot.date}:${slot.servicoId}:${slot.profissionalId}:${slot.horarioInicio}:${slot.horarioFim}`,
          );
          console.log(`Tracked OneBeleza slot options: ${sessionState.oneBelezaSlotOptions.length}`);
        }
      }

      logToolCalls.push({ name: toolCall.function.name, args: parsedArgs, result: toolResult, blocked: wasBlocked });

      if (toolResult?.error) {
        logErrors.push(`Tool ${toolCall.function.name}: ${JSON.stringify(toolResult.error).slice(0, 200)}`);
      }

      console.log(`Tool result (${toolCall.function.name}):`, JSON.stringify(toolResult).slice(0, 500));
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(toolResult),
      });
    }

    response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages,
        tools,
        tool_choice: "auto",
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("AI gateway error (tool round):", response.status, errText);
      logErrors.push(`AI gateway error (round ${rounds}): ${response.status} ${errText.slice(0, 200)}`);
      return { response: "Desculpe, tive um problema ao consultar o sistema. Tente novamente.", toolCalls: logToolCalls, errors: logErrors, model: modelUsed, durationMs: Date.now() - startTime, sessionBlocked };
    }

    result = await response.json();
    assistantMessage = result.choices?.[0]?.message;
  }

  const finalResponse = assistantMessage?.content || "Desculpe, não consegui processar sua solicitação.";
  return { response: finalResponse, toolCalls: logToolCalls, errors: logErrors, model: modelUsed, durationMs: Date.now() - startTime, sessionBlocked };
}

// ===================== PROVIDER DISPATCHER =====================

function buildToolsForProvider(provider: string, tenant: any): any[] | undefined {
  let providerTools: any[] | undefined;
  switch (provider) {
    case "trinks":
      providerTools = buildTrinksTools(tenant);
      break;
    case "onebeleza":
      providerTools = buildOneBelezaTools(tenant);
      break;
    case "none":
      providerTools = buildNoneTools(tenant);
      break;
    default:
      providerTools = buildTrinksTools(tenant);
  }

  // Inject custom tools from tenant.agent_settings
  const customTools = getEnabledCustomTools(tenant);
  if (customTools.length > 0) {
    const customToolDefs = customTools.map((ct: any) => ({
      type: "function",
      function: {
        name: ct.name,
        description: ct.description || ct.display_name,
        parameters: {
          type: "object",
          properties: ct.type === "escalate_human" ? {
            motivo: { type: "string", description: "Motivo para escalar para atendente humano" },
          } : {},
          required: [],
        },
      },
    }));
    providerTools = [...(providerTools || []), ...customToolDefs];
  }

  return providerTools;
}

function getEnabledCustomTools(tenant: any): any[] {
  const settings = tenant?.agent_settings;
  if (!settings || typeof settings !== "object") return [];
  const tools = settings.custom_tools;
  if (!Array.isArray(tools)) return [];
  return tools.filter((t: any) => t.enabled === true);
}

async function executeToolForProvider(provider: string, tenant: any, toolCall: any, phoneNumber?: string): Promise<any> {
  const funcName = toolCall.function.name;

  // Check if it's a custom tool first
  const customTools = getEnabledCustomTools(tenant);
  const customTool = customTools.find((ct: any) => ct.name === funcName);
  if (customTool) {
    return executeCustomTool(tenant, customTool, phoneNumber || "");
  }

  switch (provider) {
    case "trinks":
      return executeTrinksTool(tenant, toolCall, phoneNumber);
    case "onebeleza":
      return executeOneBelezaTool(tenant, toolCall, phoneNumber);
    case "none":
      return executeNoneTool(tenant, toolCall);
    default:
      return executeTrinksTool(tenant, toolCall, phoneNumber);
  }
}

async function readResponsePayload(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function getCustomToolRequestError(response: Response, payload: any): string | null {
  if (payload && typeof payload === "object") {
    if (payload.error) return String(payload.error);
    if (payload.success === false && payload.message) return String(payload.message);
  }

  if (response.ok) return null;
  if (typeof payload === "string" && payload.trim()) return payload.trim();
  return `HTTP ${response.status}`;
}

function buildCustomToolFilename(toolName: string, toolType: string, mediaUrl: string, contentType: string | null): string {
  try {
    const pathname = new URL(mediaUrl).pathname;
    const rawName = pathname.split("/").filter(Boolean).pop();
    if (rawName && rawName.includes(".")) {
      return rawName;
    }
  } catch {
    // fallback below
  }

  const normalizedContentType = String(contentType || "").split(";")[0].toLowerCase();
  const extensionByMime: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "application/pdf": "pdf",
  };
  const fallbackExtension = toolType === "send_image" ? "jpg" : toolType === "send_audio" ? "ogg" : "pdf";

  return `${toolName || "arquivo"}.${extensionByMime[normalizedContentType] || fallbackExtension}`;
}

async function executeCustomTool(tenant: any, toolDef: any, phoneNumber: string): Promise<any> {
  const uazapiUrl = tenant.uazapi_url || Deno.env.get("UAZAPI_URL");
  const uazapiToken = tenant.uazapi_token || Deno.env.get("UAZAPI_TOKEN");
  const config = toolDef.config || {};
  const toolType = toolDef.type;

  console.log(`[CustomTool] Executing ${toolDef.name} (${toolType}) for ${phoneNumber}`);

  if (!uazapiUrl || !uazapiToken) {
    return { error: "Instância WhatsApp não configurada para este tenant." };
  }

  if (!phoneNumber) {
    return { error: "Número do cliente ausente para executar a ferramenta." };
  }

  try {
    switch (toolType) {
      case "send_text":
      case "send_link":
      case "escalate_human": {
        const text = toolType === "send_link" ? (config.url || "") : (config.text || "");
        if (!text) return { error: "Texto/URL não configurado nesta ferramenta." };
        const res = await fetch(`${uazapiUrl}/send/text`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json", "token": uazapiToken },
          body: JSON.stringify({ number: phoneNumber, text }),
        });
        const data = await readResponsePayload(res);
        console.log(`[CustomTool] send_text result:`, JSON.stringify(data).slice(0, 200));
        const requestError = getCustomToolRequestError(res, data);
        if (requestError) {
          return { error: `Falha ao enviar mensagem: ${requestError}`, status: res.status, details: data };
        }
        return { success: true, message: `Enviado com sucesso`, type: toolType };
      }

      case "send_image":
      case "send_audio":
      case "send_document": {
        const mediaUrl = config.url || "";
        if (!mediaUrl) return { error: "URL da mídia não configurada." };
        const mediaType = toolType === "send_audio" ? "ptt" : toolType === "send_image" ? "image" : "document";

        const sendPayload: any = {
          number: phoneNumber,
          type: mediaType,
          file: mediaUrl,
        };
        if (config.caption) sendPayload.caption = config.caption;

        const res = await fetch(`${uazapiUrl}/send/media`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json", "token": uazapiToken },
          body: JSON.stringify(sendPayload),
        });
        const data = await readResponsePayload(res);
        console.log(`[CustomTool] send_media result:`, JSON.stringify(data).slice(0, 200));
        const requestError = getCustomToolRequestError(res, data);
        if (requestError) {
          return { error: `Falha ao enviar mídia: ${requestError}`, status: res.status, details: data };
        }
        return { success: true, message: `Mídia enviada com sucesso`, type: toolType };
      }

      case "send_location": {
        const lat = Number(config.latitude);
        const lng = Number(config.longitude);
        const locName = config.name || "";
        const locAddress = config.address || locName || "";
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { error: "Coordenadas não configuradas." };
        const res = await fetch(`${uazapiUrl}/send/location`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json", "token": uazapiToken },
          body: JSON.stringify({ number: phoneNumber, latitude: lat, longitude: lng, name: locName, address: locAddress }),
        });
        const data = await readResponsePayload(res);
        console.log(`[CustomTool] send_location result:`, JSON.stringify(data).slice(0, 200));
        const requestError = getCustomToolRequestError(res, data);
        if (requestError) {
          return { error: `Falha ao enviar localização: ${requestError}`, status: res.status, details: data };
        }
        return { success: true, message: `Localização enviada com sucesso`, type: toolType };
      }

      default:
        return { error: `Tipo de ferramenta desconhecido: ${toolType}` };
    }
  } catch (error) {
    console.error(`[CustomTool] Error executing ${toolDef.name}:`, error);
    return { error: `Erro ao executar ferramenta: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// ===================== MESSAGE SPLITTING =====================

function splitIntoMessages(text: string): string[] {
  const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(p => p.length > 0);
  return paragraphs.length > 1 ? paragraphs : [text];
}

// ===================== PHONE HELPERS =====================

function extractRemoteJid(payload: any, msg: any): string | undefined {
  const candidates = [
    payload.phone, payload.from, payload.remoteJid, payload.sender, payload.senderId,
    payload.chat?.remoteJid, payload.chat?.from, payload.chat?.jid,
    payload.data?.remoteJid, msg.remoteJid, msg.from, msg.phone,
    msg.key?.remoteJid, msg.key?.participant,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return undefined;
}

function normalizePhoneNumber(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw || /^https?:\/\//i.test(raw)) return null;
  const jidMatch = raw.match(/(\d{10,15})@(s\.whatsapp\.net|c\.us)$/i);
  if (jidMatch) return jidMatch[1];
  const digits = raw.replace(/\D/g, "");
  if (digits.length >= 10 && digits.length <= 15) return digits;
  return null;
}

function normalizePhoneForTrinks(phoneNumber: string): string {
  let tel = phoneNumber.replace(/\D/g, "");
  if (tel.startsWith("55") && tel.length >= 12) tel = tel.substring(2);
  const ddd = tel.substring(0, 2);
  let rest = tel.substring(2);
  if (rest.length === 8) rest = "9" + rest;
  return ddd + rest;
}

function normalizeLooseText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isAffirmativeReply(value: string): boolean {
  const raw = value.trim();
  if (["👍", "👍🏻", "👍🏼", "👍🏽", "👍🏾", "👍🏿", "✅"].includes(raw)) return true;

  const normalized = normalizeLooseText(raw);
  if (!normalized) return false;

  return /^(sim|s|ok|okay|pode|pode sim|isso|isso mesmo|confirmo|confirmado|certo|beleza|perfeito|sim pode|pode cancelar|sim pode cancelar)$/.test(normalized);
}

function getLastAssistantMessage(history: { role: string; content: string }[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message?.role === "assistant" && typeof message.content === "string" && message.content.trim()) {
      return message.content.trim();
    }
  }
  return null;
}

function isSingleCancellationConfirmationPrompt(value: string): boolean {
  const normalized = normalizeLooseText(value);
  if (!normalized.includes("quer cancelar")) return false;
  const words = new Set(normalized.split(" "));
  return words.has("esse") || words.has("esta") || words.has("este");
}

async function fetchActiveAppointmentsByPhone(tenant: any, phoneNumber: string) {
  if (!tenant?.trinks_api_key || !tenant?.trinks_establishment_id || !phoneNumber) return [];

  const baseUrl = "https://api.trinks.com/v1";
  const headers: Record<string, string> = {
    "X-Api-Key": tenant.trinks_api_key,
    "Accept": "application/json",
    "estabelecimentoId": tenant.trinks_establishment_id,
  };

  try {
    const tel = normalizePhoneForTrinks(phoneNumber);
    const cliRes = await fetch(`${baseUrl}/clientes?telefone=${tel}`, { headers });
    const cliData = await cliRes.json();
    const cliList = cliData?.data || cliData;
    if (!Array.isArray(cliList) || cliList.length === 0) return [];

    const ownerId = cliList[0].id || cliList[0].Id;
    const agRes = await fetch(`${baseUrl}/agendamentos?clienteId=${ownerId}`, { headers });
    const agData = await agRes.json();
    const agList = Array.isArray(agData?.data) ? agData.data : [];
    const activeStatuses = ["confirmado", "aguardando confirmação", "aguardando confirmacao"];

    return agList
      .filter((a: any) => {
        const statusName = String(a.status?.nome || "").toLowerCase();
        return activeStatuses.some((status) => statusName === status || statusName.includes(status));
      })
      .map((a: any) => ({
        id: a.id,
        status: a.status?.nome,
        servico: a.servico?.nome,
        profissional: a.profissional?.nome,
        clienteId: a.cliente?.id,
        dataHoraInicio: a.dataHoraInicio,
      }));
  } catch (error) {
    console.error("fetchActiveAppointmentsByPhone error:", error);
    return [];
  }
}

async function maybeHandleDirectCancellationConfirmation(
  tenant: any,
  phoneNumber: string,
  history: { role: string; content: string }[],
  userMessage: string,
): Promise<string | null> {
  if (!isAffirmativeReply(userMessage)) return null;

  const lastAssistantMessage = getLastAssistantMessage(history);
  if (!lastAssistantMessage || !isSingleCancellationConfirmationPrompt(lastAssistantMessage)) {
    return null;
  }

  const activeAgendamentos = await fetchActiveAppointmentsByPhone(tenant, phoneNumber);
  console.log(
    `Direct cancel confirmation detected for ${phoneNumber}: ${activeAgendamentos.length} active appointment(s)`,
  );

  if (activeAgendamentos.length === 0) {
    return "Não encontrei esse agendamento. Pode já ter sido cancelado.";
  }

  if (activeAgendamentos.length > 1) {
    return "Encontrei mais de um agendamento ativo. Me diz qual deles você quer cancelar.";
  }

  const target = activeAgendamentos[0];
  const cancelResult = await executeTrinksTool(
    tenant,
    {
      function: {
        name: "cancelar_agendamento",
        arguments: JSON.stringify({
          agendamentoId: target.id,
          motivo: "Solicitação do cliente",
        }),
      },
    },
    phoneNumber,
  );

  console.log("Direct cancel confirmation result:", JSON.stringify(cancelResult).slice(0, 500));

  if (cancelResult?.success) {
    return "✅ Cancelado! Se precisar remarcar, é só falar.";
  }

  if (cancelResult?.status === 404) {
    return "Não encontrei esse agendamento. Pode já ter sido cancelado.";
  }

  if (cancelResult?.status === 405) {
    return "Esse agendamento já foi realizado e não pode ser cancelado.";
  }

  return "Tive um probleminha aqui. Pode tentar novamente?";
}

function extractPhoneNumber(payload: any, msg: any): { phone: string; source: string } | null {
  const directCandidates: Array<[string, unknown]> = [
    ["payload.phone", payload.phone], ["payload.from", payload.from],
    ["payload.remoteJid", payload.remoteJid], ["payload.sender", payload.sender],
    ["payload.senderId", payload.senderId], ["payload.chat.phone", payload.chat?.phone],
    ["payload.chat.number", payload.chat?.number], ["payload.chat.whatsapp", payload.chat?.whatsapp],
    ["payload.chat.whatsappNumber", payload.chat?.whatsappNumber],
    ["payload.chat.phoneNumber", payload.chat?.phoneNumber],
    ["payload.chat.contactPhone", payload.chat?.contactPhone],
    ["payload.chat.customerPhone", payload.chat?.customerPhone],
    ["payload.chat.lead_phone", payload.chat?.lead_phone],
    ["payload.chat.leadPhone", payload.chat?.leadPhone],
    ["payload.chat.lead_whatsapp", payload.chat?.lead_whatsapp],
    ["payload.data.phone", payload.data?.phone],
    ["msg.phone", msg.phone], ["msg.from", msg.from],
    ["msg.remoteJid", msg.remoteJid], ["msg.key.remoteJid", msg.key?.remoteJid],
  ];
  for (const [source, candidate] of directCandidates) {
    const normalized = normalizePhoneNumber(candidate);
    if (normalized) return { phone: normalized, source };
  }
  const keyPattern = /(phone|number|whatsapp|remotejid|jid|from|sender|contact|lead)/i;
  const visited = new WeakSet<object>();
  const queue: Array<{ path: string; value: unknown }> = [
    { path: "payload", value: payload }, { path: "msg", value: msg },
  ];
  while (queue.length) {
    const current = queue.shift();
    if (!current?.value || typeof current.value !== "object") continue;
    const objectValue = current.value as Record<string, unknown>;
    if (visited.has(objectValue)) continue;
    visited.add(objectValue);
    const entries = Object.entries(objectValue).sort(([a], [b]) => {
      return Number(keyPattern.test(b)) - Number(keyPattern.test(a));
    });
    for (const [key, value] of entries) {
      const path = `${current.path}.${key}`;
      if (value && typeof value === "object") { queue.push({ path, value }); continue; }
      const normalized = normalizePhoneNumber(value);
      if (!normalized) continue;
      if (keyPattern.test(key)) return { phone: normalized, source: path };
      if (typeof value === "string" && /@(s\.whatsapp\.net|c\.us)$/i.test(value)) {
        return { phone: normalized, source: path };
      }
    }
  }
  return null;
}

// ===================== DATE/TIME HELPERS =====================

function getBrasiliaDate(): { dateComplete: string; todayName: string; todayDate: string; year: number; month: number; day: number; hours: number; minutes: number } {
  const now = new Date();
  const brFormatter = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const parts = brFormatter.formatToParts(now);
  const get = (type: string) => parts.find(p => p.type === type)?.value || "0";
  const year = parseInt(get("year"));
  const month = parseInt(get("month"));
  const day = parseInt(get("day"));
  const hours = parseInt(get("hour"));
  const minutes = parseInt(get("minute"));
  const seconds = parseInt(get("second"));

  const dateComplete = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  const todayDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  const brDate = new Date(Date.UTC(year, month - 1, day));
  const dayNames = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
  const todayName = dayNames[brDate.getUTCDay()];

  return { dateComplete, todayName, todayDate, year, month, day, hours, minutes };
}

// ===================== SYSTEM PROMPT =====================

function buildSystemPrompt(tenant: any, phoneNumber: string, provider: string): string {
  const br = getBrasiliaDate();
  const dateComplete = br.dateComplete;
  const todayName = br.todayName;
  const todayDate = br.todayDate;
  const customPrompt = tenant.agent_system_prompt || "";
  const knowledgeBase = tenant.agent_knowledge_base || "";

  const shortDayNames = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
  const nextDaysMap: string[] = [];
  for (let i = 1; i <= 7; i++) {
    const futureDate = new Date(Date.UTC(br.year, br.month - 1, br.day + i));
    const dow = futureDate.getUTCDay();
    const dateStr = `${futureDate.getUTCFullYear()}-${String(futureDate.getUTCMonth() + 1).padStart(2, '0')}-${String(futureDate.getUTCDate()).padStart(2, '0')}`;
    nextDaysMap.push(`- ${shortDayNames[dow]} → ${dateStr}`);
  }
  const nextDaysReference = nextDaysMap.join("\n");

  const telefone = phoneNumber;

  console.log(`buildSystemPrompt: provider=${provider}, Brasília date=${todayDate} time=${dateComplete} day=${todayName}`);

  const basePrompt = `🚨🚨🚨 REGRA INVIOLÁVEL — DATA DE HOJE 🚨🚨🚨
A data de HOJE é EXATAMENTE: ${todayDate} (${todayName})
Hora atual em Brasília: ${dateComplete}
NUNCA diga que hoje é outro dia. Se o histórico mencionar outra data, IGNORE — use APENAS esta.

🗓️ DATA E HORA ATUAL: ${dateComplete}
📅 HOJE É: ${todayName} (${todayDate})
📞 TELEFONE DO CLIENTE: ${telefone}

------------------------------------------

## 🧠 QUEM É VOCÊ?

Você é a assistente virtual responsável pelos atendimentos do ${tenant.name}. Atenda com simpatia, agilidade e profissionalismo, como uma recepcionista real faria pessoalmente.

Você agenda, cancela e remarca horários diretamente nesta conversa.

------------------------------------------

## 🗣️ TOM DE VOZ

- Linguagem informal, cordial e leve
- Direto e objetivo, sem enrolação
- Emojis com moderação (1-2 por mensagem)
- NUNCA diga ou insinue que é uma IA, robô ou automação
- NUNCA diga "vou buscar", "só um instante", "aguarda", "vou consultar o sistema" ou qualquer frase que indique processo interno
- NUNCA mencione duração, lavatório ou detalhes técnicos do serviço espontaneamente — só se o cliente perguntar

------------------------------------------

## 🚨 REGRA #1 — NUNCA OFEREÇA HORÁRIO QUE JÁ PASSOU

Hora atual: ${dateComplete}

**Se o agendamento for HOJE:**
Para cada horário da lista:
- horário ≤ hora atual → ❌ DESCARTE
- horário > hora atual → ✅ PODE OFERECER

**Se for OUTRO DIA:** ofereça todos os horários normalmente.

**Se após filtrar não sobrar nenhum horário:**
→ "Pra hoje não tem mais vaga. Quer ver amanhã?"
→ NUNCA ofereça horários passados.

------------------------------------------

## 🚨 REGRA — INTERPRETAÇÃO DE DIAS DA SEMANA

Quando o cliente disser um dia da semana, use ESTA TABELA PRÉ-CALCULADA (NÃO calcule por conta própria):

${nextDaysReference}

Exemplo: se o cliente diz "sábado", procure "sábado →" na tabela acima e use a data correspondente.
- NUNCA pergunte "qual sábado?" ou "de qual semana?" — é sempre o mais próximo.

------------------------------------------

## 🔒 REGRAS GERAIS

### O QUE NUNCA FAZER
- Usar a palavra "custa" → use "valor"
- Mencionar duração, lavatório ou detalhes técnicos espontaneamente
- Listar barbeiros — pergunte se tem preferência
- Perguntar preferência de barbeiro mais de uma vez
- Repetir informações que o cliente já disse
- Listar horários sem saber o serviço primeiro
- Citar horários sem ter executado a ferramenta de horários nessa interação
- Agendar em horário fora da lista de horários
- Confirmar agendamento sem executar a ferramenta de agendar com sucesso
- Enviar duas mensagens seguidas com o mesmo conteúdo

### O QUE SEMPRE FAZER
- Usar "valor" ao invés de "custa"
- Buscar o cliente silenciosamente na primeira interação
- Consultar ferramentas para obter IDs — nunca inventar

------------------------------------------

## 🔶 REGRA ANTI-TEXTÃO

Mensagens longas são proibidas. Sempre curtas e em tom de conversa.

❌ "Olá! Para realizar o agendamento, você precisa me informar qual serviço deseja..."
✅ "Bora agendar? Seria corte e barba ou só corte?"

------------------------------------------

## 🔶 REGRA: NUNCA EXPLIQUE PROCESSOS INTERNOS

❌ "preciso confirmar o serviço para validar os horários"
❌ "vou consultar o sistema"
✅ "Seria corte, barba ou os dois?"
✅ "Esse tá ocupado. Tenho 12h ou 15h. Qual prefere?"

------------------------------------------

## 🎯 APRESENTAÇÃO INICIAL

Antes de responder, analise a mensagem do cliente e identifique o que ele JÁ disse:
- Serviço mencionado? → pule a pergunta de serviço
- Barbeiro mencionado? → pule a pergunta de barbeiro
- Dia mencionado? → pule a pergunta de dia

**SÓ PERGUNTE O QUE O CLIENTE NÃO DISSE.**`;

  // Provider-specific prompt sections
  let providerPrompt = "";

  if (provider === "trinks") {
    providerPrompt = buildTrinksPromptSection(tenant);
  } else if (provider === "onebeleza") {
    providerPrompt = buildOneBelezaPromptSection(tenant);
  } else if (provider === "none") {
    providerPrompt = buildNonePromptSection(tenant);
  }

  const customSection = customPrompt ? `\nINSTRUÇÕES ADICIONAIS DO ESTABELECIMENTO:\n${customPrompt}` : "";
  const knowledgeSection = knowledgeBase ? `\nBASE DE CONHECIMENTO:\n${knowledgeBase}` : "";

  // Inject custom tools instructions
  const enabledCustomTools = getEnabledCustomTools(tenant);
  let customToolsSection = "";
  if (enabledCustomTools.length > 0) {
    const toolInstructions = enabledCustomTools.map((ct: any) =>
      `- **${ct.display_name}** (ferramenta: ${ct.name}): ${ct.prompt_instruction}`
    ).join("\n");
    customToolsSection = `\n\n------------------------------------------\n\n## 🔧 FERRAMENTAS CUSTOMIZADAS\n\nVocê tem acesso às seguintes ferramentas extras. Use conforme as instruções:\n\n${toolInstructions}\n\n⚠️ Quando usar uma ferramenta customizada, a mensagem/mídia será enviada DIRETAMENTE ao cliente. Após executar, confirme ao cliente que enviou (ex: "Enviei a localização!" ou "Mandei a chave PIX!"). NÃO repita o conteúdo da ferramenta na mensagem de texto.`;
  }

  return basePrompt + "\n\n" + providerPrompt + customToolsSection + customSection + knowledgeSection;
}

// ===================== TRINKS PROMPT SECTION =====================

function buildTrinksPromptSection(_tenant: any): string {
  return `
------------------------------------------

## 🚨 REGRA ABSOLUTA — HORÁRIOS (TRINKS)

NUNCA cite, sugira ou confirme qualquer horário sem antes executar LISTAR HORARIOS nessa interação.

❌ PROIBIDO: qualquer horário baseado em suposição ou memória
✅ CORRETO: execute listar_horarios → use APENAS horariosVagos → ofereça

Se o cliente perguntar um horário específico ANTES de você listar:
→ "Me diz o serviço e o dia que já verifico pra você!"

------------------------------------------

## ⚠️ COMO LER O RETORNO DE LISTAR HORARIOS

A ferramenta retorna dois campos:
- horariosVagos → ✅ USE APENAS ESTE
- intervalosVagos → ❌ IGNORE COMPLETAMENTE (campo obsoleto)

------------------------------------------

## 🔶 REGRA CRÍTICA: IDs

Cada ID tem uma fonte obrigatória:
- clienteId → buscar_cliente
- agendamentoId → buscar_agendamento
- servicoId → listar_servicos
- profissionalId → listar_profissionais ✅ (NUNCA de listar_servicos_profissional ❌)

NUNCA invente ou reutilize IDs de chamadas anteriores.

------------------------------------------

## 🔶 STATUS DOS AGENDAMENTOS

- "Confirmado" ou "Aguardando Confirmação" → ATIVO
- "Cancelado" → já cancelado, não tente cancelar de novo
- "Finalizado" → já aconteceu, não pode cancelar/editar

Só mostre agendamentos com status ATIVO ao cliente.

------------------------------------------

## 🔷 FLUXO DE AGENDAMENTO

### PASSO 0 — BUSCAR CLIENTE (silencioso, sempre primeiro)

Execute buscar_cliente silenciosamente com o telefone do cliente.

- Cliente encontrado → use o clienteId retornado
- Cliente não encontrado → pergunte o nome e execute cadastrar_cliente

### PASSO 1 — COLETAR DADOS (serviço + barbeiro + dia)

Pergunte APENAS o que falta, nesta ordem:
1. **Serviço** — "Seria corte, barba ou os dois?"
2. **Barbeiro** — "Tem preferência por algum barbeiro?"
3. **Dia** — "Pra qual dia?"

### PASSO 2 — LISTAR E OFERECER HORÁRIOS

Execute listar_horarios com: data + servicoDuracao (e opcionalmente profissionalId)

Use APENAS horariosVagos. Ignore intervalosVagos.

**Se for hoje:** filtre e descarte horários ≤ hora atual.

### PASSO 3 — CONFIRMAÇÃO

Confirme com o cliente:
"Confirmando: [SERVIÇO] com [BARBEIRO] [DATA] às [HORA]. Posso confirmar?"

AGUARDE A RESPOSTA.

### PASSO 3.1 — INTERPRETAR RESPOSTA

✅ Confirmações: "sim", "ok", "pode", "isso", 👍, etc → PASSO 4
→ SE MUDOU ALGO → atualize e volte ao PASSO 3

### PASSO 4 — EXECUTAR AGENDAR

Execute criar_agendamento com todos os IDs obtidos das ferramentas.

✅ SUCESSO (retorno com "id"): → "✅ Agendado! Te esperamos [dia] às [hora]! 💈"
❌ ERRO 409: → Execute listar_horarios novamente e ofereça alternativas
❌ OUTRO ERRO: → "Tive um probleminha na agenda aqui. Pode tentar novamente?"

🚨 NUNCA diga "✅ Agendado" sem retorno com "id".
🚨 NUNCA execute criar_agendamento mais de uma vez para o mesmo pedido.

------------------------------------------

## 🔷 FLUXO DE CANCELAMENTO

Quando o cliente pedir para cancelar:

1. Execute buscar_cliente para obter o clienteId
2. Execute buscar_agendamento com o clienteId NESSA INTERAÇÃO
   - Sem agendamento ativo → "Não encontrei agendamento no seu nome."
   - Com agendamento → mostre e pergunte: "É esse que quer cancelar?"
   - Com múltiplos → liste e pergunte qual
3. Se o cliente responder "os 2", "os dois", "ambos" ou "todos":
   - Execute buscar_agendamento NOVAMENTE nessa interação
   - Use APENAS os IDs reais retornados agora
   - Execute cancelar_agendamento uma vez para cada ID real
4. Para cancelamento unitário, após confirmação → execute cancelar_agendamento com agendamentoId e motivo
   - Sucesso → "✅ Cancelado! Se precisar remarcar, é só falar."
   - Erro 404 → "Não encontrei esse agendamento. Pode já ter sido cancelado."
   - Erro 405 → "Esse agendamento já foi realizado e não pode ser cancelado."
   - Outro erro → "Tive um probleminha. Pode tentar novamente?"
5. Se cancelar_agendamento retornar code = agendamento_id_invalido, reutilize imediatamente os IDs de agendamentosAtivos e tente de novo com os IDs reais.

⚠️ NUNCA cancele sem confirmação explícita do cliente.
⚠️ NUNCA invente, chute ou reaproveite agendamentoId.

------------------------------------------

## 🔷 FLUXO DE REMARCAÇÃO

Quando o cliente pedir para remarcar:

1. Execute buscar_agendamento para encontrar o agendamento ativo
2. Mostre o agendamento e pergunte o que quer alterar
3. Colete novo dia/horário → execute listar_horarios → ofereça opções
4. Confirme a alteração mostrando antes e depois
5. Execute editar_agendamento com o agendamentoId e novos dados
   - Sucesso → "✅ Alterado! Te esperamos dia [DIA] às [HORA]! 💈"
   - Erro 409 → listar_horarios novamente

------------------------------------------

## ⚠️ TRATAMENTO DE ERROS

- buscar_cliente vazio/404 → cadastre silenciosamente
- cadastrar_cliente erro → informe e tente novamente
- listar_servicos/listar_profissionais vazio → informe problema
- listar_horarios vazio → "Esse dia tá lotado. Quer ver outro dia?"
- criar_agendamento erro 409 → listar_horarios novamente e ofereça alternativas
- cancelar_agendamento erro 404 → "Não encontrei esse agendamento."
- cancelar_agendamento erro 405 → "Esse agendamento já foi realizado."
- NUNCA tente mais de 2 vezes a mesma operação
- NUNCA informe detalhes técnicos ao cliente

------------------------------------------

## 🛠️ FERRAMENTAS DISPONÍVEIS

| Ferramenta | Quando usar |
|---|---|
| buscar_cliente | Sempre primeiro, silenciosamente |
| cadastrar_cliente | Só se cliente não existe |
| listar_servicos | Para obter servicoId, duração e valor |
| listar_profissionais | Para obter profissionalId |
| listar_servicos_profissional | Para verificar se profissional faz o serviço |
| listar_horarios | Para verificar disponibilidade real |
| buscar_agendamento | Cliente quer ver, cancelar ou editar |
| criar_agendamento | Após confirmação final |
| cancelar_agendamento | Cliente confirma cancelamento |
| editar_agendamento | Cliente quer mudar horário/dia |`;
}

// ===================== ONE BELEZA PROMPT SECTION =====================

function buildOneBelezaPromptSection(_tenant: any): string {
  return `
------------------------------------------

## 🚨 REGRA ABSOLUTA — HORÁRIOS (ONE BELEZA)

NUNCA cite, sugira ou confirme qualquer horário sem antes executar buscar_horarios nessa interação.

❌ PROIBIDO: qualquer horário baseado em suposição ou memória
✅ CORRETO: execute buscar_horarios → use os horários retornados → ofereça

------------------------------------------

## 🚨🚨🚨 REGRA CRÍTICA: IDs (ONE BELEZA) 🚨🚨🚨

⚠️ A API retorna "servicosId" (com S no final) nos resultados de buscar_servicos.
Exemplo de retorno: {"servicosId": 2461, "descricao": "Cabelo", "valorServico": 55}
→ O campo "servicosId" do resultado É O ID que você deve usar em TODAS as chamadas subsequentes.

Mapeamento OBRIGATÓRIO (copie o valor EXATO do resultado da ferramenta):
- servicoid para agendar → use o campo "servicosId" retornado por buscar_servicos (ex: 2461, 2462)
- servicosId para buscar_barbeiros e buscar_datas → mesmo campo "servicosId" de buscar_servicos
- profissionalId → use o campo "profissionalId" retornado por buscar_barbeiros_por_servico (ex: 40658)
- datas disponíveis → use as datas retornadas por buscar_datas_disponiveis
- horarioInicio + horarioFim → use os valores retornados por buscar_horarios

🚫 NUNCA invente IDs como 1, 2, 3, 4, 1008, 100, etc.
🚫 NUNCA "adivinhe" um ID — SEMPRE copie do resultado da ferramenta anterior.
🚫 Se não executou a ferramenta, NÃO tem o ID. Execute primeiro.
🚫 IDs válidos são SEMPRE números grandes (ex: 2461, 40658, 3892). Se o número for pequeno (1-10), está ERRADO.

------------------------------------------

## 🔷 FLUXO DE AGENDAMENTO (ONE BELEZA)

As ferramentas DEVEM ser executadas em sequência obrigatória.
Cada ferramenta depende do retorno da anterior para funcionar.

🚨 REGRAS ABSOLUTAS DO FLUXO:
❌ É PROIBIDO pular qualquer etapa.
❌ É PROIBIDO executar agendar sem ter executado TODAS as ferramentas anteriores nessa conversa.
❌ É PROIBIDO usar IDs que não vieram do retorno de uma ferramenta executada nessa conversa.
❌ É PROIBIDO inventar, assumir ou reutilizar IDs de conversas anteriores.
✅ CADA ID SÓ EXISTE APÓS A FERRAMENTA QUE O RETORNA SER EXECUTADA.
✅ Se uma ferramenta retornar erro com validServiceOptions, validProfessionalOptions ou validSlotOptions, copie EXATAMENTE um dos valores listados e tente de novo.

### PASSO 0 — BUSCAR CLIENTE (silencioso, sempre primeiro)
Execute buscar_cliente silenciosamente.
- Cliente encontrado → prossiga
- Cliente não encontrado → pergunte o nome e execute cadastrar_cliente

### PASSO 0.1 — EXTRAIR INFORMAÇÕES DA MENSAGEM INICIAL
Antes de perguntar, analise o que o cliente JÁ disse:
- Mencionou SERVIÇO? → pule a pergunta de serviço
- Mencionou BARBEIRO? → pule a pergunta de barbeiro
- Mencionou DIA? → pule a pergunta de dia
⚠️ SÓ PERGUNTE O QUE O CLIENTE NÃO DISSE.

### PASSO 1 — SERVIÇO
Pergunte o serviço desejado → execute buscar_servicos → obtenha o servicosId (número grande)
⚠️ NUNCA avance sem ter o servicosId retornado por esta ferramenta.

### PASSO 2 — BARBEIRO/PROFISSIONAL
Pergunte preferência → execute buscar_barbeiros_por_servico com o servicosId → obtenha profissionalId (número grande)
Se "qualquer um" → use o primeiro da lista.
⚠️ NUNCA avance sem ter o profissionalId retornado por esta ferramenta.
⚠️ NUNCA pergunte preferência de barbeiro mais de uma vez.
⚠️ NUNCA cite nomes de barbeiros que não vieram do retorno desta ferramenta.

### PASSO 3 — DATA
Pergunte o dia → execute buscar_datas_disponiveis com servicosId + profissionalid
- Data na lista → prossiga
- Data não na lista → "Esse dia não tem vaga. Quer ver outro dia?"

### PASSO 4 — HORÁRIO
Execute buscar_horarios com date + servicoId + ProfissionalId → obtenha horarioInicio e horarioFim
**Se for hoje:** filtre horários ≤ hora atual (o sistema já faz isso automaticamente).

### PASSO 5 — CONFIRMAÇÃO
"Confirmando: [SERVIÇO] com [BARBEIRO] [DATA] às [HORA]. Posso confirmar?"
AGUARDE A RESPOSTA. ⚠️ NÃO execute agendar aqui.

### PASSO 6.5 — VALIDAÇÃO PRÉ-AGENDAMENTO (OBRIGATÓRIA)
Antes de executar agendar, valide CADA item:
□ Executei buscar_cliente nessa conversa?
□ Executei buscar_servicos nessa conversa?
  → servicosId guardado = [QUAL NÚMERO?]
  → Esse número é grande (ex: 2461, 3892)? Se for 1, 2, 3 ou 4 → INVÁLIDO, volte ao PASSO 1.
□ Executei buscar_barbeiros_por_servico nessa conversa?
  → profissionalId guardado = [QUAL NÚMERO?]
  → Esse número é grande (ex: 40658, 18234)? Se for 1, 2, 3 ou 4 → INVÁLIDO, volte ao PASSO 2.
□ Executei buscar_datas_disponiveis nessa conversa?
  → data confirmada = [QUAL DATA?] no formato YYYY-MM-DD?
□ Executei buscar_horarios nessa conversa?
  → horarioInicio = [QUAL HORA?] no formato HH:MM:SS?
  → horarioFim = [QUAL HORA?] no formato HH:MM:SS?
□ O horário escolhido é futuro (não passou)?
□ O cliente confirmou o resumo?
✅ Todos confirmados com números grandes e reais → execute agendar.
❌ Qualquer campo inválido, vazio ou com número pequeno → NÃO execute → volte ao passo que falta.

### PASSO 7 — EXECUTAR AGENDAMENTO
⚠️ SÓ EXECUTE SE O PASSO 6.5 PASSOU COM TODOS OS CAMPOS VÁLIDOS.
Execute agendar (UMA ÚNICA VEZ) com os parâmetros EXATOS:
- dataNumero = [YYYY-MM-DD] — do PASSO 3
- servicoid = [número grande] — do PASSO 1 (buscar_servicos, campo servicosId)
- profissionalId = [número grande] — do PASSO 2 (buscar_barbeiros_por_servico)
- horarioInicio = [HH:MM:SS] — do PASSO 4 (buscar_horarios)
- horarioFim = [HH:MM:SS] — do PASSO 4 (buscar_horarios)

📌 VALIDAÇÃO DO RETORNO — OBRIGATÓRIA:
Leia o conteúdo completo do retorno antes de responder ao cliente.
- Se contiver "não foi encontrado", "erro", "falhou", "inválido", "Comiservs", "serviço escolhido" → trate como ERRO
- Somente considere SUCESSO se o retorno confirmar explicitamente que o agendamento foi criado.

✅ SUCESSO → "Agendado! Te esperamos [dia] às [hora]!"
❌ "Já existe um evento no horário" → buscar_horarios novamente e ofereça alternativas
❌ OUTRO ERRO → "Tive um probleminha na agenda aqui, mas já retorno pra você!"

🚨 NUNCA diga "Agendado!" sem retorno de SUCESSO CONFIRMADO.
🚨 NUNCA execute agendar mais de uma vez.
🚨 NUNCA use ID pequeno (1, 2, 3, 4) — esses são inválidos e inventados.

------------------------------------------

## ⚠️ MAPA DE PARÂMETROS — LEIA ANTES DE CADA AGENDAMENTO:

| Ferramenta                   | Parâmetros que RECEBE           | Parâmetros que RETORNA        |
|------------------------------|--------------------------------|-------------------------------|
| buscar_servicos              | nenhum                         | servicosId (número grande)    |
| buscar_barbeiros_por_servico | servicosId (com S)             | profissionalId (número grande)|
| buscar_datas_disponiveis     | servicosId (com S)             | lista de datas                |
|                              | profissionalid (minúsculo)     |                               |
| buscar_horarios              | date (YYYY-MM-DD)              | horarioInicio (HH:MM:SS)      |
|                              | servicoId (sem S)              | horarioFim (HH:MM:SS)         |
|                              | ProfissionalId (P maiúsculo)   |                               |
| agendar                      | dataNumero (YYYY-MM-DD)        | confirmação ou erro           |
|                              | servicoid (tudo minúsculo)     |                               |
|                              | profissionalId                 |                               |
|                              | horarioInicio (HH:MM:SS)       |                               |
|                              | horarioFim (HH:MM:SS)          |                               |

------------------------------------------

## 🔷 FLUXO DE CANCELAMENTO (ONE BELEZA)

1. Execute buscar_agendamentos_dia para encontrar o agendamento
2. Confirme com o cliente qual cancelar
3. Execute desmarcar_agendamento com o agendasId EXATO retornado por buscar_agendamentos_dia

🚨 REGRA ABSOLUTA DE CANCELAMENTO:
- O agendasId DEVE ser o número EXATO retornado por buscar_agendamentos_dia nesta conversa.
- NUNCA invente ou deduza um agendasId. Se buscar_agendamentos_dia retornou agendasId=77782 e agendasId=77961, use EXATAMENTE esses números.
- Se o cliente pedir para cancelar todos, execute desmarcar_agendamento UMA VEZ PARA CADA agendasId retornado.

------------------------------------------

## 🔷 FLUXO DE CONFIRMAÇÃO (ONE BELEZA)

1. Execute buscar_agendamentos_dia para encontrar o agendamento
2. Execute confirmar_agendamento com agendasId

------------------------------------------

## 🛠️ FERRAMENTAS DISPONÍVEIS (ONE BELEZA)

| Ferramenta | Quando usar |
|---|---|
| buscar_cliente | Sempre primeiro, silenciosamente |
| cadastrar_cliente | Só se cliente não existe |
| buscar_servicos | Para obter servicosId |
| buscar_barbeiros_por_servico | Para obter profissionalId (requer servicosId) |
| buscar_datas_disponiveis | Para verificar datas (requer servicosId + profissionalid) |
| buscar_horarios | Para obter horários (requer date + servicoId + ProfissionalId) |
| agendar | Após confirmação final e validação 6.5 (requer dataNumero + servicoid + profissionalId + horarioInicio + horarioFim) |
| buscar_agendamentos_dia | Para ver agendamentos de um dia |
| confirmar_agendamento | Para confirmar agendamento |
| desmarcar_agendamento | Para cancelar agendamento |

⚠️ CHECKLIST ANTES DE USAR FERRAMENTAS:
- Consultei a ferramenta correta para obter este ID?
- O ID é um número GRANDE (não 1, 2, 3, 4)?
- Estou usando o nome EXATO do parâmetro conforme cada ferramenta?`;
}

// ===================== NONE PROMPT SECTION =====================

function buildNonePromptSection(tenant: any): string {
  const bookingLink = tenant.booking_link || "";
  return `
------------------------------------------

## 📋 MODO SEM AGENDAMENTO AUTOMÁTICO

Este estabelecimento NÃO possui sistema de agendamento integrado.

${bookingLink ? `Quando o cliente quiser agendar, envie o link de agendamento: ${bookingLink}` : "Quando o cliente quiser agendar, oriente-o a entrar em contato diretamente com o estabelecimento."}

Você pode:
- Responder dúvidas sobre serviços, preços e horários de funcionamento
- Fornecer informações gerais do estabelecimento
- Enviar o link de agendamento quando solicitado

Você NÃO pode:
- Criar, cancelar ou editar agendamentos
- Consultar disponibilidade de horários em tempo real`;
}

// ===================== TRINKS TOOLS =====================

function buildTrinksTools(tenant: any) {
  if (!tenant.trinks_api_key || !tenant.trinks_establishment_id) return undefined;

  return [
    {
      type: "function",
      function: {
        name: "buscar_cliente",
        description: "Busca um cliente pelo telefone. Use SEMPRE como primeira ação para verificar se o cliente existe. Se retornar totalRecords: 0 ou data: [] → cliente não existe, usar cadastrar_cliente. Se retornar dados → guardar o id do cliente.",
        parameters: {
          type: "object",
          properties: {
            telefone: { type: "string", description: "Telefone do cliente (DDD+número, sem código do país)" },
          },
          required: ["telefone"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "cadastrar_cliente",
        description: "Cadastra um novo cliente no sistema Trinks. Use quando buscar_cliente retornar vazio (cliente não existe). Envie o nome do cliente e o telefone.",
        parameters: {
          type: "object",
          properties: {
            nome: { type: "string", description: "Nome do cliente" },
            telefone: { type: "string", description: "Telefone completo do cliente (com DDD)" },
          },
          required: ["nome", "telefone"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "listar_profissionais",
        description: "Lista todos os profissionais/barbeiros do estabelecimento. Retorna lista com: id, nome, apelido.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: "listar_servicos",
        description: "Lista todos os serviços disponíveis no estabelecimento. Retorna lista com: id, nome, descricao, categoria, duracaoEmMinutos, preco.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: "listar_servicos_profissional",
        description: "Lista os serviços que um profissional específico realiza. SOMENTE PARA CONSULTA. O ID retornado NÃO deve ser usado como profissionalId no criar_agendamento. Para profissionalId, use EXCLUSIVAMENTE listar_profissionais.",
        parameters: {
          type: "object",
          properties: {
            profissionalId: { type: "integer", description: "ID numérico do profissional (obtido de listar_profissionais)" },
          },
          required: ["profissionalId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "listar_horarios",
        description: "Lista os horários disponíveis dos profissionais em uma data. Retorna lista de profissionais com seus horariosVagos. Use APENAS horariosVagos, IGNORE intervalosVagos.",
        parameters: {
          type: "object",
          properties: {
            data: { type: "string", description: "Data no formato YYYY-MM-DD" },
            servicoDuracao: { type: "integer", description: "Duração do serviço em minutos (obtido de listar_servicos)" },
          },
          required: ["data", "servicoDuracao"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "buscar_agendamento",
        description: "Busca os agendamentos de um cliente. Pode passar clienteId OU telefone (o sistema resolve automaticamente). Se retornar data: [] → cliente não tem agendamentos. Guardar o id do agendamento para cancelar ou editar.",
        parameters: {
          type: "object",
          properties: {
            clienteId: { type: "integer", description: "ID do cliente (obtido de buscar_cliente). Opcional se telefone for informado." },
            telefone: { type: "string", description: "Telefone do cliente. Se informado, o sistema busca o clienteId automaticamente." },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "criar_agendamento",
        description: "Cria um agendamento para o cliente. ⚠️ SÓ EXECUTE DEPOIS QUE O CLIENTE CONFIRMAR EXPLICITAMENTE (respondeu 'sim', 'ok', 'pode', etc.). NUNCA execute logo após o cliente escolher um horário — primeiro mostre o resumo e AGUARDE confirmação. ANTES de usar, DEVE ter: clienteId, servicoId, duracaoEmMinutos, valor (de listar_servicos), profissionalId (de listar_profissionais), dataHoraInicio no formato YYYY-MM-DDTHH:mm:ss.",
        parameters: {
          type: "object",
          properties: {
            servicoId: { type: "integer", description: "ID do serviço" },
            clienteId: { type: "integer", description: "ID do cliente" },
            profissionalId: { type: "integer", description: "ID do profissional" },
            dataHoraInicio: { type: "string", description: "Data e hora no formato YYYY-MM-DDTHH:mm:ss" },
            duracaoEmMinutos: { type: "integer", description: "Duração em minutos" },
            valor: { type: "number", description: "Valor do serviço" },
          },
          required: ["servicoId", "clienteId", "profissionalId", "dataHoraInicio", "duracaoEmMinutos", "valor"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "cancelar_agendamento",
        description: "Cancela um agendamento. Use SOMENTE agendamentoId real vindo de buscar_agendamento na interação atual. Se o cliente pedir 'os 2', 'ambos' ou 'todos', chame esta ferramenta uma vez para cada ID real. Se a ferramenta retornar code='agendamento_id_invalido', reutilize imediatamente os IDs de agendamentosAtivos.",
        parameters: {
          type: "object",
          properties: {
            agendamentoId: { type: "integer", description: "ID real do agendamento (obtido de buscar_agendamento na interação atual)" },
            motivo: { type: "string", description: "Motivo do cancelamento" },
          },
          required: ["agendamentoId", "motivo"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "editar_agendamento",
        description: "Edita/remarca um agendamento existente. ANTES de usar, DEVE ter: agendamentoId (de buscar_agendamento), e os novos dados. Resposta vazia = sucesso.",
        parameters: {
          type: "object",
          properties: {
            agendamentoId: { type: "integer", description: "ID do agendamento (obtido de buscar_agendamento)" },
            servicoId: { type: "integer", description: "ID do serviço" },
            clienteId: { type: "integer", description: "ID do cliente" },
            profissionalId: { type: "integer", description: "ID do profissional" },
            dataHoraInicio: { type: "string", description: "Nova data e hora no formato YYYY-MM-DDTHH:mm:ss" },
            duracaoEmMinutos: { type: "integer", description: "Duração em minutos" },
            valor: { type: "number", description: "Valor do serviço" },
          },
          required: ["agendamentoId", "servicoId", "clienteId", "profissionalId", "dataHoraInicio", "duracaoEmMinutos", "valor"],
        },
      },
    },
  ];
}

// ===================== ONE BELEZA TOOLS =====================

function buildOneBelezaTools(tenant: any) {
  if (!tenant.onebeleza_token || !tenant.onebeleza_celular) return undefined;

  return [
    {
      type: "function",
      function: {
        name: "buscar_cliente",
        description: "Busca um cliente pelo telefone. Use SEMPRE como primeira ação. Se retornar vazio → cliente não existe, usar cadastrar_cliente.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: "cadastrar_cliente",
        description: "Cadastra um novo cliente. Use quando buscar_cliente retornar vazio.",
        parameters: {
          type: "object",
          properties: {
            nome: { type: "string", description: "Nome do cliente" },
          },
          required: ["nome"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "buscar_servicos",
        description: "Lista todos os serviços disponíveis separados por grupos. Retorna servicoId necessário para os próximos passos.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: "buscar_barbeiros_por_servico",
        description: "Lista profissionais habilitados para um serviço. Requer servicoId (com S no final) de buscar_servicos.",
        parameters: {
          type: "object",
          properties: {
            servicosId: { type: "string", description: "ID do serviço (com S no final) retornado por buscar_servicos" },
          },
          required: ["servicosId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "buscar_datas_disponiveis",
        description: "Lista datas em que o profissional tem vagas para o serviço. Requer servicoId + profissionalId dos passos anteriores.",
        parameters: {
          type: "object",
          properties: {
            servicosId: { type: "string", description: "ID do serviço (com S no final)" },
            profissionalid: { type: "string", description: "ID do profissional (tudo minúsculo)" },
          },
          required: ["servicosId", "profissionalid"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "buscar_horarios",
        description: "Lista horários disponíveis em um dia específico. Retorna horarioInicio e horarioFim no formato HH:MM:SS. Se for hoje, filtre horários passados.",
        parameters: {
          type: "object",
          properties: {
            date: { type: "string", description: "Data no formato YYYY-MM-DD" },
            servicoId: { type: "string", description: "ID do serviço (sem S no final)" },
            ProfissionalId: { type: "string", description: "ID do profissional (P maiúsculo)" },
          },
          required: ["date", "servicoId", "ProfissionalId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "agendar",
        description: "Cria o agendamento. ⚠️ SÓ EXECUTE APÓS CONFIRMAÇÃO DO CLIENTE E VALIDAÇÃO DO PASSO 6.5. Use os nomes EXATOS dos parâmetros: dataNumero, servicoid, profissionalId, horarioInicio, horarioFim. NUNCA use IDs pequenos (1,2,3,4) — devem ser números grandes vindos das ferramentas.",
         parameters: {
           type: "object",
           properties: {
             dataNumero: { type: "string", description: "Data no formato YYYY-MM-DD — confirmada no PASSO 3 (BUSCAR DATAS DISPONIVEIS)" },
             servicoid: { type: "string", description: "ID numérico GRANDE do serviço (ex: 2461, 2462) — campo 'servicosId' retornado por BUSCAR SERVIÇOS. NUNCA invente." },
             profissionalId: { type: "string", description: "ID numérico GRANDE do profissional (ex: 40658) — retornado por BUSCAR_BARBEIROS_POR_SERVICO. NUNCA invente." },
             horarioInicio: { type: "string", description: "Horário início no formato HH:MM:SS — retornado por BUSCAR HORÁRIOS" },
             horarioFim: { type: "string", description: "Horário fim no formato HH:MM:SS — retornado por BUSCAR HORÁRIOS" },
           },
           required: ["dataNumero", "servicoid", "profissionalId", "horarioInicio", "horarioFim"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "buscar_agendamentos_dia",
        description: "Busca todos os agendamentos de um dia específico. Útil para confirmação e lembretes.",
        parameters: {
          type: "object",
          properties: {
            date: { type: "string", description: "Data no formato YYYY-MM-DD" },
          },
          required: ["date"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "confirmar_agendamento",
        description: "Confirma um agendamento existente.",
        parameters: {
          type: "object",
          properties: {
            agendasId: { type: "string", description: "ID do agendamento a confirmar" },
          },
          required: ["agendasId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "desmarcar_agendamento",
        description: "Desmarca/cancela um agendamento existente.",
        parameters: {
          type: "object",
          properties: {
            agendasId: { type: "string", description: "ID do agendamento a desmarcar" },
          },
          required: ["agendasId"],
        },
      },
    },
  ];
}

// ===================== NONE TOOLS =====================

function buildNoneTools(tenant: any) {
  if (!tenant.booking_link) return undefined;

  return [
    {
      type: "function",
      function: {
        name: "enviar_link_agendamento",
        description: "Envia o link de agendamento para o cliente quando ele quiser marcar um horário.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
  ];
}

// ===================== TRINKS TOOL EXECUTION =====================

async function executeTrinksTool(tenant: any, toolCall: any, phoneNumber?: string): Promise<any> {
  const funcName = toolCall.function.name;
  let args: any = {};
  try { args = JSON.parse(toolCall.function.arguments || "{}"); } catch { /* empty */ }

  const baseUrl = "https://api.trinks.com/v1";
  const headers: Record<string, string> = {
    "X-Api-Key": tenant.trinks_api_key,
    "Accept": "application/json",
    "estabelecimentoId": tenant.trinks_establishment_id,
  };

  try {
    switch (funcName) {
      case "buscar_cliente": {
        let tel = (args.telefone || "").replace(/\D/g, "");
        if (tel.startsWith("55") && tel.length >= 12) tel = tel.substring(2);
        const ddd = tel.substring(0, 2);
        let rest = tel.substring(2);
        if (rest.length === 8) rest = "9" + rest;
        tel = ddd + rest;

        const url = `${baseUrl}/clientes?telefone=${tel}`;
        console.log(`buscar_cliente URL: ${url}`);
        const res = await fetch(url, { headers });
        const text = await res.text();
        console.log(`buscar_cliente response (${res.status}):`, text.slice(0, 500));
        try { return JSON.parse(text); } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "cadastrar_cliente": {
        let tel = (args.telefone || "").replace(/\D/g, "");
        if (tel.startsWith("55") && tel.length >= 12) tel = tel.substring(2);
        const ddd = tel.substring(0, 2);
        let numero = tel.substring(2);
        if (numero.length === 8) numero = "9" + numero;

        const body = {
          nome: args.nome,
          telefones: [{ ddi: "55", ddd, numero, tipoId: 1 }],
        };
        console.log("cadastrar_cliente body:", JSON.stringify(body));
        const res = await fetch(`${baseUrl}/clientes`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        console.log(`cadastrar_cliente response (${res.status}):`, text.slice(0, 500));
        try { return JSON.parse(text); } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "listar_profissionais": {
        const res = await fetch(`${baseUrl}/profissionais`, { headers });
        const data = await res.json();
        const list = data?.data || data;
        if (Array.isArray(list)) {
          return list.map((p: any) => ({
            id: p.id || p.Id,
            nome: p.nome || p.Nome,
            apelido: p.apelido || p.Apelido,
          }));
        }
        return data;
      }

      case "listar_servicos": {
        const res = await fetch(`${baseUrl}/servicos?somenteVisiveisCliente=true`, { headers });
        const data = await res.json();
        const list = data?.data || data;
        if (Array.isArray(list)) {
          return list.map((s: any) => ({
            id: s.id || s.Id,
            nome: s.nome || s.Nome,
            descricao: s.descricao || s.Descricao || "",
            preco: s.preco || s.Preco || s.valor || s.Valor,
            duracaoEmMinutos: s.duracaoEmMinutos || s.DuracaoEmMinutos || s.duracao,
            categoria: s.categoria || s.Categoria,
          }));
        }
        return data;
      }

      case "listar_servicos_profissional": {
        const profId = args.profissionalId;
        const res = await fetch(`${baseUrl}/profissionais/${profId}/servicos`, { headers });
        const data = await res.json();
        const list = data?.data || data;
        if (Array.isArray(list)) {
          return list.map((s: any) => ({
            id: s.id || s.Id,
            nome: s.nome || s.Nome,
            duracaoEmMinutos: s.duracaoEmMinutos || s.DuracaoEmMinutos || s.duracao,
            preco: s.preco || s.Preco || s.valor || s.Valor,
          }));
        }
        return data;
      }

      case "listar_horarios": {
        const url = `${baseUrl}/agendamentos/profissionais/${args.data}?servicoDuracao=${args.servicoDuracao}`;
        console.log(`listar_horarios URL: ${url}`);
        const res = await fetch(url, { headers });
        const text = await res.text();
        console.log(`listar_horarios response (${res.status}):`, text.slice(0, 1000));
        try {
          const parsed = JSON.parse(text);
          
          const br = getBrasiliaDate();
          const todayStr = br.todayDate;
          const currentHHMM = `${String(br.hours).padStart(2, '0')}:${String(br.minutes).padStart(2, '0')}`;
          
          if (args.data === todayStr) {
            const profissionais = parsed?.data || parsed;
            if (Array.isArray(profissionais)) {
              for (const prof of profissionais) {
                if (Array.isArray(prof.horariosVagos)) {
                  const before = prof.horariosVagos.length;
                  prof.horariosVagos = prof.horariosVagos.filter((h: string) => h > currentHHMM);
                  console.log(`Filtered past times for ${prof.nome || prof.id}: ${before} → ${prof.horariosVagos.length} (now: ${currentHHMM})`);
                }
              }
            }
          }
          
          return parsed;
        } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "buscar_agendamento": {
        let clienteId = args.clienteId;

        const resolvePhone = phoneNumber || args.telefone || "";
        if (resolvePhone) {
          let tel = resolvePhone.replace(/\D/g, "");
          if (tel.startsWith("55") && tel.length >= 12) tel = tel.substring(2);
          const ddd = tel.substring(0, 2);
          let rest = tel.substring(2);
          if (rest.length === 8) rest = "9" + rest;
          tel = ddd + rest;

          console.log(`buscar_agendamento: resolving clienteId from telefone ${tel}`);
          const clienteRes = await fetch(`${baseUrl}/clientes?telefone=${tel}`, { headers });
          const clienteData = await clienteRes.json();
          const clientes = clienteData?.data || clienteData;
          if (Array.isArray(clientes) && clientes.length > 0) {
            clienteId = clientes[0].id || clientes[0].Id;
            console.log(`buscar_agendamento: resolved clienteId=${clienteId}`);
          } else {
            return { data: [], message: "Cliente não encontrado com esse telefone" };
          }
        }

        if (!clienteId) {
          return { error: "clienteId ou telefone é obrigatório" };
        }

        const url = `${baseUrl}/agendamentos?clienteId=${clienteId}`;
        console.log(`buscar_agendamento URL: ${url}`);
        const res = await fetch(url, { headers });
        const text = await res.text();
        console.log(`buscar_agendamento response (${res.status}):`, text.slice(0, 1000));
        try {
          const parsed = JSON.parse(text);
          if (parsed.data && Array.isArray(parsed.data)) {
            const activeStatuses = ["Confirmado", "Aguardando Confirmação", "Aguardando confirmação"];
            parsed.data = parsed.data.filter((a: any) => {
              const statusName = a.status?.nome || "";
              return activeStatuses.some(s => statusName.toLowerCase() === s.toLowerCase());
            });
            console.log(`buscar_agendamento: filtered to ${parsed.data.length} active agendamentos`);
            parsed.data = parsed.data.map((a: any) => ({
              id: a.id,
              status: a.status?.nome,
              servico: a.servico?.nome,
              servicoId: a.servico?.id,
              profissional: a.profissional?.nome,
              profissionalId: a.profissional?.id,
              clienteId: a.cliente?.id,
              dataHoraInicio: a.dataHoraInicio,
              duracaoEmMinutos: a.duracaoEmMinutos,
              valor: a.valor,
            }));
          }
          return parsed;
        } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "criar_agendamento": {
        let dataHoraInicio = args.dataHoraInicio || "";
        if (dataHoraInicio.includes(" ")) dataHoraInicio = dataHoraInicio.replace(" ", "T");
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dataHoraInicio)) dataHoraInicio += ":00";

        let resolvedClienteId = args.clienteId;
        if (phoneNumber) {
          let tel = phoneNumber.replace(/\D/g, "");
          if (tel.startsWith("55") && tel.length >= 12) tel = tel.substring(2);
          const ddd = tel.substring(0, 2);
          let rest = tel.substring(2);
          if (rest.length === 8) rest = "9" + rest;
          tel = ddd + rest;

          const clienteRes = await fetch(`${baseUrl}/clientes?telefone=${tel}`, { headers });
          const clienteData = await clienteRes.json();
          const clientes = clienteData?.data || clienteData;
          if (Array.isArray(clientes) && clientes.length > 0) {
            resolvedClienteId = clientes[0].id || clientes[0].Id;
            console.log(`criar_agendamento: resolved clienteId=${resolvedClienteId} from phone ${tel}`);
          } else {
            return { error: "Cliente não encontrado. Use buscar_cliente ou cadastrar_cliente primeiro." };
          }
        }

        try {
          const dedupRes = await fetch(`${baseUrl}/agendamentos?clienteId=${resolvedClienteId}`, { headers });
          const dedupData = await dedupRes.json();
          const agendamentos = dedupData?.data || [];
          if (Array.isArray(agendamentos)) {
            const activeStatuses = ["confirmado", "aguardando confirmação"];
            const duplicate = agendamentos.find((a: any) => {
              const statusName = (a.status?.nome || "").toLowerCase();
              if (!activeStatuses.some(s => statusName.includes(s))) return false;
              const existingStart = (a.dataHoraInicio || "").replace(" ", "T").substring(0, 19);
              const newStart = dataHoraInicio.substring(0, 19);
              return existingStart === newStart &&
                (a.profissional?.id || a.profissionalId) === args.profissionalId;
            });
            if (duplicate) {
              console.log(`criar_agendamento: DUPLICATE detected, existing id=${duplicate.id}`);
              return {
                id: duplicate.id,
                message: "Agendamento já existe para este horário e profissional.",
                deduplicated: true,
              };
            }
          }
        } catch (dedupErr) {
          console.error("criar_agendamento dedup check failed:", dedupErr);
        }

        const body = {
          servicoId: args.servicoId,
          clienteId: resolvedClienteId,
          profissionalId: args.profissionalId,
          dataHoraInicio,
          duracaoEmMinutos: args.duracaoEmMinutos,
          valor: args.valor,
        };
        console.log("criar_agendamento body:", JSON.stringify(body));
        const res = await fetch(`${baseUrl}/agendamentos`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        console.log(`criar_agendamento response (${res.status}):`, text.slice(0, 500));
        try { return JSON.parse(text); } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "cancelar_agendamento": {
        if (phoneNumber) {
          let tel = phoneNumber.replace(/\D/g, "");
          if (tel.startsWith("55") && tel.length >= 12) tel = tel.substring(2);
          const ddd = tel.substring(0, 2);
          let rest = tel.substring(2);
          if (rest.length === 8) rest = "9" + rest;
          tel = ddd + rest;
          const cliRes = await fetch(`${baseUrl}/clientes?telefone=${tel}`, { headers });
          const cliData = await cliRes.json();
          const cliList = cliData?.data || cliData;
          if (Array.isArray(cliList) && cliList.length > 0) {
            const ownerId = cliList[0].id || cliList[0].Id;
            const agRes = await fetch(`${baseUrl}/agendamentos?clienteId=${ownerId}`, { headers });
            const agData = await agRes.json();
            const agList = Array.isArray(agData?.data) ? agData.data : [];
            const activeStatuses = ["confirmado", "aguardando confirmação", "aguardando confirmacao"];
            const activeAgendamentos = agList
              .filter((a: any) => {
                const statusName = String(a.status?.nome || "").toLowerCase();
                return activeStatuses.some((status) => statusName === status || statusName.includes(status));
              })
              .map((a: any) => ({
                id: a.id,
                status: a.status?.nome,
                servico: a.servico?.nome,
                profissional: a.profissional?.nome,
                clienteId: a.cliente?.id,
                dataHoraInicio: a.dataHoraInicio,
              }));
            const owns = activeAgendamentos.some((a: any) => a.id === args.agendamentoId);
            if (!owns) {
              const idx = args.agendamentoId;
              if (Number.isInteger(idx) && idx >= 1 && idx <= activeAgendamentos.length) {
                const correctedId = activeAgendamentos[idx - 1].id;
                console.log(`cancelar_agendamento: AUTO-CORRECTED positional id ${idx} → real id ${correctedId}`);
                args.agendamentoId = correctedId;
              } else if (activeAgendamentos.length === 1) {
                const correctedId = activeAgendamentos[0].id;
                console.log(`cancelar_agendamento: AUTO-CORRECTED invalid id ${args.agendamentoId} → only active id ${correctedId}`);
                args.agendamentoId = correctedId;
              } else {
                console.log(`cancelar_agendamento: ownership check FAILED for agendamentoId=${args.agendamentoId}, cannot auto-correct`);
                return {
                  code: "agendamento_id_invalido",
                  error: "O agendamento informado não pertence a você.",
                  message: "Use um dos IDs reais de agendamentosAtivos ou execute buscar_agendamento novamente nesta interação.",
                  agendamentosAtivos: activeAgendamentos,
                };
              }
            }
          }
        }

        const url = `${baseUrl}/agendamentos/${args.agendamentoId}/status/cancelado`;
        const body = {
          quemCancelou: 1,
          motivo: args.motivo || "Cancelado pelo cliente via WhatsApp",
        };
        console.log(`cancelar_agendamento URL: ${url}`, JSON.stringify(body));
        const res = await fetch(url, {
          method: "PATCH",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        console.log(`cancelar_agendamento response (${res.status}):`, text.slice(0, 500));
        if (res.status === 200 || res.status === 204) {
          return { success: true, message: "Agendamento cancelado com sucesso" };
        }
        try { return { status: res.status, ...JSON.parse(text) }; } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "editar_agendamento": {
        if (phoneNumber) {
          let tel = phoneNumber.replace(/\D/g, "");
          if (tel.startsWith("55") && tel.length >= 12) tel = tel.substring(2);
          const ddd = tel.substring(0, 2);
          let rest = tel.substring(2);
          if (rest.length === 8) rest = "9" + rest;
          tel = ddd + rest;
          const cliRes = await fetch(`${baseUrl}/clientes?telefone=${tel}`, { headers });
          const cliData = await cliRes.json();
          const cliList = cliData?.data || cliData;
          if (Array.isArray(cliList) && cliList.length > 0) {
            const ownerId = cliList[0].id || cliList[0].Id;
            const agRes = await fetch(`${baseUrl}/agendamentos?clienteId=${ownerId}`, { headers });
            const agData = await agRes.json();
            const agList = Array.isArray(agData?.data) ? agData.data : [];
            const activeStatuses = ["confirmado", "aguardando confirmação", "aguardando confirmacao"];
            const activeAgendamentos = agList
              .filter((a: any) => {
                const statusName = String(a.status?.nome || "").toLowerCase();
                return activeStatuses.some((status) => statusName === status || statusName.includes(status));
              })
              .map((a: any) => ({
                id: a.id,
                status: a.status?.nome,
                servico: a.servico?.nome,
                profissional: a.profissional?.nome,
                clienteId: a.cliente?.id,
                dataHoraInicio: a.dataHoraInicio,
              }));
            const owns = activeAgendamentos.some((a: any) => a.id === args.agendamentoId);
            if (!owns) {
              const idx = args.agendamentoId;
              if (Number.isInteger(idx) && idx >= 1 && idx <= activeAgendamentos.length) {
                const correctedId = activeAgendamentos[idx - 1].id;
                console.log(`editar_agendamento: AUTO-CORRECTED positional id ${idx} → real id ${correctedId}`);
                args.agendamentoId = correctedId;
              } else if (activeAgendamentos.length === 1) {
                const correctedId = activeAgendamentos[0].id;
                console.log(`editar_agendamento: AUTO-CORRECTED invalid id ${args.agendamentoId} → only active id ${correctedId}`);
                args.agendamentoId = correctedId;
              } else {
                console.log(`editar_agendamento: ownership check FAILED for agendamentoId=${args.agendamentoId}`);
                return {
                  code: "agendamento_id_invalido",
                  error: "O agendamento informado não pertence a você.",
                  message: "Use um dos IDs reais de agendamentosAtivos ou execute buscar_agendamento novamente nesta interação.",
                  agendamentosAtivos: activeAgendamentos,
                };
              }
            }
          }
        }

        let dataHoraInicio = args.dataHoraInicio || "";
        if (dataHoraInicio.includes(" ")) dataHoraInicio = dataHoraInicio.replace(" ", "T");
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dataHoraInicio)) dataHoraInicio += ":00";

        let editClienteId = args.clienteId;
        if (phoneNumber) {
          let tel2 = phoneNumber.replace(/\D/g, "");
          if (tel2.startsWith("55") && tel2.length >= 12) tel2 = tel2.substring(2);
          const ddd2 = tel2.substring(0, 2);
          let rest2 = tel2.substring(2);
          if (rest2.length === 8) rest2 = "9" + rest2;
          tel2 = ddd2 + rest2;
          const cliRes2 = await fetch(`${baseUrl}/clientes?telefone=${tel2}`, { headers });
          const cliData2 = await cliRes2.json();
          const cliList2 = cliData2?.data || cliData2;
          if (Array.isArray(cliList2) && cliList2.length > 0) {
            editClienteId = cliList2[0].id || cliList2[0].Id;
          }
        }

        const body = {
          servicoId: args.servicoId,
          clienteId: editClienteId,
          profissionalId: args.profissionalId,
          dataHoraInicio,
          duracaoEmMinutos: args.duracaoEmMinutos,
          valor: args.valor,
        };
        console.log(`editar_agendamento body:`, JSON.stringify(body));
        const res = await fetch(`${baseUrl}/agendamentos/${args.agendamentoId}`, {
          method: "PUT",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        console.log(`editar_agendamento response (${res.status}):`, text.slice(0, 500));
        if (res.status === 200 || res.status === 204) {
          return { success: true, message: "Agendamento alterado com sucesso" };
        }
        try { return { status: res.status, ...JSON.parse(text) }; } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      default:
        return { error: `Unknown tool: ${funcName}` };
    }
  } catch (error) {
    console.error(`Trinks tool error (${funcName}):`, error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { error: `Erro ao executar ${funcName}: ${errorMessage}` };
  }
}

// ===================== ONE BELEZA TOOL EXECUTION =====================

async function executeOneBelezaTool(tenant: any, toolCall: any, phoneNumber?: string): Promise<any> {
  const funcName = toolCall.function.name;
  let args: any = {};
  try { args = JSON.parse(toolCall.function.arguments || "{}"); } catch { /* empty */ }

  const baseUrl = "https://onechatbotapi.azurewebsites.net";
  const celular = tenant.onebeleza_celular || "";
  const rawToken = (tenant.onebeleza_token || "").trim();
  const bearerToken = rawToken.startsWith("Bearer ") ? rawToken : `Bearer ${rawToken}`;
  const authHeaders: Record<string, string> = {
    "Authorization": bearerToken,
    "Accept": "application/json",
  };

  try {
    switch (funcName) {
      case "buscar_cliente": {
        // Use the client's phone number for lookup, normalized
        let tel = (phoneNumber || "").replace(/\D/g, "");
        if (tel.startsWith("55") && tel.length >= 12) tel = tel.substring(2);
        
        const url = `${baseUrl}/api/Clientes/GetClientePeloNumero?Celular=${tel}`;
        console.log(`[OneBeleza] buscar_cliente URL: ${url}`);
        const res = await fetch(url, { headers: authHeaders });
        const text = await res.text();
        console.log(`[OneBeleza] buscar_cliente response (${res.status}):`, text.slice(0, 500));
        try { return JSON.parse(text); } catch { return { raw: text.slice(0, 200), status: res.status }; }
      }

      case "cadastrar_cliente": {
        let tel = (phoneNumber || "").replace(/\D/g, "");
        if (tel.startsWith("55") && tel.length >= 12) tel = tel.substring(2);
        
        // cadastrar uses a different host: onetotemapi
        const url = `https://onetotemapi.azurewebsites.net/api/OLoginChatBot/CadastrarUsuario`;
        const body = { celular: tel, nome: args.nome || "Cliente" };
        console.log(`[OneBeleza] cadastrar_cliente URL: ${url}`, JSON.stringify(body));
        const res = await fetch(url, {
          method: "POST",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        console.log(`[OneBeleza] cadastrar_cliente response (${res.status}):`, text.slice(0, 500));
        try { return JSON.parse(text); } catch { return { raw: text.slice(0, 200), status: res.status }; }
      }

      case "buscar_servicos": {
        const url = `${baseUrl}/api/Servicos/RetornarGrupoServicos?celular=${celular}`;
        console.log(`[OneBeleza] buscar_servicos URL: ${url}`);
        const res = await fetch(url, { headers: authHeaders });
        const text = await res.text();
        console.log(`[OneBeleza] buscar_servicos response (${res.status}):`, text.slice(0, 1000));
        try { return JSON.parse(text); } catch { return { raw: text.slice(0, 200), status: res.status }; }
      }

      case "buscar_barbeiros_por_servico": {
        const url = `${baseUrl}/api/Profissionais/PesquisarProfissionais?celular=${celular}&servicosId=${args.servicosId}`;
        console.log(`[OneBeleza] buscar_barbeiros URL: ${url}`);
        const res = await fetch(url, { headers: authHeaders });
        const text = await res.text();
        console.log(`[OneBeleza] buscar_barbeiros response (${res.status}):`, text.slice(0, 1000));
        try { return JSON.parse(text); } catch { return { raw: text.slice(0, 200), status: res.status }; }
      }

      case "buscar_datas_disponiveis": {
        const url = `${baseUrl}/api/Agendamento/RetornarDatasPorServico?celular=${celular}&servicosid=${args.servicosId}&profissionalid=${args.profissionalid}`;
        console.log(`[OneBeleza] buscar_datas URL: ${url}`);
        const res = await fetch(url, { headers: authHeaders });
        const text = await res.text();
        console.log(`[OneBeleza] buscar_datas response (${res.status}):`, text.slice(0, 1000));
        try { return JSON.parse(text); } catch { return { raw: text.slice(0, 200), status: res.status }; }
      }

      case "buscar_horarios": {
        const url = `${baseUrl}/api/Agendamento/HorariosPorProfissionaisByDataServico?celular=${celular}&date=${args.date}&servicoId=${args.servicoId}&ProfissionalId=${args.ProfissionalId}`;
        console.log(`[OneBeleza] buscar_horarios URL: ${url}`);
        const res = await fetch(url, {
          method: "POST",
          headers: authHeaders,
        });
        const text = await res.text();
        console.log(`[OneBeleza] buscar_horarios response (${res.status}):`, text.slice(0, 1000));
        try {
          const parsed = JSON.parse(text);
          
          // Filter past times if today
          const br = getBrasiliaDate();
          if (args.date === br.todayDate) {
            const currentHHMMSS = `${String(br.hours).padStart(2, '0')}:${String(br.minutes).padStart(2, '0')}:00`;
            if (Array.isArray(parsed)) {
              for (const item of parsed) {
                if (item.horarioInicio && item.horarioInicio <= currentHHMMSS) {
                  item._filtered = true;
                }
              }
              const filtered = parsed.filter((item: any) => !item._filtered);
              console.log(`[OneBeleza] Filtered past times: ${parsed.length} → ${filtered.length}`);
              return filtered;
            }
          }
          
          return parsed;
        } catch { return { raw: text.slice(0, 200), status: res.status }; }
      }

      case "agendar": {
        const url = `${baseUrl}/api/Agendamento/MarcarAgendamentoForm?celular=${celular}`;
        
        // Normalize args keys to handle case variations (e.g. servicoid → servicoId)
        const normalizedArgs: Record<string, string> = {};
        for (const [k, v] of Object.entries(args)) {
          normalizedArgs[k.toLowerCase()] = String(v ?? "");
        }
        const aDataAg = normalizedArgs["datanumero"] || normalizedArgs["dataag"] || normalizedArgs["data"] || "";
        const aServicoId = normalizedArgs["servicoid"] || normalizedArgs["servicosid"] || "";
        const aProfissionalId = normalizedArgs["profissionalid"] || "";
        const aHorarioInicio = normalizeOneBelezaTime(normalizedArgs["horarioinicio"] || "");
        const aHorarioFim = normalizeOneBelezaTime(normalizedArgs["horariofim"] || "");

        // Validate IDs are not small/invented numbers
        const sIdNum = parseInt(aServicoId, 10);
        const pIdNum = parseInt(aProfissionalId, 10);
        if (aServicoId && sIdNum > 0 && sIdNum <= 10) {
          console.error(`[OneBeleza] agendar BLOCKED: servicoId=${aServicoId} is suspiciously small (likely invented)`);
          return { error: "servicoId inválido. Execute buscar_servicos novamente e use o servicosId retornado (número grande, ex: 2461).", blocked: true };
        }
        if (aProfissionalId && pIdNum > 0 && pIdNum <= 10) {
          console.error(`[OneBeleza] agendar BLOCKED: profissionalId=${aProfissionalId} is suspiciously small (likely invented)`);
          return { error: "profissionalId inválido. Execute buscar_barbeiros_por_servico novamente e use o profissionalId retornado (número grande, ex: 40658).", blocked: true };
        }
        
        // Build multipart form data
        const formData = new FormData();
        formData.append("dataAg", aDataAg);
        formData.append("servicoId", aServicoId);
        formData.append("profissionalId", aProfissionalId);
        formData.append("horarioInicio", aHorarioInicio);
        formData.append("horarioFim", aHorarioFim);
        
        console.log(`[OneBeleza] agendar URL: ${url}`, `dataAg=${aDataAg} servicoId=${aServicoId} profissionalId=${aProfissionalId} horarioInicio=${aHorarioInicio} horarioFim=${aHorarioFim}`);
        
        const res = await fetch(url, {
          method: "POST",
          headers: { "Authorization": bearerToken },
          body: formData,
        });
        const text = await res.text();
        console.log(`[OneBeleza] agendar response (${res.status}):`, text.slice(0, 500));
        
        if (res.status === 200 || res.status === 201) {
          try { 
            const parsed = JSON.parse(text);
            return { id: parsed.id || parsed.Id || true, success: true, ...parsed };
          } catch { 
            return { id: true, success: true, message: text.slice(0, 200) };
          }
        }
        
        // Handle "Já existe um evento no horário" error
        if (res.status === 400 && text.includes("evento no hor")) {
          return { error: "Já existe um evento no horário.", conflict: true };
        }
        
        try { return JSON.parse(text); } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "buscar_agendamentos_dia": {
        const url = `${baseUrl}/api/Agendamento/GetTodosAgendamentosDia?date=${args.date}`;
        console.log(`[OneBeleza] buscar_agendamentos_dia URL: ${url}`);
        const res = await fetch(url, { headers: authHeaders });
        const text = await res.text();
        console.log(`[OneBeleza] buscar_agendamentos_dia response (${res.status}):`, text.slice(0, 1000));
        try { return JSON.parse(text); } catch { return { raw: text.slice(0, 200), status: res.status }; }
      }

      case "confirmar_agendamento": {
        const url = `${baseUrl}/api/Agendamento/ConfirmarAgendamento?agendasId=${args.agendasId}&celular=${celular}`;
        console.log(`[OneBeleza] confirmar_agendamento URL: ${url}`);
        const res = await fetch(url, {
          method: "POST",
          headers: authHeaders,
        });
        const text = await res.text();
        console.log(`[OneBeleza] confirmar_agendamento response (${res.status}):`, text.slice(0, 500));
        if (res.status === 200) {
          return { success: true, message: "Agendamento confirmado com sucesso" };
        }
        try { return JSON.parse(text); } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "desmarcar_agendamento": {
        const url = `${baseUrl}/api/Agendamento/DesmarcarAgendamento?celular=${celular}&agendasId=${args.agendasId}`;
        console.log(`[OneBeleza] desmarcar_agendamento URL: ${url}`);
        const res = await fetch(url, {
          method: "DELETE",
          headers: authHeaders,
        });
        const text = await res.text();
        console.log(`[OneBeleza] desmarcar_agendamento response (${res.status}):`, text.slice(0, 500));
        if (res.status === 200 || res.status === 204) {
          return { success: true, message: "Agendamento desmarcado com sucesso" };
        }
        try { return JSON.parse(text); } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      default:
        return { error: `Unknown OneBeleza tool: ${funcName}` };
    }
  } catch (error) {
    console.error(`OneBeleza tool error (${funcName}):`, error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { error: `Erro ao executar ${funcName}: ${errorMessage}` };
  }
}

// ===================== NONE TOOL EXECUTION =====================

async function executeNoneTool(tenant: any, toolCall: any): Promise<any> {
  const funcName = toolCall.function.name;

  if (funcName === "enviar_link_agendamento") {
    return {
      link: tenant.booking_link || "Link não configurado",
      message: `Link de agendamento: ${tenant.booking_link || "não configurado"}`,
    };
  }

  return { error: `Unknown tool: ${funcName}` };
}
