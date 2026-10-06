// Filtros PUROS do MultiBookingGuard do AppBarber (sem imports, testáveis).
//
// Contexto (caso real 05/10, 9Cinco: Ryan 554497172144 e Kaue 554499296763):
// o cliente pediu só "cabelo", o cabelo foi agendado certo, mas o guard achou
// que eram 2 e 3 serviços e mandou "tive um probleminha, vou acionar a equipe".
// Duas causas, uma função pra cada:
//
//  A) O filtro barato (appbarberIsClearlySingleBooking) procurava sinais de
//     "vários serviços" (ex: /\bos dois\b/) na conversa INTEIRA, inclusive nas
//     falas da própria IA. A Carol tinha perguntado "cabelo, barba ou os dois?"
//     e isso disparou o sinal. -> appBarberClientOnlyText
//
//  B) O classificador recebe as últimas 30 mensagens sem filtro de data e
//     contou agendamentos de semanas atrás como pendentes (Kaue: 10/09 e
//     26/09; Ryan: 02/10). Data anterior a hoje nunca pode estar pendente.
//     -> dropPastAppBarberIntentItems

export type IntentHistoryMessage = { role?: string; content?: unknown };

/**
 * Texto onde o filtro barato procura sinais textuais de múltiplos serviços.
 *
 * Regra (decisão do dono, 05/10): o guard escuta SÓ o que o CLIENTE escreveu.
 * Fala da IA nunca é pedido do cliente, então não entra, nem quando a resposta
 * atual é curta ("sim", "pode"). Quando o cliente quer vários agendamentos ele
 * diz isso explicitamente em alguma mensagem dele.
 */
export function appBarberClientOnlyText(messages: IntentHistoryMessage[]): string {
  return (messages || [])
    .filter((m) => m?.role === "user" && typeof m?.content === "string" && m.content.trim())
    .map((m) => String(m.content))
    .join("\n");
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isPastIsoDate(value: unknown, todayIso: string): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim().slice(0, 10);
  return ISO_DATE_RE.test(v) && v < todayIso;
}

/**
 * Reduz uma contagem que incluía itens já passados, sem nunca ir abaixo do
 * que sobrou de evidência. Se a contagem já cabe no que sobrou, não mexe
 * (ex: o classificador já tinha excluído os antigos do total).
 */
export function adjustCountForDroppedPast(count: number, removed: number, remainingItems: number): number {
  if (!Number.isFinite(count) || removed <= 0) return count;
  if (count <= remainingItems) return count;
  return Math.max(1, remainingItems, count - removed);
}

/**
 * Tira da saída do classificador os itens com data anterior a hoje (YYYY-MM-DD,
 * fuso do negócio) e ajusta total/dimensões. Se não há item no passado,
 * devolve o MESMO objeto, sem alteração nenhuma.
 */
export function dropPastAppBarberIntentItems(
  raw: Record<string, unknown>,
  todayIso: string,
): { cleaned: Record<string, unknown>; removed: number; remaining: number } {
  const items = Array.isArray(raw?.requested_items) ? (raw.requested_items as unknown[]) : [];
  const isPast = (it: unknown) =>
    !!it && typeof it === "object" && isPastIsoDate((it as Record<string, unknown>).date, todayIso);
  const past = items.filter(isPast);
  if (past.length === 0) return { cleaned: raw, removed: 0, remaining: items.length };

  const remainingItems = items.filter((it) => !isPast(it));
  const removed = past.length;
  const remaining = remainingItems.length;
  const cleaned: Record<string, unknown> = { ...raw, requested_items: remainingItems };
  for (const field of [
    "total_bookings_requested",
    "distinct_people",
    "distinct_times",
    "distinct_professionals",
  ]) {
    const n = Number(raw[field]);
    if (Number.isFinite(n) && n >= 1) cleaned[field] = adjustCountForDroppedPast(n, removed, remaining);
  }
  return { cleaned, removed, remaining };
}
