// ============================================================================
// MONITOR 24H — montagem do dossiê e validação determinística de evidência.
// Nada aqui chama IA: a IA interpreta, o código exige a prova.
// ============================================================================

export const AUDIT_CATEGORIES = [
  "completude_agendamento",
  "cancelamento_remarcacao",
  "comunicacao",
  "erro_tecnico_mascarado",
  // Novas camadas: qualquer vacilo da IA no uso da API de agenda.
  "disponibilidade_inventada",
  "dados_incorretos_api",
  "uso_indevido_ferramenta",
  "duplicidade_agendamento",
  // Violações objetivas de protocolo da conversa.
  "violacao_silent_mode",
  "acao_afirmada_nao_executada",
  "profissional_inventado",
] as const;

// Ferramentas que tornam o atendimento auditável (agenda + cliente),
// incluindo as consultas — é nelas que a IA inventa horário/profissional.
export const RELEVANT_TOOLS: string[] = [
  // criação
  "criar_agendamento", "agendar",
  // cancelamento
  "cancelar_agendamento", "desmarcar_agendamento",
  // remarcação
  "editar_agendamento", "remarcar_agendamento",
  // cliente
  "buscar_cliente", "cadastrar_cliente", "consultar_cliente",
  // consulta de agendamentos existentes
  "listar_agendamentos", "buscar_agendamento", "buscar_agendamentos", "buscar_agendamentos_dia", "confirmar_agendamento",
  // disponibilidade, serviços, profissionais e unidades
  "buscar_horarios", "buscar_horarios_disponiveis", "listar_horarios", "listar_horarios_geral",
  "buscar_servicos", "listar_servicos", "listar_servicos_profissional",
  "listar_profissionais", "buscar_barbeiros_por_servico", "listar_unidades",
];

// Qualquer chamada real à API de agenda torna o turno auditável.
const AUDITABLE_TOOLS = new Set(RELEVANT_TOOLS);

export function hasRelevantTool(toolCalls: any[]): boolean {
  return (toolCalls ?? []).some((tc) => AUDITABLE_TOOLS.has(String(tc?.name ?? "")));
}

function trim(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…(truncado)` : text;
}

export function buildDossier(
  log: { user_message?: string | null; ai_response?: string | null; errors?: unknown; created_at?: string },
  history: Array<{ role: string; content: string; created_at?: string }>,
  toolCalls: any[],
  afterMessages: Array<{ role: string; content: string }> = [],
) {
  const historyLines = history
    .filter((m) => m?.role === "user" || m?.role === "assistant")
    .map((m) => `${m.role === "user" ? "CLIENTE" : "IA"}: ${trim(m.content, 900)}`);

  const conversationBlock = [
    "=== CONVERSA (mais antiga primeiro) ===",
    ...historyLines,
    "",
    "=== MENSAGEM DO CLIENTE NESTE ATENDIMENTO ===",
    trim(log.user_message, 2000),
    "",
    "=== RESPOSTA FINAL ENVIADA AO CLIENTE ===",
    trim(log.ai_response, 2000) || "(nenhuma resposta enviada)",
    "",
    "=== O QUE O CLIENTE DISSE DEPOIS (reação real) ===",
    ...(afterMessages.length
      ? afterMessages
          .filter((m) => m?.role === "user" || m?.role === "assistant")
          .map((m) => `${m.role === "user" ? "CLIENTE" : "IA"}: ${trim(m.content, 500)}`)
      : ["(nada depois)"]),
  ].join("\n");

  const toolLines = (toolCalls ?? [])
    .filter((tc) => String(tc?.name ?? "") !== "__debounce_batch__")
    .map((tc, i) => {
      const name = String(tc?.name ?? "desconhecida");
      const args = trim(tc?.resolvedArgs ?? tc?.args, 700);
      // Limite generoso: cortar cedo demais fazia o modelo ler só o começo de
      // listas de horários e concluir ausência inexistente (falso alarme N7).
      const result = trim(tc?.result, 6000);
      const blocked = tc?.blocked === true ? " [BLOQUEADA POR GUARD]" : "";
      return `#${i + 1} ${name}${blocked}\n  argumentos: ${args}\n  retorno real: ${result}`;
    });

  const errorsBlock = trim(log.errors, 800);

  const toolBlock = [
    "=== FERRAMENTAS EXECUTADAS (retorno real da API) ===",
    ...(toolLines.length ? toolLines : ["(nenhuma)"]),
    "",
    "=== ERROS REGISTRADOS NO ATENDIMENTO ===",
    errorsBlock && errorsBlock !== "null" ? errorsBlock : "(nenhum)",
  ].join("\n");

  const timeBlock = buildTimeReference(toolBlock, log.created_at);

  return {
    dossier: `${conversationBlock}\n\n${toolBlock}\n\n${timeBlock}\n\nAudite este atendimento seguindo suas regras.`,
    conversationText: conversationBlock,
    toolText: toolBlock,
    timeReference: timeBlock,
  };
}


