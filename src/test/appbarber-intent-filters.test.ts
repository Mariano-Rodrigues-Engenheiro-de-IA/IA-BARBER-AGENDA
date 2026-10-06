import { describe, expect, it } from "vitest";
import {
  adjustCountForDroppedPast,
  appBarberClientOnlyText,
  dropPastAppBarberIntentItems,
} from "../../supabase/functions/whatsapp-webhook/providers/appbarber/intent-filters";
import { buildAppBarberIntentSnapshot } from "../../supabase/functions/whatsapp-webhook/providers/appbarber/guard-core";

const TODAY = "2026-10-05";
const OS_DOIS = /\bos dois\b/i;

// ---- Ajuste A: o filtro só enxerga o pedido do cliente --------------------
describe("Ajuste A - sinais de multi-serviço só nas falas do cliente", () => {
  // Conversas reais de 05/10 (9Cinco), tiradas de chat_messages.
  const ryan = [
    { role: "user", content: "Bom dia!\nTudo bem?\nQueria marcar um horário" },
    { role: "assistant", content: "bom dia! Sou a Carol, assistente virtual da 9Cinco. Para qual serviço vamos agendar: cabelo, barba ou os dois? ☺️" },
    { role: "user", content: "Com o Cleiton para terça-feira quais horários disponíveis?" },
    { role: "assistant", content: "Com o Cleiton na terça à tarde tenho 10:30, 10:45, 15:30. Qual prefere?" },
    { role: "user", content: "Pode ser às 10:45" },
    { role: "assistant", content: "Só pra confirmar, é cabelo, barba ou os dois? ☺️" },
    { role: "user", content: "Só cabelo" },
  ];
  const kaue = [
    { role: "user", content: "Pode ser às 15:30 com o victor" },
    { role: "assistant", content: "Para qual serviço vamos agendar: cabelo, barba ou os dois?" },
    { role: "user", content: "cabelo" },
  ];

  it("Ryan e Kaue: com resposta explícita, a pergunta da própria IA não vira sinal", () => {
    expect(OS_DOIS.test(appBarberClientOnlyText(ryan))).toBe(false);
    expect(OS_DOIS.test(appBarberClientOnlyText(kaue))).toBe(false);
  });

  it("respostas curtas do cliente ('Sim, só cabelo', 'Pode ser só cabelo') também ignoram a IA", () => {
    for (const reply of ["Sim, só cabelo", "Pode ser só cabelo", "Claro, só cabelo", "Beleza, cabelo"]) {
      const msgs = [
        { role: "assistant", content: "Para qual serviço: cabelo, barba ou os dois?" },
        { role: "user", content: reply },
      ];
      expect(OS_DOIS.test(appBarberClientOnlyText(msgs))).toBe(false);
    }
  });

  it("cliente que ESCREVE 'os dois' continua sendo detectado", () => {
    const msgs = [
      { role: "assistant", content: "Para qual serviço: cabelo, barba ou os dois?" },
      { role: "user", content: "os dois" },
    ];
    expect(OS_DOIS.test(appBarberClientOnlyText(msgs))).toBe(true);
  });

  it("pedido parcelado do cliente ('pra mim e pro meu filho' ... várias msgs depois '16h') continua detectado", () => {
    const msgs = [
      { role: "user", content: "Queria cortar pra mim e pro meu filho" },
      { role: "assistant", content: "Claro! Qual dia?" },
      { role: "user", content: "16h" },
    ];
    const text = appBarberClientOnlyText(msgs);
    expect(/\bpro meu\b/i.test(text)).toBe(true);
  });

  it("oferta de 'os dois' feita só pela IA, com cliente respondendo 'pode', não vira sinal", () => {
    const msgs = [
      { role: "assistant", content: "Posso agendar os dois: cabelo e barba?" },
      { role: "user", content: "pode" },
    ];
    expect(OS_DOIS.test(appBarberClientOnlyText(msgs))).toBe(false);
  });

  it("ignora mensagens vazias ou sem texto", () => {
    expect(appBarberClientOnlyText([{ role: "user", content: "  " }, { role: "user", content: 5 as unknown }])).toBe("");
  });
});

