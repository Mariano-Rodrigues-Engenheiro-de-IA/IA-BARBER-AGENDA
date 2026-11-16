import { describe, expect, it } from "vitest";
import {
  trinksActiveCompletionClaim,
  trinksRecentOfferSelection,
  trinksHasPositiveCreation,
  trinksRecoveryClaimBlockReason,
  phantomGuardConfig,
} from "../../supabase/functions/whatsapp-webhook/providers/trinks/index";
import { appBarberClaimsCompletedBooking } from "../../supabase/functions/whatsapp-webhook/providers/appbarber/guard-core";

const offer = "Para quarta com Vinicius tenho 18h40 ou 19h20. Qual prefere?";
const history = [{ role: "assistant", content: offer, created_at: "2026-11-16T11:42:51Z" }];
const selection = "18:40 e cabelo e orelha ok?";
const creation = (result: unknown, time = "2026-11-18T18:40:00") => ({
  name: "criar_agendamento", args: { dataHoraInicio: time }, result,
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