export type AppBarberIntentItem = {
  personName: string | null;
  serviceName: string | null;
  serviceCode: number | null;
  date: string | null;
  time: string | null;
  professionalName: string | null;
  professionalCode: number | null;
};

export type AppBarberIntentSnapshot = {
  expectedCount: number;
  distinctPeople: number;
  distinctTimes: number;
  distinctProfessionals: number;
  items: AppBarberIntentItem[];
  ambiguous: boolean;
  source: "llm" | "fallback";
  updatedAt: string;
};

export type AppBarberExecution = AppBarberIntentItem & {
  key: string;
  appointmentId: string;
};

export type AppBarberReconciliation = {
  expectedCount: number;
  completedCount: number;
  pendingCount: number;
  uncertainCount: number;
  duplicateExecutionKeys: string[];
  completed: AppBarberExecution[];
};

export type AppBarberGuardDecision = {
  guard: string;
  priority: number;
  action: "allow" | "block" | "recover" | "ask";
  reason: string;
};

export type AppBarberSlotSelection = {
  serviceCode: number;
  professionalCode: number;
  date: string;
  time: string;
};

const cleanText = (value: unknown): string => String(value ?? "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/\s+/g, " ")
  .trim();

const SERVICE_STOP_WORDS = new Set(["de", "da", "do", "das", "dos", "a", "o", "e", "com", "para", "club", "cinco", "9cinco"]);

const serviceMentionTokens = (value: unknown): string[] => {
  const synonyms: Record<string, string[]> = {
    cabelo: ["corte", "cortar", "cortinho", "maquina"],
    barba: ["barbear", "barbinha"],
    sobrancelha: ["sobrancelhas", "design"],
    hidratacao: ["hidratar"],
  };
  const base = cleanText(value).replace(/^\d+\s*/, "").split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !SERVICE_STOP_WORDS.has(word));
  const tokens = new Set(base);
  for (const word of base) for (const synonym of synonyms[word] || []) tokens.add(synonym);
  return [...tokens];
};

/**
 * AppBarber: decide se o pedido ATUAL contém a parte ainda não coberta de um
 * serviço candidato. Evita que slots antigos transformem "corte" em
 * "corte + combo + barba", mas preserva "corte e sobrancelha".
 */
export function appBarberCurrentRequestMentionsPendingService(
  currentRequest: unknown,
  bookedServiceNames: string[],
  candidateServiceName: unknown,
): boolean {
  const request = cleanText(currentRequest);
  if (!request) return false;
  const bookedTokens = new Set(bookedServiceNames.flatMap(serviceMentionTokens));
  const uncoveredTokens = serviceMentionTokens(candidateServiceName)
    .filter((token) => !bookedTokens.has(token));
  return uncoveredTokens.length > 0
    && uncoveredTokens.some((token) => new RegExp(`\\b${token}\\b`, "i").test(request));
}

const positiveInt = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const nullableText = (value: unknown, maxLength = 120): string | null => {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, maxLength) : null;
};

/**
 * Detecta afirmação de reserva concluída;
 * (05/10, caso 9Cinco 5544999295422) inclui o serviço como sujeito: "Seu cabelo
 * e barba ficam confirmados pra sexta" não era reconhecido, só "seu horário".
 * a legitimidade é validada pelo orquestrador. */
