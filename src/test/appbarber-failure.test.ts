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

  it("a mensagem do cliente oferece trocar ou manter em vez de só recusar", () => {
    const r = classifyAppBarberFailure(422, undefined, err(variants[0]));
    // Desde 28/08 o texto oferece TROCAR ou MANTER (prompt V33); a palavra
    // "remarcar" foi removida porque casava com as regexes dos guards.
    expect(r.clientMessage).toMatch(/troc|troq/i);
    expect(r.clientMessage).toMatch(/manter/i);
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

describe("invariante: clientMessage não pode disparar os guards de confirmação", () => {
  /**
   * Espelhos das regexes de whatsapp-webhook/index.ts (IMPLICIT_CONFIRMATION_RE
   * em ~:3869 e IMPLIED_FINALIZATION_RE em ~:6870). Não dá pra importar o index
   * aqui porque ele é um módulo Deno; se as regexes de lá mudarem, atualizar
   * estas cópias junto.
   *
   * Por que isso importa: um `clientMessage` que casa com uma delas é tratado
   * como confirmação falsa da IA e substituído por um fallback de erro. Foi o
   * que aconteceu em 28/08 — o texto dizia "você já tem um horário marcado",
   * `marcado` casou, e o cliente recebeu "tive um probleminha... vou acionar a
   * equipe" sem que nenhuma escalação tivesse acontecido.
   */
  const IMPLICIT_CONFIRMATION_RE =
    /\b(confirm|agendei|marquei|marcado|pronto|feito|t[aá]\s+marcado|t[aá]\s+combinado|show|beleza|te\s+espero|te\s+aguard|at[eé]\s+l[aá]|nos\s+vemos)\b/i;

  const IMPLIED_FINALIZATION_RE =
    /\b(?:(?:tudo|ta|tá|esta|está)\s+(?:certo|confirmad[oa]|combinado)|confirmad[oa]|hor[aá]rio\s+(?:confirmad[oa]|marcad[oa]|reservad[oa])|agendamento\s+(?:confirmad[oa]|marcad[oa]|reservad[oa])|reserva\s+(?:confirmad[oa]|marcad[oa]|reservad[oa])|te\s+esperamos|esperamos\s+voc[eê]|at[eé]\s+(?:l[aá]|mais\s+tarde|amanh[aã])|fechado(?:\s+ent[aã]o)?|combinado(?:\s+ent[aã]o)?)\b/i;

  const casos: Array<[string, number, string]> = [
    ["future_appointments_limit", 422, "O limite de agendamentos futuros foi excedido"],
    ["establishment_inactive", 400, "Estabelecimento inativo"],
  ];

  it.each(casos)("%s não casa com IMPLICIT_CONFIRMATION_RE", (_n, status, msg) => {
    const { clientMessage } = classifyAppBarberFailure(status, undefined, err(msg));
    if (clientMessage) expect(clientMessage).not.toMatch(IMPLICIT_CONFIRMATION_RE);
  });

  it.each(casos)("%s não casa com IMPLIED_FINALIZATION_RE", (_n, status, msg) => {
    const { clientMessage } = classifyAppBarberFailure(status, undefined, err(msg));
    if (clientMessage) expect(clientMessage).not.toMatch(IMPLIED_FINALIZATION_RE);
  });

  it("a mensagem oferece TROCAR ou MANTER, como o prompt V33 especifica", () => {
    const { clientMessage } = classifyAppBarberFailure(
      422, undefined, err("O limite de agendamentos futuros foi excedido"),
    );
    // Ortografia PT: o "c" vira "qu" antes de e/i — "troque", não "troce".
    // Mesmo cuidado vale para remarcar/remarque.
    expect(clientMessage).toMatch(/troc|troq/i);
    expect(clientMessage).toMatch(/manter/i);
  });
});
