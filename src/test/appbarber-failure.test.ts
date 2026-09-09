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

/**
 * Os dois blocos abaixo espelham regexes que vivem em
 * whatsapp-webhook/index.ts. Não dá para importar o index aqui (módulo Deno),
 * então as cópias precisam ser atualizadas junto quando as originais mudarem.
 * O valor deles é travar os CASOS REAIS do Relatório de Bugs como regressão.
 */

describe("PhantomCancelGuard — alegação de cancelamento sem ferramenta", () => {
  const CANCEL_CLAIM_RE = /\b(?:cancelad[oa]s?|desmarcad[oa]s?|remarcad[oa]s?|cancelei|desmarquei|remarquei|cancelamos|desmarcamos|remarcamos)\b/i;
  const NEGATED_RE = /\bn[ãa]o\s+(?:foi\s+|est[áa]\s+|consegui\s+)?(?:cancelad|desmarcad|remarcad|cancel|desmarc|remarc)/i;

  const detecta = (texto: string): string | undefined =>
    texto.split(/(?<=[.!?])\s+/)
      .find((s) => !s.trim().endsWith("?") && CANCEL_CLAIM_RE.test(s) && !NEGATED_RE.test(s));

  it.each([
    ["V25 — caso Weslei (556191070244)", "Cancelado! Qualquer coisa é só chamar ☺️"],
    ["V29 — caso Gabriel Oliveira", "Pode deixar, já está remarcado para hoje às 18h30."],
    ["V27 — caso 5", "Seu horário foi desmarcado com sucesso."],
    ["primeira pessoa", "Pronto, cancelei seu horário."],
  ])("detecta: %s", (_nome, texto) => {
    expect(detecta(texto)).toBeTruthy();
  });

  it.each([
    ["oferta no subjuntivo", "Quer que eu cancele esse e marque a barba na segunda às 15h?"],
    ["oferta no infinitivo", "Posso cancelar o do sábado e marcar sua barba na segunda, ou prefere manter?"],
    ["negação", "Seu agendamento não foi cancelado, continua valendo."],
    ["negação de falha", "Não consegui cancelar agora, vou verificar."],
    ["confirmação de agendamento", "Agendei seu corte de cabelo com o Pedro para o próximo sábado às 9h."],
  ])("não dispara em: %s", (_nome, texto) => {
    expect(detecta(texto)).toBeUndefined();
  });
});

