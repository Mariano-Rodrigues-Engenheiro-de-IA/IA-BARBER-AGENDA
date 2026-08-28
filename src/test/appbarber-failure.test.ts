import { describe, it, expect } from "vitest";
import { classifyAppBarberFailure } from "../../supabase/functions/whatsapp-webhook/providers/appbarber/index";

/**
 * Testes de regressão do classificador de falhas do AppBarber.
 *
 * Contexto: o campo `clientMessage` pode ser enviado LITERALMENTE ao cliente no
 * WhatsApp pelo MultiBookingGuard (whatsapp-webhook/index.ts, ramo
 * `definitive_failure_no_recovery`). Em 25/08/2026 um texto escrito como diretiva
 * de agente estava nesse campo e vazou para um cliente da 9Cinco em 3 mensagens.
 *
 * Os testes abaixo travam as duas garantias que impedem a recorrência:
 *   1. `clientMessage` nunca contém vocabulário interno.
 *   2. `future_appointments_limit` é recuperável (não escala humano).
 */

const err = (message: string) => ({ message });

describe("classifyAppBarberFailure — eixos de classificação", () => {
  it("401/403 são definitivos e sem mensagem de cliente (escalam)", () => {
    for (const status of [401, 403]) {
      const r = classifyAppBarberFailure(status, undefined, err("qualquer coisa"));
      expect(r.retryable).toBe(false);
      expect(r.reason).toBe(`auth_${status}`);
      expect(r.clientMessage).toBeUndefined();
      expect(r.recoverable).toBeUndefined();
    }
  });

  it("404 é definitivo (endpoint/estabelecimento inválido)", () => {
    const r = classifyAppBarberFailure(404, undefined, err("not found"));
    expect(r.retryable).toBe(false);
    expect(r.reason).toBe("not_found");
  });

  it("422 genérico é retryable — a IA pode oferecer outro horário", () => {
    const r = classifyAppBarberFailure(422, undefined, err("horario indisponivel"));
    expect(r.retryable).toBe(true);
    expect(r.reason).toBe("conflict_422");
    expect(r.clientMessage).toBeUndefined();
  });

  it("429 e 5xx são transitórios", () => {
    expect(classifyAppBarberFailure(429, undefined, err("rate limit")).retryable).toBe(true);
    expect(classifyAppBarberFailure(500, undefined, err("boom")).retryable).toBe(true);
    expect(classifyAppBarberFailure(503, undefined, err("boom")).retryable).toBe(true);
  });

  it("estabelecimento inativo tem mensagem de cliente e escala (não é recuperável)", () => {
    const r = classifyAppBarberFailure(400, undefined, err("Estabelecimento inativo"));
    expect(r.reason).toBe("establishment_inactive");
    expect(r.retryable).toBe(false);
    expect(r.recoverable).toBeUndefined();
    expect(r.clientMessage).toBeTruthy();
  });
});

describe("future_appointments_limit — regressão do vazamento de 25/08", () => {
  const variants = [
    "O limite de agendamentos futuros foi excedido",
    "Limite de agendamentos futuros do cliente excedido",
  ];

  it.each(variants)("reconhece a mensagem da API: %s", (msg) => {
    expect(classifyAppBarberFailure(422, undefined, err(msg)).reason).toBe("future_appointments_limit");
  });

  it("não repete o mesmo agendamento, mas também NÃO escala humano", () => {
    const r = classifyAppBarberFailure(422, undefined, err(variants[0]));
    // retryable=false → MultiBookingGuard não roda recovery às cegas.
    expect(r.retryable).toBe(false);
    // recoverable=true → BookingGuard NÃO injeta "chame escalate_human".
    // Sem isso, cada ocorrência gera escalação falsa para a equipe.
    expect(r.recoverable).toBe(true);
  });

  it("separa as duas audiências: cliente e modelo", () => {
    const r = classifyAppBarberFailure(422, undefined, err(variants[0]));
    expect(r.clientMessage).toBeTruthy();
    expect(r.recoveryDirective).toBeTruthy();
    expect(r.clientMessage).not.toBe(r.recoveryDirective);
    // O procedimento tem que estar na diretiva do modelo, não no texto do cliente.
    expect(r.recoveryDirective).toMatch(/listar_agendamentos/);
    expect(r.recoveryDirective).toMatch(/cancelar_agendamento/);
  });

  it("a mensagem do cliente oferece a remarcação em vez de só recusar", () => {
    const r = classifyAppBarberFailure(422, undefined, err(variants[0]));
    // "remarque" (subjuntivo) tem 'qu', não 'c' — cobrir as duas grafias.
    expect(r.clientMessage).toMatch(/remarc|remarq/i);
  });
});

describe("invariante: clientMessage nunca vaza vocabulário interno", () => {
  // Qualquer texto que possa sair literalmente no WhatsApp do cliente.
  // Se um caso novo for adicionado ao classificador com linguagem de agente,
  // este teste falha antes de chegar em produção.
  const casos: Array<[string, number, string]> = [
    ["future_appointments_limit", 422, "O limite de agendamentos futuros foi excedido"],
    ["establishment_inactive", 400, "Estabelecimento inativo"],
  ];

  // Nome do fornecedor, nomes de ferramenta, jargão de API e imperativos
  // dirigidos ao agente — nada disso pode chegar ao cliente final.
  const proibido = [
    /appbarber/i,
    /\bapi\b/i,
    /\bhttp\b/i,
    /\bstatus\b/i,
    /\bendpoint\b/i,
    /listar_\w+/i,
    /criar_agendamento|cancelar_agendamento/i,
    /escalate_human|escalar_humano/i,
    /é obrigatório/i,
    /não tente/i,
  ];

  it.each(casos)("%s produz texto apresentável ao cliente", (_nome, status, msg) => {
    const r = classifyAppBarberFailure(status, undefined, err(msg));
    if (!r.clientMessage) return;
    for (const padrao of proibido) {
      expect(r.clientMessage, `"${r.clientMessage}" casou com ${padrao}`).not.toMatch(padrao);
    }
  });

  it("o texto exato que vazou em 25/08 não pode voltar", () => {
    const r = classifyAppBarberFailure(422, undefined, err("O limite de agendamentos futuros foi excedido"));
    expect(r.clientMessage).not.toMatch(/no AppBarber/i);
    expect(r.clientMessage).not.toMatch(/Não tente criar outro horário direto/i);
  });
});