export function appBarberClaimsCompletedBooking(value: unknown): boolean {
  const text = String(value ?? "").trim();
  if (!text) return false;
  const completedClaim = /\b(?:(?:j[aá]\s+)?(?:agendei|reservei|marquei)|(?:j[aá]\s+)?deixei(?:\s+(?:seu|o))?\s+(?:hor[aá]rio\s+)?(?:agendad[oa]|reservad[oa]|marcad[oa]|confirmad[oa])|acabe[io]\s+de\s+(?:agendar|reservar|marcar)|criei\s+(?:o\s+)?(?:seu\s+)?agendamento|criei\s+(?:a\s+)?(?:sua\s+)?reserva|marcamos\s+(?:seu|o)\s+hor[aá]rio|(?:(?:seu|o)\s+(?:hor[aá]rio|agendamento)|(?:sua|a)\s+reserva)[^.!?]{0,80}\b(?:est[aá]|ficou|foi)\s+(?:agendad[oa]|confirmad[oa]|marcad[oa]|reservad[oa])|(?:seu|sua|seus|suas)\s+[^.!?,]{0,40}?\b(?:ficam?|ficou|ficaram|est[aá]|est[aã]o|foi|foram)\s+(?:agendad|confirmad|marcad|reservad)[oa]s?|(?:agendamento|reserva|hor[aá]rio)\s+(?:agendad[oa]|confirmad[oa]|marcad[oa]|reservad[oa])|^\s*(?:agendad[oa]|confirmad[oa]|reservad[oa]|remarcad[oa]))\b/i;
  const negated = /\bn[ãa]o\s+(?:foi\s+|est[áa]\s+|ficou\s+|consegui\s+)?(?:agend|reserv|marc|confirm)/i;
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .some((sentence) => !sentence.endsWith("?") && completedClaim.test(sentence) && !negated.test(sentence));
}

/** Resolve uma escolha curta somente quando ela identifica um único slot já oferecido. */
export function resolveAppBarberSlotSelection(
  currentRequest: unknown,
  previousAssistantMessage: unknown,
  slots: Array<{
    service_code?: unknown;
    professional_code?: unknown;
    professional_name?: unknown;
    start_date?: unknown;
    start_time?: unknown;
  }> | null | undefined,
): AppBarberSlotSelection | null {
  const request = cleanText(currentRequest);
  const previous = cleanText(previousAssistantMessage);
  if (!request || !previous || !Array.isArray(slots) || slots.length === 0) return null;

  const timeMatch = request.match(/\b([01]?\d|2[0-3])\s*(?::|h)\s*([0-5]\d)\b/);
  if (!timeMatch) return null;
  const time = `${timeMatch[1].padStart(2, "0")}:${timeMatch[2]}`;
  const requestTokens = request.split(/[^a-z0-9]+/).filter((token) => token.length >= 3);
  const previousMentionsTime = previous.includes(time)
    || previous.includes(time.replace(":", "h"))
    || (time.endsWith(":00") && new RegExp(`\\b${Number(time.slice(0, 2))}h\\b`).test(previous));
  if (!previousMentionsTime) return null;

  const matches = slots.filter((slot) => {
    const professionalWords = cleanText(slot.professional_name).split(" ").filter(Boolean);
    const professionalMentioned = requestTokens.some((token) => professionalWords.includes(token));
    return String(slot.start_time ?? "").slice(0, 5) === time && professionalMentioned;
  });

  const unique = new Map<string, AppBarberSlotSelection>();
  for (const slot of matches) {
    const serviceCode = positiveInt(slot.service_code);
    const professionalCode = positiveInt(slot.professional_code);
    const date = nullableText(slot.start_date, 10);
    if (!serviceCode || !professionalCode || !date) continue;
    const selection = { serviceCode, professionalCode, date, time };
    unique.set(`${serviceCode}|${professionalCode}|${date}|${time}`, selection);
  }
  return unique.size === 1 ? [...unique.values()][0] : null;
}

