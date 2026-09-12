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

  return {
    dossier: `${conversationBlock}\n\n${toolBlock}\n\nAudite este atendimento seguindo suas regras.`,
    conversationText: conversationBlock,
    toolText: toolBlock,
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

const MIN_PROOF_CHARS = 12;

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
