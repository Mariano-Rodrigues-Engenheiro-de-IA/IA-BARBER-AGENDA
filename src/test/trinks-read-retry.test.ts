import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  trinksGetWithRetry,
  trinksServicesCache,
  executeTrinksTool,
} from "../../supabase/functions/whatsapp-webhook/providers/trinks/index";

const tenant = { id: "t-bendita", trinks_api_key: "k", trinks_establishment_id: "1" };
const call = (name: string, args: any = {}) => ({ function: { name, arguments: JSON.stringify(args) } });
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
    expect(out.dica).toMatch(/não escale/i);
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
});
