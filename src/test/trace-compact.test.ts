import { describe, it, expect } from "vitest";
import {
  compactTraceBodies,
  sumOpenAiTotalTokens,
  isOpenAiHost,
  isUazapiHost,
  summarizeOpenAiResponse,
} from "../../supabase/functions/whatsapp-webhook/trace-compact.ts";

const OPENAI = "https://api.openai.com/v1/chat/completions";
const req = JSON.stringify({
  model: "gpt-5-mini",
  messages: [{ role: "system", content: "x".repeat(5000) }, { role: "user", content: "oi" }],
  tools: [{}, {}],
  tool_choice: "auto",
});
const res = JSON.stringify({
  model: "gpt-5-mini-2025-08-07",
  choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ function: { name: "criar_agendamento" } }] } }],
  usage: {
    prompt_tokens: 35693,
    completion_tokens: 73,
    total_tokens: 35766,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 64 },
  },
});

describe("trace-compact", () => {
  it("identifica hosts", () => {
    expect(isOpenAiHost(OPENAI)).toBe(true);
    expect(isOpenAiHost("https://evil.com/api.openai.com")).toBe(false);
    expect(isUazapiHost("https://zaylo.uazapi.com/send/text")).toBe(true);
    expect(isUazapiHost("https://notuazapi.com/x")).toBe(false);
  });

  it("OpenAI: nao guarda conteudo, guarda usage", () => {
    const c = compactTraceBodies(OPENAI, req, res)!;
    expect(c.request_body).not.toContain("xxxx");
    const rq = JSON.parse(c.request_body!);
    expect(rq).toMatchObject({ model: "gpt-5-mini", messages: 2, tools: 2, tool_choice: "auto", prompt_chars: 5002 });
    const rs = JSON.parse(c.response_body!);
    expect(rs.tool_calls).toEqual(["criar_agendamento"]);
    expect(rs.usage).toMatchObject({ prompt_tokens: 35693, cached_tokens: 0, completion_tokens: 73, reasoning_tokens: 64, total_tokens: 35766 });
  });

  it("OpenAI: corpo invalido nao quebra", () => {
    const c = compactTraceBodies(OPENAI, "nao json", "tambem nao")!;
    expect(JSON.parse(c.response_body!).unparsed).toBe(true);
    expect(summarizeOpenAiResponse(null)).toMatchObject({ unparsed: true });
  });

  it("UAZAPI: corta em 300", () => {
    const c = compactTraceBodies("https://a.uazapi.com/send/text", "y".repeat(1000), "ok")!;
    expect(c.request_body!.length).toBeLessThan(340);
    expect(c.request_body).toContain("(+700 chars)");
    expect(c.response_body).toBe("ok");
  });

  it("outros hosts nao sao tocados", () => {
    expect(compactTraceBodies("https://api.bemp.com.br/x", "a", "b")).toBeNull();
  });

  it("soma total_tokens so da OpenAI", () => {
    const c = compactTraceBodies(OPENAI, req, res)!;
    const entries = [
      { url: OPENAI, response_body: c.response_body },
      { url: OPENAI, response_body: c.response_body },
      { url: "https://api.bemp.com.br/x", response_body: res },
    ];
    expect(sumOpenAiTotalTokens(entries)).toBe(71532);
    expect(sumOpenAiTotalTokens([])).toBe(0);
  });
});
