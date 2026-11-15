import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";

const source = readFileSync("supabase/functions/move-crm-lead/index.ts", "utf8")
  .replace(/^import .*;\s*/m, "");
const script = transformSync(source, { loader: "ts", format: "cjs" }).code;

async function run(staffAccess: boolean, accessError = false) {
  let handler: ((request: Request) => Promise<Response>) | undefined;
  let flags = ["29", "20"];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "has_role") return { data: false };
    expect(args).toEqual({ _user_id: "staff-user", _tenant_id: "alex-tenant" });
    return { data: staffAccess, error: accessError ? new Error("unavailable") : null };
  });
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "staff-user" } } }) },
    rpc,
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: async () => ({ error: null }),
        maybeSingle: async () => ({ data: table === "tenant_users" ? null : { id: "lead", flag_labels: flags } }),
        single: async () => ({ data: { id: "alex-tenant", uazapi_url: "https://instance.test", uazapi_token: "test-only" } }),
        update: (patch: { flag_labels: string[] }) => { flags = patch.flag_labels; return chain; },
      };
      // Queries chain eq before resolving single/maybeSingle.
      chain.eq = (() => chain) as unknown as typeof chain.eq;
      return chain;
    },
  };
  const send = vi.fn(async () => new Response("{}", { status: 200 }));
  new Function("createClient", "Deno", "fetch", script)(
    () => client,
    { env: { get: () => "test-only" }, serve: (fn: typeof handler) => { handler = fn; } },
    send,
  );
  if (!handler) throw new Error("Handler not registered");
  const response = await handler(new Request("https://app.test", {
    method: "POST",
    headers: { Authorization: "Bearer test-only", "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId: "alex-tenant", phoneNumber: "556183012868", toggleFlag: "29" }),
  }));
  return { response, flags, send };
}

describe("CRM recognizes existing tenant staff access", () => {
  it("allows granted staff to remove IA OFF 29, preserving label 20", async () => {
    const { response, flags, send } = await run(true);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ action: "removed", flagLabelId: "29" });
    expect(flags).toEqual(["20"]);
    expect(JSON.parse(send.mock.calls[0]?.[1]?.body as string)).toEqual({ number: "556183012868", remove_labelid: "29" });
  });
  it("denies staff without tenant access, without changing labels", async () => {
    const { response, flags, send } = await run(false);
    expect(response.status).toBe(403);
    expect(flags).toEqual(["29", "20"]);
    expect(send).not.toHaveBeenCalled();
  });
  it("fails closed if the existing access check fails", async () => {
    const { response, send } = await run(true, true);
    expect(response.status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });
});