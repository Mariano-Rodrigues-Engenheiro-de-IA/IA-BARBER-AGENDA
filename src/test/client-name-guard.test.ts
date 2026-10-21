import { describe, it, expect } from "vitest";
import {
  isNameBackedByConversation,
  profileNameForRegistration,
  resolveProfileNameForRegistration,
} from "../../supabase/functions/whatsapp-webhook/client-name-guard";

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
  it("barra Carlos e Silva separados por outras palavras", () => {
    expect(isNameBackedByConversation("Carlos Silva", "", "Quero atendimento com Carlos; meu irmão é Silva.")).toBe(false);
  });
  it("barra palavras em ordem invertida", () => {
    expect(isNameBackedByConversation("Carlos Silva", "", "Silva Carlos")).toBe(false);
  });
  it("não usa uma única ocorrência para inventar nome repetido", () => {
    expect(isNameBackedByConversation("José José", "", "Quero falar com José amanhã")).toBe(false);
  });
  it("aceita nome completo na sequência com espaços e acentos normalizados", () => {
    expect(isNameBackedByConversation("João Álvares", "", "Meu nome é JOAO   ALVARES, pode marcar")).toBe(true);
  });
  it("não confunde parte de sobrenome com o sobrenome completo", () => {
    expect(isNameBackedByConversation("Carlos Silva", "", "Carlos Silvano")).toBe(false);
  });
  it("preserva igualdade com perfil contendo emoji", () => {
    expect(isNameBackedByConversation("Vini Bocchi", "Vini Bocchi 😎", "Quero cortar amanhã")).toBe(true);
  });
  it("nome de uma palavra só não passa pela conversa", () => {
    expect(isNameBackedByConversation("Carlos", "", "Carlos")).toBe(false);
  });
  it("vazio nunca passa", () => {
    expect(isNameBackedByConversation("", "Vini Bocchi", "oi")).toBe(false);
    expect(isNameBackedByConversation(null, null, null)).toBe(false);
  });
});

describe("nome do perfil de uma palavra só / com números (caso Thallys 21/10)", () => {
  it("'Sergio' (1 palavra) vira nome de cadastro", () => {
    expect(profileNameForRegistration("Sergio")).toBe("Sergio");
    expect(resolveProfileNameForRegistration("Sergio", "Sergio")).toBe("Sergio");
  });
  it("apelido com números perde os números", () => {
    expect(profileNameForRegistration("nicolasdaniel57035")).toBe("Nicolasdaniel");
    expect(resolveProfileNameForRegistration("nicolasdaniel57035", "nicolasdaniel57035")).toBe("Nicolasdaniel");
    expect(resolveProfileNameForRegistration("Nicolasdaniel", "nicolasdaniel57035")).toBe("Nicolasdaniel");
  });
  it("emojis e símbolos saem; minúsculas viram capitalizadas", () => {
    expect(profileNameForRegistration("fer giga 🔥")).toBe("Fer Giga");
  });
  it("sem nome utilizável no perfil → null (continua escalando)", () => {
    expect(profileNameForRegistration("🔥🔥")).toBeNull();
    expect(profileNameForRegistration("12345")).toBeNull();
    expect(profileNameForRegistration("")).toBeNull();
    expect(profileNameForRegistration(undefined)).toBeNull();
  });
  it("nome inventado pela IA que não é o do perfil continua barrado", () => {
    expect(resolveProfileNameForRegistration("Carlos", "Sergio")).toBeNull();
    expect(resolveProfileNameForRegistration("Joao", "")).toBeNull();
  });
});
