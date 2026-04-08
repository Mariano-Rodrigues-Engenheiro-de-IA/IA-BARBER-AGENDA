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

      const messageId = msg.key?.id || msg.id || payload.key?.id || payload.id;
      console.log(`Message from ${phoneNumber}: ${messageContent}`);

      const { data: tenants, error: tenantError } = await supabase
        .from("tenants")
        .select("*")
        .not("uazapi_token", "is", null)
        .eq("status", "active")
        .limit(1);

      if (tenantError || !tenants?.length) {
        console.error("No tenant found:", tenantError);
        return new Response(JSON.stringify({ error: "No tenant configured" }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const tenant = tenants[0];

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

          // Step 1: Get media download link from UAZAPI
          console.log(`Downloading media for messageId: ${messageId}`);
          const linkRes = await fetch(`${uazapiUrlMedia}/getLink/${messageId}`, {
            headers: { "token": uazapiTokenMedia },
          });
          const linkData = await linkRes.json();
          const mediaUrl = linkData?.url || linkData?.fileUrl || linkData?.link || linkData?.mediaUrl;
          console.log("Media link response:", JSON.stringify(linkData).slice(0, 500));

          if (mediaUrl) {
            // Step 2: Download the actual media file
            const mediaRes = await fetch(mediaUrl);
            if (mediaRes.ok) {
              const mediaBuffer = await mediaRes.arrayBuffer();
              const bytes = new Uint8Array(mediaBuffer);
              // Convert to base64
              let binary = "";
              for (let i = 0; i < bytes.length; i++) {
                binary += String.fromCharCode(bytes[i]);
              }
              mediaBase64 = btoa(binary);
              mediaMimeType = linkData?.mimetype || mediaRes.headers.get("content-type") || 
                (isAudioMessage ? "audio/ogg" : "image/jpeg");
              console.log(`Media downloaded: ${mediaMimeType}, size: ${mediaBase64.length} chars base64`);
            } else {
              console.error("Failed to download media:", mediaRes.status);
            }
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

      // ===== DEBOUNCE: Wait 20 seconds for more messages =====
      const DEBOUNCE_MS = 10_000;
      console.log(`Debounce: waiting ${DEBOUNCE_MS / 1000}s for ${phoneNumber}...`);
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS));

      // Check if newer unprocessed messages arrived — if so, let the latest webhook handle it
      const { data: pendingMsgs } = await supabase
        .from("chat_messages")
        .select("id, content, message_id, created_at")
        .eq("tenant_id", tenant.id)
        .eq("phone_number", phoneNumber)
        .eq("role", "user")
        .eq("processed", false)
        .order("created_at", { ascending: false })
        .limit(1);

      if (!pendingMsgs?.length || pendingMsgs[0].message_id !== messageId) {
        console.log(`Debounce: not the latest message, skipping (latest: ${pendingMsgs?.[0]?.message_id}, ours: ${messageId})`);
        return new Response(JSON.stringify({ status: "debounce_skip" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // We are the latest — gather ALL unprocessed user messages and combine
      const { data: allPending } = await supabase
        .from("chat_messages")
        .select("id, content")
        .eq("tenant_id", tenant.id)
        .eq("phone_number", phoneNumber)
        .eq("role", "user")
        .eq("processed", false)
        .order("created_at", { ascending: true });

      // Mark all as processed
      if (allPending?.length) {
        const ids = allPending.map((m: any) => m.id);
        await supabase.from("chat_messages").update({ processed: true }).in("id", ids);
      }

      // Combine messages into one
      const combinedContent = allPending?.map((m: any) => m.content).join("\n") || storedContent;
      console.log(`Debounce: processing ${allPending?.length || 1} messages combined for ${phoneNumber}`);

      const { data: history } = await supabase
        .from("chat_messages")
        .select("role, content")
        .eq("tenant_id", tenant.id)
        .eq("phone_number", phoneNumber)
        .order("created_at", { ascending: true })
        .limit(60);

      const aiResponse = await callAIAgent(tenant, phoneNumber, history || [], combinedContent, mediaBase64, mediaMimeType);

      await supabase.from("chat_messages").insert({
        tenant_id: tenant.id,
        phone_number: phoneNumber,
        role: "assistant",
        content: aiResponse,
      });

      // ===== SPLIT RESPONSE: Send each sentence as a separate message =====
      const uazapiUrl = tenant.uazapi_url || Deno.env.get("UAZAPI_URL");
      const uazapiToken = tenant.uazapi_token || Deno.env.get("UAZAPI_TOKEN");

      // Split by sentence-ending punctuation followed by space/newline
      const messageParts = splitIntoMessages(aiResponse);

      for (let i = 0; i < messageParts.length; i++) {
        const part = messageParts[i].trim();
        if (!part) continue;

        // Small delay between messages to feel natural (except first)
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
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// ===================== AI AGENT =====================

async function callAIAgent(
  tenant: any,
  phoneNumber: string,
  history: { role: string; content: string }[],
  userMessage: string,
  mediaBase64?: string | null,
  mediaMimeType?: string | null,
): Promise<string> {
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

  const systemPrompt = buildSystemPrompt(tenant, phoneNumber);
  const messages: any[] = [
    { role: "system", content: systemPrompt },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];

  // Build the user message — multimodal if media is present
  const lastMsg = messages[messages.length - 1];
  const alreadyHasUserMsg = lastMsg?.role === "user" && lastMsg?.content === userMessage;

  if (mediaBase64 && mediaMimeType) {
    // Multimodal message with media
    const contentParts: any[] = [];

    if (mediaMimeType.startsWith("audio/")) {
      contentParts.push({
        type: "input_audio",
        input_audio: { data: mediaBase64, format: mediaMimeType.includes("ogg") ? "ogg" : mediaMimeType.includes("mp3") ? "mp3" : "wav" },
      });
      contentParts.push({
        type: "text",
        text: userMessage || "O cliente enviou um áudio. Transcreva e responda ao conteúdo.",
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
      // Replace last message with multimodal version
      messages[messages.length - 1] = { role: "user", content: contentParts };
    } else {
      messages.push({ role: "user", content: contentParts });
    }
  } else if (!alreadyHasUserMsg) {
    messages.push({ role: "user", content: userMessage });
  }

  const tools = buildTrinksTools(tenant);

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
    return "Desculpe, estou com dificuldades técnicas no momento. Por favor, tente novamente em instantes.";
  }

  let result = await response.json();
  let assistantMessage = result.choices?.[0]?.message;

  // Handle tool calls (up to 8 rounds for complex flows)
  let rounds = 0;
  while (assistantMessage?.tool_calls && rounds < 8) {
    rounds++;
    messages.push(assistantMessage);

    for (const toolCall of assistantMessage.tool_calls) {
      console.log(`Tool call: ${toolCall.function.name}`, toolCall.function.arguments);
      const toolResult = await executeTrinksTool(tenant, toolCall);
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
      return "Desculpe, tive um problema ao consultar o sistema. Tente novamente.";
    }

    result = await response.json();
    assistantMessage = result.choices?.[0]?.message;
  }

  return assistantMessage?.content || "Desculpe, não consegui processar sua solicitação.";
}

// ===================== MESSAGE SPLITTING =====================

function splitIntoMessages(text: string): string[] {
  // Only split by double newlines (paragraph breaks) — NOT by sentences
  // Splitting by sentences causes contradictory-sounding messages
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

// ===================== SYSTEM PROMPT =====================

function buildSystemPrompt(tenant: any, phoneNumber: string): string {
  const now = new Date();
  // Brasília = UTC-3
  const brTime = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const dateComplete = brTime.toISOString().replace("Z", "").split(".")[0];
  const customPrompt = tenant.agent_system_prompt || "";
  const knowledgeBase = tenant.agent_knowledge_base || "";

  // Format phone for display
  const telefone = phoneNumber;

  return `🗓️ DATA E HORA ATUAL: ${dateComplete}
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
Para cada horário da lista horariosVagos:
- horário ≤ hora atual → ❌ DESCARTE
- horário > hora atual → ✅ PODE OFERECER

**Se for OUTRO DIA:** ofereça todos os horários normalmente.

**Se após filtrar não sobrar nenhum horário:**
→ "Pra hoje não tem mais vaga. Quer ver amanhã?"
→ NUNCA ofereça horários passados.

------------------------------------------

## 🚨 REGRA ABSOLUTA — HORÁRIOS

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

## 🔒 REGRAS GERAIS

### O QUE NUNCA FAZER
- Usar a palavra "custa" → use "valor"
- Mencionar duração, lavatório ou detalhes técnicos espontaneamente
- Listar barbeiros — pergunte se tem preferência
- Perguntar preferência de barbeiro mais de uma vez
- Repetir informações que o cliente já disse
- Listar horários sem saber o serviço primeiro
- Citar horários sem ter executado listar_horarios nessa interação
- Agendar em horário fora da lista de listar_horarios
- Confirmar agendamento sem executar criar_agendamento com sucesso
- Enviar duas mensagens seguidas com o mesmo conteúdo

### O QUE SEMPRE FAZER
- Usar "valor" ao invés de "custa"
- Buscar o cliente silenciosamente na primeira interação
- Consultar ferramentas para obter IDs — nunca inventar
- Usar APENAS horariosVagos (nunca intervalosVagos)

------------------------------------------

## 🔶 REGRA CRÍTICA: IDs

Cada ID tem uma fonte obrigatória:
- clienteId → buscar_cliente
- agendamentoId → buscar_agendamento
- servicoId → listar_servicos
- profissionalId → listar_profissionais ✅ (NUNCA de listar_servicos_profissional ❌)

NUNCA invente ou reutilize IDs de chamadas anteriores.

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

## 🔶 STATUS DOS AGENDAMENTOS

- "Confirmado" ou "Aguardando Confirmação" → ATIVO
- "Cancelado" → já cancelado, não tente cancelar de novo
- "Finalizado" → já aconteceu, não pode cancelar/editar

Só mostre agendamentos com status ATIVO ao cliente.

------------------------------------------

## 🎯 APRESENTAÇÃO INICIAL

Antes de responder, analise a mensagem do cliente e identifique o que ele JÁ disse:
- Serviço mencionado? → pule a pergunta de serviço
- Barbeiro mencionado? → pule a pergunta de barbeiro
- Dia mencionado? → pule a pergunta de dia

**SÓ PERGUNTE O QUE O CLIENTE NÃO DISSE.**

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
2. Execute buscar_agendamento com o clienteId
   - Sem agendamento ativo → "Não encontrei agendamento no seu nome."
   - Com agendamento → mostre e pergunte: "É esse que quer cancelar?"
   - Com múltiplos → liste e pergunte qual
3. Após confirmação → execute cancelar_agendamento com agendamentoId e motivo
   - Sucesso → "✅ Cancelado! Se precisar remarcar, é só falar."
   - Erro 404 → "Não encontrei esse agendamento. Pode já ter sido cancelado."
   - Erro 405 → "Esse agendamento já foi realizado e não pode ser cancelado."
   - Outro erro → "Tive um probleminha. Pode tentar novamente?"

⚠️ NUNCA cancele sem confirmação explícita do cliente.

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
| editar_agendamento | Cliente quer mudar horário/dia |

${customPrompt ? `\nINSTRUÇÕES ADICIONAIS DO ESTABELECIMENTO:\n${customPrompt}` : ""}
${knowledgeBase ? `\nBASE DE CONHECIMENTO:\n${knowledgeBase}` : ""}`;
}

// ===================== TOOLS =====================

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
        description: "Cria um agendamento para o cliente. ANTES de usar, DEVE ter: clienteId, servicoId, duracaoEmMinutos, valor (de listar_servicos), profissionalId (de listar_profissionais), dataHoraInicio no formato YYYY-MM-DDTHH:mm:ss.",
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
        description: "Cancela um agendamento. ANTES de usar, DEVE ter: agendamentoId (de buscar_agendamento). Envie agendamentoId e motivo.",
        parameters: {
          type: "object",
          properties: {
            agendamentoId: { type: "integer", description: "ID do agendamento (obtido de buscar_agendamento)" },
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

// ===================== TOOL EXECUTION =====================

async function executeTrinksTool(tenant: any, toolCall: any): Promise<any> {
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
        // Normalize phone: remove country code, ensure 9-digit mobile
        let tel = (args.telefone || "").replace(/\D/g, "");
        if (tel.startsWith("55") && tel.length >= 12) tel = tel.substring(2);
        // Ensure 9-digit mobile format
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
            duracao: s.duracaoEmMinutos || s.DuracaoEmMinutos || s.duracao,
            categoria: s.categoria || s.Categoria,
          }));
        }
        return data;
      }

      case "listar_servicos_profissional": {
        const profId = args.profissionalId;
        const res = await fetch(`${baseUrl}/profissionais/${profId}/servicos`, { headers });
        const data = await res.json();
        return data;
      }

      case "listar_horarios": {
        const url = `${baseUrl}/agendamentos/profissionais/${args.data}?servicoDuracao=${args.servicoDuracao}`;
        console.log(`listar_horarios URL: ${url}`);
        const res = await fetch(url, { headers });
        const text = await res.text();
        console.log(`listar_horarios response (${res.status}):`, text.slice(0, 1000));
        try { return JSON.parse(text); } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "buscar_agendamento": {
        let clienteId = args.clienteId;

        // Auto-resolve clienteId from telefone if not provided or if provided telefone
        if (!clienteId && args.telefone) {
          let tel = (args.telefone || "").replace(/\D/g, "");
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
          // Filter to only return ACTIVE agendamentos (not cancelled/finalized)
          // Status IDs: 4=Confirmado, 1=Aguardando Confirmação → ACTIVE
          // Status IDs: 9=Cancelado, 6=Finalizado → INACTIVE (remove)
          if (parsed.data && Array.isArray(parsed.data)) {
            const activeStatuses = ["Confirmado", "Aguardando Confirmação", "Aguardando confirmação"];
            parsed.data = parsed.data.filter((a: any) => {
              const statusName = a.status?.nome || "";
              return activeStatuses.some(s => statusName.toLowerCase() === s.toLowerCase());
            });
            console.log(`buscar_agendamento: filtered to ${parsed.data.length} active agendamentos`);
            // Simplify response to reduce noise and prevent ID confusion
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

        const body = {
          servicoId: args.servicoId,
          clienteId: args.clienteId,
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
        let dataHoraInicio = args.dataHoraInicio || "";
        if (dataHoraInicio.includes(" ")) dataHoraInicio = dataHoraInicio.replace(" ", "T");
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dataHoraInicio)) dataHoraInicio += ":00";

        const body = {
          servicoId: args.servicoId,
          clienteId: args.clienteId,
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
    return { error: `Erro ao executar ${funcName}: ${error.message}` };
  }
}
