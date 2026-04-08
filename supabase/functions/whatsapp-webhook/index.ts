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

      // Get sender phone number - UAZAPI uses 'phone' or 'from' or remoteJid
      const remoteJid = payload.phone || payload.from || msg.remoteJid || msg.key?.remoteJid || payload.remoteJid;
      const fromMe = payload.fromMe ?? msg.fromMe ?? msg.key?.fromMe;
      
      console.log("Parsed - remoteJid:", remoteJid, "fromMe:", fromMe, "content:", messageContent?.slice(0, 100));

      // Skip messages sent by us or group messages
      if (fromMe || !remoteJid || String(remoteJid).endsWith("@g.us")) {
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

      // Extract phone number from JID (remove @s.whatsapp.net)
      const phoneNumber = remoteJid.replace("@s.whatsapp.net", "").replace("@c.us", "");
      const messageId = message.key?.id || message.id || data.key?.id;

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

      const sendResult = await fetch(`${uazapiUrl}/message/send-text`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "token": uazapiToken,
        },
        body: JSON.stringify({
          number: phoneNumber,
          text: aiResponse,
          delay: 2000,
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
      const toolResult = await executeTrinksTool(tenant, toolCall);
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
        description: "Lista os profissionais disponíveis no salão e suas agendas.",
        parameters: {
          type: "object",
          properties: {
            data: {
              type: "string",
              description: "Data para consulta no formato YYYY-MM-DD. Se não informada, usa a data atual.",
            },
          },
          required: [],
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
        // Return simplified list
        if (Array.isArray(data)) {
          return data.map((s: any) => ({
            id: s.id || s.Id,
            nome: s.nome || s.Nome,
            preco: s.preco || s.Preco || s.valor || s.Valor,
            duracao: s.duracao || s.Duracao || s.duracaoEmMinutos || s.DuracaoEmMinutos,
            categoria: s.categoria || s.Categoria,
          })).slice(0, 20);
        }
        return data;
      }

      case "listar_profissionais": {
        const res = await fetch(
          `${baseUrl}/profissionais/agenda?estabelecimentoId=${tenant.trinks_establishment_id}${args.data ? `&data=${args.data}` : ""}`,
          { headers }
        );
        const data = await res.json();
        if (Array.isArray(data)) {
          return data.map((p: any) => ({
            id: p.id || p.Id,
            nome: p.nome || p.Nome,
            agenda: p.agenda || p.Agenda,
          })).slice(0, 10);
        }
        return data;
      }

      case "buscar_cliente": {
        const params = new URLSearchParams();
        params.set("estabelecimentoId", tenant.trinks_establishment_id);
        if (args.telefone) params.set("telefone", args.telefone);
        if (args.email) params.set("email", args.email);
        const res = await fetch(`${baseUrl}/clientes?${params}`, { headers });
        return await res.json();
      }

      case "criar_cliente": {
        const res = await fetch(`${baseUrl}/clientes`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            nome: args.nome,
            telefone: args.telefone,
            email: args.email || "",
            estabelecimentoId: parseInt(tenant.trinks_establishment_id),
          }),
        });
        return await res.json();
      }

      case "criar_agendamento": {
        const res = await fetch(`${baseUrl}/agendamentos`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            servicoId: args.servicoId,
            clienteId: args.clienteId,
            profissionalId: args.profissionalId,
            dataHoraInicio: args.dataHoraInicio,
            duracaoEmMinutos: args.duracaoEmMinutos,
            valor: args.valor,
            observacoes: args.observacoes || "",
            confirmado: false,
            estabelecimentoId: parseInt(tenant.trinks_establishment_id),
          }),
        });
        return await res.json();
      }

      default:
        return { error: `Unknown tool: ${funcName}` };
    }
  } catch (error) {
    console.error(`Trinks tool error (${funcName}):`, error);
    return { error: `Erro ao executar ${funcName}: ${error.message}` };
  }
}
