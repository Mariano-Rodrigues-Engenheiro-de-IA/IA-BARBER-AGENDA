// Compactação PURA do http_trace gravado em agent_logs (sem imports, testável).
//
// Contexto (medição de 05/10, 170 atendimentos de IA): a linha média de
// agent_logs tinha 27 KB e 94% era http_trace. Dentro dele, 77% eram chamadas à
// OpenAI (o corpo da requisição repete os primeiros 4000 caracteres do mesmo
// prompt de sistema) e 20% eram chamadas à UAZAPI. O tool_calls, que o painel
// e o auditor leem, tinha só ~0,8 KB.
//
// Regras:
//  - OpenAI: não guarda o corpo da requisição nem da resposta. Guarda um resumo
//    curto (modelo, tamanhos, parâmetros) e o `usage` real (entrada, cache,
//    raciocínio, saída). Isso também permite somar total_tokens por atendimento.
//  - UAZAPI: guarda status/duração/url e só o início dos corpos.
//  - Qualquer outro host (APIs de agenda: Bemp, AppBarber, Frizzar, Trinks...)
//    não é tocado, porque ajuda nas investigações.

export const UAZAPI_BODY_MAX = 300;

type Json = Record<string, unknown>;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function isOpenAiHost(url: string): boolean {
  return hostOf(url) === "api.openai.com";
}

export function isUazapiHost(url: string): boolean {
  const h = hostOf(url);
  return h === "uazapi.com" || h.endsWith(".uazapi.com");
}

function safeParse(text: string | null | undefined): Json | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as Json) : null;
  } catch {
    return null;
  }
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Resumo da requisição à OpenAI, sem nenhum conteúdo de mensagem. */
export function summarizeOpenAiRequest(reqBody: string | null | undefined): Json {
  const req = safeParse(reqBody);
  if (!req) return { unparsed: true, chars: reqBody ? reqBody.length : 0 };
  const messages = Array.isArray(req.messages) ? (req.messages as Array<Json>) : [];
  let promptChars = 0;
  for (const m of messages) {
    const c = (m as Json)?.content;
    if (typeof c === "string") promptChars += c.length;
    else if (Array.isArray(c)) promptChars += JSON.stringify(c).length;
  }
  const toolChoice = req.tool_choice;
  return {
    model: req.model ?? null,
    messages: messages.length,
    tools: Array.isArray(req.tools) ? req.tools.length : 0,
    tool_choice: typeof toolChoice === "string" ? toolChoice : toolChoice ? "forced" : null,
    max_completion_tokens: req.max_completion_tokens ?? null,
    reasoning_effort: req.reasoning_effort ?? null,
    prompt_chars: promptChars,
  };
}

/** Resumo da resposta da OpenAI: modelo, motivo de parada, nomes de tools e usage. */
export function summarizeOpenAiResponse(resBody: string | null | undefined): Json {
  const res = safeParse(resBody);
  if (!res) return { unparsed: true, chars: resBody ? resBody.length : 0 };
  const choice = Array.isArray(res.choices) ? (res.choices[0] as Json | undefined) : undefined;
  const message = (choice?.message ?? {}) as Json;
  const toolCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as Array<Json>) : [];
  const usage = (res.usage ?? {}) as Json;
  const promptDetails = (usage.prompt_tokens_details ?? {}) as Json;
  const completionDetails = (usage.completion_tokens_details ?? {}) as Json;
  const prompt = num(usage.prompt_tokens);
  const completion = num(usage.completion_tokens);
  return {
    model: res.model ?? null,
    finish_reason: choice?.finish_reason ?? null,
    tool_calls: toolCalls
      .map((t) => String(((t?.function ?? {}) as Json).name ?? ""))
      .filter(Boolean),
    usage: {
      prompt_tokens: prompt,
      cached_tokens: num(promptDetails.cached_tokens) ?? 0,
      completion_tokens: completion,
      reasoning_tokens: num(completionDetails.reasoning_tokens) ?? 0,
      total_tokens: num(usage.total_tokens) ?? (prompt !== null && completion !== null ? prompt + completion : null),
    },
  };
}

/**
 * Devolve os corpos compactos para os hosts que compactamos, ou null quando o
 * host deve seguir o fluxo normal (truncar em 4000 caracteres).
 * `reqRaw` e `resRaw` são os textos originais (antes de truncar).
 */
export function compactTraceBodies(
  url: string,
  reqRaw: string | null | undefined,
  resRaw: string | null | undefined,
): { request_body: string | null; response_body: string | null } | null {
  if (isOpenAiHost(url)) {
    return {
      request_body: JSON.stringify(summarizeOpenAiRequest(reqRaw)),
      response_body: JSON.stringify(summarizeOpenAiResponse(resRaw)),
    };
  }
  if (isUazapiHost(url)) {
    const cut = (t: string | null | undefined) =>
      !t ? null : t.length <= UAZAPI_BODY_MAX ? t : t.slice(0, UAZAPI_BODY_MAX) + `…(+${t.length - UAZAPI_BODY_MAX} chars)`;
    return { request_body: cut(reqRaw), response_body: cut(resRaw) };
  }
  return null;
}

/** Soma o total_tokens das chamadas à OpenAI já compactadas. 0 se não houver. */
export function sumOpenAiTotalTokens(
  entries: Array<{ url?: string; response_body?: string | null }>,
): number {
  let total = 0;
  for (const e of entries || []) {
    if (!e?.url || !isOpenAiHost(e.url)) continue;
    const parsed = safeParse(e.response_body);
    const usage = (parsed?.usage ?? {}) as Json;
    total += num(usage.total_tokens) ?? 0;
  }
  return total;
}
