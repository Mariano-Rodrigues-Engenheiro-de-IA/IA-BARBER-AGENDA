// ===================== MODO ECONÔMICO / SITE DE CHAT =====================
// Módulo isolado. Tudo que é específico do canal WEB (site próprio da empresa)
// mora aqui — nada de lógica de provider ou de guards de agendamento.
//
// Fluxo:
// 1. WhatsApp recebe mensagem de um cliente de um tenant com economic_mode_enabled.
// 2. Em vez de rodar a IA, o webhook envia UM convite (botão nativo UAZAPI /send/menu,
//    com fallback automático para /send/text) com o link único do cliente.
// 3. O cliente abre o link -> site de chat -> conversa com a MESMA IA (callAIAgent),
//    injetada aqui de fora para não duplicar lógica.

export interface WebChatSession {
  id: string;
  tenant_id: string;
  phone_number: string;
  token: string;
  display_name: string | null;
  invite_sent_at: string | null;
  last_seen_at: string | null;
}

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function getPublicAppUrl(): string {
  const raw = Deno.env.get("PUBLIC_APP_URL") || "https://zayloia.com";
  return raw.replace(/\/+$/, "");
}

export function buildWebChatUrl(token: string): string {
  return `${getPublicAppUrl()}/c/${token}`;
}

/** Cria (ou reaproveita) a sessão web do cliente naquele tenant. Token é por telefone e não expira. */
export async function ensureWebChatSession(
  supabase: any,
  tenantId: string,
  phoneNumber: string,
  displayName?: string | null,
): Promise<WebChatSession | null> {
  const { data: existing } = await supabase
    .from("web_chat_sessions")
    .select("id,tenant_id,phone_number,token,display_name,invite_sent_at,last_seen_at")
    .eq("tenant_id", tenantId)
    .eq("phone_number", phoneNumber)
    .maybeSingle();

  if (existing) {
    if (displayName && !existing.display_name) {
      await supabase.from("web_chat_sessions").update({ display_name: displayName }).eq("id", existing.id);
      existing.display_name = displayName;
    }
    return existing as WebChatSession;
  }

  const { data: created, error } = await supabase
    .from("web_chat_sessions")
    .insert({
      tenant_id: tenantId,
      phone_number: phoneNumber,
      token: randomToken(),
      display_name: displayName || null,
    })
    .select("id,tenant_id,phone_number,token,display_name,invite_sent_at,last_seen_at")
    .single();

  if (error) {
    console.error("[WebChat] erro criando sessão:", error.message);
    // Corrida entre dois webhooks simultâneos: relê.
    const { data: retry } = await supabase
      .from("web_chat_sessions")
      .select("id,tenant_id,phone_number,token,display_name,invite_sent_at,last_seen_at")
      .eq("tenant_id", tenantId)
      .eq("phone_number", phoneNumber)
      .maybeSingle();
    return (retry as WebChatSession) || null;
  }
  return created as WebChatSession;
}

/**
 * Envia o convite no WhatsApp.
 * CONFIRMADO NA DOC DA UAZAPI: POST /send/menu com type="button" aceita botão de URL
 * no formato "Texto|https://link". Como API não oficial pode degradar em alguns
 * aparelhos, se o /send/menu falhar cai automaticamente para /send/text (fail-safe).
 */
export async function sendEconomicModeInvite(opts: {
  uazapiUrl: string;
  uazapiToken: string;
  number: string;
  text: string;
  buttonLabel: string;
  url: string;
  footerText?: string;
}): Promise<{ ok: boolean; via: "menu" | "text" | "none"; status?: number; error?: string }> {
  const base = opts.uazapiUrl.replace(/\/+$/, "");
  const headers = { "Content-Type": "application/json", token: opts.uazapiToken };

  try {
    const resp = await fetch(`${base}/send/menu`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        number: opts.number,
        type: "button",
        text: opts.text,
        choices: [`${opts.buttonLabel}|${opts.url}`],
        footerText: opts.footerText || undefined,
      }),
    });
    if (resp.ok) {
      try { await resp.text(); } catch { /* ignore */ }
      return { ok: true, via: "menu", status: resp.status };
    }
    const body = await resp.text().catch(() => "");
    console.warn(`[WebChat] /send/menu falhou (${resp.status}): ${body.slice(0, 300)} — caindo para texto`);
  } catch (e) {
    console.warn("[WebChat] /send/menu erro de rede — caindo para texto:", e);
  }

  try {
    const resp = await fetch(`${base}/send/text`, {
      method: "POST",
      headers,
      body: JSON.stringify({ number: opts.number, text: `${opts.text}\n\n👉 ${opts.url}` }),
    });
    if (resp.ok) {
      try { await resp.text(); } catch { /* ignore */ }
      return { ok: true, via: "text", status: resp.status };
    }
    const body = await resp.text().catch(() => "");
    return { ok: false, via: "none", status: resp.status, error: body.slice(0, 300) };
  } catch (e: any) {
    return { ok: false, via: "none", error: e?.message || String(e) };
  }
}