describe.skip("PhantomConfirmationGuard — confirmação sem ferramenta [GAP ABERTO]", () => {
  /**
   * ⛔ SKIP PROPOSITAL — não é teste quebrado, é gap documentado.
   *
   * A regex ampliada abaixo foi aplicada em 03/09 e REVERTIDA no mesmo dia:
   * ela caçava "seu horário está confirmado", que é um SCRIPT OBRIGATÓRIO do
   * prompt (seção DISPARO DE CONFIRMAÇÃO) para quando o agendamento JÁ EXISTE.
   * O guard passou a comer a resposta correta e devolver o fallback
   * "Deixa eu confirmar aqui rapidinho e já te retorno" — promessa falsa, já
   * que a IA não reabre conversa. Atingiu 4 clientes numa manhã.
   *
   * Os casos fantasma abaixo são REAIS e seguem SEM cobertura em produção.
   * Ficam aqui para serem reativados quando as três pré-condições estiverem
   * prontas (ver comentário em index.ts, acima de CONFIRM_CLAIM_RE):
   *   1. isAffirmativeReply tolerar saudação e cortesia
   *   2. o guard reconhecer o formato do disparo de confirmação
   *   3. lookupLegit aceitar listar_agendamentos com agendamento ativo,
   *      sem exigir que o texto cite a hora
   *
   * Para reativar: trocar describe.skip por describe e aplicar a regex
   * ampliada em index.ts no mesmo commit.
   */
  const CONFIRM_CLAIM_RE = /\b(?:(?:j[aá]\s+)?agendei|acabei\s+de\s+agendar|acabo\s+de\s+agendar|criei\s+(?:o\s+)?(?:seu\s+)?agendamento|criei\s+(?:a\s+)?(?:sua\s+)?reserva|marcamos\s+(?:seu|o)\s+hor[aá]rio|remarquei|remarcamos|agendamento\s+(?:criado|feito|realizado)\s+com\s+sucesso|reserva\s+(?:criada|feita)\s+com\s+sucesso|(?:seu|sua|o|a)\s+(?:hor[aá]rio|agendamento|reserva)[^.!?]{0,70}?(?:est[aá]|foi|ficou)\s+(?:confirmad|marcad|agendad|remarcad|reservad|garantid)[oa]|(?:est[aá]|foi|ficou)\s+(?:confirmad|marcad|agendad|remarcad)[oa]\s+para|(?:hor[aá]rio|agendamento|reserva)\s+(?:confirmad|remarcad|agendad)[oa]\s+para|prontinho[^.!?]{0,60}(?:agendei|criei|marcamos|remarquei))\b/i;
  const CANCEL_CONTEXT_RE = /\bcancel|desmarc/i;

  const alega = (texto: string): boolean =>
    texto.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean)
      .some((s) => CONFIRM_CLAIM_RE.test(s) && !CANCEL_CONTEXT_RE.test(s) && !s.endsWith("?"));

  it.each([
    ["02/09 14:37 — zero ferramentas", "Perfeito! Seu horário está confirmado para sexta às 16h com o Nando. Te esperamos 🤝😁"],
    ["01/09 18:53 — zero ferramentas", "Perfeito! Seu horário está confirmado para o dia 2 do mês que vem às 14h com o Leonardo. Te esperamos 🤝😁"],
    ["V27 caso 4 — 554498685420", "Perfeito! Seu horário com o Nando hoje às 15h30 está confirmado"],
    ["V28 caso 3 — 554498603038", "Perfeito! Está confirmado para amanhã às 17h15 com o Gabriel."],
    ["V17 — remarcação Leonardo", "Seu horário está remarcado para quinta às 18h30."],
    ["V29 — Gabriel Vargas", "Pode deixar, já está remarcado para hoje às 18h30."],
    ["primeira pessoa", "Pronto, remarquei seu horário para sábado às 9h."],
    ["passiva", "Seu agendamento foi confirmado para quinta às 10h."],
  ])("detecta alegação: %s", (_nome, texto) => {
    expect(alega(texto)).toBe(true);
  });

  it.each([
    ["pergunta de confirmação", "Cabelo com o Leonardo, sexta às 16h. Pode confirmar?"],
    ["pergunta de remarcação", "Posso remarcar seu horário de sábado das 11h para sábado às 9h?"],
    ["oferta de horário", "Quer um horário mais cedo no mesmo sábado ou prefere outro dia pela manhã?"],
    ["pedido de nome (CASO A da V34)", "Cabelo com o Leonardo, sexta às 16h. Pra confirmar, me manda seu nome completo? ☺️"],
    ["lista de horários", "Com ele tem das 13h30 às 16h15. Qual horário prefere?"],
    ["trocar ou manter", "Você já tem um agendamento ativo. Quer que eu troque para esse novo horário, ou prefere manter o atual?"],
    ["cancelamento legítimo", "Pronto, cancelei seu horário. Qualquer coisa é só chamar ☺️"],
    ["consulta de agendamento", "Você tem um agendamento de cabelo na quarta às 14h. Te esperamos! 🤝"],
    ["aguardando o nome", "Tranquilo — quando quiser, me manda seu nome que eu confirmo o horário com o Leonardo às 16h na quinta."],
  ])("não dispara em: %s", (_nome, texto) => {
    expect(alega(texto)).toBe(false);
  });
});

describe("isBookingTimeConfirmationPrompt — reconhece pedido de confirmação de remarcação", () => {
  /**
   * Espelho de whatsapp-webhook/index.ts (~:9510). Caso real: 08/09, cliente
   * Leonardo Neres (9Cinco). A IA perguntou "Confirmo a mudança para as 17h
   * com o mesmo profissional, Nando?", o cliente respondeu "Sim", e a resposta
   * seguinte ("Perfeito, está confirmado para amanhã às 17h") NUNCA foi
   * testada contra o guard de confirmação fantasma, porque a frase de pergunta
   * não batia em nenhum padrão reconhecido — "para" ligava ao horário, não a
   * "você", e por isso isNewBookingFinalStep ficava false. A IA tinha, de
   * fato, zero chamadas de ferramenta na rodada da confirmação falsa.
   */
  const isBookingTimeConfirmationPrompt = (value: string): boolean => {
    const normalized = value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (!normalized) return false;
    return /\b(posso confirmar|posso marcar|posso reservar|quer confirmar|quer que eu confirme|quer que eu marque|quer que eu reserve|confirmo pra voce|confirmo para voce|confirmo a mudanca|confirmo a troca|confirmo a alteracao|confirmo a remarcacao|confirmo o agendamento|confirmo o horario|vou confirmar|vou marcar|vou reservar|fecho pra voce|fecho para voce|fechar esse horario|confirmar esse horario|pode ser esse horario|pode ser esse horario pro|pode ser esse horario para|pode ser esse|esse horario serve|serve esse horario|fechou nesse horario|confirmando)\b/.test(normalized);
  };

  it("pega o caso real do Leonardo Neres (08/09, 9Cinco)", () => {
    expect(isBookingTimeConfirmationPrompt("Confirmo a mudança para as 17h com o mesmo profissional, Nando?")).toBe(true);
  });

  it.each([
    "Confirmo a troca para amanhã às 10h?",
    "Confirmo a alteração para sexta às 16h?",
    "Confirmo a remarcação para o mesmo horário?",
    "Confirmo o agendamento para quinta?",
    "Confirmo o horário das 9h?",
  ])("pega variações do mesmo padrão: %s", (texto) => {
    expect(isBookingTimeConfirmationPrompt(texto)).toBe(true);
  });

  it.each([
    "Posso confirmar para você?",
    "Confirmo pra você às 15h com o Nando?",
    "Quer que eu confirme esse horário?",
  ])("não regride nos padrões que já existiam: %s", (texto) => {
    expect(isBookingTimeConfirmationPrompt(texto)).toBe(true);
  });

  it.each([
    "Com o Leonardo tenho 10h ou 10h40, qual prefere?",
    "Você tem um agendamento de cabelo na quarta às 14h.",
    "Pronto, cancelei seu horário.",
    "Tenho 9h, 10h ou 11h. Qual prefere?",
  ])("não dispara em mensagens que não pedem confirmação: %s", (texto) => {
    expect(isBookingTimeConfirmationPrompt(texto)).toBe(false);
  });
});