// Normaliza para comparar citação x texto original sem depender de acento,
// caixa, pontuação ou espaçamento.
export function normalizeForProof(text: string): string {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// ============================================================================
// REFERÊNCIA DE TEMPO — a auditora não pode deduzir fuso nem dia da semana.
// Toda data/hora encontrada no retorno das ferramentas é convertida para o
// horário local (America/Sao_Paulo) com o dia da semana já calculado.
// ============================================================================
const SP_TZ = "America/Sao_Paulo";
const WEEKDAY_WORDS = ["domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"];

function spParts(d: Date): { date: string; time: string; weekday: string } | null {
  if (Number.isNaN(d.getTime())) return null;
  const fmt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: SP_TZ,
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  return {
    date: `${parts.day}/${parts.month}/${parts.year}`,
    time: `${parts.hour}:${parts.minute}`,
    weekday: String(parts.weekday ?? "").replace(/-feira$/, ""),
  };
}

// Aceita ISO com ou sem hora e formato brasileiro dd/mm/aaaa[ hh:mm].
const ISO_RE = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?/g;
const BR_RE = /\b\d{2}\/\d{2}\/\d{4}(?: \d{2}:\d{2})?\b/g;

function spDateOnly(d: Date): string {
  const fmt = new Intl.DateTimeFormat("pt-BR", { timeZone: SP_TZ, day: "2-digit", month: "2-digit", year: "numeric" });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function spWeekdayLong(d: Date): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: SP_TZ, weekday: "long" }).format(d);
}

// Converte data ISO (com ou sem hora) para referência local. Sem hora, só a data importa.
function describeIso(raw: string): string | null {
  const hasTime = /[T ]\d{2}:\d{2}/.test(raw);
  const hasZone = /(?:Z|[+-]\d{2}:\d{2})$/.test(raw);
  const normalized = raw.replace(" ", "T");
  const d = new Date(hasTime ? (hasZone ? normalized : `${normalized}-03:00`) : `${normalized}T12:00:00-03:00`);
  const p = spParts(d);
  if (!p) return null;
  return hasTime ? `${raw} = ${p.weekday}, ${p.date} ${p.time} (horário local de Brasília)` : `${raw} = ${p.weekday}, ${p.date}`;
}

