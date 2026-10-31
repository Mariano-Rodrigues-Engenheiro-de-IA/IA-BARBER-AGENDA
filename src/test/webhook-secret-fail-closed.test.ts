import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Regra do projeto: WHATSAPP_WEBHOOK_SECRET nunca pode virar opcional (fail-open).
// O handler roda em Deno.serve, então o teste fixa o texto dos dois pontos de checagem.
const src = readFileSync(resolve(__dirname, "../../supabase/functions/whatsapp-webhook/index.ts"), "utf8");

describe("WHATSAPP_WEBHOOK_SECRET é fail-closed", () => {
  it("a pré-checagem do background recusa quando o segredo não está configurado", () => {
    const i = src.indexOf("function webhookSecretOk");
    const trecho = src.slice(i, i + 700);
    expect(trecho).toContain("if (!webhookSecret) {");
    expect(trecho).toContain("return false;");
    expect(trecho).not.toContain("if (!webhookSecret) return true");
  });
  it("o handler responde 503 quando o segredo não está configurado e não aceita requisição sem assinatura", () => {
    expect(src).toContain('JSON.stringify({ error: "Webhook secret not configured" })');
    expect(src).toContain("status: 503");
    expect(src).not.toContain("accepting unsigned requests");
  });
  it("webchat e simulador continuam fora da checagem (retornam antes dela)", () => {
    const secret = src.indexOf("WHATSAPP_WEBHOOK_SECRET é OBRIGATÓRIO");
    expect(src.indexOf('req.headers.get("x-mode") === "webchat"')).toBeLessThan(secret);
    expect(src.indexOf('req.headers.get("x-mode") === "simulator"')).toBeLessThan(secret);
  });
});