describe("anti-eco — só descarta eco de verdade", () => {
  /**
   * Espelho da lógica de comparação de whatsapp-webhook/index.ts (~:1762).
   * A versão anterior usava `stored.includes(echoNorm)` com limiar de 9 chars e
   * SEM filtrar por telefone — descartava mensagem legítima de cliente sem
   * deixar rastro no banco. Provável causa do relato de "a IA não responde".
   */
  const MIN = 25;
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const ehEco = (doCliente: string, daIA: string[]): boolean => {
    if (doCliente.trim().length < MIN) return false;
    const alvo = norm(doCliente);
    return daIA.some((m) => norm(m).length >= MIN && norm(m) === alvo);
  };

  const respostaDaIA = "Cabelo com o Leonardo, sexta às 16h. Pode confirmar?";

  it("descarta o eco real: a mensagem inteira voltando", () => {
    expect(ehEco(respostaDaIA, [respostaDaIA])).toBe(true);
  });

  it("NÃO descarta o cliente respondendo um pedaço da frase", () => {
    // Era exatamente isto que a versão antiga engolia.
    expect(ehEco("sexta às 16h", [respostaDaIA])).toBe(false);
    expect(ehEco("Cabelo com o Leonardo", [respostaDaIA])).toBe(false);
  });

  it("NÃO descarta mensagem curta de cliente", () => {
    expect(ehEco("pode ser", [respostaDaIA])).toBe(false);
    expect(ehEco("Sim obrigado", [respostaDaIA])).toBe(false);
  });

  it("NÃO descarta frase parecida mas não idêntica", () => {
    expect(ehEco("Cabelo com o Leonardo, sexta às 17h. Pode confirmar?", [respostaDaIA])).toBe(false);
  });
});

describe("isLeakedReasoningResponse — vazamento de raciocínio", () => {
  const STRONG_ENGLISH_LEAK_RE = /\b(?:yet|cannot|unable|awaiting|proceed|user\s+input|next\s+(?:user|message|step|input)|i\s+(?:will|can|should|need|must)|let\s+me\s+(?:check|know|proceed|see)|need\s+(?:to|more|the|next)|waiting\s+for)\b/i;

  it("pega o texto exato que vazou em 25/08", () => {
    // Híbrido PT+EN: os acentos marcavam hasPortugueseSignal e curto-circuitavam
    // a checagem de inglês, e "yet" nem estava na lista de palavras.
    expect(STRONG_ENGLISH_LEAK_RE.test("Não posso respondê-lo yet.")).toBe(true);
  });

  it.each([
    "Need next user input",
    "Let me check the availability first",
    "I will proceed with the booking",
    "Waiting for user response",
    "Vou proceed com o agendamento",
  ])("pega: %s", (texto) => {
    expect(STRONG_ENGLISH_LEAK_RE.test(texto)).toBe(true);
  });

  it.each([
    "Boa noite! Sou a Carol, assistente da 9Cinco. Para qual serviço vamos agendar?",
    "Cabelo com o Leonardo, sexta às 16h. Pra confirmar, me manda seu nome completo? ☺️",
    "Você já tem um agendamento ativo. Quer que eu troque para esse novo horário, ou prefere manter o atual?",
    "Infelizmente nosso sistema permite só 1 agendamento ativo por cliente.",
    "Pronto, cancelei seu horário. Qualquer coisa é só chamar ☺️",
  ])("não bloqueia mensagem legítima: %s", (texto) => {
    expect(STRONG_ENGLISH_LEAK_RE.test(texto)).toBe(false);
  });
});
