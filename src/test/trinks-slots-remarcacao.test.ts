import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fundirIntervalos,
  inferirPasso,
  liberarJanelaDoCliente,
} from "../../supabase/functions/whatsapp-webhook/providers/trinks/slots";
import { executeTrinksTool } from "../../supabase/functions/whatsapp-webhook/providers/trinks/index";

// Retorno BRUTO real da Trinks (Bendita, 02/11/2026, serviço de 60 min) — copiado dos logs de 26/10.
const brutoBendita = {
  data: [
    { id: 782064, nome: "Isaias da Silva Goulart", horariosVagos: ["09:00","09:20","09:40","10:00","10:20","10:40","11:00","11:20","11:40","12:00","12:20","12:40","13:00","13:20","13:40","14:00","14:20","14:40","15:00","15:20","15:40","16:00","16:20","16:40","17:00"], intervalosVagos: [{ inicio: "09:00", fim: "18:00" }] },
    { id: 782068, nome: "Ismael Oliveira Pedroso", horariosVagos: ["10:00","10:20","10:40","11:00","13:00","13:20","13:40","14:00","14:20","14:40","15:00","15:20","15:40","16:00","16:20","16:40","17:00"], intervalosVagos: [{ inicio: "10:00", fim: "12:00" }, { inicio: "13:00", fim: "18:00" }, { inicio: "18:40", fim: "19:00" }] },
    { id: 764030, nome: "William Crepes Ferrari", horariosVagos: ["10:00","10:20","10:40","11:00","11:20","11:40","12:00","12:20","12:40","13:00","13:20","13:40","14:00","14:20","14:40","15:00","15:20","15:40","16:00","16:20","16:40","17:00"], intervalosVagos: [{ inicio: "10:00", fim: "18:00" }] },
  ],
  page: 1, pageSize: 50, totalPages: 1, totalRecords: 3,
};
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

describe("slots.ts (funções puras)", () => {
  it("infere o passo de 20 min da grade real e cai em 20 sem dados", () => {
    expect(inferirPasso(brutoBendita.data)).toBe(20);
    expect(inferirPasso([{ horariosVagos: [] }])).toBe(20);
  });

  it("funde blocos que se encostam e ordena", () => {
    expect(fundirIntervalos([{ inicio: "18:00", fim: "19:00" }, { inicio: "10:00", fim: "18:00" }, { inicio: "19:20", fim: "20:00" }]))
      .toEqual([{ inicio: "10:00", fim: "19:00" }, { inicio: "19:20", fim: "20:00" }]);
  });

  it("caso Bendita: liberar 18:00-19:00 do William acrescenta 17:20, 17:40 e 18:00 (e NÃO 18:20)", () => {
    const william = clone(brutoBendita.data[2]);
    const r = liberarJanelaDoCliente(william, { inicio: "18:00", duracao: 60 }, 60, 20);
    expect(r.intervalosVagos).toEqual([{ inicio: "10:00", fim: "19:00" }]);
    expect(r.acrescentados).toEqual(["17:20", "17:40", "18:00"]);
    expect(r.horariosVagos).toContain("17:40");
    expect(r.horariosVagos).not.toContain("18:20"); // terminaria 19:20, depois do fim do bloco
    // o que a Trinks já tinha continua igual
    for (const h of william.horariosVagos!) expect(r.horariosVagos).toContain(h);
  });

  it("serviço mais curto cabe mais tarde: 40 min libera até 18:20 (termina 19:00)", () => {
    const william = clone(brutoBendita.data[2]);
    const r = liberarJanelaDoCliente(william, { inicio: "18:00", duracao: 60 }, 40, 20);
    expect(r.horariosVagos).toContain("18:20");
    expect(r.horariosVagos).not.toContain("18:40");
  });

  it("janela isolada (sem bloco encostado) cria um bloco novo", () => {
    const prof = { horariosVagos: ["10:00"], intervalosVagos: [{ inicio: "10:00", fim: "11:00" }] };
    const r = liberarJanelaDoCliente(prof, { inicio: "15:00", duracao: 60 }, 60, 20);
    expect(r.intervalosVagos).toEqual([{ inicio: "10:00", fim: "11:00" }, { inicio: "15:00", fim: "16:00" }]);
    expect(r.acrescentados).toEqual(["15:00"]);
  });
});

const tenant = { id: "t-bendita-rem", trinks_api_key: "k", trinks_establishment_id: "1" };
const call = (name: string, args: Record<string, unknown> = {}) => ({ function: { name, arguments: JSON.stringify(args) } });
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const agendamentoAtual = {
  id: 540689802, status: { id: 4, nome: "Confirmado" }, cliente: { id: 91311552, nome: "Pedro Monteiro" },
  servico: { id: 14358978, nome: "[COMBO] Corte e Barba com Ozônio" }, profissional: { id: 764030, nome: "William Crepes Ferrari" },
  dataHoraInicio: "2026-11-02T18:00:00", duracaoEmMinutos: 60, valor: 130,
};