export function normalizeAppBarberIntentItems(value: unknown): AppBarberIntentItem[] {
  if (!Array.isArray(value)) return [];
  const items: AppBarberIntentItem[] = [];
  const seen = new Set<string>();
  for (const raw of value.slice(0, 10)) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const item: AppBarberIntentItem = {
      personName: nullableText(row.person_name ?? row.personName),
      serviceName: nullableText(row.service_name ?? row.serviceName),
      serviceCode: positiveInt(row.service_code ?? row.serviceCode),
      date: nullableText(row.date, 10),
      time: nullableText(row.time, 5),
      professionalName: nullableText(row.professional_name ?? row.professionalName),
      professionalCode: positiveInt(row.professional_code ?? row.professionalCode),
    };
    const key = [
      cleanText(item.personName), item.serviceCode ?? cleanText(item.serviceName),
      item.date ?? "", item.time ?? "", item.professionalCode ?? cleanText(item.professionalName),
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return items;
}

export function buildAppBarberIntentSnapshot(
  raw: Record<string, unknown>,
  source: "llm" | "fallback",
  now = new Date(),
): AppBarberIntentSnapshot {
  const items = normalizeAppBarberIntentItems(raw.requested_items);
  const dimension = (value: unknown): number => Math.min(10, positiveInt(value) ?? 1);
  const distinctPeople = dimension(raw.distinct_people);
  const distinctTimes = dimension(raw.distinct_times);
  const distinctProfessionals = dimension(raw.distinct_professionals);
  const declared = dimension(raw.total_bookings_requested);
  return {
    expectedCount: Math.max(declared, distinctPeople, distinctTimes, distinctProfessionals, items.length || 1),
    distinctPeople,
    distinctTimes,
    distinctProfessionals,
    items,
    ambiguous: raw.ambiguous === true,
    source,
    updatedAt: now.toISOString(),
  };
}

export function appBarberExecutionKey(args: Record<string, unknown>): string {
  const services = Array.isArray(args.services)
    ? args.services.map((service) => positiveInt((service as Record<string, unknown>)?.service_code)).filter(Boolean)
    : [];
  const service = positiveInt(args.service_code) ?? services[0] ?? "";
  return [
    cleanText(args.customer_name), service, nullableText(args.start_date, 10) ?? "",
    nullableText(args.start_time, 5) ?? "", positiveInt(args.professional_code) ?? "",
  ].join("|");
}

export function reconcileAppBarberBookings(
  snapshot: AppBarberIntentSnapshot | null | undefined,
  toolCalls: Array<{ name?: string; args?: Record<string, unknown>; result?: Record<string, unknown>; blocked?: boolean }>,
): AppBarberReconciliation {
  const completed: AppBarberExecution[] = [];
  const seen = new Set<string>();
  const duplicateExecutionKeys: string[] = [];
  let uncertainCount = 0;
  for (const call of toolCalls || []) {
    if (call?.name !== "criar_agendamento" || call.blocked) continue;
    const result = call.result || {};
    const appointmentId = result.appointment_id ?? result.scheduling_code ?? result.id;
    if (result.result_uncertain === true) {
      uncertainCount++;
      continue;
    }
    if (result.ok !== true || !appointmentId) continue;
    const args = call.args || {};
    const key = appBarberExecutionKey(args);
    if (seen.has(key)) {
      duplicateExecutionKeys.push(key);
      continue;
    }
    seen.add(key);
    completed.push({
      key,
      appointmentId: String(appointmentId),
      personName: nullableText(args.customer_name),
      serviceName: nullableText(result.service_name),
      serviceCode: positiveInt(args.service_code ?? result.service_code),
      date: nullableText(args.start_date, 10),
      time: nullableText(args.start_time, 5),
      professionalName: nullableText(result.professional_name),
      professionalCode: positiveInt(args.professional_code ?? result.professional_code),
    });
  }
  const expectedCount = Math.max(1, snapshot?.expectedCount ?? completed.length ?? 1);
  return {
    expectedCount,
    completedCount: completed.length,
    pendingCount: Math.max(0, expectedCount - completed.length),
    uncertainCount,
    duplicateExecutionKeys,
    completed,
  };
}

export function arbitrateAppBarberGuardDecisions(decisions: AppBarberGuardDecision[]): AppBarberGuardDecision {
  const actionable = decisions.filter((decision) => decision.action !== "allow");
  if (actionable.length === 0) {
    return { guard: "arbiter", priority: 0, action: "allow", reason: "no_guard_blocked" };
  }
  return [...actionable].sort((a, b) => b.priority - a.priority || a.guard.localeCompare(b.guard))[0];
}

export function appBarberNamesConflict(a: unknown, b: unknown): boolean {
  const left = cleanText(a).split(" ").filter(Boolean);
  const right = cleanText(b).split(" ").filter(Boolean);
  if (left.length < 2 || right.length < 2 || left[0] !== right[0]) return false;
  return left.slice(1).join(" ") !== right.slice(1).join(" ");
}