import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import {
  trinksActiveCompletionClaim,
  trinksRecentOfferSelection,
  trinksHasPositiveCreation,
  trinksRecoveryClaimBlockReason,
  phantomGuardConfig,
  trinksPhantomRecoveryInstruction,
} from "../../supabase/functions/whatsapp-webhook/providers/trinks/index";
import { appBarberClaimsCompletedBooking } from "../../supabase/functions/whatsapp-webhook/providers/appbarber/guard-core";

const offer = "Para quarta com Vinicius tenho 18h40 ou 19h20. Qual prefere?";
const history = [{ role: "assistant", content: offer, created_at: "2026-11-16T11:42:51Z" }];
const selection = "18:40 e cabelo e orelha ok?";
const creation = (result: unknown, time = "2026-11-18T18:40:00") => ({
  name: "criar_agendamento", args: { dataHoraInicio: time }, result,
});

// Execute o bloco real do dispatcher com transporte/IA simulados: nenhuma escrita externa.
const source = readFileSync(resolve(__dirname, "../../supabase/functions/whatsapp-webhook/index.ts"), "utf8");
const start = source.indexOf("  if (finalResponse && !guardOverrideResponse && _bookingAttempts === 0 && _phantomCfg)");
const end = source.indexOf("  // ============================================================================\n  // 🛡️ PHANTOM CANCEL/RESCHEDULE GUARD", start);
async function runGuard(provider: string, responses: Array<Record<string, unknown>>) {
  const logToolCalls: Array<Record<string, unknown>> = [];
  const messages: Array<Record<string, unknown>> = [];
  const execute = vi.fn().mockResolvedValue([{ id: 1, nome: "Corte", preco: 45 }]);
  const fallback = vi.fn().mockResolvedValue("Não consegui concluir; pedido encaminhado à equipe.");
  const fetchAI = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: responses.shift() || {} }] }), { status: 200 }));
  const dependencies = {
    provider, history, userMessage: selection, _bookingAttempts: 0, _phantomCfg: phantomGuardConfig,
    sessionState: { recentCompletedActions: [] }, logToolCalls, messages, logErrors: [],
    tenant: {}, phoneNumber: "5516997503361", supabase: {}, simulatorMode: true, modelUsed: "gpt-5-mini",
    trinksRecentOfferSelection, trinksActiveCompletionClaim, trinksHasPositiveCreation,
    trinksRecoveryClaimBlockReason, trinksPhantomRecoveryInstruction, appBarberClaimsCompletedBooking,
    getLastAssistantMessage: () => offer, isAffirmativeReply: () => false,
    isBookingTimeConfirmationPrompt: () => false, isActiveBookingLookupStillValid: () => false,
    responseCitesLookupBooking: () => false, buildToolsForProvider: () => [],
    fetchAIWithRetry: fetchAI, executeToolForProvider: execute,
    parseToolArguments: (s: string) => JSON.parse(s), buildDeterministicBookingConfirmation: () => null,
    finalAnswerTokenLimits: () => ({}), buildGuardFailureFallback: fallback,
  };
  const body = ts.transpileModule(`async function exercise() {
    let finalResponse = "Já deixei confirmado pra quarta às 18h40";
    let guardOverrideResponse = false;
    ${source.slice(start, end)}
    return { finalResponse, guardOverrideResponse };
  }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const fn = new Function(...Object.keys(dependencies), `${body}\n return exercise();`);
  const result = await fn(...Object.values(dependencies)) as { finalResponse: string; guardOverrideResponse: boolean };
  return { result, execute, fallback, messages, logToolCalls, fetchAI };
}
describe("Trinks — fluxo real do PhantomConfirmationGuard", () => {
  it("471d0a10: bloqueia criar na escolha e devolve motivo à IA, retornando resumo", async () => {
    const tool = { id: "c1", type: "function", function: { name: "criar_agendamento", arguments: "{}" } };
    const summary = "Quarta às 18h40 com Vinicius: corte + depilação de orelha, R$ 60. Posso confirmar?";
    const flow = await runGuard("trinks", [{ tool_calls: [tool] }, { content: summary }, { content: summary }]);
    expect(flow.execute).not.toHaveBeenCalled();
    expect(flow.logToolCalls.some((c) => c.name === "criar_agendamento" && (c.result as { blocked?: boolean }).blocked)).toBe(true);
    expect(flow.messages.some((m) => m.role === "tool" && String(m.content).includes("Escolha de horário não autoriza criação"))).toBe(true);
    expect(flow.result.finalResponse).toBe(summary);
    expect(flow.fallback).not.toHaveBeenCalled();
  });
  it("listar_* não destrava promessa: todas as saídas inválidas caem no fallback", async () => {
    const tool = { id: "c1", type: "function", function: { name: "listar_servicos", arguments: "{}" } };
    const claim = "Já deixei confirmado pra quarta às 18h40";
    const flow = await runGuard("trinks", [{ tool_calls: [tool] }, { content: claim }, { content: claim }, { content: claim }]);
    expect(flow.execute).toHaveBeenCalledTimes(1);
    expect(flow.fallback).toHaveBeenCalledTimes(1);
    expect(flow.result.finalResponse).not.toBe(claim);
    expect(flow.messages.some((m) => m.role === "system" && String(m.content).includes("Texto bloqueado"))).toBe(true);
  });
  it.each(["frizzar", "onebeleza", "bemp"])("não aplica o novo caminho ao provider %s", async (provider) => {
    const flow = await runGuard(provider, []);
    expect(flow.fetchAI).not.toHaveBeenCalled();
    expect(flow.result.finalResponse).toBe("Já deixei confirmado pra quarta às 18h40");
  });
});

describe("Trinks — corte de confirmação fantasma", () => {
  it("471d0a10: detecta escolha única com pergunta de serviço, mas não comprova escrita", () => {
    expect(trinksRecentOfferSelection(history, selection)?.selectedTime).toBe("18:40");
    const claim = "Já deixei confirmado pra quarta às 18h40";
    expect(trinksActiveCompletionClaim(claim)).toBe(true);
    expect(trinksRecoveryClaimBlockReason(claim, [], true)).not.toBeNull();
  });
  it("junta lista de horários e Qual prefere da mesma sequência", () => {
    const split = [
      { ...history[0], content: "Tenho 18h40 ou 19h20 com Vinicius.", created_at: "2026-11-16T11:42:51Z" },
      { ...history[0], content: "Qual prefere?", created_at: "2026-11-16T11:42:54Z" },
      { role: "user", content: selection, created_at: "2026-11-16T11:43:55Z" },
    ];
    expect(trinksRecentOfferSelection(split, selection)?.selectedTime).toBe("18:40");
  });
  it("não atravessa entrada anterior, mensagem humana nem rodada antiga", () => {
    for (const separator of [
      { role: "user", content: "Outra dúvida" },
      { role: "assistant", content: "[ATENDENTE HUMANO] Olá" },
    ]) {
      expect(trinksRecentOfferSelection([history[0], separator, { role: "assistant", content: "Qual prefere?" }], selection)).toBeNull();
    }
    expect(trinksRecentOfferSelection([history[0], { role: "assistant", content: "Qual prefere?", created_at: "2026-11-16T11:48:00Z" }], selection)).toBeNull();
    expect(trinksRecentOfferSelection([...history, { role: "user", content: selection, created_at: "2026-11-16T12:00:00Z" }], selection)).toBeNull();
  });
  it.each(["remarcar", "cancelar", "alterar", "retirar produto", "lembrete: você agendou"])("exclui contexto %s", (context) => {
    expect(trinksRecentOfferSelection([{ role: "assistant", content: `${context}. ${offer}` }], selection)).toBeNull();
  });
  it("mantém confirmação humana/existente fora de oferta de criação nova", () => {
    expect(trinksRecentOfferSelection([{ role: "assistant", content: "[ATENDENTE HUMANO] Você agendou quarta 18h40. Podemos confirmar?" }], "18h40 confirmado")).toBeNull();
    expect(trinksRecentOfferSelection([{ role: "assistant", content: "Você agendou quarta 18h40. Podemos confirmar seu horário?" }], "18h40 confirmado")).toBeNull();
  });
  it.each(["18h40 ou 19h20", "20h00"])("não resolve escolha ambígua ou incompatível %s", (text) => {
    expect(trinksRecentOfferSelection(history, text)).toBeNull();
  });
  it.each(["deixei", "já deixei", "deixamos"])("reconhece forma ativa %s", (verb) => {
    expect(trinksActiveCompletionClaim(`${verb} seu atendimento com Vinicius garantido às 18h40.`)).toBe(true);
  });
  it.each(["Seu horário está confirmado.", "Não deixei confirmado.", "Deixei reservado, mas preciso do nome para finalizar.", "Quer que eu deixe confirmado?"])("não amplia detector ativo indevidamente: %s", (text) => {
    expect(trinksActiveCompletionClaim(text)).toBe(false);
  });
  it("listar serviços não autoriza a saída afirmando conclusão", () => {
    expect(trinksRecoveryClaimBlockReason("Confirmado quarta 18h40", [{ name: "listar_servicos", result: [{ id: 1 }] }], true)).not.toBeNull();
  });
  it.each([{}, { success: true }, { data: [] }, { id: "duplicate", blocked: true }, { id: 5, error: "falhou" }, { id: 5, success: false }])("retorno sem ID positivo ou falho não comprova criação: %j", (r) => {
    expect(trinksHasPositiveCreation(creation(r))).toBe(false);
  });
  it("ID positivo correspondente permite conclusão; outro minuto/dia não", () => {
    const calls = [creation({ id: 123 })];
    expect(trinksHasPositiveCreation(calls[0])).toBe(true);
    expect(trinksRecoveryClaimBlockReason("Confirmado quarta 18h40", calls, true)).toBeNull();
    expect(trinksRecoveryClaimBlockReason("Confirmado quarta 18h20", calls, true)).not.toBeNull();
    expect(trinksRecoveryClaimBlockReason("Confirmado quinta 18h40", calls, true)).not.toBeNull();
  });
  it("consulta legítima compatível permite reconfirmação; vazia/inativa/bloqueada não", () => {
    const data = [{ id: 123, dataHoraInicio: "2026-11-18T18:40:00" }];
    expect(trinksRecoveryClaimBlockReason("Confirmado quarta 18h40", [{ name: "buscar_agendamento", result: { data } }], true)).toBeNull();
    for (const result of [{ data: [] }, { inativos: data }, { data, blocked: true }]) {
      expect(trinksRecoveryClaimBlockReason("Confirmado quarta 18h40", [{ name: "buscar_agendamento", result }], true)).not.toBeNull();
    }
  });
  it("resumo e pergunta não exigem escrita", () => {
    expect(trinksRecoveryClaimBlockReason("Quarta 18h40, Vinicius, corte + orelha. Posso confirmar?", [], false)).toBeNull();
  });
  it.each([
    ["5e6ed378", "agendado com o Tallys amanhã às 11h40"],
    ["f6477e7b", "está tudo confirmado: seu pezinho com o Ramon às 10h20"],
    ["471d0a10", "Já deixei confirmado pra quarta às 18h40"],
  ])("fixture real %s sem escrita não sustenta conclusão", (_id, claim) => {
    expect(trinksRecoveryClaimBlockReason(claim, [], true)).not.toBeNull();
  });
  it("preserva shadow da Trinks e detector AppBarber", () => {
    expect(phantomGuardConfig.shadow).toBe(true);
    expect(appBarberClaimsCompletedBooking("Já deixei reservado às 10h")).toBe(true);
    expect(appBarberClaimsCompletedBooking("Deixamos seu atendimento garantido às 18h40")).toBe(false);
  });
});