function stubTrinks(bruto: unknown) {
  const fetchMock = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes("/agendamentos/profissionais/")) return json(200, clone(bruto));
    if (u.includes("/agendamentos?")) return json(200, { data: [agendamentoAtual] });
    if (u.includes("/clientes")) return json(200, { data: [{ id: 91311552, nome: "Pedro Monteiro", telefones: [{ ddi: "55", ddd: "61", telefone: "999841310" }] }] });
    return json(404, {});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const prof = (res: any, id: number) => res.data.find((p: any) => p.id === id);

describe("listar_horarios na REMARCAÇÃO (caso Bendita 26/10)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("com agendamentoIdRemarcar: libera a janela atual do William, outros profissionais ficam iguais", async () => {
    stubTrinks(brutoBendita);
    const res: any = await executeTrinksTool(tenant, call("listar_horarios", { data: "2026-11-02", servicoDuracao: 60, agendamentoIdRemarcar: 540689802 }), "556199841310");
    expect(prof(res, 764030).intervalosVagos).toEqual([{ inicio: "10:00", fim: "19:00" }]);
    expect(res.remarcacao.janelaLiberada).toEqual({ inicio: "18:00", fim: "19:00" });
    expect(res.remarcacao.horariosAcrescentados).toEqual(["17:20", "17:40", "18:00"]);
    expect(res.dica).toContain("REMARCAÇÃO");
    expect(res.dica).toContain("editar_agendamento");
    expect(prof(res, 782068).intervalosVagos).toEqual(brutoBendita.data[1].intervalosVagos); // Ismael intacto
    expect(prof(res, 764030).horariosVagos).toContain("18:00"); // o horário atual volta como opção sugerida
  });

  it("SEM agendamentoIdRemarcar: comportamento anterior (nada liberado, sem consulta de agendamentos)", async () => {
    const fetchMock = stubTrinks(brutoBendita);
    const res: any = await executeTrinksTool(tenant, call("listar_horarios", { data: "2026-11-02", servicoDuracao: 60 }), "556199841310");
    expect(prof(res, 764030).intervalosVagos).toEqual([{ inicio: "10:00", fim: "18:00" }]);
    expect(res.remarcacao).toBeUndefined();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/agendamentos?"))).toBe(false);
  });

  it("id de agendamento que NÃO é do cliente: não libera nada e avisa", async () => {
    stubTrinks(brutoBendita);
    const res: any = await executeTrinksTool(tenant, call("listar_horarios", { data: "2026-11-02", servicoDuracao: 60, agendamentoIdRemarcar: 999 }), "556199841310");
    expect(prof(res, 764030).intervalosVagos).toEqual([{ inicio: "10:00", fim: "18:00" }]);
    expect(res.remarcacao.aviso).toContain("não encontrado");
  });

  it("agendamento de OUTRO dia: não libera nada no dia consultado", async () => {
    stubTrinks(brutoBendita);
    const res: any = await executeTrinksTool(tenant, call("listar_horarios", { data: "2026-11-03", servicoDuracao: 60, agendamentoIdRemarcar: 540689802 }), "556199841310");
    expect(prof(res, 764030).intervalosVagos).toEqual([{ inicio: "10:00", fim: "18:00" }]);
    expect(res.remarcacao.aviso).toContain("2026-11-02");
  });

  it("mesmo id retornado pela API com OUTRO dono não libera a janela", async () => {
    stubTrinks(brutoBendita);
    const fallbackFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url).includes("/agendamentos?")
      ? json(200, { data: [{ ...agendamentoAtual, cliente: { id: 999, nome: "Outro cliente" } }] })
      : fallbackFetch(url)));
    const res = await executeTrinksTool(tenant, call("listar_horarios", { data: "2026-11-02", servicoDuracao: 60, agendamentoIdRemarcar: 540689802 }), "556199841310");
    expect(prof(res, 764030).intervalosVagos).toEqual([{ inicio: "10:00", fim: "18:00" }]);
    expect(res.remarcacao.janelaLiberada).toBeUndefined();
  });

  it("agendamento cancelado não libera a janela", async () => {
    stubTrinks(brutoBendita);
    const fallbackFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url).includes("/agendamentos?")
      ? json(200, { data: [{ ...agendamentoAtual, status: { id: 5, nome: "Cancelado" } }] })
      : fallbackFetch(url)));
    const res = await executeTrinksTool(tenant, call("listar_horarios", { data: "2026-11-02", servicoDuracao: 60, agendamentoIdRemarcar: 540689802 }), "556199841310");
    expect(prof(res, 764030).intervalosVagos).toEqual([{ inicio: "10:00", fim: "18:00" }]);
    expect(res.remarcacao.janelaLiberada).toBeUndefined();
  });
});

