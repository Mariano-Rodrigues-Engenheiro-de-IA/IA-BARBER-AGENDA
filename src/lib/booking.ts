// Helpers para identificar agendamentos efetivamente criados e calcular faturamento
// a partir de tool_calls dos agent_logs. Cobre os 4 provedores:
//
//  - Trinks   ("criar_agendamento"): args.valor + args.servicoId
//  - OneBeleza ("agendar"):          args.servicoid → lookup em buscar_servicos
//  - Frizzar  ("agendar"):           result.total / result.agendamentos[].totalComanda
//  - Bemp     ("criar_agendamento"): args.service_id → lookup em listar_servicos

const BOOKING_TOOL_NAMES = new Set(["agendar", "criar_agendamento"]);
const SERVICE_LIST_TOOLS = new Set([
  "listar_servicos",
  "buscar_servicos",
  "listar_servicos_profissional",
  "catalogo_de_servicos",
]);

export function getBookingId(tc: any): string | null {
  if (!tc || tc.blocked) return null;
  if (!BOOKING_TOOL_NAMES.has(tc.name)) return null;
  const r = tc.result;
  if (!r || typeof r !== "object") return null;
  if (r.error) return null;
  if (r.deduplicated) return null;
  if (Array.isArray(r.Errors) && r.Errors.length > 0) return null;
  if (r.success === false) return null;

  // Frizzar
  if (r.agendamentoId != null) return String(r.agendamentoId);
  // Bemp: data é objeto { id, start, ... }
  if (r.data && typeof r.data === "object" && !Array.isArray(r.data)) {
    const did = (r.data as any).id ?? (r.data as any).agendamento_id ?? (r.data as any).appointment_id;
    if (did != null && typeof did !== "boolean") {
      const s = String(did).trim();
      if (s && s !== "true" && s !== "false") return s;
    }
  }
  // Trinks: data é o id numérico; id é boolean
  if (r.data != null && typeof r.data !== "boolean" && typeof r.data !== "object") return String(r.data);
  // OneBeleza / Bemp / outros
  const candidates = [r.id, r.agendamento_id, r.appointment_id];
  for (const c of candidates) {
    if (c == null) continue;
    if (typeof c === "boolean") continue;
    const s = String(c).trim();
    if (s && s !== "true" && s !== "false") return s;
  }
  return null;
}

/**
 * Constrói um mapa { serviceId(string) → preço } a partir de chamadas
 * listar_servicos / buscar_servicos no histórico de tool_calls.
 * Aceita os formatos dos 4 provedores.
 */
export function buildServicePriceMap(
  logs: Array<{ tool_calls: any }> | null | undefined,
): Map<string, number> {
  const map = new Map<string, number>();
  const visit = (item: any) => {
    if (!item || typeof item !== "object") return;
    // Trinks / Frizzar / Bemp: serviço plano
    const id =
      item.id ?? item.codigo ?? item.servicoId ?? item.servicosId ?? item.servico_id;
    const price =
      item.preco ?? item.price ?? item.valor ?? item.valorServico ?? item.value;
    if (id != null && typeof price === "number" && !isNaN(price)) {
      map.set(String(id), price);
    }
    // OneBeleza: grupo com servicos[] aninhado
    if (Array.isArray(item.servicos)) item.servicos.forEach(visit);
  };

  (logs ?? []).forEach((l) => {
    const tools = Array.isArray(l.tool_calls) ? l.tool_calls : [];
    tools.forEach((tc: any) => {
      if (!tc || !SERVICE_LIST_TOOLS.has(tc.name)) return;
      const r = tc.result;
      if (Array.isArray(r)) r.forEach(visit);
      else if (r && typeof r === "object") {
        if (Array.isArray(r.servicos)) r.servicos.forEach(visit);
        else if (Array.isArray(r.data)) r.data.forEach(visit);
        else visit(r);
      }
    });
  });
  return map;
}

/**
 * Retorna o valor (R$) de um booking. Tenta extrair direto da chamada e,
 * em fallback, busca no mapa de preços por serviço.
 * Retorna 0 quando não conseguir determinar.
 */
export function getBookingValue(tc: any, priceMap?: Map<string, number>): number {
  if (!getBookingId(tc)) return 0;
  const args = tc.args ?? {};
  const r = tc.result ?? {};

  // Frizzar: result.total ou agendamentos[].totalComanda
  if (typeof r.total === "number") return r.total;
  if (Array.isArray(r.agendamentos)) {
    const sum = r.agendamentos.reduce(
      (s: number, a: any) => s + (typeof a?.totalComanda === "number" ? a.totalComanda : 0),
      0,
    );
    if (sum > 0) return sum;
  }

  // Trinks: args.valor direto
  if (typeof args.valor === "number" && args.valor > 0) return args.valor;

  // Lookup por id no mapa de preços
  if (priceMap && priceMap.size > 0) {
    const candidates = [
      args.servicoId,
      args.servicoid,
      args.servico_id,
      args.service_id,
      args.serviceId,
    ];
    // Trinks/Frizzar podem mandar lista de servicos
    if (Array.isArray(args.servicos)) {
      let sum = 0;
      for (const s of args.servicos) {
        const sid = s?.codigo ?? s?.id ?? s?.servicoId;
        if (sid != null) sum += priceMap.get(String(sid)) ?? 0;
      }
      if (sum > 0) return sum;
    }
    for (const c of candidates) {
      if (c == null) continue;
      const p = priceMap.get(String(c));
      if (typeof p === "number") return p;
    }
  }

  return 0;
}

