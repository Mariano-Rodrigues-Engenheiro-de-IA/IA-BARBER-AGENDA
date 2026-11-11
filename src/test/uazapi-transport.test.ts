import { describe, expect, it } from "vitest";
import { inboundLidEvidence, resolveUazapiTarget, uazapiRequest, withUazapiTransport } from "../../supabase/functions/_shared/uazapi-transport";

const number = "143761162109130";
const init = { method: "POST", body: JSON.stringify({ number, text: "teste", delay: 1200 }) };

describe("LID transport", () => {
  for (const status of [400, 401, 403, 404, 408, 429, 500, 502, 503, 504]) {
    it(`falls back after ${status}, including non-transient status`, async () => {
      const targets: string[] = [];
      const fetcher: typeof fetch = async (_url, options) => {
        targets.push(JSON.parse(String(options?.body)).number);
        return new Response("{}", { status: targets.length === 1 ? status : 200 });
      };
      const response = await uazapiRequest("https://example.test/send/text", init, { attempts: 3, fetcher, wait: async () => {} });
      expect(response.status).toBe(200);
      await response.text();
      expect(targets).toEqual([`${number}@lid`, number]);
    });
  }
  for (const status of [401, 403]) {
    it(`does not blindly retry auth ${status} after the single format fallback`, async () => {
      let calls = 0;
      const response = await uazapiRequest("https://example.test/send/text", init, {
        attempts: 5, wait: async () => {}, fetcher: async () => { calls++; return new Response("{}", { status }); },
      });
      await response.text();
      expect(calls).toBe(2);
    });
  }
  for (const path of ["send/text", "send/media", "send/location", "send/contact", "send/menu", "message/presence"]) {
    it(`uses LID for ${path}`, async () => {
      let destination = "";
      const response = await uazapiRequest(`https://example.test/${path}`, init, {
        fetcher: async (_url, options) => { destination = JSON.parse(String(options?.body)).number; return new Response("{}"); },
      });
      await response.text();
      expect(destination).toBe(`${number}@lid`);
    });
  }
  it("preserves a short event LID without changing numeric identity and excludes sensitive fields", () => withUazapiTransport(() => {
    const evidence = inboundLidEvidence("12345678901", { chat: { wa_chatlid: "12345678901@lid", phone: "554491625650", token: "secret" }, text: "private" }, {});
    expect(resolveUazapiTarget("12345678901").primary).toBe("12345678901@lid");
    expect(evidence?.["chat.phone"]).toBe("554491625650");
    expect(evidence).not.toHaveProperty("token");
    expect(evidence).not.toHaveProperty("text");
  }));
  it("does not guess a PN/LID link or share context between requests", async () => {
    await withUazapiTransport(async () => {
      inboundLidEvidence("12345678901", { chat: { wa_chatlid: "99999999999@lid" } }, {});
      expect(resolveUazapiTarget("12345678901").primary).toBe("12345678901");
    });
    expect(resolveUazapiTarget("12345678901").primary).toBe("12345678901");
  });
  it("normal PN retains transient retries and never gains a LID", async () => {
    const targets: string[] = [];
    const response = await uazapiRequest("https://example.test/send/text", { ...init, body: JSON.stringify({ number: "554491625650" }) }, {
      attempts: 3, wait: async () => {}, fetcher: async (_url, options) => { targets.push(JSON.parse(String(options?.body)).number); return new Response("{}", { status: 503 }); },
    });
    await response.text();
    expect(targets).toEqual(["554491625650", "554491625650", "554491625650"]);
  });
  it("does not retry a normal PN auth error", async () => {
    let calls = 0;
    const response = await uazapiRequest("https://example.test/send/text", { ...init, body: JSON.stringify({ number: "554491625650" }) }, {
      attempts: 3, fetcher: async () => { calls++; return new Response("{}", { status: 401 }); },
    });
    await response.text();
    expect(calls).toBe(1);
  });
});