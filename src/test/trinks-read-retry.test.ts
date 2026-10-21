import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  trinksGetWithRetry,
  trinksServicesCache,
  executeTrinksTool,
  trinksSenderLocalPhone,
} from "../../supabase/functions/whatsapp-webhook/providers/trinks/index";

const tenant = { id: "t-bendita", trinks_api_key: "k", trinks_establishment_id: "1" };
const call = (name: string, args: Record<string, unknown> = {}) => ({ function: { name, arguments: JSON.stringify(args) } });
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const services = { data: [{ id: 1, nome: "Corte", preco: 45, duracaoEmMinutos: 40, categoria: "Cabelo" }] };

describe("Trinks: leituras com retry em 429", () => {
  beforeEach(() => {
    trinksServicesCache.clear();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("trinksGetWithRetry repete após 429 e devolve a resposta boa (caso Bendita 19/10)", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(429, { message: "Too Many Requests" }))
      .mockResolvedValueOnce(json(429, { message: "Too Many Requests" }))
      .mockResolvedValueOnce(json(200, services));
    vi.stubGlobal("fetch", fetchMock);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const res = await trinksGetWithRetry("https://x", {}, "teste", sleep);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls).toEqual([[1200], [3000]]);
  });

  it("não repete em erro que não é transitório (404)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(404, {}));
    vi.stubGlobal("fetch", fetchMock);
    const res = await trinksGetWithRetry("https://x", {}, "teste", async () => {});
    expect(res.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("desiste após 3 tentativas e devolve o último 429", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(429, { message: "Too Many Requests" }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await trinksGetWithRetry("https://x", {}, "teste", async () => {});
    expect(res.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("listar_servicos: 429 persistente sem cache devolve falha técnica recuperável (não um objeto cru)", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(429, { message: "Too Many Requests" })));
    const p = executeTrinksTool(tenant, call("listar_servicos"));
    await vi.runAllTimersAsync();
    const out = await p;
    expect(out.falha_tecnica).toBe(true);
    expect(out.recoverable).toBe(true);
    expect(out.status).toBe(429);
  });

  it("listar_servicos: segunda chamada usa o cache e não consulta a Trinks", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, services));
    vi.stubGlobal("fetch", fetchMock);
    const a = await executeTrinksTool(tenant, call("listar_servicos"));
    const b = await executeTrinksTool(tenant, call("listar_servicos"));
    expect(a).toEqual(b);
    expect(a[0].nome).toBe("Corte");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("listar_servicos: com a Trinks limitando e cache vencido, serve a última lista conhecida", async () => {
    vi.useFakeTimers();
    trinksServicesCache.set(tenant.id, { list: [{ id: 1, nome: "Corte" }], fetchedAt: Date.now() - 30 * 60 * 1000 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(429, { message: "Too Many Requests" })));
    const p = executeTrinksTool(tenant, call("listar_servicos"));
    await vi.runAllTimersAsync();
    const out = await p;
    expect(out).toEqual([{ id: 1, nome: "Corte" }]);
  });

  it("buscar_cliente: 429 persistente NÃO vira 'cliente não encontrado'", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(429, { message: "Too Many Requests" })));
    const p = executeTrinksTool(tenant, call("buscar_cliente", { telefone: "27999277010" }));
    await vi.runAllTimersAsync();
    const out = await p;
    expect(out.falha_tecnica).toBe(true);
    expect(out.data).toBeUndefined();
  });

  it.each([401, 403, 404, 500])("listar_servicos: HTTP %i não serve catálogo antigo", async (status) => {
    trinksServicesCache.set(tenant.id, {
      list: [{ id: 1, nome: "Corte" }], fetchedAt: Date.now() - 30 * 60 * 1000,
    });
    const fetchMock = vi.fn().mockImplementation(async () => json(status, {}));
    vi.stubGlobal("fetch", fetchMock);
    const out = await executeTrinksTool(tenant, call("listar_servicos"));
    expect(Array.isArray(out)).toBe(false);
    expect(out.status).toBe(status);
    expect(out.falha_tecnica).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([429, 502, 503, 504])("listar_servicos: HTTP %i permite catálogo antigo após 3 tentativas", async (status) => {
    vi.useFakeTimers();
    const list = [{ id: 1, nome: "Corte" }];
    trinksServicesCache.set(tenant.id, { list, fetchedAt: Date.now() - 30 * 60 * 1000 });
    const fetchMock = vi.fn().mockImplementation(async () => json(status, {}));
    vi.stubGlobal("fetch", fetchMock);
    const pending = executeTrinksTool(tenant, call("listar_servicos"));
    await vi.runAllTimersAsync();
    expect(await pending).toEqual(list);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("cache não compartilha catálogo entre barbearias", async () => {
    trinksServicesCache.set(tenant.id, { list: [{ id: 1, nome: "Corte" }], fetchedAt: Date.now() });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(200, { data: [{ id: 2, nome: "Barba" }] })));
    const out = await executeTrinksTool({ ...tenant, id: "outro-tenant" }, call("listar_servicos"));
    expect(out[0].id).toBe(2);
    expect(trinksServicesCache.get(tenant.id)?.list[0].id).toBe(1);
  });

  it("cache de 6 horas não é servido mesmo em 429", async () => {
    vi.useFakeTimers();
    trinksServicesCache.set(tenant.id, { list: [{ id: 1, nome: "Corte" }], fetchedAt: Date.now() - 6 * 60 * 60 * 1000 });
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => json(429, {})));
    const pending = executeTrinksTool(tenant, call("listar_servicos"));
    await vi.runAllTimersAsync();
    const out = await pending;
    expect(out.falha_tecnica).toBe(true);
    expect(out.status).toBe(429);
  });

  it("catálogo de 5 minutos é atualizado", async () => {
    vi.useFakeTimers();
    trinksServicesCache.set(tenant.id, { list: [{ id: 1, nome: "Antigo" }], fetchedAt: Date.now() - 5 * 60 * 1000 });
    const fetchMock = vi.fn().mockResolvedValue(json(200, services));
    vi.stubGlobal("fetch", fetchMock);
    const out = await executeTrinksTool(tenant, call("listar_servicos"));
    expect(out[0].nome).toBe("Corte");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("Trinks: telefone sempre o da conversa (caso Thallys 21/10)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("trinksSenderLocalPhone: normaliza e ignora o que não é número legível", () => {
    expect(trinksSenderLocalPhone("5516999628080")).toBe("16999628080");
    expect(trinksSenderLocalPhone("16999628080")).toBe("16999628080");
    expect(trinksSenderLocalPhone("SIM:3f2a-0000")).toBeNull();
    expect(trinksSenderLocalPhone("32281125241048")).toBeNull(); // LID
    expect(trinksSenderLocalPhone("")).toBeNull();
    expect(trinksSenderLocalPhone(undefined)).toBeNull();
  });

  it("buscar_cliente com telefone errado da IA consulta o número da conversa", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { data: [{ id: 1 }] }));
    vi.stubGlobal("fetch", fetchMock);
    await executeTrinksTool(tenant, call("buscar_cliente", { telefone: "169999628080" }), "5516999628080");
    expect(String(fetchMock.mock.calls[0][0])).toContain("telefone=16999628080");
  });

  it("cadastrar_cliente usa o telefone da conversa no corpo", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { id: 9 }));
    vi.stubGlobal("fetch", fetchMock);
    await executeTrinksTool(tenant, call("cadastrar_cliente", { nome: "Sergio", telefone: "169999628080" }), "5516999628080");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.telefones[0]).toMatchObject({ ddd: "16", numero: "999628080" });
  });

  it("sem número legível (simulador/LID) mantém o telefone que a IA passou", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await executeTrinksTool(tenant, call("buscar_cliente", { telefone: "27999277010" }), "SIM:abc");
    expect(String(fetchMock.mock.calls[0][0])).toContain("telefone=27999277010");
  });
});