export function buildInviteText(tenant: any): string {
  const custom = String(tenant?.chat_site_invite_message || "").trim();
  if (custom) return custom;
  return `Olá! 👋 Aqui é o atendimento digital da ${tenant?.name || "nossa equipe"}.\n\n` +
    `Para agendar e tirar dúvidas com mais rapidez, continue o atendimento no nosso site 👇`;
}

/** Branding público do site de chat (nunca expõe credenciais do tenant). */
export function publicTenantBranding(tenant: any) {
  return {
    id: tenant.id,
    name: tenant.name,
    logo_url: tenant.logo_url ?? null,
    banner_url: tenant.chat_site_banner_url ?? null,
    brand_color: tenant.chat_site_brand_color ?? null,
    theme: tenant.chat_site_theme === "light" ? "light" : "dark",
    welcome_message: tenant.chat_site_welcome_message ?? null,
    whatsapp_number: tenant.whatsapp_number ?? null,
  };
}

type CallAIAgentFn = (
  supabase: any,
  tenant: any,
  phoneNumber: string,
  history: { role: string; content: string; created_at?: string }[],
  userMessage: string,
  provider: string,
  mediaBase64?: string | null,
  mediaMimeType?: string | null,
  senderName?: string,
  simulatorMode?: boolean,
) => Promise<{ response: string | null; toolCalls: any[]; errors: any[]; model?: string; durationMs?: number }>;

const HISTORY_LIMIT = 60;

/**
 * Handler do canal WEB. Público (identificado pelo token da URL), sem login.
 * actions:
 *  - "init": devolve branding do tenant + histórico da conversa
 *  - "send": roda a MESMA IA do WhatsApp e devolve a resposta para exibir no site
 */
