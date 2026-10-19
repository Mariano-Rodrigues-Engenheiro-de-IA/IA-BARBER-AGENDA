import { describe, it, expect } from "vitest";
import {
  isUnreadableCustomerPhone,
  PHONE_DEPENDENT_BOOKING_LOOKUP_TOOLS,
  UNREADABLE_PHONE_INSTRUCTION_PT,
} from "../../supabase/functions/whatsapp-webhook/phone-readability";

describe("isUnreadableCustomerPhone", () => {
  it("LID real do caso 9Cinco (14 dígitos) é ilegível", () => {
    expect(isUnreadableCustomerPhone("32281125241048")).toBe(true);
  });
  it("LID de 15 dígitos e com sufixo @lid é ilegível", () => {
    expect(isUnreadableCustomerPhone("123456789012345")).toBe(true);
    expect(isUnreadableCustomerPhone("32281125241048@lid")).toBe(true);
  });
  it("telefones brasileiros normais são legíveis", () => {
    expect(isUnreadableCustomerPhone("5544998931212")).toBe(false); // 13
    expect(isUnreadableCustomerPhone("554498931212")).toBe(false); // 12
    expect(isUnreadableCustomerPhone("44998931212")).toBe(false); // 11
  });
  it("ids não numéricos (simulador, web chat) nunca são bloqueados", () => {
    expect(isUnreadableCustomerPhone("SIM:3f2a9c1e-0000-0000-0000-000000000000")).toBe(false);
    expect(isUnreadableCustomerPhone("web:abc123")).toBe(false);
  });
  it("vazio/nulo não é tratado como ilegível", () => {
    expect(isUnreadableCustomerPhone("")).toBe(false);
    expect(isUnreadableCustomerPhone(null)).toBe(false);
    expect(isUnreadableCustomerPhone(undefined)).toBe(false);
  });
});

describe("trava de busca de agendamento", () => {
  it("cobre as buscas de todos os providers", () => {
    for (const t of ["buscar_agendamento", "buscar_agendamentos", "buscar_agendamentos_dia", "listar_agendamentos"]) {
      expect(PHONE_DEPENDENT_BOOKING_LOOKUP_TOOLS.has(t)).toBe(true);
    }
    expect(PHONE_DEPENDENT_BOOKING_LOOKUP_TOOLS.has("listar_horarios")).toBe(false);
  });
  it("a instrução proíbe dizer 'não encontrei' e manda escalar", () => {
    expect(UNREADABLE_PHONE_INSTRUCTION_PT).toMatch(/NUNCA diga que não encontrou/);
    expect(UNREADABLE_PHONE_INSTRUCTION_PT).toMatch(/transferência para humano/);
  });
});
