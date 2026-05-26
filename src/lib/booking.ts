// Helpers para identificar agendamentos efetivamente criados a partir de tool_calls
// dos agent_logs. Cobre os dois formatos usados pelos provedores:
//  - "agendar" (Trinks): result = { success: true, data: <id numérico>, id: true }
//  - "criar_agendamento" (demais): result = { id|agendamento_id|appointment_id: <id> }
// Retorna uma chave única para deduplicar (mesmo agendamento aparece em várias rodadas).

const BOOKING_TOOL_NAMES = new Set(["agendar", "criar_agendamento"]);

export function getBookingId(tc: any): string | null {
  if (!tc || tc.blocked) return null;
  if (!BOOKING_TOOL_NAMES.has(tc.name)) return null;
  const r = tc.result;
  if (!r || typeof r !== "object") return null;
  if (r.error) return null;
  if (r.deduplicated) return null;
  if (Array.isArray(r.Errors) && r.Errors.length > 0) return null;
  if (r.success === false) return null;

  // Prioridade: data (numérico do Trinks) > id > agendamento_id > appointment_id
  const candidates = [r.data, r.id, r.agendamento_id, r.appointment_id];
  for (const c of candidates) {
    if (c == null) continue;
    if (typeof c === "boolean") continue; // ignora flags
    const s = String(c).trim();
    if (s && s !== "true" && s !== "false") return s;
  }
  return null;
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
