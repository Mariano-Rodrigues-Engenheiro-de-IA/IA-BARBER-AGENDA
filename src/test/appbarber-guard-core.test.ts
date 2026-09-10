import { describe, expect, it } from "vitest";
import {
  appBarberExecutionKey,
  appBarberNamesConflict,
  arbitrateAppBarberGuardDecisions,
  buildAppBarberIntentSnapshot,
  reconcileAppBarberBookings,
} from "../../supabase/functions/whatsapp-webhook/providers/appbarber/guard-core";

describe("AppBarber guard core — intenção ampla", () => {
  it("preserva o maior eixo e itens parcelados em vez de reduzir para uma execução", () => {
    const snapshot = buildAppBarberIntentSnapshot({
      total_bookings_requested: 1,
      distinct_people: 3,
      distinct_times: 2,
      distinct_professionals: 1,
      requested_items: [
        { person_name: "Mariano Rodrigues", service_code: 10, time: "10:00" },
        { person_name: "Lucas Rodrigues", service_code: 10, time: "10:45" },
        { person_name: "João Rodrigues", service_code: 11, time: null },
      ],
    }, "llm", new Date("2026-09-10T22:00:00Z"));

    expect(snapshot.expectedCount).toBe(3);
    expect(snapshot.items).toHaveLength(3);
  });

  it("mantém duas pessoas no mesmo telefone como execuções distintas pelo nome", () => {
    const self = appBarberExecutionKey({ customer_name: "Mariano Rodrigues", service_code: 10, start_date: "2026-09-11", start_time: "10:00", professional_code: 7 });
    const child = appBarberExecutionKey({ customer_name: "Lucas Rodrigues", service_code: 10, start_date: "2026-09-11", start_time: "10:45", professional_code: 7 });
    expect(self).not.toBe(child);
  });

  it("deduplica retry idêntico, mas não dois agendamentos legítimos", () => {
    const snapshot = buildAppBarberIntentSnapshot({ total_bookings_requested: 2, distinct_people: 2 }, "llm");
    const base = { name: "criar_agendamento", result: { ok: true, appointment_id: "A1" } };
    const result = reconcileAppBarberBookings(snapshot, [
      { ...base, args: { customer_name: "Mariano Rodrigues", service_code: 10, start_date: "2026-09-11", start_time: "10:00", professional_code: 7 } },
      { ...base, result: { ok: true, appointment_id: "A1-retry" }, args: { customer_name: "Mariano Rodrigues", service_code: 10, start_date: "2026-09-11", start_time: "10:00", professional_code: 7 } },
      { ...base, result: { ok: true, appointment_id: "A2" }, args: { customer_name: "Lucas Rodrigues", service_code: 10, start_date: "2026-09-11", start_time: "10:45", professional_code: 7 } },
    ]);
    expect(result.completedCount).toBe(2);
    expect(result.pendingCount).toBe(0);
    expect(result.duplicateExecutionKeys).toHaveLength(1);
  });

  it("resultado incerto não conta como concluído e não autoriza repetição", () => {
    const snapshot = buildAppBarberIntentSnapshot({ total_bookings_requested: 1 }, "llm");
    const result = reconcileAppBarberBookings(snapshot, [{
      name: "criar_agendamento",
      args: { customer_name: "Ana Lima", service_code: 10, start_date: "2026-09-11", start_time: "10:00", professional_code: 7 },
      result: { result_uncertain: true },
    }]);
    expect(result.completedCount).toBe(0);
    expect(result.pendingCount).toBe(1);
    expect(result.uncertainCount).toBe(1);
  });

  it("árbitro é estável e escolhe a maior prioridade, não a última execução", () => {
    const first = arbitrateAppBarberGuardDecisions([
      { guard: "phantom", priority: 30, action: "block", reason: "sem criação" },
      { guard: "ownership", priority: 100, action: "ask", reason: "pessoa ambígua" },
    ]);
    const reversed = arbitrateAppBarberGuardDecisions([
      { guard: "ownership", priority: 100, action: "ask", reason: "pessoa ambígua" },
      { guard: "phantom", priority: 30, action: "block", reason: "sem criação" },
    ]);
    expect(first).toEqual(reversed);
    expect(first.guard).toBe("ownership");
  });

  it("não aceita sobrenomes diferentes só porque o primeiro nome coincide", () => {
    expect(appBarberNamesConflict("João Silva", "João Souza")).toBe(true);
    expect(appBarberNamesConflict("João Silva", "João da Silva")).toBe(true);
    expect(appBarberNamesConflict("João Silva", "João Silva")).toBe(false);
  });
});