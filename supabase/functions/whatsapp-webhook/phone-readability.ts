// Contatos que a UAZAPI entrega só pelo LID do WhatsApp (identificador interno de
// 14-15 dígitos) chegam ao webhook SEM telefone real. Bug real 19/10/2026
// (9Cinco, contato 32281125241048): a busca de agendamento por telefone rodou com o
// LID, voltou vazia e a IA afirmou "não encontrei nenhum agendamento", quando na
// verdade a busca nunca teve como achar nada.
//
// Telefone brasileiro tem no máximo 13 dígitos (55 + DDD + 9 dígitos). Um
// identificador só de dígitos com 14+ dígitos não é telefone utilizável.
// Identificadores não numéricos (ex.: "SIM:<id>" do simulador, ids do web chat)
// NÃO são tocados por esta regra.
export function isUnreadableCustomerPhone(phone: unknown): boolean {
  const raw = String(phone ?? "").trim().replace(/@.*$/, "");
  if (!/^\d+$/.test(raw)) return false;
  return raw.length >= 14;
}

// Ferramentas que dependem do telefone do cliente para ENCONTRAR agendamentos.
export const PHONE_DEPENDENT_BOOKING_LOOKUP_TOOLS = new Set([
  "buscar_agendamento",
  "buscar_agendamentos",
  "buscar_agendamentos_dia",
  "listar_agendamentos",
]);

export const UNREADABLE_PHONE_INSTRUCTION_PT =
  "A busca NÃO foi executada: o número deste contato chegou ilegível (identificador interno do WhatsApp, não um telefone). " +
  "Isto NÃO significa que o cliente não tem agendamento — significa que não foi possível consultar. " +
  "NUNCA diga que não encontrou agendamento. Diga ao cliente, em uma frase simples, que não conseguiu consultar o agendamento agora porque houve uma falha na leitura do número dele, " +
  "e que vai chamar um atendente para ajudar. Em seguida chame a ferramenta de transferência para humano, informando no motivo que o número do cliente veio ilegível e a consulta de agenda não foi possível.";
