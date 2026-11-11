import { AsyncLocalStorage } from "node:async_hooks";

const transportContext = new AsyncLocalStorage<Map<string, string>>();
const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);

export function withUazapiTransport<T>(work: () => T): T {
  return transportContext.run(new Map(), work);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function lid(value: unknown): string | null {
  return typeof value === "string" && /^\d{1,20}@lid$/i.test(value.trim())
    ? value.trim().toLowerCase() : null;
}

export function resolveUazapiTarget(number: string): { primary: string; fallback: string | null } {
  const raw = number.trim();
  const preserved = transportContext.getStore()?.get(raw);
  const explicit = lid(raw);
  // Legacy numeric identities cannot be merged here. Length is only a transport fallback.
  const inferred = /^\d{14,15}$/.test(raw) ? `${raw}@lid` : null;
  const primary = preserved || explicit || inferred || number;
  return { primary, fallback: lid(primary) ? primary.replace(/@lid$/i, "") : null };
}

/** Only identity fields, never message content, names, URLs, tokens or the whole event. */
export function inboundLidEvidence(number: string, payload: unknown, message: unknown): Record<string, string | null> | null {
  const p = record(payload);
  const m = record(message);
  const chat = record(p.chat);
  const key = record(m.key);
  const fields: Record<string, unknown> = {
    "chat.wa_chatid": chat.wa_chatid, "chat.wa_chatlid": chat.wa_chatlid,
    "chat.phone": chat.phone, "payload.wa_chatid": p.wa_chatid,
    "payload.wa_chatlid": p.wa_chatlid, "payload.sender": p.sender,
    "payload.sender_pn": p.sender_pn, "payload.remoteJid": p.remoteJid,
    "message.wa_chatid": m.wa_chatid, "message.wa_chatlid": m.wa_chatlid,
    "message.sender": m.sender, "message.sender_pn": m.sender_pn,
    "message.sender_lid": m.sender_lid, "message.remoteJid": m.remoteJid,
    "message.chatid": m.chatid, "message.key.remoteJid": key.remoteJid,
  };
  const lids = Object.values(fields).map(lid).filter((v): v is string => v !== null);
  const digits = number.trim().replace(/@.*$/, "");
  // Only bind the event JID to the SAME numeric identity. Never associate a PN by guess.
  const matching = lids.find((v) => v.replace(/@lid$/, "") === digits) || lid(number);
  if (matching) transportContext.getStore()?.set(number.trim(), matching);
  if (!matching && !/^\d{14,15}$/.test(number.trim()) && lids.length === 0) return null;
  const evidence: Record<string, string | null> = { identity: number, transport_jid: matching };
  for (const [key, value] of Object.entries(fields)) {
    evidence[key] = typeof value === "string" && /^[+\d\s().-]{1,40}(?:@(s\.whatsapp\.net|c\.us|lid))?$/i.test(value)
      ? value : null;
  }
  return evidence;
}

/**
 * LID policy: primary JID once; on ANY HTTP failure (including 400/401/403),
 * one legacy-digits fallback. Auth failures on either leg end the operation:
 * no blind credential retries. After other failures, only transient statuses
 * may retry the legacy destination, within `attempts` (LID minimum budget: 2).
 * Normal PN sends retain the caller's budget and transient-only retry policy.
 * Presence and all /send/* endpoints use exactly the same target resolution.
 */
export async function uazapiRequest(
  url: string,
  init: RequestInit,
  options: { attempts?: number; fetcher?: typeof fetch; wait?: (ms: number) => Promise<void> } = {},
): Promise<Response> {
  const fetcher = options.fetcher || fetch;
  const wait = options.wait || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
  if (!body || typeof body.number !== "string") return fetcher(url, init);
  const target = resolveUazapiTarget(body.number);
  const budget = Math.max(target.fallback ? 2 : 1, options.attempts || 1);
  let authFailure = false;
  for (let attempt = 1; attempt <= budget; attempt++) {
    const destination = attempt === 1 ? target.primary : target.fallback || target.primary;
    let response: Response;
    try {
      response = await fetcher(url, {
        ...init,
        body: JSON.stringify({ ...body, number: destination, ...(attempt > 1 && "delay" in body ? { delay: 0 } : {}) }),
      });
    } catch (error) {
      if (attempt === budget || authFailure) throw error;
      await wait(attempt === 1 ? 800 : 2500);
      continue;
    }
    if (response.ok) return response;
    authFailure ||= response.status === 401 || response.status === 403;
    const requiredFallback = attempt === 1 && target.fallback !== null;
    if (attempt === budget || (!requiredFallback && (authFailure || !transientStatuses.has(response.status)))) return response;
    console.warn(`[UAZAPI Transport] ${new URL(url).pathname} status=${response.status} attempt=${attempt}/${budget} fallback=${requiredFallback}`);
    await response.arrayBuffer();
    await wait(attempt === 1 ? 800 : 2500);
  }
  throw new Error("UAZAPI transport exhausted");
}