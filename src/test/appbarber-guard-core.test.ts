import { describe, expect, it } from "vitest";
import {
  appBarberClaimsCompletedBooking,
  appBarberCurrentRequestMentionsPendingService,
  appBarberExecutionKey,
  appBarberNamesConflict,
  arbitrateAppBarberGuardDecisions,
  buildAppBarberIntentSnapshot,
  reconcileAppBarberBookings,
  resolveAppBarberSlotSelection,
} from "../../supabase/functions/whatsapp-webhook/providers/appbarber/guard-core";

describe("AppBarber guard core — confirmação fantasma", () => {
  it.each([
    "Perfeito, já deixei reservado com o Nando às 10h.",
    "Já agendei seu corte para sábado.",
    "Seu horário ficou marcado para as 10h.",
    "Agendado! Te espero sábado.",
  ])("detecta afirmação concluída: %s", (text) => {
    expect(appBarberClaimsCompletedBooking(text)).toBe(true);
  });

  it.each([
    "Posso deixar reservado às 10h?",
    "Não consegui reservar esse horário.",
    "Tenho 10h disponível. Qual prefere?",
  ])("não confunde oferta, pergunta ou falha: %s", (text) => {
    expect(appBarberClaimsCompletedBooking(text)).toBe(false);
  });
});

describe("AppBarber guard core — escolha preservada entre turnos", () => {
  const slots = [
    { service_code: 1131457, professional_code: 21573809, professional_name: "Nando Júnior", start_date: "2026-09-19", start_time: "10:00" },
    { service_code: 1131457, professional_code: 28010864, professional_name: "Leonardo Jaldi", start_date: "2026-09-19", start_time: "10:00" },
  ];

  it("resolve o caso real sem trocar corte avulso pelo serviço do clube", () => {
    expect(resolveAppBarberSlotSelection(
      "Com o Nando, as 10:00",
      "Com o Nando tem 10h, 10h15 e 10h30. Qual prefere?",
      slots,
    )).toEqual({ serviceCode: 1131457, professionalCode: 21573809, date: "2026-09-19", time: "10:00" });
  });

  it("não escolhe quando dois serviços continuam possíveis", () => {
    expect(resolveAppBarberSlotSelection(
      "Com o Nando, as 10:00",
      "Com o Nando tem 10h. Qual prefere?",
      [...slots, { ...slots[0], service_code: 1131740 }],
    )).toBeNull();
  });
});

describe("AppBarber guard core — serviços pendentes do pedido atual", () => {
  it("não transforma um pedido novo de corte em combo e barba por causa de slots antigos", () => {
    expect(appBarberCurrentRequestMentionsPendingService(
      "marca pra mim na terça às 9 corte",
      ["02. Cabelo"],
      "01. Cabelo & Barba",
    )).toBe(false);
    expect(appBarberCurrentRequestMentionsPendingService(
      "marca pra mim na terça às 9 corte",
      ["02. Cabelo"],
      "03. Barba & Bigode",
    )).toBe(false);
  });

  it("mantém um segundo serviço realmente pedido na mensagem atual", () => {
    expect(appBarberCurrentRequestMentionsPendingService(
      "quero corte e sobrancelha amanhã",
      ["02. Cabelo"],
      "11. Sobrancelha a Navalha",
    )).toBe(true);
  });
});

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