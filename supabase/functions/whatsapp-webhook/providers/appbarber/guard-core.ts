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