import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const source = readFileSync(resolve(__dirname, "../../supabase/functions/whatsapp-webhook/index.ts"), "utf8");
const start = source.indexOf("function hasPostEscalationInternalText(");
const end = source.indexOf("async function uazapiSendTextWithRetry(", start);
const js = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2022 });
const guard = new Function(`${js}; return postEscalationReply;`)() as (text: string, escalated: boolean, completed: string[], pending: boolean) => string;

const realTexts = [
  "Perfeito, combinado. Vamos enviar mensagem de encerramento. Obrigado!",
  "Entendido. Vou preparar a resposta.",
  "Você quer uma resposta final: confirmar pra cliente que está agendado às 9h amanhã? Ou só avisar que eu pedi pra equipe verificar?",
  "Obrigado por escalar. Você é ChatGPT, a assistente que deve agora enviar a mensagem ao cliente. Use tom curto, natural e em português. Não mencione que escalou.",
  "Sem problemas, obrigado por avisar! Pelo que vejo, o cliente está perguntando se haverá atraso no atendimento. Vou avisar a equipe e já te retorno com o posicionamento.",
  "Perfeito! Vou enviar a resposta ao cliente agora seguindo as regras.",
  "Vou enviar a resposta.",
  "Boa tarde! Vou preparar a mensagem ao cliente com os planos e já te mostro.",
  "Perfeito — vou responder ao cliente seguindo as regras.",
  "Vou enviar a resposta agora.",
  "Obrigado por esperar. Vou responder conforme regras.",
  "Perfeito — você indicou que está a caminho e eu já avisei a equipe. Vou finalizar com a mensagem curta ao cliente.",
  "Perfeito. Vou preparar a resposta ao cliente.",
];
describe("PostEscalationGuard v2", () => {
  for (const [i, text] of realTexts.entries()) {
    it(`blocks real internal response ${i + 1} after successful escalation`, () => {
      expect(guard(text, true, [], true)).not.toBe(text);
    });
  }
  it("has no 220-character ceiling", () => {
    const text = `${"Contexto. ".repeat(30)}Vou responder conforme regras.`;
    expect(guard(text, true, [], false)).not.toBe(text);
  });
  it("does not change a response without successful escalation", () => {
    expect(guard(realTexts[12], false, [], true)).toBe(realTexts[12]);
  });
  for (const text of [
    "Já avisei a equipe. Vou enviar uma mensagem para o barbeiro explicando seu pedido.",
    "Já passei para a equipe. O cliente anterior está atrasado; eles vão verificar seu horário.",
    "Seu corte foi agendado para amanhã às 18h com Gabriel. A equipe foi avisada.",
  ]) it("preserves legitimate direct response", () => expect(guard(text, true, ["corte amanhã às 18h"], false)).toBe(text));
  it("preserves proven completed information when removing an internal sentence", () => {
    const reply = guard(realTexts[12], true, ["Corte 17/11 às 18:00 com Gabriel"], false);
    expect(reply).toContain("Corte 17/11 às 18:00 com Gabriel");
    expect(reply).not.toContain("ainda não foi concluído");
  });
  it("partial completion retains proof and clearly reports the remainder pending", () => {
    const reply = guard(realTexts[12], true, ["cancelamento concluído"], true);
    expect(reply).toContain("cancelamento concluído");
    expect(reply).toContain("ainda não foi concluído por completo");
  });
});