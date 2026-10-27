import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// O retorno de escalar_humano mora dentro da função gigante do webhook (sem como chamá-la isolada).
// Este teste só garante que o texto que a IA lê continua proibindo "marquei/remarquei" quando a ação não foi feita.
describe("escalar_humano: mensagem que orienta a IA depois de escalar (caso Thallys 26/10)", () => {
  const src = readFileSync(resolve(__dirname, "../../supabase/functions/whatsapp-webhook/index.ts"), "utf8");
  const i = src.indexOf("Atendimento escalado para humano (etiqueta aplicada e atendente avisado).");
  const trecho = src.slice(i, i + 900);

  it("existe e mantém o aviso original de que nada foi enviado ao cliente", () => {
    expect(i).toBeGreaterThan(-1);
    expect(trecho).toContain("Nenhuma mensagem foi enviada ao cliente");
  });
  it("manda deixar claro que a ação NÃO foi concluída e proíbe 'marquei com a equipe'", () => {
    expect(trecho).toContain("NÃO foi concluído");
    expect(trecho).toContain("a equipe vai finalizar");
    expect(trecho).toContain("NUNCA escreva");
    expect(trecho).toContain("marquei com a equipe");
  });
});