describe("trava de criar_agendamento usa a grade COMPLETA (não só as sugestões)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("17:20 liberado para REMARCAR não autoriza CRIAR outra reserva na janela ocupada", async () => {
    const fetchMock = stubTrinks(brutoBendita);
    const t = { ...tenant, id: "t-rem-nao-criar" };
    await executeTrinksTool(t, call("listar_horarios", { data: "2026-11-02", servicoDuracao: 60, agendamentoIdRemarcar: 540689802 }), "556199841310");
    const res = await executeTrinksTool(t, call("criar_agendamento", { servicoId: 1, profissionalId: 764030, dataHoraInicio: "2026-11-02T17:20:00", duracaoEmMinutos: 60, valor: 130, clienteId: 91311552 }), "556199841310");
    expect(res.blocked).toBe(true);
    expect(res.horariosDisponiveis).not.toContain("17:20");
    expect(res.horariosDisponiveis).toContain("16:20");
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/agendamentos"))).toBe(false);
  });

  it("grade vazia também bloqueia criar_agendamento fora da grade", async () => {
    const fetchMock = stubTrinks({ data: [{ id: 764030, horariosVagos: [], intervalosVagos: [] }] });
    const t = { ...tenant, id: "t-grade-vazia" };
    await executeTrinksTool(t, call("listar_horarios", { data: "2026-11-02", servicoDuracao: 60 }), "556199841310");
    const res = await executeTrinksTool(t, call("criar_agendamento", { servicoId: 1, profissionalId: 764030, dataHoraInicio: "2026-11-02T16:30:00", duracaoEmMinutos: 60, valor: 130, clienteId: 91311552 }), "556199841310");
    expect(res.blocked).toBe(true);
    expect(res.horariosDisponiveis).toEqual([]);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/agendamentos"))).toBe(false);
  });

  it("profissional ausente na grade consultada não autoriza criar_agendamento", async () => {
    const fetchMock = stubTrinks({ data: [{ id: 782064, horariosVagos: ["16:20"], intervalosVagos: [{ inicio: "16:20", fim: "18:00" }] }] });
    const t = { ...tenant, id: "t-prof-ausente" };
    await executeTrinksTool(t, call("listar_horarios", { data: "2026-11-02", servicoDuracao: 60 }), "556199841310");
    const res = await executeTrinksTool(t, call("criar_agendamento", { servicoId: 1, profissionalId: 764030, dataHoraInicio: "2026-11-02T16:20:00", duracaoEmMinutos: 60, valor: 130, clienteId: 91311552 }), "556199841310");
    expect(res.blocked).toBe(true);
    expect(res.horariosDisponiveis).toEqual([]);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/agendamentos"))).toBe(false);
  });

  it("16:30 (fora da grade) continua bloqueado, e a lista devolvida inclui 16:20 que antes o filtro escondia", async () => {
    stubTrinks(brutoBendita);
    const tenant2 = { ...tenant, id: "t-bendita-trava" };
    await executeTrinksTool(tenant2, call("listar_horarios", { data: "2026-11-02", servicoDuracao: 60 }), "556199841311");
    const res: any = await executeTrinksTool(
      tenant2,
      call("criar_agendamento", { servicoId: 1, profissionalId: 764030, dataHoraInicio: "2026-11-02T16:30:00", duracaoEmMinutos: 60, valor: 130, clienteId: 1 }),
      "556199841311",
    );
    expect(res.blocked).toBe(true);
    expect(res.error).toContain("não está disponível");
    expect(res.horariosDisponiveis).toContain("16:20"); // antes do ajuste só existiam 10:00, 11:00, ... 17:00
    expect(res.horariosDisponiveis).toContain("16:40");
  });

  it("16:20 (livre na Trinks, escondido pelo filtro anti-buraco) NÃO é mais bloqueado pela trava", async () => {
    stubTrinks(brutoBendita);
    const tenant3 = { ...tenant, id: "t-bendita-trava2" };
    await executeTrinksTool(tenant3, call("listar_horarios", { data: "2026-11-02", servicoDuracao: 60 }), "556199841312");
    const res: any = await executeTrinksTool(
      tenant3,
      call("criar_agendamento", { servicoId: 1, profissionalId: 764030, dataHoraInicio: "2026-11-02T16:20:00", duracaoEmMinutos: 60, valor: 130, clienteId: 1 }),
      "556199841312",
    );
    // pode falhar mais adiante (o mock não cobre a criação), mas NÃO pela trava de grade
    expect(res.error ?? "").not.toContain("não está disponível em");
  });
});
