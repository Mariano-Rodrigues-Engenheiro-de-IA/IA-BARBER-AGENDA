import { describe, it, expect } from "vitest";
import { splitTextWithLinks } from "@/lib/linkify";

describe("splitTextWithLinks", () => {
  it("texto sem link volta como um pedaço só", () => {
    expect(splitTextWithLinks("Oi, tudo bem?")).toEqual([{ type: "text", value: "Oi, tudo bem?" }]);
  });

  it("link no meio do texto", () => {
    expect(splitTextWithLinks("Acesse https://exemplo.com/a?x=1 agora")).toEqual([
      { type: "text", value: "Acesse " },
      { type: "link", value: "https://exemplo.com/a?x=1" },
      { type: "text", value: " agora" },
    ]);
  });

  it("ponto final colado ao link fica fora do link", () => {
    expect(splitTextWithLinks("Veja https://exemplo.com/plano.")).toEqual([
      { type: "text", value: "Veja " },
      { type: "link", value: "https://exemplo.com/plano" },
      { type: "text", value: "." },
    ]);
  });

  it("dois links e quebra de linha", () => {
    const parts = splitTextWithLinks("a http://um.com\nb https://dois.com/x");
    expect(parts.filter((p) => p.type === "link").map((p) => p.value)).toEqual([
      "http://um.com",
      "https://dois.com/x",
    ]);
    expect(parts.map((p) => p.value).join("")).toBe("a http://um.com\nb https://dois.com/x");
  });

  it("link da Frizzar com parâmetro", () => {
    const url = "https://admin.frizzar.com.br/assinatura/assinaturas.xhtml?empresa=bbbarbearia";
    expect(splitTextWithLinks(`Link: ${url}`)).toEqual([
      { type: "text", value: "Link: " },
      { type: "link", value: url },
    ]);
  });

  it("HTML e javascript: nunca viram link", () => {
    const t = '<script>alert(1)</script> javascript:alert(1) <a href="x">y</a>';
    const parts = splitTextWithLinks(t);
    expect(parts.every((p) => p.type === "text")).toBe(true);
    expect(parts.map((p) => p.value).join("")).toBe(t);
  });

  it("só o protocolo não vira link", () => {
    expect(splitTextWithLinks("veja https:// depois")).toEqual([{ type: "text", value: "veja https:// depois" }]);
  });

  it("texto vazio", () => {
    expect(splitTextWithLinks("")).toEqual([]);
  });
});
