import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// A trava mora dentro da função gigante do webhook. Este teste fixa os pontos que não podem regredir
// na remarcação fantasma da AppBarber (9Cinco, 24–31/10): ligada, reinjeta com motivo, nunca cancela a comanda nova.
const base = resolve(__dirname, "../../supabase/functions/whatsapp-webhook");
const idx = readFileSync(resolve(base, "index.ts"), "utf8");
const app = readFileSync(resolve(base, "providers/appbarber/index.ts"), "utf8");
const i = idx.indexOf("PHANTOM CANCEL/RESCHEDULE GUARD");
const bloco = idx.slice(i, idx.indexOf("STALE-CONFIRMATION GUARD", i));

describe("phantom_cancel_guard (remarcação sem cancelar)", () => {
  it("AppBarber saiu do modo sombra", () => {
    const cfg = app.slice(app.indexOf("export const phantomGuardConfig"), app.indexOf("export const phantomGuardConfig") + 1800);
    expect(cfg).toContain("shadow: false");
    expect(cfg).not.toContain("shadow: true");
  });
  it("reinjeta o motivo à IA em vez de mensagem genérica", () => {
    expect(bloco).toContain("phantom-cancel-reinject-r");
    expect(bloco).toContain("e NÃO cancelou o antigo");
    expect(bloco).not.toContain("Deixa eu confirmar esse cancelamento aqui rapidinho");
  });
  it("proíbe cancelar a comanda nova e exclui ela dos candidatos", () => {
    expect(bloco).toContain("NUNCA cancele a comanda nova");
    expect(bloco).toContain("code === newInvoice");
  });
  it("com mais de um candidato pergunta ao cliente, e só diz 'remarcado' após cancelar com sucesso", () => {
    expect(bloco).toContain("mais de um candidato");
    expect(bloco).toContain("Só diga 'remarcado' depois que cancelar_agendamento retornar sucesso");
  });
  it("sem recuperar, cai no fallback honesto (nunca segue com a alegação falsa)", () => {
    expect(bloco).toContain("buildGuardFailureFallback");
    expect(bloco).toContain("blocked_no_cancel_fallback");
  });
  it("mantém a leitura de ledger e do cancelamento bem-sucedido antes de agir", () => {
    expect(bloco).toContain("cancelSucceededThisTurn");
    expect(bloco).toContain("cancelInLedger");
  });
  it("cancelamento feito na reinjeção entra no ledger (senão o guard dispara de novo no turno seguinte)", () => {
    expect(bloco).toContain("recordCompletedAction(sessionState");
    expect(bloco).toContain("isMutatingToolName(tc?.function?.name, tenant)");
  });

  it("resposta final das reinjeções não usa mais 500 tokens fixos (gpt-5-mini gastava tudo raciocinando)", () => {
    for (const label of ["phantom-confirmation-final-answer", "phantom-cancel-final-answer", "stale-confirmation-final-answer"]) {
      const k = idx.indexOf(label);
      expect(k).toBeGreaterThan(-1);
      expect(idx.slice(Math.max(0, k - 260), k)).toContain("finalAnswerTokenLimits(modelUsed)");
    }
    const fn = idx.slice(idx.indexOf("function finalAnswerTokenLimits"), idx.indexOf("function finalAnswerTokenLimits") + 400);
    expect(fn).toContain("max_completion_tokens: 4096");
    expect(fn).toContain('reasoning_effort: "low"');
  });

  it("reinjeção do RescheduleGuard (cancelou o antigo, novo falhou) não usa 700 tokens fixos", () => {
    const k = idx.indexOf('"reschedule-guard-reinject"');
    expect(k).toBeGreaterThan(-1);
    const trecho = idx.slice(k - 700, k);
    expect(trecho).toContain("max_completion_tokens: _isGpt5Resched ? 4096 : 700");
    expect(trecho).toContain('reasoning_effort: "low"');
  });
});
