import { describe, it, expect } from "vitest";
import { isNameBackedByConversation } from "../../supabase/functions/whatsapp-webhook/client-name-guard";

describe("isNameBackedByConversation", () => {
  it("caso Thallys 20/10: nome do perfil do WhatsApp passa", () => {
    expect(isNameBackedByConversation("Vini Bocchi", "Vini Bocchi", "Marca as 14:00 com o Vinicius, meu xará\nKkkk")).toBe(true);
  });
  it("ignora acento e caixa no perfil", () => {
    expect(isNameBackedByConversation("João Álvares", "joao alvares", "oi")).toBe(true);
  });
  it("caso Bendita 20/10: nome digitado junto de outras linhas passa", () => {
    expect(isNameBackedByConversation("Vilmar Boeira", "", "Que estava disponível\nVilmar Boeira")).toBe(true);
  });
  it("nome inventado pela IA (sem perfil nem conversa) continua barrado", () => {
    expect(isNameBackedByConversation("Carlos Silva", "Vini Bocchi", "Quero cortar o cabelo hoje às 14h")).toBe(false);
  });
  it("só um sobrenome da conversa não basta", () => {
    expect(isNameBackedByConversation("Pedro Boeira", "", "Vilmar Boeira")).toBe(false);
  });
  it("nome de uma palavra só não passa pela conversa", () => {
    expect(isNameBackedByConversation("Carlos", "", "Carlos")).toBe(false);
  });
  it("vazio nunca passa", () => {
    expect(isNameBackedByConversation("", "Vini Bocchi", "oi")).toBe(false);
    expect(isNameBackedByConversation(null, null, null)).toBe(false);
  });
});