export function countBookings(logs: Array<{ tool_calls: any }> | null | undefined): number {
  const ids = new Set<string>();
  (logs ?? []).forEach((l) => {
    const tools = Array.isArray(l.tool_calls) ? l.tool_calls : [];
    tools.forEach((tc: any) => {
      const id = getBookingId(tc);
      if (id) ids.add(id);
    });
  });
  return ids.size;
}

/** Soma o faturamento de bookings deduplicados por id. */
export function sumBookingRevenue(
  logs: Array<{ tool_calls: any }> | null | undefined,
  priceMap?: Map<string, number>,
): { total: number; withPrice: number; withoutPrice: number } {
  const seen = new Map<string, number>(); // bookingId → valor
  (logs ?? []).forEach((l) => {
    const tools = Array.isArray(l.tool_calls) ? l.tool_calls : [];
    tools.forEach((tc: any) => {
      const id = getBookingId(tc);
      if (!id || seen.has(id)) return;
      seen.set(id, getBookingValue(tc, priceMap));
    });
  });
  let total = 0;
  let withPrice = 0;
  let withoutPrice = 0;
  seen.forEach((v) => {
    total += v;
    if (v > 0) withPrice++;
    else withoutPrice++;
  });
  return { total, withPrice, withoutPrice };
}

// ---------------------------------------------------------------------------
// Cancelamentos e remarcações
//
// Nomes de ferramenta por provedor:
//  - cancelamento: "cancelar_agendamento" (Trinks, Frizzar, Bemp, AppBarber)
//                  "desmarcar_agendamento" (OneBeleza)
//  - remarcação:   "editar_agendamento" (Trinks) / "reagendar" (OneBeleza)
// ---------------------------------------------------------------------------

const CANCEL_TOOL_NAMES = new Set(["cancelar_agendamento", "desmarcar_agendamento"]);
const RESCHEDULE_TOOL_NAMES = new Set(["editar_agendamento", "reagendar"]);

function isSuccessfulCall(tc: any): boolean {
  if (!tc || tc.blocked) return false;
  const r = tc.result;
  if (r == null) return false;
  if (typeof r === "object") {
    if (r.error) return false;
    if (r.deduplicated) return false;
    if (r.success === false) return false;
    if (Array.isArray(r.Errors) && r.Errors.length > 0) return false;
  }
  return true;
}

/** Chave estável de deduplicação para cancelamento/remarcação. */
function actionKey(tc: any, kind: string): string {
  const a = tc?.args ?? {};
  const id =
    a.agendamentoId ?? a.agendamento_id ?? a.appointment_id ?? a.appointmentId ??
    a.id ?? a.reservaId ?? a.codigo ?? null;
  return id != null ? `${kind}:${String(id)}` : `${kind}:${JSON.stringify(a)}`;
}

function collectActionIds(
  logs: Array<{ tool_calls: any }> | null | undefined,
  names: Set<string>,
  kind: string,
): Set<string> {
  const ids = new Set<string>();
  (logs ?? []).forEach((l) => {
    const tools = Array.isArray(l.tool_calls) ? l.tool_calls : [];
    tools.forEach((tc: any) => {
      if (!tc || !names.has(tc.name)) return;
      if (!isSuccessfulCall(tc)) return;
      ids.add(actionKey(tc, kind));
    });
  });
  return ids;
}

export function countCancellations(logs: Array<{ tool_calls: any }> | null | undefined): number {
  return collectActionIds(logs, CANCEL_TOOL_NAMES, "cancel").size;
}

export function countReschedules(logs: Array<{ tool_calls: any }> | null | undefined): number {
  return collectActionIds(logs, RESCHEDULE_TOOL_NAMES, "resched").size;
}

/** Série diária de cancelamentos e remarcações, deduplicada globalmente. */
export function buildCancelRescheduleDaily(
  logs: Array<{ tool_calls: any; created_at: string }> | null | undefined,
  bucketDates: string[],
): Array<{ date: string; cancelamentos: number; remarcacoes: number }> {
  const map: Record<string, { date: string; cancelamentos: number; remarcacoes: number }> = {};
  bucketDates.forEach((d) => { map[d] = { date: d.slice(5), cancelamentos: 0, remarcacoes: 0 }; });
  const seen = new Set<string>();
  (logs ?? []).forEach((l) => {
    const k = l.created_at?.slice(0, 10);
    if (!k || !map[k]) return;
    const tools = Array.isArray(l.tool_calls) ? l.tool_calls : [];
    tools.forEach((tc: any) => {
      if (!tc || !isSuccessfulCall(tc)) return;
      const isCancel = CANCEL_TOOL_NAMES.has(tc.name);
      const isResched = RESCHEDULE_TOOL_NAMES.has(tc.name);
      if (!isCancel && !isResched) return;
      const key = actionKey(tc, isCancel ? "cancel" : "resched");
      if (seen.has(key)) return;
      seen.add(key);
      if (isCancel) map[k].cancelamentos++;
      else map[k].remarcacoes++;
    });
  });
  return Object.values(map);
}