// Data brasileira já é horário local: não converter fuso (evita dupla conversão).
function describeBr(raw: string): string | null {
  const m = raw.match(/(\d{2})\/(\d{2})\/(\d{4})(?: (\d{2}):(\d{2}))?/);
  if (!m) return null;
  const d = new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4] ?? "12"}:${m[5] ?? "00"}:00-03:00`);
  const p = spParts(d);
  if (!p) return null;
  return m[4] ? `${raw} = ${p.weekday}, ${p.date} ${p.time} (já é horário local)` : `${raw} = ${p.weekday}, ${p.date}`;
}

// Calendário ancorado na data DO TURNO (nunca na data em que a auditoria roda).
function calendarBlock(turnAt?: string): string[] {
  if (!turnAt) return [];
  const base = new Date(turnAt);
  if (Number.isNaN(base.getTime())) return [];
  const baseDate = spDateOnly(base); // YYYY-MM-DD em Brasília
  const [y, m, d] = baseDate.split("-").map(Number);
  const day0 = Date.UTC(y, m - 1, d, 12);
  const iso = (offset: number) => spDateOnly(new Date(day0 + offset * 86400000));
  const wd = (offset: number) => spWeekdayLong(new Date(day0 + offset * 86400000));
  const days: string[] = [];
  for (let i = 0; i < 14; i++) {
    const tag = i === 0 ? " (HOJE)" : i === 1 ? " (AMANHÃ)" : "";
    days.push(`${wd(i)} = ${iso(i)}${tag}`);
  }
  return [
    `hoje = ${iso(0)} (${wd(0)}); amanhã = ${iso(1)} (${wd(1)}); ontem = ${iso(-1)} (${wd(-1)})`,
    `Calendário dos próximos 14 dias: ${days.join(" · ")}`,
  ];
}

export function buildTimeReference(toolText: string, turnAt?: string): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const raw of toolText.match(ISO_RE) ?? []) {
    if (seen.has(raw) || seen.size >= 25) continue;
    seen.add(raw);
    const desc = describeIso(raw);
    if (desc) lines.push(desc);
  }
  for (const raw of toolText.match(BR_RE) ?? []) {
    if (seen.has(raw) || seen.size >= 50) continue;
    seen.add(raw);
    const desc = describeBr(raw);
    if (desc) lines.push(desc);
  }
  const now = turnAt ? spParts(new Date(turnAt)) : null;
  return [
    "=== REFERÊNCIA DE TEMPO (já convertida — use SOMENTE estes valores) ===",
    now ? `Momento do atendimento: ${now.weekday}, ${now.date} ${now.time}` : "",
    ...calendarBlock(turnAt),
    ...(lines.length ? lines : ["(nenhuma data/hora no retorno das ferramentas)"]),
    "A IA de atendimento fala em linguagem natural ('amanhã', 'na terça', 'quinta às 15h'). Converta para a data ISO usando o calendário acima ANTES de apontar divergência. Referência relativa correta NÃO é erro.",
    "Datas com Z ou +00:00 estão em UTC: o horário local é 3 horas menor. Diferença de fuso NÃO é divergência.",
    "Nunca calcule dia da semana por conta própria — use o que está acima.",
  ]
    .filter(Boolean)
    .join("\n");
}

function weekdayKey(text: string): string {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

// Horários citados, normalizados para HH:MM ("13h10", "13h", "9h", "13:10").
function extractTimes(text: string): string[] {
  const out = new Set<string>();
  const src = String(text ?? "");
  for (const m of src.matchAll(/\b(\d{1,2})\s*[:h]\s*(\d{2})\b/g)) {
    out.add(`${m[1].padStart(2, "0")}:${m[2]}`);
  }
  for (const m of src.matchAll(/\b(\d{1,2})\s*h(?!\d)/g)) {
    out.add(`${m[1].padStart(2, "0")}:00`);
  }
  return [...out];
}

// Severidade determinística por tipo de impacto — sem julgamento do modelo.
export const SEVERITY_BY_CATEGORY: Record<string, "baixa" | "media" | "alta"> = {
  completude_agendamento: "alta",
  cancelamento_remarcacao: "alta",
  erro_tecnico_mascarado: "alta",
  disponibilidade_inventada: "media",
  dados_incorretos_api: "media",
  uso_indevido_ferramenta: "media",
  comunicacao: "media",
  duplicidade_agendamento: "alta",
  violacao_silent_mode: "media",
  acao_afirmada_nao_executada: "alta",
  profissional_inventado: "media",
};

// Ferramentas que de fato executam ação (criam/alteram algo na agenda).
export const ACTION_TOOLS = new Set([
  "criar_agendamento", "agendar",
  "cancelar_agendamento", "desmarcar_agendamento",
  "editar_agendamento", "remarcar_agendamento",
]);

// ============================================================================
// TRIAGEM DETERMINÍSTICA — roda em TODOS os turnos, sem gastar token.
// Decide quem precisa de LLM e quem pode ser resolvido em código.
// ============================================================================

// Resposta afirmando que uma ação foi concluída (escrita ou confirmação).
const CLAIM_RE = /\b(confirmad[oa]s?|agendad[oa]s?|reservad[oa]s?|reservei|marquei|marcad[oa]s?|cancelei|cancelad[oa]s?|remarquei|remarcad[oa]s?|registrei|atualizei|prontinho)\b/i;

export function claimsCompletedAction(aiResponse: string | null | undefined): boolean {
  return CLAIM_RE.test(String(aiResponse ?? ""));
}

// Guard com acao "detected_*" é sinal de risco: o turno NUNCA pode ser pulado.
export function hasDetectedGuardSignal(toolCalls: any[]): boolean {
  return (toolCalls ?? []).some((tc) =>
    String(tc?.result?.acao ?? "").startsWith("detected_")
  );
}

// escalar_humano em modo silencioso proíbe qualquer mensagem ao cliente.
// Resposta não-vazia no mesmo turno = violação objetiva, provada em código.
export function silentModeViolation(
  toolCalls: any[],
  aiResponse: string | null | undefined,
): { violated: boolean; evidence: string } {
  const silentCall = (toolCalls ?? []).find((tc) => tc?.result?.silent_mode === true);
  const response = String(aiResponse ?? "").trim();
  if (!silentCall || !response) return { violated: false, evidence: "" };
  const evidence = `${String(silentCall?.name ?? "escalar_humano")} → ${JSON.stringify(silentCall.result)}`;
  return { violated: true, evidence: evidence.slice(0, 2000) };
}

// Turno exige auditoria por LLM mesmo sem ferramenta "relevante":
// afirmou ação concluída ou algum guard detectou algo.
export function needsLlmAudit(toolCalls: any[], aiResponse: string | null | undefined): boolean {
  return hasRelevantTool(toolCalls) || hasDetectedGuardSignal(toolCalls) || claimsCompletedAction(aiResponse);
}


const MIN_PROOF_CHARS = 12;

const NO_DIVERGENCE_SUMMARY_PATTERNS = [
  /\bsem diverg[eê]ncia\b/i,
  /\bsem inconsist[eê]ncia\b/i,
  /\bn[ãa]o hou?ve (?:diverg[eê]ncia|inconsist[eê]ncia|erro|falha|problema)\b/i,
  /\bn[ãa]o h[áa] (?:diverg[eê]ncia|inconsist[eê]ncia|erro|falha|problema)\b/i,
  /\bde forma compat[ií]vel\b/i,
  /\b(?:coerente|consistente|compat[ií]vel)\s+com\s+(?:o\s+)?(?:retorno|dado|hor[áa]rio|resultado)/i,
  /\b(?:resposta|confirma[cç][aã]o).{0,80}\bcompat[ií]vel com (?:o )?retorno\b/i,
  /\b(?:as tr[eê]s coisas|pedido.{0,30}resposta.{0,30}(?:ferramenta|retorno)).{0,80}\b(?:batem|coincidem|correspondem|conferem)\b/i,
  /\b(?:conferem|batem|coincidem|correspondem)\s+(?:com|entre)\b.{0,60}\b(?:retorno|api|ferramenta)\b/i,
];

function summaryExplicitlySaysThereIsNoDivergence(summary: string): boolean {
  return NO_DIVERGENCE_SUMMARY_PATTERNS.some((pattern) => pattern.test(summary));
}


function quoteAppears(quote: string, haystack: string): boolean {
  const q = normalizeForProof(quote);
  if (q.length < MIN_PROOF_CHARS) return false;
  const h = normalizeForProof(haystack);
  if (h.includes(q)) return true;
  // Citação longa pode ter sido remontada; exige que a maior parte dos
  // trechos contíguos apareça no original, nunca palavras isoladas.
  const chunks = q.split(" ");
  if (chunks.length < 6) return false;
  const windows: string[] = [];
  for (let i = 0; i + 4 <= chunks.length; i += 4) windows.push(chunks.slice(i, i + 4).join(" "));
  if (!windows.length) return false;
  const hits = windows.filter((w) => h.includes(w)).length;
  return hits / windows.length >= 0.8;
}

// ============================================================================
// DEDUPE DE ACHADOS — o mesmo problema não pode ser reportado duas vezes só
// porque a conversa seguiu em outros turnos. A assinatura é determinística:
// categoria + identificadores reais da API (agendamento/comanda) quando houver,
// senão categoria + trecho da conversa citado.
// ============================================================================
function extractApiIds(toolEvidence: string, summary: string): string[] {
  const source = `${toolEvidence}\n${summary}`;
  const ids = new Set<string>();
  const patterns = [
    /"?(?:appointment_id|scheduling_code|invoice_code|confirmation_link_code)"?\s*[:=]\s*"?(\d{4,})/gi,
    /\b(\d{8,})\b/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) ids.add(m[1]);
  }
  return [...ids].sort();
}

export function findingSignature(finding: {
  category?: string;
  summary?: string;
  evidence_tool?: string;
  evidence_conversation?: string;
}): string {
  const category = String(finding.category ?? "");
  const ids = extractApiIds(String(finding.evidence_tool ?? ""), String(finding.summary ?? ""));
  if (ids.length) return `${category}|ids:${ids.join(",")}`;
  const conv = normalizeForProof(String(finding.evidence_conversation ?? "")).slice(0, 160);
  return `${category}|conv:${conv}`;
}

// Datas distintas presentes nos dados das ferramentas. Só é seguro absolver
// por igualdade de horário quando há UMA data em jogo — com várias, o mesmo
// horário em dia diferente seria absorvido por engano.
function distinctDatesInToolText(toolText: string): Set<string> {
  const dates = new Set<string>();
  for (const raw of toolText.match(/\d{4}-\d{2}-\d{2}/g) ?? []) dates.add(raw);
  for (const raw of toolText.match(/\b\d{2}\/\d{2}\/\d{4}\b/g) ?? []) {
    const m = raw.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (m) dates.add(`${m[3]}-${m[2]}-${m[1]}`);
  }
  return dates;
}

// Achado sobre fuso horário: se o horário citado na conversa é exatamente o
// horário local já convertido do retorno da API, não existe divergência.
// Só absolve quando o retorno trata de UMA única data.
function timesAllBackedByApi(finding: any, toolText: string, timeReference: string): boolean {
  const summary = String(finding.summary ?? "");
  // Alegação de negativa ("disse que não tem vaga") não é validada por igualdade
  // de horários — ali o problema é justamente o que a IA negou.
  if (/\bn[ãa]o (?:tem|h[áa]|havia|tinha)\b|\bnegou\b|\bsem vaga\b|\bindispon[íi]vel\b|\besgotad/i.test(summary)) return false;
  if (distinctDatesInToolText(toolText).size !== 1) return false;
  const cited = extractTimes(`${finding.evidence_conversation ?? ""} ${summary}`);
  if (!cited.length) return false;
  const haystack = `${toolText}\n${timeReference}`;
  const available = new Set(extractTimes(haystack));
  return cited.every((t) => available.has(t));
}

// Dia da semana: a auditora não sabe calcular. Se o dia citado é o mesmo que a
// referência de tempo traz para alguma data do retorno, não há divergência.
function weekdayMatchesReference(finding: any, timeReference: string): boolean {
  const claim = weekdayKey(`${finding.summary ?? ""} ${finding.evidence_conversation ?? ""}`);
  const citedWeekday = WEEKDAY_WORDS.find((w) => claim.includes(w));
  if (!citedWeekday) return false;
  if (!/\b(?:dia da semana|dia errado|data errada|divergente)\b/i.test(String(finding.summary ?? ""))) return false;
  return weekdayKey(timeReference).includes(citedWeekday);
}

// Turno ainda em andamento: nenhuma ação foi executada e a IA terminou
// perguntando algo ao cliente. Falta dado que só o cliente pode dar.
function turnStillWaitingOnClient(context?: AuditContext): boolean {
  if (!context) return false;
  const executedAction = (context.toolCalls ?? []).some((tc) => ACTION_TOOLS.has(String(tc?.name ?? "")));
  if (executedAction) return false;
  const response = String(context.aiResponse ?? "").trim();
  if (!response) return false;
  return /\?\s*$/.test(response) || /\?["')\]]*\s*$/.test(response);
}

export type AuditContext = {
  aiResponse?: string | null;
  toolCalls?: any[];
  timeReference?: string;
};

// Retorna null quando o achado é aceito, ou o motivo enumerado do descarte.
// O motivo é persistido junto ao achado descartado para permitir calibração.
export function validateFinding(
  finding: any,
  conversationText: string,
  toolText: string,
  context?: AuditContext,
): string | null {

  if (!finding || typeof finding !== "object") return "nao_e_objeto";
  if (!AUDIT_CATEGORIES.includes(finding.category)) return "categoria_invalida";
  if (typeof finding.summary !== "string" || finding.summary.trim().length < 8) return "resumo_curto";
  // Um achado não pode afirmar, no próprio resumo, que o atendimento foi
  // compatível ou não teve divergência. Isso é uma contradição do classificador,
  // não um problema real do atendimento.
  if (summaryExplicitlySaysThereIsNoDivergence(finding.summary)) return "resumo_contraditorio";
  const conv = typeof finding.evidence_conversation === "string" ? finding.evidence_conversation : "";
  const tool = typeof finding.evidence_tool === "string" ? finding.evidence_tool : "";
  if (!quoteAppears(conv, conversationText)) return "evidencia_conversa_ausente";
  // "Disse e não fez" prova-se pela AUSÊNCIA de execução: quando nenhuma
  // ferramenta de escrita rodou, não existe trecho de ferramenta para citar —
  // a evidência aceita é a indicação literal de que o bloco está vazio.
  const toolEvidenceRequired = finding.category !== "acao_afirmada_nao_executada";
  if (toolEvidenceRequired && !quoteAppears(tool, toolText)) return "evidencia_ferramenta_ausente";
  if (!toolEvidenceRequired && !quoteAppears(tool, toolText) && !/\(nenhuma\)|detected_/i.test(toolText + " " + tool)) {
    return "evidencia_ferramenta_ausente";
  }

  const timeReference = context?.timeReference ?? "";
  // Fuso horário / formatação de hora idêntica ao retorno real.
  if (
    (finding.category === "dados_incorretos_api" || finding.category === "disponibilidade_inventada") &&
    timesAllBackedByApi(finding, toolText, timeReference)
  ) return "equivalencia_temporal";
  // Dia da semana já calculado na referência de tempo.
  if (weekdayMatchesReference(finding, timeReference)) return "dia_semana_confere";
  // Fluxo aguardando escolha do cliente não é atendimento incompleto.
  if (
    (finding.category === "completude_agendamento" || finding.category === "cancelamento_remarcacao") &&
    turnStillWaitingOnClient(context)
  ) return "aguardando_cliente";

  return null;
}
