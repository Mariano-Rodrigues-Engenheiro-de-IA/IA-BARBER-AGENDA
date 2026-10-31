import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { executeAppBarberTool } from "../../supabase/functions/whatsapp-webhook/providers/appbarber/index";

// Caso 554498571542 (9Cinco, 28/10): a IA cancelou a comanda recém-criada (ter 10h30) para trocar por 11h00,
// que não estava em available_times; a criação foi barrada e o cliente ficou sem horário.
// Revisão da Lovable (31/10): a checagem tem que usar serviço + profissional + data + hora, como a criação.
const tenant = { appbarber_api_key: "k", appbarber_establishment_code: "4981532", appbarber_base_url: "https://x.test" };
const call = (args: any, sessionState: any) =>
  executeAppBarberTool(tenant, { function: { name: "cancelar_agendamento", arguments: JSON.stringify(args) } }, "5544998571542", sessionState);
const CLEITON = 9114167;
const GABRIEL = 25044391;
const SVC = 1131459;
const slots = [
  { service_code: SVC, professional_code: CLEITON, start_date: "2026-11-03", start_time: "15:00:00", duration_minutes: 30 },
  { service_code: SVC, professional_code: CLEITON, start_date: "2026-11-03", start_time: "15:30:00", duration_minutes: 30 },
];
const base = { invoice_code: 249442320, reason: "Remarcação solicitada pelo cliente" };
const okFetch = () => vi.fn().mockImplementation(async () => new Response(JSON.stringify({ result: "Comanda cancelada com sucesso!" }), { status: 200 }));

afterEach(() => vi.unstubAllGlobals());

describe("cancelar_agendamento para remarcar: só cancela se o horário novo existe para aquele serviço e profissional", () => {
  it("bloqueia e NÃO chama a API quando o horário novo não está em available_times (caso real das 11h00)", async () => {
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    const r: any = await call({ ...base, novo_horario: "2026-11-03 11:00", novo_service_code: SVC, novo_professional_code: CLEITON }, { appbarberSlotOptions: slots });
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe("reschedule_new_slot_not_available");
    expect(r.recoverable).toBe(true);
    expect(r.horarios_consultados_no_dia).toEqual(["15:00", "15:30"]);
    expect(r.recoveryDirective).toContain("NÃO cancele o agendamento atual");
    expect(f).not.toHaveBeenCalled();
  });

  it("bloqueia horário livre só para OUTRO profissional (a criação barraria e o cliente ficaria sem horário)", async () => {
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    const r: any = await call({ ...base, novo_horario: "2026-11-03 15:30", novo_service_code: SVC, novo_professional_code: GABRIEL }, { appbarberSlotOptions: slots });
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe("reschedule_new_slot_not_available");
    expect(f).not.toHaveBeenCalled();
  });

  it("bloqueia remarcação sem novo_horario, serviço ou profissional e devolve o motivo à IA", async () => {
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    for (const extra of [{}, { novo_horario: "2026-11-03 15:30" }, { novo_horario: "2026-11-03 15:30", novo_service_code: SVC }]) {
      const r: any = await call({ ...base, ...extra }, { appbarberSlotOptions: slots });
      expect(r.blocked).toBe(true);
      expect(r.reason).toBe("reschedule_missing_new_slot");
      expect(r.recoveryDirective).toContain("O cancelamento NÃO foi feito");
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("sem nenhuma consulta de horários na sessão também bloqueia, de forma recuperável", async () => {
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    const r: any = await call({ ...base, novo_horario: "2026-11-03 15:30", novo_service_code: SVC, novo_professional_code: CLEITON }, { appbarberSlotOptions: [] });
    expect(r.blocked).toBe(true);
    expect(r.recoverable).toBe(true);
    expect(r.recoveryDirective).toContain("chame listar_horarios");
    expect(f).not.toHaveBeenCalled();
  });

  it("deixa passar quando serviço, profissional, data e hora estão em available_times", async () => {
    const f = okFetch(); vi.stubGlobal("fetch", f);
    const r: any = await call({ ...base, novo_horario: "2026-11-03T15:30", novo_service_code: SVC, novo_professional_code: CLEITON }, { appbarberSlotOptions: slots });
    expect(r.blocked).not.toBe(true);
    expect(f).toHaveBeenCalled();
  });

  it("cancelamento puro não é afetado, nem 'decidiu mudar de ideia'", async () => {
    for (const reason of ["Cancelamento solicitado pelo cliente via WhatsApp", "Cancelamento: cliente decidiu mudar de ideia"]) {
      const f = okFetch(); vi.stubGlobal("fetch", f);
      const r: any = await call({ invoice_code: 249442320, reason }, { appbarberSlotOptions: slots });
      expect(r.blocked).not.toBe(true);
      expect(f).toHaveBeenCalled();
      vi.unstubAllGlobals();
    }
  });
});

describe("pontos de apoio no código (cache de horários e reinjeção)", () => {
  const base2 = resolve(__dirname, "../../supabase/functions/whatsapp-webhook");
  const idx = readFileSync(resolve(base2, "index.ts"), "utf8");
  const app = readFileSync(resolve(base2, "providers/appbarber/index.ts"), "utf8");

  it("consulta bem-sucedida substitui as opções antigas do mesmo escopo, inclusive vazias", () => {
    const k = idx.indexOf("SUBSTITUI as opções antigas do mesmo escopo");
    expect(k).toBeGreaterThan(-1);
    const trecho = idx.slice(k, k + 1800);
    expect(trecho).toContain("_scopes.has(`${slot.service_code}:${slot.professional_code}`)");
    // o filtro roda antes de a lista nova ser acrescentada (e mesmo quando slotOptions fica vazia)
    expect(trecho.indexOf(".filter(")).toBeLessThan(trecho.indexOf("if (slotOptions.length > 0)"));
  });
  it("criar_agendamento com sucesso registra o horário criado nas opções da sessão", () => {
    expect(app).toContain("Registra o horário recém-criado entre as opções conhecidas da sessão");
  });
  it("a reinjeção da phantom_cancel_guard manda passar novo_horario, serviço e profissional", () => {
    expect(idx).toContain('novo_horario="${newStart}", novo_service_code=${newSvcCode || "?"}, novo_professional_code=${newProfCode || "?"}');
  });
});
