import { describe, it, expect, vi, afterEach } from "vitest";
import { executeAppBarberTool } from "../../supabase/functions/whatsapp-webhook/providers/appbarber/index";

// Caso 554498571542 (9Cinco, 28/10): a IA cancelou a comanda recém-criada (ter 10h30) para trocar por 11h00,
// que não estava em available_times; a criação foi barrada e o cliente ficou sem horário.
const tenant = { appbarber_api_key: "k", appbarber_establishment_code: "4981532", appbarber_base_url: "https://x.test" };
const call = (args: any, sessionState: any) =>
  executeAppBarberTool(tenant, { function: { name: "cancelar_agendamento", arguments: JSON.stringify(args) } }, "5544998571542", sessionState);
const slots = [
  { service_code: 1131459, professional_code: 9114167, start_date: "2026-11-03", start_time: "15:00:00", duration_minutes: 30 },
  { service_code: 1131459, professional_code: 9114167, start_date: "2026-11-03", start_time: "15:30:00", duration_minutes: 30 },
];

afterEach(() => vi.unstubAllGlobals());

describe("cancelar_agendamento para remarcar: só cancela se o horário novo existe", () => {
  it("bloqueia e NÃO chama a API quando o horário novo não está em available_times", async () => {
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    const r: any = await call({ invoice_code: 249442320, reason: "Remarcação solicitada pelo cliente", novo_horario: "2026-11-03 11:00" }, { appbarberSlotOptions: slots });
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe("reschedule_new_slot_not_available");
    expect(r.recoverable).toBe(true);
    expect(r.horarios_consultados_no_dia).toEqual(["15:00", "15:30"]);
    expect(r.recoveryDirective).toContain("NÃO cancele o agendamento atual");
    expect(f).not.toHaveBeenCalled();
  });

  it("bloqueia remarcação sem novo_horario e devolve o motivo à IA", async () => {
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    const r: any = await call({ invoice_code: 249442320, reason: "Remarcação solicitada pelo cliente" }, { appbarberSlotOptions: slots });
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe("reschedule_missing_new_slot");
    expect(r.recoveryDirective).toContain("O cancelamento NÃO foi feito");
    expect(f).not.toHaveBeenCalled();
  });

  it("deixa passar quando o horário novo está em available_times", async () => {
    const f = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ result: "Comanda cancelada com sucesso!" }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    const r: any = await call({ invoice_code: 249442320, reason: "Remarcação solicitada pelo cliente", novo_horario: "2026-11-03T15:30" }, { appbarberSlotOptions: slots });
    expect(r.reason).not.toBe("reschedule_new_slot_not_available");
    expect(r.reason).not.toBe("reschedule_missing_new_slot");
    expect(f).toHaveBeenCalled();
  });

  it("cancelamento puro (sem remarcar) não é afetado", async () => {
    const f = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ result: "Comanda cancelada com sucesso!" }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    const r: any = await call({ invoice_code: 249442320, reason: "Cancelamento solicitado pelo cliente via WhatsApp" }, { appbarberSlotOptions: slots });
    expect(r.blocked).not.toBe(true);
    expect(f).toHaveBeenCalled();
  });

  it("sem nenhuma consulta de horários na sessão não bloqueia (mesmo critério da trava de criação)", async () => {
    const f = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ result: "ok" }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    const r: any = await call({ invoice_code: 249442320, reason: "Remarcação solicitada pelo cliente" }, { appbarberSlotOptions: [] });
    expect(r.blocked).not.toBe(true);
    expect(f).toHaveBeenCalled();
  });
});
