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
      const result = trim(tc?.result, 1400);
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

const ISO_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/g;

export function buildTimeReference(toolText: string, turnAt?: string): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const raw of toolText.match(ISO_RE) ?? []) {
    if (seen.has(raw) || seen.size >= 25) continue;
    seen.add(raw);
    const hasZone = /(?:Z|[+-]\d{2}:\d{2})$/.test(raw);
    const p = spParts(new Date(hasZone ? raw.replace(" ", "T") : `${raw.replace(" ", "T")}-03:00`));
    if (!p) continue;
    lines.push(`${raw} = ${p.weekday}, ${p.date} ${p.time} (horário local de Brasília)`);
  }
  const now = turnAt ? spParts(new Date(turnAt)) : null;
  return [
    "=== REFERÊNCIA DE TEMPO (já convertida — use SOMENTE estes valores) ===",
    now ? `Momento do atendimento: ${now.weekday}, ${now.date} ${now.time}` : "",
    ...(lines.length ? lines : ["(nenhuma data/hora ISO no retorno das ferramentas)"]),
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
};

// Ferramentas que de fato executam ação (criam/alteram algo na agenda).
const ACTION_TOOLS = new Set([
  "criar_agendamento", "agendar",
  "cancelar_agendamento", "desmarcar_agendamento",
  "editar_agendamento", "remarcar_agendamento",
]);


const NO_DIVERGENCE_SUMMARY_PATTERNS = [
  /\bsem diverg[eê]ncia\b/i,
  /\bsem inconsist[eê]ncia\b/i,
  /\bde forma compat[ií]vel\b/i,
  /\b(?:resposta|confirma[cç][aã]o).{0,80}\bcompat[ií]vel com (?:o )?retorno\b/i,
  /\b(?:as tr[eê]s coisas|pedido.{0,30}resposta.{0,30}(?:ferramenta|retorno)).{0,80}\b(?:batem|coincidem)\b/i,
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

export function validateFinding(
  finding: any,
  conversationText: string,
  toolText: string,
): boolean {
  if (!finding || typeof finding !== "object") return false;
  if (!AUDIT_CATEGORIES.includes(finding.category)) return false;
  if (typeof finding.summary !== "string" || finding.summary.trim().length < 8) return false;
  // Um achado não pode afirmar, no próprio resumo, que o atendimento foi
  // compatível ou não teve divergência. Isso é uma contradição do classificador,
  // não um problema real do atendimento.
  if (summaryExplicitlySaysThereIsNoDivergence(finding.summary)) return false;
  const conv = typeof finding.evidence_conversation === "string" ? finding.evidence_conversation : "";
  const tool = typeof finding.evidence_tool === "string" ? finding.evidence_tool : "";
  if (!quoteAppears(conv, conversationText)) return false;
  if (!quoteAppears(tool, toolText)) return false;
  return true;
}