// ---- Ajuste B: data anterior a hoje nunca está pendente ---------------------
describe("Ajuste B - itens com data passada saem da contagem", () => {
  it("Kaue (prometidos 3, criados 1): vira 1", () => {
    const raw = {
      total_bookings_requested: 3, distinct_people: 1, distinct_times: 3, distinct_professionals: 3,
      requested_items: [
        { date: "2026-09-10", time: "14:00", person_name: "Kaue Santos da Silva", service_name: "Cabelo", professional_name: "Nando Júnior" },
        { date: "2026-09-26", time: "10:45", person_name: "Kaue Silva", service_name: "Cabelo", professional_name: "Victor" },
        { date: "2026-10-05", time: "15:30", person_name: "Kaue Santos da Silva", service_name: "Cabelo", professional_name: "Victor" },
      ],
    };
    const { cleaned, removed, remaining } = dropPastAppBarberIntentItems(raw, TODAY);
    expect(removed).toBe(2);
    expect(remaining).toBe(1);
    const snap = buildAppBarberIntentSnapshot(cleaned, "llm");
    expect(snap.expectedCount).toBe(1);
    expect(snap.items).toHaveLength(1);
    expect(snap.items[0].date).toBe("2026-10-05");
  });

  it("Ryan (prometidos 2, criados 1): vira 1, e o item sem data (o pedido de hoje) fica", () => {
    const raw = {
      total_bookings_requested: 2, distinct_people: 1, distinct_times: 2, distinct_professionals: 2,
      requested_items: [
        { date: "2026-10-02", time: "10:30", person_name: "Ryan Lucas", service_name: "cabelo", professional_name: "Victor (Victor Hugo Amaral)" },
        { date: null, time: "10:45", person_name: "Ryan Lucas", service_name: "cabelo", professional_name: "Cleiton" },
      ],
    };
    const { cleaned, removed } = dropPastAppBarberIntentItems(raw, TODAY);
    expect(removed).toBe(1);
    const snap = buildAppBarberIntentSnapshot(cleaned, "llm");
    expect(snap.expectedCount).toBe(1);
    expect(snap.items.map((i) => i.time)).toEqual(["10:45"]);
  });

  it("caso 28/09 (todos os itens no passado): cai pra 1, nunca 0", () => {
    const raw = {
      total_bookings_requested: 2, distinct_people: 1, distinct_times: 2, distinct_professionals: 1,
      requested_items: [{ date: "2026-08-11", time: "16:30" }, { date: "2026-09-02", time: "10:00" }],
    };
    const { cleaned } = dropPastAppBarberIntentItems(raw, "2026-09-28");
    expect(buildAppBarberIntentSnapshot(cleaned, "llm").expectedCount).toBe(1);
  });

  it("SEM item no passado: devolve o mesmo objeto, nada muda", () => {
    const raw = {
      total_bookings_requested: 2, distinct_people: 2, distinct_times: 1, distinct_professionals: 1,
      requested_items: [{ date: "2026-10-06", time: "10:00", person_name: "A" }, { date: "2026-10-06", time: "10:00", person_name: "B" }],
    };
    const out = dropPastAppBarberIntentItems(raw, TODAY);
    expect(out.cleaned).toBe(raw);
    expect(out.removed).toBe(0);
  });

  it("DUAS pessoas de verdade continuam sendo 2, mesmo com um item antigo na lista", () => {
    const raw = {
      total_bookings_requested: 3, distinct_people: 2, distinct_times: 2, distinct_professionals: 1,
      requested_items: [
        { date: "2026-09-20", time: "10:00", person_name: "Pai" },
        { date: "2026-10-07", time: "15:00", person_name: "Pai" },
        { date: "2026-10-07", time: "15:45", person_name: "Filho" },
      ],
    };
    const { cleaned } = dropPastAppBarberIntentItems(raw, TODAY);
    const snap = buildAppBarberIntentSnapshot(cleaned, "llm");
    expect(snap.expectedCount).toBe(2);
    expect(snap.distinctPeople).toBe(2);
  });

  it("dois pedidos futuros reais continuam 2 mesmo quando o classificador já tinha excluído o antigo do total", () => {
    const raw = {
      total_bookings_requested: 2, distinct_people: 2, distinct_times: 2, distinct_professionals: 2,
      requested_items: [
        { date: "2026-09-20", time: "10:00" },
        { date: "2026-10-07", time: "15:00" },
        { date: "2026-10-07", time: "16:00" },
      ],
    };
    const { cleaned } = dropPastAppBarberIntentItems(raw, TODAY);
    expect(buildAppBarberIntentSnapshot(cleaned, "llm").expectedCount).toBe(2);
  });

  it("data de hoje e datas futuras NÃO são descartadas; data fora do formato ISO também não", () => {
    const raw = {
      total_bookings_requested: 3, distinct_people: 1, distinct_times: 3, distinct_professionals: 1,
      requested_items: [{ date: "2026-10-05", time: "09:00" }, { date: "2026-10-09", time: "09:00" }, { date: "amanhã", time: "09:00" }],
    };
    const out = dropPastAppBarberIntentItems(raw, TODAY);
    expect(out.removed).toBe(0);
    expect(out.cleaned).toBe(raw);
  });

  it("adjustCountForDroppedPast: não mexe sem remoção, nem quando a contagem já cabe no que sobrou", () => {
    expect(adjustCountForDroppedPast(3, 0, 3)).toBe(3);
    expect(adjustCountForDroppedPast(2, 1, 2)).toBe(2);
    expect(adjustCountForDroppedPast(3, 2, 1)).toBe(1);
    expect(adjustCountForDroppedPast(2, 2, 0)).toBe(1);
  });
});
