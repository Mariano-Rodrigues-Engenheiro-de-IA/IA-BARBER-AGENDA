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

    // UAZAPI sends EventType (capitalized) or event/type
    const event = payload.EventType || payload.event || payload.type;
    console.log("Event type:", event);

    // Only process incoming messages
    if (event === "messages.upsert" || event === "message" || event === "messages") {
      // UAZAPI wraps message data in various ways
      const msg = payload.message || payload.data?.message || payload.data || payload;
      
      // Extract text content - UAZAPI format
      const messageContent = msg.conversation || msg.text || msg.body ||
        msg?.extendedTextMessage?.text || msg?.message?.conversation ||
        msg?.message?.extendedTextMessage?.text ||
        payload.text || payload.body;

      const remoteJid = extractRemoteJid(payload, msg);
      const phoneMatch = extractPhoneNumber(payload, msg);
      const phoneNumber = phoneMatch?.phone ?? normalizePhoneNumber(remoteJid);
      // UAZAPI echoes bot-sent messages back as webhooks — detect fromMe from multiple sources
      const fromMe = payload.fromMe === true ||
        msg.fromMe === true ||
        msg.key?.fromMe === true ||
        payload.chat?.lastMessage_fromMe === true ||
        // If the sender matches the UAZAPI instance owner number, it's our own message
        (payload.sender && payload.owner && payload.sender === payload.owner);
      const isGroupMessage = String(remoteJid || "").endsWith("@g.us");

      console.log(
        "Parsed - remoteJid:",
        remoteJid,
        "phoneNumber:",
        phoneNumber,
        "phoneSource:",
        phoneMatch?.source,
        "fromMe:",
        fromMe,
        "content:",
        messageContent?.slice(0, 100)
      );

      // Skip messages sent by us or group messages
      if (fromMe || !phoneNumber || isGroupMessage) {
        return new Response(JSON.stringify({ status: "skipped" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (!messageContent) {
        console.log("No text content in message, skipping");
        return new Response(JSON.stringify({ status: "no_text" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const messageId = msg.key?.id || msg.id || payload.key?.id || payload.id;

      console.log(`Message from ${phoneNumber}: ${messageContent}`);

      // Find tenant by UAZAPI URL/token — for now use the default tenant with UAZAPI configured
      const { data: tenants, error: tenantError } = await supabase
        .from("tenants")
        .select("*")
        .not("uazapi_token", "is", null)
        .eq("status", "active")
        .limit(1);

      if (tenantError || !tenants?.length) {
        console.error("No tenant found with UAZAPI configured:", tenantError);
        return new Response(JSON.stringify({ error: "No tenant configured" }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const tenant = tenants[0];

      // Check for duplicate message
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

      // Save user message
      await supabase.from("chat_messages").insert({
        tenant_id: tenant.id,
        phone_number: phoneNumber,
        role: "user",
        content: messageContent,
        message_id: messageId,
      });

      // Get conversation history (last 20 messages)
      const { data: history } = await supabase
        .from("chat_messages")
        .select("role, content")
        .eq("tenant_id", tenant.id)
        .eq("phone_number", phoneNumber)
        .order("created_at", { ascending: true })
        .limit(20);

      // Call AI agent
      const aiResponse = await callAIAgent(tenant, history || [], messageContent);

      // Save assistant response
      await supabase.from("chat_messages").insert({
        tenant_id: tenant.id,
        phone_number: phoneNumber,
        role: "assistant",
        content: aiResponse,
      });

      // Send response via UAZAPI
      const uazapiUrl = tenant.uazapi_url || Deno.env.get("UAZAPI_URL");
      const uazapiToken = tenant.uazapi_token || Deno.env.get("UAZAPI_TOKEN");

      const sendResult = await fetch(`${uazapiUrl}/send/text`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "token": uazapiToken,
        },
        body: JSON.stringify({
          number: phoneNumber,
          text: aiResponse,
        }),
      });

      const sendData = await sendResult.json();
      console.log("UAZAPI send result:", JSON.stringify(sendData));

      return new Response(JSON.stringify({ status: "ok", response: aiResponse.slice(0, 100) }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Other events
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

async function callAIAgent(
  tenant: any,
  history: { role: string; content: string }[],
  userMessage: string
): Promise<string> {
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

  const systemPrompt = buildSystemPrompt(tenant);

  const messages = [
    { role: "system", content: systemPrompt },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];

  // If last message in history is the current user message (already added), don't duplicate
  const lastMsg = messages[messages.length - 1];
  if (!(lastMsg?.role === "user" && lastMsg?.content === userMessage)) {
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
      model: "google/gemini-3-flash-preview",
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

  // Handle tool calls (up to 3 rounds)
  let rounds = 0;
  while (assistantMessage?.tool_calls && rounds < 3) {
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
        model: "google/gemini-3-flash-preview",
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

function extractRemoteJid(payload: any, msg: any): string | undefined {
  const candidates = [
    payload.phone,
    payload.from,
    payload.remoteJid,
    payload.sender,
    payload.senderId,
    payload.chat?.remoteJid,
    payload.chat?.from,
    payload.chat?.jid,
    payload.data?.remoteJid,
    msg.remoteJid,
    msg.from,
    msg.phone,
    msg.key?.remoteJid,
    msg.key?.participant,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
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
  if (digits.length >= 10 && digits.length <= 15) {
    return digits;
  }

  return null;
}

function extractPhoneNumber(payload: any, msg: any): { phone: string; source: string } | null {
  const directCandidates: Array<[string, unknown]> = [
    ["payload.phone", payload.phone],
    ["payload.from", payload.from],
    ["payload.remoteJid", payload.remoteJid],
    ["payload.sender", payload.sender],
    ["payload.senderId", payload.senderId],
    ["payload.chat.phone", payload.chat?.phone],
    ["payload.chat.number", payload.chat?.number],
    ["payload.chat.whatsapp", payload.chat?.whatsapp],
    ["payload.chat.whatsappNumber", payload.chat?.whatsappNumber],
    ["payload.chat.phoneNumber", payload.chat?.phoneNumber],
    ["payload.chat.contactPhone", payload.chat?.contactPhone],
    ["payload.chat.customerPhone", payload.chat?.customerPhone],
    ["payload.chat.lead_phone", payload.chat?.lead_phone],
    ["payload.chat.leadPhone", payload.chat?.leadPhone],
    ["payload.chat.lead_whatsapp", payload.chat?.lead_whatsapp],
    ["payload.data.phone", payload.data?.phone],
    ["msg.phone", msg.phone],
    ["msg.from", msg.from],
    ["msg.remoteJid", msg.remoteJid],
    ["msg.key.remoteJid", msg.key?.remoteJid],
  ];

  for (const [source, candidate] of directCandidates) {
    const normalized = normalizePhoneNumber(candidate);
    if (normalized) {
      return { phone: normalized, source };
    }
  }

  const keyPattern = /(phone|number|whatsapp|remotejid|jid|from|sender|contact|lead)/i;
  const visited = new WeakSet<object>();
  const queue: Array<{ path: string; value: unknown }> = [
    { path: "payload", value: payload },
    { path: "msg", value: msg },
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

      if (value && typeof value === "object") {
        queue.push({ path, value });
        continue;
      }

      const normalized = normalizePhoneNumber(value);
      if (!normalized) continue;

      if (keyPattern.test(key)) {
        return { phone: normalized, source: path };
      }

      if (typeof value === "string" && /@(s\.whatsapp\.net|c\.us)$/i.test(value)) {
        return { phone: normalized, source: path };
      }
    }
  }

  return null;
}

function buildSystemPrompt(tenant: any): string {
  const customPrompt = tenant.agent_system_prompt || "";
  const knowledgeBase = tenant.agent_knowledge_base || "";

  return `Você é um assistente virtual de agendamento e atendimento do ${tenant.name}.
Seu objetivo é ajudar clientes a agendar serviços, consultar horários disponíveis e responder dúvidas.

REGRAS:
- Seja cordial, objetivo e profissional.
- Responda sempre em português brasileiro.
- Use emojis com moderação para tornar a conversa amigável.
- Quando o cliente quiser agendar, colete: serviço desejado, data/hora preferencial e profissional (se houver preferência).
- Use as ferramentas disponíveis para consultar serviços e disponibilidade na API Trinks.
- Se o cliente não for encontrado, peça nome, telefone e e-mail para cadastro.
- Formate horários de forma legível (ex: "14:30 de terça-feira, 15 de abril").
- Se não puder atender, sugira que o cliente entre em contato diretamente com o estabelecimento.
- NUNCA invente informações sobre horários ou serviços. Sempre consulte as ferramentas.
- Mantenha respostas curtas e adequadas para WhatsApp (evite textos muito longos).

${customPrompt ? `\nINSTRUÇÕES ADICIONAIS DO ESTABELECIMENTO:\n${customPrompt}` : ""}
${knowledgeBase ? `\nBASE DE CONHECIMENTO:\n${knowledgeBase}` : ""}`;
}

function buildTrinksTools(tenant: any) {
  if (!tenant.trinks_api_key || !tenant.trinks_establishment_id) return undefined;

  return [
    {
      type: "function",
      function: {
        name: "listar_servicos",
        description: "Lista os serviços disponíveis no salão com preços e duração.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "listar_profissionais",
        description: "Lista os profissionais disponíveis no salão (nome, id, apelido).",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "consultar_agenda",
        description: "Consulta os agendamentos existentes de um dia específico para verificar horários ocupados. Use para descobrir horários disponíveis.",
        parameters: {
          type: "object",
          properties: {
            data: {
              type: "string",
              description: "Data para consulta no formato YYYY-MM-DD",
            },
            profissionalId: {
              type: "integer",
              description: "ID do profissional (opcional, filtra por profissional)",
            },
          },
          required: ["data"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "buscar_cliente",
        description: "Busca um cliente no sistema pelo telefone ou e-mail.",
        parameters: {
          type: "object",
          properties: {
            telefone: { type: "string", description: "Telefone do cliente" },
            email: { type: "string", description: "E-mail do cliente" },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "criar_cliente",
        description: "Cadastra um novo cliente no sistema.",
        parameters: {
          type: "object",
          properties: {
            nome: { type: "string", description: "Nome completo do cliente" },
            telefone: { type: "string", description: "Telefone do cliente" },
            email: { type: "string", description: "E-mail do cliente" },
          },
          required: ["nome", "telefone"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "criar_agendamento",
        description: "Cria um agendamento no sistema. Use SOMENTE após confirmação explícita do cliente.",
        parameters: {
          type: "object",
          properties: {
            servicoId: { type: "integer", description: "ID do serviço" },
            clienteId: { type: "integer", description: "ID do cliente" },
            profissionalId: { type: "integer", description: "ID do profissional" },
            dataHoraInicio: { type: "string", description: "Data e hora no formato YYYY-MM-DD HH:MM" },
            duracaoEmMinutos: { type: "integer", description: "Duração em minutos" },
            valor: { type: "number", description: "Valor do serviço" },
            observacoes: { type: "string", description: "Observações opcionais" },
          },
          required: ["servicoId", "clienteId", "profissionalId", "dataHoraInicio", "duracaoEmMinutos", "valor"],
        },
      },
    },
  ];
}

async function executeTrinksTool(tenant: any, toolCall: any): Promise<any> {
  const funcName = toolCall.function.name;
  let args: any = {};
  try {
    args = JSON.parse(toolCall.function.arguments || "{}");
  } catch { /* empty args */ }

  const baseUrl = "https://api.trinks.com/v1";
  const headers: Record<string, string> = {
    "X-Api-Key": tenant.trinks_api_key,
    "Accept": "application/json",
    "estabelecimentoId": tenant.trinks_establishment_id,
  };

  try {
    switch (funcName) {
      case "listar_servicos": {
        const res = await fetch(
          `${baseUrl}/servicos?estabelecimentoId=${tenant.trinks_establishment_id}&somenteVisiveisCliente=true`,
          { headers }
        );
        const data = await res.json();
        const list = data?.data || data;
        if (Array.isArray(list)) {
          return list.map((s: any) => ({
            id: s.id || s.Id,
            nome: s.nome || s.Nome,
            descricao: s.descricao || s.Descricao || "",
            preco: s.preco || s.Preco || s.valor || s.Valor,
            duracao: s.duracaoEmMinutos || s.DuracaoEmMinutos || s.duracao || s.Duracao,
            categoria: s.categoria || s.Categoria,
          })).slice(0, 25);
        }
        return data;
      }

      case "listar_profissionais": {
        const res = await fetch(
          `${baseUrl}/profissionais?estabelecimentoId=${tenant.trinks_establishment_id}`,
          { headers }
        );
        const data = await res.json();
        const list = data?.data || data;
        if (Array.isArray(list)) {
          return list.map((p: any) => ({
            id: p.id || p.Id,
            nome: p.nome || p.Nome,
            apelido: p.apelido || p.Apelido,
          })).slice(0, 10);
        }
        return data;
      }

      case "consultar_agenda": {
        const params = new URLSearchParams();
        params.set("estabelecimentoId", tenant.trinks_establishment_id);
        params.set("dataInicio", args.data);
        params.set("dataFim", args.data);
        if (args.profissionalId) params.set("profissionalId", String(args.profissionalId));
        const url = `${baseUrl}/agendamentos?${params}`;
        console.log(`consultar_agenda URL: ${url}`);
        const res = await fetch(url, { headers });
        const data = await res.json();
        const list = data?.data || data;
        if (Array.isArray(list)) {
          return {
            data: args.data,
            agendamentos: list.map((a: any) => ({
              profissional: a.profissional?.nome || a.profissional?.apelido,
              profissionalId: a.profissional?.id,
              servico: a.servico?.nome,
              inicio: a.dataHoraInicio,
              duracao: a.duracaoEmMinutos,
              status: a.status?.nome,
            })),
            total: data?.totalRecords || list.length,
          };
        }
        return data;
      }

      case "buscar_cliente": {
        const params = new URLSearchParams();
        params.set("estabelecimentoId", tenant.trinks_establishment_id);
        if (args.telefone) params.set("telefone", args.telefone);
        if (args.email) params.set("email", args.email);
        const url = `${baseUrl}/clientes?${params}`;
        console.log(`buscar_cliente URL: ${url}`);
        const res = await fetch(url, { headers });
        const text = await res.text();
        console.log(`buscar_cliente response (${res.status}):`, text.slice(0, 500));
        try {
          return JSON.parse(text);
        } catch {
          return { error: `Trinks API retornou resposta inválida (status ${res.status})`, raw: text.slice(0, 200) };
        }
      }

      case "criar_cliente": {
        // Parse phone: expect full BR number like 62999887766 or 5562999887766
        let ddi = "55";
        let ddd = "";
        let numero = args.telefone || "";
        if (numero.startsWith("55") && numero.length >= 12) {
          ddi = "55";
          ddd = numero.substring(2, 4);
          numero = numero.substring(4);
        } else if (numero.length >= 10) {
          ddd = numero.substring(0, 2);
          numero = numero.substring(2);
        }

        const clienteBody = {
          nome: args.nome,
          email: args.email || "",
          estabelecimentoId: parseInt(tenant.trinks_establishment_id),
          telefones: [{
            ddi,
            ddd,
            numero,
            tipoId: 1,
          }],
        };
        console.log("criar_cliente body:", JSON.stringify(clienteBody));
        const res = await fetch(`${baseUrl}/clientes`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(clienteBody),
        });
        const text = await res.text();
        console.log(`criar_cliente response (${res.status}):`, text.slice(0, 500));
        try {
          return JSON.parse(text);
        } catch {
          return { error: `Trinks API retornou resposta inválida (status ${res.status})`, raw: text.slice(0, 200) };
        }
      }

      case "criar_agendamento": {
        const agendBody = {
          servicoId: args.servicoId,
          clienteId: args.clienteId,
          profissionalId: args.profissionalId,
          dataHoraInicio: args.dataHoraInicio,
          duracaoEmMinutos: args.duracaoEmMinutos,
          valor: args.valor,
          observacoes: args.observacoes || "",
          confirmado: false,
          estabelecimentoId: parseInt(tenant.trinks_establishment_id),
        };
        console.log("criar_agendamento body:", JSON.stringify(agendBody));
        const res = await fetch(`${baseUrl}/agendamentos`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(agendBody),
        });
        const text = await res.text();
        console.log(`criar_agendamento response (${res.status}):`, text.slice(0, 500));
        try {
          return JSON.parse(text);
        } catch {
          return { error: `Trinks API retornou resposta inválida (status ${res.status})`, raw: text.slice(0, 200) };
        }
      }

      default:
        return { error: `Unknown tool: ${funcName}` };
    }
  } catch (error) {
    console.error(`Trinks tool error (${funcName}):`, error);
    return { error: `Erro ao executar ${funcName}: ${error.message}` };
  }
}