export async function handleWebChatRequest(
  req: Request,
  deps: {
    createServiceClient: () => any;
    callAIAgent: CallAIAgentFn;
    corsHeaders: Record<string, string>;
    getHttpTrace?: () => unknown;
  },
): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...deps.corsHeaders, "Content-Type": "application/json" },
    });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const token = String(body?.token || "").trim();
  const action = body?.action === "send" ? "send" : "init";
  if (!token || token.length < 16) return json({ error: "invalid_token" }, 400);

  const svc = deps.createServiceClient();

  const { data: session } = await svc
    .from("web_chat_sessions")
    .select("id,tenant_id,phone_number,token,display_name,web_started_at")
    .eq("token", token)
    .maybeSingle();
  if (!session) return json({ error: "session_not_found" }, 404);

  const { data: tenant } = await svc.from("tenants").select("*").eq("id", session.tenant_id).maybeSingle();
  if (!tenant || tenant.status !== "active") return json({ error: "tenant_unavailable" }, 404);

  // A conversa do site começa do zero: nada do histórico anterior do WhatsApp
  // aparece aqui nem entra no contexto da IA. Marcamos o início no primeiro acesso.
  let webStartedAt: string = session.web_started_at || new Date().toISOString();
  if (!session.web_started_at) {
    await svc.from("web_chat_sessions").update({ web_started_at: webStartedAt }).eq("id", session.id);
  }

  await svc.from("web_chat_sessions").update({ last_seen_at: new Date().toISOString() }).eq("id", session.id);

  const loadHistory = async () => {
    const { data } = await svc
      .from("chat_messages")
      .select("role,content,created_at")
      .eq("tenant_id", tenant.id)
      .eq("phone_number", session.phone_number)
      .gte("created_at", webStartedAt)
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT);
    return (data || []).reverse() as { role: string; content: string; created_at?: string }[];
  };

  if (action === "init") {
    return json({
      tenant: publicTenantBranding(tenant),
      customer: { name: session.display_name, phone_masked: maskPhone(session.phone_number) },
      messages: await loadHistory(),
      agent_paused: !!tenant.agent_paused,
    });
  }

  const message = String(body?.message || "").trim();
  if (!message) return json({ error: "empty_message" }, 400);
  if (message.length > 2000) return json({ error: "message_too_long" }, 400);

  // Mesma trava do WhatsApp: se o dono pausou a IA, o site não responde sozinho.
  if (tenant.agent_paused) {
    await svc.from("chat_messages").insert({
      tenant_id: tenant.id, phone_number: session.phone_number,
      role: "user", content: message, processed: true,
    });
    return json({
      response: "Nosso atendimento automático está pausado no momento. Já avisamos a equipe — em instantes alguém te chama no WhatsApp. 🙌",
      paused: true,
    });
  }

  const history = await loadHistory();

  await svc.from("chat_messages").insert({
    tenant_id: tenant.id, phone_number: session.phone_number,
    role: "user", content: message, processed: true,
  });

  const provider: string = tenant.api_provider || "trinks";
  const tStart = Date.now();

  // Monitor de IA: o canal web registra em agent_logs igual ao WhatsApp, para que
  // toda conversa (econômica ou não) apareça no monitor.
  const logToMonitor = async (opts: {
    aiResponse: string | null;
    toolCalls: any[];
    errors: any[];
    model?: string | null;
  }) => {
    try {
      await svc.from("agent_logs").insert({
        tenant_id: tenant.id,
        phone_number: session.phone_number,
        user_message: message,
        ai_response: opts.aiResponse,
        tool_calls: [
          { name: "__channel__", args: { channel: "web_chat", token_suffix: token.slice(-6) }, result: { origin: "site" }, blocked: false },
          ...(opts.toolCalls || []),
        ],
        errors: opts.errors || [],
        model_used: opts.model || "web_chat",
        duration_ms: Date.now() - tStart,
        session_blocked: false,
        http_trace: deps.getHttpTrace ? deps.getHttpTrace() : null,
      });
    } catch (e: any) {
      console.error("[WebChat] falha ao gravar agent_logs:", e?.message || e);
    }
  };

  let result: Awaited<ReturnType<CallAIAgentFn>>;
  try {
    result = await deps.callAIAgent(
      svc, tenant, session.phone_number, history, message, provider,
      null, null, session.display_name || undefined, false,
    );
  } catch (e: any) {
    console.error("[WebChat] callAIAgent falhou:", e?.message, e?.stack);
    await logToMonitor({
      aiResponse: null,
      toolCalls: [],
      errors: [{ level: "error", message: `callAIAgent falhou: ${e?.message || e}` }],
    });
    return json({
      response: "Tive um probleminha técnico agora. Pode repetir sua última mensagem, por favor?",
      error: "agent_failed",
    });
  }

  const responseText = (result?.response || "").trim();
  if (responseText) {
    await svc.from("chat_messages").insert({
      tenant_id: tenant.id, phone_number: session.phone_number,
      role: "assistant", content: responseText, processed: true,
    });
  }

  await logToMonitor({
    aiResponse: responseText || null,
    toolCalls: result?.toolCalls || [],
    errors: result?.errors || [],
    model: result?.model,
  });

  // Escalonamento pra humano: a IA já executa o escalate_human (etiqueta + aviso à
  // equipe pelo WhatsApp). Aqui só sinalizamos ao site para exibir o aviso visual.
  const escalated = Array.isArray(result?.toolCalls)
    && result.toolCalls.some((tc: any) => {
      const t = `${tc?.tool_type || ""} ${tc?.name || ""} ${tc?.tool || ""}`.toLowerCase();
      return t.includes("escalate_human") || t.includes("escalar_humano") || t.includes("escalar humano");
    });

  return json({
    response: responseText || "Só um instante…",
    escalated,
    whatsapp_number: escalated ? (tenant.whatsapp_number ?? null) : null,
  });
}

function maskPhone(phone: string): string {
  const d = String(phone || "").replace(/\D/g, "");
  if (d.length < 6) return d;
  return `•••• ${d.slice(-4)}`;
}
