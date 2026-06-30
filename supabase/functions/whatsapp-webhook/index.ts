import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { buildTrinksPromptSection, buildOneBelezaPromptSection, buildNonePromptSection, buildFrizzarPromptSection, buildBempPromptSection, buildZayloPromptSection, buildAppBarberPromptSection } from "../_shared/provider-prompts.ts";

// ─────────────────────────────────────────────────────────────────────────────
// CelCash / GalaxPay — consulta LOCAL na tabela celcash_subscribers.
// A tabela é populada automaticamente a cada 1h pela função sync-celcash-subscribers.
// Aqui só lemos do banco (rápido, sem chamada externa).
// ─────────────────────────────────────────────────────────────────────────────
function celcashPhoneVariants(phone: string): string[] {
  const digits = (phone || "").replace(/\D/g, "");
  if (!digits) return [];
  const set = new Set<string>();

  // Normaliza para "55 + DDD + número" (sem +)
  let national = digits;
  if (!national.startsWith("55")) {
    if (national.length === 10 || national.length === 11) national = `55${national}`;
  }
  set.add(`+${digits}`);
  set.add(`+${national}`);

  // Se começa com 55, gera variantes com/sem o 9 do celular BR
  if (national.startsWith("55") && national.length >= 12) {
    const ddd = national.slice(2, 4);
    const rest = national.slice(4);
    // Versão sem o 9 inicial (ex.: 8 dígitos)
    if (rest.length === 9 && rest.startsWith("9")) {
      set.add(`+55${ddd}${rest.slice(1)}`);
    }
    // Versão com o 9 inicial (ex.: 9 dígitos)
    if (rest.length === 8) {
      set.add(`+55${ddd}9${rest}`);
    }
    // Também a forma sem DDI
    set.add(`+${national.slice(2)}`);
  }
  return Array.from(set);
}

async function getCelCashContextCached(supabase: any, tenant: any, phoneNumber: string): Promise<any | null> {
  if (!tenant?.celcash_enabled) return null;

  const variants = celcashPhoneVariants(phoneNumber);
  if (!variants.length) return { found: false };

  try {
    const { data, error } = await supabase
      .from("celcash_subscribers")
      .select("celcash_customer_id, celcash_subscription_id, name, document, plan_name, plan_id, status, is_overdue, overdue_amount_cents, next_due_date, last_payment_date, phone_e164, raw_payload")
      .eq("tenant_id", tenant.id)
      .in("phone_e164", variants)
      .order("synced_at", { ascending: false })
      .limit(5);

    if (error) {
      console.warn("[CelCash] Local lookup error:", error.message);
      return null;
    }
    if (!data || data.length === 0) return { found: false };

    // Agrupa por customer (a IA verá uma "ficha" do cliente + suas assinaturas)
    const first = data[0];
    const subscriptions = data.map((s: any) => {
      const raw = s.raw_payload || {};
      return {
        galaxPayId: s.celcash_subscription_id,
        status: s.status,
        value: raw.value ?? null,
        periodicity: raw.periodicity ?? null,
        planName: s.plan_name,
        nextPayDay: s.next_due_date,
      };
    });

    const overdue: any[] = [];
    for (const s of data) {
      if (s.is_overdue && (s.overdue_amount_cents || 0) > 0) {
        overdue.push({
          payday: s.next_due_date,
          value: s.overdue_amount_cents,
          status: s.status,
          statusDescription: "Em atraso",
          subscriptionGalaxPayId: s.celcash_subscription_id,
        });
      }
    }

    return {
      found: true,
      customer: {
        name: first.name,
        document: first.document,
        galaxPayId: first.celcash_customer_id,
      },
      subscriptions,
      overdue,
    };
  } catch (e) {
    console.warn("[CelCash] Local lookup exception:", (e as any)?.message);
    return null;
  }
}

function formatCelCashContextBlock(ctx: any): string {
  if (!ctx) return "";
  if (ctx.found === false) {
    return `
## 💳 ASSINATURA E AGENDAMENTO (Bemp + CelCash)

[CELCASH] Este telefone NÃO está na base de assinantes ATIVOS.
→ Trate como CLIENTE AVULSO. Ao agendar, use o serviço solicitado em modo
  pago/avulso (corte avulso, barba avulsa, etc). NÃO ofereça nem assuma
  benefício de plano de assinatura.`;
  }
  const sub = (ctx.subscriptions || [])[0] || {};
  const planLabel = sub.planName || (sub.planMyId || sub.planGalaxPayId ? `Plano #${sub.planMyId || sub.planGalaxPayId}` : "plano sem nome");
  return `
## 💳 ASSINATURA E AGENDAMENTO (Bemp + CelCash)

[CELCASH] Cliente é ASSINANTE ATIVO.
- Nome no CelCash: ${ctx.customer?.name || "—"}
- Plano: ${planLabel}

→ Ao agendar, use o serviço correspondente ao plano dele (${planLabel}).
→ Se a tool **agendar** retornar erro do tipo \`subscription_overdue\`
  (pagamento pendente / inadimplência / assinatura em atraso), NÃO tente
  agendar de novo. Envie EXATAMENTE:
  "Não consegui concluir seu agendamento porque há um pagamento pendente
  na sua assinatura. Deseja regularizar?"
  e aguarde a resposta. NÃO envie link de pagamento. NÃO escale humano
  automaticamente.`;
}



// ─────────────────────────────────────────────────────────────────────────────
// Audio transcription via OpenAI Whisper (gpt-4o-mini-transcribe).
// Handles WhatsApp's OGG/Opus format reliably. Returns text or null on failure.
// ─────────────────────────────────────────────────────────────────────────────
async function transcribeAudioViaGemini(
  base64: string,
  mimeType: string,
): Promise<string | null> {
  try {
    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) {
      console.warn("[Transcribe] OPENAI_API_KEY ausente — pulando transcrição");
      return null;
    }

    // Decode base64 → bytes → Blob
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    // Infer extension from mimeType (WhatsApp normally sends audio/ogg; codecs=opus).
    const mt = (mimeType || "audio/ogg").toLowerCase();
    let ext = "ogg";
    if (mt.includes("mpeg") || mt.includes("mp3")) ext = "mp3";
    else if (mt.includes("wav")) ext = "wav";
    else if (mt.includes("m4a") || mt.includes("mp4")) ext = "m4a";
    else if (mt.includes("webm")) ext = "webm";
    else if (mt.includes("ogg") || mt.includes("opus")) ext = "ogg";

    const blob = new Blob([bytes], { type: mt.split(";")[0] || "audio/ogg" });
    const form = new FormData();
    form.append("file", blob, `audio.${ext}`);
    form.append("model", "gpt-4o-mini-transcribe");
    form.append("language", "pt");
    form.append("response_format", "text");

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!res.ok) {
      console.warn(`[Transcribe] HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return null;
    }
    const text = (await res.text()).trim();
    if (!text) return null;
    return text;
  } catch (e) {
    console.warn("[Transcribe] erro:", e);
    return null;
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 8192;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }

  return btoa(binary);
}

function normalizeIncomingMediaMimeType(
  mimeType: string | null | undefined,
  isAudioMessage: boolean,
  isImageMessage: boolean,
): string | null {
  const raw = String(mimeType || "").trim().toLowerCase();

  if (!raw) {
    return isAudioMessage ? "audio/ogg" : isImageMessage ? "image/jpeg" : null;
  }

  if (raw.startsWith("audio/") || raw.startsWith("image/") || raw.startsWith("video/")) {
    return raw.split(";")[0];
  }

  if (raw.includes("opus") || raw.includes("ogg")) return "audio/ogg";
  if (raw.includes("mpeg") || raw.includes("mp3")) return "audio/mpeg";
  if (raw.includes("wav")) return "audio/wav";
  if (raw.includes("m4a") || raw.includes("mp4") || raw.includes("aac")) return "audio/mp4";
  if (raw.includes("webm")) return "audio/webm";
  if (raw.includes("jpeg") || raw.includes("jpg")) return "image/jpeg";
  if (raw.includes("png")) return "image/png";

  if (raw === "application/octet-stream" || raw === "binary/octet-stream") {
    return isAudioMessage ? "audio/ogg" : isImageMessage ? "image/jpeg" : raw;
  }

  return raw;
}

async function resolveIncomingMedia({
  payload,
  msg,
  messageId,
  uazapiUrl,
  uazapiToken,
  isAudioMessage,
  isImageMessage,
}: {
  payload: any;
  msg: any;
  messageId: string | null;
  uazapiUrl: string;
  uazapiToken: string;
  isAudioMessage: boolean;
  isImageMessage: boolean;
}): Promise<{ base64: string | null; mimeType: string | null }> {
  const fallbackMimeType = normalizeIncomingMediaMimeType(null, isAudioMessage, isImageMessage);

  const tryInlineSource = async (source: any, label: string): Promise<{ base64: string; mimeType: string | null } | null> => {
    if (!source || typeof source !== "object") return null;

    const inlineMime = normalizeIncomingMediaMimeType(
      source.mimetype || source.mimeType || source.mediaType || source.type || fallbackMimeType,
      isAudioMessage,
      isImageMessage,
    );

    const base64Candidate = [source.base64, source.data, source.file, source.content]
      .find((value) => typeof value === "string" && value.length > 100);

    if (typeof base64Candidate === "string") {
      if (base64Candidate.startsWith("data:")) {
        const [header, data] = base64Candidate.split(",", 2);
        const mimeFromHeader = header.match(/data:([^;]+)/)?.[1] || inlineMime;
        console.log(`[Media] Resolved inline data URL from ${label}`);
        return {
          base64: data,
          mimeType: normalizeIncomingMediaMimeType(mimeFromHeader, isAudioMessage, isImageMessage),
        };
      }

      console.log(`[Media] Resolved inline base64 from ${label}`);
      return {
        base64: base64Candidate.replace(/\s+/g, ""),
        mimeType: inlineMime,
      };
    }

    const mediaUrl = [source.url, source.fileUrl, source.fileURL, source.link, source.mediaUrl]
      .find((value) => typeof value === "string" && /^https?:\/\//i.test(value));

    if (!mediaUrl) return null;

    try {
      const mediaRes = await fetch(mediaUrl);
      if (!mediaRes.ok) return null;

      const buf = await mediaRes.arrayBuffer();
      if (buf.byteLength <= 100) return null;

      console.log(`[Media] Resolved inline URL from ${label}`);
      return {
        base64: arrayBufferToBase64(buf),
        mimeType: normalizeIncomingMediaMimeType(
          mediaRes.headers.get("content-type") || inlineMime,
          isAudioMessage,
          isImageMessage,
        ),
      };
    } catch (error) {
      console.warn(`[Media] Failed inline URL fetch from ${label}:`, error);
      return null;
    }
  };

  const candidateSources = [
    msg?.audioMessage,
    msg?.message?.audioMessage,
    payload?.audioMessage,
    payload?.message?.audioMessage,
    payload?.data?.audioMessage,
    payload?.data?.message?.audioMessage,
    msg?.imageMessage,
    msg?.message?.imageMessage,
    payload?.imageMessage,
    payload?.message?.imageMessage,
    payload?.data?.imageMessage,
    payload?.data?.message?.imageMessage,
    msg,
    msg?.message,
    payload?.message,
    payload?.data?.message,
    payload?.data,
    payload,
  ];

  for (let i = 0; i < candidateSources.length; i++) {
    const resolved = await tryInlineSource(candidateSources[i], `candidate_${i + 1}`);
    if (resolved?.base64) {
      return {
        base64: resolved.base64,
        mimeType: normalizeIncomingMediaMimeType(resolved.mimeType, isAudioMessage, isImageMessage),
      };
    }
  }

  if (!messageId || !uazapiUrl || !uazapiToken) {
    return { base64: null, mimeType: fallbackMimeType };
  }

  try {
    console.log(`Downloading media for messageId: ${messageId}`);

    const endpoints = [
      {
        label: "POST /message/download",
        run: () => fetch(`${uazapiUrl}/message/download`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json", "token": uazapiToken },
          body: JSON.stringify({ id: messageId }),
        }),
      },
      {
        label: `GET /message/download/${messageId}`,
        run: () => fetch(`${uazapiUrl}/message/download/${messageId}`, {
          headers: { "token": uazapiToken },
        }),
      },
    ];

    for (const endpoint of endpoints) {
      try {
        const res = await endpoint.run();
        console.log(`${endpoint.label} status: ${res.status}`);
        if (!res.ok) continue;

        const ct = res.headers.get("content-type") || "";
        if (ct.includes("json")) {
          const data = await res.json().catch(() => null);
          const base64Content = data?.base64 || data?.data || data?.file || data?.content;

          if (base64Content && typeof base64Content === "string" && base64Content.length > 100) {
            if (base64Content.startsWith("data:")) {
              const [header, body] = base64Content.split(",", 2);
              return {
                base64: body,
                mimeType: normalizeIncomingMediaMimeType(
                  header.match(/data:([^;]+)/)?.[1] || data?.mimetype || data?.mimeType || fallbackMimeType,
                  isAudioMessage,
                  isImageMessage,
                ),
              };
            }

            return {
              base64: base64Content.replace(/\s+/g, ""),
              mimeType: normalizeIncomingMediaMimeType(data?.mimetype || data?.mimeType || fallbackMimeType, isAudioMessage, isImageMessage),
            };
          }

          const mediaUrl = data?.url || data?.fileUrl || data?.fileURL || data?.link || data?.mediaUrl;
          if (typeof mediaUrl === "string" && /^https?:\/\//i.test(mediaUrl)) {
            const mediaRes = await fetch(mediaUrl);
            if (mediaRes.ok) {
              const mediaBuffer = await mediaRes.arrayBuffer();
              if (mediaBuffer.byteLength > 100) {
                return {
                  base64: arrayBufferToBase64(mediaBuffer),
                  mimeType: normalizeIncomingMediaMimeType(
                    data?.mimetype || data?.mimeType || mediaRes.headers.get("content-type") || fallbackMimeType,
                    isAudioMessage,
                    isImageMessage,
                  ),
                };
              }
            }
          }

          continue;
        }

        const buf = await res.arrayBuffer();
        if (buf.byteLength > 100) {
          return {
            base64: arrayBufferToBase64(buf),
            mimeType: normalizeIncomingMediaMimeType(ct || fallbackMimeType, isAudioMessage, isImageMessage),
          };
        }
      } catch (endpointError) {
        console.warn(`${endpoint.label} failed:`, endpointError);
      }
    }
  } catch (mediaErr) {
    console.error("Error downloading media:", mediaErr);
  }

  console.error("All media resolution methods failed for messageId:", messageId);
  return { base64: null, mimeType: fallbackMimeType };
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, token, x-mode",
};

// ===== Business hours helper for follow-up sequences =====
// If `at` falls outside [start,end] in given tz, push to next start within window.
function adjustToBusinessHours(at: Date, start: string, end: string, timezone: string): Date {
  try {
    const [sh, sm] = start.split(":").map(Number);
    const [eh, em] = end.split(":").map(Number);
    const fmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: timezone });
    const parts = fmt.formatToParts(at);
    const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    const cur = hh * 60 + mm;
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    if (cur >= startMin && cur < endMin) return at;
    const diff = cur < startMin ? (startMin - cur) : ((24 * 60 - cur) + startMin);
    return new Date(at.getTime() + diff * 60 * 1000);
  } catch {
    return at;
  }
}

const digitsOnly = (value: unknown) => String(value ?? "").replace(/\D/g, "");

// In-memory cache of UAZAPI label name → id resolution, keyed by uazapi base URL + token.
// Resets on cold start; refreshed every 5 minutes.
const _uazLabelsCache = new Map<string, { fetchedAt: number; labels: Array<{ id: string; name: string }> }>();

async function fetchUazapiLabels(uazapiUrl: string, uazapiToken: string): Promise<Array<{ id: string; name: string }>> {
  const cacheKey = `${uazapiUrl}::${uazapiToken}`;
  const cached = _uazLabelsCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < 5 * 60 * 1000) return cached.labels;

  // UAZAPI: GET /labels (with token header) returns the full label list for the instance.
  const endpoints = [`${uazapiUrl.replace(/\/+$/, "")}/labels`, `${uazapiUrl.replace(/\/+$/, "")}/chat/labels`];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { method: "GET", headers: { "token": uazapiToken, "Accept": "application/json" } });
      if (!res.ok) continue;
      const data = await res.json().catch(() => null);
      const raw = Array.isArray(data) ? data : (Array.isArray(data?.labels) ? data.labels : (Array.isArray(data?.data) ? data.data : []));
      if (!raw.length) continue;
      const labels = raw.map((l: any) => ({
        id: String(l.id ?? l.label_id ?? l.labelId ?? l.value ?? ""),
        name: String(l.name ?? l.label ?? l.title ?? ""),
      })).filter((l: any) => l.id);
      _uazLabelsCache.set(cacheKey, { fetchedAt: Date.now(), labels });
      console.log(`[UazLabels] Fetched ${labels.length} labels from ${url}`);
      return labels;
    } catch (e) {
      console.error(`[UazLabels] fetch ${url} failed:`, e);
    }
  }
  return [];
}

async function resolveIaOffLabelIdsFromUazapi(uazapiUrl: string | null | undefined, uazapiToken: string | null | undefined): Promise<string[]> {
  if (!uazapiUrl || !uazapiToken) return [];
  const labels = await fetchUazapiLabels(uazapiUrl, uazapiToken);
  return labels.filter((l) => /ia\s*off/i.test(l.name)).map((l) => l.id);
}

// Load all kanban columns for a tenant: union from crm_boards (multi-board model),
// falling back to legacy tenants.kanban_columns when no boards exist.
// Each returned column carries its source board_id (null for legacy).
async function loadTenantKanbanColumns(supabase: any, tenantId: string, legacyCols: any): Promise<any[]> {
  try {
    const { data: boards } = await supabase
      .from("crm_boards")
      .select("id, columns")
      .eq("tenant_id", tenantId);
    const fromBoards = (boards ?? []).flatMap((b: any) =>
      (Array.isArray(b.columns) ? b.columns : []).map((c: any) => ({ ...c, board_id: b.id }))
    );
    if (fromBoards.length) return fromBoards;
  } catch (e) {
    console.error("[loadTenantKanbanColumns] crm_boards error:", e);
  }
  return (Array.isArray(legacyCols) ? legacyCols : []).map((c: any) => ({ ...c, board_id: null }));
}

function normalizeWhatsAppLabelId(value: any): string | null {
  if (value == null) return null;

  if (typeof value === "object") {
    return normalizeWhatsAppLabelId(
      value.label_id ?? value.labelId ?? value.id ?? value.value ?? value.tag_id ?? value.tagId ?? value.raw ?? null,
    );
  }

  const raw = String(value).trim();
  if (!raw) return null;
  if (raw.includes(":")) return raw.split(":").pop()?.trim() || null;
  return raw;
}

function extractWhatsAppLabelIds(source: any): string[] {
  const labelSources = [
    source?.wa_label,
    source?.lead_tags,
    source?.labels,
    source?.chat?.wa_label,
    source?.chat?.lead_tags,
    source?.chat?.labels,
    source?.data?.wa_label,
    source?.data?.lead_tags,
    source?.data?.labels,
    source?.data?.chat?.wa_label,
    source?.data?.chat?.lead_tags,
    source?.data?.chat?.labels,
  ];

  return [...new Set(
    labelSources
      .flatMap((entry: any) => Array.isArray(entry) ? entry : typeof entry === "string" && entry.trim() ? entry.split(",") : [])
      .map((entry: any) => normalizeWhatsAppLabelId(entry))
      .filter((entry: string | null): entry is string => Boolean(entry))
  )];
}

function pickDesiredFunnelLabel(waLabelIds: string[], kanbanCols: any[], currentFunnelLabel: string | null): string | null {
  const funnelLabels = waLabelIds.filter((labelId) => {
    const col = kanbanCols.find((candidate: any) => String(candidate.label_id) === labelId);
    return col && col.type !== "flag";
  });

  if (!funnelLabels.length) return null;

  const changedCandidate = funnelLabels.filter((labelId) => labelId !== currentFunnelLabel).at(-1);
  return changedCandidate || funnelLabels.at(-1) || null;
}

type SyncLeadLabelsFromWhatsAppArgs = {
  supabase: any;
  tenant: any;
  phoneNumber: string;
  waLabelIds?: string[];
  logContext: string;
  skipIfRecentlyUpdatedMs?: number;
  uazapiUrl?: string | null;
  uazapiToken?: string | null;
};

type SyncLeadLabelsFromWhatsAppResult = {
  status: string;
  waLabelIds: string[];
  kanbanCols: any[];
  currentFlags: string[];
  effectiveFlags: string[];
  currentFunnelLabel: string | null;
  effectiveFunnelLabel: string | null;
  funnelChanged: boolean;
  flagsChanged: boolean;
};

async function syncLeadLabelsFromWhatsApp({
  supabase,
  tenant,
  phoneNumber,
  waLabelIds = [],
  logContext,
  skipIfRecentlyUpdatedMs = 10_000,
  uazapiUrl,
  uazapiToken,
}: SyncLeadLabelsFromWhatsAppArgs): Promise<SyncLeadLabelsFromWhatsAppResult> {
  const kanbanCols: any[] = await loadTenantKanbanColumns(supabase, tenant.id, tenant.kanban_columns);
  const configuredLabelIds = kanbanCols.map((c: any) => String(c.label_id));
  let effectiveWaLabelIds = [...new Set(waLabelIds.map((labelId) => String(labelId)))];

  if (!effectiveWaLabelIds.length && configuredLabelIds.length && uazapiUrl && uazapiToken) {
    try {
      const { payload: chatDetails } = await fetchUazChatDetails(uazapiUrl, uazapiToken, phoneNumber);
      const liveLabels = extractWhatsAppLabelIds(chatDetails);
      if (liveLabels.length) {
        effectiveWaLabelIds = liveLabels;
        console.log(`[${logContext}] Labels loaded from /chat/details: ${JSON.stringify(effectiveWaLabelIds)}`);
      }
    } catch (error) {
      console.error(`[${logContext}] Failed to load labels from /chat/details:`, error);
    }
  }

  const unknownIds = effectiveWaLabelIds.filter((labelId) => !configuredLabelIds.includes(labelId));
  if (unknownIds.length) {
    console.log(`[${logContext}] WhatsApp labels not configured in any board, ignoring: ${JSON.stringify(unknownIds)}`);
  }

  const { data: existingLead } = await supabase
    .from("crm_leads")
    .select("id, label_id, flag_labels, updated_at")
    .eq("tenant_id", tenant.id)
    .eq("phone_number", phoneNumber)
    .maybeSingle();

  const currentFunnelLabel = existingLead?.label_id && existingLead.label_id !== "__none__"
    ? String(existingLead.label_id)
    : null;
  const currentFlags: string[] = existingLead?.flag_labels || [];

  if (skipIfRecentlyUpdatedMs > 0 && existingLead?.updated_at) {
    const ageMs = Date.now() - new Date(existingLead.updated_at).getTime();
    if (ageMs < skipIfRecentlyUpdatedMs) {
      console.log(`[${logContext}] Skipping ${phoneNumber} — lead updated ${ageMs}ms ago (anti-loop)`);
      return {
        status: "anti_loop_skip",
        waLabelIds: effectiveWaLabelIds,
        kanbanCols,
        currentFlags,
        effectiveFlags: currentFlags,
        currentFunnelLabel,
        effectiveFunnelLabel: currentFunnelLabel,
        funnelChanged: false,
        flagsChanged: false,
      };
    }
  }

  const newFlags = [...new Set(effectiveWaLabelIds.filter((labelId) => {
    const col = kanbanCols.find((candidate: any) => String(candidate.label_id) === labelId);
    return col?.type === "flag";
  }))];
  const newFunnelLabel = pickDesiredFunnelLabel(effectiveWaLabelIds, kanbanCols, currentFunnelLabel);
  const funnelChanged = newFunnelLabel !== currentFunnelLabel;
  const flagsChanged = JSON.stringify([...newFlags].sort()) !== JSON.stringify([...currentFlags].sort());

  if (!funnelChanged && !flagsChanged && existingLead) {
    console.log(`[${logContext}] No changes for ${phoneNumber}`);
    return {
      status: "no_changes",
      waLabelIds: effectiveWaLabelIds,
      kanbanCols,
      currentFlags,
      effectiveFlags: currentFlags,
      currentFunnelLabel,
      effectiveFunnelLabel: currentFunnelLabel,
      funnelChanged,
      flagsChanged,
    };
  }

  if (existingLead || newFunnelLabel || newFlags.length > 0) {
    const funnelCol = newFunnelLabel
      ? kanbanCols.find((candidate: any) => String(candidate.label_id) === newFunnelLabel)
      : null;
    const updateData: any = { updated_at: new Date().toISOString() };

    if (funnelChanged) {
      updateData.label_id = newFunnelLabel || "__none__";
      updateData.label_name = funnelCol?.name || null;
      updateData.board_id = funnelCol?.board_id ?? null;
    }
    if (flagsChanged) {
      updateData.flag_labels = newFlags;
    }

    if (existingLead) {
      await supabase.from("crm_leads").update(updateData).eq("id", existingLead.id);
    } else {
      await supabase.from("crm_leads").insert({
        tenant_id: tenant.id,
        phone_number: phoneNumber,
        label_id: newFunnelLabel || "__none__",
        label_name: funnelCol?.name || null,
        flag_labels: newFlags,
        board_id: funnelCol?.board_id ?? null,
        updated_at: updateData.updated_at,
      });
    }

    if (funnelChanged && newFunnelLabel && existingLead?.id) {
      await supabase.from("crm_lead_history").insert({
        lead_id: existingLead.id,
        from_label: currentFunnelLabel,
        to_label: newFunnelLabel,
        changed_by: "whatsapp",
      });
    }

    console.log(`[${logContext}] Updated ${phoneNumber}: funnel=${newFunnelLabel ?? "__none__"}, flags=${JSON.stringify(newFlags)}`);
  }

  return {
    status: existingLead || newFunnelLabel || newFlags.length > 0 ? "label_synced" : "no_changes",
    waLabelIds: effectiveWaLabelIds,
    kanbanCols,
    currentFlags,
    effectiveFlags: newFlags,
    currentFunnelLabel,
    effectiveFunnelLabel: newFunnelLabel,
    funnelChanged,
    flagsChanged,
  };
}

const exactDigitsMatch = (a: unknown, b: unknown) => {
  const left = digitsOnly(a);
  const right = digitsOnly(b);
  return Boolean(left && right && left === right);
};
const normalizeUserFacingText = (value: unknown) => String(value ?? "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .trim();
const sanitizeClientName = (value: unknown) => String(value ?? "")
  .replace(/[\p{Extended_Pictographic}\u200d\uFE0F]/gu, "")
  .replace(/[^\p{L}\s\-']/gu, "")
  .replace(/\s+/g, " ")
  .trim();

// Palavras/marcadores que indicam fala (não nome). Se o "nome" contém qualquer um destes,
// é quase certo que veio de uma transcrição de áudio ou frase solta, não um nome real.
const NON_NAME_STOPWORDS = new Set([
  // saudações e respostas curtas
  "oi","ola","alo","bom","dia","boa","tarde","noite","sim","nao","ok","okay","blz","beleza",
  "valeu","obrigado","obrigada","tchau","ate","logo",
  // pronomes/conectores comuns em fala
  "eu","voce","vc","tu","ele","ela","nos","a","o","um","uma","com","sem","de","do","da","dos","das",
  "pra","para","por","em","no","na","nos","nas","que","quem","onde","como","quando","quanto",
  "isso","aquilo","esse","essa","aqui","ali","la","ai","mas","tambem","tb","entao","entao","ne","tipo",
  "ta","tah","uhum","aham","hum","hmm",
  // verbos típicos de pedido / agendamento
  "quero","queria","gostaria","posso","pode","preciso","tem","temos","ter","ir","vou","vai","vamos",
  "agendar","agenda","agendamento","marcar","marca","marcado","desmarcar","cancelar","cancela",
  "confirmar","confirma","reagendar","mudar","trocar","ver","saber","aumenta","aumentar","incluir",
  "fazer","faz","fica","ficou","esta","estah","sao","ser",
  // serviços / produtos típicos
  "corte","barba","bigode","cabelo","cabelinho","sobrancelha","pezinho","platinado","luzes","tintura",
  "hidratacao","escova","progressiva","botox","relaxamento","servico","servicos","valor","valores",
  "preco","precos","quanto","custa","custo","combo",
  // tempo / agenda
  "hoje","amanha","ontem","agora","depois","antes","cedo","tarde","manha","manhã","horario","horarios",
  "hora","horas","minuto","minutos","dia","dias","semana","mes","mes","ano",
  "segunda","terca","quarta","quinta","sexta","sabado","domingo",
  "feira","feriado",
  // placeholders
  "cliente","fulano","ciclano","beltrano","teste","testando",
]);

const NAME_CONNECTORS = new Set(["de","da","do","das","dos","e","del","della","di"]);

// Heurística forte: o texto realmente parece um nome próprio.
// - 2 a 4 palavras
// - cada palavra com 2+ letras
// - só letras (sem dígitos)
// - nenhuma palavra na lista de stopwords (exceto conectores tipo "de", "da")
// - comprimento total razoável
const looksLikeRealName = (value: unknown): boolean => {
  const cleaned = sanitizeClientName(value);
  if (!cleaned || cleaned.length < 4 || cleaned.length > 60) return false;
  if (/\d/.test(cleaned)) return false;
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 4) return false;
  for (const p of parts) {
    if (p.length < 2) return false;
    if (!/^[\p{L}'\-]+$/u.test(p)) return false;
  }
  const normalizedParts = parts.map((p) => normalizeUserFacingText(p));
  // Pelo menos a 1ª e a última palavra precisam NÃO estar nos stopwords nem ser conector.
  const first = normalizedParts[0];
  const last = normalizedParts[normalizedParts.length - 1];
  if (NON_NAME_STOPWORDS.has(first) || NAME_CONNECTORS.has(first)) return false;
  if (NON_NAME_STOPWORDS.has(last) || NAME_CONNECTORS.has(last)) return false;
  // Nenhuma palavra pode ser stopword "forte" (verbos, serviços, tempo).
  for (const np of normalizedParts) {
    if (NON_NAME_STOPWORDS.has(np)) return false;
  }
  return true;
};

const isUsableClientName = (value: unknown) => looksLikeRealName(value);

const extractExplicitClientName = (userMessage: unknown, previousAssistantMessage?: unknown) => {
  const rawMessage = String(userMessage ?? "").trim();
  if (!rawMessage) return null;

  const normalizedAssistant = normalizeUserFacingText(previousAssistantMessage);
  const assistantAskedForName = /(como voce gosta de ser chamado|como posso te chamar|qual (?:e|é) (?:o )?(?:seu )?nome|me passa (?:o )?(?:seu )?nome|me diga (?:o )?(?:seu )?nome|pode me (?:passar|dizer) (?:o )?(?:seu )?nome|seu nome (?:e )?sobrenome|nome e sobrenome)/.test(normalizedAssistant);
  const introMatch = rawMessage.match(/(?:meu nome(?: completo)?(?: é| e)?|me chamo|pode me chamar de|sou o|sou a)\s+(.+)/i);

  // Sem gatilho explícito: não tente extrair nome (evita pegar transcrição de áudio aleatória).
  if (!assistantAskedForName && !introMatch) return null;

  const candidate = (introMatch?.[1] || rawMessage)
    // remove pontuação final e conectores comuns no fim
    .replace(/[\.,!?;:]+$/g, "")
    .trim();

  const cleaned = sanitizeClientName(candidate);
  // Só aceita se realmente parecer um nome (2-4 palavras, sem verbos/serviços/tempo).
  return looksLikeRealName(cleaned) ? cleaned : null;
};

const buildOneBelezaGenericEmail = (phone: unknown) => {
  const digits = digitsOnly(phone) || `${Date.now()}`;
  return `cliente+${digits}.${Date.now()}.${crypto.randomUUID().slice(0, 8)}@example.com`;
};

// ===== One Beleza alias helpers (handle "phone already in use globally") =====
const isOneBelezaPhoneInUseError = (status: number, responseText: string) => {
  if (status >= 200 && status < 300) {
    // Even on 2xx, server may return error-string body. Detect inline too.
    const n = normalizeUserFacingText(responseText);
    if (
      (n.includes("numero de telefone") || n.includes("telefone") || n.includes("celular")) &&
      (n.includes("ja esta associado") || n.includes("ja associado") || n.includes("outra conta"))
    ) return true;
    return false;
  }
  const normalized = normalizeUserFacingText(responseText);
  // Mensagem oficial: "O número de telefone já está associado a outra conta de usuário..."
  return (
    (normalized.includes("numero de telefone") || normalized.includes("telefone") || normalized.includes("celular")) &&
    (normalized.includes("ja esta associado") ||
      normalized.includes("ja associado") ||
      normalized.includes("outra conta") ||
      normalized.includes("ja esta cadastrado") ||
      normalized.includes("ja cadastrado") ||
      normalized.includes("ja existe"))
  );
};

// Detect responses that *look* like success (HTTP 2xx) but actually carry an error message in body.
// Examples observed in production:
//   "Erro ao realizar login com o cadastro"
//   "Erro ao cadastrar..."
// Returns true ONLY when we have strong evidence the registration succeeded.
const isOneBelezaRegistrationSuccess = (status: number, responseText: string) => {
  if (status < 200 || status >= 300) return false;
  const raw = (responseText || "").trim();
  if (!raw) return false;
  const normalized = normalizeUserFacingText(raw);
  // Hard-fail keywords in the body
  if (
    normalized.startsWith("erro") ||
    normalized.includes("erro ao") ||
    normalized.includes("falha") ||
    normalized.includes("invalid") ||
    normalized.includes("inválid") ||
    normalized.includes("nao foi possivel") ||
    normalized.includes("não foi possível") ||
    normalized.includes("ja esta associado") ||
    normalized.includes("outra conta")
  ) return false;

  // If JSON, must contain something resembling an id/codigo
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const hasId = !!(parsed.codigo ?? parsed.id ?? parsed.clienteId ?? parsed.userId ?? parsed.usuarioId);
      const hasSuccessFlag = parsed.success === true || parsed.ok === true;
      // Some endpoints return {} or wrap inside data
      if (hasId || hasSuccessFlag) return true;
      if (parsed.data && typeof parsed.data === "object") {
        const d = parsed.data;
        if (d.codigo ?? d.id ?? d.clienteId ?? d.userId) return true;
      }
      // No clear success indicator — be conservative and fail
      return false;
    }
  } catch {
    // Plain text 2xx — error keywords already filtered above.
    // OneBeleza retorna textos como "Cadastro criado com sucesso !" → tratar como sucesso real.
    if (
      normalized.includes("cadastro criado") ||
      normalized.includes("criado com sucesso") ||
      normalized.includes("cadastrado com sucesso") ||
      normalized.includes("usuario cadastrado") ||
      normalized.includes("usuário cadastrado") ||
      normalized.includes("cliente cadastrado") ||
      (normalized.includes("sucesso") && !normalized.includes("nao") && !normalized.includes("não"))
    ) {
      return true;
    }
    return false;
  }
  return false;
};

function _serviceSupabase() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

function _generateAliasPhone(tenantId: string, n: number) {
  // 11 dígitos, começa com 9 (formato celular BR); 4 dígitos derivados do tenant + 6 sequenciais
  const tHash = parseInt(tenantId.replace(/-/g, "").slice(0, 4), 16) % 10000;
  return `9${String(tHash).padStart(4, "0")}${String(n).padStart(6, "0")}`;
}

// Marca um alias como queimado para que nunca mais seja reutilizado.
async function burnOneBelezaAlias(tenantId: string, aliasPhone: string, reason: string) {
  try {
    const supabase = _serviceSupabase();
    await supabase
      .from("onebeleza_client_aliases")
      .update({ burned_at: new Date().toISOString() } as any)
      .eq("tenant_id", tenantId)
      .eq("alias_phone", aliasPhone)
      .is("burned_at", null);
    console.log(`[OneBeleza][alias] BURNED tenant=${tenantId} alias=${aliasPhone} reason=${reason}`);
    await supabase.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_role: "service",
      entity: "onebeleza_alias",
      entity_id: aliasPhone,
      action: "onebeleza_alias_burned",
      after: { alias_phone: aliasPhone, reason },
    });
  } catch (e) {
    console.error(`[OneBeleza][alias] burn error:`, (e as Error).message);
  }
}

async function getOrCreateOneBelezaAlias(
  tenantId: string,
  realPhone: string,
  realName?: string,
  forceNew = false,
): Promise<string> {
  const supabase = _serviceSupabase();
  const realDigits = digitsOnly(realPhone);

  // 1. Já existe um alias ATIVO (não queimado)?
  if (!forceNew) {
    const { data: existing } = await supabase
      .from("onebeleza_client_aliases")
      .select("alias_phone")
      .eq("tenant_id", tenantId)
      .eq("real_phone", realDigits)
      .is("burned_at", null)
      .maybeSingle();
    if (existing?.alias_phone) return existing.alias_phone;
  }

  // 2. Gera novo (com retry em colisão), sempre acima do total atual (inclui queimados)
  const { count } = await supabase
    .from("onebeleza_client_aliases")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId);
  let next = (count ?? 0) + 1;

  for (let attempt = 0; attempt < 8; attempt++) {
    const alias = _generateAliasPhone(tenantId, next + attempt);
    const { data, error } = await supabase
      .from("onebeleza_client_aliases")
      .insert({
        tenant_id: tenantId,
        real_phone: realDigits,
        alias_phone: alias,
        real_name: realName || null,
      })
      .select("alias_phone")
      .maybeSingle();
    if (!error && data?.alias_phone) {
      console.log(`[OneBeleza][alias] created tenant=${tenantId} real=${realDigits} alias=${alias}`);
      try {
        await supabase.from("audit_logs").insert({
          tenant_id: tenantId,
          actor_role: "service",
          entity: "onebeleza_alias",
          entity_id: alias,
          action: forceNew ? "onebeleza_alias_rotated" : "created",
          after: { real_phone: realDigits, alias_phone: alias, real_name: realName || null },
        });
      } catch { /* ignore */ }
      return alias;
    }
    // Caso de colisão no alias_phone: tenta o próximo número
  }
  throw new Error("Falha ao gerar alias OneBeleza após múltiplas tentativas");
}

async function resolveOneBelezaClientPhone(
  tenantId: string,
  realPhone: string,
): Promise<string> {
  const realDigits = digitsOnly(realPhone);
  if (!realDigits) return realDigits;
  try {
    const supabase = _serviceSupabase();
    const { data } = await supabase
      .from("onebeleza_client_aliases")
      .select("alias_phone")
      .eq("tenant_id", tenantId)
      .eq("real_phone", realDigits)
      .is("burned_at", null)
      .maybeSingle();
    if (data?.alias_phone) {
      console.log(`[OneBeleza][alias] resolved tenant=${tenantId} real=${realDigits} -> alias=${data.alias_phone}`);
      return data.alias_phone;
    }
  } catch (e) {
    console.error("[OneBeleza][alias] resolve error:", (e as Error).message);
  }
  return realDigits;
}

async function fetchOneBelezaWithRetry(
  url: string,
  options?: RequestInit,
  maxRetries = 2,
  retryDelayMs = 1000,
): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.status >= 500 && res.status < 600) {
        console.log(`[OneBeleza] HTTP ${res.status} on ${url}, retrying in ${retryDelayMs}ms (attempt ${attempt + 1}/${maxRetries})...`);
        if (attempt < maxRetries - 1) {
          await new Promise((r) => setTimeout(r, retryDelayMs));
          continue;
        }
      }
      return res;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.log(`[OneBeleza] fetch error on ${url}: ${lastError.message}, retrying in ${retryDelayMs}ms (attempt ${attempt + 1}/${maxRetries})...`);
      if (attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }
  }
  if (lastError) {
    throw lastError;
  }
  return fetch(url, options);
}

const shouldRetryOneBelezaWithEmail = (status: number, responseText: string) => {
  if (status >= 200 && status < 300) return false;
  const normalized = normalizeUserFacingText(responseText);

  return /\b(e-?mail|email)\b/.test(normalized) && (
    normalized.includes("obrigat") ||
    normalized.includes("required") ||
    normalized.includes("necessar") ||
    normalized.includes("inval") ||
    normalized.includes("ja esta em uso") ||
    normalized.includes("em uso") ||
    normalized.includes("already in use") ||
    normalized.includes("choose another")
  );
};

const parseTimestampMs = (value: unknown) => {
  const timestamp = new Date(String(value ?? "")).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
};

// Verifica se um cadastro foi realmente persistido consultando a API por telefone.
async function verifyOneBelezaClientExists(
  authHeaders: Record<string, string>,
  celular: string,
): Promise<boolean> {
  try {
    const url = `https://onechatbotapi.azurewebsites.net/api/Clientes/GetClientePeloNumero?Celular=${celular}`;
    const r = await fetchOneBelezaWithRetry(url, { headers: authHeaders });
    const t = await r.text();
    if (!r.ok) return false;
    try {
      const parsed = JSON.parse(t);
      if (Array.isArray(parsed)) return parsed.length > 0;
      if (parsed && typeof parsed === "object") {
        return !!(parsed.codigo ?? parsed.id ?? parsed.clienteId);
      }
      return false;
    } catch {
      return false;
    }
  } catch (e) {
    console.error(`[OneBeleza] verifyClient error:`, (e as Error).message);
    return false;
  }
}

async function registerOneBelezaClient(
  authHeaders: Record<string, string>,
  tel: string,
  nome: string,
  logPrefix: string,
  tenantId?: string,
): Promise<{ res: Response; text: string; aliasUsed?: string }> {
  const regUrl = "https://onetotemapi.azurewebsites.net/api/OLoginChatBot/CadastrarUsuario";

  const doRegister = async (celular: string, withEmail?: string) => {
    const body: Record<string, unknown> = { celular, nome: nome || "Cliente" };
    if (withEmail) body.email = withEmail;
    console.log(`${logPrefix} cadastrar_cliente URL: ${regUrl}`, JSON.stringify(body));
    const r = await fetchOneBelezaWithRetry(regUrl, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const t = await r.text();
    console.log(`${logPrefix} cadastrar_cliente response (${r.status}):`, t.slice(0, 500));
    return { r, t };
  };

  // 1. Tenta com telefone real
  let { r: res, t: text } = await doRegister(tel);

  // 2. Se erro de email → retry com email gerado
  if (shouldRetryOneBelezaWithEmail(res.status, text)) {
    const fallbackEmail = buildOneBelezaGenericEmail(tel);
    console.log(`${logPrefix} cadastrar_cliente retry with generated email: ${fallbackEmail}`);
    ({ r: res, t: text } = await doRegister(tel, fallbackEmail));
  }

  // Caminho feliz com telefone real
  if (isOneBelezaRegistrationSuccess(res.status, text)) {
    return { res, text };
  }

  // 3. Fallback de alias — só se temos tenant E o erro é "telefone já associado"
  //     ou se a resposta foi 2xx mas com corpo de erro (falso sucesso).
  const realPhoneTaken = isOneBelezaPhoneInUseError(res.status, text);
  const falseSuccess = res.status >= 200 && res.status < 300 && !isOneBelezaRegistrationSuccess(res.status, text);

  if (tenantId && (realPhoneTaken || falseSuccess)) {
    const MAX_ALIAS_TRIES = 5;
    let forceNew = false;
    for (let attempt = 1; attempt <= MAX_ALIAS_TRIES; attempt++) {
      let alias: string;
      try {
        alias = await getOrCreateOneBelezaAlias(tenantId, tel, nome, forceNew);
      } catch (e) {
        console.error(`${logPrefix} cadastrar_cliente alias generation error:`, (e as Error).message);
        break;
      }
      console.log(`${logPrefix} cadastrar_cliente attempt ${attempt}/${MAX_ALIAS_TRIES} with alias=${alias} (real=${tel})`);
      const aliasEmail = buildOneBelezaGenericEmail(alias);
      let aliasRes: Response;
      let aliasText: string;
      ({ r: aliasRes, t: aliasText } = await doRegister(alias, aliasEmail));
      if (shouldRetryOneBelezaWithEmail(aliasRes.status, aliasText)) {
        ({ r: aliasRes, t: aliasText } = await doRegister(alias));
      }

      // Sucesso real?
      if (isOneBelezaRegistrationSuccess(aliasRes.status, aliasText)) {
        // Verifica via GET para garantir persistência
        const exists = await verifyOneBelezaClientExists(authHeaders, alias);
        if (exists) {
          return { res: aliasRes, text: aliasText, aliasUsed: alias };
        }
        await burnOneBelezaAlias(tenantId, alias, "registration_returned_success_but_verify_failed");
        forceNew = true;
        continue;
      }

      // Falhou — alias está queimado (telefone associado ou falso-sucesso)
      const aliasTaken = isOneBelezaPhoneInUseError(aliasRes.status, aliasText);
      const aliasFalseSuccess = aliasRes.status >= 200 && aliasRes.status < 300;

      // Antes de queimar por "falso-sucesso", verifica se o cliente foi de fato
      // criado na API. Alguns endpoints retornam 2xx com corpo ambíguo, mas o
      // cadastro foi persistido — nesse caso o alias deve permanecer ativo.
      if (aliasFalseSuccess && !aliasTaken) {
        const existsAfterAmbiguous = await verifyOneBelezaClientExists(authHeaders, alias);
        if (existsAfterAmbiguous) {
          console.log(`${logPrefix} cadastrar_cliente ambiguous 2xx but client exists in API → keep alias=${alias}`);
          return { res: aliasRes, text: aliasText, aliasUsed: alias };
        }
      }

      const reason = aliasTaken
        ? "alias_phone_already_associated"
        : (aliasFalseSuccess ? "alias_registration_false_success" : `alias_registration_failed_${aliasRes.status}`);
      await burnOneBelezaAlias(tenantId, alias, reason);
      forceNew = true;
      // Atualiza last response para retornar caso esgote tentativas
      res = aliasRes;
      text = aliasText;
    }
    console.error(`${logPrefix} cadastrar_cliente esgotou ${MAX_ALIAS_TRIES} tentativas de alias`);
  }

  return { res, text };
}



Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // ===== SIMULATOR MODE =====
  // Painel do cliente envia { mode: "simulator", tenantId, message, history }
  // Roda o mesmo callAIAgent porém:
  // - usa phone sintético "SIM:<userId>" (não polui chat_messages reais)
  // - simulatorMode=true → bloqueia tools de mutação e não salva state/logs
  if (req.headers.get("x-mode") === "simulator") {
    try {
      const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
      const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
      const authHeader = req.headers.get("Authorization") || "";
      if (!authHeader.startsWith("Bearer ")) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const userClient = createClient(SUPABASE_URL, ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: userData, error: userErr } = await userClient.auth.getUser();
      if (userErr || !userData?.user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const userId = userData.user.id;

      const body = await req.json();
      const tenantId: string = body.tenantId;
      const message: string = String(body.message || "").trim();
      const history: { role: string; content: string }[] = Array.isArray(body.history) ? body.history : [];
      if (!tenantId || !message) {
        return new Response(JSON.stringify({ error: "Missing tenantId or message" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const svc = createClient(SUPABASE_URL, SERVICE_KEY);

      // Validar acesso: admin OU tenant_users membro do tenant
      const { data: roleRow } = await svc.from("user_roles").select("role").eq("user_id", userId).eq("role", "admin").maybeSingle();
      const isAdmin = !!roleRow;
      if (!isAdmin) {
        const { data: membership } = await svc.from("tenant_users").select("tenant_id").eq("user_id", userId).eq("tenant_id", tenantId).maybeSingle();
        if (!membership) {
          return new Response(JSON.stringify({ error: "Forbidden" }), {
            status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      const { data: tenant, error: tenantErr } = await svc.from("tenants").select("*").eq("id", tenantId).maybeSingle();
      if (tenantErr || !tenant) {
        return new Response(JSON.stringify({ error: "Tenant not found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const provider: string = tenant.api_provider || "trinks";
      const simPhone = `SIM:${userId}`;
      const senderName = userData.user.email?.split("@")[0] || "Simulador";

      const result = await callAIAgent(
        svc, tenant, simPhone, history, message, provider,
        null, null, senderName, true,
      );

      return new Response(JSON.stringify({
        response: result.response,
        toolCalls: result.toolCalls,
        errors: result.errors,
        model: result.model,
        durationMs: result.durationMs,
      }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e: any) {
      console.error("[Simulator] error:", e?.message, e?.stack);
      return new Response(JSON.stringify({ error: "Simulator failed", detail: String(e?.message || e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }



  // ===== Webhook authentication =====
  // Validates a shared secret to prevent forged webhook events.
  // Configure UAZAPI to send the secret either as `?token=...` query param
  // or as `x-webhook-token` / `x-uazapi-token` header.
  // If WHATSAPP_WEBHOOK_SECRET is not configured, we log a warning but accept
  // the request (to avoid downtime during rollout). Set the secret + configure
  // UAZAPI to enforce validation.
  const webhookSecret = Deno.env.get("WHATSAPP_WEBHOOK_SECRET");
  if (webhookSecret) {
    const url = new URL(req.url);
    const provided =
      url.searchParams.get("token") ||
      req.headers.get("x-webhook-token") ||
      req.headers.get("x-uazapi-token") ||
      "";
    // Constant-time-ish compare
    const a = new TextEncoder().encode(provided);
    const b = new TextEncoder().encode(webhookSecret);
    let ok = a.length === b.length;
    const len = Math.max(a.length, b.length);
    let diff = a.length ^ b.length;
    for (let i = 0; i < len; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
    ok = ok && diff === 0;
    if (!ok) {
      console.warn("Webhook rejected: invalid or missing secret");
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  } else {
    console.warn(
      "WHATSAPP_WEBHOOK_SECRET not set — webhook is accepting unsigned requests. " +
      "Set the secret and configure UAZAPI to send it as ?token=... or x-webhook-token header."
    );
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const payload = await req.json();
    console.log("Webhook received:", JSON.stringify(payload).slice(0, 1000));

    const event = payload.EventType || payload.event || payload.type;
    console.log("Event type:", event);

    if (event === "messages.upsert" || event === "message" || event === "messages") {
      const msg = payload.message || payload.data?.message || payload.data || payload;

      // Detect message type
      const messageType = msg.messageType || msg.type || payload.messageType || "";
      const reactionPayload =
        msg?.reactionMessage ||
        msg?.message?.reactionMessage ||
        payload?.reactionMessage ||
        payload?.data?.reactionMessage ||
        payload?.data?.message?.reactionMessage;
      const isReactionMessage =
        /reaction/i.test(messageType) ||
        Boolean(reactionPayload) ||
        payload?.type === "reaction" ||
        payload?.event === "reaction";
      const isAudioMessage = /audio|ptt/i.test(messageType);
      const isImageMessage = /image/i.test(messageType);
      const hasMedia = isAudioMessage || isImageMessage;

      const messageContent = msg.conversation || msg.text || msg.body ||
        msg?.extendedTextMessage?.text || msg?.message?.conversation ||
        msg?.message?.extendedTextMessage?.text ||
        payload.text || payload.body ||
        msg?.imageMessage?.caption || msg?.message?.imageMessage?.caption || "";

      const remoteJid = extractRemoteJid(payload, msg);
      const phoneMatch = extractPhoneNumber(payload, msg);
      const phoneNumber = phoneMatch?.phone ?? normalizePhoneNumber(remoteJid);

      const fromMe = payload.fromMe === true ||
        msg.fromMe === true ||
        msg.key?.fromMe === true ||
        (payload.sender && payload.owner && payload.sender === payload.owner);
      const isGroupMessage = String(remoteJid || "").endsWith("@g.us");

      console.log(
        "Parsed - remoteJid:", remoteJid,
        "phoneNumber:", phoneNumber,
        "phoneSource:", phoneMatch?.source,
        "fromMe:", fromMe,
        "messageType:", messageType,
        "isReaction:", isReactionMessage,
        "hasMedia:", hasMedia,
        "content:", messageContent?.slice(0, 100)
      );

      if (isGroupMessage || !phoneNumber) {
        return new Response(JSON.stringify({ status: "skipped" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (isReactionMessage) {
        console.log(`Skipping reaction message from ${phoneNumber}`);
        return new Response(JSON.stringify({ status: "reaction_ignored" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Store owner messages in chat history for context, then skip AI processing
      if (fromMe) {
        if (messageContent) {
          // Find tenant to store the message
          const { data: tenantsForStore } = await supabase
            .from("tenants")
            .select("id, whatsapp_number")
            .eq("status", "active");

          const ownerNumStore = digitsOnly(payload.chat?.owner || payload.owner || payload.to || "");
          const tenantForStore = (tenantsForStore || []).find((t: any) => {
            if (!t.whatsapp_number) return false;
            return exactDigitsMatch(ownerNumStore, t.whatsapp_number);
          });

          if (tenantForStore) {
            const storeMessageId = msg.key?.id || msg.id || payload.key?.id || payload.id || payload.chat?.lastMessage_id;
            // Check for duplicate by message_id
            const { data: existingMsg } = storeMessageId
              ? await supabase.from("chat_messages").select("id").eq("message_id", storeMessageId).maybeSingle()
              : { data: null };

            if (!existingMsg) {
              // Detect if this is just an echo of the AI's own recent reply (within 60s)
              // to avoid duplicating and to avoid mislabeling AI messages as human-sent.
              const sixtySecAgo = new Date(Date.now() - 60_000).toISOString();
              const { data: recentAssistant } = await supabase
                .from("chat_messages")
                .select("id, content")
                .eq("tenant_id", tenantForStore.id)
                .eq("phone_number", phoneNumber)
                .eq("role", "assistant")
                .gte("created_at", sixtySecAgo)
                .order("created_at", { ascending: false })
                .limit(5);

              const normalize = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
              const incoming = normalize(messageContent);
              const isEchoOfAI = incoming.length > 0 && (recentAssistant || []).some((m: any) => {
                if (!m.content) return false;
                const stored = normalize(m.content).replace(/^\[atendente humano\]:\s*/i, "");
                if (!stored) return false;
                // Exact match OR incoming is a chunk of the stored AI reply (the AI splits
                // long replies into multiple WhatsApp messages, so each echo is a substring).
                return stored === incoming || stored.includes(incoming) || incoming.includes(stored);
              });

              if (isEchoOfAI) {
                // Just tag the existing AI message with the message_id (so future dedup works) and skip insert
                if (storeMessageId && recentAssistant && recentAssistant[0]) {
                  await supabase
                    .from("chat_messages")
                    .update({ message_id: storeMessageId, processed: true })
                    .eq("id", recentAssistant[0].id);
                }
                console.log(`Skipped owner echo (matches AI reply): ${phoneNumber} -> "${messageContent.slice(0, 80)}"`);
              } else {
                // Real message sent manually by the human attendant (via app or WhatsApp).
                // Tag with prefix so the AI clearly sees it was a human, not itself.
                const taggedContent = `[ATENDENTE HUMANO]: ${messageContent}`;
                await supabase.from("chat_messages").insert({
                  tenant_id: tenantForStore.id,
                  phone_number: phoneNumber,
                  role: "assistant",
                  content: taggedContent,
                  message_id: storeMessageId || null,
                  processed: true,
                });
                console.log(`Stored HUMAN attendant message: ${phoneNumber} -> "${messageContent.slice(0, 80)}"`);
              }
            }
          }
        }
        return new Response(JSON.stringify({ status: "skipped_fromMe_stored" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (!messageContent && !hasMedia) {
        console.log("No text content or media in message, skipping");
        return new Response(JSON.stringify({ status: "no_text" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const messageId = msg.key?.id || msg.id || payload.key?.id || payload.id || payload.chat?.lastMessage_id;
      const senderName = payload.pushName || payload.senderName || msg.pushName || msg.senderName || payload.chat?.name || payload.chat?.pushName || payload.notify || msg.notify || "";
      console.log(`Message from ${phoneNumber}: ${messageContent}`, "messageId:", messageId, "senderName:", senderName, "msg.key:", JSON.stringify(msg.key || {}));

      // ===== TENANT LOOKUP =====
      // Buscar TODOS os tenants (inclusive inativos) para conseguir identificar
      // mensagens que chegam de instâncias desativadas e ignorar com segurança,
      // em vez de cair em fallback errado para outro tenant ativo.
      const { data: allTenantsRaw, error: tenantError } = await supabase
        .from("tenants")
        .select("*");

      if (tenantError || !allTenantsRaw?.length) {
        console.error("No tenant found:", tenantError);
        return new Response(JSON.stringify({ error: "No tenant configured" }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const activeTenants = allTenantsRaw.filter((t: any) => t.status === "active");

      // 1) PRIORITY: Match by chat.owner (o número WhatsApp conectado à sessão UAZAPI)
      const ownerNumber = payload.chat?.owner || payload.owner || payload.to || "";
      const ownerDigits = digitsOnly(ownerNumber);
      const incomingUnitHints = [
        payload.chat?.name,
        payload.chat?.title,
        payload.chat?.description,
        payload.pushName,
        payload.senderName,
        payload.notify,
        payload.body,
        payload.text,
        messageContent,
      ]
        .map((value) => normalizeSearchText(value))
        .filter(Boolean);

      let tenant: any = null;
      let matchedInactive: any = null;

      if (ownerDigits) {
        // Match EXATO contra TODOS os tenants (ativos + inativos) para detectar inativos
        const allOwnerMatches = allTenantsRaw.filter((t: any) => {
          if (!t.whatsapp_number) return false;
          const normalized = t.whatsapp_number.replace(/\D/g, "");
          return exactDigitsMatch(ownerDigits, normalized);
        });

        const activeOwnerMatches = allOwnerMatches.filter((t: any) => t.status === "active");
        const inactiveOwnerMatches = allOwnerMatches.filter((t: any) => t.status !== "active");

        if (activeOwnerMatches.length === 1) {
          tenant = activeOwnerMatches[0];
        } else if (activeOwnerMatches.length > 1) {
          tenant = activeOwnerMatches.find((candidate: any) => {
            const unitFilters = getOneBelezaUnitFilterList(candidate).map(normalizeSearchText);
            return unitFilters.length > 0 && unitFilters.some((filter) => incomingUnitHints.some((hint) => hint.includes(filter)));
          }) || null;
          console.log(`Multiple ACTIVE tenants matched owner (${ownerDigits}). Resolved by unit hint: ${tenant?.name || "none"}`);
        } else if (inactiveOwnerMatches.length > 0) {
          matchedInactive = inactiveOwnerMatches[0];
        }

        if (tenant) {
          console.log(`Tenant matched by owner (${ownerDigits}): ${tenant.name}`);
        }
      }

      // 🚨 BLINDAGEM: se o owner number bate EXATAMENTE com um tenant INATIVO,
      // ignorar a mensagem em vez de cair em outro tenant ativo (causa de vazamento entre unidades).
      if (!tenant && matchedInactive) {
        console.log(`[BLOCKED] Owner ${ownerDigits} pertence a tenant INATIVO "${matchedInactive.name}" (${matchedInactive.id}). Ignorando mensagem para evitar roteamento cruzado.`);
        return new Response(JSON.stringify({ ok: true, ignored: "tenant_inactive", tenant: matchedInactive.name }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // 2) Match by UAZAPI BaseUrl (apenas se único entre ativos)
      if (!tenant) {
        const incomingBaseUrl = (payload.BaseUrl || "").replace(/\/+$/, "").toLowerCase();
        if (incomingBaseUrl) {
          const urlMatches = activeTenants.filter((t: any) => {
            if (!t.uazapi_url) return false;
            return t.uazapi_url.replace(/\/+$/, "").toLowerCase() === incomingBaseUrl;
          });
          if (urlMatches.length === 1) {
            tenant = urlMatches[0];
            console.log(`Tenant matched by unique BaseUrl: ${tenant.name}`);
          } else if (urlMatches.length > 1) {
            console.log(`Multiple tenants (${urlMatches.length}) share BaseUrl ${incomingBaseUrl}, skipping URL match`);
          }
        }
      }

      // 3) Match EXATO por whatsapp_number do cliente (raro, mas mantido)
      if (!tenant) {
        tenant = activeTenants.find((t: any) => {
          if (!t.whatsapp_number) return false;
          const normalized = t.whatsapp_number.replace(/\D/g, "");
          return exactDigitsMatch(phoneNumber, normalized);
        }) || null;
      }

      // 🚨 BLINDAGEM FINAL: SEM fallback para tenants[0]. Se não casou ninguém, ignora.
      if (!tenant) {
        console.log(`[BLOCKED] Nenhum tenant ativo casou com owner=${ownerDigits} / phone=${phoneNumber}. Ignorando para evitar roteamento errado.`);
        return new Response(JSON.stringify({ ok: true, ignored: "no_tenant_match", owner: ownerDigits }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const provider: string = tenant.api_provider || "trinks";
      console.log(`Tenant matched: ${tenant.name} (${tenant.id}), provider: ${provider}, owner: ${ownerDigits}`);

      // 🛑 IA pausada manualmente pelo cliente — NÃO chama a IA, mas SALVA a mensagem
      // para que o atendente humano veja no painel de Conversas e tenha histórico/memória.
      if (tenant.agent_paused) {
        console.log(`[PAUSED] Tenant ${tenant.name} está com a IA pausada. Salvando mensagem sem resposta.`);
        try {
          const _msgId = msg.key?.id || msg.id || payload.key?.id || payload.id || payload.chat?.lastMessage_id || null;
          // Dedup por message_id (evita duplicar se o webhook reentregar)
          const { data: existing } = _msgId
            ? await supabase.from("chat_messages").select("id").eq("message_id", _msgId).maybeSingle()
            : { data: null };
          if (!existing) {
            // Resolve mídia/transcrição mesmo pausado, para o painel mostrar o conteúdo real
            let pausedContent = messageContent || "";
            if (hasMedia) {
              try {
                const uazUrl = tenant.uazapi_url || Deno.env.get("UAZAPI_URL") || "";
                const uazTok = tenant.uazapi_token || Deno.env.get("UAZAPI_TOKEN") || "";
                const resolved = await resolveIncomingMedia({
                  payload, msg, messageId, uazapiUrl: uazUrl, uazapiToken: uazTok,
                  isAudioMessage, isImageMessage,
                });
                if (isAudioMessage && resolved.base64 && resolved.mimeType?.startsWith("audio/")) {
                  const tr = await transcribeAudioViaGemini(resolved.base64, resolved.mimeType);
                  pausedContent = tr ? `🎙️ ${tr}` : (pausedContent || "[Áudio recebido]");
                } else if (isImageMessage) {
                  pausedContent = pausedContent || "[Imagem recebida]";
                } else {
                  pausedContent = pausedContent || "[Mídia recebida]";
                }
              } catch (e) {
                console.warn("[PAUSED] erro resolvendo mídia:", e);
                pausedContent = pausedContent || (isAudioMessage ? "[Áudio recebido]" : "[Mídia recebida]");
              }
            }
            await supabase.from("chat_messages").insert({
              tenant_id: tenant.id,
              phone_number: phoneNumber,
              role: "user",
              content: pausedContent,
              message_id: _msgId,
              processed: true,
            });
          }
        } catch (e) {
          console.warn("[PAUSED] erro ao salvar mensagem com IA pausada:", e);
        }
        return new Response(JSON.stringify({ ok: true, ignored: "agent_paused", stored: true }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const uazapiUrlMedia = tenant.uazapi_url || Deno.env.get("UAZAPI_URL") || "";
      const uazapiTokenMedia = tenant.uazapi_token || Deno.env.get("UAZAPI_TOKEN") || "";

      let mediaBase64: string | null = null;
      let mediaMimeType: string | null = null;
      let audioTranscript: string | null = null;

      if (hasMedia) {
        const resolvedMedia = await resolveIncomingMedia({
          payload,
          msg,
          messageId,
          uazapiUrl: uazapiUrlMedia,
          uazapiToken: uazapiTokenMedia,
          isAudioMessage,
          isImageMessage,
        });
        mediaBase64 = resolvedMedia.base64;
        mediaMimeType = resolvedMedia.mimeType;

        if (isAudioMessage && mediaBase64 && mediaMimeType?.startsWith("audio/")) {
          audioTranscript = await transcribeAudioViaGemini(mediaBase64, mediaMimeType);
          if (audioTranscript) {
            console.log(`[Transcribe] OK (${audioTranscript.length} chars): ${audioTranscript.slice(0, 120)}`);
          }
          // OpenAI chat models don't accept audio as image_url — after transcription,
          // drop the binary so we only send text downstream.
          mediaBase64 = null;
          mediaMimeType = null;
        }
      }

      const storedContent = isAudioMessage
        ? (audioTranscript
            ? `🎙️ ${audioTranscript}`
            : (messageContent || "[Áudio recebido]"))
        : isImageMessage
          ? (messageContent || "[Imagem recebida]")
          : messageContent;

      // 🛑 PAUSA POR CONVERSA — checa ANTES de qualquer processamento pesado.
      // Salva a mensagem para o usuário ver no painel, mas não chama a IA.
      try {
        const { data: pauseRow, error: pauseErr } = await supabase
          .from("conversation_pauses")
          .select("paused")
          .eq("tenant_id", tenant.id)
          .eq("phone_number", phoneNumber)
          .maybeSingle();
        console.log(`[ConvPaused] check ${tenant.id}/${phoneNumber} -> row=${JSON.stringify(pauseRow)} err=${pauseErr?.message ?? "none"}`);
        if (pauseRow?.paused) {
          const _msgId = msg.key?.id || msg.id || payload.key?.id || payload.id || payload.chat?.lastMessage_id || null;
          await supabase.from("chat_messages").insert({
            tenant_id: tenant.id,
            phone_number: phoneNumber,
            role: "user",
            content: storedContent || (hasMedia ? (isAudioMessage ? "[Áudio recebido]" : "[Mídia recebida]") : ""),
            message_id: _msgId,
            processed: true,
          });
          console.log(`[ConvPaused] IA pausada para ${phoneNumber} — mensagem salva, sem resposta da IA.`);
          return new Response(JSON.stringify({ status: "conversation_paused" }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      } catch (e) {
        console.warn("[ConvPaused] erro ao consultar pausa por conversa:", e);
      }



      if (messageId) {
        const { data: existing } = await supabase
          .from("chat_messages")
          .select("id")
          .eq("message_id", messageId)
          .limit(1);
        if (existing?.length) {
          return new Response(JSON.stringify({ status: "duplicate" }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      // ===== IA OFF CHECK =====
      // Source of truth = WhatsApp itself (payload.chat.wa_label).
      // We sync the DB to match WhatsApp state on every message:
      //   - IA OFF present in WhatsApp → ensure flag in DB, block AI
      //   - IA OFF absent in WhatsApp → remove stale flag from DB, allow AI
      // Also reconciles all other configured flag labels (full bidirectional sync),
      // since UAZAPI does not emit chats.update events on this account.
      {
        const kanbanCols: any[] = await loadTenantKanbanColumns(supabase, tenant.id, tenant.kanban_columns);

        const iaOffLabelIds = kanbanCols
          .filter((c: any) => c.type === "flag" && /ia\s*off/i.test(c.name || ""))
          .map((c: any) => String(c.label_id));

        // Fallback: if no IA OFF flag column is configured, resolve the label ID
        // from the WhatsApp account itself (any label literally named "IA OFF").
        if (iaOffLabelIds.length === 0) {
          const fallbackIds = await resolveIaOffLabelIdsFromUazapi(
            tenant.uazapi_url || Deno.env.get("UAZAPI_URL"),
            tenant.uazapi_token || Deno.env.get("UAZAPI_TOKEN"),
          );
          for (const id of fallbackIds) if (!iaOffLabelIds.includes(id)) iaOffLabelIds.push(id);
          if (fallbackIds.length) console.log(`[IA OFF Check] Fallback resolved IA OFF label IDs from UAZAPI: ${JSON.stringify(fallbackIds)}`);
        }

        const allConfiguredFlagIds = kanbanCols
          .filter((c: any) => c.type === "flag")
          .map((c: any) => String(c.label_id));



        // Read DB state
        const { data: leadData } = await supabase
          .from("crm_leads")
          .select("id, flag_labels")
          .eq("tenant_id", tenant.id)
          .eq("phone_number", phoneNumber)
          .limit(1);

        const flagLabels: string[] = leadData?.[0]?.flag_labels || [];
        const dbHasIaOff = flagLabels.some((f: string) => iaOffLabelIds.includes(f) || /ia\s*off/i.test(f));

        // Read live WhatsApp state from payload
        const waLabelIds = extractWhatsAppLabelIds(payload);
        const waHasIaOff = iaOffLabelIds.length > 0 && waLabelIds.some((id: string) => iaOffLabelIds.includes(id));

        console.log(`[IA OFF Check] wa_label: ${JSON.stringify(waLabelIds)} | iaOffIds: ${JSON.stringify(iaOffLabelIds)} | dbHasIaOff: ${dbHasIaOff} | waHasIaOff: ${waHasIaOff}`);

        // ----- Bidirectional flag reconciliation (WhatsApp = source of truth) -----
        // Build the desired flag set from WhatsApp, but only for labels configured as type:"flag".
        // Unknown labels (e.g. funnel labels) are ignored here.
        if (allConfiguredFlagIds.length > 0) {
          const desiredFlags = [...new Set(waLabelIds.filter((id: string) => allConfiguredFlagIds.includes(id)))];
          const currentSorted = [...flagLabels].sort().join(",");
          const desiredSorted = [...desiredFlags].sort().join(",");

          if (currentSorted !== desiredSorted) {
            try {
              if (leadData?.[0]) {
                await supabase.from("crm_leads")
                  .update({ flag_labels: desiredFlags, updated_at: new Date().toISOString() })
                  .eq("id", leadData[0].id);
                console.log(`[FlagSync] Reconciled flags for ${phoneNumber}: [${currentSorted}] → [${desiredSorted}]`);
              } else if (desiredFlags.length > 0) {
                const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
                const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
                await sb.from("crm_leads").insert({
                  tenant_id: tenant.id,
                  phone_number: phoneNumber,
                  label_id: "__none__",
                  flag_labels: desiredFlags,
                });
                console.log(`[FlagSync] Created lead for ${phoneNumber} with flags [${desiredSorted}]`);
              }
            } catch (e) {
              console.error("[FlagSync] error:", e);
            }
          }
        }

        // Final decision: WhatsApp state wins.
        if (waHasIaOff) {
          console.log(`IA OFF flag detected for ${phoneNumber} in tenant ${tenant.name}, skipping AI`);
          return new Response(JSON.stringify({ status: "ia_off" }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        if (dbHasIaOff && !waHasIaOff) {
          console.log(`[IA OFF Check] DB had stale IA OFF flag for ${phoneNumber} but WhatsApp does not — releasing AI`);
        }

        const configuredFunnelIds = kanbanCols
          .filter((c: any) => c.type !== "flag")
          .map((c: any) => String(c.label_id));

        if (configuredFunnelIds.length > 0) {
          const syncResult = await syncLeadLabelsFromWhatsApp({
            supabase,
            tenant,
            phoneNumber,
            waLabelIds,
            logContext: "MessageLabelSync",
            skipIfRecentlyUpdatedMs: 10_000,
            uazapiUrl: tenant.uazapi_url || Deno.env.get("UAZAPI_URL"),
            uazapiToken: tenant.uazapi_token || Deno.env.get("UAZAPI_TOKEN"),
          });
          console.log(`[MessageLabelSync] status=${syncResult.status} labels=${JSON.stringify(syncResult.waLabelIds)}`);
        }
      }

      // ❌ = reset memory for this user
      if (messageContent.trim() === "❌") {
        const { error: delError } = await supabase
          .from("chat_messages")
          .delete()
          .eq("tenant_id", tenant.id)
          .eq("phone_number", phoneNumber);
        console.log(`Memory reset for ${phoneNumber}:`, delError ? delError.message : "OK");

        // Also clear conversation state
        await supabase
          .from("conversation_state")
          .delete()
          .eq("tenant_id", tenant.id)
          .eq("phone_number", phoneNumber);

        const uazapiUrl = tenant.uazapi_url || Deno.env.get("UAZAPI_URL");
        const uazapiToken = tenant.uazapi_token || Deno.env.get("UAZAPI_TOKEN");
        await fetch(`${uazapiUrl}/send/text`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json", "token": uazapiToken },
          body: JSON.stringify({ number: phoneNumber, text: "🔄 Memória limpa! Pode começar uma nova conversa.", delay: 1000 }),
        });

        return new Response(JSON.stringify({ status: "memory_reset" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Save message as unprocessed for debounce queue
      await supabase.from("chat_messages").insert({
        tenant_id: tenant.id,
        phone_number: phoneNumber,
        role: "user",
        content: storedContent,
        message_id: messageId,
        processed: false,
      });

      // (pausa por conversa já verificada no início do handler)



      // ===== DEBOUNCE: Wait for more messages, then claim atomically =====
      const tenantSettings = tenant.agent_settings && typeof tenant.agent_settings === "object" ? tenant.agent_settings as Record<string, any> : {};
      const DEBOUNCE_MS = ((tenantSettings.response_delay as number) || 10) * 1000;
      console.log(`Debounce: waiting ${DEBOUNCE_MS / 1000}s for ${phoneNumber}...`);
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS));

      const { data: unclaimed, error: unclaimedErr } = await supabase
        .from("chat_messages")
        .select("id, content, created_at")
        .eq("tenant_id", tenant.id)
        .eq("phone_number", phoneNumber)
        .eq("role", "user")
        .eq("processed", false)
        .order("created_at", { ascending: true });

      console.log(`Debounce: found ${unclaimed?.length || 0} unclaimed messages for ${phoneNumber}`, unclaimedErr ? `error: ${unclaimedErr.message}` : "");

      if (!unclaimed?.length) {
        console.log(`Debounce: no unclaimed messages for ${phoneNumber}, another webhook handled them`);
        return new Response(JSON.stringify({ status: "debounce_skip" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const newestQueuedAtMs = Math.max(...unclaimed.map((message: any) => parseTimestampMs(message.created_at)), 0);
      const remainingDebounceMs = newestQueuedAtMs
        ? newestQueuedAtMs + DEBOUNCE_MS - Date.now()
        : 0;

      if (remainingDebounceMs > 250) {
        const newestQueuedAtIso = new Date(newestQueuedAtMs).toISOString();
        console.log(
          `Debounce: recent activity detected for ${phoneNumber}; newest queued message at ${newestQueuedAtIso}. ` +
          `Remaining quiet window: ${Math.ceil(remainingDebounceMs / 1000)}s. Skipping this run so a newer webhook can process the full batch.`
        );
        return new Response(JSON.stringify({
          status: "debounce_rearmed",
          remaining_ms: remainingDebounceMs,
          newest_message_at: newestQueuedAtIso,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const unclaimedIds = unclaimed.map((m: any) => m.id);
      const { data: claimed, error: claimErr } = await supabase
        .from("chat_messages")
        .update({ processed: true })
        .in("id", unclaimedIds)
        .eq("processed", false)
        .select("id");

      console.log(`Debounce: claimed ${claimed?.length || 0} of ${unclaimed.length} messages`, claimErr ? `error: ${claimErr.message}` : "");

      if (!claimed?.length) {
        console.log(`Debounce: claim race lost for ${phoneNumber}, another webhook got them`);
        return new Response(JSON.stringify({ status: "debounce_skip" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const claimedIds = new Set(claimed.map((c: any) => c.id));
      const claimedMessages = unclaimed.filter((m: any) => claimedIds.has(m.id));
      const combinedContent = claimedMessages.map((m: any) => m.content).join("\n");
      const tDebounceEnd = Date.now();
      console.log(`Debounce: processing ${claimedMessages.length} messages combined for ${phoneNumber}`);

      // ===== IA OFF RECHECK (after debounce) =====
      // The owner may apply IA OFF label DURING the 10s debounce window.
      // We re-check the flag from DB AND from UAZAPI live (chat/details) before processing.
      try {
        const kanbanCols2: any[] = await loadTenantKanbanColumns(supabase, tenant.id, tenant.kanban_columns);
        const iaOffLabelIds2 = kanbanCols2
          .filter((c: any) => c.type === "flag" && /ia\s*off/i.test(c.name || ""))
          .map((c: any) => String(c.label_id));

        // Fallback: resolve from UAZAPI labels list if not configured as flag column.
        if (iaOffLabelIds2.length === 0) {
          const fb = await resolveIaOffLabelIdsFromUazapi(
            tenant.uazapi_url || Deno.env.get("UAZAPI_URL"),
            tenant.uazapi_token || Deno.env.get("UAZAPI_TOKEN"),
          );
          for (const id of fb) if (!iaOffLabelIds2.includes(id)) iaOffLabelIds2.push(id);
        }

        if (iaOffLabelIds2.length > 0) {
          let iaOffNow = false;

          // 1) DB recheck
          const { data: leadDataNow } = await supabase
            .from("crm_leads")
            .select("flag_labels")
            .eq("tenant_id", tenant.id)
            .eq("phone_number", phoneNumber)
            .limit(1);
          const flagsNow: string[] = leadDataNow?.[0]?.flag_labels || [];
          if (flagsNow.some((f: string) => iaOffLabelIds2.includes(f) || /ia\s*off/i.test(f))) {
            iaOffNow = true;
          }

          // 2) UAZAPI live recheck (only if DB did not flag)
          if (!iaOffNow) {
            try {
              const uazUrlForCheck = tenant.uazapi_url || Deno.env.get("UAZAPI_URL");
              const uazTokenForCheck = tenant.uazapi_token || Deno.env.get("UAZAPI_TOKEN");
              if (uazUrlForCheck && uazTokenForCheck) {
                const { payload: chatDetails } = await fetchUazChatDetails(uazUrlForCheck, uazTokenForCheck, phoneNumber);
                for (const lid of iaOffLabelIds2) {
                  if (chatHasLabel(chatDetails, lid)) {
                    iaOffNow = true;
                    // sync DB so next message hits the early check
                    try {
                      const newFlags = [...new Set([...flagsNow, lid])];
                      if (leadDataNow?.[0]) {
                        await supabase.from("crm_leads")
                          .update({ flag_labels: newFlags, updated_at: new Date().toISOString() })
                          .eq("tenant_id", tenant.id).eq("phone_number", phoneNumber);
                      } else {
                        await supabase.from("crm_leads").insert({
                          tenant_id: tenant.id, phone_number: phoneNumber,
                          label_id: "__none__", flag_labels: newFlags,
                        });
                      }
                    } catch (e) {
                      console.error("[IA OFF Recheck] DB sync error:", e);
                    }
                    break;
                  }
                }
              }
            } catch (e) {
              console.error("[IA OFF Recheck] UAZAPI fetch error:", e);
            }
          }

          if (iaOffNow) {
            console.log(`[IA OFF Recheck] Detected AFTER debounce for ${phoneNumber} — skipping AI response`);
            // claimed messages stay processed=true so they won't be reprocessed
            return new Response(JSON.stringify({ status: "ia_off_after_debounce" }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        }
      } catch (e) {
        console.error("[IA OFF Recheck] error:", e);
      }

      const { data: historyRaw } = await supabase
        .from("chat_messages")
        .select("role, content, processed, created_at")
        .eq("tenant_id", tenant.id)
        .eq("phone_number", phoneNumber)
        .or("role.eq.assistant,processed.eq.true")
        .order("created_at", { ascending: false })
        .limit(50);
      const history = (historyRaw || []).reverse();

      // Provider-specific direct handlers
      let directResponse: string | null = null;
      if (provider === "trinks") {
        directResponse = await maybeHandleDirectCancellationConfirmation(tenant, phoneNumber, history || [], combinedContent);
      }

      let aiResponse: string;
      let agentResult: AgentResult | null = null;

      try {
        if (directResponse) {
          aiResponse = directResponse;
        } else {
          agentResult = await callAIAgent(supabase, tenant, phoneNumber, history || [], combinedContent, provider, mediaBase64, mediaMimeType, senderName);
          aiResponse = agentResult.response;
        }
      } catch (aiErr: any) {
        const errMsg = aiErr?.message || String(aiErr);
        console.error(`[AI Pipeline] Unhandled error for ${phoneNumber} (tenant ${tenant.name}):`, errMsg, aiErr?.stack);

        // Release the claim so the message can be reprocessed when the next webhook arrives
        try {
          await supabase
            .from("chat_messages")
            .update({ processed: false })
            .in("id", Array.from(claimedIds));
          console.log(`[AI Pipeline] Released ${claimedIds.size} message(s) back to processed=false for retry`);
        } catch (releaseErr: any) {
          console.error("[AI Pipeline] Failed to release claim:", releaseErr?.message || releaseErr);
        }

        // Log the failure so it shows up in agent_logs / dashboards
        try {
          await supabase.from("agent_logs").insert({
            tenant_id: tenant.id,
            phone_number: phoneNumber,
            user_message: combinedContent,
            ai_response: "",
            tool_calls: [{
              name: "__pipeline_error__",
              args: { phase: "callAIAgent" },
              result: { released_for_retry: true },
              blocked: true,
            }],
            errors: [`Pipeline error: ${errMsg}`],
            model_used: "error",
            duration_ms: Date.now() - tDebounceEnd,
            session_blocked: false,
          });
        } catch (logErr: any) {
          console.error("[AI Pipeline] Failed to log error:", logErr?.message || logErr);
        }

        return new Response(JSON.stringify({ status: "ai_error_released", error: errMsg }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const tAiDone = Date.now();

      // NOTE: LinkClaimGuard removido a pedido do cliente. Preferimos que a IA siga
      // exclusivamente o prompt do sistema. O prompt deve garantir o envio literal
      // do booking_link sempre que prometido. Se a IA falhar e mandar o link 2x em
      // mensagens próximas, é considerado aceitável (vs. dizer "mandei" sem mandar).

      // ===== FOLLOW-UP: Check if client confirmed booking (all providers) =====
      {
        const confirmPatterns = [
          /agend(ei|ado|ou)/i, /marqu?e(i|ado|ou)/i, /confirm(ei|ado|ou)/i,
          /fiz\s*(o\s*)?(meu\s*)?(agendamento|horário|reserva)/i,
          /já\s*(agend|marqu)/i, /feito/i, /consegui.*agend/i, /reserv(ei|ado|ou)/i,
        ];
        const isConfirmation = confirmPatterns.some((p) => p.test(combinedContent));
        if (isConfirmation) {
          const { data: pendingFU } = await supabase
            .from("follow_ups")
            .select("id")
            .eq("tenant_id", tenant.id)
            .eq("phone_number", phoneNumber)
            .eq("status", "pending")
            .limit(10);
          if (pendingFU?.length) {
            await supabase
              .from("follow_ups")
              .update({ status: "confirmed", confirmed_at: new Date().toISOString() })
              .in("id", pendingFU.map((f: any) => f.id));
            console.log(`Follow-up: marked ${pendingFU.length} as confirmed for ${phoneNumber}`);
          }
        }
      }

      // ===== FOLLOW-UP: Deterministic triggers (after_link_sent + after_no_reply) =====
      {
        const settings = tenant.agent_settings || {};
        const followUpConfigs: any[] = Array.isArray(settings.follow_ups) ? settings.follow_ups : [];
        // Legacy migration
        if (followUpConfigs.length === 0 && settings.follow_up && settings.follow_up.enabled !== false) {
          followUpConfigs.push({
            id: "legacy",
            name: "Follow-up padrão",
            type: "after_link_sent",
            delay_minutes: settings.follow_up.delay_minutes || 30,
            message: settings.follow_up.message || "Oi! Vi que te mandei o link pra agendar, conseguiu marcar certinho? Se tiver qualquer dúvida, tô aqui! 😊",
            enabled: true,
          });
        }

        const enabledConfigs = followUpConfigs.filter((fu: any) => fu.enabled);
        console.log(`[FollowUp] Configs: ${enabledConfigs.length} enabled of ${followUpConfigs.length} total`);

        // Detect triggers from this interaction.
        // The "enviar_link_agendamento" tool was removed — for provider "none"
        // we now infer "link sent" by checking if the booking_link appears in
        // the AI's text response.
        const aiResponseText = String(agentResult?.response || aiResponse || "");
        const bookingLinkInResponse = !!(tenant.booking_link && aiResponseText.includes(tenant.booking_link));
        const legacyLinkToolCalled = agentResult?.toolCalls?.some((tc: any) =>
          tc.name === "enviar_link_agendamento" && !tc.blocked
        ) || false;
        const linkToolCalled = bookingLinkInResponse || legacyLinkToolCalled;

        for (const fuConfig of enabledConfigs) {
          let shouldTrigger = false;

          if (fuConfig.type === "after_link_sent" && linkToolCalled) {
            // Check: no existing pending/sent follow-up of this type for this client
            const { data: existingLinkFU } = await supabase
              .from("follow_ups")
              .select("id")
              .eq("tenant_id", tenant.id)
              .eq("phone_number", phoneNumber)
              .in("status", ["pending", "sent"])
              .like("follow_up_message", fuConfig.message?.slice(0, 20) + "%")
              .limit(1);

            if (existingLinkFU?.length) {
              console.log(`[FollowUp] Skipping "after_link_sent": already has pending/sent for ${phoneNumber}`);
            } else {
              shouldTrigger = true;
              console.log(`[FollowUp] Trigger "after_link_sent": link sent this interaction`);
            }
          }

          if (fuConfig.type === "after_no_reply") {
            // RULE: Only trigger on the FIRST interaction of this client (1-2 user messages in history)
            // RULE: Only trigger ONCE per client — never again if already sent/pending for this tenant+phone
            const userMsgCount = (history || []).filter((m: any) => m.role === "user").length;
            // Current message is already in history as processed, so count=1 means this is the first interaction
            const isFirstInteraction = userMsgCount <= 1;

            if (!isFirstInteraction) {
              console.log(`[FollowUp] Skipping "after_no_reply": not first interaction (${userMsgCount} user msgs in history)`);
            } else {
              // Check if we already sent/scheduled one for this client ever
              const { data: existingNoReplyFU } = await supabase
                .from("follow_ups")
                .select("id, status")
                .eq("tenant_id", tenant.id)
                .eq("phone_number", phoneNumber)
                .like("follow_up_message", fuConfig.message?.slice(0, 20) + "%")
                .limit(1);

              if (existingNoReplyFU?.length) {
                console.log(`[FollowUp] Skipping "after_no_reply": already exists (${existingNoReplyFU[0].status}) for ${phoneNumber}`);
              } else {
                shouldTrigger = true;
                console.log(`[FollowUp] Trigger "after_no_reply": first interaction, no previous follow-up for ${phoneNumber}`);
              }
            }
          }

          if (shouldTrigger) {
            const delayMin = fuConfig.delay_minutes || 30;
            const followUpAt = new Date(Date.now() + delayMin * 60 * 1000).toISOString();
            await supabase.from("follow_ups").insert({
              tenant_id: tenant.id,
              phone_number: phoneNumber,
              follow_up_at: followUpAt,
              follow_up_message: fuConfig.message,
            });
            console.log(`[FollowUp] Scheduled: "${fuConfig.name}" for ${phoneNumber} at ${followUpAt} (${delayMin}min delay)`);
          }
        }
      }

      // ===== SEQUENCES: cancel pending steps when lead replies (any message after step 1 was scheduled) =====
      try {
        const userMsgCountForSeq = (history || []).filter((m: any) => m.role === "user").length;
        // Only cancel if this is NOT the first interaction — first msg may be the trigger itself
        if (userMsgCountForSeq > 1) {
          const { data: pendingSeqFU } = await supabase
            .from("follow_ups")
            .select("id")
            .eq("tenant_id", tenant.id)
            .eq("phone_number", phoneNumber)
            .eq("status", "pending")
            .not("sequence_id", "is", null);
          if (pendingSeqFU?.length) {
            await supabase
              .from("follow_ups")
              .update({ status: "expired", cancelled_at: new Date().toISOString(), cancel_reason: "lead_replied" })
              .in("id", pendingSeqFU.map((f: any) => f.id));
            console.log(`[Sequence] Cancelled ${pendingSeqFU.length} pending steps for ${phoneNumber} (lead replied)`);
          }
        }
      } catch (e) {
        console.error("[Sequence] cancel error:", e);
      }

      // ===== SEQUENCES: trigger first_contact_traffic when keyword matches (and no sequence yet for this phone) =====
      try {
        {
          const { data: sequences } = await supabase
            .from("follow_up_sequences")
            .select("*, follow_up_steps(*)")
            .eq("tenant_id", tenant.id)
            .eq("enabled", true)
            .eq("trigger_type", "first_contact_traffic");

          for (const seq of sequences || []) {
            const cfg = seq.trigger_config || {};
            const keywords: string[] = Array.isArray(cfg.keywords) ? cfg.keywords : [];
            const matchMode: string = cfg.match_mode || "any";
            const catchAll: boolean = !!cfg.catch_all;
            const text = String(combinedContent || "").toLowerCase();
            let matchedKeyword: string | null = null;

            if (catchAll) {
              matchedKeyword = "__catch_all__";
            } else if (keywords.length > 0) {
              if (matchMode === "regex") {
                for (const k of keywords) {
                  try {
                    if (new RegExp(k, "i").test(combinedContent)) { matchedKeyword = k; break; }
                  } catch {}
                }
              } else {
                const matches = keywords.filter((k) => text.includes(String(k).toLowerCase()));
                if (matchMode === "all" && matches.length === keywords.length && matches.length > 0) matchedKeyword = matches.join(",");
                else if (matchMode === "any" && matches.length > 0) matchedKeyword = matches[0];
              }
            }

            if (!matchedKeyword) continue;

            // Check no existing follow-up of this sequence for this phone
            const { data: existing } = await supabase
              .from("follow_ups")
              .select("id")
              .eq("tenant_id", tenant.id)
              .eq("phone_number", phoneNumber)
              .eq("sequence_id", seq.id)
              .limit(1);
            if (existing?.length) {
              console.log(`[Sequence] Skip "${seq.name}": already has follow-ups for ${phoneNumber}`);
              continue;
            }

            const steps = (seq.follow_up_steps || []).sort((a: any, b: any) => a.step_order - b.step_order);
            if (!steps.length) continue;
            const step1 = steps[0];

            // Compute follow_up_at respecting business_hours
            let triggerAt = new Date(Date.now() + (step1.delay_minutes || 30) * 60 * 1000);
            const bh = seq.business_hours || {};
            if (bh.enabled) {
              triggerAt = adjustToBusinessHours(triggerAt, bh.start || "08:00", bh.end || "21:00", bh.timezone || "America/Sao_Paulo");
            }

            await supabase.from("follow_ups").insert({
              tenant_id: tenant.id,
              phone_number: phoneNumber,
              follow_up_at: triggerAt.toISOString(),
              follow_up_message: step1.message,
              sequence_id: seq.id,
              step_order: step1.step_order,
              matched_keyword: matchedKeyword,
            });
            console.log(`[Sequence] Triggered "${seq.name}" step ${step1.step_order} for ${phoneNumber} at ${triggerAt.toISOString()} (kw=${matchedKeyword})`);
          }
        }
      } catch (e) {
        console.error("[Sequence] trigger error:", e);
      }

      // ===== SPLIT RESPONSE: Send each paragraph as a separate message =====
      // Persist each part AFTER sending using the message_id returned by UAZAPI.
      // This way, when the fromMe echo arrives, the dedup-by-message_id check
      // catches it and we never store it again as [ATENDENTE HUMANO].
      const uazapiUrl = tenant.uazapi_url || Deno.env.get("UAZAPI_URL");
      const uazapiToken = tenant.uazapi_token || Deno.env.get("UAZAPI_TOKEN");

      const messageParts = splitIntoMessages(aiResponse);

      let tFirstSend = 0;
      let firstSendError: string | null = null;

      for (let i = 0; i < messageParts.length; i++) {
        const part = messageParts[i].trim();
        if (!part) continue;

        let sentMessageId: string | null = null;
        try {
          const sendResult = await fetch(`${uazapiUrl}/send/text`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json",
              "token": uazapiToken,
            },
            body: JSON.stringify({ number: phoneNumber, text: part, delay: 0 }),
          });
          const sendData = await sendResult.json().catch(() => ({} as any));
          console.log(`UAZAPI send part ${i + 1}/${messageParts.length}:`, JSON.stringify(sendData).slice(0, 200));
          // Extract message_id from UAZAPI response so the fromMe echo dedup works
          sentMessageId = (sendData?.id || sendData?.messageId || sendData?.key?.id || null) as string | null;
          if (i === 0) {
            tFirstSend = Date.now();
            if (!sendResult.ok) {
              firstSendError = `UAZAPI status ${sendResult.status}`;
            }
          }
        } catch (e: any) {
          if (i === 0) {
            tFirstSend = Date.now();
            firstSendError = `UAZAPI fetch error: ${e?.message || String(e)}`;
          }
          console.error(`UAZAPI send error part ${i + 1}:`, e?.message || e);
        }

        // Persist the part with the real message_id (so the fromMe echo gets deduped)
        try {
          await supabase.from("chat_messages").insert({
            tenant_id: tenant.id,
            phone_number: phoneNumber,
            role: "assistant",
            content: part,
            message_id: sentMessageId,
            processed: true,
          });
        } catch (persistErr: any) {
          console.error(`Failed to persist assistant part ${i + 1}:`, persistErr?.message || persistErr);
        }
      }

      // ===== Log to agent_logs (AFTER first send so we measure real wait) =====
      const newestQueuedAtMsForTotal = Math.max(
        ...claimedMessages.map((m: any) => parseTimestampMs(m.created_at)).filter((n: number) => n > 0),
      );
      const aiDurationMs = agentResult?.durationMs || 0;
      const debounceWaitMs = newestQueuedAtMsForTotal > 0
        ? Math.max(0, tDebounceEnd - newestQueuedAtMsForTotal)
        : DEBOUNCE_MS;
      const uazapiSendMs = tFirstSend > 0 ? Math.max(0, tFirstSend - tAiDone) : null;
      const totalResponseMs = tFirstSend > 0 && newestQueuedAtMsForTotal > 0
        ? tFirstSend - newestQueuedAtMsForTotal
        : (debounceWaitMs + aiDurationMs + (uazapiSendMs || 0));

      const logErrors = [...(agentResult?.errors || [])];
      if (firstSendError) logErrors.push(firstSendError);

      await supabase.from("agent_logs").insert({
        tenant_id: tenant.id,
        phone_number: phoneNumber,
        user_message: combinedContent,
        ai_response: aiResponse,
        tool_calls: [
          {
            name: "__debounce_batch__",
            args: {
              debounce_seconds: DEBOUNCE_MS / 1000,
              message_count: claimedMessages.length,
              messages: claimedMessages.map((message: any) => ({
                created_at: message.created_at,
                content: message.content,
              })),
            },
            result: {
              combined_content: combinedContent,
              total_response_ms: totalResponseMs,
              debounce_wait_ms: debounceWaitMs,
              ai_processing_ms: aiDurationMs,
              uazapi_send_ms: uazapiSendMs,
            },
            blocked: false,
          },
          ...(agentResult?.toolCalls || []),
        ],
        errors: logErrors,
        model_used: agentResult?.model || "direct_handler",
        duration_ms: totalResponseMs,
        session_blocked: agentResult?.sessionBlocked || false,
      }).then(({ error }) => {
        if (error) console.error("Failed to log agent execution:", error.message);
      });

      return new Response(JSON.stringify({ status: "ok", parts: messageParts.length }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ===== LABEL SYNC: chats.update =====
    if (event === "chats.update" || event === "chats.upsert" || event === "chat.update" || event === "chat_labels") {
      const chat = payload.chat || payload.data?.chat || payload;
      const ownerNumber = chat?.owner || payload.owner || "";
      const ownerDigits = digitsOnly(ownerNumber);
      const chatPhone = String(chat?.phone || chat?.id || "").replace(/\D/g, "").replace(/@.*/, "");
      
      console.log(`[LabelSync] Event: ${event}, owner: ${ownerDigits}, chatPhone: ${chatPhone}`);
      console.log(`[LabelSync] wa_label/raw labels:`, JSON.stringify({
        wa_label: chat?.wa_label || payload?.wa_label || payload?.data?.wa_label || [],
        lead_tags: chat?.lead_tags || payload?.lead_tags || payload?.data?.lead_tags || [],
        labels: chat?.labels || payload?.labels || payload?.data?.labels || [],
      }));

      if (!chatPhone) {
        return new Response(JSON.stringify({ status: "no_phone" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Find tenant — PRIORITY: owner of the WhatsApp instance > board containing the label > existing lead
      const { data: allTenants } = await supabase
        .from("tenants")
        .select("id, name, whatsapp_number, kanban_columns, uazapi_url, uazapi_token")
        .eq("status", "active");

      const waLabelIds = extractWhatsAppLabelIds({ chat, data: payload?.data, payload });
      let syncTenant: any = null;
      let matchReason = "none";

      // 1) PRIMARY: match by the WhatsApp instance owner number
      if (ownerDigits && allTenants) {
        syncTenant = allTenants.find((t: any) => {
          if (!t.whatsapp_number) return false;
          return exactDigitsMatch(ownerDigits, t.whatsapp_number);
        });
        if (syncTenant) matchReason = "owner_number";
      }

      // 2) FALLBACK: a tenant whose board contains one of the received label IDs
      if (!syncTenant && waLabelIds.length && allTenants) {
        const { data: boardsWithLabel } = await supabase
          .from("crm_boards")
          .select("tenant_id, columns")
          .in("tenant_id", allTenants.map((t: any) => t.id));
        const tenantWithLabel = (boardsWithLabel ?? []).find((b: any) => {
          const cols = Array.isArray(b.columns) ? b.columns : [];
          return cols.some((c: any) => waLabelIds.includes(String(c.label_id)));
        });
        if (tenantWithLabel) {
          syncTenant = allTenants.find((t: any) => t.id === tenantWithLabel.tenant_id);
          if (syncTenant) matchReason = "board_label_match";
        }
      }

      // 3) LAST RESORT: tenant that already has a lead for this phone
      if (!syncTenant) {
        const { data: existingLeadTenants } = await supabase
          .from("crm_leads")
          .select("tenant_id")
          .eq("phone_number", chatPhone);
        if (existingLeadTenants?.length && allTenants) {
          const leadTenantIds = new Set(existingLeadTenants.map((l: any) => l.tenant_id));
          syncTenant = allTenants.find((t: any) => leadTenantIds.has(t.id));
          if (syncTenant) matchReason = "existing_lead";
        }
      }

      if (!syncTenant) {
        console.log(`[LabelSync] No tenant matched. owner=${ownerDigits}, chatPhone=${chatPhone}, labels=${JSON.stringify(waLabelIds)}`);
        return new Response(JSON.stringify({ status: "no_tenant" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      console.log(`[LabelSync] Tenant matched: ${syncTenant.name} (${syncTenant.id}) via ${matchReason}`);

      // Diagnostic: list configured columns and detect cross-tenant label conflicts
      const diagCols = await loadTenantKanbanColumns(supabase, syncTenant.id, syncTenant.kanban_columns);
      console.log(`[LabelSync] Configured columns for ${syncTenant.name}: ${JSON.stringify(diagCols.map((c: any) => ({ id: String(c.label_id), name: c.name, type: c.type ?? "funnel", board_id: c.board_id })))}`);
      const unknown = waLabelIds.filter((l) => !diagCols.some((c: any) => String(c.label_id) === l));
      if (unknown.length) {
        const { data: otherBoards } = await supabase
          .from("crm_boards")
          .select("tenant_id, name, columns, tenants:tenant_id(name)");
        const conflicts: any[] = [];
        for (const b of otherBoards ?? []) {
          if ((b as any).tenant_id === syncTenant.id) continue;
          const cols = Array.isArray((b as any).columns) ? (b as any).columns : [];
          for (const c of cols) {
            if (unknown.includes(String(c.label_id))) {
              conflicts.push({ label_id: String(c.label_id), in_tenant: (b as any).tenants?.name ?? (b as any).tenant_id, board: (b as any).name, column: c.name });
            }
          }
        }
        if (conflicts.length) {
          console.log(`[LabelSync] WARNING: labels ${JSON.stringify(unknown)} are NOT configured for ${syncTenant.name}, but exist in other tenants: ${JSON.stringify(conflicts)} — etiqueta aplicada no WhatsApp não pertence ao funil deste cliente`);
        }
      }

      const syncResult = await syncLeadLabelsFromWhatsApp({
        supabase,
        tenant: syncTenant,
        phoneNumber: chatPhone,
        waLabelIds,
        logContext: "LabelSync",
        skipIfRecentlyUpdatedMs: 10_000,
        uazapiUrl: syncTenant.uazapi_url || Deno.env.get("UAZAPI_URL"),
        uazapiToken: syncTenant.uazapi_token || Deno.env.get("UAZAPI_TOKEN"),
      });

      return new Response(JSON.stringify({
        status: syncResult.status,
        funnelChanged: syncResult.funnelChanged,
        flagsChanged: syncResult.flagsChanged,
        labels: syncResult.waLabelIds,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ status: "ignored", event }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Webhook error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// ===================== AUTO-REGISTER CLIENT =====================

async function autoRegisterClient(_tenant: any, phoneNumber: string, provider: string): Promise<void> {
  console.log(`[AutoRegister] Skipped generic auto-registration for ${provider}/${phoneNumber} — waiting for explicit client name.`);
}

// ===================== AI AGENT =====================

interface AgentResult {
  response: string;
  toolCalls: { name: string; args: any; result: any; blocked?: boolean; deduplicated?: boolean; originalArgs?: any; resolvedArgs?: any; correctionReason?: string }[];
  errors: string[];
  model: string;
  durationMs: number;
  sessionBlocked: boolean;
}

interface OneBelezaServiceOption {
  servicosId: number;
  descricao: string;
}

interface OneBelezaProfessionalOption {
  servicosId: number | null;
  profissionalId: number;
  nomeProfissional: string;
}

interface OneBelezaSlotOption {
  date: string;
  servicoId: number;
  profissionalId: number;
  horarioInicio: string;
  horarioFim: string;
}

interface AgentSessionState {
  criarAgendamentoSuccessId: number | null;
  scheduledSlotSignatures: string[];
  validAgendasIds: number[];
  oneBelezaServiceOptions: OneBelezaServiceOption[];
  allowedServiceIds: number[];
  oneBelezaProfessionalOptions: OneBelezaProfessionalOption[];
  oneBelezaSlotOptions: OneBelezaSlotOption[];
  bempSalonOptions: Array<{
    salonId: number;
    name: string;
  }>;
  bempProfessionalOptions: Array<{
    salonId: number | null;
    serviceId: number | null;
    professionalId: number;
    name: string;
  }>;
  bempSlotOptions: Array<{
    salonId: number | null;
    serviceId: number | null;
    professionalId: number | null;
    date: string | null;
    start: string;
    end: string;
    start_text?: string;
    end_text?: string;
  }>;
  zayloBarberOptions?: Array<{
    barberId: string;
    name: string;
  }>;
  zayloServiceOptions?: Array<{
    serviceId: string;
    name: string;
    price: number | null;
  }>;
  zayloSlotOptions?: Array<{
    barberId: string | null;
    serviceId: string | null;
    date: string | null;
    time: string;
  }>;
  selectedSalonId: number | null;
  // Persistent selections (survive across messages)
  selectedServiceId: number | null;
  selectedProfessionalId: number | null;
  selectedDate: string | null;
  selectedZayloBarberId?: string | null;
  selectedZayloServiceId?: string | null;
  executedToolNames: string[];
  explicitClientName: string | null;
  nameRejectionCount?: number;
  // OneBeleza: vira true depois de buscar_cliente retornar "não encontrado".
  // Só permitimos cadastrar_cliente quando este flag está true E a última mensagem
  // do cliente contém um nome válido (i.e. ele respondeu à pergunta de nome).
  awaitingNameForRegistration?: boolean;
  // GLOBAL ACTION LEDGER — histórico curto de ações mutáveis concluídas para impedir
  // que a IA repita a mesma ação em mensagens consecutivas. Cross-provider.
  recentCompletedActions?: Array<{
    toolName: string;
    category: string;
    dedupeKey: string;
    status: "success" | "failed" | "blocked";
    completedAt: string; // ISO
    summary: string;
    resultId?: string | number | null;
  }>;
  // ANTI-REPETIÇÃO DE TEXTO — últimas respostas enviadas pela IA, para evitar
  // que ela responda quase a mesma coisa várias vezes seguidas quando o cliente
  // manda mensagens fragmentadas ou repetitivas. TTL 30 min, máx 6.
  recentAssistantReplies?: Array<{
    text: string;
    norm: string;
    at: string; // ISO
  }>;
}


// ===================== PERSISTENT STATE =====================

async function loadConversationState(supabase: any, tenantId: string, phoneNumber: string): Promise<AgentSessionState> {
  const defaultState: AgentSessionState = {
    criarAgendamentoSuccessId: null,
    scheduledSlotSignatures: [],
    validAgendasIds: [],
    oneBelezaServiceOptions: [],
    allowedServiceIds: [],
    oneBelezaProfessionalOptions: [],
    oneBelezaSlotOptions: [],
    bempSalonOptions: [],
    bempProfessionalOptions: [],
    bempSlotOptions: [],
    zayloBarberOptions: [],
    zayloServiceOptions: [],
    zayloSlotOptions: [],
    selectedSalonId: null,
    selectedServiceId: null,
    selectedProfessionalId: null,
    selectedDate: null,
    selectedZayloBarberId: null,
    selectedZayloServiceId: null,
    executedToolNames: [],
    explicitClientName: null,
    awaitingNameForRegistration: false,
    recentCompletedActions: [],
    recentAssistantReplies: [],
  };

  try {
    const { data } = await supabase
      .from("conversation_state")
      .select("state, updated_at")
      .eq("tenant_id", tenantId)
      .eq("phone_number", phoneNumber)
      .limit(1)
      .single();

    if (!data?.state) return defaultState;

    // Expire state older than 2 hours
    const updatedAt = new Date(data.updated_at).getTime();
    if (Date.now() - updatedAt > 2 * 60 * 60 * 1000) {
      console.log(`[State] Expired for ${phoneNumber} (${Math.round((Date.now() - updatedAt) / 60000)}min old)`);
      return defaultState;
    }

    const s = data.state;
    return {
      criarAgendamentoSuccessId: null, // always reset per invocation
      scheduledSlotSignatures: Array.isArray(s.scheduledSlotSignatures) ? s.scheduledSlotSignatures.filter((v: unknown) => typeof v === "string") : [],
      validAgendasIds: Array.isArray(s.validAgendasIds) ? s.validAgendasIds : [],
      oneBelezaServiceOptions: Array.isArray(s.oneBelezaServiceOptions) ? s.oneBelezaServiceOptions : [],
      allowedServiceIds: Array.isArray(s.allowedServiceIds) ? s.allowedServiceIds.filter((id: unknown) => typeof id === "number") : [],
      oneBelezaProfessionalOptions: Array.isArray(s.oneBelezaProfessionalOptions) ? s.oneBelezaProfessionalOptions : [],
      oneBelezaSlotOptions: Array.isArray(s.oneBelezaSlotOptions) ? s.oneBelezaSlotOptions : [],
      bempSalonOptions: Array.isArray(s.bempSalonOptions) ? s.bempSalonOptions : [],
      bempProfessionalOptions: Array.isArray(s.bempProfessionalOptions) ? s.bempProfessionalOptions : [],
      bempSlotOptions: Array.isArray(s.bempSlotOptions) ? s.bempSlotOptions : [],
      zayloBarberOptions: Array.isArray(s.zayloBarberOptions) ? s.zayloBarberOptions : [],
      zayloServiceOptions: Array.isArray(s.zayloServiceOptions) ? s.zayloServiceOptions : [],
      zayloSlotOptions: Array.isArray(s.zayloSlotOptions) ? s.zayloSlotOptions : [],
      selectedSalonId: s.selectedSalonId ?? null,
      selectedServiceId: s.selectedServiceId ?? null,
      selectedProfessionalId: s.selectedProfessionalId ?? null,
      selectedDate: s.selectedDate ?? null,
      selectedZayloBarberId: typeof s.selectedZayloBarberId === "string" ? s.selectedZayloBarberId : null,
      selectedZayloServiceId: typeof s.selectedZayloServiceId === "string" ? s.selectedZayloServiceId : null,
      executedToolNames: Array.isArray(s.executedToolNames) ? s.executedToolNames.filter((name: unknown) => typeof name === "string") : [],
      explicitClientName: isUsableClientName(s.explicitClientName) ? sanitizeClientName(s.explicitClientName) : null,
      awaitingNameForRegistration: Boolean(s.awaitingNameForRegistration),
      recentCompletedActions: Array.isArray(s.recentCompletedActions)
        ? s.recentCompletedActions
            .filter((a: any) => a && typeof a.toolName === "string" && typeof a.dedupeKey === "string" && typeof a.completedAt === "string")
            .slice(-12)
        : [],
      recentAssistantReplies: Array.isArray(s.recentAssistantReplies)
        ? s.recentAssistantReplies
            .filter((r: any) => r && typeof r.text === "string" && typeof r.norm === "string" && typeof r.at === "string")
            .slice(-6)
        : [],
      // Trinks service-lock (carrega entre mensagens, com TTL curto de 20min)
      ...(Array.isArray(s.trinksServiceCatalog) ? { trinksServiceCatalog: s.trinksServiceCatalog } : { trinksServiceCatalog: [] }),
      trinksSelectedServiceId: typeof s.trinksSelectedServiceId === "number" ? s.trinksSelectedServiceId : null,
      trinksSelectedServiceDuration: typeof s.trinksSelectedServiceDuration === "number" ? s.trinksSelectedServiceDuration : null,
      trinksSelectedServiceName: typeof s.trinksSelectedServiceName === "string" ? s.trinksSelectedServiceName : null,
      trinksLockUpdatedAt: typeof s.trinksLockUpdatedAt === "number" ? s.trinksLockUpdatedAt : 0,
    } as AgentSessionState;
  } catch {
    return defaultState;
  }
}

async function saveConversationState(supabase: any, tenantId: string, phoneNumber: string, state: AgentSessionState): Promise<void> {
  try {
    const stateToSave = {
      validAgendasIds: state.validAgendasIds,
      scheduledSlotSignatures: state.scheduledSlotSignatures,
      oneBelezaServiceOptions: state.oneBelezaServiceOptions,
      allowedServiceIds: state.allowedServiceIds,
      oneBelezaProfessionalOptions: state.oneBelezaProfessionalOptions,
      oneBelezaSlotOptions: state.oneBelezaSlotOptions,
      bempSalonOptions: state.bempSalonOptions,
      bempProfessionalOptions: state.bempProfessionalOptions,
      bempSlotOptions: state.bempSlotOptions,
      zayloBarberOptions: state.zayloBarberOptions,
      zayloServiceOptions: state.zayloServiceOptions,
      zayloSlotOptions: state.zayloSlotOptions,
      executedToolNames: state.executedToolNames,
      selectedSalonId: state.selectedSalonId,
      selectedServiceId: state.selectedServiceId,
      selectedProfessionalId: state.selectedProfessionalId,
      selectedDate: state.selectedDate,
      selectedZayloBarberId: state.selectedZayloBarberId,
      selectedZayloServiceId: state.selectedZayloServiceId,
      explicitClientName: state.explicitClientName,
      awaitingNameForRegistration: state.awaitingNameForRegistration ?? false,
      recentCompletedActions: (state.recentCompletedActions || []).slice(-12),
      recentAssistantReplies: (state.recentAssistantReplies || []).slice(-6),
      // Trinks service-lock (sobrevive entre mensagens; impede troca silenciosa de serviço)
      trinksServiceCatalog: Array.isArray((state as any).trinksServiceCatalog)
        ? (state as any).trinksServiceCatalog.slice(0, 200)
        : [],
      trinksSelectedServiceId: (state as any).trinksSelectedServiceId ?? null,
      trinksSelectedServiceDuration: (state as any).trinksSelectedServiceDuration ?? null,
      trinksSelectedServiceName: (state as any).trinksSelectedServiceName ?? null,
      trinksLockUpdatedAt: (state as any).trinksLockUpdatedAt ?? 0,
    };

    await supabase
      .from("conversation_state")
      .upsert(
        { tenant_id: tenantId, phone_number: phoneNumber, state: stateToSave },
        { onConflict: "tenant_id,phone_number" }
      );
    console.log(`[State] Saved for ${phoneNumber}: services=${state.oneBelezaServiceOptions.length}, allowed=${state.allowedServiceIds.length}, profs=${state.oneBelezaProfessionalOptions.length}, slots=${state.oneBelezaSlotOptions.length}, bempSalons=${state.bempSalonOptions.length}, zayloBarbers=${state.zayloBarberOptions?.length || 0}, zayloServices=${state.zayloServiceOptions?.length || 0}, zayloSlots=${state.zayloSlotOptions?.length || 0}, tools=${state.executedToolNames.length}, recentActions=${(state.recentCompletedActions || []).length}, sel=${state.selectedSalonId}/${state.selectedServiceId}/${state.selectedProfessionalId}/${state.selectedDate}/${state.selectedZayloBarberId || "null"}/${state.selectedZayloServiceId || "null"}`);
  } catch (err) {
    console.error("[State] Save failed:", err);
  }
}

// ===================== GLOBAL ACTION LEDGER =====================
// Prevents the AI from repeating the SAME mutating action across consecutive
// user messages in the same conversation. Cross-provider, cross-tool.

const MUTATING_TOOL_CATEGORIES: Record<string, string> = {
  agendar: "booking",
  criar_agendamento: "booking",
  editar_agendamento: "booking_edit",
  cancelar_agendamento: "booking_cancel",
  desmarcar_agendamento: "booking_cancel",
  confirmar_agendamento: "booking_confirm",
  cadastrar_cliente: "client_register",
  atualizar_resumo_cliente: "summary_update",
};

function isMutatingToolName(toolName: string, tenant?: any): { mutating: boolean; category: string } {
  if (MUTATING_TOOL_CATEGORIES[toolName]) {
    return { mutating: true, category: MUTATING_TOOL_CATEGORIES[toolName] };
  }
  // Read-only prefixes are never mutating
  if (/^(buscar_|listar_|consultar_|verificar_|get_|list_|obter_)/i.test(toolName)) {
    return { mutating: false, category: "lookup" };
  }
  // Check custom tool type
  try {
    const customTools = (getEnabledCustomTools as any)?.(tenant) || [];
    const match = customTools.find((t: any) => t?.name === toolName);
    if (match) {
      const type = String(match.type || "");
      // add_label / escalate_human / send_* are mutating side-effects
      if (type) return { mutating: true, category: `custom_${type}` };
    }
  } catch { /* ignore */ }
  // Unknown tool → treat as mutating to be safe
  return { mutating: true, category: "unknown" };
}

function buildDedupeKey(toolName: string, args: any): string {
  if (!args || typeof args !== "object") return `${toolName}|`;
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = (args as any)[k];
      if (v !== undefined && v !== null && v !== "") return String(v);
    }
    return "";
  };

  if (toolName === "agendar" || toolName === "criar_agendamento") {
    const serviceIds: string[] = [];
    const candidates = [args.serviceId, args.servicoId, args.servicosId, args.servicoid];
    for (const c of candidates) if (c) serviceIds.push(String(c));
    if (Array.isArray(args.servicos)) {
      for (const s of args.servicos) {
        const sid = s?.codigo ?? s?.servicoId ?? s?.servicosId ?? s?.id;
        if (sid) serviceIds.push(String(sid));
      }
    }
    const dt = pick("dataHoraInicio", "start");
    const date = pick("dia", "data", "date") || (dt ? dt.slice(0, 10) : "");
    const time = pick("hora", "horario", "time") || (dt.length >= 16 ? dt.slice(11, 16) : "");
    const prof = pick("profissionalId", "professionalId", "barberId");
    const clientHint = pick("clienteId", "clientId", "nome", "name");
    return `${toolName}|${serviceIds.sort().join(",")}|${date}|${time}|${prof}|${clientHint}`;
  }

  if (toolName === "cancelar_agendamento" || toolName === "desmarcar_agendamento" || toolName === "confirmar_agendamento") {
    return `${toolName}|${pick("agendamentoId", "appointmentId", "id", "agendasId")}`;
  }

  if (toolName === "editar_agendamento") {
    return `${toolName}|${pick("agendamentoId", "appointmentId", "id")}|${pick("dataHoraInicio", "start", "data")}|${pick("hora", "time")}`;
  }

  if (toolName === "cadastrar_cliente") {
    return `${toolName}|${(pick("nome", "name") || "").toLowerCase().trim()}`;
  }

  if (toolName === "atualizar_resumo_cliente") {
    // Dedupe by content prefix to avoid repeated identical summary updates
    return `${toolName}|${(pick("summary", "resumo", "content") || "").slice(0, 80).toLowerCase().trim()}`;
  }

  // Custom tools / unknown: stable JSON
  try {
    const sorted = Object.keys(args).sort().reduce((acc: any, k) => { acc[k] = args[k]; return acc; }, {});
    return `${toolName}|${JSON.stringify(sorted).slice(0, 240)}`;
  } catch {
    return `${toolName}|`;
  }
}

function buildActionSummary(toolName: string, args: any, result: any): string {
  try {
    if (toolName === "agendar" || toolName === "criar_agendamento") {
      const date = args?.dia || args?.data || args?.date || (typeof args?.dataHoraInicio === "string" ? args.dataHoraInicio.slice(0, 10) : "");
      const time = args?.hora || args?.horario || args?.time || (typeof args?.dataHoraInicio === "string" && args.dataHoraInicio.length >= 16 ? args.dataHoraInicio.slice(11, 16) : "");
      const prof = args?.profissionalId || args?.professionalId || args?.barberId || "";
      return `agendamento concluído (data=${date || "?"} hora=${time || "?"} prof=${prof || "?"}) id=${result?.id || result?.agendamentoId || "?"}`;
    }
    if (toolName === "cancelar_agendamento" || toolName === "desmarcar_agendamento") {
      return `cancelamento concluído id=${args?.agendamentoId || args?.id || args?.agendasId || "?"}`;
    }
    if (toolName === "confirmar_agendamento") {
      return `confirmação concluída id=${args?.agendamentoId || args?.id || "?"}`;
    }
    if (toolName === "cadastrar_cliente") {
      return `cliente cadastrado: ${args?.nome || args?.name || "?"}`;
    }
    if (toolName === "atualizar_resumo_cliente") {
      return `resumo do cliente atualizado`;
    }
    return `${toolName} executado`;
  } catch {
    return `${toolName} executado`;
  }
}

const ACTION_LEDGER_TTL_MS = 30 * 60 * 1000; // 30 minutos
const ACTION_LEDGER_MAX = 12;

function pruneRecentActions(state: AgentSessionState): AgentSessionState["recentCompletedActions"] {
  const now = Date.now();
  const arr = (state.recentCompletedActions || []).filter((a) => {
    const t = Date.parse(a.completedAt);
    return Number.isFinite(t) && (now - t) < ACTION_LEDGER_TTL_MS;
  });
  return arr.slice(-ACTION_LEDGER_MAX);
}

function findRecentAction(state: AgentSessionState, dedupeKey: string, status: "success" | "failed" | "blocked" = "success"): { toolName: string; category: string; dedupeKey: string; status: string; completedAt: string; summary: string; resultId?: string | number | null } | null {
  const list = pruneRecentActions(state);
  state.recentCompletedActions = list;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].dedupeKey === dedupeKey && list[i].status === status) return list[i];
  }
  return null;
}

function recordCompletedAction(state: AgentSessionState, entry: { toolName: string; category: string; dedupeKey: string; status: "success" | "failed" | "blocked"; summary: string; resultId?: string | number | null }): void {
  const next = pruneRecentActions(state);
  next.push({ ...entry, completedAt: new Date().toISOString() });
  state.recentCompletedActions = next.slice(-ACTION_LEDGER_MAX);
}

// ===================== ANTI-REPETIÇÃO DE RESPOSTAS DA IA =====================
// Evita que a IA mande quase a mesma mensagem várias vezes seguidas quando o
// cliente envia mensagens fragmentadas, repetitivas ou sem nova informação.
const ASSISTANT_REPLY_TTL_MS = 30 * 60 * 1000; // 30 min
const ASSISTANT_REPLY_MAX = 6;
const ASSISTANT_REPLY_SIMILARITY_THRESHOLD = 0.78;

function normalizeReplyForCompare(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function replyTokens(norm: string): Set<string> {
  return new Set(norm.split(" ").filter((w) => w.length >= 3));
}

function replyJaccard(a: string, b: string): number {
  const ta = replyTokens(a);
  const tb = replyTokens(b);
  if (ta.size === 0 || tb.size === 0) return a === b ? 1 : 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  const uni = ta.size + tb.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

function pruneRecentAssistantReplies(state: AgentSessionState): NonNullable<AgentSessionState["recentAssistantReplies"]> {
  const now = Date.now();
  const arr = (state.recentAssistantReplies || []).filter((r) => {
    const t = Date.parse(r.at);
    return Number.isFinite(t) && (now - t) < ASSISTANT_REPLY_TTL_MS;
  });
  return arr.slice(-ASSISTANT_REPLY_MAX);
}

function findSimilarRecentReply(state: AgentSessionState, candidate: string): { idx: number; sim: number; entry: { text: string; norm: string; at: string } } | null {
  const list = pruneRecentAssistantReplies(state);
  state.recentAssistantReplies = list;
  const norm = normalizeReplyForCompare(candidate);
  if (norm.length < 8) return null; // muito curto (ex: "ok") — não bloqueia
  let best: { idx: number; sim: number; entry: any } | null = null;
  for (let i = 0; i < list.length; i++) {
    const sim = replyJaccard(norm, list[i].norm);
    if (sim >= ASSISTANT_REPLY_SIMILARITY_THRESHOLD && (!best || sim > best.sim)) {
      best = { idx: i, sim, entry: list[i] };
    }
  }
  return best;
}

function recordAssistantReply(state: AgentSessionState, text: string): void {
  const trimmed = (text || "").trim();
  if (!trimmed) return;
  const norm = normalizeReplyForCompare(trimmed);
  if (norm.length < 4) return;
  const next = pruneRecentAssistantReplies(state);
  next.push({ text: trimmed.slice(0, 600), norm: norm.slice(0, 600), at: new Date().toISOString() });
  state.recentAssistantReplies = next.slice(-ASSISTANT_REPLY_MAX);
}


// Constrói uma mensagem determinística de confirmação de agendamento a partir
// dos tool_calls da rodada. Usada como rede de segurança quando a IA cria a
// reserva mas falha em produzir resposta textual ao cliente (estouro de rounds,
// content vazio, etc.). Cobre Frizzar / Trinks / One Beleza / Bemp / Zaylo.
function buildDeterministicBookingConfirmation(
  logToolCalls: Array<{ name: string; args: any; result: any; blocked?: boolean }>,
): string | null {
  const bookingNames = new Set(["agendar", "criar_agendamento"]);
  // Pega a ÚLTIMA chamada de booking bem-sucedida nesta rodada
  let chosen: { name: string; args: any; result: any } | null = null;
  for (const tc of logToolCalls || []) {
    if (!tc || tc.blocked) continue;
    if (!bookingNames.has(tc.name)) continue;
    const r: any = tc.result || {};
    const ok = !r.error && r.success !== false
      && !(Array.isArray(r.Errors) && r.Errors.length > 0)
      && (r.id || r.ok || r.success === true || r.agendamentoId || r.appointment_id || r.data);
    if (ok) chosen = { name: tc.name, args: tc.args || {}, result: r };
  }
  if (!chosen) return null;

  const r: any = chosen.result;
  const args: any = chosen.args || {};

  // --- Extrai data/hora em formato amigável ---
  let quando = "";
  // Frizzar: result.inicioFormatado "29/06 10:00" ou agendamentos[0].inicio ISO
  if (typeof r.inicioFormatado === "string") {
    quando = r.inicioFormatado;
  } else if (Array.isArray(r.agendamentos) && r.agendamentos[0]) {
    const a = r.agendamentos[0];
    if (typeof a.inicioFormatado === "string") quando = a.inicioFormatado;
    else if (typeof a.inicio === "string") {
      const d = new Date(a.inicio);
      if (!isNaN(d.getTime())) {
        const dd = String(d.getUTCDate()).padStart(2, "0");
        const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
        const hh = String(d.getUTCHours()).padStart(2, "0");
        const mi = String(d.getUTCMinutes()).padStart(2, "0");
        quando = `${dd}/${mm} ${hh}:${mi}`;
      }
    }
  }
  // Fallback: pega de args (data + hora / dataHoraInicio)
  if (!quando) {
    const dataArg = args.dia || args.data || args.date;
    const horaArg = args.hora || args.time;
    if (dataArg && horaArg) {
      // formata YYYY-MM-DD para DD/MM
      const m = String(dataArg).match(/^(\d{4})-(\d{2})-(\d{2})/);
      quando = m ? `${m[3]}/${m[2]} ${horaArg}` : `${dataArg} ${horaArg}`;
    } else if (args.dataHoraInicio) {
      const d = new Date(args.dataHoraInicio);
      if (!isNaN(d.getTime())) {
        const dd = String(d.getUTCDate()).padStart(2, "0");
        const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
        const hh = String(d.getUTCHours()).padStart(2, "0");
        const mi = String(d.getUTCMinutes()).padStart(2, "0");
        quando = `${dd}/${mm} ${hh}:${mi}`;
      }
    }
  }

  // --- Serviço ---
  let servico = "";
  if (typeof r.servico === "string") servico = r.servico;
  else if (Array.isArray(r.agendamentos) && r.agendamentos[0]?.servicoNome) servico = r.agendamentos[0].servicoNome;
  else if (typeof r.service_name === "string") servico = r.service_name;

  // --- Profissional ---
  let prof = "";
  if (typeof r.profissional === "string") prof = r.profissional;
  else if (Array.isArray(r.agendamentos) && r.agendamentos[0]?.funcionarioNome) prof = r.agendamentos[0].funcionarioNome;
  else if (typeof r.professional_name === "string") prof = r.professional_name;
  else if (r.data && typeof r.data === "object" && typeof (r.data as any).professional_name === "string") prof = (r.data as any).professional_name;

  if (!quando && !servico && !prof) {
    // Sem nenhuma informação útil — melhor não enviar nada quebrado
    return null;
  }

  const partes: string[] = ["Prontinho, agendamento confirmado ✅"];
  if (servico) partes.push(`Serviço: ${servico}`);
  if (prof) partes.push(`Profissional: ${prof}`);
  if (quando) partes.push(`Quando: ${quando}`);
  partes.push("Te espero! 😊");
  return partes.join("\n");
}

function isRecoverableFrizzarScheduleResult(result: any): boolean {
  if (!result || typeof result !== "object" || !result.error) return false;
  const errorText = String(result.error || "");
  if (/cliente bloqueado|limite de agendamentos/i.test(errorText)) return false;
  const hasSameDaySlots = Array.isArray(result.horariosLivres);
  const hasOtherDaySlots = Array.isArray(result.outrosDias);
  return hasSameDaySlots || hasOtherDaySlots || /hor[aá]rio.*indispon[ií]vel|sem vagas|hor[aá]rios livres|ofere[cç]a um dos hor[aá]rios|antes de agendar|data divergente/i.test(errorText);
}

function buildFrizzarScheduleRecoveryInstruction(result: any, args: any = {}): string {
  const requestedTime = typeof args?.hora === "string" ? args.hora : "o horário pedido";
  const requestedDay = typeof args?.dia === "string" ? args.dia : "a data solicitada";
  const shouldListFirst = result?.blocked === true && !Array.isArray(result?.horariosLivres) && !Array.isArray(result?.outrosDias);
  const sameDaySlots = Array.isArray(result?.horariosLivres)
    ? result.horariosLivres.filter((h: unknown) => typeof h === "string").slice(0, 5)
    : [];
  const otherDayOptions = Array.isArray(result?.outrosDias)
    ? result.outrosDias
        .filter((d: any) => Array.isArray(d?.horariosLivres) && d.horariosLivres.length > 0)
        .slice(0, 3)
        .map((d: any) => ({
          dia: String(d?.dia || ""),
          horariosLivres: d.horariosLivres.filter((h: unknown) => typeof h === "string").slice(0, 3),
        }))
    : [];

  const alternatives = shouldListFirst
    ? "Antes de responder ao cliente, chame listar_horarios para esse profissional/data/serviços e use somente horariosLivres."
    : sameDaySlots.length > 0
      ? `Horários disponíveis no mesmo dia: ${sameDaySlots.join(", ")}.`
      : otherDayOptions.length > 0
        ? `Sem vaga nesse dia. Alternativas em outros dias: ${JSON.stringify(otherDayOptions)}.`
        : "Não há horários livres úteis na resposta; peça outro dia ao cliente.";

  return [
    "⚠️ FALHA RECUPERÁVEL DE HORÁRIO NA FRIZZAR.",
    `O cliente tentou ${requestedTime} em ${requestedDay}, mas esse horário NÃO está disponível.`,
    "É PROIBIDO escalar humano por esse motivo e é PROIBIDO dizer que agendou.",
    alternatives,
    shouldListFirst
      ? "Não responda ainda e não escale humano: execute listar_horarios agora."
      : "Responda agora em português, curto e natural, dizendo que esse horário não está disponível e oferecendo 2-3 alternativas. Só chame agendar depois que o cliente escolher uma alternativa exata.",
  ].join(" ");
}


// ===================== ID RESOLUTION LAYER =====================


interface IdResolutionResult {
  resolvedArgs: any;
  corrected: boolean;
  correctionReason: string | null;
  blocked: boolean;
  blockMessage: string | null;
}

function resolveOneBelezaServiceId(
  args: any,
  sessionState: AgentSessionState,
): { id: number | null; corrected: boolean; reason: string | null } {
  const rawId = toPositiveInteger(args?.servicosId ?? args?.servicoId ?? args?.servicoid);
  
  if (!rawId) {
    // Use selected if available
    if (sessionState.selectedServiceId) {
      return { id: sessionState.selectedServiceId, corrected: true, reason: `servicoId ausente, usando seleção persistida ${sessionState.selectedServiceId}` };
    }
    return { id: null, corrected: false, reason: null };
  }

  // Check if the ID is valid
  const isValid = sessionState.oneBelezaServiceOptions.some(o => o.servicosId === rawId);
  if (isValid) {
    return { id: rawId, corrected: false, reason: null };
  }

  // Try to find by closest match or use selected
  if (sessionState.selectedServiceId) {
    const selectedValid = sessionState.oneBelezaServiceOptions.some(o => o.servicosId === sessionState.selectedServiceId);
    if (selectedValid) {
      return { id: sessionState.selectedServiceId, corrected: true, reason: `servicoId ${rawId} inválido, corrigido para ${sessionState.selectedServiceId} (persistido)` };
    }
  }

  // Single option auto-correct
  if (sessionState.oneBelezaServiceOptions.length === 1) {
    const onlyId = sessionState.oneBelezaServiceOptions[0].servicosId;
    return { id: onlyId, corrected: true, reason: `servicoId ${rawId} inválido, corrigido para único válido ${onlyId}` };
  }

  return { id: rawId, corrected: false, reason: null };
}

function resolveOneBelezaProfessionalId(
  args: any,
  sessionState: AgentSessionState,
  servicoId: number | null,
): { id: number | null; corrected: boolean; reason: string | null } {
  const rawId = toPositiveInteger(args?.profissionalId ?? args?.ProfissionalId ?? args?.profissionalid);
  
  if (!rawId) {
    if (sessionState.selectedProfessionalId) {
      return { id: sessionState.selectedProfessionalId, corrected: true, reason: `profissionalId ausente, usando seleção persistida ${sessionState.selectedProfessionalId}` };
    }
    return { id: null, corrected: false, reason: null };
  }

  // Check if the ID is valid in known professionals
  const validProfessionals = sessionState.oneBelezaProfessionalOptions.filter(
    o => o.servicosId === servicoId || o.servicosId === null
  );

  if (validProfessionals.length === 0) {
    // No professionals tracked yet — let it through
    return { id: rawId, corrected: false, reason: null };
  }

  const isValid = validProfessionals.some(o => o.profissionalId === rawId);
  if (isValid) {
    return { id: rawId, corrected: false, reason: null };
  }

  // Use persisted selection
  if (sessionState.selectedProfessionalId) {
    const selectedValid = validProfessionals.some(o => o.profissionalId === sessionState.selectedProfessionalId);
    if (selectedValid) {
      return { id: sessionState.selectedProfessionalId, corrected: true, reason: `profissionalId ${rawId} inválido, corrigido para ${sessionState.selectedProfessionalId} (persistido)` };
    }
  }

  // Single option auto-correct
  if (validProfessionals.length === 1) {
    const onlyId = validProfessionals[0].profissionalId;
    return { id: onlyId, corrected: true, reason: `profissionalId ${rawId} inválido, corrigido para único válido ${onlyId}` };
  }

  // Block with helpful error
  return { id: null, corrected: false, reason: `profissionalId ${rawId} não encontrado entre os válidos: ${validProfessionals.map(p => `${p.profissionalId} (${p.nomeProfissional})`).join(", ")}` };
}

function resolveOneBelezaToolArgs(
  toolName: string,
  parsedArgs: any,
  sessionState: AgentSessionState,
): IdResolutionResult {
  const result: IdResolutionResult = {
    resolvedArgs: { ...parsedArgs },
    corrected: false,
    correctionReason: null,
    blocked: false,
    blockMessage: null,
  };

  const corrections: string[] = [];
  const shouldGuardServiceId = ["buscar_barbeiros_por_servico", "buscar_datas_disponiveis", "buscar_horarios", "buscar_horarios_disponiveis", "agendar"].includes(toolName);
  const allowedServiceIds = getAllowedOneBelezaServiceIds(sessionState);

  if (shouldGuardServiceId && allowedServiceIds.length > 0) {
    const incomingServiceId = toPositiveInteger(
      parsedArgs?.servicosId ?? parsedArgs?.servicoId ?? parsedArgs?.servicoid,
    );

    if (incomingServiceId && !allowedServiceIds.includes(incomingServiceId)) {
      result.blocked = true;
      result.blockMessage = `servicosId ${incomingServiceId} não pertence à unidade desta barbearia. Use APENAS um destes IDs: ${allowedServiceIds.join(", ")}.`;
      return result;
    }

    // Unit guard: prevent silently switching between gservsID groups (e.g., Barbearia ↔ Estúdio) mid-flow
    const unitMap = (sessionState as any).oneBelezaServiceUnitMap as
      | Record<string, { gservsID: number; descricao: string }>
      | undefined;
    const selectedUnit = (sessionState as any).selectedUnit as
      | { gservsID: number; descricao: string }
      | undefined;
    if (incomingServiceId && unitMap && unitMap[String(incomingServiceId)]) {
      const incomingUnit = unitMap[String(incomingServiceId)];
      if (selectedUnit && selectedUnit.gservsID !== incomingUnit.gservsID) {
        result.blocked = true;
        result.blockMessage = `servicosId ${incomingServiceId} pertence a "${incomingUnit.descricao}", mas o cliente já está sendo atendido em "${selectedUnit.descricao}". Confirme com o cliente se ele quer trocar de unidade antes de prosseguir.`;
        return result;
      }
      // Auto-set selected unit if not yet defined
      if (!selectedUnit) {
        (sessionState as any).selectedUnit = incomingUnit;
        console.log(`[State] Auto-selected OneBeleza unit: ${incomingUnit.descricao} (gservsID=${incomingUnit.gservsID}) via servicosId=${incomingServiceId}`);
      }
    }
  }

  if (toolName === "buscar_barbeiros_por_servico") {
    const svc = resolveOneBelezaServiceId(parsedArgs, sessionState);
    if (svc.id && svc.corrected) {
      result.resolvedArgs.servicosId = String(svc.id);
      corrections.push(svc.reason!);
    } else if (!svc.id && sessionState.oneBelezaServiceOptions.length > 0) {
      result.blocked = true;
      result.blockMessage = `servicosId ${parsedArgs?.servicosId ?? "(ausente)"} inválido. Opções válidas: ${sessionState.oneBelezaServiceOptions.map(o => `${o.servicosId} (${o.descricao})`).join(", ")}`;
    }
  }

  if (toolName === "buscar_datas_disponiveis") {
    const svc = resolveOneBelezaServiceId(parsedArgs, sessionState);
    if (svc.id && svc.corrected) {
      result.resolvedArgs.servicosId = String(svc.id);
      corrections.push(svc.reason!);
    }
    const prof = resolveOneBelezaProfessionalId(parsedArgs, sessionState, svc.id);
    if (prof.id && prof.corrected) {
      result.resolvedArgs.profissionalid = String(prof.id);
      corrections.push(prof.reason!);
    } else if (!prof.id && prof.reason) {
      result.blocked = true;
      result.blockMessage = prof.reason;
    }
  }

  if (toolName === "buscar_horarios_disponiveis") {
    const svc = resolveOneBelezaServiceId({ servicoId: parsedArgs?.servicoId ?? parsedArgs?.servicosId }, sessionState);
    if (svc.id && svc.corrected) {
      result.resolvedArgs.servicoId = String(svc.id);
      corrections.push(svc.reason!);
    } else if (!svc.id && svc.reason) {
      result.blocked = true;
      result.blockMessage = svc.reason;
    }
    const rawDate = normalizeOneBelezaDate(parsedArgs?.date);
    if (!rawDate && sessionState.selectedDate) {
      result.resolvedArgs.date = sessionState.selectedDate;
      corrections.push(`date ausente, usando data persistida ${sessionState.selectedDate}`);
    }
  }

  if (toolName === "buscar_horarios") {
    const svc = resolveOneBelezaServiceId({ servicoId: parsedArgs?.servicoId }, sessionState);
    if (svc.id && svc.corrected) {
      result.resolvedArgs.servicoId = String(svc.id);
      corrections.push(svc.reason!);
    }
    const prof = resolveOneBelezaProfessionalId(parsedArgs, sessionState, svc.id ?? toPositiveInteger(parsedArgs?.servicoId));
    if (prof.id && prof.corrected) {
      result.resolvedArgs.ProfissionalId = String(prof.id);
      corrections.push(prof.reason!);
    } else if (!prof.id && prof.reason) {
      result.blocked = true;
      result.blockMessage = prof.reason;
    }

    // Resolve date from persisted state
    const rawDate = normalizeOneBelezaDate(parsedArgs?.date);
    if (!rawDate && sessionState.selectedDate) {
      result.resolvedArgs.date = sessionState.selectedDate;
      corrections.push(`date ausente, usando data persistida ${sessionState.selectedDate}`);
    }
  }

  if (toolName === "agendar") {
    // Service
    const svc = resolveOneBelezaServiceId({ servicoId: parsedArgs?.servicoid ?? parsedArgs?.servicoId ?? parsedArgs?.servicosId }, sessionState);
    if (svc.id && svc.corrected) {
      result.resolvedArgs.servicoid = String(svc.id);
      corrections.push(svc.reason!);
    }
    // Professional
    const prof = resolveOneBelezaProfessionalId(parsedArgs, sessionState, svc.id);
    if (prof.id && prof.corrected) {
      result.resolvedArgs.profissionalId = String(prof.id);
      corrections.push(prof.reason!);
    }
    // Date
    const rawDate = normalizeOneBelezaDate(parsedArgs?.dataNumero ?? parsedArgs?.dataAg ?? parsedArgs?.date ?? parsedArgs?.data);
    if (!rawDate && sessionState.selectedDate) {
      result.resolvedArgs.dataNumero = sessionState.selectedDate;
      corrections.push(`dataNumero ausente, usando data persistida ${sessionState.selectedDate}`);
    }
  }

  if (corrections.length > 0) {
    result.corrected = true;
    result.correctionReason = corrections.join("; ");
    console.log(`[IDResolver] ${toolName} corrections: ${result.correctionReason}`);
  }

  return result;
}

// ===================== HELPERS =====================

function parseToolArguments(rawArgs?: string): any {
  try {
    return JSON.parse(rawArgs || "{}");
  } catch {
    return {};
  }
}

function toPositiveInteger(value: unknown): number | null {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;

  const parsed = parseInt(normalized, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// Reconcile a hallucinated agendasId to the correct one from validAgendasIds
function reconcileOneBelezaAgendaId(
  hallucinated: number,
  sessionState: AgentSessionState,
  messages: any[],
): number | null {
  const validIds = sessionState.validAgendasIds;
  const agendaOptions = (sessionState as any).oneBelezaAgendaOptions as any[] | undefined;

  if (validIds.length === 1) return validIds[0];

  if (agendaOptions && agendaOptions.length > 0) {
    const lastAssistantMsg = [...messages].reverse().find((m: any) => m.role === "assistant" && typeof m.content === "string");
    const assistantText = lastAssistantMsg?.content || "";

    const timeMatch = assistantText.match(/(\d{1,2})[h:](\d{2})/);
    if (timeMatch) {
      const mentionedTime = `${timeMatch[1].padStart(2, "0")}:${timeMatch[2]}`;
      const matchByTime = agendaOptions.find((a: any) => (a.horarioInicio || "").substring(0, 5) === mentionedTime);
      if (matchByTime) return matchByTime.agendasId;
    }

    for (const agenda of agendaOptions) {
      if (agenda.descricaoServico && assistantText.toLowerCase().includes(agenda.descricaoServico.toLowerCase())) {
        const serviceMatches = agendaOptions.filter((a: any) => a.descricaoServico?.toLowerCase() === agenda.descricaoServico.toLowerCase());
        if (serviceMatches.length === 1) return serviceMatches[0].agendasId;
      }
    }
  }

  console.log(`[OneBeleza] reconcileAgendaId: fallback to first valid ID ${validIds[0]}`);
  return validIds[0];
}

function dedupeByKey<T>(items: T[], getKey: (item: T) => string): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];

  for (const item of items) {
    const key = getKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

function normalizeOneBelezaDate(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";

  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return normalized;
  }

  const brMatch = normalized.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (brMatch) {
    const [, day, month, year] = brMatch;
    return `${year}-${month}-${day}`;
  }

  return normalized;
}

function normalizeOneBelezaTime(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";

  if (/^\d{2}:\d{2}$/.test(normalized)) {
    return `${normalized}:00`;
  }

  return normalized;
}

function normalizeSearchText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function getOneBelezaUnitFilterList(tenant: any): string[] {
  const rawFilter = tenant?.agent_settings?.onebeleza_unit_filter;
  const list = Array.isArray(rawFilter)
    ? rawFilter.filter((value: unknown) => typeof value === "string" && value.trim())
    : (typeof rawFilter === "string" && rawFilter.trim() ? [rawFilter] : []);

  return dedupeByKey(list.map((value) => value.trim()), (value) => normalizeSearchText(value));
}

function getAllowedOneBelezaServiceIds(sessionState: AgentSessionState): number[] {
  if (sessionState.allowedServiceIds.length > 0) {
    return dedupeByKey(sessionState.allowedServiceIds, (id) => String(id));
  }

  return dedupeByKey(
    sessionState.oneBelezaServiceOptions.map((option) => option.servicosId),
    (id) => String(id),
  );
}

function extractOneBelezaServiceOptions(toolResult: any): OneBelezaServiceOption[] {
  if (!Array.isArray(toolResult)) return [];

  const options: OneBelezaServiceOption[] = [];

  for (const groupOrService of toolResult) {
    const groupedServices = Array.isArray(groupOrService?.servicos)
      ? groupOrService.servicos
      : [groupOrService];

    for (const service of groupedServices) {
      const servicosId = toPositiveInteger(service?.servicosId ?? service?.servicoId ?? service?.id);
      if (!servicosId) continue;

      options.push({
        servicosId,
        descricao: String(service?.descricao || groupOrService?.descricao || `Serviço ${servicosId}`),
      });
    }
  }

  return dedupeByKey(options, (option) => String(option.servicosId));
}

function extractOneBelezaProfessionalOptions(toolResult: any, args: any): OneBelezaProfessionalOption[] {
  if (!Array.isArray(toolResult)) return [];

  const servicosId = toPositiveInteger(args?.servicosId ?? args?.servicoId ?? args?.servicoid);
  const options = toolResult.flatMap((item: any) => {
    const profissionalId = toPositiveInteger(item?.profissionalId ?? item?.id);
    if (!profissionalId) return [];

    return [{
      servicosId,
      profissionalId,
      nomeProfissional: String(item?.nomeProfissional || item?.nome || item?.descricao || `Profissional ${profissionalId}`),
    }];
  });

  return dedupeByKey(options, (option) => `${option.servicosId ?? "any"}:${option.profissionalId}`);
}

function extractOneBelezaProfessionalOptionsFromAvailability(toolResult: any, args: any): OneBelezaProfessionalOption[] {
  if (!Array.isArray(toolResult)) return [];

  const servicosId = toPositiveInteger(args?.servicoId ?? args?.servicosId ?? args?.servicoid);
  const options: OneBelezaProfessionalOption[] = [];

  for (const item of toolResult) {
    const disponibilidades = Array.isArray(item?.disponibilidades) ? item.disponibilidades : [];
    for (const disponibilidade of disponibilidades) {
      const profissionalId = toPositiveInteger(disponibilidade?.profissionalId);
      if (!profissionalId) continue;

      options.push({
        servicosId,
        profissionalId,
        nomeProfissional: String(
          disponibilidade?.profissionalNome || disponibilidade?.nomeProfissional || disponibilidade?.nome || `Profissional ${profissionalId}`,
        ),
      });
    }
  }

  return dedupeByKey(options, (option) => `${option.servicosId ?? "any"}:${option.profissionalId}`);
}

function extractOneBelezaSlotOptions(toolResult: any, args: any): OneBelezaSlotOption[] {
  if (!Array.isArray(toolResult)) return [];

  const date = normalizeOneBelezaDate(args?.date ?? args?.dataNumero ?? args?.dataAg ?? args?.data);
  const fallbackServiceId = toPositiveInteger(args?.servicoId ?? args?.servicoid ?? args?.servicosId);
  const fallbackProfessionalId = toPositiveInteger(args?.ProfissionalId ?? args?.profissionalId ?? args?.profissionalid);
  const slots: OneBelezaSlotOption[] = [];

  const pushSlot = (
    servicoIdValue: unknown,
    profissionalIdValue: unknown,
    horarioInicioValue: unknown,
    horarioFimValue: unknown,
  ) => {
    const servicoId = toPositiveInteger(servicoIdValue);
    const profissionalId = toPositiveInteger(profissionalIdValue);
    const horarioInicio = String(horarioInicioValue ?? "").trim();
    const horarioFim = String(horarioFimValue ?? "").trim();

    if (!date || !servicoId || !profissionalId || !horarioInicio || !horarioFim) return;

    slots.push({
      date,
      servicoId,
      profissionalId,
      horarioInicio,
      horarioFim,
    });
  };

  for (const item of toolResult) {
    if (Array.isArray(item?.disponibilidades)) {
      const itemServiceId = toPositiveInteger(item?.servicoId ?? item?.servicosId ?? fallbackServiceId);

      for (const disponibilidade of item.disponibilidades) {
        const itemProfessionalId = toPositiveInteger(disponibilidade?.profissionalId ?? fallbackProfessionalId);
        const horarios = Array.isArray(disponibilidade?.horarios) ? disponibilidade.horarios : [];

        for (const horario of horarios) {
          pushSlot(
            itemServiceId,
            itemProfessionalId,
            horario?.horarioInicio,
            horario?.horarioFinal ?? horario?.horarioFim,
          );
        }
      }
    }

    pushSlot(
      item?.servicoId ?? fallbackServiceId,
      item?.profissionalId ?? fallbackProfessionalId,
      item?.horarioInicio,
      item?.horarioFinal ?? item?.horarioFim,
    );
  }

  return dedupeByKey(
    slots,
    (slot) => `${slot.date}:${slot.servicoId}:${slot.profissionalId}:${slot.horarioInicio}:${slot.horarioFim}`,
  );
}

function buildNormalizedOneBelezaAgendarArgs(parsedArgs: any, slot: OneBelezaSlotOption): any {
  return {
    ...parsedArgs,
    dataNumero: slot.date,
    servicoid: String(slot.servicoId),
    profissionalId: String(slot.profissionalId),
    horarioInicio: slot.horarioInicio,
    horarioFim: slot.horarioFim,
  };
}

function reconcileOneBelezaSchedulingArgs(
  parsedArgs: any,
  sessionState: AgentSessionState,
): { args: any; adjusted: boolean; corrected: boolean } {
  const servicoId = toPositiveInteger(parsedArgs?.servicoid ?? parsedArgs?.servicoId ?? parsedArgs?.servicosId);
  const profissionalId = toPositiveInteger(parsedArgs?.profissionalId ?? parsedArgs?.ProfissionalId ?? parsedArgs?.profissionalid);
  const dataNumero = normalizeOneBelezaDate(parsedArgs?.dataNumero ?? parsedArgs?.dataAg ?? parsedArgs?.date ?? parsedArgs?.data);
  const horarioInicio = normalizeOneBelezaTime(parsedArgs?.horarioInicio);
  const horarioFim = normalizeOneBelezaTime(parsedArgs?.horarioFim ?? parsedArgs?.horarioFinal);

  const normalizedArgs = {
    ...parsedArgs,
    ...(dataNumero ? { dataNumero } : {}),
    ...(servicoId ? { servicoid: String(servicoId) } : {}),
    ...(profissionalId ? { profissionalId: String(profissionalId) } : {}),
    ...(horarioInicio ? { horarioInicio } : {}),
    ...(horarioFim ? { horarioFim } : {}),
  };

  // AUTO-FILL profissionalId quando ausente: se temos slots no estado da sessão
  // que combinam servicoId + data + horarioInicio, escolhemos o profissional do
  // primeiro slot compatível (= "qualquer barbeiro" se vários).
  let effectiveProfissionalId = profissionalId;
  if (!effectiveProfissionalId && servicoId && dataNumero && horarioInicio) {
    const candidateSlots = sessionState.oneBelezaSlotOptions.filter((slot) => {
      if (slot.servicoId !== servicoId) return false;
      if (slot.date !== dataNumero) return false;
      if (slot.horarioInicio !== horarioInicio) return false;
      if (horarioFim && slot.horarioFim !== horarioFim) return false;
      return true;
    });
    if (candidateSlots.length > 0) {
      effectiveProfissionalId = candidateSlots[0].profissionalId;
      normalizedArgs.profissionalId = String(effectiveProfissionalId);
      console.log(
        `[OneBeleza] reconcile auto-filled profissionalId=${effectiveProfissionalId} from slot match (servico=${servicoId}, data=${dataNumero}, inicio=${horarioInicio}, candidates=${candidateSlots.length})`,
      );
    }
  }

  if (!servicoId || !effectiveProfissionalId || !dataNumero || !horarioInicio) {
    return {
      args: normalizedArgs,
      adjusted: JSON.stringify(normalizedArgs) !== JSON.stringify(parsedArgs),
      corrected: !!effectiveProfissionalId && effectiveProfissionalId !== profissionalId,
    };
  }

  // Reatribui para que o restante do código use o valor efetivo
  const profissionalIdResolved = effectiveProfissionalId;

  const validSlotOptionsForDate = sessionState.oneBelezaSlotOptions.filter((slot) => {
    if (slot.servicoId !== servicoId) return false;
    if (slot.date !== dataNumero) return false;
    return true;
  });

  const validSlotOptions = validSlotOptionsForDate.filter((slot) => slot.profissionalId === profissionalIdResolved);

  const wasAutoFilled = !profissionalId && !!profissionalIdResolved;

  if (validSlotOptions.length === 0 && horarioInicio) {
    const uniqueStartMatchAcrossProfessionals = validSlotOptionsForDate.filter((slot) => {
      if (slot.horarioInicio !== horarioInicio) return false;
      if (horarioFim && slot.horarioFim !== horarioFim) return false;
      return true;
    });

    if (uniqueStartMatchAcrossProfessionals.length === 1) {
      return {
        args: buildNormalizedOneBelezaAgendarArgs(normalizedArgs, uniqueStartMatchAcrossProfessionals[0]),
        adjusted: true,
        corrected: true,
      };
    }
  }

  if (validSlotOptions.length === 0) {
    return {
      args: normalizedArgs,
      adjusted: JSON.stringify(normalizedArgs) !== JSON.stringify(parsedArgs),
      corrected: false,
    };
  }

  const exactMatch = validSlotOptions.find(
    (slot) => slot.horarioInicio === horarioInicio && slot.horarioFim === horarioFim,
  );
  if (exactMatch) {
    const exactArgs = buildNormalizedOneBelezaAgendarArgs(normalizedArgs, exactMatch);
    return {
      args: exactArgs,
      adjusted: JSON.stringify(exactArgs) !== JSON.stringify(parsedArgs),
      corrected: wasAutoFilled,
    };
  }


  const startOnlyMatch = validSlotOptions.find((slot) => slot.horarioInicio === horarioInicio);
  if (!startOnlyMatch) {
    return {
      args: normalizedArgs,
      adjusted: JSON.stringify(normalizedArgs) !== JSON.stringify(parsedArgs),
      corrected: false,
    };
  }

  return {
    args: buildNormalizedOneBelezaAgendarArgs(normalizedArgs, startOnlyMatch),
    adjusted: true,
    corrected: horarioFim !== startOnlyMatch.horarioFim,
  };
}

function buildOneBelezaSchedulingValidationResult(
  parsedArgs: any,
  sessionState: AgentSessionState,
): any | null {
  const allowedServiceIds = getAllowedOneBelezaServiceIds(sessionState);

  if (sessionState.oneBelezaServiceOptions.length === 0) {
    return {
      error: "Antes de agendar, execute buscar_servicos nesta interação e use um servicosId real do retorno.",
      blocked: true,
    };
  }

  if (sessionState.oneBelezaProfessionalOptions.length === 0) {
    return {
      error: "Antes de agendar, execute buscar_barbeiros_por_servico nesta interação e use um profissionalId real do retorno.",
      blocked: true,
    };
  }

  if (sessionState.oneBelezaSlotOptions.length === 0) {
    return {
      error: "Antes de agendar, execute buscar_horarios nesta interação e use exatamente um horário retornado.",
      blocked: true,
    };
  }

  const servicoId = toPositiveInteger(parsedArgs?.servicoid ?? parsedArgs?.servicoId ?? parsedArgs?.servicosId);
  const profissionalId = toPositiveInteger(parsedArgs?.profissionalId ?? parsedArgs?.ProfissionalId ?? parsedArgs?.profissionalid);
  const dataNumero = normalizeOneBelezaDate(parsedArgs?.dataNumero ?? parsedArgs?.dataAg ?? parsedArgs?.date ?? parsedArgs?.data);
  const horarioInicio = normalizeOneBelezaTime(parsedArgs?.horarioInicio);
  const horarioFim = normalizeOneBelezaTime(parsedArgs?.horarioFim ?? parsedArgs?.horarioFinal);

  if (servicoId && allowedServiceIds.length > 0 && !allowedServiceIds.includes(servicoId)) {
    return {
      error: `servicoId ${servicoId} não pertence à unidade desta barbearia. Use APENAS um dos IDs permitidos: ${allowedServiceIds.join(", ")}.`,
      allowedServiceIds,
      blocked: true,
    };
  }

  if (!servicoId || !sessionState.oneBelezaServiceOptions.some((option) => option.servicosId === servicoId)) {
    return {
      error: `servicoId ${servicoId ?? "(ausente)"} inválido. Use APENAS um servicosId real retornado por buscar_servicos nesta interação.`,
      validServiceOptions: sessionState.oneBelezaServiceOptions,
      blocked: true,
    };
  }

  const validProfessionalOptions = dedupeByKey(
    sessionState.oneBelezaProfessionalOptions.filter((option) => option.servicosId === servicoId || option.servicosId === null),
    (option) => String(option.profissionalId),
  );

  if (
    validProfessionalOptions.length > 0 &&
    (!profissionalId || !validProfessionalOptions.some((option) => option.profissionalId === profissionalId))
  ) {
    // Mensagem mais didática: lista nomes + IDs reais e dica de auto-fill quando há horário
    const optsForPrompt = validProfessionalOptions.map((o) => ({
      profissionalId: o.profissionalId,
      nome: o.nomeProfissional,
    }));
    const hint = horarioInicio
      ? ` Se o cliente disse "qualquer barbeiro", escolha o primeiro profissionalId da lista que tenha esse horário disponível e chame agendar novamente com esse profissionalId.`
      : ` Pergunte ao cliente qual desses profissionais ele prefere, ou se "qualquer barbeiro", use o primeiro da lista.`;
    return {
      error: `profissionalId ${profissionalId ?? "(ausente)"} inválido para o serviço ${servicoId}. Use APENAS um dos profissionalId reais listados.${hint}`,
      validProfessionalOptions: optsForPrompt,
      blocked: true,
    };
  }

  if (!dataNumero || !horarioInicio || !horarioFim) {
    return {
      error: "dataNumero, horarioInicio e horarioFim são obrigatórios e devem vir EXATAMENTE do retorno de buscar_horarios.",
      validSlotOptions: sessionState.oneBelezaSlotOptions.slice(0, 20),
      blocked: true,
    };
  }

  const validSlotOptions = sessionState.oneBelezaSlotOptions.filter((slot) => {
    if (slot.servicoId !== servicoId) return false;
    if (profissionalId && slot.profissionalId !== profissionalId) return false;
    if (slot.date !== dataNumero) return false;
    return true;
  });

  if (validSlotOptions.length === 0) {
    return {
      error: `A combinação serviço=${servicoId}, profissional=${profissionalId ?? "(ausente)"} e data=${dataNumero || "(ausente)"} não foi retornada por buscar_horarios nesta interação.`,
      validSlotOptions: sessionState.oneBelezaSlotOptions.slice(0, 20),
      blocked: true,
    };
  }

  const matchingSlot = validSlotOptions.find(
    (slot) => slot.horarioInicio === horarioInicio && slot.horarioFim === horarioFim,
  );

  if (!matchingSlot) {
    return {
      error: `Horário ${horarioInicio} → ${horarioFim} inválido para serviço=${servicoId}, profissional=${profissionalId ?? "(ausente)"} e data=${dataNumero}. Use APENAS uma combinação EXATA retornada por buscar_horarios nesta interação.`,
      validSlotOptions: validSlotOptions.slice(0, 20),
      blocked: true,
    };
  }

  return null;
}

async function hydrateOneBelezaSessionStateFromProvider(
  tenant: any,
  parsedArgs: any,
  sessionState: AgentSessionState,
): Promise<void> {
  const servicoId = toPositiveInteger(parsedArgs?.servicoid ?? parsedArgs?.servicoId ?? parsedArgs?.servicosId);
  const profissionalId = toPositiveInteger(parsedArgs?.profissionalId ?? parsedArgs?.ProfissionalId ?? parsedArgs?.profissionalid);
  const dataNumero = normalizeOneBelezaDate(parsedArgs?.dataNumero ?? parsedArgs?.dataAg ?? parsedArgs?.date ?? parsedArgs?.data);

  if (!servicoId) return;

  const hasService = sessionState.oneBelezaServiceOptions.some((option) => option.servicosId === servicoId);
  if (!hasService) {
    const serviceResult = await executeOneBelezaTool(
      tenant,
      { function: { name: "buscar_servicos", arguments: "{}" } },
    );
    const serviceOptions = extractOneBelezaServiceOptions(serviceResult);
    if (serviceOptions.length > 0) {
      sessionState.oneBelezaServiceOptions = dedupeByKey(
        [...sessionState.oneBelezaServiceOptions, ...serviceOptions],
        (option) => String(option.servicosId),
      );
      sessionState.allowedServiceIds = dedupeByKey(
        [...sessionState.allowedServiceIds, ...serviceOptions.map((option) => option.servicosId)],
        (id) => String(id),
      );
      console.log(`Hydrated OneBeleza service IDs: [${sessionState.oneBelezaServiceOptions.map((option) => option.servicosId).join(", ")}]`);
    }
  }

  if (profissionalId) {
    const hasProfessional = sessionState.oneBelezaProfessionalOptions.some(
      (option) => option.profissionalId === profissionalId && (option.servicosId === servicoId || option.servicosId === null),
    );

    if (!hasProfessional) {
      const professionalArgs = { servicosId: String(servicoId) };
      const professionalResult = await executeOneBelezaTool(
        tenant,
        {
          function: {
            name: "buscar_barbeiros_por_servico",
            arguments: JSON.stringify(professionalArgs),
          },
        },
      );
      const professionalOptions = extractOneBelezaProfessionalOptions(professionalResult, professionalArgs);
      if (professionalOptions.length > 0) {
        sessionState.oneBelezaProfessionalOptions = dedupeByKey(
          [...sessionState.oneBelezaProfessionalOptions, ...professionalOptions],
          (option) => `${option.servicosId ?? "any"}:${option.profissionalId}`,
        );
        console.log(`Hydrated OneBeleza professional IDs: [${sessionState.oneBelezaProfessionalOptions.map((option) => option.profissionalId).join(", ")}]`);
      }
    }
  }

  const effectiveProfessionalId = (() => {
    if (!profissionalId) return null;
    const isTrackedForService = sessionState.oneBelezaProfessionalOptions.some(
      (option) => option.profissionalId === profissionalId && (option.servicosId === servicoId || option.servicosId === null),
    );
    return isTrackedForService ? profissionalId : null;
  })();

  if (dataNumero && (!effectiveProfessionalId || sessionState.oneBelezaSlotOptions.length === 0)) {
    const consolidatedArgs = {
      date: dataNumero,
      servicoId: String(servicoId),
    };
    const consolidatedResult = await executeOneBelezaTool(
      tenant,
      {
        function: {
          name: "buscar_horarios_disponiveis",
          arguments: JSON.stringify(consolidatedArgs),
        },
      },
    );
    const consolidatedProfessionalOptions = extractOneBelezaProfessionalOptionsFromAvailability(consolidatedResult, consolidatedArgs);
    const consolidatedSlotOptions = extractOneBelezaSlotOptions(consolidatedResult, consolidatedArgs);

    if (consolidatedProfessionalOptions.length > 0) {
      sessionState.oneBelezaProfessionalOptions = dedupeByKey(
        [...sessionState.oneBelezaProfessionalOptions, ...consolidatedProfessionalOptions],
        (option) => `${option.servicosId ?? "any"}:${option.profissionalId}`,
      );
      console.log(`Hydrated OneBeleza professional IDs (from consolidated): [${sessionState.oneBelezaProfessionalOptions.map((option) => option.profissionalId).join(", ")}]`);
    }

    if (consolidatedSlotOptions.length > 0) {
      sessionState.oneBelezaSlotOptions = dedupeByKey(
        [...sessionState.oneBelezaSlotOptions, ...consolidatedSlotOptions],
        (slot) => `${slot.date}:${slot.servicoId}:${slot.profissionalId}:${slot.horarioInicio}:${slot.horarioFim}`,
      );
      console.log(`Hydrated OneBeleza slot options (from consolidated): ${sessionState.oneBelezaSlotOptions.length}`);
    }
  }

  if (effectiveProfessionalId && dataNumero) {
    const hasSlot = sessionState.oneBelezaSlotOptions.some(
      (slot) => slot.servicoId === servicoId && slot.profissionalId === effectiveProfessionalId && slot.date === dataNumero,
    );

    if (!hasSlot) {
      const slotArgs = {
        date: dataNumero,
        servicoId: String(servicoId),
        ProfissionalId: String(effectiveProfessionalId),
      };
      const slotResult = await executeOneBelezaTool(
        tenant,
        {
          function: {
            name: "buscar_horarios",
            arguments: JSON.stringify(slotArgs),
          },
        },
      );
      const slotOptions = extractOneBelezaSlotOptions(slotResult, slotArgs);
      if (slotOptions.length > 0) {
        sessionState.oneBelezaSlotOptions = dedupeByKey(
          [...sessionState.oneBelezaSlotOptions, ...slotOptions],
          (slot) => `${slot.date}:${slot.servicoId}:${slot.profissionalId}:${slot.horarioInicio}:${slot.horarioFim}`,
        );
        console.log(`Hydrated OneBeleza slot options: ${sessionState.oneBelezaSlotOptions.length}`);
      }
    }
  }
}

async function callAIAgent(
  supabase: any,
  tenant: any,
  phoneNumber: string,
  history: { role: string; content: string; created_at?: string }[],
  userMessage: string,
  provider: string,
  mediaBase64?: string | null,
  mediaMimeType?: string | null,
  senderName?: string,
  simulatorMode?: boolean,
): Promise<AgentResult> {
  const startTime = Date.now();
  const logToolCalls: AgentResult["toolCalls"] = [];
  const logErrors: string[] = [];
  let sessionBlocked = false;
  // Tracks if a cancel/edit (reschedule flow) succeeded earlier in THIS invocation.
  // When true, slot-based duplicate protection can be reset so the customer can be
  // rebooked safely after cancelling or editing.
  let cancelOrEditHappenedThisInvocation = false;
  const hasAudio = mediaBase64 && mediaMimeType?.startsWith("audio/");
  const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  // Always use OpenAI direct. Audio is transcribed via Whisper (transcribeAudioViaGemini) before reaching the chat model.
  const modelUsed = "gpt-5-mini";
  const aiEndpoint = "https://api.openai.com/v1/chat/completions";
  const aiAuthKey = OPENAI_API_KEY;
  console.log(`AI provider: OpenAI direct, model: ${modelUsed}`);

  // Retry transient upstream errors (502/503/504) up to 3 attempts with exponential backoff.
  const fetchAIWithRetry = async (body: string, label: string): Promise<Response> => {
    const transientStatuses = new Set([500, 502, 503, 504, 408, 429]);
    const maxAttempts = 3;
    let lastResp: Response | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const resp = await fetch(aiEndpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${aiAuthKey}`,
            "Content-Type": "application/json",
          },
          body,
        });
        if (resp.ok || !transientStatuses.has(resp.status)) return resp;
        lastResp = resp;
        // Drain body to free socket
        try { await resp.text(); } catch {}
        const delayMs = 600 * attempt;
        console.warn(`AI gateway transient ${resp.status} on ${label}, attempt ${attempt}/${maxAttempts}, retrying in ${delayMs}ms`);
        await new Promise((r) => setTimeout(r, delayMs));
      } catch (err) {
        console.warn(`AI gateway fetch threw on ${label} attempt ${attempt}:`, err);
        if (attempt === maxAttempts) throw err;
        await new Promise((r) => setTimeout(r, 600 * attempt));
      }
    }
    // Re-issue one last time to return a Response object (already drained above)
    return lastResp ?? await fetch(aiEndpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${aiAuthKey}`, "Content-Type": "application/json" },
      body,
    });
  };

  const persistClientSummary = async (resumo: string) => {
    const cleaned = String(resumo || "").trim().slice(0, 1200);
    if (!cleaned || !phoneNumber) return false;

    const { data: existing } = await supabase
      .from("crm_leads")
      .select("id")
      .eq("tenant_id", tenant.id)
      .eq("phone_number", phoneNumber)
      .limit(1);

    if (existing && existing.length > 0) {
      await supabase
        .from("crm_leads")
        .update({ ai_summary: cleaned, ai_summary_updated_at: new Date().toISOString() })
        .eq("id", existing[0].id);
    } else {
      await supabase
        .from("crm_leads")
        .insert({
          tenant_id: tenant.id,
          phone_number: phoneNumber,
          label_id: "novo",
          ai_summary: cleaned,
          ai_summary_updated_at: new Date().toISOString(),
        } as any);
    }

    return true;
  };

  const maybeAutoPersistClientSummary = async (assistantReply: string | null | undefined) => {
    if (simulatorMode) return;

    const currentSummary = (aiSummary || "").trim();
    const hasToolActivity = logToolCalls.length > 0;
    const userMsgsCount = (history || []).filter((m: any) => m?.role === "user").length
      + (userMessage ? 1 : 0);
    const trivialOnly = /^\s*(oi+|ol[aá]+|bom\s*dia|boa\s*tarde|boa\s*noite|ok+|obrigad[oa]+|valeu+|tchau+|s+i+m+|n+a+o+|👍|❤️)\s*[!.?]*\s*$/i;
    const isTrivial = trivialOnly.test(userMessage || "") && !assistantReply;

    // Roda sempre que: já existe resumo, houve tool call, OU tem ≥2 msgs do user.
    // Só pula quando é absolutamente nada (1ª saudação isolada).
    if (!currentSummary && !hasToolActivity && userMsgsCount < 2 && isTrivial) {
      console.log(`[SummaryAuto] skipped for ${phoneNumber}: trivial first contact`);
      return;
    }

    try {
      const summaryBody: any = {
        model: modelUsed,
        messages: [
          {
            role: "system",
            content:
              "Você é um extrator de memória persistente de CRM para um salão/barbearia. " +
              "Responda APENAS JSON válido (sem markdown) no formato " +
              "{\"should_update\": boolean, \"summary\": string, \"reason\": string}.\n\n" +
              "REGRA PRINCIPAL: seja GENEROSO ao atualizar. should_update=true sempre que houver QUALQUER fato útil sobre o cliente, mesmo que pequeno:\n" +
              "- Nome do cliente (quando descoberto)\n" +
              "- Serviço(s) que mencionou, perguntou ou agendou (mesmo uma vez)\n" +
              "- Profissional citado/preferido\n" +
              "- Janela de horário típica (manhã/tarde/sábado/etc.)\n" +
              "- Plano, clube, assinatura, pacote\n" +
              "- Restrição, alergia, observação útil\n" +
              "- Status da última interação (ex: 'agendou corte com X em DATA', 'pediu preço de barba', 'primeiro contato — interesse em sobrancelha', 'desmarcou e quer remarcar')\n\n" +
              "Só responda should_update=false quando a mensagem for puramente social (oi/tchau/ok/obrigado) E não existir currentSummary.\n\n" +
              "REGRA DE MERGE: receba currentSummary e devolva uma versão ATUALIZADA que PRESERVE o que já era verdade e adicione/refine o novo. Não apague info anterior. Consolide; máximo 600 caracteres, PT-BR, factual, sem floreio, sem citar 'cliente disse'.",
          },
          {
            role: "user",
            content: JSON.stringify({
              tenantName: tenant.name || "",
              currentSummary,
              lastUserMessage: userMessage || "",
              assistantReply: assistantReply || "",
              recentHistory: history.slice(-8),
              toolCalls: logToolCalls.slice(-6).map((tool) => ({ name: tool.name, args: tool.args, result: tool.result })),
            }),
          },
        ],
        max_completion_tokens: 280,
      };

      if (modelUsed.includes("gpt-5")) {
        summaryBody.reasoning_effort = "low";
      }

      const summaryResponse = await fetchAIWithRetry(JSON.stringify(summaryBody), "summary extractor");
      if (!summaryResponse.ok) {
        const errText = await summaryResponse.text();
        console.warn(`[SummaryAuto] extractor failed ${summaryResponse.status}: ${errText.slice(0, 200)}`);
        return;
      }

      const summaryJson = await summaryResponse.json();
      const rawContent = String(summaryJson?.choices?.[0]?.message?.content || "").trim();
      const jsonBlock = rawContent.match(/\{[\s\S]*\}/)?.[0] || "";
      if (!jsonBlock) {
        console.warn(`[SummaryAuto] invalid extractor payload for ${phoneNumber}: ${rawContent.slice(0, 160)}`);
        return;
      }

      const parsed = JSON.parse(jsonBlock);
      const nextSummary = String(parsed?.summary || "").trim().slice(0, 1200);
      const shouldUpdate = Boolean(parsed?.should_update) && !!nextSummary;

      if (!shouldUpdate) {
        console.log(`[SummaryAuto] no update for ${phoneNumber}: ${String(parsed?.reason || "n/a")}`);
        return;
      }

      if (nextSummary === currentSummary) {
        console.log(`[SummaryAuto] unchanged for ${phoneNumber}`);
        return;
      }

      await persistClientSummary(nextSummary);
      console.log(`[SummaryAuto] updated for ${phoneNumber}: ${nextSummary.slice(0, 120)}`);
    } catch (e: any) {
      console.warn(`[SummaryAuto] failed for ${phoneNumber}:`, e?.message || e);
    }
  };

  const requestFinalNaturalResponse = async (conversationMessages: any[]): Promise<string | null> => {
    // Re-issue the request WITHOUT tools so the model is forced to produce a natural text reply
    // grounded in the original system prompt + conversation history (knowledge base, prices, tone, etc.)
    // We inject a strong reminder to respond in Portuguese, in character, never leaking reasoning.
    const reminder = {
      role: "system" as const,
      content:
        "LEMBRETE CRÍTICO: Responda agora ao cliente em PORTUGUÊS BRASILEIRO, com mensagem natural curta de WhatsApp, mantendo a persona do estabelecimento. NUNCA responda em inglês. NUNCA escreva texto de raciocínio interno (ex: 'Vou proceed', 'Need next user input', 'Let me', 'I will'). Apenas a mensagem final ao cliente, em português.",
    };
    const finalBodyPayload: any = {
      model: modelUsed,
      messages: [...conversationMessages, reminder],
      max_completion_tokens: 800,
    };
    // Minimize reasoning latency on gpt-5* models — natural reply doesn't need deep reasoning
    if (modelUsed.includes("gpt-5")) {
      finalBodyPayload.reasoning_effort = "low";
    }
    const finalBodyStr = JSON.stringify(finalBodyPayload);

    console.log(`AI request (final text fallback): ${conversationMessages.length} msgs, body size: ${finalBodyStr.length} chars`);

    const finalResponse = await fetchAIWithRetry(finalBodyStr, "final text fallback");

    if (!finalResponse.ok) {
      const errText = await finalResponse.text();
      console.error("AI gateway error (final text fallback):", finalResponse.status, errText);
      logErrors.push(`AI gateway error (final fallback): ${finalResponse.status} ${errText.slice(0, 200)}`);
      return null;
    }

    const finalJson = await finalResponse.json();
    const finalText = typeof finalJson?.choices?.[0]?.message?.content === "string"
      ? finalJson.choices[0].message.content.trim()
      : "";

    return finalText || null;
  };

  // Detect "leaked" responses: model outputs internal reasoning/scratchpad in English
  // instead of a natural Portuguese reply (e.g., "Vou proceed. Need next user input.")
  const isLeakedReasoningResponse = (text: string): boolean => {
    if (!text) return false;
    const t = text.trim();
    if (t.length === 0) return false;
    // JSON leak: model echoed a tool result / internal status payload instead of natural text.
    // Examples observed in prod: {"status":"failed","reason":"duplicate final messages detected"}
    if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
      try {
        JSON.parse(t);
        return true;
      } catch { /* not valid JSON, fall through */ }
    }
    // Even partial JSON-shaped leaks with status/reason keys must never reach the client
    if (/"status"\s*:\s*"(failed|success|error|ok|blocked)"/i.test(t)) return true;
    if (/"reason"\s*:\s*"[^"]*(duplicate|final\s+messages|detected)/i.test(t)) return true;
    const leakPatterns = [
      /\bneed\s+(next|more|another)\s+(user|input|message|reply)\b/i,
      /\bwait(ing)?\s+for\s+(user|next|more)\b/i,
      /\b(let|i'?ll|i\s+will|i\s+need\s+to|let\s+me)\s+(proceed|check|wait|continue|now)\b/i,
      /\bproceed\.\s*need\b/i,
      /\b(thinking|plan|step\s*\d|okay,\s*so|alright,\s*so)\b/i,
      /\bno\s+further\s+(action|response)\b/i,
      /\b(awaiting|pending)\s+(user|customer|client)\b/i,
      // Portuguese meta-commentary leaks (model talking ABOUT the conversation instead of TO the user)
      /\(\s*mensagem\s+duplicada/i,
      /\(\s*duplicad[ao]\s*\)/i,
      /\(\s*repetid[ao]/i,
      /\(\s*sem\s+(resposta|altera|novidad|mudan)/i,
      /\(\s*aguardando\s+(cliente|usu[aá]rio|resposta)/i,
      /\(\s*mesma\s+mensagem/i,
      /\(\s*continua\s+igual/i,
      /\(\s*j[aá]\s+enviad[ao]/i,
      /\(\s*nenhuma?\s+(altera|mudan|novidad|resposta)/i,
      /\bmensagem\s+duplicada\s+acima\b/i,
    ];
    if (leakPatterns.some((re) => re.test(t))) return true;
    // Whole response is just a parenthetical meta-note (e.g., "(Mensagem duplicada acima)")
    if (/^\s*\([^)]{3,80}\)\s*$/.test(t)) {
      const inner = t.replace(/^\s*\(|\)\s*$/g, "").toLowerCase();
      const metaWords = /\b(duplicad|repetid|aguardand|mesma|continua|sem\s+(resposta|altera|novidad|mudan)|j[aá]\s+enviad|nenhuma?)\b/;
      if (metaWords.test(inner)) return true;
    }
    // Short responses without Portuguese signals that look like English are very likely leaks
    if (t.length < 120) {
      const hasPortugueseSignal = /[áàâãéêíóôõúüç]|\b(você|voce|olá|ola|obrigad|tudo bem|posso|quero|queria|gostaria|certo|claro|sim|não|nao|bom dia|boa tarde|boa noite|valeu|legal|beleza|agendar|horário|horario|marcar|atendiment|serviço|servico|preço|preco|profissional|barbeiro|salão|salao|gráfica|grafica|cliente|amanhã|amanha|hoje|próxim|proxim|fazem|fazemos|temos|fica|pode|posso|aqui|sim|nao|tem|sao|são|é|ja|já|sem|por favor|favor|nome|completo|cadastro|cadastrar|nascimento|email|e-mail|fechou|qualquer|coisa|chama|tamo|junto|valeu|obrigado|obrigada|tranquilo|tranquila|combinado|perfeito|ótimo|otimo|show|massa|firmeza|abraço|abraco|até|ate|tchau|oi|opa|eai|e ai|aí|ai|pra|pro|me passa|me manda|me diz|me fala|me envia|me chama|me avisa|me confirma)\b/i.test(t);
      // Require at least 2 distinct English content words to avoid false positives on words shared with PT (e.g. "me")
      const englishMatches = t.match(/\b(the|and|will|need|user|input|next|please|let|check|continue|wait|proceed|thank|hello|message|reply|response|now)\b/gi) || [];
      const distinctEnglish = new Set(englishMatches.map((w) => w.toLowerCase()));
      const looksEnglish = distinctEnglish.size >= 2;
      if (!hasPortugueseSignal && looksEnglish) return true;
    }
    return false;
  };

  // Strip internal-only prefixes/markers that must NEVER reach the end client.
  // These are tags used internally to mark messages from the human attendant in chat history.
  const stripInternalPrefixes = (text: string): string => {
    if (!text) return text;
    let out = text;
    // Remove ALL occurrences of [ATENDENTE HUMANO]: (with variations) anywhere in the text
    out = out.replace(/\[\s*ATENDENTE\s+HUMANO\s*\]\s*:?\s*/gi, "");
    // Remove other internal markers if they ever leak
    out = out.replace(/\[\s*(SISTEMA|SYSTEM|INTERNAL|INTERNO|CONTEXTO)\s*\]\s*:?\s*/gi, "");
    // Collapse extra whitespace/newlines created by removals
    out = out.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    return out;
  };

  // Fetch CRM lead name + persistent AI summary
  let leadName = "";
  let aiSummary = "";
  let aiSummaryUpdatedAt: string | null = null;
  try {
    const { data: leadRows } = await supabase
      .from("crm_leads")
      .select("name, ai_summary, ai_summary_updated_at")
      .eq("tenant_id", tenant.id)
      .eq("phone_number", phoneNumber)
      .limit(1);
    leadName = leadRows?.[0]?.name || "";
    aiSummary = leadRows?.[0]?.ai_summary || "";
    aiSummaryUpdatedAt = leadRows?.[0]?.ai_summary_updated_at || null;
  } catch (e) {
    console.warn("[CallAIAgent] Failed to fetch lead name/summary:", (e as any)?.message);
  }
  const sessionState: AgentSessionState = await loadConversationState(supabase, tenant.id, phoneNumber);
  const previousAssistantMessage = [...history].reverse().find((m) => m.role === "assistant")?.content || "";
  const explicitClientName = extractExplicitClientName(userMessage, previousAssistantMessage) || sessionState.explicitClientName || null;
  sessionState.explicitClientName = explicitClientName;
  console.log(`[CallAIAgent] Names — sender: "${senderName || ""}", lead: "${leadName}", explicit: "${explicitClientName || ""}", simulator: ${!!simulatorMode}`);

  // Compute gaps (minutes) for the AI's temporal awareness.
  // - lastClientGapMinutes: from the previous CLIENT message (excluding the current one)
  // - lastAssistantGapMinutes: from the last IA-generated assistant message
  // - lastHumanGapMinutes: from the last [ATENDENTE HUMANO] message
  let lastClientGapMinutes: number | null = null;
  let lastAssistantGapMinutes: number | null = null;
  let lastHumanGapMinutes: number | null = null;
  let lastClientAtISO: string | null = null;
  let lastAssistantAtISO: string | null = null;
  let lastHumanAtISO: string | null = null;
  if (!simulatorMode) {
    try {
      // Previous user message (index 1; index 0 is the current one)
      const { data: lastUserRows } = await supabase
        .from("chat_messages")
        .select("created_at")
        .eq("tenant_id", tenant.id)
        .eq("phone_number", phoneNumber)
        .eq("role", "user")
        .order("created_at", { ascending: false })
        .limit(2);
      const prevUser = lastUserRows?.[1]?.created_at;
      if (prevUser) {
        lastClientAtISO = prevUser;
        lastClientGapMinutes = Math.max(0, Math.round((Date.now() - new Date(prevUser).getTime()) / 60000));
      }
    } catch (e) {
      console.warn("[CallAIAgent] Failed to compute last client gap:", (e as any)?.message);
    }

    // Derive assistant/human gaps from the loaded history (avoids extra queries).
    try {
      for (let i = history.length - 1; i >= 0; i--) {
        const m: any = history[i];
        if (m.role !== "assistant" || !m.created_at) continue;
        const isHuman = typeof m.content === "string" && /^\s*\[ATENDENTE HUMANO\]/i.test(m.content);
        if (isHuman && !lastHumanAtISO) {
          lastHumanAtISO = m.created_at;
          lastHumanGapMinutes = Math.max(0, Math.round((Date.now() - new Date(m.created_at).getTime()) / 60000));
        } else if (!isHuman && !lastAssistantAtISO) {
          lastAssistantAtISO = m.created_at;
          lastAssistantGapMinutes = Math.max(0, Math.round((Date.now() - new Date(m.created_at).getTime()) / 60000));
        }
        if (lastHumanAtISO && lastAssistantAtISO) break;
      }
    } catch (e) {
      console.warn("[CallAIAgent] Failed to derive assistant/human gaps:", (e as any)?.message);
    }
  }

  // Fetch admin-editable provider prompt override + GLOBAL override from DB.
  let providerPromptOverride: string | null = null;
  let globalPromptOverride: string | null = null;
  try {
    const { data: ppRows } = await supabase
      .from("provider_prompts")
      .select("provider, content")
      .in("provider", [provider, "global"]);
    for (const row of (ppRows || []) as any[]) {
      const c = row?.content;
      if (typeof c !== "string" || c.trim().length === 0) continue;
      if (row.provider === "global") globalPromptOverride = c;
      else if (row.provider === provider) providerPromptOverride = c;
    }
  } catch (e) {
    console.warn("[ProviderPrompts] override fetch failed:", (e as any)?.message);
  }

  let systemPrompt = buildSystemPrompt(tenant, phoneNumber, provider, senderName, leadName, explicitClientName, lastClientGapMinutes, aiSummary, aiSummaryUpdatedAt, !!simulatorMode, pruneRecentActions(sessionState), pruneRecentAssistantReplies(sessionState), {
    lastClientAtISO,
    lastAssistantAtISO,
    lastHumanAtISO,
    lastClientGapMinutes,
    lastAssistantGapMinutes,
    lastHumanGapMinutes,
  }, providerPromptOverride, globalPromptOverride);

  // CelCash context injection — só para provider Bemp com celcash_enabled
  if (tenant?.celcash_enabled && provider === "bemp") {
    try {
      const celcashCtx = await getCelCashContextCached(supabase, tenant, phoneNumber);
      const block = formatCelCashContextBlock(celcashCtx);
      if (block) {
        systemPrompt += `\n${block}`;
        console.log(`[CelCash] Context injected for ${phoneNumber}: found=${celcashCtx?.found}, subs=${celcashCtx?.subscriptions?.length || 0}`);
      }
    } catch (e) {
      console.warn("[CelCash] Context injection failed:", (e as any)?.message);
    }
  }

  // Brasília-formatted timestamp prefix for each history message (internal marker for the model).
  const tsPrefix = (iso?: string): string => {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      const parts = new Intl.DateTimeFormat("pt-BR", {
        timeZone: "America/Sao_Paulo",
        day: "2-digit", month: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false,
      }).formatToParts(d);
      const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
      return `[${get("day")}/${get("month")} ${get("hour")}:${get("minute")}] `;
    } catch { return ""; }
  };

  const messages: any[] = [
    { role: "system", content: systemPrompt },
    ...history.map((m: any) => ({
      role: m.role,
      content: typeof m.content === "string" ? `${tsPrefix(m.created_at)}${m.content}` : m.content,
    })),
  ];

  if (provider === "zaylo") {
    const normalizedUserMessage = normalizeUserFacingText(userMessage || "");
    const zayloIntentDetected = /(agend|agenda|marcar|marcação|marcacao|hor[áa]rio|horario|dispon[ií]vel|disponibilidade|pre[çc]o|valor|quanto custa|servi[çc]o|procedimento|profissional|especialista|esteticista|limpeza|botox|drenagem|depila)/i.test(normalizedUserMessage);
    const alreadyLoadedZayloCatalog = (sessionState.zayloBarberOptions?.length || 0) > 0 || (sessionState.zayloServiceOptions?.length || 0) > 0;
    const lastAssistantWasForcedZayloCatalogPrompt = /\[ZAYLO_TOOL_ENFORCER\]/.test(previousAssistantMessage || "");

    if (zayloIntentDetected && !alreadyLoadedZayloCatalog && !lastAssistantWasForcedZayloCatalogPrompt) {
      messages.push({
        role: "assistant",
        content: "[ZAYLO_TOOL_ENFORCER] Intenção de agenda/preço/serviço detectada. Antes de responder ao cliente, chame obrigatoriamente a ferramenta obter_info agora. Não faça perguntas antes disso.",
      });
    }
  }

  // Build the user message — multimodal if media is present
  const lastMsg = messages[messages.length - 1];
  const alreadyHasUserMsg = lastMsg?.role === "user" && lastMsg?.content === userMessage;

  const normalizeMediaPromptText = (text: string) =>
    text
      .replace(/\[Áudio recebido\]/gi, "")
      .replace(/\[Imagem recebida\]/gi, "")
      .replace(/\[Vídeo recebido\]/gi, "")
      .replace(/\[Video recebido\]/gi, "")
      .replace(/\s+/g, " ")
      .trim();

  const buildMediaInstruction = () => {
    const cleanedText = normalizeMediaPromptText(userMessage || "");

    if (mediaMimeType?.startsWith("audio/")) {
      return cleanedText
         ? `O cliente enviou um áudio com esta mensagem complementar: "${cleanedText}". Entenda o conteúdo do áudio e responda diretamente. NÃO transcreva, repita ou cite entre aspas o que o cliente disse. NÃO peça para repetir em texto.`
        : "O cliente enviou um áudio. Entenda o conteúdo e responda diretamente. NÃO transcreva, repita ou cite entre aspas o que o cliente disse. NÃO peça para o cliente repetir em texto.";
    }

    if (mediaMimeType?.startsWith("image/")) {
      return cleanedText
        ? `O cliente enviou uma imagem com esta mensagem complementar: "${cleanedText}". Analise a imagem e responda considerando também esse texto.`
        : "O cliente enviou uma imagem. Analise o que aparece nela e responda de forma útil e objetiva.";
    }

    return cleanedText || userMessage || "O cliente enviou uma mídia.";
  };

  if (mediaBase64 && mediaMimeType) {
    const contentParts: any[] = [];
    const mediaInstruction = buildMediaInstruction();

    if (mediaMimeType.startsWith("audio/")) {
      // Audio is transcribed via Whisper upstream and merged into the text message.
      // OpenAI chat models reject audio data URLs ("Invalid MIME type"), so we skip it here.
      contentParts.push({
        type: "text",
        text: mediaInstruction,
      });
    } else if (mediaMimeType.startsWith("image/")) {
      contentParts.push({
        type: "text",
        text: mediaInstruction,
      });
      contentParts.push({
        type: "image_url",
        image_url: { url: `data:${mediaMimeType};base64,${mediaBase64}` },
      });
    } else {
      contentParts.push({
        type: "text",
        text: mediaInstruction,
      });
    }

    console.log("Sending multimodal message to AI:", {
      mediaMimeType,
      partTypes: contentParts.map((part) => part.type),
      instruction: mediaInstruction.slice(0, 160),
    });

    if (alreadyHasUserMsg) {
      messages[messages.length - 1] = { role: "user", content: contentParts };
    } else {
      messages.push({ role: "user", content: contentParts });
    }
  } else if (!alreadyHasUserMsg) {
    messages.push({ role: "user", content: userMessage });
  }

  // ===== PROVIDER DISPATCHER: build tools based on provider =====
  const tools = buildToolsForProvider(provider, tenant);

  const requestBody: any = {
    model: modelUsed,
    messages,
    max_completion_tokens: 4096,
  };



  if (modelUsed.includes("gpt-5")) {
    requestBody.reasoning_effort = "low";
  }
  if (tools && tools.length > 0) {
    requestBody.tools = tools;
    requestBody.tool_choice = "auto";
  }

  // Provider "none" uses custom tools (labels, send_combo, send_text, etc.) which the AI may
  // chain multiple times (e.g. update funnel label → send images → update label again → reply).
  // We need enough rounds for the AI to: call N tools AND still have room to produce the final
  // natural-language reply that continues the conversation. 6 rounds is a safe ceiling.
  // For trinks/onebeleza we keep up to 8 rounds for the multi-step scheduling flow.
  const maxRounds = provider === "none" ? 6 : 8;

  const initialBodyStr = JSON.stringify(requestBody);
  console.log(`AI request (initial): ${messages.length} msgs, body size: ${initialBodyStr.length} chars`);
  let response = await fetchAIWithRetry(initialBodyStr, "initial");
  if (!response.ok) {
    const errText = await response.text();
    console.error("AI gateway error (initial):", response.status, errText);
    logErrors.push(`AI gateway error (initial): ${response.status} ${errText.slice(0, 200)}`);
    // 🚨 Política global: NUNCA expor erro técnico ao cliente. Escala humano de imediato.
    console.warn(`[AIGatewayFallback] Falha no gateway para ${phoneNumber}, escalando humano sem expor erro.`);
    logErrors.push(`AI gateway: falha → escalar humano (sem expor erro ao cliente)`);
    const fallbackMsg = "Só um instante, vou avisar o responsável pra te atender por aqui 🙏";
    sessionBlocked = true;
    (sessionState as any).aiFailureCount = 0;
    if (!simulatorMode) await saveConversationState(supabase, tenant.id, phoneNumber, sessionState);
    return { response: fallbackMsg, toolCalls: logToolCalls, errors: logErrors, model: modelUsed, durationMs: Date.now() - startTime, sessionBlocked };
  }
  // Sucesso → zera contador de falhas
  if ((sessionState as any).aiFailureCount) {
    (sessionState as any).aiFailureCount = 0;
  }
  let result: any = await response.json();
  let assistantMessage: any = result.choices?.[0]?.message;
  let rounds = 0;
  const executedToolsThisSession: Set<string> = new Set<string>(sessionState.executedToolNames || []);

  while (assistantMessage?.tool_calls && rounds < maxRounds) {

    rounds++;
    messages.push(assistantMessage);

    for (const toolCall of assistantMessage.tool_calls) {
      let parsedArgs = parseToolArguments(toolCall.function.arguments);
      const originalParsedArgs = JSON.parse(JSON.stringify(parsedArgs || {}));
      let toolCallToExecute = toolCall;
      let correctionReason: string | null = null;

      if (toolCall.function.name === "cadastrar_cliente") {
        const explicit = sessionState.explicitClientName;
        const forcedName = isUsableClientName(explicit) ? sanitizeClientName(explicit) : "";
        const argNome = typeof parsedArgs?.nome === "string" ? parsedArgs.nome : "";
        const argNomeOk = isUsableClientName(argNome);

        // Trava extra (One Beleza): a IA SÓ pode cadastrar quando a última mensagem
        // do cliente claramente é uma resposta com nome (ou seja, depois que perguntamos).
        // Isso impede o cenário "cliente manda 'Bom dia, está precisando de produtos?'
        // e a IA já cadastra com essa frase no mesmo turno".
        const userMsgLooksLikeName = looksLikeRealName(userMessage);
        const hasNamePrefix = /(?:meu nome|me chamo|sou o\b|sou a\b|pode me chamar)/i.test(String(userMessage || ""));
        const userJustSentName = userMsgLooksLikeName || hasNamePrefix;
        const blockedByFlow = provider === "onebeleza"
          && !sessionState.awaitingNameForRegistration
          && !userJustSentName
          && !forcedName;

        if (blockedByFlow) {
          console.log(`[CadastrarCliente] BLOCKED by flow — provider=${provider} awaitingFlag=${sessionState.awaitingNameForRegistration} userMsg="${String(userMessage || "").slice(0, 80)}" arg="${argNome}"`);
          sessionState.nameRejectionCount = (sessionState.nameRejectionCount || 0) + 1;
          try {
            await supabase.from("audit_logs").insert({
              tenant_id: tenant.id,
              actor_role: "service",
              entity: "onebeleza_cadastrar_cliente",
              entity_id: phoneNumber,
              action: "onebeleza_register_blocked_flow",
              before: { user_message: String(userMessage || "").slice(0, 200), arg_nome: argNome, awaiting_flag: !!sessionState.awaitingNameForRegistration },
            });
          } catch { /* ignore */ }
          const blockedResult = {
            error: "FLUXO_INVALIDO",
            message: "NÃO chame cadastrar_cliente agora. Primeiro execute buscar_cliente. Se não existir, responda APENAS: 'Pra finalizar, me diz só seu nome e sobrenome?' e AGUARDE a próxima mensagem do cliente. NÃO use a mensagem atual do cliente como nome (ela é uma saudação, pergunta ou pedido — não um nome).",
            blocked: true,
          };
          messages.push({ role: "tool", tool_call_id: toolCall.id, name: toolCall.function.name, content: JSON.stringify(blockedResult) });
          executedToolsThisSession.add(toolCall.function.name);
          continue;
        }

        if (forcedName) {
          if (parsedArgs?.nome !== forcedName) {
            parsedArgs = { ...parsedArgs, nome: forcedName };
            correctionReason = `nome corrigido para o nome validado da conversa: ${forcedName}`;
            toolCallToExecute = {
              ...toolCall,
              function: {
                ...toolCall.function,
                arguments: JSON.stringify(parsedArgs),
              },
            };
          }
        } else if (argNomeOk && userJustSentName) {
          // Só aceita o nome que a IA passou se o cliente acabou de mandar algo que parece nome.
          const cleaned = sanitizeClientName(argNome);
          parsedArgs = { ...parsedArgs, nome: cleaned };
          sessionState.explicitClientName = cleaned;
          toolCallToExecute = {
            ...toolCall,
            function: { ...toolCall.function, arguments: JSON.stringify(parsedArgs) },
          };
        } else {
          console.log(`[CadastrarCliente] BLOCKED — sem nome válido. explicit="${explicit || ""}" arg="${argNome}" userMsg="${String(userMessage || "").slice(0, 80)}" argNomeOk=${argNomeOk} userJustSentName=${userJustSentName}`);
          sessionState.nameRejectionCount = (sessionState.nameRejectionCount || 0) + 1;
          try {
            await supabase.from("audit_logs").insert({
              tenant_id: tenant.id,
              actor_role: "service",
              entity: "onebeleza_cadastrar_cliente",
              entity_id: phoneNumber,
              action: "onebeleza_register_blocked_name",
              before: { user_message: String(userMessage || "").slice(0, 200), arg_nome: argNome, reason: "looks_not_like_name" },
            });
          } catch { /* ignore */ }
          const blockedResult = {
            error: "NOME_NAO_COLETADO",
            message: "Você ainda não tem um nome válido do cliente. NÃO chame cadastrar_cliente. Responda ao cliente APENAS: 'Pra finalizar, me diz só seu nome e sobrenome?' e AGUARDE a próxima mensagem. Critérios de nome válido: 2 a 4 palavras, só letras, sem verbos, sem palavras como 'corte', 'barba', 'horário', 'quero', 'tem', dias da semana, saudações ('bom dia'). Se a resposta do cliente for uma frase longa, saudação, pergunta ou parecer transcrição de áudio, NÃO use como nome — peça de novo de forma simpática.",
            blocked: true,
            attemptsSoFar: sessionState.nameRejectionCount,
          };
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: JSON.stringify(blockedResult),
          });
          executedToolsThisSession.add(toolCall.function.name);
          continue;
        }
      }



      console.log(`Tool call: ${toolCall.function.name}`, toolCall.function.arguments);

      let toolResult: any;
      let wasBlocked = false;

      // ===== GLOBAL ACTION LEDGER GUARD (cross-provider, cross-tool) =====
      // Blocks the AI from re-executing the SAME mutating action when the same
      // intent (toolName + normalized args) was already completed successfully
      // in the last 30 minutes of this conversation. Prevents the
      // "client confirms, then sends name → AI books again" class of bugs.
      {
        const mutInfo = isMutatingToolName(toolCall.function.name, tenant);
        if (mutInfo.mutating) {
          const dedupeKey = buildDedupeKey(toolCall.function.name, parsedArgs);
          const prior = findRecentAction(sessionState, dedupeKey, "success");
          if (prior) {
            const ageMin = Math.round((Date.now() - Date.parse(prior.completedAt)) / 60000);
            console.log(`[ActionLedger] ${toolCall.function.name} BLOCKED: same action completed ${ageMin}min ago (key=${dedupeKey.slice(0, 120)})`);
            try {
              await supabase.from("audit_logs").insert({
                tenant_id: tenant.id,
                actor_role: "service",
                entity: "ai_action_ledger",
                entity_id: phoneNumber,
                action: "duplicate_action_blocked",
                before: {
                  tool: toolCall.function.name,
                  category: mutInfo.category,
                  dedupe_key: dedupeKey.slice(0, 200),
                  prior_at: prior.completedAt,
                  prior_summary: prior.summary,
                  user_message: String(userMessage || "").slice(0, 200),
                },
              });
            } catch { /* ignore */ }
            toolResult = {
              error: "ACAO_JA_CONCLUIDA",
              blocked: true,
              message: `Você JÁ executou esta ação nesta conversa há ${ageMin} minuto(s): ${prior.summary}. NÃO chame a ferramenta de novo. Apenas responda ao cliente naturalmente (ex: confirme o que já foi feito, agradeça, ou peça a próxima informação). Só repita a ação se o cliente PEDIR EXPLICITAMENTE algo DIFERENTE (outro horário, outro serviço, outra pessoa).`,
              priorAction: { at: prior.completedAt, summary: prior.summary, resultId: prior.resultId ?? null },
            };
            wasBlocked = true;
            sessionBlocked = true;
            messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(toolResult) });
            logToolCalls.push({ name: toolCall.function.name, args: parsedArgs, result: toolResult, blocked: true, deduplicated: true });
            continue;
          }
        }
      }


      // Block duplicate tool calls (same tool name) within this session
      // EXCEPT lookup tools that may need to run multiple times across the scheduling flow
      // and EXCEPT custom tools of type "add_label" — the AI may need to update the lead's
      // funnel label across multiple messages as the conversation progresses.
      const toolKey = toolCall.function.name;
      // Lookup/read-only tools may be called multiple times across the conversation.
      // Any tool starting with `buscar_` or `listar_` is treated as read-only and
      // never deduplicated. Only mutating tools (criar/cancelar/editar agendamento,
      // cadastrar_cliente, send_image/audio/video, escalate_human, etc.) are blocked
      // from running twice in the same session.
      // cadastrar_cliente is allowed to repeat — backend returns "already registered"
      // when duplicate, so it's safe to call as many times as needed in the conversation.
        const isReadOnlyTool = /^(buscar_|listar_|consultar_|verificar_|get_|list_|obter_)/i.test(toolKey) || toolKey === "cadastrar_cliente" || toolKey === "atualizar_resumo_cliente";
      // Scheduling and cancel/edit tools may legitimately repeat (different services or
      // multiple appointments). They have their own per-service / per-id dedup logic below.
      const isSchedulingOrCancelTool = [
        "criar_agendamento", "agendar", "editar_agendamento",
        "cancelar_agendamento", "desmarcar_agendamento", "confirmar_agendamento",
      ].includes(toolKey);
      // Check if this is a custom tool of type "add_label" (always allow repeats)
      const matchedCustomTool = getEnabledCustomTools(tenant).find((ct: any) => ct.name === toolKey);
      const isAddLabelTool = matchedCustomTool?.type === "add_label";

      if (executedToolsThisSession.has(toolKey) && !isReadOnlyTool && !isAddLabelTool && !isSchedulingOrCancelTool) {
        // Special case: for escalate_human, even when deduplicated, make sure the
        // configured label is actually present on the WhatsApp chat. The owner may
        // have removed the label between turns, leaving the lead without the
        // pause flag — so we re-apply it silently before blocking the call.
        if (matchedCustomTool?.type === "escalate_human") {
          try {
            const labelId = matchedCustomTool?.config?.label_id;
            if (labelId) {
              const reapply = await ensureChatLabelState(
                tenant.uazapi_url || Deno.env.get("UAZAPI_URL") || "",
                tenant.uazapi_token || Deno.env.get("UAZAPI_TOKEN") || "",
                phoneNumber,
                String(labelId),
                "present",
                "EscalateHuman:dedup-reapply",
              );
              console.log(`[DedupGuard] escalate_human dedup → label reapply result: ${JSON.stringify({ ok: reapply.success, already: reapply.already })}`);
            }
          } catch (e) {
            console.error("[DedupGuard] escalate_human label reapply error:", e);
          }
        }
        console.log(`[DedupGuard] ${toolKey} BLOCKED: already executed in this conversation`);
        toolResult = {
          message: `A ferramenta "${toolKey}" já foi executada nesta conversa. Não execute novamente. Prossiga com a resposta ao cliente sem chamar a ferramenta outra vez.`,
          blocked: true,
          deduplicated: true,
        };
        wasBlocked = true;
        sessionBlocked = true;
        messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(toolResult) });
        logToolCalls.push({ name: toolCall.function.name, args: parsedArgs, result: toolResult, blocked: true, deduplicated: true });
        continue;
      }

      // Block duplicate scheduling ONLY when the EXACT same slot (services + date + time + professional)
      // has already been booked successfully. Re-booking the same service on a different date/time
      // (remarcação) is allowed without requiring an explicit cancel beforehand.
      const isSchedulingTool = ["criar_agendamento", "agendar"].includes(toolCall.function.name);
      let attemptedServiceIds: number[] = [];
      let attemptedSlotSignature = "";
      if (isSchedulingTool) {
        const candidateIds = [
          parsedArgs?.serviceId,
          parsedArgs?.servicoId,
          parsedArgs?.servicoid,
          parsedArgs?.servicosId,
        ];
        if (Array.isArray(parsedArgs?.servicos)) {
          for (const s of parsedArgs.servicos) {
            candidateIds.push(s?.codigo, s?.servicoId, s?.servicosId);
          }
        }
        attemptedServiceIds = candidateIds
          .map((v) => toPositiveInteger(v))
          .filter((v): v is number => typeof v === "number");

        // Build a slot signature that works across providers
        const dt: string =
          (typeof parsedArgs?.dataHoraInicio === "string" && parsedArgs.dataHoraInicio) ||
          (typeof parsedArgs?.start === "string" && parsedArgs.start) ||
          "";
        const date =
          (typeof parsedArgs?.dia === "string" && parsedArgs.dia) ||
          (typeof parsedArgs?.data === "string" && parsedArgs.data) ||
          (typeof parsedArgs?.date === "string" && parsedArgs.date) ||
          (dt ? dt.slice(0, 10) : "");
        const time =
          (typeof parsedArgs?.hora === "string" && parsedArgs.hora) ||
          (typeof parsedArgs?.horario === "string" && parsedArgs.horario) ||
          (typeof parsedArgs?.time === "string" && parsedArgs.time) ||
          (dt && dt.length >= 16 ? dt.slice(11, 16) : "");
        const prof =
          toPositiveInteger(parsedArgs?.profissionalId) ??
          toPositiveInteger(parsedArgs?.professionalId) ??
          "";
        const servicesKey = [...attemptedServiceIds].sort((a, b) => a - b).join(",");
        attemptedSlotSignature = `${servicesKey}|${date}|${time}|${prof}`;
      }

      if (!toolResult && provider === "frizzar" && toolCall.function.name === "agendar") {
        const serviceIdCounts = new Map<number, number>();
        for (const sid of attemptedServiceIds) {
          serviceIdCounts.set(sid, (serviceIdCounts.get(sid) || 0) + 1);
        }

        const duplicatedWithinPayload = [...serviceIdCounts.entries()]
          .filter(([, count]) => count > 1)
          .map(([sid]) => sid);

        if (duplicatedWithinPayload.length > 0) {
          toolResult = {
            error: `Na Frizzar, o mesmo serviço não pode aparecer duas vezes no mesmo agendamento automático. IDs repetidos: ${duplicatedWithinPayload.join(", ")}.`,
            blocked: true,
            message: "Se o cliente quiser dois atendimentos do mesmo tipo (ex.: dois cortes), não tente agendar automaticamente. Acione um atendente humano.",
            duplicateServiceIds: duplicatedWithinPayload,
          };
          wasBlocked = true;
          sessionBlocked = true;
        }

          const lastFrizzarListedForProfessional = frizzarLastListed.get(`${tenant.id}:${phoneNumber || ""}:${parsedArgs?.profissionalId}`);
          const hasRecentFrizzarList = !!lastFrizzarListedForProfessional && Date.now() - lastFrizzarListedForProfessional.listedAt < 30 * 60 * 1000;
          if (
            !toolResult &&
            (!hasRecentFrizzarList || lastFrizzarListedForProfessional?.dia !== parsedArgs?.dia)
          ) {
            toolResult = {
              error: hasRecentFrizzarList
                ? `Data divergente: você listou horários para ${lastFrizzarListedForProfessional?.dia}, mas tentou agendar em ${parsedArgs?.dia}.`
                : "Antes de agendar na Frizzar, execute listar_horarios nesta conversa para este profissional/data/serviços e use exatamente um horário retornado.",
              blocked: true,
              message: "Não chame agendar ainda. Liste horários reais primeiro; se o horário pedido não aparecer em horariosLivres, ofereça alternativas em vez de escalar humano.",
            };
            wasBlocked = true;
            sessionBlocked = true;
          }

        const lastAssistantMessage = getLastAssistantMessage(history);
        const lastOfferedTime = extractSingleTimeReference(lastAssistantMessage || "");
        if (
          !toolResult &&
          isAffirmativeReply(userMessage || "") &&
          lastAssistantMessage &&
          isBookingTimeConfirmationPrompt(lastAssistantMessage) &&
          lastOfferedTime &&
          typeof parsedArgs?.hora === "string" &&
          parsedArgs.hora !== lastOfferedTime
        ) {
          toolResult = {
            error: `Confirmação ancorada no horário ${lastOfferedTime}, mas a IA tentou agendar ${parsedArgs.hora}.`,
            blocked: true,
            message: `O cliente respondeu a uma oferta do horário ${lastOfferedTime}. Use exatamente esse horário ou volte a confirmar antes de agendar.`,
            expectedHour: lastOfferedTime,
            attemptedHour: parsedArgs.hora,
          };
          wasBlocked = true;
          sessionBlocked = true;
        }
      }

      const exactSlotAlreadyBooked =
        isSchedulingTool &&
        attemptedSlotSignature !== "" &&
        attemptedServiceIds.length > 0 &&
        sessionState.scheduledSlotSignatures.includes(attemptedSlotSignature);

      if (isSchedulingTool && exactSlotAlreadyBooked) {
        console.log(`${toolCall.function.name} BLOCKED: exact slot already booked (${attemptedSlotSignature})`);
        toolResult = {
          message: "Esse agendamento exato (mesmos serviços, data, hora e profissional) já foi criado nesta conversa. Não chame a ferramenta novamente para o mesmo slot.",
          blocked: true,
        };
        wasBlocked = true;
        sessionBlocked = true;
      } else {
        // ===== BEMP STATE-BASED RESOLUTION LAYER =====
        if (provider === "bemp") {
          const toolName = toolCall.function.name;
          if (["listar_servicos", "listar_profissionais", "listar_horarios", "agendar"].includes(toolName) && !toPositiveInteger(parsedArgs?.salonId)) {
            if (sessionState.selectedSalonId) {
              parsedArgs.salonId = sessionState.selectedSalonId;
            } else if (sessionState.bempSalonOptions.length === 1) {
              parsedArgs.salonId = sessionState.bempSalonOptions[0].salonId;
            }
          }
          const bempToolsNeedingService = ["listar_profissionais", "listar_horarios", "agendar"];
          const bempToolsNeedingProfessional = ["listar_horarios", "agendar"];
          const corrections: string[] = [];

          if (["listar_servicos", "listar_profissionais", "listar_horarios", "agendar"].includes(toolName)) {
            const requestedSalonId = toPositiveInteger(parsedArgs?.salonId);
            if (!requestedSalonId) {
              toolResult = {
                error: "salonId é obrigatório na Bemp.",
                blocked: true,
                message: "Antes de seguir, chame listar_unidades e use um salonId real do retorno.",
                unidades_disponiveis: sessionState.bempSalonOptions.map((option) => ({ id: option.salonId, name: option.name })),
              };
              wasBlocked = true;
              sessionBlocked = true;
            } else if (sessionState.bempSalonOptions.length > 0 && !sessionState.bempSalonOptions.some((option) => option.salonId === requestedSalonId)) {
              toolResult = {
                error: `salonId ${requestedSalonId} não pertence às unidades válidas da Bemp.`,
                blocked: true,
                message: "Use um salonId real retornado por listar_unidades nesta conversa.",
                unidades_disponiveis: sessionState.bempSalonOptions.map((option) => ({ id: option.salonId, name: option.name })),
              };
              wasBlocked = true;
              sessionBlocked = true;
            } else if (requestedSalonId && sessionState.selectedSalonId !== requestedSalonId) {
              corrections.push(`salonId validado ${requestedSalonId}`);
            }
          }

          if (!toolResult && bempToolsNeedingService.includes(toolName) && !toPositiveInteger(parsedArgs?.serviceId) && sessionState.selectedServiceId) {
            parsedArgs.serviceId = sessionState.selectedServiceId;
            corrections.push(`serviceId ausente, usando seleção persistida ${sessionState.selectedServiceId}`);
          }

          if (!toolResult && bempToolsNeedingProfessional.includes(toolName) && !toPositiveInteger(parsedArgs?.professionalId)) {
            const requestedSalonId = toPositiveInteger(parsedArgs?.salonId);
            const requestedServiceId = toPositiveInteger(parsedArgs?.serviceId);

            const matchingProfessionals = sessionState.bempProfessionalOptions.filter((option) => {
              const salonMatches = !requestedSalonId || option.salonId === null || option.salonId === requestedSalonId;
              const serviceMatches = !requestedServiceId || option.serviceId === null || option.serviceId === requestedServiceId;
              return salonMatches && serviceMatches;
            });

            if (sessionState.selectedProfessionalId && matchingProfessionals.some((option) => option.professionalId === sessionState.selectedProfessionalId)) {
              parsedArgs.professionalId = sessionState.selectedProfessionalId;
              corrections.push(`professionalId ausente, usando seleção persistida ${sessionState.selectedProfessionalId}`);
            } else if (matchingProfessionals.length === 1) {
              parsedArgs.professionalId = matchingProfessionals[0].professionalId;
              corrections.push(`professionalId ausente, usando único profissional conhecido ${matchingProfessionals[0].professionalId}`);
            } else {
              toolResult = {
                error: "professionalId é obrigatório na Bemp.",
                blocked: true,
                message: "Antes de seguir, chame listar_profissionais para esse serviço e use um professionalId real do retorno.",
                profissionais_disponiveis: matchingProfessionals.map((option) => ({ id: option.professionalId, name: option.name })),
              };
              wasBlocked = true;
              sessionBlocked = true;
            }
          }

          if (!toolResult && toolName === "listar_horarios" && !parsedArgs?.data && sessionState.selectedDate) {
            parsedArgs.data = sessionState.selectedDate;
            corrections.push(`data ausente, usando seleção persistida ${sessionState.selectedDate}`);
          }

          if (!toolResult && toolName === "agendar") {
            const requestedSalonId = toPositiveInteger(parsedArgs?.salonId);
            const requestedServiceId = toPositiveInteger(parsedArgs?.serviceId);
            const requestedProfessionalId = toPositiveInteger(parsedArgs?.professionalId);
            const requestedStart = typeof parsedArgs?.start === "string" ? parsedArgs.start : "";
            const requestedEnd = typeof parsedArgs?.end === "string" ? parsedArgs.end : "";
            const requestedDate = requestedStart.slice(0, 10) || sessionState.selectedDate;

            const matchingSlots = sessionState.bempSlotOptions.filter((slot) => {
              const salonMatches = !requestedSalonId || slot.salonId === null || slot.salonId === requestedSalonId;
              const serviceMatches = !requestedServiceId || slot.serviceId === null || slot.serviceId === requestedServiceId;
              const professionalMatches = !requestedProfessionalId || slot.professionalId === null || slot.professionalId === requestedProfessionalId;
              const dateMatches = !requestedDate || slot.date === null || slot.date === requestedDate;
              return salonMatches && serviceMatches && professionalMatches && dateMatches;
            });

            if (matchingSlots.length === 0) {
              toolResult = {
                error: "Nenhum horário válido em memória para este profissional.",
                blocked: true,
                message: "Antes de agendar, rode listar_horarios COM professionalId e use exatamente um slot retornado nessa resposta.",
              };
              wasBlocked = true;
              sessionBlocked = true;
            } else if (!matchingSlots.some((slot) => slot.start === requestedStart && slot.end === requestedEnd)) {
              toolResult = {
                error: "O horário informado não bate com os slots válidos retornados pela Bemp.",
                blocked: true,
                message: "Rode listar_horarios novamente com professionalId e use exatamente start/end de um slot retornado.",
                horarios_validos: matchingSlots.slice(0, 20).map((slot) => ({
                  start: slot.start,
                  end: slot.end,
                  start_text: slot.start_text,
                  end_text: slot.end_text,
                })),
              };
              wasBlocked = true;
              sessionBlocked = true;
            }
          }

          if (!toolResult && corrections.length > 0) {
            correctionReason = corrections.join("; ");
            toolCallToExecute = {
              ...toolCall,
              function: { ...toolCall.function, arguments: JSON.stringify(parsedArgs) },
            };
            console.log(`[BempResolver] ${toolName} corrected: ${correctionReason}`);
          }
        }

        // ===== ONE BELEZA ID RESOLUTION LAYER =====
        if (provider === "onebeleza") {
          const resolvableTools = ["buscar_barbeiros_por_servico", "buscar_datas_disponiveis", "buscar_horarios", "buscar_horarios_disponiveis", "agendar"];
          if (resolvableTools.includes(toolCall.function.name)) {
            const resolution = resolveOneBelezaToolArgs(toolCall.function.name, parsedArgs, sessionState);
            
            if (resolution.blocked) {
              console.log(`[IDResolver] ${toolCall.function.name} BLOCKED: ${resolution.blockMessage}`);
              toolResult = {
                error: resolution.blockMessage,
                blocked: true,
              };
              wasBlocked = true;
              sessionBlocked = true;
            } else if (resolution.corrected) {
              parsedArgs = resolution.resolvedArgs;
              correctionReason = resolution.correctionReason;
              toolCallToExecute = {
                ...toolCall,
                function: { ...toolCall.function, arguments: JSON.stringify(parsedArgs) },
              };
              console.log(`[IDResolver] ${toolCall.function.name} corrected: ${correctionReason}`);
          }
        }

        }

        // ===== TRINKS SERVICE-LOCK LAYER =====
        // Impede que a IA troque o serviço escolhido no meio da MESMA tentativa
        // de agendamento sem o cliente ter pedido. TTL curto (20min) e auto-
        // limpeza após criar_agendamento bem-sucedido evitam que travas antigas
        // bloqueiem novos agendamentos.
        if (provider === "trinks") {
          const tName = toolCall.function.name;
          const lockedDur = (sessionState as any).trinksSelectedServiceDuration as number | null;
          const lockedName = (sessionState as any).trinksSelectedServiceName as string | null;
          const lockedSvcId = (sessionState as any).trinksSelectedServiceId as number | null;
          const lockUpdatedAt = ((sessionState as any).trinksLockUpdatedAt as number) || 0;
          const LOCK_TTL_MS = 20 * 60 * 1000; // 20min
          const lockExpired = lockUpdatedAt > 0 && (Date.now() - lockUpdatedAt) > LOCK_TTL_MS;

          if (lockExpired && lockedDur) {
            console.log(`[TrinksLock] expirado (${Math.round((Date.now() - lockUpdatedAt) / 60000)}min), limpando trava`);
            (sessionState as any).trinksSelectedServiceDuration = null;
            (sessionState as any).trinksSelectedServiceId = null;
            (sessionState as any).trinksSelectedServiceName = null;
            (sessionState as any).trinksLockUpdatedAt = 0;
          }

          const stillLocked = !lockExpired && lockedDur;
          // Intenção explícita do cliente de trocar/adicionar serviço.
          const SWITCH_INTENT = /\b(barba|cabelo|combo|tamb[eé]m|incluir|adicionar?|junto|os\s?dois|ambos|trocar|mudar|na\s+verdade|prefiro|outro\s+servi[cç]o|s[oó]\s+(corte|barba|cabelo)|corte)\b/i;
          const lastUser = String(userMessage || "");
          const userWantsChange = SWITCH_INTENT.test(lastUser);

          if (!toolResult && stillLocked && tName === "listar_horarios") {
            const reqDur = toPositiveInteger(parsedArgs?.servicoDuracao);
            if (reqDur && reqDur !== lockedDur && !userWantsChange) {
              console.log(`[TrinksLock] listar_horarios BLOCKED: servicoDuracao=${reqDur} ≠ locked=${lockedDur} (svcId=${lockedSvcId}, name=${lockedName}) — sem intenção de troca`);
              toolResult = {
                error: `Serviço da conversa: ${lockedName || `(duração ${lockedDur}min)`}. NÃO troque o serviço sozinho. Refaça listar_horarios com servicoDuracao=${lockedDur}. Se quiser sugerir outro serviço, PERGUNTE ao cliente ANTES e aguarde resposta.`,
                blocked: true,
                locked_service: { id: lockedSvcId, nome: lockedName, duracao: lockedDur },
              };
              wasBlocked = true;
              sessionBlocked = true;
            }
          }

          // criar_agendamento NÃO é mais bloqueado pela trava — apenas registra
          // aviso em log. Travar a criação causava agendamentos legítimos a
          // falharem quando a duração mudava entre listar_horarios e criar.
          if (!toolResult && stillLocked && tName === "criar_agendamento") {
            const reqDur = toPositiveInteger(parsedArgs?.duracaoEmMinutos);
            if (reqDur && reqDur !== lockedDur) {
              console.log(`[TrinksLock] criar_agendamento dur mismatch (req=${reqDur}, locked=${lockedDur}) — permitindo prosseguir (lock é só sinal, não trava criação)`);
            }
          }
        }


        // Auto-correct desmarcar/confirmar agendasId
        const isAgendaIdTool = ["desmarcar_agendamento", "confirmar_agendamento"].includes(toolCall.function.name);
        if (!toolResult && isAgendaIdTool && provider === "onebeleza") {
          // 🚨 TTL TRAVA: invalida cache de agendamentos se foi capturado há mais de 5min,
          // para evitar usar dados obsoletos em fluxo de cancelamento/remarcação.
          const fetchedAt = (sessionState as any).validAgendasIdsFetchedAt || 0;
          const cacheAgeMs = Date.now() - fetchedAt;
          const CACHE_TTL_MS = 5 * 60 * 1000;
          if (sessionState.validAgendasIds.length > 0 && cacheAgeMs > CACHE_TTL_MS) {
            console.log(`[OneBeleza] ${toolCall.function.name}: validAgendasIds cache stale (${Math.round(cacheAgeMs/1000)}s old), invalidating to force re-fetch`);
            sessionState.validAgendasIds = [];
            (sessionState as any).oneBelezaAgendaOptions = [];
          }
          // If validAgendasIds is empty (new invocation or stale), auto-fetch agendamentos
          if (sessionState.validAgendasIds.length === 0) {
            console.log(`[OneBeleza] ${toolCall.function.name}: validAgendasIds empty, auto-fetching agendamentos...`);
            
            // Resolve target date: state > tool args > conversation context > today
            const brNow = getBrasiliaDate();
            const todayFallback = brNow.todayDate;
            let targetDate = sessionState.selectedDate || null;
            
            if (!targetDate && parsedArgs.date) {
              targetDate = String(parsedArgs.date);
            }
            
            // Try to extract date from recent messages (e.g., "segunda-feira", "dia 13", "2026-04-13")
            if (!targetDate) {
              const recentMsgs = messages.slice(-10).filter((m: any) => m.role === "user" || m.role === "assistant");
              const datePatterns = [
                /(\d{4}-\d{2}-\d{2})/,
                /dia\s+(\d{1,2})\/(\d{1,2})/i,
                /dia\s+(\d{1,2})/i,
              ];
              const dayNameMap: Record<string, number> = {
                "domingo": 0, "segunda": 1, "terça": 2, "quarta": 3,
                "quinta": 4, "sexta": 5, "sábado": 6,
              };
              for (const msg of recentMsgs.reverse()) {
                const text = typeof msg.content === "string" ? msg.content : "";
                // Check YYYY-MM-DD
                const isoMatch = text.match(datePatterns[0]);
                if (isoMatch) { targetDate = isoMatch[1]; break; }
                // Check "dia DD/MM"
                const dmMatch = text.match(datePatterns[1]);
                if (dmMatch) {
                  const d = parseInt(dmMatch[1]);
                  const m = parseInt(dmMatch[2]);
                  targetDate = `${brNow.year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                  break;
                }
                // Check day name (segunda, terça, etc.)
                for (const [dayName, dayIndex] of Object.entries(dayNameMap)) {
                  if (text.toLowerCase().includes(dayName)) {
                    const currentDow = new Date(Date.UTC(brNow.year, brNow.month - 1, brNow.day)).getUTCDay();
                    let diff = dayIndex - currentDow;
                    if (diff <= 0) diff += 7;
                    const futureDate = new Date(Date.UTC(brNow.year, brNow.month - 1, brNow.day + diff));
                    targetDate = `${futureDate.getUTCFullYear()}-${String(futureDate.getUTCMonth() + 1).padStart(2, '0')}-${String(futureDate.getUTCDate()).padStart(2, '0')}`;
                    break;
                  }
                }
                if (targetDate) break;
              }
            }
            
            const dateToFetch = targetDate || todayFallback;
            console.log(`[OneBeleza] Auto-fetch date resolved: ${dateToFetch} (source: ${targetDate ? (sessionState.selectedDate ? 'state' : 'context') : 'today-fallback'})`);
            
            const fetchResult = await executeToolForProvider(provider, tenant, {
              ...toolCall,
              function: { name: "buscar_agendamentos_dia", arguments: JSON.stringify({ date: dateToFetch }) },
            }, phoneNumber, { supabase, simulatorMode });
            if (Array.isArray(fetchResult)) {
              // Filter only agendamentos for this phone number
              const phoneClean = phoneNumber.replace(/^55/, "");
              const myAgendamentos = fetchResult.filter((a: any) => {
                const cel = String(a.celular || "").replace(/^55/, "");
                return cel === phoneClean || cel === phoneNumber;
              });
              sessionState.validAgendasIds = (myAgendamentos.length > 0 ? myAgendamentos : fetchResult).map((a: any) => a.agendasId).filter((id: any) => typeof id === "number");
              (sessionState as any).oneBelezaAgendaOptions = myAgendamentos.length > 0 ? myAgendamentos : fetchResult;
              (sessionState as any).validAgendasIdsFetchedAt = Date.now();
              console.log(`[OneBeleza] Auto-fetched validAgendasIds: [${sessionState.validAgendasIds}] (date: ${dateToFetch}, filtered: ${myAgendamentos.length > 0})`);
            }
          }

          const usedId = toPositiveInteger(parsedArgs.agendasId);
          if (usedId && sessionState.validAgendasIds.length > 0 && !sessionState.validAgendasIds.includes(usedId)) {
            const correctedId = reconcileOneBelezaAgendaId(usedId, sessionState, messages);
            if (correctedId) {
              console.log(`[OneBeleza] ${toolCall.function.name} auto-corrected agendasId: ${usedId} → ${correctedId}`);
              parsedArgs.agendasId = String(correctedId);
              correctionReason = `agendasId ${usedId} → ${correctedId}`;
              toolCallToExecute = {
                ...toolCall,
                function: { ...toolCall.function, arguments: JSON.stringify(parsedArgs) },
              };
            } else {
              console.log(`${toolCall.function.name} BLOCKED: agendasId ${usedId} not in valid list [${sessionState.validAgendasIds}], no match found`);
              toolResult = {
                error: `agendasId ${usedId} é inválido. Os IDs reais são: ${sessionState.validAgendasIds.join(", ")}. Use APENAS esses IDs.`,
                validIds: sessionState.validAgendasIds,
                blocked: true,
              };
              wasBlocked = true;
              sessionBlocked = true;
            }
          } else if (usedId && sessionState.validAgendasIds.length === 0) {
            console.log(`${toolCall.function.name} WARNING: no valid agenda IDs found, proceeding with AI's ID ${usedId}`);
          }
        }

        if (!toolResult && provider === "onebeleza" && toolCall.function.name === "agendar") {
          await hydrateOneBelezaSessionStateFromProvider(tenant, parsedArgs, sessionState);
          const reconciledSchedulingArgs = reconcileOneBelezaSchedulingArgs(parsedArgs, sessionState);
          parsedArgs = reconciledSchedulingArgs.args;

          if (reconciledSchedulingArgs.adjusted) {
            toolCallToExecute = {
              ...toolCall,
              function: {
                ...toolCall.function,
                arguments: JSON.stringify(parsedArgs),
              },
            };
          }

          if (reconciledSchedulingArgs.corrected) {
            const slotCorrectionReason = `slot auto-corrected`;
            correctionReason = correctionReason ? `${correctionReason}; ${slotCorrectionReason}` : slotCorrectionReason;
            console.log(
              `[OneBeleza] agendar auto-corrected slot args:`,
              JSON.stringify({
                originalArgs: originalParsedArgs,
                resolvedArgs: parsedArgs,
              }).slice(0, 1000),
            );
          }

          toolResult = buildOneBelezaSchedulingValidationResult(parsedArgs, sessionState);

          if (toolResult) {
            console.log(`[OneBeleza] agendar BLOCKED by session validation:`, JSON.stringify(toolResult).slice(0, 1000));
            wasBlocked = true;
            sessionBlocked = true;
          }
        }

        if (!toolResult) {
          // ===== PROVIDER DISPATCHER: execute tool based on provider =====
          toolResult = await executeToolForProvider(provider, tenant, toolCallToExecute, phoneNumber, { supabase, simulatorMode });
        }

        // OneBeleza: gerenciar flag awaitingNameForRegistration baseado em buscar_cliente / cadastrar_cliente
        if (provider === "onebeleza") {
          if (toolCall.function.name === "buscar_cliente") {
            // resultado vazio / notFound → entramos no fluxo de cadastro pendente
            const r: any = toolResult;
            const isEmpty = !r
              || r?.notFound === true
              || r?.status === 404
              || (typeof r === "object" && !r?.codigo && !r?.id && !r?.clienteId
                  && !(Array.isArray(r?.data) && r.data.length > 0)
                  && !(Array.isArray(r) && r.length > 0));
            if (isEmpty) {
              sessionState.awaitingNameForRegistration = true;
              console.log(`[OneBeleza] buscar_cliente vazio → awaitingNameForRegistration=true`);
            } else {
              sessionState.awaitingNameForRegistration = false;
            }
          } else if (toolCall.function.name === "cadastrar_cliente") {
            // sucesso → limpa flag
            const r: any = toolResult;
            const ok = r && !r?.error && !r?.blocked && (r?.codigo || r?.id || r?.clienteId || r?.ok === true || r?.success === true || r?.aliasUsed);
            if (ok) {
              sessionState.awaitingNameForRegistration = false;
            }
          }
        }


        // Track successful scheduling by exact slot to prevent accidental duplicate booking.
        const scheduleSucceeded = isSchedulingTool && !toolResult?.error && !toolResult?.blocked && (toolResult?.id || toolResult?.ok || toolResult?.agendamentoId || toolResult?.success);
        if (scheduleSucceeded) {
          if (toolResult?.id) sessionState.criarAgendamentoSuccessId = toolResult.id;
          if (attemptedSlotSignature && !sessionState.scheduledSlotSignatures.includes(attemptedSlotSignature)) {
            sessionState.scheduledSlotSignatures.push(attemptedSlotSignature);
          }
          console.log(`${toolCall.function.name}: slot=${attemptedSlotSignature}`);
        }

        // Reschedule support: when a cancel/edit succeeds, clear the slot-based
        // scheduling guard so the AI can call `agendar` again for a new slot
        // (e.g. customer wants to change the day/time of an existing appointment).
        const isCancelOrEditTool = [
          "cancelar_agendamento", "desmarcar_agendamento", "editar_agendamento",
        ].includes(toolCall.function.name);
        const cancelOrEditSucceeded = isCancelOrEditTool && !toolResult?.error && !toolResult?.blocked;
        if (cancelOrEditSucceeded) {
          cancelOrEditHappenedThisInvocation = true;
          if (sessionState.scheduledSlotSignatures.length > 0) {
            sessionState.scheduledSlotSignatures = [];
          }
        }

        // ===== GLOBAL ACTION LEDGER — record successful mutating actions =====
        // Runs for ANY mutating tool (booking, cancel, register, custom side-effects)
        // so the next message can't accidentally repeat the same action.
        try {
          const mutInfo2 = isMutatingToolName(toolCall.function.name, tenant);
          if (mutInfo2.mutating && !wasBlocked) {
            const r: any = toolResult || {};
            const succeeded = !r.error && !r.blocked && r.success !== false
              && !(Array.isArray(r.Errors) && r.Errors.length > 0);
            if (succeeded) {
              const dedupeKey = buildDedupeKey(toolCall.function.name, parsedArgs);
              const summary = buildActionSummary(toolCall.function.name, parsedArgs, r);
              const resultId = r?.id ?? r?.agendamentoId ?? r?.appointment_id ?? null;
              recordCompletedAction(sessionState, {
                toolName: toolCall.function.name,
                category: mutInfo2.category,
                dedupeKey,
                status: "success",
                summary,
                resultId,
              });
              console.log(`[ActionLedger] recorded success: ${toolCall.function.name} key=${dedupeKey.slice(0, 100)}`);
            }
          }
        } catch (e) {
          console.warn(`[ActionLedger] record failed: ${(e as any)?.message || e}`);
        }


        // Track valid agendasIds from buscar_agendamentos_dia
        // 🚨 CROSS-CLIENT TRAVA: filtra agendamentos pelo telefone do lead atual
        // ANTES de devolver pro modelo, para evitar que a IA confunda agendamento de
        // outra pessoa (ex: irmão/parente) como sendo do cliente que está conversando.
        if (toolCall.function.name === "buscar_agendamentos_dia" && Array.isArray(toolResult)) {
          const phoneClean = (phoneNumber || "").replace(/^55/, "").replace(/\D/g, "");
          const myAgendamentos = toolResult.filter((a: any) => {
            const cel = String(a?.celular || "").replace(/^55/, "").replace(/\D/g, "");
            if (!cel) return false;
            return cel === phoneClean || cel.endsWith(phoneClean) || phoneClean.endsWith(cel);
          });
          const filtered = myAgendamentos;
          sessionState.validAgendasIds = filtered.map((a: any) => a.agendasId).filter((id: any) => typeof id === "number");
          (sessionState as any).oneBelezaAgendaOptions = filtered;
          (sessionState as any).validAgendasIdsFetchedAt = Date.now();
          console.log(`Tracked validAgendasIds (filtered by phone ${phoneClean}): [${sessionState.validAgendasIds}] (raw=${toolResult.length}, mine=${filtered.length})`);
          // 🔁 Substitui o resultado entregue à IA pelo subset do próprio cliente.
          // Se o cliente não tem nada marcado nesse dia, devolve array vazio com aviso.
          toolResult = filtered.length > 0
            ? filtered
            : { empty: true, message: `Nenhum agendamento encontrado para o telefone ${phoneNumber} nessa data. NÃO mencione agendamentos de outros clientes.` };
        }

        if (provider === "bemp" && toolCall.function.name === "listar_unidades" && Array.isArray(toolResult)) {
          const salonOptions = toolResult
            .map((option: any) => ({
              salonId: toPositiveInteger(option?.id) ?? 0,
              name: String(option?.name || "").trim(),
            }))
            .filter((option: any) => option.salonId > 0);

          sessionState.bempSalonOptions = dedupeByKey(
            [...sessionState.bempSalonOptions, ...salonOptions],
            (option) => String(option.salonId),
          );

          if (salonOptions.length === 1) {
            sessionState.selectedSalonId = salonOptions[0].salonId;
          }

          console.log(`Tracked Bemp salons: [${sessionState.bempSalonOptions.map((o) => o.salonId).join(", ")}]`);
        }

        if (provider === "bemp" && toolCall.function.name === "listar_profissionais" && Array.isArray(toolResult)) {
          const salonId = toPositiveInteger(parsedArgs?.salonId);
          const serviceId = toPositiveInteger(parsedArgs?.serviceId);
          const professionalOptions = toolResult
            .map((option: any) => ({
              salonId: salonId ?? null,
              serviceId: serviceId ?? null,
              professionalId: toPositiveInteger(option?.id) ?? 0,
              name: String(option?.name || "").trim(),
            }))
            .filter((option: any) => option.professionalId > 0);

          sessionState.bempProfessionalOptions = dedupeByKey(
            [...sessionState.bempProfessionalOptions, ...professionalOptions],
            (option) => `${option.salonId ?? "any"}:${option.serviceId ?? "any"}:${option.professionalId}`,
          );

          if (salonId) sessionState.selectedSalonId = salonId;
          if (serviceId) sessionState.selectedServiceId = serviceId;
          if (professionalOptions.length === 1) {
            sessionState.selectedProfessionalId = professionalOptions[0].professionalId;
          }

          console.log(`Tracked Bemp professional IDs: [${sessionState.bempProfessionalOptions.map((o) => o.professionalId).join(", ")}]`);
        }

        if (provider === "bemp" && toolCall.function.name === "listar_horarios" && Array.isArray(toolResult)) {
          const salonId = toPositiveInteger(parsedArgs?.salonId);
          const serviceId = toPositiveInteger(parsedArgs?.serviceId);
          const professionalId = toPositiveInteger(parsedArgs?.professionalId);
          const date = typeof parsedArgs?.data === "string" ? parsedArgs.data : null;

          sessionState.bempSlotOptions = dedupeByKey(
            [
              ...sessionState.bempSlotOptions,
              ...toolResult
                .map((slot: any) => ({
                  salonId: salonId ?? null,
                  serviceId: serviceId ?? null,
                  professionalId: professionalId ?? null,
                  date,
                  start: String(slot?.start || ""),
                  end: String(slot?.end || ""),
                  start_text: typeof slot?.start_text === "string" ? slot.start_text : undefined,
                  end_text: typeof slot?.end_text === "string" ? slot.end_text : undefined,
                }))
                .filter((slot: any) => slot.start && slot.end),
            ],
            (slot) => `${slot.salonId ?? "any"}:${slot.serviceId ?? "any"}:${slot.professionalId ?? "any"}:${slot.start}:${slot.end}`,
          );

          if (salonId) sessionState.selectedSalonId = salonId;
          if (serviceId) sessionState.selectedServiceId = serviceId;
          if (professionalId) sessionState.selectedProfessionalId = professionalId;
          if (date) sessionState.selectedDate = date;

          console.log(`Tracked Bemp slot options: ${sessionState.bempSlotOptions.length}`);
        }

        if (provider === "zaylo" && toolCall.function.name === "obter_info" && toolResult && !toolResult?.error) {
          const barberOptions = Array.isArray(toolResult?.barbers)
            ? toolResult.barbers
                .map((barber: any) => ({
                  barberId: String(barber?.id || "").trim(),
                  name: String(barber?.name || "").trim(),
                }))
                .filter((option: any) => option.barberId && option.name)
            : [];

          const serviceOptions = Array.isArray(toolResult?.services)
            ? toolResult.services
                .map((service: any) => ({
                  serviceId: String(service?.id || "").trim(),
                  name: String(service?.name || "").trim(),
                  price: typeof service?.price === "number" ? service.price : null,
                }))
                .filter((option: any) => option.serviceId && option.name)
            : [];

          sessionState.zayloBarberOptions = dedupeByKey(
            [...(sessionState.zayloBarberOptions || []), ...barberOptions],
            (option) => option.barberId,
          );
          sessionState.zayloServiceOptions = dedupeByKey(
            [...(sessionState.zayloServiceOptions || []), ...serviceOptions],
            (option) => option.serviceId,
          );

          console.log(`Tracked Zaylo barbers: [${(sessionState.zayloBarberOptions || []).map((option) => option.barberId).join(", ")}]`);
          console.log(`Tracked Zaylo services: [${(sessionState.zayloServiceOptions || []).map((option) => option.serviceId).join(", ")}]`);
        }

        if (provider === "zaylo" && toolCall.function.name === "obter_horarios_disponiveis" && toolResult && !toolResult?.error) {
          const barberId = typeof parsedArgs?.barber_id === "string" ? parsedArgs.barber_id : (sessionState.selectedZayloBarberId || null);
          const serviceId = typeof parsedArgs?.service_id === "string" ? parsedArgs.service_id : (sessionState.selectedZayloServiceId || null);
          const date = typeof parsedArgs?.date === "string" ? parsedArgs.date : null;
          const slotOptions = Array.isArray(toolResult?.available_times)
            ? toolResult.available_times
                .map((time: any) => ({
                  barberId,
                  serviceId,
                  date,
                  time: String(time || "").trim(),
                }))
                .filter((option: any) => option.time)
            : [];

          sessionState.zayloSlotOptions = dedupeByKey(
            [...(sessionState.zayloSlotOptions || []), ...slotOptions],
            (option) => `${option.barberId ?? "any"}:${option.serviceId ?? "any"}:${option.date ?? "any"}:${option.time}`,
          );

          if (barberId) sessionState.selectedZayloBarberId = barberId;
          if (serviceId) sessionState.selectedZayloServiceId = serviceId;
          if (date) sessionState.selectedDate = date;

          console.log(`Tracked Zaylo slot options: ${(sessionState.zayloSlotOptions || []).length}`);
        }

        if (provider === "zaylo") {
          const barberId = typeof parsedArgs?.barber_id === "string" ? parsedArgs.barber_id : null;
          const serviceId = typeof parsedArgs?.service_id === "string" ? parsedArgs.service_id : null;
          const date = typeof parsedArgs?.date === "string" ? parsedArgs.date : null;

          if (barberId) sessionState.selectedZayloBarberId = barberId;
          if (serviceId) sessionState.selectedZayloServiceId = serviceId;
          if (date) sessionState.selectedDate = date;
        }

        // ===== TRINKS: catálogo + service lock tracking =====
        if (provider === "trinks" && toolCall.function.name === "listar_servicos" && Array.isArray(toolResult)) {
          const catalog = toolResult
            .map((s: any) => ({
              id: toPositiveInteger(s?.id) ?? null,
              nome: typeof s?.nome === "string" ? s.nome : "",
              duracao: toPositiveInteger(s?.duracaoEmMinutos) ?? null,
            }))
            .filter((s: any) => s.id && s.duracao);
          (sessionState as any).trinksServiceCatalog = catalog;
          console.log(`[TrinksLock] catalog tracked: ${catalog.length} serviços`);
        }

        if (provider === "trinks" && toolCall.function.name === "listar_horarios" && !wasBlocked && toolResult && !(toolResult as any)?.error) {
          const reqDur = toPositiveInteger(parsedArgs?.servicoDuracao);
          if (reqDur) {
            const catalog = ((sessionState as any).trinksServiceCatalog || []) as Array<{ id: number; nome: string; duracao: number }>;
            const matches = catalog.filter((s) => s.duracao === reqDur);
            const prevDur = (sessionState as any).trinksSelectedServiceDuration as number | null;
            (sessionState as any).trinksSelectedServiceDuration = reqDur;
            (sessionState as any).trinksLockUpdatedAt = Date.now();
            // Só trava nome/id quando há UM único serviço para essa duração.
            // Caso contrário (ambíguo), mantém apenas a duração travada.
            if (matches.length === 1) {
              (sessionState as any).trinksSelectedServiceId = matches[0].id;
              (sessionState as any).trinksSelectedServiceName = matches[0].nome;
            } else {
              (sessionState as any).trinksSelectedServiceId = null;
              (sessionState as any).trinksSelectedServiceName = null;
            }
            if (prevDur !== reqDur) {
              console.log(`[TrinksLock] dur locked=${reqDur} (${matches.length} serviço(s) compatíveis)`);
            }
          }
        }

        if (provider === "trinks" && toolCall.function.name === "criar_agendamento" && !wasBlocked && toolResult && !(toolResult as any)?.error) {
          // Agendamento concluído → limpa a trava para não bloquear o próximo agendamento.
          console.log(`[TrinksLock] criar_agendamento OK — limpando trava de serviço`);
          (sessionState as any).trinksSelectedServiceId = null;
          (sessionState as any).trinksSelectedServiceDuration = null;
          (sessionState as any).trinksSelectedServiceName = null;
          (sessionState as any).trinksLockUpdatedAt = 0;
        }

        // ===== FRIZZAR: rastreia última grade real consultada =====
        // Usado pelo pre-guard de `agendar` para impedir que a IA tente marcar
        // um horário que não veio de uma `listar_horarios` recente.
        if (provider === "frizzar" && toolCall.function.name === "listar_horarios" && !wasBlocked && toolResult && !(toolResult as any)?.error) {
          const profId = toPositiveInteger(parsedArgs?.profissionalId);
          const data = typeof parsedArgs?.data === "string" ? parsedArgs.data.slice(0, 10) : null;
          if (profId && data) {
            frizzarLastListed.set(`${tenant.id}:${phoneNumber || ""}:${profId}`, { dia: data, listedAt: Date.now() });
            sessionState.selectedProfessionalId = profId;
            sessionState.selectedDate = data;
            console.log(`[FrizzarGuard] tracked listar_horarios prof=${profId} data=${data}`);
          }
        }



        if (provider === "onebeleza" && toolCall.function.name === "buscar_servicos") {
          sessionState.oneBelezaServiceOptions = extractOneBelezaServiceOptions(toolResult);
          sessionState.allowedServiceIds = dedupeByKey(
            sessionState.oneBelezaServiceOptions.map((option) => option.servicosId),
            (id) => String(id),
          );
          // Build serviceId → unidade (gservsID + descricao) map for unit guard
          const unitMap: Record<string, { gservsID: number; descricao: string }> = {};
          if (Array.isArray(toolResult)) {
            for (const grp of toolResult) {
              const gid = toPositiveInteger(grp?.gservsID);
              const desc = String(grp?.descricao || "").trim();
              if (!gid || !Array.isArray(grp?.servicos)) continue;
              for (const svc of grp.servicos) {
                const sid = toPositiveInteger(svc?.servicosId);
                if (sid) unitMap[String(sid)] = { gservsID: gid, descricao: desc };
              }
            }
          }
          (sessionState as any).oneBelezaServiceUnitMap = unitMap;
          console.log(`Tracked OneBeleza service IDs: [${sessionState.oneBelezaServiceOptions.map((option) => option.servicosId).join(", ")}]`);
          console.log(`Tracked allowed OneBeleza service IDs: [${sessionState.allowedServiceIds.join(", ")}]`);
          console.log(`Tracked OneBeleza service→unit map: ${Object.keys(unitMap).length} entries`);
        }

        if (provider === "onebeleza" && toolCall.function.name === "buscar_barbeiros_por_servico") {
          const professionalOptions = extractOneBelezaProfessionalOptions(toolResult, parsedArgs);
          sessionState.oneBelezaProfessionalOptions = dedupeByKey(
            [...sessionState.oneBelezaProfessionalOptions, ...professionalOptions],
            (option) => `${option.servicosId ?? "any"}:${option.profissionalId}`,
          );
          console.log(`Tracked OneBeleza professional IDs: [${sessionState.oneBelezaProfessionalOptions.map((option) => option.profissionalId).join(", ")}]`);

          // Auto-select professional if only one
          if (professionalOptions.length === 1) {
            sessionState.selectedProfessionalId = professionalOptions[0].profissionalId;
            console.log(`[State] Auto-selected profissionalId: ${sessionState.selectedProfessionalId}`);
          } else if (professionalOptions.length > 1) {
            // Select the one the AI asked for (it was already resolved)
            const requestedId = toPositiveInteger(parsedArgs?.servicosId ?? parsedArgs?.servicoId);
            const selectedProf = toPositiveInteger(parsedArgs?.profissionalId ?? parsedArgs?.ProfissionalId);
            if (selectedProf && professionalOptions.some(p => p.profissionalId === selectedProf)) {
              sessionState.selectedProfessionalId = selectedProf;
            }
          }

          // Also track selected service
          const svcId = toPositiveInteger(parsedArgs?.servicosId ?? parsedArgs?.servicoId);
          if (svcId) {
            sessionState.selectedServiceId = svcId;
            console.log(`[State] Selected servicoId: ${svcId}`);
          }
        }

        if (provider === "onebeleza" && (toolCall.function.name === "buscar_horarios" || toolCall.function.name === "buscar_horarios_disponiveis")) {
          const slotOptions = extractOneBelezaSlotOptions(toolResult, parsedArgs);
          sessionState.oneBelezaSlotOptions = dedupeByKey(
            [...sessionState.oneBelezaSlotOptions, ...slotOptions],
            (slot) => `${slot.date}:${slot.servicoId}:${slot.profissionalId}:${slot.horarioInicio}:${slot.horarioFim}`,
          );
          console.log(`Tracked OneBeleza slot options: ${sessionState.oneBelezaSlotOptions.length}`);

          // For the consolidated tool, also extract professional options from the same response
          if (toolCall.function.name === "buscar_horarios_disponiveis" && Array.isArray(toolResult)) {
            const profOptions = extractOneBelezaProfessionalOptionsFromAvailability(toolResult, parsedArgs);
            sessionState.oneBelezaProfessionalOptions = dedupeByKey(
              [...sessionState.oneBelezaProfessionalOptions, ...profOptions],
              (option) => `${option.servicosId ?? "any"}:${option.profissionalId}`,
            );
            console.log(`Tracked OneBeleza professional IDs (from consolidated): [${sessionState.oneBelezaProfessionalOptions.map((o) => o.profissionalId).join(", ")}]`);
          }

          // Track selected date and professional from the args
          const resolvedDate = normalizeOneBelezaDate(parsedArgs?.date);
          if (resolvedDate) {
            sessionState.selectedDate = resolvedDate;
            console.log(`[State] Selected date: ${resolvedDate}`);
          }
          const resolvedProf = toPositiveInteger(parsedArgs?.ProfissionalId ?? parsedArgs?.profissionalId);
          if (resolvedProf) {
            sessionState.selectedProfessionalId = resolvedProf;
          }
          const resolvedSvc = toPositiveInteger(parsedArgs?.servicoId ?? parsedArgs?.servicoid);
          if (resolvedSvc) {
            sessionState.selectedServiceId = resolvedSvc;
          }
        }

        // Track selections from buscar_datas_disponiveis
        if (provider === "onebeleza" && toolCall.function.name === "buscar_datas_disponiveis") {
          const svcId = toPositiveInteger(parsedArgs?.servicosId ?? parsedArgs?.servicoId);
          const profId = toPositiveInteger(parsedArgs?.profissionalid ?? parsedArgs?.profissionalId);
          if (svcId) sessionState.selectedServiceId = svcId;
          if (profId) sessionState.selectedProfessionalId = profId;
        }
      }

      // Build enhanced log entry
      const logEntry: AgentResult["toolCalls"][0] = {
        name: toolCall.function.name,
        args: parsedArgs,
        result: toolResult,
        blocked: wasBlocked,
      };
      
      // Add correction info if applicable
      if (correctionReason) {
        logEntry.originalArgs = originalParsedArgs;
        logEntry.resolvedArgs = parsedArgs;
        logEntry.correctionReason = correctionReason;
      }
      
      logToolCalls.push(logEntry);

      if (toolResult?.error) {
        logErrors.push(`Tool ${toolCall.function.name}: ${JSON.stringify(toolResult.error).slice(0, 200)}`);
      }

      console.log(`Tool result (${toolCall.function.name}):`, JSON.stringify(toolResult).slice(0, 500));
      
      // Mark tool as executed and persist it for the conversation
      if (!wasBlocked) {
        executedToolsThisSession.add(toolCall.function.name);
        sessionState.executedToolNames = Array.from(executedToolsThisSession);
      }
      
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(toolResult),
      });

      // 🚨 HARD GUARD: se uma ferramenta de AGENDAMENTO falhou, é TERMINANTEMENTE
      // PROIBIDO confirmar o agendamento. Força a IA a NÃO inventar sucesso e
      // a acionar a ferramenta de escalar humano (se existir). Vale para TODOS os provedores.
      const bookingToolNames = new Set([
        "criar_agendamento", "agendar", "editar_agendamento",
      ]);
      if (bookingToolNames.has(toolCall.function.name)) {
        const r: any = toolResult || {};
        const succeeded = !r.error && !r.blocked && r.success !== false
          && !(Array.isArray(r.Errors) && r.Errors.length > 0)
          && (r.id || r.ok || r.success === true || r.agendamentoId || r.appointment_id || r.data);
        if (!succeeded) {
          if (provider === "frizzar" && toolCall.function.name === "agendar" && isRecoverableFrizzarScheduleResult(r)) {
            messages.push({ role: "system", content: buildFrizzarScheduleRecoveryInstruction(r, parsedArgs) });
            logErrors.push(`[BookingGuard] Frizzar agendar failed with recoverable availability — injected alternatives directive`);
            continue;
          }
          // Conflitos recuperáveis (ex.: AppBarber 422 — choque de horário). NÃO escalar.
          if (r?.recoverable === true) {
            const recoveryMsg = [
              "⚠️ Conflito de horário ao tentar agendar (não é falha de sistema).",
              `Motivo: ${r?.error || "horário indisponível"}.`,
              "Ação OBRIGATÓRIA: chame listar_horarios novamente para o MESMO serviço e profissional na MESMA data e ofereça ao cliente os horários realmente livres.",
              "NÃO escale humano. NÃO diga que houve erro/problema. NÃO confirme o agendamento.",
              "Fale de forma natural: o horário escolhido acabou de ficar indisponível e ofereça as alternativas que vierem da próxima consulta.",
            ].join(" ");
            messages.push({ role: "system", content: recoveryMsg });
            logErrors.push(`[BookingGuard] ${toolCall.function.name} recoverable conflict — injected retry directive`);
            continue;
          }
          const escalateTool = (getEnabledCustomTools(tenant) || []).find(
            (t: any) => t?.type === "escalate_human",
          );
          const escalateName = escalateTool?.name;
          const guardMsg = [
            "⛔ FALHA NA FERRAMENTA DE AGENDAMENTO.",
            "É TERMINANTEMENTE PROIBIDO confirmar, dizer que agendou, que está marcado, encaixado, ou qualquer variação de sucesso.",
            "NÃO invente que o agendamento foi feito.",
            escalateName
              ? `OBRIGATÓRIO: chame AGORA a ferramenta "${escalateName}" para acionar um atendente humano. Passe um motivo curto descrevendo a falha.`
              : "OBRIGATÓRIO: responda ao cliente que não foi possível concluir o agendamento agora e que um atendente humano vai assumir em instantes. NÃO confirme o agendamento.",
          ].join(" ");
          messages.push({ role: "system", content: guardMsg });
          logErrors.push(`[BookingGuard] Booking tool ${toolCall.function.name} failed — injected escalate directive`);
        } else {
          // ✅ SUCESSO: força a IA a PARAR de chamar ferramentas e responder agora.
          // Sem isso, em alguns casos a IA chama listar_horarios/listar_agendamentos
          // depois do agendar bem-sucedido, estoura o limite de rounds e acaba
          // entregando uma resposta vazia ao cliente — mesmo com a reserva criada.
          const successMsg = [
            "✅ AGENDAMENTO CRIADO COM SUCESSO.",
            "PARE imediatamente de chamar ferramentas — NÃO chame listar_horarios, listar_agendamentos, buscar_agendamento, agendar de novo, nem qualquer outra. NADA.",
            "Sua PRÓXIMA ação OBRIGATÓRIA é responder ao cliente em PORTUGUÊS, em UMA mensagem curta de WhatsApp, confirmando:",
            "(1) que o agendamento foi feito; (2) data e horário; (3) serviço; (4) profissional. Use os dados do último resultado da ferramenta.",
            "Não invente preço nem nada que não esteja no resultado. Termine com uma despedida curta (ex: 'até lá!' ou um emoji).",
          ].join(" ");
          messages.push({ role: "system", content: successMsg });
        }
      }
    }

    const roundBody: any = { model: modelUsed, messages, max_completion_tokens: 4096 };
    // Minimize reasoning latency on gpt-5* models — saves 10-20s per round
    if (modelUsed.includes("gpt-5")) {
      roundBody.reasoning_effort = "low";
    }
    if (tools && tools.length > 0) {
      roundBody.tools = tools;
      roundBody.tool_choice = "auto";
    }
    const roundBodyStr = JSON.stringify(roundBody);
    console.log(`AI request (round ${rounds}): ${messages.length} msgs, body size: ${roundBodyStr.length} chars`);

    response = await fetchAIWithRetry(roundBodyStr, `tool round ${rounds}`);

    if (!response.ok) {
      const errText = await response.text();
      console.error("AI gateway error (tool round):", response.status, errText);
      logErrors.push(`AI gateway error (round ${rounds}): ${response.status} ${errText.slice(0, 200)}`);
      // Save state even on error
      if (!simulatorMode) await saveConversationState(supabase, tenant.id, phoneNumber, sessionState);
      sessionBlocked = true;
      return { response: "Só um instante, vou avisar o responsável pra te atender por aqui 🙏", toolCalls: logToolCalls, errors: logErrors, model: modelUsed, durationMs: Date.now() - startTime, sessionBlocked };
    }

    result = await response.json();
    console.log(`AI response metadata (round ${rounds}):`, JSON.stringify({ finishReason: result?.choices?.[0]?.finish_reason || null, hasMessage: Boolean(result?.choices?.[0]?.message), hasToolCalls: Boolean(result?.choices?.[0]?.message?.tool_calls?.length), contentLength: typeof result?.choices?.[0]?.message?.content === "string" ? result.choices[0].message.content.length : 0 }).slice(0, 300));
    assistantMessage = result.choices?.[0]?.message;
  }

  // Save persistent state after all tool rounds
  if (!simulatorMode) await saveConversationState(supabase, tenant.id, phoneNumber, sessionState);

  let finalResponse = typeof assistantMessage?.content === "string" ? assistantMessage.content.trim() : "";

  // Strip leaked internal prefixes (NEVER expose to client)
  finalResponse = stripInternalPrefixes(finalResponse);

  // Detect leaked reasoning/scratchpad (e.g., "Vou proceed. Need next user input.") and regenerate
  if (finalResponse && isLeakedReasoningResponse(finalResponse)) {
    console.warn(`[LeakDetected] Discarding leaked reasoning response: "${finalResponse.slice(0, 120)}"`);
    logErrors.push(`Leaked reasoning detected and discarded: "${finalResponse.slice(0, 120)}"`);
    finalResponse = "";
  }

  if (!finalResponse) {
    const recoveredResponseRaw = await requestFinalNaturalResponse(messages);
    const recoveredResponse = stripInternalPrefixes(recoveredResponseRaw || "");
    if (recoveredResponse && !isLeakedReasoningResponse(recoveredResponse)) {
      finalResponse = recoveredResponse;
    } else if (recoveredResponse) {
      console.warn(`[LeakDetected] Recovery also leaked, discarding: "${recoveredResponse.slice(0, 120)}"`);
      logErrors.push(`Recovery response also leaked: "${recoveredResponse.slice(0, 120)}"`);
    }
  }

  if (!finalResponse) {
    // 🛟 Última rede de segurança: se um AGENDAMENTO foi efetivamente criado
    // nesta rodada mas a IA não conseguiu produzir uma resposta (estourou o
    // limite de rounds, devolveu vazio, etc.), montamos uma confirmação
    // determinística a partir do resultado da própria tool. Evita o pior
    // cenário: reserva criada na agenda + cliente sem nenhuma resposta no WhatsApp.
    const bookingFallback = buildDeterministicBookingConfirmation(logToolCalls);
    if (bookingFallback) {
      console.warn(`[BookingFallback] AI response empty after successful booking — sending deterministic confirmation.`);
      logErrors.push(`Resposta vazia após agendamento bem-sucedido — usado fallback determinístico.`);
      finalResponse = bookingFallback;
    } else {
      // Last-resort fallback: stay completely silent rather than send a generic line that
      // breaks character. Returning empty string prevents the webhook from sending a message.
      finalResponse = "";
    }
  }

  // 🚨 LOOP DETECTOR (FIX #3): se a IA repetiu o MESMO conjunto de horários 3x seguidas
  // sem o cliente confirmar, troca a resposta por um pedido de paciência + flag interna
  // para o operador humano assumir. Evita irritar o cliente em loop.
  if (finalResponse) {
    const timeTokens = (finalResponse.match(/\b\d{1,2}[:h]\d{2}\b/g) || []).map((t) => t.toLowerCase());
    if (timeTokens.length >= 3) {
      const signature = [...new Set(timeTokens)].sort().join(",");
      const history: string[] = Array.isArray((sessionState as any).lastTimeListings)
        ? (sessionState as any).lastTimeListings
        : [];
      history.push(signature);
      while (history.length > 3) history.shift();
      (sessionState as any).lastTimeListings = history;
      if (history.length === 3 && history[0] === history[1] && history[1] === history[2]) {
        console.warn(`[LoopDetector] 3x mesma lista de horários para ${phoneNumber}: ${signature}. Substituindo resposta e zerando histórico.`);
        logErrors.push(`Loop de listagem de horários detectado (sig=${signature})`);
        finalResponse = "Vou pedir pra um atendente humano te ajudar a finalizar isso, um momento por favor 🙏";
        sessionBlocked = true;
        (sessionState as any).lastTimeListings = [];
        if (!simulatorMode) await saveConversationState(supabase, tenant.id, phoneNumber, sessionState);
      }
    } else {
      // resposta sem listagem → reset do tracker
      (sessionState as any).lastTimeListings = [];
    }
  }

  // 🔁 ANTI-REPETIÇÃO DE TEXTO — se a resposta gerada for muito parecida com
  // alguma das últimas respostas enviadas nos últimos 30 min, tenta regenerar
  // uma vez forçando "diga algo novo ou fique em silêncio". Se ainda assim vier
  // duplicada, fica em silêncio (string vazia) — preferimos não enviar nada do
  // que mandar a mesma coisa de novo.
  if (finalResponse) {
    const dupHit = findSimilarRecentReply(sessionState, finalResponse);
    if (dupHit) {
      console.warn(`[ReplyDedup] Resposta similar à enviada há ${Math.round((Date.now() - Date.parse(dupHit.entry.at)) / 60000)}min (sim=${dupHit.sim.toFixed(2)}) para ${phoneNumber}. Tentando regenerar.`);
      logErrors.push(`Reply repetida detectada (sim=${dupHit.sim.toFixed(2)}); regenerando.`);
      const antiRepeatReminder = {
        role: "system" as const,
        content:
          `ALERTA: você acabou de gerar uma mensagem quase idêntica a "${dupHit.entry.text.slice(0, 200)}" que você JÁ ENVIOU há poucos minutos. NÃO repita. Avalie: a última mensagem do cliente traz pergunta ou informação realmente NOVA? Se SIM, responda com algo DIFERENTE e que avance a conversa. Se NÃO (mensagem fragmentada, emoji, "ok", "valeu", ou repetindo o que já perguntou), devolva uma STRING VAZIA — não envie nada. Nunca reenvie a mesma resposta nem uma paráfrase do mesmo conteúdo.`,
      };
      try {
        const regenRaw = await requestFinalNaturalResponse([...messages, antiRepeatReminder]);
        const regen = stripInternalPrefixes(regenRaw || "").trim();
        if (regen && !isLeakedReasoningResponse(regen)) {
          const stillDup = findSimilarRecentReply(sessionState, regen);
          if (stillDup) {
            console.warn(`[ReplyDedup] Regeneração ainda duplicada (sim=${stillDup.sim.toFixed(2)}). Silenciando.`);
            logErrors.push(`Regeneração ainda duplicada — mensagem suprimida.`);
            finalResponse = "";
          } else {
            finalResponse = regen;
          }
        } else {
          // Modelo escolheu não falar — respeita.
          console.log(`[ReplyDedup] Regeneração vazia → silêncio intencional para ${phoneNumber}.`);
          finalResponse = "";
        }
      } catch (e) {
        console.error("[ReplyDedup] Falha ao regenerar, silenciando:", (e as any)?.message);
        finalResponse = "";
      }
    }
  }

  if (finalResponse) {
    recordAssistantReply(sessionState, finalResponse);
    if (!simulatorMode) await saveConversationState(supabase, tenant.id, phoneNumber, sessionState);
  }

  await maybeAutoPersistClientSummary(finalResponse);
  return { response: finalResponse, toolCalls: logToolCalls, errors: logErrors, model: modelUsed, durationMs: Date.now() - startTime, sessionBlocked };
}

// ===================== PROVIDER DISPATCHER =====================

// Universal tool injected for every provider — the AI uses it to keep a small
// persistent "dossier" about the client (preferences, plan, journey).
const ATUALIZAR_RESUMO_TOOL = {
  type: "function" as const,
  function: {
    name: "atualizar_resumo_cliente",
    description:
      "Atualiza o RESUMO PERSISTENTE deste cliente (jornada/perfil) quando ele revelar algo relevante e duradouro: serviço favorito, profissional preferido, plano/assinatura/clube, frequência típica, restrições, datas importantes, observações úteis para futuros atendimentos. NÃO use para coisas efêmeras (humor, status de mensagem). Sempre reescreva o resumo INTEIRO (não acumule) e mantenha curto, até ~600 caracteres, em português, no formato 'frase + frase + frase'.",
    parameters: {
      type: "object",
      properties: {
        resumo: {
          type: "string",
          description: "Texto novo COMPLETO do resumo (substitui o anterior). Curto, factual, em PT-BR, até ~600 caracteres.",
        },
      },
      required: ["resumo"],
    },
  },
};

function buildToolsForProvider(provider: string, tenant: any): any[] | undefined {
  let providerTools: any[] | undefined;
  switch (provider) {
    case "trinks":
      providerTools = buildTrinksTools(tenant);
      break;
    case "onebeleza":
      providerTools = buildOneBelezaTools(tenant);
      break;
    case "frizzar":
      providerTools = buildFrizzarTools(tenant);
      break;
    case "bemp":
      providerTools = buildBempTools(tenant);
      break;
    case "zaylo":
      providerTools = buildZayloTools(tenant);
      break;
    case "appbarber":
      providerTools = buildAppBarberTools(tenant);
      break;
    case "none":
      providerTools = buildNoneTools(tenant);
      break;
    default:
      providerTools = buildTrinksTools(tenant);
  }

  // Universal client-summary tool (all providers)
  providerTools = [...(providerTools || []), ATUALIZAR_RESUMO_TOOL];

  // Inject custom tools from tenant.agent_settings
  const customTools = getEnabledCustomTools(tenant);
  if (customTools.length > 0) {
    const customToolDefs = customTools.map((ct: any) => {
      // Build a rich description so the model can pick the RIGHT tool when many similar
      // tools exist (e.g. multiple etiquetas). The prompt_instruction holds the real
      // "use when..." rule and is critical for tool selection by the LLM.
      const baseDesc = ct.description || ct.display_name || ct.name;
      const usageRule = (ct.prompt_instruction || "").trim();
      const richDescription = usageRule
        ? `${baseDesc}. QUANDO USAR: ${usageRule}`
        : baseDesc;

      return {
        type: "function",
        function: {
          name: ct.name,
          description: richDescription,
          parameters: {
            type: "object",
            properties: ct.type === "escalate_human" ? {
              motivo: { type: "string", description: "Motivo para escalar para atendente humano" },
            } : {},
            required: [],
          },
        },
      };
    });
    providerTools = [...(providerTools || []), ...customToolDefs];
  }

  return providerTools;
}

// Heuristic: any tool that mutates external state must be blocked in simulator mode.
const WRITE_TOOL_NAME_RE = /^(criar_|cadastrar_|agendar$|agendar_|cancelar_|desmarcar_|editar_|confirmar_|atualizar_|enviar_|send_|escalate|debug_)/i;
function isWriteToolName(name: string): boolean {
  return WRITE_TOOL_NAME_RE.test(name);
}

function getEnabledCustomTools(tenant: any): any[] {
  const settings = tenant?.agent_settings;
  if (!settings || typeof settings !== "object") return [];
  const tools = settings.custom_tools;
  if (!Array.isArray(tools)) return [];
  return tools.filter((t: any) => t.enabled === true);
}

async function executeToolForProvider(
  provider: string,
  tenant: any,
  toolCall: any,
  phoneNumber?: string,
  opts?: { supabase?: any; simulatorMode?: boolean },
): Promise<any> {
  const funcName = toolCall.function.name;
  const simulator = !!opts?.simulatorMode;

  // ===== SIMULATOR MODE: block any tool that writes to external systems or to the DB.
  if (simulator) {
    const customTools = getEnabledCustomTools(tenant);
    const isCustom = customTools.some((ct: any) => ct.name === funcName);
    if (isCustom || isWriteToolName(funcName)) {
      return {
        ok: true,
        simulated: true,
        message: `Ação simulada — no WhatsApp real, "${funcName}" seria executada de verdade.`,
      };
    }
  }

  // ===== Universal tool: atualizar_resumo_cliente
  if (funcName === "atualizar_resumo_cliente") {
    let toolArgs: any = {}; try { toolArgs = JSON.parse(toolCall.function.arguments || "{}"); } catch { /* empty */ }
    const resumo = String(toolArgs?.resumo ?? "").trim().slice(0, 1200);
    if (!resumo) return { ok: false, error: "Resumo vazio." };
    if (simulator) {
      return { ok: true, simulated: true, message: "Resumo atualizado (simulado)." };
    }
    const sb = opts?.supabase;
    if (!sb || !phoneNumber) return { ok: false, error: "Contexto indisponível para persistir resumo." };
    try {
      const { data: existing } = await sb
        .from("crm_leads")
        .select("id")
        .eq("tenant_id", tenant.id)
        .eq("phone_number", phoneNumber)
        .limit(1);
      if (existing && existing.length > 0) {
        await sb
          .from("crm_leads")
          .update({ ai_summary: resumo, ai_summary_updated_at: new Date().toISOString() })
          .eq("id", existing[0].id);
      } else {
        await sb
          .from("crm_leads")
          .insert({
            tenant_id: tenant.id,
            phone_number: phoneNumber,
            label_id: "novo",
            ai_summary: resumo,
            ai_summary_updated_at: new Date().toISOString(),
          } as any);
      }
      return { ok: true };
    } catch (e: any) {
      console.error("[atualizar_resumo_cliente] failed:", e?.message);
      return { ok: false, error: e?.message || "Falha ao salvar resumo." };
    }
  }

  // Check if it's a custom tool
  const customTools = getEnabledCustomTools(tenant);
  const customTool = customTools.find((ct: any) => ct.name === funcName);
  if (customTool) {
    let toolArgs: any = {}; try { toolArgs = JSON.parse(toolCall.function.arguments || "{}"); } catch { /* empty */ }
    return executeCustomTool(tenant, customTool, phoneNumber || "", toolArgs);
  }

  switch (provider) {
    case "trinks":
      return executeTrinksTool(tenant, toolCall, phoneNumber);
    case "onebeleza":
      return executeOneBelezaTool(tenant, toolCall, phoneNumber);
    case "frizzar":
      return executeFrizzarTool(tenant, toolCall, phoneNumber);
    case "bemp":
      return executeBempTool(tenant, toolCall, phoneNumber);
    case "zaylo":
      return executeZayloTool(tenant, toolCall, phoneNumber);
    case "appbarber":
      return executeAppBarberTool(tenant, toolCall, phoneNumber);
    case "none":
      return executeNoneTool(tenant, toolCall);
    default:
      return executeTrinksTool(tenant, toolCall, phoneNumber);
  }
}

async function readResponsePayload(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function getCustomToolRequestError(response: Response, payload: any): string | null {
  if (payload && typeof payload === "object") {
    if (payload.error) return String(payload.error);
    if (payload.success === false && payload.message) return String(payload.message);
  }

  if (response.ok) return null;
  if (typeof payload === "string" && payload.trim()) return payload.trim();
  return `HTTP ${response.status}`;
}

async function fetchUazChatDetails(uazapiUrl: string, uazapiToken: string, phoneNumber: string): Promise<{ response: Response; payload: any }> {
  const response = await fetch(`${uazapiUrl}/chat/details`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "token": uazapiToken },
    body: JSON.stringify({ number: phoneNumber }),
  });
  const payload = await readResponsePayload(response);
  return { response, payload };
}

function chatHasLabel(chatDetailsPayload: any, labelId: string): boolean {
  const normalizedLabelId = String(labelId);
  const fullLabelSuffix = `:${normalizedLabelId}`;
  const labels = Array.isArray(chatDetailsPayload?.wa_label) ? chatDetailsPayload.wa_label : [];

  return labels.some((value: any) => {
    const raw = String(value ?? "");
    return raw === normalizedLabelId || raw.endsWith(fullLabelSuffix);
  });
}

// ===================== CRM LEAD UPSERT =====================

async function upsertCrmLead(
  supabaseClient: any,
  tenantId: string,
  phoneNumber: string,
  labelId: string,
  labelName?: string,
  changedBy: string = "ai",
): Promise<void> {
  try {
    // Check if this label is a flag (not a funnel stage) by reading tenant kanban_columns
    const { data: tenant } = await supabaseClient
      .from("tenants")
      .select("kanban_columns")
      .eq("id", tenantId)
      .single();

    const kanbanColumns: any[] = Array.isArray(tenant?.kanban_columns) ? tenant.kanban_columns : [];
    const columnConfig = kanbanColumns.find((c: any) => String(c.label_id) === String(labelId));
    const isFlag = columnConfig?.type === "flag";

    // Get existing lead
    const { data: existing } = await supabaseClient
      .from("crm_leads")
      .select("id, label_id, flag_labels")
      .eq("tenant_id", tenantId)
      .eq("phone_number", phoneNumber)
      .maybeSingle();

    if (isFlag) {
      // FLAG label: add to flag_labels array, don't change funnel label_id
      const currentFlags: string[] = existing?.flag_labels || [];
      if (!currentFlags.includes(String(labelId))) {
        const newFlags = [...currentFlags, String(labelId)];
        if (existing) {
          await supabaseClient
            .from("crm_leads")
            .update({ flag_labels: newFlags, updated_at: new Date().toISOString() })
            .eq("id", existing.id);
        } else {
          // Create lead with flag but no funnel stage yet
          await supabaseClient
            .from("crm_leads")
            .insert({
              tenant_id: tenantId,
              phone_number: phoneNumber,
              label_id: "__none__",
              label_name: null,
              flag_labels: newFlags,
              updated_at: new Date().toISOString(),
            });
        }
        console.log(`[CRM] Flag ${labelId} added to ${phoneNumber}`);
      } else {
        console.log(`[CRM] Flag ${labelId} already on ${phoneNumber}`);
      }
      return;
    }

    // FUNNEL label: change label_id (original behavior)
    const fromLabel = existing?.label_id || null;
    const leadId = existing?.id;

    const { data: upserted, error: upsertError } = await supabaseClient
      .from("crm_leads")
      .upsert(
        {
          tenant_id: tenantId,
          phone_number: phoneNumber,
          label_id: String(labelId),
          label_name: labelName || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "tenant_id,phone_number" }
      )
      .select("id")
      .single();

    if (upsertError) {
      console.error("[CRM] Upsert error:", upsertError.message);
      return;
    }

    const finalLeadId = upserted?.id || leadId;

    if (finalLeadId && fromLabel !== String(labelId)) {
      await supabaseClient.from("crm_lead_history").insert({
        lead_id: finalLeadId,
        from_label: fromLabel,
        to_label: String(labelId),
        changed_by: changedBy,
      });
      console.log(`[CRM] Lead ${phoneNumber} moved: ${fromLabel} → ${labelId} (by ${changedBy})`);
    } else {
      console.log(`[CRM] Lead ${phoneNumber} label unchanged: ${labelId}`);
    }
  } catch (err) {
    console.error("[CRM] upsertCrmLead error:", err);
  }
}

type EnsureLabelStateResult = {
  success: boolean;
  changed: boolean;
  already?: boolean;
  status?: number;
  error?: string;
  details?: any;
};

async function ensureChatLabelState(
  uazapiUrl: string,
  uazapiToken: string,
  phoneNumber: string,
  labelId: string,
  desiredState: "present" | "absent",
  logContext: string,
): Promise<EnsureLabelStateResult> {
  const shouldBePresent = desiredState === "present";

  // Use /chat/labels (plural) with add_labelid or remove_labelid — NOT the toggle endpoint
  const labelBody = shouldBePresent
    ? { number: phoneNumber, add_labelid: String(labelId) }
    : { number: phoneNumber, remove_labelid: String(labelId) };

  console.log(`[${logContext}] Label ${shouldBePresent ? "ADD" : "REMOVE"} attempt: POST /chat/labels`, JSON.stringify(labelBody));

  const res = await fetch(`${uazapiUrl}/chat/labels`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "token": uazapiToken },
    body: JSON.stringify(labelBody),
  });
  const resPayload = await readResponsePayload(res);
  console.log(`[${logContext}] Label result status: ${res.status} body:`, JSON.stringify(resPayload).slice(0, 300));

  if (!res.ok) {
    const errorMsg = getCustomToolRequestError(res, resPayload);
    return {
      success: false,
      changed: false,
      status: res.status,
      error: `Falha ao ${shouldBePresent ? "adicionar" : "remover"} etiqueta: ${errorMsg}`,
      details: resPayload,
    };
  }

  console.log(`[${logContext}] Label ${labelId} ${shouldBePresent ? "added" : "removed"} successfully`);
  return { success: true, changed: true, already: false, details: resPayload };
}

function buildCustomToolFilename(toolName: string, toolType: string, mediaUrl: string, contentType: string | null): string {
  try {
    const pathname = new URL(mediaUrl).pathname;
    const rawName = pathname.split("/").filter(Boolean).pop();
    if (rawName && rawName.includes(".")) {
      return rawName;
    }
  } catch {
    // fallback below
  }

  const normalizedContentType = String(contentType || "").split(";")[0].toLowerCase();
  const extensionByMime: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "application/pdf": "pdf",
  };
  const fallbackExtension = toolType === "send_image" ? "jpg" : toolType === "send_audio" ? "ogg" : "pdf";

  return `${toolName || "arquivo"}.${extensionByMime[normalizedContentType] || fallbackExtension}`;
}

async function executeCustomTool(tenant: any, toolDef: any, phoneNumber: string, toolArgs?: any): Promise<any> {
  const uazapiUrl = tenant.uazapi_url || Deno.env.get("UAZAPI_URL");
  const uazapiToken = tenant.uazapi_token || Deno.env.get("UAZAPI_TOKEN");
  const config = toolDef.config || {};
  const toolType = String(toolDef.type || "");
  const normalizedToolType = toolType
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");

  console.log(`[CustomTool] Executing ${toolDef.name} (${toolType} -> ${normalizedToolType}) for ${phoneNumber}`);

  if (!uazapiUrl || !uazapiToken) {
    return { error: "Instância WhatsApp não configurada para este tenant." };
  }

  if (!phoneNumber) {
    return { error: "Número do cliente ausente para executar a ferramenta." };
  }

  try {
    switch (normalizedToolType) {
      case "send_text":
      case "send_link": {
        const text = toolType === "send_link" ? (config.url || "") : (config.text || "");
        if (!text) return { error: "Texto/URL não configurado nesta ferramenta." };
        const res = await fetch(`${uazapiUrl}/send/text`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json", "token": uazapiToken },
          body: JSON.stringify({ number: phoneNumber, text, delay: 2000 }),
        });
        const data = await readResponsePayload(res);
        console.log(`[CustomTool] send_text result:`, JSON.stringify(data).slice(0, 200));
        const requestError = getCustomToolRequestError(res, data);
        if (requestError) {
          return { error: `Falha ao enviar mensagem: ${requestError}`, status: res.status, details: data };
        }
        return { success: true, message: `Enviado com sucesso`, type: toolType };
      }

      case "escalate_human": {
        const silentMode = config.silent_mode === true;
        if (!silentMode) {
          const clientText = config.text || "Vou transferir você para um atendente. Aguarde um momento! 🙋";
          const clientRes = await fetch(`${uazapiUrl}/send/text`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json", "token": uazapiToken },
            body: JSON.stringify({ number: phoneNumber, text: clientText, delay: 2000 }),
          });
          await readResponsePayload(clientRes);
        } else {
          console.log(`[EscalateHuman] Silent mode — skipping client message`);
        }

        const humanNumber = config.human_number;
        if (humanNumber) {
          const motivo = toolArgs?.motivo || "Cliente solicitou atendimento humano";
          const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
          const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
          let lastClientMsg = "";
          try {
            const msgRes = await fetch(
              `${supabaseUrl}/rest/v1/chat_messages?tenant_id=eq.${tenant.id}&phone_number=eq.${phoneNumber}&role=eq.user&order=created_at.desc&limit=3`,
              { headers: { "apikey": serviceKey, "Authorization": `Bearer ${serviceKey}` } }
            );
            const msgs = await msgRes.json();
            if (Array.isArray(msgs) && msgs.length > 0) {
              lastClientMsg = msgs.map((m: any) => m.content).reverse().join("\n");
            }
          } catch (e) {
            console.error("[EscalateHuman] Error fetching last messages:", e);
          }

          const summaryText = `🚨 *Atendimento Escalado*\n\n` +
            `👤 *Cliente:* ${phoneNumber}\n` +
            `📋 *Motivo:* ${motivo}\n` +
            `💬 *Últimas mensagens:*\n${lastClientMsg || "(sem mensagens)"}`;

          await fetch(`${uazapiUrl}/send/text`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json", "token": uazapiToken },
            body: JSON.stringify({ number: humanNumber, text: summaryText, delay: 1000 }),
          });
          console.log(`[EscalateHuman] Summary sent to human ${humanNumber}`);
        }

        const labelId = config.label_id;
        if (labelId) {
          try {
            const labelResult = await ensureChatLabelState(uazapiUrl, uazapiToken, phoneNumber, String(labelId), "present", "EscalateHuman");
            if (!labelResult.success) {
              console.error(`[EscalateHuman] Error ensuring label ${labelId}: ${labelResult.error}`, JSON.stringify(labelResult.details ?? null).slice(0, 200));
            } else {
              console.log(`[EscalateHuman] Label ${labelId} ensured present (${labelResult.already ? "already present" : "changed"})`);
              // CRM upsert
              const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
              await upsertCrmLead(sb, tenant.id, phoneNumber, String(labelId), "Escalado Humano", "ai");
            }
          } catch (e) {
            console.error("[EscalateHuman] Error adding label:", e);
          }
        }

        return { success: true, message: `Atendimento escalado para humano`, type: toolType };
      }

      case "add_label": {
        const labelId = config.label_id;
        if (!labelId) return { error: "ID da etiqueta não configurado nesta ferramenta." };
        try {
          const labelResult = await ensureChatLabelState(uazapiUrl, uazapiToken, phoneNumber, String(labelId), "present", `CustomTool:add_label:${labelId}`);
          if (!labelResult.success) {
            return { error: labelResult.error || "Falha ao adicionar etiqueta.", status: labelResult.status, details: labelResult.details };
          }
          // CRM upsert
          const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
          await upsertCrmLead(sb, tenant.id, phoneNumber, String(labelId), toolDef.display_name || toolDef.name, "ai");
          return {
            success: true,
            message: labelResult.already ? `Etiqueta ${labelId} já estava no contato` : `Etiqueta ${labelId} adicionada ao contato`,
            type: toolType,
          };
        } catch (e) {
          console.error("[CustomTool] add_label error:", e);
          return { error: `Erro ao adicionar etiqueta: ${e.message}` };
        }
      }

      case "remove_label": {
        const labelId = config.label_id;
        if (!labelId) return { error: "ID da etiqueta não configurado nesta ferramenta." };
        try {
          const labelResult = await ensureChatLabelState(uazapiUrl, uazapiToken, phoneNumber, String(labelId), "absent", `CustomTool:remove_label:${labelId}`);
          if (!labelResult.success) {
            return { error: labelResult.error || "Falha ao remover etiqueta.", status: labelResult.status, details: labelResult.details };
          }
          return {
            success: true,
            message: labelResult.already ? `Etiqueta ${labelId} já não estava no contato` : `Etiqueta ${labelId} removida do contato`,
            type: toolType,
          };
        } catch (e) {
          console.error("[CustomTool] remove_label error:", e);
          return { error: `Erro ao remover etiqueta: ${e.message}` };
        }
      }

      case "send_image":
      case "send_audio":
      case "send_video":
      case "send_document": {
        const mediaUrl = config.url || "";
        if (!mediaUrl) return { error: "URL da mídia não configurada." };
        const mediaType = toolType === "send_audio" ? "ptt" : toolType === "send_image" ? "image" : toolType === "send_video" ? "video" : "document";

        const sendPayload: any = {
          number: phoneNumber,
          type: mediaType,
          file: mediaUrl,
          delay: toolType === "send_audio" ? 2000 : 1000,
        };
        if (config.caption) sendPayload.caption = config.caption;

        const res = await fetch(`${uazapiUrl}/send/media`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json", "token": uazapiToken },
          body: JSON.stringify(sendPayload),
        });
        const data = await readResponsePayload(res);
        console.log(`[CustomTool] send_media result:`, JSON.stringify(data).slice(0, 200));
        const requestError = getCustomToolRequestError(res, data);
        if (requestError) {
          return { error: `Falha ao enviar mídia: ${requestError}`, status: res.status, details: data };
        }
        return { success: true, message: `Mídia enviada com sucesso`, type: toolType };
      }

      case "send_location": {
        const lat = Number(config.latitude);
        const lng = Number(config.longitude);
        const locName = config.name || "";
        const locAddress = config.address || locName || "";
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { error: "Coordenadas não configuradas." };
        const res = await fetch(`${uazapiUrl}/send/location`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json", "token": uazapiToken },
          body: JSON.stringify({ number: phoneNumber, latitude: lat, longitude: lng, name: locName, address: locAddress }),
        });
        const data = await readResponsePayload(res);
        console.log(`[CustomTool] send_location result:`, JSON.stringify(data).slice(0, 200));
        const requestError = getCustomToolRequestError(res, data);
        if (requestError) {
          return { error: `Falha ao enviar localização: ${requestError}`, status: res.status, details: data };
        }
        return { success: true, message: `Localização enviada com sucesso`, type: toolType };
      }

      case "send_pix": {
        const pixType = String(config.pix_type || "").toUpperCase();
        const pixKey = String(config.pix_key || "").trim();
        const validTypes = ["CPF", "CNPJ", "PHONE", "EMAIL", "EVP"];
        if (!pixKey) return { error: "Chave PIX não configurada." };
        if (!validTypes.includes(pixType)) return { error: `Tipo de chave PIX inválido. Use: ${validTypes.join(", ")}` };
        const pixPayload: any = { number: phoneNumber, pixType, pixKey };
        if (config.pix_name) pixPayload.pixName = config.pix_name;
        if (config.merchant_name) pixPayload.merchantName = config.merchant_name;
        const res = await fetch(`${uazapiUrl}/send/pix-button`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json", "token": uazapiToken },
          body: JSON.stringify(pixPayload),
        });
        const data = await readResponsePayload(res);
        console.log(`[CustomTool] send_pix result:`, JSON.stringify(data).slice(0, 200));
        const requestError = getCustomToolRequestError(res, data);
        if (requestError) {
          return { error: `Falha ao enviar botão PIX: ${requestError}`, status: res.status, details: data };
        }
        return { success: true, message: `Botão PIX enviado com sucesso`, type: toolType };
      }

      case "send_contact": {
        const fullName = String(config.contact_full_name || "").trim();
        const contactPhone = String(config.contact_phone || "").replace(/\D/g, "");
        const organization = String(config.contact_organization || "").trim();
        if (!fullName) return { error: "Nome do contato não configurado. Não tente novamente — peça ao admin configurar.", blocked: true };
        if (!contactPhone) return { error: "Telefone do contato não configurado. Não tente novamente — peça ao admin configurar.", blocked: true };
        const contactBody: any = { number: phoneNumber, fullName, phoneNumber: contactPhone };
        if (organization) contactBody.organization = organization;
        const res = await fetch(`${uazapiUrl}/send/contact`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json", "token": uazapiToken },
          body: JSON.stringify(contactBody),
        });
        const data = await readResponsePayload(res);
        console.log(`[CustomTool] send_contact result:`, JSON.stringify(data).slice(0, 200));
        const requestError = getCustomToolRequestError(res, data);
        if (requestError) {
          return { error: `Falha ao enviar contato: ${requestError}`, status: res.status, details: data };
        }
        return { success: true, message: `Contato enviado com sucesso`, type: toolType };
      }

      case "send_combo": {
        const comboItems = config.combo_items;
        if (!Array.isArray(comboItems) || comboItems.length === 0) {
          return { error: "Nenhum item configurado no combo." };
        }
        const results: any[] = [];
        for (const item of comboItems) {
          const itemConfig = item.config || {};
          const itemType = item.type;
          let res: Response;
          let sendPayload: any;

          switch (itemType) {
            case "text": {
              if (!itemConfig.text) { results.push({ type: "text", skipped: true }); continue; }
              res = await fetch(`${uazapiUrl}/send/text`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Accept": "application/json", "token": uazapiToken },
                body: JSON.stringify({ number: phoneNumber, text: itemConfig.text, delay: 2000 }),
              });
              break;
            }
            case "image":
            case "audio":
            case "video":
            case "document": {
              if (!itemConfig.url) { results.push({ type: itemType, skipped: true }); continue; }
              const mediaType = itemType === "audio" ? "ptt" : itemType === "video" ? "video" : itemType === "image" ? "image" : "document";
              sendPayload = { number: phoneNumber, type: mediaType, file: itemConfig.url, delay: itemType === "audio" ? 2000 : 1000 };
              if (itemConfig.caption) sendPayload.caption = itemConfig.caption;
              res = await fetch(`${uazapiUrl}/send/media`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Accept": "application/json", "token": uazapiToken },
                body: JSON.stringify(sendPayload),
              });
              break;
            }
            case "location": {
              const lat = Number(itemConfig.latitude);
              const lng = Number(itemConfig.longitude);
              if (!Number.isFinite(lat) || !Number.isFinite(lng)) { results.push({ type: "location", skipped: true }); continue; }
              res = await fetch(`${uazapiUrl}/send/location`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Accept": "application/json", "token": uazapiToken },
                body: JSON.stringify({ number: phoneNumber, latitude: lat, longitude: lng, name: itemConfig.name || "", address: itemConfig.address || "" }),
              });
              break;
            }
            default:
              results.push({ type: itemType, skipped: true, reason: "unknown type" });
              continue;
          }
          const data = await readResponsePayload(res!);
          const err = getCustomToolRequestError(res!, data);
          results.push({ type: itemType, success: !err, error: err || undefined });
          console.log(`[CustomTool] combo item ${itemType} result:`, err || "ok");
          // Small delay between sends to avoid rate limits
          await new Promise(r => setTimeout(r, 800));
        }
        const sent = results.filter(r => r.success).length;
        const failed = results.filter(r => r.error).length;
        return { success: failed === 0, message: `Combo: ${sent} enviado(s)${failed ? `, ${failed} falha(s)` : ""}`, details: results };
      }

      default:
        return { error: `Tipo de ferramenta desconhecido: ${toolType || "(vazio)"} (${normalizedToolType || "inválido"})` };
    }
  } catch (error) {
    console.error(`[CustomTool] Error executing ${toolDef.name}:`, error);
    return { error: `Erro ao executar ferramenta: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// ===================== MESSAGE SPLITTING =====================

function splitIntoMessages(text: string): string[] {
  // Step 1: split by double newlines (paragraphs)
  const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(p => p.length > 0);
  
  // Step 2: for each paragraph, split by sentence-ending punctuation (.!?) 
  // but keep sentences grouped if they're short (under 80 chars together)
  const parts: string[] = [];
  for (const para of paragraphs) {
    // Split by sentence boundaries: after . ! ? followed by space or end
    const sentences = para.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
    if (sentences.length <= 1) {
      parts.push(para);
      continue;
    }
    let current = "";
    for (const sentence of sentences) {
      if (current.length === 0) {
        current = sentence;
      } else if ((current + " " + sentence).length < 120) {
        current += " " + sentence;
      } else {
        parts.push(current.trim());
        current = sentence;
      }
    }
    if (current.trim().length > 0) parts.push(current.trim());
  }
  
  return parts.length > 0 ? parts : [text];
}

// ===================== PHONE HELPERS =====================

function extractRemoteJid(payload: any, msg: any): string | undefined {
  const candidates = [
    payload.phone, payload.from, payload.remoteJid, payload.sender, payload.senderId,
    payload.chat?.remoteJid, payload.chat?.from, payload.chat?.jid,
    payload.data?.remoteJid, msg.remoteJid, msg.from, msg.phone,
    msg.key?.remoteJid, msg.key?.participant,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return undefined;
}

function normalizePhoneNumber(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw || /^https?:\/\//i.test(raw)) return null;
  const jidMatch = raw.match(/(\d{10,15})@(s\.whatsapp\.net|c\.us)$/i);
  if (jidMatch) return jidMatch[1];
  const digits = raw.replace(/\D/g, "");
  if (digits.length >= 10 && digits.length <= 15) return digits;
  return null;
}

function normalizePhoneForTrinks(phoneNumber: string): string {
  let tel = phoneNumber.replace(/\D/g, "");
  if (tel.startsWith("55") && tel.length >= 12) tel = tel.substring(2);
  const ddd = tel.substring(0, 2);
  let rest = tel.substring(2);
  if (rest.length === 8) rest = "9" + rest;
  return ddd + rest;
}

function isAffirmativeReply(value: string): boolean {
  const raw = value.trim();
  if (["👍", "👍🏻", "👍🏼", "👍🏽", "👍🏾", "👍🏿", "✅"].includes(raw)) return true;

  const normalized = normalizeUserFacingText(raw);
  if (!normalized) return false;

  return /^(sim|s|ok|okay|pode|pode sim|isso|isso mesmo|confirmo|confirmado|certo|beleza|perfeito|sim pode|pode cancelar|sim pode cancelar)$/.test(normalized);
}

function getLastAssistantMessage(history: { role: string; content: string }[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message?.role === "assistant" && typeof message.content === "string" && message.content.trim()) {
      return message.content.trim();
    }
  }
  return null;
}

function extractSingleTimeReference(value: string): string | null {
  const matches = (String(value || "").match(/\b\d{1,2}[:h]\d{2}\b/g) || [])
    .map((token) => token.toLowerCase().replace("h", ":"))
    .map((token) => {
      const [hours, minutes] = token.split(":");
      return `${String(hours || "").padStart(2, "0")}:${String(minutes || "").padStart(2, "0")}`;
    });
  const unique = [...new Set(matches)];
  return unique.length === 1 ? unique[0] : null;
}

function isBookingTimeConfirmationPrompt(value: string): boolean {
  const normalized = normalizeUserFacingText(value);
  if (!normalized) return false;
  return /\b(posso confirmar|pode ser esse horario|pode ser esse horario pro|pode ser esse horario para|pode ser esse|esse horario serve|serve esse horario|fechou nesse horario|confirmando)\b/.test(normalized);
}

function isSingleCancellationConfirmationPrompt(value: string): boolean {
  const normalized = normalizeUserFacingText(value);
  if (!normalized.includes("quer cancelar")) return false;
  const words = new Set(normalized.split(" "));
  return words.has("esse") || words.has("esta") || words.has("este");
}

async function fetchActiveAppointmentsByPhone(tenant: any, phoneNumber: string) {
  if (!tenant?.trinks_api_key || !tenant?.trinks_establishment_id || !phoneNumber) return [];

  const baseUrl = "https://api.trinks.com/v1";
  const headers: Record<string, string> = {
    "X-Api-Key": tenant.trinks_api_key,
    "Accept": "application/json",
    "estabelecimentoId": tenant.trinks_establishment_id,
  };

  try {
    const tel = normalizePhoneForTrinks(phoneNumber);
    const cliRes = await fetch(`${baseUrl}/clientes?telefone=${tel}`, { headers });
    const cliData = await cliRes.json();
    const cliList = cliData?.data || cliData;
    if (!Array.isArray(cliList) || cliList.length === 0) return [];

    const ownerId = cliList[0].id || cliList[0].Id;
    const agRes = await fetch(`${baseUrl}/agendamentos?clienteId=${ownerId}`, { headers });
    const agData = await agRes.json();
    const agList = Array.isArray(agData?.data) ? agData.data : [];
    const activeStatuses = ["confirmado", "aguardando confirmação", "aguardando confirmacao"];

    return agList
      .filter((a: any) => {
        const statusName = String(a.status?.nome || "").toLowerCase();
        return activeStatuses.some((status) => statusName === status || statusName.includes(status));
      })
      .map((a: any) => ({
        id: a.id,
        status: a.status?.nome,
        servico: a.servico?.nome,
        profissional: a.profissional?.nome,
        clienteId: a.cliente?.id,
        dataHoraInicio: a.dataHoraInicio,
      }));
  } catch (error) {
    console.error("fetchActiveAppointmentsByPhone error:", error);
    return [];
  }
}

async function maybeHandleDirectCancellationConfirmation(
  tenant: any,
  phoneNumber: string,
  history: { role: string; content: string }[],
  userMessage: string,
): Promise<string | null> {
  if (!isAffirmativeReply(userMessage)) return null;

  const lastAssistantMessage = getLastAssistantMessage(history);
  if (!lastAssistantMessage || !isSingleCancellationConfirmationPrompt(lastAssistantMessage)) {
    return null;
  }

  const activeAgendamentos = await fetchActiveAppointmentsByPhone(tenant, phoneNumber);
  console.log(
    `Direct cancel confirmation detected for ${phoneNumber}: ${activeAgendamentos.length} active appointment(s)`,
  );

  if (activeAgendamentos.length === 0) {
    return "Não encontrei esse agendamento. Pode já ter sido cancelado.";
  }

  if (activeAgendamentos.length > 1) {
    return "Encontrei mais de um agendamento ativo. Me diz qual deles você quer cancelar.";
  }

  const target = activeAgendamentos[0];
  const cancelResult = await executeTrinksTool(
    tenant,
    {
      function: {
        name: "cancelar_agendamento",
        arguments: JSON.stringify({
          agendamentoId: target.id,
          motivo: "Solicitação do cliente",
        }),
      },
    },
    phoneNumber,
  );

  console.log("Direct cancel confirmation result:", JSON.stringify(cancelResult).slice(0, 500));

  if (cancelResult?.success) {
    return "✅ Cancelado! Se precisar remarcar, é só falar.";
  }

  if (cancelResult?.status === 404) {
    return "Não encontrei esse agendamento. Pode já ter sido cancelado.";
  }

  if (cancelResult?.status === 405) {
    return "Esse agendamento já foi realizado e não pode ser cancelado.";
  }

  return "Tive um probleminha aqui. Pode tentar novamente?";
}

function extractPhoneNumber(payload: any, msg: any): { phone: string; source: string } | null {
  const directCandidates: Array<[string, unknown]> = [
    ["payload.phone", payload.phone], ["payload.from", payload.from],
    ["payload.remoteJid", payload.remoteJid], ["payload.sender", payload.sender],
    ["payload.senderId", payload.senderId], ["payload.chat.phone", payload.chat?.phone],
    ["payload.chat.number", payload.chat?.number], ["payload.chat.whatsapp", payload.chat?.whatsapp],
    ["payload.chat.whatsappNumber", payload.chat?.whatsappNumber],
    ["payload.chat.phoneNumber", payload.chat?.phoneNumber],
    ["payload.chat.contactPhone", payload.chat?.contactPhone],
    ["payload.chat.customerPhone", payload.chat?.customerPhone],
    ["payload.chat.lead_phone", payload.chat?.lead_phone],
    ["payload.chat.leadPhone", payload.chat?.leadPhone],
    ["payload.chat.lead_whatsapp", payload.chat?.lead_whatsapp],
    ["payload.data.phone", payload.data?.phone],
    ["msg.phone", msg.phone], ["msg.from", msg.from],
    ["msg.remoteJid", msg.remoteJid], ["msg.key.remoteJid", msg.key?.remoteJid],
  ];
  for (const [source, candidate] of directCandidates) {
    const normalized = normalizePhoneNumber(candidate);
    if (normalized) return { phone: normalized, source };
  }
  const keyPattern = /(phone|number|whatsapp|remotejid|jid|from|sender|contact|lead)/i;
  const visited = new WeakSet<object>();
  const queue: Array<{ path: string; value: unknown }> = [
    { path: "payload", value: payload }, { path: "msg", value: msg },
  ];
  while (queue.length) {
    const current = queue.shift();
    if (!current?.value || typeof current.value !== "object") continue;
    const objectValue = current.value as Record<string, unknown>;
    if (visited.has(objectValue)) continue;
    visited.add(objectValue);
    const entries = Object.entries(objectValue).sort(([a], [b]) => {
      return Number(keyPattern.test(b)) - Number(keyPattern.test(a));
    });
    for (const [key, value] of entries) {
      const path = `${current.path}.${key}`;
      if (value && typeof value === "object") { queue.push({ path, value }); continue; }
      const normalized = normalizePhoneNumber(value);
      if (!normalized) continue;
      if (keyPattern.test(key)) return { phone: normalized, source: path };
      if (typeof value === "string" && /@(s\.whatsapp\.net|c\.us)$/i.test(value)) {
        return { phone: normalized, source: path };
      }
    }
  }
  return null;
}

// ===================== DATE/TIME HELPERS =====================

function getBrasiliaDate(): {
  dateComplete: string; todayName: string; todayDate: string;
  year: number; month: number; day: number; hours: number; minutes: number;
  timeHHMM: string; periodOfDay: string; greeting: string;
  dayType: string; todayDateBR: string;
} {
  const now = new Date();
  const brFormatter = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const parts = brFormatter.formatToParts(now);
  const get = (type: string) => parts.find(p => p.type === type)?.value || "0";
  const year = parseInt(get("year"));
  const month = parseInt(get("month"));
  const day = parseInt(get("day"));
  const hours = parseInt(get("hour"));
  const minutes = parseInt(get("minute"));
  const seconds = parseInt(get("second"));

  const dateComplete = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  const todayDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const todayDateBR = `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;

  const brDate = new Date(Date.UTC(year, month - 1, day));
  const dow = brDate.getUTCDay();
  const dayNames = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
  const todayName = dayNames[dow];

  const timeHHMM = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  let periodOfDay: string;
  let greeting: string;
  if (hours >= 0 && hours < 6) { periodOfDay = "madrugada"; greeting = "boa madrugada"; }
  else if (hours < 12) { periodOfDay = "manhã"; greeting = "bom dia"; }
  else if (hours < 18) { periodOfDay = "tarde"; greeting = "boa tarde"; }
  else { periodOfDay = "noite"; greeting = "boa noite"; }
  const dayType = (dow === 0 || dow === 6) ? "fim de semana" : "dia útil";

  return { dateComplete, todayName, todayDate, year, month, day, hours, minutes, timeHHMM, periodOfDay, greeting, dayType, todayDateBR };
}

// Format phone (e.g. "5561983012868" -> "+55 (61) 98301-2868" + DDD region hint)
function formatPhoneForPrompt(raw: string): string {
  const digits = String(raw || "").replace(/\D+/g, "");
  if (!digits) return raw || "";
  // DDD region hints (resumo das principais regiões)
  const dddRegions: Record<string, string> = {
    "11": "São Paulo/SP (capital)", "12": "São José dos Campos/SP", "13": "Santos/SP", "14": "Bauru/SP", "15": "Sorocaba/SP", "16": "Ribeirão Preto/SP", "17": "São José do Rio Preto/SP", "18": "Presidente Prudente/SP", "19": "Campinas/SP",
    "21": "Rio de Janeiro/RJ (capital)", "22": "Campos/RJ", "24": "Volta Redonda/RJ",
    "27": "Vitória/ES", "28": "Cachoeiro/ES",
    "31": "Belo Horizonte/MG", "32": "Juiz de Fora/MG", "33": "Governador Valadares/MG", "34": "Uberlândia/MG", "35": "Poços de Caldas/MG", "37": "Divinópolis/MG", "38": "Montes Claros/MG",
    "41": "Curitiba/PR", "42": "Ponta Grossa/PR", "43": "Londrina/PR", "44": "Maringá/PR", "45": "Cascavel/PR", "46": "Pato Branco/PR",
    "47": "Joinville/SC", "48": "Florianópolis/SC", "49": "Chapecó/SC",
    "51": "Porto Alegre/RS", "53": "Pelotas/RS", "54": "Caxias do Sul/RS", "55": "Santa Maria/RS",
    "61": "Brasília/DF", "62": "Goiânia/GO", "63": "Palmas/TO", "64": "Rio Verde/GO", "65": "Cuiabá/MT", "66": "Rondonópolis/MT", "67": "Campo Grande/MS",
    "68": "Rio Branco/AC", "69": "Porto Velho/RO",
    "71": "Salvador/BA", "73": "Ilhéus/BA", "74": "Juazeiro/BA", "75": "Feira de Santana/BA", "77": "Vitória da Conquista/BA", "79": "Aracaju/SE",
    "81": "Recife/PE", "82": "Maceió/AL", "83": "João Pessoa/PB", "84": "Natal/RN", "85": "Fortaleza/CE", "86": "Teresina/PI", "87": "Petrolina/PE", "88": "Juazeiro do Norte/CE", "89": "Picos/PI",
    "91": "Belém/PA", "92": "Manaus/AM", "93": "Santarém/PA", "94": "Marabá/PA", "95": "Boa Vista/RR", "96": "Macapá/AP", "97": "Coari/AM", "98": "São Luís/MA", "99": "Imperatriz/MA",
  };
  // Normalize Brazilian numbers (with country code 55)
  let pretty = digits;
  let region = "";
  if (digits.length === 13 && digits.startsWith("55")) {
    const ddd = digits.slice(2, 4);
    const rest = digits.slice(4);
    pretty = `+55 (${ddd}) ${rest.slice(0, 5)}-${rest.slice(5)}`;
    region = dddRegions[ddd] || "";
  } else if (digits.length === 12 && digits.startsWith("55")) {
    const ddd = digits.slice(2, 4);
    const rest = digits.slice(4);
    pretty = `+55 (${ddd}) ${rest.slice(0, 4)}-${rest.slice(4)}`;
    region = dddRegions[ddd] || "";
  } else if (digits.length === 11) {
    const ddd = digits.slice(0, 2);
    const rest = digits.slice(2);
    pretty = `(${ddd}) ${rest.slice(0, 5)}-${rest.slice(5)}`;
    region = dddRegions[ddd] || "";
  }
  return region ? `${pretty} — DDD ${region}` : pretty;
}

// Format a minute gap as "Xh YYmin" or "Ymin"
function formatGapMinutes(mins: number | null): string {
  if (mins == null || !Number.isFinite(mins) || mins < 0) return "primeira mensagem (sem gap anterior)";
  if (mins < 1) return "menos de 1 minuto";
  if (mins < 60) return `${Math.round(mins)} min`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  if (h < 24) return m > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
}

// ===================== SYSTEM PROMPT =====================

function buildSystemPrompt(
  tenant: any,
  phoneNumber: string,
  provider: string,
  senderName?: string,
  leadName?: string,
  explicitClientName?: string | null,
  lastClientGapMinutes?: number | null,
  aiSummary?: string,
  aiSummaryUpdatedAt?: string | null,
  simulatorMode?: boolean,
  recentCompletedActions?: AgentSessionState["recentCompletedActions"],
  recentAssistantReplies?: AgentSessionState["recentAssistantReplies"],
  temporalContext?: {
    lastClientAtISO?: string | null;
    lastAssistantAtISO?: string | null;
    lastHumanAtISO?: string | null;
    lastClientGapMinutes?: number | null;
    lastAssistantGapMinutes?: number | null;
    lastHumanGapMinutes?: number | null;
  },
  providerPromptOverride?: string | null,
): string {
  const br = getBrasiliaDate();
  const dateComplete = br.dateComplete;
  const todayName = br.todayName;
  const todayDate = br.todayDate;
  const customPrompt = tenant.agent_system_prompt || "";
  const knowledgeBase = tenant.agent_knowledge_base || "";

  // ===== CLIENT IDENTITY — explicit > CRM > (pushName as weak hint only) =====
  // WhatsApp pushName is just display metadata and must never be used for cadastro
  // nem para se dirigir ao cliente.
  const rawName = (explicitClientName && explicitClientName.trim()) || (leadName && leadName.trim()) || "";
  const cleanedName = sanitizeClientName(rawName);
  const isUsable = isUsableClientName(cleanedName);
  const firstName = isUsable ? cleanedName.split(/\s+/)[0] : "";

  const rawSender = (senderName || "").trim();
  const cleanedSender = sanitizeClientName(rawSender);
  const senderUsable = isUsableClientName(cleanedSender);
  const senderDisplay = rawSender
    ? (senderUsable ? cleanedSender : `${rawSender} (inválido — emojis/símbolos/números)`)
    : "(não disponível)";

  const phonePretty = formatPhoneForPrompt(phoneNumber);
  const gapStr = formatGapMinutes(lastClientGapMinutes ?? null);

  // ===== TEMPORAL CONTEXT (this interaction) =====
  const fmtBR = (iso?: string | null): string => {
    if (!iso) return "—";
    try {
      const parts = new Intl.DateTimeFormat("pt-BR", {
        timeZone: "America/Sao_Paulo",
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit", hour12: false,
      }).formatToParts(new Date(iso));
      const g = (t: string) => parts.find((p) => p.type === t)?.value || "";
      return `${g("day")}/${g("month")}/${g("year")} ${g("hour")}:${g("minute")}`;
    } catch { return "—"; }
  };
  const sameCalendarDayAsToday = (iso?: string | null): boolean => {
    if (!iso) return true;
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Sao_Paulo",
        year: "numeric", month: "2-digit", day: "2-digit",
      }).formatToParts(new Date(iso));
      const g = (t: string) => parts.find((p) => p.type === t)?.value || "";
      return `${g("year")}-${g("month")}-${g("day")}` === `${br.year}-${String(br.month).padStart(2, "0")}-${String(br.day).padStart(2, "0")}`;
    } catch { return true; }
  };
  const tc = temporalContext || {};
  const gapClient = tc.lastClientGapMinutes ?? lastClientGapMinutes ?? null;
  const gapAssistant = tc.lastAssistantGapMinutes ?? null;
  const gapHuman = tc.lastHumanGapMinutes ?? null;
  const lastClientStr = `${fmtBR(tc.lastClientAtISO)} (gap: ${formatGapMinutes(gapClient ?? null)})`;
  const lastAssistantStr = tc.lastAssistantAtISO ? `${fmtBR(tc.lastAssistantAtISO)} (gap: ${formatGapMinutes(gapAssistant ?? null)})` : "—";
  const lastHumanStr = tc.lastHumanAtISO ? `${fmtBR(tc.lastHumanAtISO)} (gap: ${formatGapMinutes(gapHuman ?? null)})` : "—";
  // NOVA SESSÃO: gap do cliente ≥ 8h OU última troca (cliente/humano/IA) em dia calendário diferente de hoje
  const lastAnyISO = [tc.lastClientAtISO, tc.lastAssistantAtISO, tc.lastHumanAtISO]
    .filter(Boolean)
    .sort()
    .pop() || null;
  const isNewSession = (gapClient != null && gapClient >= 8 * 60) || (lastAnyISO != null && !sameCalendarDayAsToday(lastAnyISO));
  const temporalBlock = `## ⏰ ESTADO TEMPORAL DESTA INTERAÇÃO
- Agora (Brasília): ${br.todayDateBR} ${br.timeHHMM} (${br.todayName})
- Última mensagem do cliente antes desta: ${lastClientStr}
- Última mensagem sua (IA): ${lastAssistantStr}
- Última mensagem do atendente humano: ${lastHumanStr}
- Status da sessão: ${isNewSession ? "🆕 NOVA SESSÃO (gap ≥ 8h ou dia calendário diferente — NÃO continue o assunto antigo automaticamente)" : "▶️ CONTINUAÇÃO (mesmo dia, gap < 8h)"}
`;

  const identityBlock = `## 👤 IDENTIDADE DO CLIENTE
- Telefone: ${phonePretty}
- Nome confirmado pelo cliente NESTA conversa: ${explicitClientName && explicitClientName.trim() ? explicitClientName.trim() : "(vazio)"}
- Nome no CRM/cadastro do estabelecimento: ${leadName && leadName.trim() ? leadName.trim() : "(não cadastrado)"}
- Nome exibido no WhatsApp (pushName): ${senderDisplay}
- Nome a usar nas mensagens: ${isUsable ? firstName : "NÃO use nome — atenda de forma neutra, sem gírias de gênero"}

Regras de uso do nome:
- Prioridade: nome confirmado pelo cliente > nome do CRM > nenhum. NUNCA use o pushName do WhatsApp para se dirigir ao cliente nem para cadastrar — ele é só metadado.
- Se houver nome válido, use o PRIMEIRO NOME quando soar natural (ex: "Oi, ${firstName || "Fulano"}!"). Não force em toda mensagem.
- Use o nome válido para inferir gênero conforme as regras do prompt do estabelecimento.
- Se NÃO houver nome válido e o cliente perguntar "você sabe meu nome?", você pode (opcionalmente) citar o pushName apenas como dica e PEDIR CONFIRMAÇÃO (ex: "Vi um '${senderUsable ? cleanedSender : "—"}' aqui, é você mesmo?"). NUNCA assuma como verdadeiro.
- O telefone acima já está identificado — o cliente NÃO precisa informar telefone em buscas/agendamentos.
`;

  const humanAttendantBlock = `\n## 🧑‍💼 MENSAGENS DO ATENDENTE HUMANO\nNo histórico, mensagens com role "assistant" que começam com o prefixo \`[ATENDENTE HUMANO]:\` foram enviadas MANUALMENTE pelo dono/atendente da empresa (pelo app ou direto pelo WhatsApp), NÃO por você.\n\nRegras quando isso aparece:\n- Trate o conteúdo como contexto verdadeiro e já realizado pelo humano (ex: confirmações, avisos, combinados).\n- NÃO repita ações que o humano já fez. Ex: se o atendente humano enviou "Confirma seu agendamento de hoje 19h?" e o cliente respondeu "Sim", você NÃO deve criar um novo agendamento — apenas continue a conversa naturalmente (ex: "Perfeito, te esperamos!").\n- Antes de chamar qualquer ferramenta de criar/cancelar/editar agendamento, verifique se o atendente humano já tratou o assunto na conversa recente.\n- Mensagens "assistant" SEM esse prefixo foram enviadas por você (IA) — pode considerar como suas.\n\n🚨 PROIBIDO TERMINANTEMENTE: NUNCA, em hipótese alguma, inclua na sua resposta ao cliente os marcadores internos \`[ATENDENTE HUMANO]\`, \`[ATENDENTE HUMANO]:\`, \`[SISTEMA]\`, \`[SYSTEM]\`, \`[INTERNO]\`, \`[CONTEXTO]\` ou qualquer outro rótulo entre colchetes que apareça no histórico. Esses marcadores são APENAS para SEU uso interno de leitura — o cliente NUNCA deve vê-los. Sua resposta deve ser sempre uma mensagem natural, limpa, sem prefixos técnicos. Se precisar referenciar algo que o atendente humano disse, parafraseie em linguagem natural (ex: "como combinamos", "como te avisamos") — JAMAIS copie o texto com o prefixo.\n\n🚨🚨 PROIBIDO COPIAR/REPRODUZIR O CONTEÚDO DE MENSAGENS [ATENDENTE HUMANO]:\n- NUNCA copie, reescreva ou "imite" o TEXTO de uma mensagem \`[ATENDENTE HUMANO]:\` na sua resposta. Mesmo sem o prefixo, é PROIBIDO reenviar o conteúdo dele.\n- NUNCA envie LEMBRETES DE CONFIRMAÇÃO DE AGENDAMENTO (ex: "Olá Fulano, você possui um agendamento com X em DD/MM às HH:MM" + link). Lembretes/confirmações são responsabilidade do sistema externo do estabelecimento, NÃO sua. Você NUNCA gera esse tipo de mensagem por conta própria.\n- NUNCA reenvie URLs/links de confirmação (ex: cashbarber.com.br/.../confirmacao/...) que tenham aparecido no histórico. Esses links são únicos por agendamento e foram enviados pelo humano/sistema — repetir é ERRO GRAVE.\n- NUNCA reenvie nomes de profissionais, horários ou valores que você só conhece porque viu numa mensagem \`[ATENDENTE HUMANO]:\` anterior — esses dados podem estar desatualizados.\n- Você só envia UMA resposta por vez, focada na ÚLTIMA mensagem do cliente. NÃO concatene várias "mensagens fantasma" copiando frases curtas do histórico do atendente (ex: "👍🏻", "Eu que agradeço", "Boa tarde", "😉"). Se a resposta natural é curta, mande curta.\n- Se você não tem informação NOVA e legítima a enviar agora, responda apenas o necessário à última mensagem do cliente — NUNCA "complete" com trechos que pareçam plausíveis tirados do histórico.\n`;

  // ===== PERSISTENT CLIENT SUMMARY (cross-conversation memory) =====
  const summaryText = (aiSummary || "").trim();
  const summaryAgeStr = aiSummaryUpdatedAt ? formatGapMinutes(Math.round((Date.now() - new Date(aiSummaryUpdatedAt).getTime()) / 60000)) : null;
  const summaryBlock = summaryText
    ? `\n## 🗂️ RESUMO/JORNADA DESTE CLIENTE (memória persistente)\n${summaryText}\nAtualizado há: ${summaryAgeStr || "—"}\n\nUse este resumo ATIVAMENTE para personalizar o atendimento (ex: "Vai querer o de sempre?", "Como cliente do clube..."). Mas NUNCA leia em voz alta o resumo nem cite que existe um "perfil" — é só conhecimento seu.\n→ Quando o cliente revelar algo NOVO e duradouro (serviço favorito, plano, profissional preferido, frequência, restrição, observação útil), chame a ferramenta \`atualizar_resumo_cliente\` com o resumo INTEIRO reescrito (curto, até ~600 chars). NÃO acumule; consolide.\n`
    : `\n## 🗂️ RESUMO/JORNADA DESTE CLIENTE (memória persistente)\n(cliente novo / ainda sem resumo — colete informações naturalmente ao longo da conversa)\n\nQuando perceber algo relevante e duradouro sobre o cliente (serviço favorito, plano/assinatura, profissional preferido, frequência típica, restrições, observações úteis para futuros atendimentos), chame a ferramenta \`atualizar_resumo_cliente\` com um resumo CURTO em PT-BR (até ~600 caracteres). NUNCA cite ao cliente que está montando um perfil.\n`;

  const simulatorBlock = simulatorMode
    ? `\n## 🧪 MODO SIMULADOR (TESTE INTERNO)\nVocê está respondendo dentro do simulador do painel do dono da empresa. Comporte-se EXATAMENTE como responderia ao cliente final no WhatsApp — não mencione que está em simulador, não mude o tom, não saia do personagem. Ferramentas de escrita (criar/cancelar/editar agendamento, cadastrar cliente, atualizar resumo, enviar mídia) são interceptadas e retornam "simulado" — siga a conversa como se tivessem dado certo.\n`
    : "";

  // ===== AÇÕES RECENTES CONCLUÍDAS (ledger global anti-duplicação) =====
  const recentActionsList = (recentCompletedActions || []).filter((a) => {
    const t = Date.parse(a.completedAt);
    return Number.isFinite(t) && (Date.now() - t) < 30 * 60 * 1000;
  });
  const recentActionsBlock = recentActionsList.length === 0
    ? ""
    : `\n## ✅ AÇÕES JÁ EXECUTADAS NESTA CONVERSA (últimos 30 min)\n${recentActionsList
        .slice(-8)
        .map((a) => {
          const minAgo = Math.max(0, Math.round((Date.now() - Date.parse(a.completedAt)) / 60000));
          return `- há ${minAgo} min — ${a.summary}`;
        })
        .join("\n")}\n\n🚨 REGRA CRÍTICA: Você JÁ executou as ações acima. NÃO chame de novo a mesma ferramenta com os mesmos parâmetros. Se a próxima mensagem do cliente for confirmação ("sim", "ok", "valeu"), agradecimento, o NOME do cliente, um emoji ou um comentário curto — apenas responda em texto natural. NÃO interprete isso como pedido para repetir uma ação já feita. Só execute uma ferramenta mutável de novo se o cliente pedir EXPLICITAMENTE algo NOVO ou DIFERENTE (ex.: outro horário, outro dia, outro serviço, outra pessoa).\n`;

  // ===== ÚLTIMAS RESPOSTAS DA IA (anti-repetição de texto) =====
  const recentRepliesList = (recentAssistantReplies || []).filter((r) => {
    const t = Date.parse(r.at);
    return Number.isFinite(t) && (Date.now() - t) < 30 * 60 * 1000;
  });
  const recentRepliesBlock = recentRepliesList.length === 0
    ? ""
    : `\n## 🔁 SUAS ÚLTIMAS RESPOSTAS NESTA CONVERSA (não repita)\n${recentRepliesList
        .slice(-5)
        .map((r) => {
          const minAgo = Math.max(0, Math.round((Date.now() - Date.parse(r.at)) / 60000));
          const preview = r.text.length > 220 ? r.text.slice(0, 220) + "…" : r.text;
          return `- há ${minAgo} min: "${preview}"`;
        })
        .join("\n")}\n\n🚨 REGRA CRÍTICA DE NÃO-REPETIÇÃO:\n- NÃO reenvie nenhuma das mensagens acima, nem uma versão parafraseada com o mesmo conteúdo.\n- Você NÃO é obrigada a responder toda mensagem do cliente. Se o cliente mandou várias mensagens fragmentadas que tratam do MESMO assunto que você acabou de responder, ou se a nova mensagem não traz pergunta/informação nova (ex: emoji solto, "ok", "entendi", "valeu", "kkk", uma mensagem quebrada repetindo o que ele já disse), responda APENAS se houver algo realmente novo a acrescentar. Caso contrário, devolva uma STRING VAZIA — o sistema simplesmente não envia nada, como uma pessoa real que não fica respondendo cada balão.\n- Se o cliente fez 2 ou 3 perguntas que basicamente pedem a mesma coisa, una tudo em UMA resposta nova — nunca repita um bloco que já mandou.\n- Antes de escrever, pergunte-se: "isso é diferente do que eu acabei de mandar?". Se a resposta for não, fique em silêncio (string vazia).\n`;


  const shortDayNames = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
  const fullDayNames = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
  const nextDaysMap: string[] = [];
  for (let i = 0; i <= 14; i++) {
    const futureDate = new Date(Date.UTC(br.year, br.month - 1, br.day + i));
    const dow = futureDate.getUTCDay();
    const fmtDate = `${futureDate.getUTCFullYear()}-${String(futureDate.getUTCMonth() + 1).padStart(2, '0')}-${String(futureDate.getUTCDate()).padStart(2, '0')}`;
    const label = i === 0 ? "HOJE" : i === 1 ? "AMANHÃ" : "";
    nextDaysMap.push(`  - ${fullDayNames[dow]} = ${fmtDate}${label ? ` (${label})` : ""}`);
  }

  const basePrompt = `Você é a assistente virtual de agendamento do estabelecimento "${tenant.name || "nosso estabelecimento"}".

## 🌐 IDIOMA E FORMATO DA RESPOSTA (REGRA ABSOLUTA)
- TODA resposta enviada ao cliente DEVE ser em PORTUGUÊS BRASILEIRO. NUNCA responda em inglês ou em qualquer outro idioma.
- NUNCA escreva texto de raciocínio, planejamento ou notas internas no campo de resposta. Frases como "Vou proceed", "Need next user input", "Let me check", "I will now", "Thinking:", "Okay,", "Plan:", "Step 1" são PROIBIDAS.
- 🚫 NUNCA escreva meta-comentários, observações de status ou notas entre parênteses sobre a própria conversa. Frases como "(Mensagem duplicada acima)", "(Sem resposta)", "(Repetido)", "(Aguardando cliente)", "(Sem alteração)", "(Continua igual)", "(Mesma mensagem)", "(Já enviado)", "(Sem novidades)" são ABSOLUTAMENTE PROIBIDAS. Se não tiver nada novo a dizer, NÃO ENVIE NADA — devolva uma string vazia.
- NUNCA comente sobre mensagens anteriores, repetições ou estado da conversa. Apenas converse naturalmente como uma pessoa real no WhatsApp.
- Sempre que você for responder ao cliente, escreva uma mensagem natural, curta e em português, como se fosse uma pessoa real conversando no WhatsApp.
- Se você acabou de executar ferramentas (ex: enviar imagens, adicionar etiqueta), AINDA ASSIM você DEVE escrever uma mensagem natural em português ao cliente logo em seguida — nunca termine sem texto, nunca devolva texto telegráfico em inglês, nunca devolva meta-comentário entre parênteses.

${temporalBlock}
## ⏰ CONTEXTO TEMPORAL (LEIA ANTES DE QUALQUER RESPOSTA)
- AGORA são **${br.timeHHMM}** da **${br.periodOfDay}** — ${todayName}, ${br.todayDateBR} (${br.dayType})
- Data ISO de hoje: ${todayDate} | Data/hora completa Brasília: ${dateComplete}
- Gap desde a última mensagem do cliente: ${gapStr}
- 📌 Cada mensagem do histórico abaixo vem com um prefixo INTERNO \`[DD/MM HH:MM]\` indicando quando foi enviada (Brasília). Use isso para raciocinar sobre o tempo entre as trocas e para detectar virada de dia/semana. NUNCA escreva esse prefixo na sua resposta ao cliente.
- Calendário dos próximos 14 dias (CONSULTE SEMPRE ANTES DE RESPONDER):
${nextDaysMap.join("\n")}

🚨 REGRA GLOBAL — VIRADA DE DIA / CONVERSA ANTIGA (APLICA-SE A TODAS AS BARBEARIAS):
Antes de QUALQUER resposta, compare "Agora" do bloco "ESTADO TEMPORAL DESTA INTERAÇÃO" com a data da última troca real (cliente, IA ou atendente humano).
- Se o "Status da sessão" estiver marcado como 🆕 NOVA SESSÃO (gap ≥ 8h OU dia calendário diferente de hoje):
  • NÃO dê continuidade automática ao assunto da conversa anterior. NÃO reconfirme agendamento que estava sendo combinado, NÃO retome a escolha de horário/serviço pendente, NÃO reenvie link/PIX/valor que já tinha sido oferecido em dia anterior.
  • Trate a mensagem atual como uma NOVA interação: cumprimento curto adequado ao período (use a regra de saudação) + pergunte como pode ajudar AGORA. Aja como uma pessoa real que retoma o WhatsApp depois de horas/dias sem responder.
  • Se a mensagem atual referenciar claramente o assunto antigo (ex: "pode confirmar aquele horário?", "fechado então?"), você DEVE REVALIDAR via ferramentas — reconsultar disponibilidade/preço/cadastro/agendamento ANTES de prometer qualquer coisa. Horários, valores e ofertas mencionados em dias anteriores estão EXPIRADOS e podem não valer mais.
  • Se a última mensagem foi sua (IA) ou do atendente humano e ficou DIAS sem resposta, NÃO "complete" o assunto antigo nem cobre o cliente; comece do zero, educadamente.
- Em QUALQUER caso (nova sessão ou continuação): referências relativas ("hoje", "amanhã", "sexta") presentes em mensagens antigas do histórico (prefixo de outro dia) são INVÁLIDAS para a conversa de hoje. Só vale data ABSOLUTA. Se precisar reusar, traduza para a referência relativa correta em relação ao "Agora".



🚨 REGRA DE SAUDAÇÃO (CRÍTICA — NÃO QUEBRE):
- Saudação correta para o período de AGORA (CASO precise saudar): "${br.greeting}".
- ⛔ **NÃO cumprimente em toda mensagem.** Saudação ("bom dia/boa tarde/boa noite/olá/oi/e aí") só é permitida em UMA situação: a PRIMEIRA resposta de um NOVO atendimento — ou seja, NÃO existe histórico anterior nesta conversa, OU o gap acima é maior que 8 horas.
- Se já existe histórico recente (gap ≤ 8h) ou você já cumprimentou antes nesta conversa, NUNCA inicie a mensagem com "bom dia", "boa tarde", "boa noite", "olá", "oi" ou variações. Vá DIRETO ao assunto, como uma pessoa real no WhatsApp.
- Se o cliente mandar uma saudação no meio da conversa (ex: "boa tarde" quando já estão conversando), NÃO devolva outra saudação — apenas continue o atendimento (ex: "opa, tudo bem? então, sobre o seu corte...").
- A saudação "${br.greeting}" indicada acima existe APENAS para garantir o período correto QUANDO saudar for permitido. Ela NÃO é uma ordem para saudar.

🚨 REGRA DE USO DE CONTEXTO (CRÍTICA — LEIA COM ATENÇÃO):
As informações acima (hora atual, período do dia, data, dia da semana, saudação adequada) E as informações da base de conhecimento (horário de funcionamento, nome do estabelecimento, endereço, etc.) são CONTEXTO INTERNO PARA VOCÊ — NÃO são roteiro de mensagem.
- ⛔ NUNCA informe horário de funcionamento, endereço, telefone, nome do estabelecimento, hora atual ou data de hoje de forma PROATIVA. Só mencione quando o cliente PERGUNTAR explicitamente ou quando for ESTRITAMENTE necessário para responder.
- ⛔ NUNCA diga frases como "hoje funcionamos das 9 às 19", "estamos abertos até X", "nosso horário é..." a menos que o cliente tenha PERGUNTADO sobre horário de funcionamento.
- ✅ Use o horário de funcionamento INTERNAMENTE para decidir se aceita/recusa um horário pedido pelo cliente, mas sem citá-lo se não foi perguntado. Ex: cliente pede "20h", se fecha às 19h, responda algo como "20h a gente já não pega, posso te encaixar mais cedo?" — não precisa recitar a tabela inteira.
- ✅ Só diga "já fechamos / estamos fechados / ainda abertos" se o cliente perguntar isso diretamente. Caso contrário, apenas conduza o atendimento normalmente.
- Comparação interna: se AGORA < fechamento de hoje → ainda está aberto. Se cliente pedir horário FUTURO de hoje, só recuse se for DEPOIS do fechamento.
- Se o "Status da sessão" for 🆕 NOVA SESSÃO, releia o histórico (cada mensagem traz prefixo \`[DD/MM HH:MM]\`) e siga a "REGRA GLOBAL — VIRADA DE DIA / CONVERSA ANTIGA" antes de assumir que "amanhã"/"hoje" antigos do cliente ainda valem.

REGRA GERAL: dados de contexto (nome do cliente, hora, período, horário de funcionamento) servem para VOCÊ entender a situação. Use só o mínimo necessário na resposta — fale como uma pessoa real no WhatsApp, não como um robô recitando informações.



🚨 REGRA CRÍTICA DE DATAS — NUNCA QUEBRE ESTA REGRA:
1. NUNCA diga uma data sem antes consultar o calendário acima.
2. Quando o cliente disser um dia da semana (ex: "sexta"), encontre a PRÓXIMA ocorrência no calendário acima e use a data EXATA correspondente.
3. Quando mencionar uma data para o cliente, SEMPRE confirme que o dia da semana corresponde à data no calendário. Ex: se sexta = 2026-04-17, diga "sexta, dia 17" e NUNCA "sexta, dia 20".
4. Se não tiver certeza, NÃO invente. Consulte o calendário.
5. "Amanhã" = ${nextDaysMap.length > 1 ? nextDaysMap[1].split("=")[1].trim().split(" ")[0] : "dia seguinte"}.
6. Ao usar ferramentas de agendamento, use SEMPRE o formato YYYY-MM-DD extraído do calendário.

🚨 REGRA CRÍTICA DE CONTINUIDADE DE CONVERSA (NUNCA QUEBRE):
A conversa pode ter ficado parada por horas ou dias. ANTES de falar qualquer coisa relacionada a data/horário, PARE e faça este raciocínio interno:
  a) Qual é a data REAL de hoje? (use ${todayDate})
  b) Qual data o cliente está REALMENTE pedindo? Quando o cliente disse "amanhã" ou "hoje" em mensagens ANTIGAS do histórico, aquela referência era relativa à data daquela mensagem — NÃO à data de hoje. Não assuma que "amanhã" mencionado anteriormente ainda é amanhã.
  c) Se o "Status da sessão" for 🆕 NOVA SESSÃO (mensagem do cliente em outro dia/semana) e ele retomar dizendo "vamos confirmar?", NÃO reuse a referência relativa antiga e NÃO assuma que o horário ainda está disponível. Releia o histórico (use o prefixo \`[DD/MM HH:MM]\` de cada mensagem) para descobrir a DATA ABSOLUTA combinada, REVALIDE via ferramentas e só então traduza para a referência relativa CORRETA em relação a hoje.
  d) Em caso de DÚVIDA sobre qual dia o cliente quer, PERGUNTE antes de buscar/agendar/cancelar. Ex: "Só pra confirmar, o agendamento é pra hoje mesmo, né?"
NUNCA chame ferramentas de buscar/agendar/cancelar/confirmar com uma data que você não tem 100% de certeza.

🚨🚨 REGRA DE PRIVACIDADE DA DATA — USO ESTRITAMENTE INTERNO 🚨🚨
A data e o calendário acima são para SEU USO INTERNO de raciocínio APENAS.
NUNCA escreva ao cliente datas em nenhum formato (dd/mm, dd/mm/aaaa, "dia 25", "dia 25/04", "25 de abril", "amanhã, dia X", etc.).
Sempre use referências relativas: "amanhã", "hoje", "sexta", "na próxima semana", "no próximo sábado", "no dia que você prefere".

❌ ERROS REAIS QUE JÁ ACONTECERAM E QUE VOCÊ NÃO PODE REPETIR:
  ❌ "Você quer agendar pra amanhã, dia 25/04?"
  ❌ "Posso confirmar pra sexta, dia 17?"
  ❌ "Hoje é sábado, dia 12."
  ❌ "Confirmando: corte na quinta, 23/04."

✅ FORMA CORRETA:
  ✅ "Você quer agendar pra amanhã?"
  ✅ "Posso confirmar pra sexta?"
  ✅ "Pra qual dia você prefere?"
  ✅ "Confirmando: corte na quinta. Pode ser?"

Exceção única: se o cliente PERGUNTAR EXPLICITAMENTE a data ("que dia é hoje?", "amanhã é dia quantos?"), aí você pode informar.

------------------------------------------

${identityBlock}
${summaryBlock}
${recentActionsBlock}
${recentRepliesBlock}
${simulatorBlock}
${humanAttendantBlock}
------------------------------------------




## 🎯 TOM DE VOZ

- Fale como um humano: informal, direto, simpático
- Use emojis com moderação
- Mensagens CURTAS (máximo 2-3 linhas por mensagem)
- Nada de "Olá! Como posso ajudá-lo hoje?"
- Se o cliente já disse o que quer, vá direto ao ponto

------------------------------------------

## 🚫 O QUE NUNCA FAZER

🔴 REGRA MÁXIMA — NUNCA EXPONHA INFORMAÇÕES INTERNAS AO CLIENTE:
- NUNCA mencione IDs (servicosId, profissionalId, agendasId, clienteId, etc.) — o cliente NÃO deve saber que existem
- NUNCA mencione nomes de ferramentas (buscar_servicos, buscar_barbeiros, agendar, etc.)
- NUNCA diga que está "consultando", "buscando", "verificando no sistema" ou qualquer processo interno
- NUNCA revele que é IA, robô, assistente virtual ou chatbot
- NUNCA use linguagem técnica/robótica ("processando", "solicitação", "aguarde enquanto verifico")
- NUNCA coloque nomes de serviços entre aspas (escreva corte normal, NÃO "Corte Normal")

❌ EXEMPLOS PROIBIDOS (NUNCA DIGA ISSO):
  ❌ "Para Corte Normal, temos a opção com o servicosId 2461"
  ❌ "Vou buscar os horários disponíveis"
  ❌ "Consultando o sistema..."
  ❌ "O profissionalId do João é 40658"
  ❌ "Então é segunda-feira, dia 13, né?" (reconfirmação desnecessária)
  ❌ "Hoje é sábado e agora são 15h"

✅ EXEMPLOS CORRETOS:
  ✅ "Corte normal com o João na segunda, né? Qual horário fica bom?"
  ✅ "Esses são os horários disponíveis: 9h, 10h, 14h, 15h"
  ✅ "Agendado! Te esperamos segunda às 15h!"

🔴 REGRA — NÃO RECONFIRME, PROSSIGA:
- Se o cliente JÁ disse serviço + barbeiro + dia, NÃO pergunte de novo. Execute as ferramentas silenciosamente e vá direto para o próximo passo pendente.
- Exemplo: cliente diz "corte com João na segunda" → execute buscar_servicos, buscar_barbeiros, buscar_datas, buscar_horarios em sequência e APRESENTE OS HORÁRIOS direto.

Outras proibições:
- Inventar horários, preços ou informações
- Mencionar duração, lavatório ou detalhes técnicos espontaneamente
- Listar barbeiros — pergunte se tem preferência
- Perguntar preferência de barbeiro mais de uma vez
- Repetir informações que o cliente já disse
- Listar horários sem saber o serviço primeiro
- Citar horários sem ter executado a ferramenta de horários nessa interação
- Agendar em horário fora da lista de horários
- Confirmar agendamento sem executar a ferramenta de agendar com sucesso
- Enviar duas mensagens seguidas com o mesmo conteúdo
- Repetir, transcrever ou citar entre aspas o que o cliente disse em áudio

------------------------------------------

## 🖼️ REGRA — IMAGENS ENVIADAS PELO CLIENTE

Quando o cliente envia uma imagem, você a enxerga internamente. Use essa informação como CONTEXTO, mas siga estas regras com RIGOR:

🔴 NUNCA descreva o que tem na imagem para o cliente (ex: "vi uma árvore rosa com flores e um lago"). O cliente já sabe o que mandou.
🔴 NUNCA pergunte "quer que eu responda agradecendo?" ou "quer que eu envie nossos horários?". Apenas responda direto.
🔴 NUNCA reaja emocionalmente à imagem ("que linda!", "muito bonita!") a menos que seja claramente relevante ao atendimento.

✅ COMO AGIR:
- Se a imagem for RELEVANTE ao agendamento (ex: foto de referência de corte/barba, comprovante de pagamento PIX, print de horário, foto do próprio cliente para visagismo) → comente brevemente APENAS o que importa pro atendimento e prossiga (ex: "Boa! Esse estilo a gente faz sim. Bora marcar?" ou "Recebi o comprovante, valeu! 👍").
- Se a imagem for ALEATÓRIA (paisagem, meme, foto de animal, figurinha, imagem decorativa, etc.) → IGNORE completamente o conteúdo visual e siga o atendimento normal conforme o prompt e a última intenção do cliente. Se não houver intenção pendente, responda algo curto e neutro como "Recebi! Posso te ajudar com algo? 😊" e pare por aí.
- NUNCA descreva a imagem em detalhes, NUNCA enumere o que viu, NUNCA pergunte qual reação o cliente quer.

### O QUE SEMPRE FAZER
- Usar "valor" ao invés de "custa"
- Buscar o cliente silenciosamente na primeira interação
- Consultar ferramentas para obter IDs — nunca inventar
- Falar de forma natural, como um atendente real falaria no WhatsApp
- Executar ferramentas silenciosamente — o cliente só vê o resultado final

------------------------------------------

## 🔶 REGRA ANTI-TEXTÃO

Mensagens longas são proibidas. Sempre curtas e em tom de conversa.

❌ "Olá! Para realizar o agendamento, você precisa me informar qual serviço deseja..."
✅ "Bora agendar? Seria corte e barba ou só corte?"

------------------------------------------

## 🔶 REGRA: NUNCA EXPLIQUE PROCESSOS INTERNOS

❌ "preciso confirmar o serviço para validar os horários"
❌ "vou consultar o sistema"
✅ "Seria corte, barba ou os dois?"
✅ "Esse tá ocupado. Tenho 12h ou 15h. Qual prefere?"

------------------------------------------

## 🆘 REGRA GLOBAL — FALHAS DE SISTEMA (NUNCA EXPONHA ERROS)

🔴 PROIBIDO TERMINANTEMENTE dizer ao cliente qualquer variação de:
- "Tive um problema ao consultar o sistema"
- "Desculpe, deu um erro"
- "Estou com instabilidade / fora do ar / lento / com falha"
- "O sistema falhou / travou / não respondeu"
- "Tente novamente em alguns minutos"
- Qualquer menção a "API", "servidor", "sistema", "erro", "bug", "falha técnica", status HTTP, ou nome de ferramenta.

✅ COMO AGIR quando uma ferramenta falhar, retornar erro, instabilidade, timeout, ou você não conseguir concluir o que o cliente pediu:
1. Se existir a ferramenta de escalar humano (ex: escalate_human), chame-a IMEDIATAMENTE com um motivo curto.
2. Responda ao cliente APENAS com algo no espírito de: "Só um instante, vou avisar o responsável pra te atender por aqui 🙏" (pode variar a frase, mas mantenha o tom: tranquilo, sem culpa, sem mencionar erro).
3. NÃO tente refazer a operação várias vezes nem prossiga o fluxo de agendamento depois disso — pare e aguarde o humano.

Toda barbearia tem um responsável humano disponível. Quando algo não funciona, você SEMPRE escala — você NUNCA admite falha técnica ao cliente.

------------------------------------------

## 🎯 APRESENTAÇÃO INICIAL

Antes de responder, analise a mensagem do cliente e identifique o que ele JÁ disse:
- Serviço mencionado? → pule a pergunta de serviço
- Barbeiro mencionado? → pule a pergunta de barbeiro
- Dia mencionado? → pule a pergunta de dia

**SÓ PERGUNTE O QUE O CLIENTE NÃO DISSE.**`;

  // Provider-specific prompt sections
  let providerPrompt = "";

  if (typeof providerPromptOverride === "string" && providerPromptOverride.trim().length > 0) {
    providerPrompt = providerPromptOverride;
  } else if (provider === "trinks") {
    providerPrompt = buildTrinksPromptSection(tenant);
  } else if (provider === "onebeleza") {
    providerPrompt = buildOneBelezaPromptSection(tenant);
  } else if (provider === "frizzar") {
    providerPrompt = buildFrizzarPromptSection(tenant);
  } else if (provider === "bemp") {
    providerPrompt = buildBempPromptSection(tenant);
  } else if (provider === "zaylo") {
    providerPrompt = buildZayloPromptSection(tenant);
  } else if (provider === "appbarber") {
    providerPrompt = buildAppBarberPromptSection(tenant);
  } else if (provider === "none") {
    providerPrompt = buildNonePromptSection(tenant);
  }

  const customSection = customPrompt ? `\nINSTRUÇÕES ADICIONAIS DO ESTABELECIMENTO:\n${customPrompt}` : "";
  const knowledgeSection = knowledgeBase ? `\nBASE DE CONHECIMENTO:\n${knowledgeBase}` : "";

  // Inject custom tools instructions
  const enabledCustomTools = getEnabledCustomTools(tenant);
  let customToolsSection = "";
  if (enabledCustomTools.length > 0) {
    const toolInstructions = enabledCustomTools.map((ct: any) =>
      `- **${ct.display_name}** (ferramenta: ${ct.name}): ${ct.prompt_instruction}`
    ).join("\n");
    customToolsSection = `\n\n------------------------------------------\n\n## 🔧 FERRAMENTAS CUSTOMIZADAS\n\nVocê tem acesso às seguintes ferramentas extras. Use conforme as instruções:\n\n${toolInstructions}\n\n⚠️ Quando usar uma ferramenta customizada, a mensagem/mídia será enviada DIRETAMENTE ao cliente. Após executar, confirme ao cliente que enviou (ex: "Enviei a localização!" ou "Mandei a chave PIX!"). NÃO repita o conteúdo da ferramenta na mensagem de texto.`;
  }

  // providerPrompt vai por ÚLTIMO para sobrescrever instruções conflitantes do prompt customizado (ex.: tenant que descreve a API em texto cru)
  return basePrompt + "\n\n" + customSection + knowledgeSection + customToolsSection + "\n\n" + providerPrompt;
}

// ===================== TRINKS PROMPT SECTION =====================


// ===================== ONE BELEZA PROMPT SECTION =====================


// ===================== NONE PROMPT SECTION =====================



// ===================== TRINKS TOOLS =====================

function buildTrinksTools(tenant: any) {
  if (!tenant.trinks_api_key || !tenant.trinks_establishment_id) return undefined;

  return [
    {
      type: "function",
      function: {
        name: "buscar_cliente",
        description: "Busca um cliente pelo telefone. Use SEMPRE como primeira ação para verificar se o cliente existe. Se retornar totalRecords: 0 ou data: [] → cliente não existe, usar cadastrar_cliente. Se retornar dados → guardar o id do cliente.",
        parameters: {
          type: "object",
          properties: {
            telefone: { type: "string", description: "Telefone do cliente (DDD+número, sem código do país)" },
          },
          required: ["telefone"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "cadastrar_cliente",
        description: "Cadastra um novo cliente no sistema Trinks. Use quando buscar_cliente retornar vazio (cliente não existe). Envie o nome do cliente e o telefone.",
        parameters: {
          type: "object",
          properties: {
            nome: { type: "string", description: "Nome do cliente" },
            telefone: { type: "string", description: "Telefone completo do cliente (com DDD)" },
          },
          required: ["nome", "telefone"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "listar_profissionais",
        description: "Lista todos os profissionais/barbeiros do estabelecimento. Retorna lista com: id, nome, apelido.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: "listar_servicos",
        description: "Lista todos os serviços disponíveis no estabelecimento. Retorna lista com: id, nome, descricao, categoria, duracaoEmMinutos, preco.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: "listar_servicos_profissional",
        description: "Lista os serviços que um profissional específico realiza. SOMENTE PARA CONSULTA. O ID retornado NÃO deve ser usado como profissionalId no criar_agendamento. Para profissionalId, use EXCLUSIVAMENTE listar_profissionais.",
        parameters: {
          type: "object",
          properties: {
            profissionalId: { type: "integer", description: "ID numérico do profissional (obtido de listar_profissionais)" },
          },
          required: ["profissionalId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "listar_horarios",
        description: "Lista os horários disponíveis dos profissionais em uma data. Retorna lista de profissionais com seus horariosVagos. Use APENAS horariosVagos, IGNORE intervalosVagos.",
        parameters: {
          type: "object",
          properties: {
            data: { type: "string", description: "Data no formato YYYY-MM-DD" },
            servicoDuracao: { type: "integer", description: "Duração do serviço em minutos (obtido de listar_servicos)" },
          },
          required: ["data", "servicoDuracao"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "buscar_agendamento",
        description: "Busca os agendamentos de um cliente. Pode passar clienteId OU telefone (o sistema resolve automaticamente). Se retornar data: [] → cliente não tem agendamentos. Guardar o id do agendamento para cancelar ou editar.",
        parameters: {
          type: "object",
          properties: {
            clienteId: { type: "integer", description: "ID do cliente (obtido de buscar_cliente). Opcional se telefone for informado." },
            telefone: { type: "string", description: "Telefone do cliente. Se informado, o sistema busca o clienteId automaticamente." },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "criar_agendamento",
        description: "Cria um agendamento para o cliente. ⚠️ SÓ EXECUTE DEPOIS QUE O CLIENTE CONFIRMAR EXPLICITAMENTE (respondeu 'sim', 'ok', 'pode', etc.). NUNCA execute logo após o cliente escolher um horário — primeiro mostre o resumo e AGUARDE confirmação. ANTES de usar, DEVE ter: clienteId, servicoId, duracaoEmMinutos, valor (de listar_servicos), profissionalId (de listar_profissionais), dataHoraInicio no formato YYYY-MM-DDTHH:mm:ss.",
        parameters: {
          type: "object",
          properties: {
            servicoId: { type: "integer", description: "ID do serviço" },
            clienteId: { type: "integer", description: "ID do cliente" },
            profissionalId: { type: "integer", description: "ID do profissional" },
            dataHoraInicio: { type: "string", description: "Data e hora no formato YYYY-MM-DDTHH:mm:ss" },
            duracaoEmMinutos: { type: "integer", description: "Duração em minutos" },
            valor: { type: "number", description: "Valor do serviço" },
          },
          required: ["servicoId", "clienteId", "profissionalId", "dataHoraInicio", "duracaoEmMinutos", "valor"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "cancelar_agendamento",
        description: "Cancela um agendamento. Use SOMENTE agendamentoId real vindo de buscar_agendamento na interação atual. Se o cliente pedir 'os 2', 'ambos' ou 'todos', chame esta ferramenta uma vez para cada ID real. Se a ferramenta retornar code='agendamento_id_invalido', reutilize imediatamente os IDs de agendamentosAtivos.",
        parameters: {
          type: "object",
          properties: {
            agendamentoId: { type: "integer", description: "ID real do agendamento (obtido de buscar_agendamento na interação atual)" },
            motivo: { type: "string", description: "Motivo do cancelamento" },
          },
          required: ["agendamentoId", "motivo"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "editar_agendamento",
        description: "Edita/remarca um agendamento existente. ANTES de usar, DEVE ter: agendamentoId (de buscar_agendamento), e os novos dados. Resposta vazia = sucesso.",
        parameters: {
          type: "object",
          properties: {
            agendamentoId: { type: "integer", description: "ID do agendamento (obtido de buscar_agendamento)" },
            servicoId: { type: "integer", description: "ID do serviço" },
            clienteId: { type: "integer", description: "ID do cliente" },
            profissionalId: { type: "integer", description: "ID do profissional" },
            dataHoraInicio: { type: "string", description: "Nova data e hora no formato YYYY-MM-DDTHH:mm:ss" },
            duracaoEmMinutos: { type: "integer", description: "Duração em minutos" },
            valor: { type: "number", description: "Valor do serviço" },
          },
          required: ["agendamentoId", "servicoId", "clienteId", "profissionalId", "dataHoraInicio", "duracaoEmMinutos", "valor"],
        },
      },
    },
  ];
}

// ===================== ONE BELEZA TOOLS =====================

function buildOneBelezaTools(tenant: any) {
  if (!tenant.onebeleza_token || !tenant.onebeleza_celular) return undefined;

  return [
    {
      type: "function",
      function: {
        name: "buscar_cliente",
        description: "Busca um cliente pelo telefone. Use SEMPRE como primeira ação. Se retornar vazio → cliente não existe, usar cadastrar_cliente.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: "cadastrar_cliente",
        description: "Cadastra um novo cliente. Use quando buscar_cliente retornar vazio. Envie apenas o nome do cliente.",
        parameters: {
          type: "object",
          properties: {
            nome: { type: "string", description: "Nome do cliente" },
          },
          required: ["nome"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "buscar_servicos",
        description: "Lista todos os serviços disponíveis separados por grupos. Retorna servicoId necessário para os próximos passos.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: "buscar_horarios_disponiveis",
        description: "🔥 FERRAMENTA OTIMIZADA: para uma data + serviço, retorna TODOS os profissionais habilitados E seus horários disponíveis em UMA ÚNICA chamada. Substitui buscar_barbeiros_por_servico + buscar_datas_disponiveis + buscar_horarios. Use SEMPRE após buscar_servicos. Resposta inclui disponibilidades[].profissionalId + disponibilidades[].horarios[].horarioInicio/horarioFinal.",
        parameters: {
          type: "object",
          properties: {
            date: { type: "string", description: "Data no formato YYYY-MM-DD" },
            servicoId: { type: "string", description: "ID do serviço retornado por buscar_servicos (campo servicosId)" },
          },
          required: ["date", "servicoId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "agendar",
        description: "Cria o agendamento. ⚠️ SÓ EXECUTE APÓS CONFIRMAÇÃO DO CLIENTE. Use os nomes EXATOS dos parâmetros: dataNumero, servicoid, profissionalId, horarioInicio, horarioFim.",
         parameters: {
           type: "object",
           properties: {
             dataNumero: { type: "string", description: "Data no formato YYYY-MM-DD" },
             servicoid: { type: "string", description: "ID numérico do serviço — campo 'servicosId' retornado por BUSCAR SERVIÇOS" },
             profissionalId: { type: "string", description: "ID numérico do profissional — retornado por BUSCAR_BARBEIROS_POR_SERVICO" },
             horarioInicio: { type: "string", description: "Horário início no formato HH:MM:SS — retornado por BUSCAR HORÁRIOS" },
             horarioFim: { type: "string", description: "Horário fim no formato HH:MM:SS — retornado por BUSCAR HORÁRIOS" },
           },
           required: ["dataNumero", "servicoid", "profissionalId", "horarioInicio", "horarioFim"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "buscar_agendamentos_dia",
        description: "Busca todos os agendamentos de um dia específico. Útil para confirmação e lembretes.",
        parameters: {
          type: "object",
          properties: {
            date: { type: "string", description: "Data no formato YYYY-MM-DD" },
          },
          required: ["date"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "confirmar_agendamento",
        description: "Confirma um agendamento existente.",
        parameters: {
          type: "object",
          properties: {
            agendasId: { type: "string", description: "ID do agendamento a confirmar" },
          },
          required: ["agendasId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "desmarcar_agendamento",
        description: "Desmarca/cancela um agendamento existente.",
        parameters: {
          type: "object",
          properties: {
            agendasId: { type: "string", description: "ID do agendamento a desmarcar" },
          },
          required: ["agendasId"],
        },
      },
    },
  ];
}

// ===================== NONE TOOLS =====================

function buildNoneTools(_tenant: any) {
  // Provider "none" não usa ferramentas. O link de agendamento é enviado
  // diretamente no texto da resposta, conforme regra do system prompt.
  return undefined;
}

// ===================== TRINKS TOOL EXECUTION =====================

// 🚨 TRAVAS TRINKS (in-process, sobrevivem entre invocações warm)
// Cache de IDs válidos de profissionais por tenant (TTL 30min) — bloqueia IDs alucinados (ex.: 1, 1001).
const trinksKnownProfs = new Map<string, { ids: Set<number>; fetchedAt: number }>();
// Cache da última `listar_horarios` por conversa — { data, slotsByProf: prof->Set<HH:MM> }
// Bloqueia `criar_agendamento` em horário/data fora do que foi efetivamente consultado.
const trinksLastListed = new Map<string, { data: string; slotsByProf: Map<number, Set<string>>; listedAt: number }>();
const TRINKS_CACHE_TTL_MS = 30 * 60 * 1000;

async function executeTrinksTool(tenant: any, toolCall: any, phoneNumber?: string): Promise<any> {
  const funcName = toolCall.function.name;
  let args: any = {};
  try { args = JSON.parse(toolCall.function.arguments || "{}"); } catch { /* empty */ }

  const baseUrl = "https://api.trinks.com/v1";
  const headers: Record<string, string> = {
    "X-Api-Key": tenant.trinks_api_key,
    "Accept": "application/json",
    "estabelecimentoId": tenant.trinks_establishment_id,
  };

  try {
    switch (funcName) {
      case "buscar_cliente": {
        let tel = (args.telefone || "").replace(/\D/g, "");
        if (tel.startsWith("55") && tel.length >= 12) tel = tel.substring(2);
        const ddd = tel.substring(0, 2);
        let rest = tel.substring(2);
        if (rest.length === 8) rest = "9" + rest;
        tel = ddd + rest;

        const url = `${baseUrl}/clientes?telefone=${tel}`;
        console.log(`buscar_cliente URL: ${url}`);
        const res = await fetch(url, { headers });
        const text = await res.text();
        console.log(`buscar_cliente response (${res.status}):`, text.slice(0, 500));
        try { return JSON.parse(text); } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "cadastrar_cliente": {
        let tel = (args.telefone || "").replace(/\D/g, "");
        // Remove DDI 55 repetidamente (cobre casos com "55" duplicado vindos do WhatsApp/AI)
        while (tel.startsWith("55") && tel.length > 11) tel = tel.substring(2);
        // Remove zero à esquerda do DDD (ex.: "035...")
        while (tel.startsWith("0") && tel.length > 11) tel = tel.substring(1);

        const ddd = tel.substring(0, 2);
        let numero = tel.substring(2);
        // Garante 9º dígito para celulares brasileiros
        if (numero.length === 8) numero = "9" + numero;

        if (!ddd || ddd.length !== 2 || numero.length !== 9) {
          const err = `Telefone inválido após normalização: original="${args.telefone}", ddd="${ddd}", numero="${numero}". Esperado DDD(2) + numero(9, iniciando em 9).`;
          console.error(`cadastrar_cliente ${err}`);
          return { error: err };
        }

        const body = {
          nome: args.nome,
          telefones: [{ ddi: "55", ddd, numero, tipoId: 1 }],
        };
        console.log("cadastrar_cliente body:", JSON.stringify(body));
        const res = await fetch(`${baseUrl}/clientes`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        console.log(`cadastrar_cliente response (${res.status}):`, text.slice(0, 500));
        try { return JSON.parse(text); } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "listar_profissionais": {
        const res = await fetch(`${baseUrl}/profissionais`, { headers });
        const data = await res.json();
        const list = data?.data || data;
        if (Array.isArray(list)) {
          const mapped = list.map((p: any) => ({
            id: p.id || p.Id,
            nome: p.nome || p.Nome,
            apelido: p.apelido || p.Apelido,
          }));
          // Popula cache de IDs válidos para travar alucinação em criar_agendamento.
          const ids = new Set<number>(mapped.map((p: any) => Number(p.id)).filter((n: number) => Number.isFinite(n)));
          trinksKnownProfs.set(tenant.id, { ids, fetchedAt: Date.now() });
          console.log(`[Trinks] cache profs atualizado: tenant=${tenant.id} ids=${[...ids].join(",")}`);
          return mapped;
        }
        return data;
      }

      case "listar_servicos": {
        const res = await fetch(`${baseUrl}/servicos?somenteVisiveisCliente=true`, { headers });
        const data = await res.json();
        const list = data?.data || data;
        if (Array.isArray(list)) {
          return list.map((s: any) => ({
            id: s.id || s.Id,
            nome: s.nome || s.Nome,
            descricao: s.descricao || s.Descricao || "",
            preco: s.preco || s.Preco || s.valor || s.Valor,
            duracaoEmMinutos: s.duracaoEmMinutos || s.DuracaoEmMinutos || s.duracao,
            categoria: s.categoria || s.Categoria,
          }));
        }
        return data;
      }

      case "listar_servicos_profissional": {
        const profId = args.profissionalId;
        const res = await fetch(`${baseUrl}/profissionais/${profId}/servicos`, { headers });
        const data = await res.json();
        const list = data?.data || data;
        if (Array.isArray(list)) {
          return list.map((s: any) => ({
            id: s.id || s.Id,
            nome: s.nome || s.Nome,
            duracaoEmMinutos: s.duracaoEmMinutos || s.DuracaoEmMinutos || s.duracao,
            preco: s.preco || s.Preco || s.valor || s.Valor,
          }));
        }
        return data;
      }

      case "listar_horarios": {
        const url = `${baseUrl}/agendamentos/profissionais/${args.data}?servicoDuracao=${args.servicoDuracao}`;
        console.log(`listar_horarios URL: ${url}`);
        const res = await fetch(url, { headers });
        const text = await res.text();
        console.log(`listar_horarios response (${res.status}):`, text.slice(0, 1000));
        try {
          const parsed = JSON.parse(text);
          
          const br = getBrasiliaDate();
          const todayStr = br.todayDate;
          const currentHHMM = `${String(br.hours).padStart(2, '0')}:${String(br.minutes).padStart(2, '0')}`;
          
          if (args.data === todayStr) {
            const profissionais = parsed?.data || parsed;
            if (Array.isArray(profissionais)) {
              for (const prof of profissionais) {
                if (Array.isArray(prof.horariosVagos)) {
                  const before = prof.horariosVagos.length;
                  prof.horariosVagos = prof.horariosVagos.filter((h: string) => h > currentHHMM);
                  console.log(`Filtered past times for ${prof.nome || prof.id}: ${before} → ${prof.horariosVagos.length} (now: ${currentHHMM})`);
                }
              }
            }
          }

          // ===== FILTRO ANTI-BURACO (greedy slot packing) =====
          // Para cada profissional, mantém um slot e descarta os próximos que
          // cairiam dentro da janela [inicio, inicio+duracao). Isso evita que
          // a IA ofereça 9:00 + 9:20 (que criariam um buraco órfão de 20min
          // quando o cliente escolher um dos dois). Aplicado SEMPRE — se um
          // slot intermediário é o único disponível, ele continua sendo o
          // primeiro da lista e portanto é preservado.
          try {
            const dur = Number(args.servicoDuracao);
            const profissionais = parsed?.data || parsed;
            if (Array.isArray(profissionais) && Number.isFinite(dur) && dur > 0) {
              const toMin = (h: string) => {
                const [hh, mm] = String(h).slice(0, 5).split(":").map(Number);
                return hh * 60 + mm;
              };
              for (const prof of profissionais) {
                if (!Array.isArray(prof.horariosVagos) || prof.horariosVagos.length === 0) continue;
                const sorted = [...prof.horariosVagos]
                  .map((h: string) => String(h).slice(0, 5))
                  .filter((h: string) => /^\d{2}:\d{2}$/.test(h))
                  .sort();
                const kept: string[] = [];
                let nextAllowed = -Infinity;
                for (const h of sorted) {
                  const m = toMin(h);
                  if (m >= nextAllowed) {
                    kept.push(h);
                    nextAllowed = m + dur;
                  }
                }
                const before = prof.horariosVagos.length;
                prof.horariosVagos = kept;
                console.log(`[AntiBuraco] ${prof.nome || prof.id}: ${before} → ${kept.length} slots (dur=${dur}min)`);
              }
            }
          } catch (e) { console.warn("[AntiBuraco] falha:", (e as Error).message); }

          // Popula cache de slots reais por profissional para travar criar_agendamento alucinado.
          try {
            const profissionais = parsed?.data || parsed;
            if (Array.isArray(profissionais) && args.data) {
              const slotsByProf = new Map<number, Set<string>>();
              for (const prof of profissionais) {
                const pid = Number(prof?.id || prof?.Id);
                if (!Number.isFinite(pid)) continue;
                const slots = new Set<string>(
                  Array.isArray(prof.horariosVagos) ? prof.horariosVagos.map((h: string) => String(h).slice(0, 5)) : []
                );
                slotsByProf.set(pid, slots);
              }
              const key = `${tenant.id}:${phoneNumber || ""}`;
              trinksLastListed.set(key, { data: args.data, slotsByProf, listedAt: Date.now() });
              console.log(`[Trinks] cache horários: ${key} data=${args.data} profs=${slotsByProf.size}`);
            }
          } catch (e) { console.warn("[Trinks] falha ao cachear horários:", (e as Error).message); }

          // ===== AGENDAMENTO INTELIGENTE (consolidação) =====
          // Enriquecemos o retorno com uma visão consolidada para a IA decidir
          // sem perguntar "tem preferência de barbeiro?" quando não for necessário.
          try {
            const profissionais = (parsed?.data || parsed) as any[];
            if (Array.isArray(profissionais)) {
              const profsLivres = profissionais
                .filter((p) => Array.isArray(p?.horariosVagos) && p.horariosVagos.length > 0)
                .map((p) => ({
                  id: Number(p?.id || p?.Id),
                  nome: p?.nome || p?.Nome || "",
                  qtdHorarios: p.horariosVagos.length,
                  primeirosHorarios: p.horariosVagos.slice(0, 6),
                }));

              const consolidado: Record<string, Array<{ id: number; nome: string }>> = {};
              for (const p of profissionais) {
                if (!Array.isArray(p?.horariosVagos)) continue;
                const pid = Number(p?.id || p?.Id);
                const pnome = p?.nome || p?.Nome || "";
                for (const h of p.horariosVagos) {
                  const slot = String(h).slice(0, 5);
                  if (!consolidado[slot]) consolidado[slot] = [];
                  consolidado[slot].push({ id: pid, nome: pnome });
                }
              }

              let dica = "";
              if (profsLivres.length === 0) {
                dica = "NENHUM profissional livre nessa data. Ofereça outro dia — NÃO pergunte preferência de barbeiro.";
              } else if (profsLivres.length === 1) {
                dica = `APENAS 1 profissional livre (${profsLivres[0].nome}). NÃO pergunte preferência — ofereça direto os horários desse barbeiro.`;
              } else {
                dica = "Múltiplos profissionais livres. Se o cliente JÁ mencionou um horário, escolha automaticamente um barbeiro disponível naquele horário (sem perguntar). Se não mencionou horário, ofereça opções consolidadas OU pergunte preferência.";
              }

              (parsed as any).profissionaisLivres = profsLivres;
              (parsed as any).horariosConsolidados = consolidado;
              (parsed as any).dica = dica;
            }
          } catch (e) { console.warn("[Trinks] falha ao consolidar horários:", (e as Error).message); }

          return parsed;
        } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "buscar_agendamento": {
        let clienteId = args.clienteId;

        const resolvePhone = phoneNumber || args.telefone || "";
        if (resolvePhone) {
          let tel = resolvePhone.replace(/\D/g, "");
          if (tel.startsWith("55") && tel.length >= 12) tel = tel.substring(2);
          const ddd = tel.substring(0, 2);
          let rest = tel.substring(2);
          if (rest.length === 8) rest = "9" + rest;
          tel = ddd + rest;

          console.log(`buscar_agendamento: resolving clienteId from telefone ${tel}`);
          const clienteRes = await fetch(`${baseUrl}/clientes?telefone=${tel}`, { headers });
          const clienteData = await clienteRes.json();
          const clientes = clienteData?.data || clienteData;
          if (Array.isArray(clientes) && clientes.length > 0) {
            clienteId = clientes[0].id || clientes[0].Id;
            console.log(`buscar_agendamento: resolved clienteId=${clienteId} from telefone`);
          }
        }

        if (!clienteId) {
          return { data: [], message: "Cliente não encontrado" };
        }

        const agRes = await fetch(`${baseUrl}/agendamentos?clienteId=${clienteId}`, { headers });
        const agData = await agRes.json();
        const allList = Array.isArray(agData?.data) ? agData.data : [];
        const activeStatuses = ["confirmado", "aguardando confirmação", "aguardando confirmacao"];

        const activeAgendamentos = allList
          .filter((a: any) => {
            const statusName = String(a.status?.nome || "").toLowerCase();
            return activeStatuses.some((status) => statusName === status || statusName.includes(status));
          })
          .map((a: any) => ({
            id: a.id,
            status: a.status?.nome,
            servico: a.servico?.nome,
            profissional: a.profissional?.nome,
            clienteId: a.cliente?.id,
            dataHoraInicio: a.dataHoraInicio,
            duracaoEmMinutos: a.duracaoEmMinutos,
            valor: a.valor,
            servicoId: a.servico?.id,
            profissionalId: a.profissional?.id,
          }));

        return { data: activeAgendamentos, totalRecords: activeAgendamentos.length };
      }

      case "criar_agendamento": {
        // 🚨 TRAVA 0 — campos obrigatórios vazios. Evita 400/500 silencioso na Trinks
        // e impede a IA de chutar agendamento sem ter coletado os dados.
        const missing: string[] = [];
        if (!args.servicoId && !Number(args.servicoId)) missing.push("servicoId");
        if (!args.profissionalId && !Number(args.profissionalId)) missing.push("profissionalId");
        if (!args.dataHoraInicio || typeof args.dataHoraInicio !== "string") missing.push("dataHoraInicio");
        if (!args.duracaoEmMinutos && !Number(args.duracaoEmMinutos)) missing.push("duracaoEmMinutos");
        if (args.valor === undefined || args.valor === null || args.valor === "") missing.push("valor");
        if (missing.length > 0) {
          console.warn(`[Trinks] BLOQUEIO criar_agendamento campos vazios: ${missing.join(", ")}`);
          return {
            error: `Campos obrigatórios ausentes em criar_agendamento: ${missing.join(", ")}. Obtenha esses valores das tools (listar_servicos, listar_profissionais, listar_horarios) ANTES de chamar criar_agendamento.`,
            camposFaltantes: missing,
            blocked: true,
          };
        }

        let resolvedClienteId = args.clienteId;


        if (phoneNumber) {
          let tel = phoneNumber.replace(/\D/g, "");
          if (tel.startsWith("55") && tel.length >= 12) tel = tel.substring(2);
          const ddd = tel.substring(0, 2);
          let rest = tel.substring(2);
          if (rest.length === 8) rest = "9" + rest;
          tel = ddd + rest;

          const cliRes = await fetch(`${baseUrl}/clientes?telefone=${tel}`, { headers });
          const cliData = await cliRes.json();
          const cliList = cliData?.data || cliData;
          if (Array.isArray(cliList) && cliList.length > 0) {
            resolvedClienteId = cliList[0].id || cliList[0].Id;
            console.log(`criar_agendamento: resolved clienteId=${resolvedClienteId} from phone`);
          }
        }

        let dataHoraInicio = args.dataHoraInicio || "";
        if (dataHoraInicio.includes(" ")) dataHoraInicio = dataHoraInicio.replace(" ", "T");
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dataHoraInicio)) dataHoraInicio += ":00";

        // 🚨 TRAVA 1 — profissionalId alucinado.
        const profCache = trinksKnownProfs.get(tenant.id);
        const profId = Number(args.profissionalId);
        if (profCache && Date.now() - profCache.fetchedAt < TRINKS_CACHE_TTL_MS) {
          if (!Number.isFinite(profId) || !profCache.ids.has(profId)) {
            console.warn(`[Trinks] BLOQUEIO profissionalId inválido: ${args.profissionalId} (válidos: ${[...profCache.ids].join(",")})`);
            return {
              error: `profissionalId inválido: ${args.profissionalId}. Use APENAS um ID retornado por listar_profissionais.`,
              profissionalIdRecebido: args.profissionalId,
              profissionaisValidos: [...profCache.ids],
              blocked: true,
            };
          }
        }

        // 🚨 TRAVA 2 — data/horário fora do que foi listado.
        const slotsCache = trinksLastListed.get(`${tenant.id}:${phoneNumber || ""}`);
        if (slotsCache && Date.now() - slotsCache.listedAt < TRINKS_CACHE_TTL_MS) {
          const m = dataHoraInicio.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
          if (m) {
            const [_, dataReq, horaReq] = m;
            if (dataReq !== slotsCache.data) {
              console.warn(`[Trinks] BLOQUEIO data divergente: listada=${slotsCache.data} vs agendar=${dataReq}`);
              return {
                error: `Data divergente: você listou horários para ${slotsCache.data} mas tentou agendar em ${dataReq}. Chame listar_horarios para a data correta ANTES de criar_agendamento.`,
                ultimaDataListada: slotsCache.data,
                dataSolicitada: dataReq,
                blocked: true,
              };
            }
            const slotsProf = Number.isFinite(profId) ? slotsCache.slotsByProf.get(profId) : undefined;
            if (slotsProf && slotsProf.size > 0 && !slotsProf.has(horaReq)) {
              console.warn(`[Trinks] BLOQUEIO horário fora da grade: prof=${profId} hora=${horaReq} disponíveis=${[...slotsProf].join(",")}`);
              return {
                error: `Horário ${horaReq} não está disponível em ${dataReq} para o profissional ${profId}. Escolha um dos horários abaixo e tente novamente.`,
                horariosDisponiveis: [...slotsProf],
                data: dataReq,
                profissionalId: profId,
                blocked: true,
              };
            }
          }
        }


        // Check for duplicates
        try {
          const agRes = await fetch(`${baseUrl}/agendamentos?clienteId=${resolvedClienteId}`, { headers });
          const agData = await agRes.json();
          const agList = Array.isArray(agData?.data) ? agData.data : [];
          const activeStatuses = ["confirmado", "aguardando confirmação", "aguardando confirmacao"];
          const isDuplicate = agList.some((a: any) => {
            const statusName = String(a.status?.nome || "").toLowerCase();
            const isActive = activeStatuses.some((s) => statusName === s || statusName.includes(s));
            return isActive && a.dataHoraInicio === dataHoraInicio;
          });
          if (isDuplicate) {
            console.log(`criar_agendamento: DUPLICATE detected for ${dataHoraInicio}`);
            return {
              id: "duplicate",
              message: "Já existe um agendamento ativo neste horário. NÃO crie outro. Confirme ao cliente que já está agendado.",
              blocked: true,
            };
          }
        } catch (dedupErr) {
          console.error("criar_agendamento dedup check failed:", dedupErr);
        }

        const body = {
          servicoId: args.servicoId,
          clienteId: resolvedClienteId,
          profissionalId: args.profissionalId,
          dataHoraInicio,
          duracaoEmMinutos: args.duracaoEmMinutos,
          valor: args.valor,
        };
        console.log("criar_agendamento body:", JSON.stringify(body));
        const res = await fetch(`${baseUrl}/agendamentos`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        console.log(`criar_agendamento response (${res.status}):`, text.slice(0, 500));
        try { return JSON.parse(text); } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "cancelar_agendamento": {
        if (phoneNumber) {
          let tel = phoneNumber.replace(/\D/g, "");
          if (tel.startsWith("55") && tel.length >= 12) tel = tel.substring(2);
          const ddd = tel.substring(0, 2);
          let rest = tel.substring(2);
          if (rest.length === 8) rest = "9" + rest;
          tel = ddd + rest;
          const cliRes = await fetch(`${baseUrl}/clientes?telefone=${tel}`, { headers });
          const cliData = await cliRes.json();
          const cliList = cliData?.data || cliData;
          if (Array.isArray(cliList) && cliList.length > 0) {
            const ownerId = cliList[0].id || cliList[0].Id;
            const agRes = await fetch(`${baseUrl}/agendamentos?clienteId=${ownerId}`, { headers });
            const agData = await agRes.json();
            const agList = Array.isArray(agData?.data) ? agData.data : [];
            const activeStatuses = ["confirmado", "aguardando confirmação", "aguardando confirmacao"];
            const activeAgendamentos = agList
              .filter((a: any) => {
                const statusName = String(a.status?.nome || "").toLowerCase();
                return activeStatuses.some((status) => statusName === status || statusName.includes(status));
              })
              .map((a: any) => ({
                id: a.id,
                status: a.status?.nome,
                servico: a.servico?.nome,
                profissional: a.profissional?.nome,
                clienteId: a.cliente?.id,
                dataHoraInicio: a.dataHoraInicio,
              }));
            const owns = activeAgendamentos.some((a: any) => a.id === args.agendamentoId);
            if (!owns) {
              const idx = args.agendamentoId;
              if (Number.isInteger(idx) && idx >= 1 && idx <= activeAgendamentos.length) {
                const correctedId = activeAgendamentos[idx - 1].id;
                console.log(`cancelar_agendamento: AUTO-CORRECTED positional id ${idx} → real id ${correctedId}`);
                args.agendamentoId = correctedId;
              } else if (activeAgendamentos.length === 1) {
                const correctedId = activeAgendamentos[0].id;
                console.log(`cancelar_agendamento: AUTO-CORRECTED invalid id ${args.agendamentoId} → only active id ${correctedId}`);
                args.agendamentoId = correctedId;
              } else {
                console.log(`cancelar_agendamento: ownership check FAILED for agendamentoId=${args.agendamentoId}, cannot auto-correct`);
                return {
                  code: "agendamento_id_invalido",
                  error: "O agendamento informado não pertence a você.",
                  message: "Use um dos IDs reais de agendamentosAtivos ou execute buscar_agendamento novamente nesta interação.",
                  agendamentosAtivos: activeAgendamentos,
                };
              }
            }
          }
        }

        const url = `${baseUrl}/agendamentos/${args.agendamentoId}/status/cancelado`;
        const body = {
          quemCancelou: 1,
          motivo: args.motivo || "Cancelado pelo cliente via WhatsApp",
        };
        console.log(`cancelar_agendamento URL: ${url}`, JSON.stringify(body));
        const res = await fetch(url, {
          method: "PATCH",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        console.log(`cancelar_agendamento response (${res.status}):`, text.slice(0, 500));
        if (res.status === 200 || res.status === 204) {
          return { success: true, message: "Agendamento cancelado com sucesso" };
        }
        try { return { status: res.status, ...JSON.parse(text) }; } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "editar_agendamento": {
        if (phoneNumber) {
          let tel = phoneNumber.replace(/\D/g, "");
          if (tel.startsWith("55") && tel.length >= 12) tel = tel.substring(2);
          const ddd = tel.substring(0, 2);
          let rest = tel.substring(2);
          if (rest.length === 8) rest = "9" + rest;
          tel = ddd + rest;
          const cliRes = await fetch(`${baseUrl}/clientes?telefone=${tel}`, { headers });
          const cliData = await cliRes.json();
          const cliList = cliData?.data || cliData;
          if (Array.isArray(cliList) && cliList.length > 0) {
            const ownerId = cliList[0].id || cliList[0].Id;
            const agRes = await fetch(`${baseUrl}/agendamentos?clienteId=${ownerId}`, { headers });
            const agData = await agRes.json();
            const agList = Array.isArray(agData?.data) ? agData.data : [];
            const activeStatuses = ["confirmado", "aguardando confirmação", "aguardando confirmacao"];
            const activeAgendamentos = agList
              .filter((a: any) => {
                const statusName = String(a.status?.nome || "").toLowerCase();
                return activeStatuses.some((status) => statusName === status || statusName.includes(status));
              })
              .map((a: any) => ({
                id: a.id,
                status: a.status?.nome,
                servico: a.servico?.nome,
                profissional: a.profissional?.nome,
                clienteId: a.cliente?.id,
                dataHoraInicio: a.dataHoraInicio,
              }));
            const owns = activeAgendamentos.some((a: any) => a.id === args.agendamentoId);
            if (!owns) {
              const idx = args.agendamentoId;
              if (Number.isInteger(idx) && idx >= 1 && idx <= activeAgendamentos.length) {
                const correctedId = activeAgendamentos[idx - 1].id;
                console.log(`editar_agendamento: AUTO-CORRECTED positional id ${idx} → real id ${correctedId}`);
                args.agendamentoId = correctedId;
              } else if (activeAgendamentos.length === 1) {
                const correctedId = activeAgendamentos[0].id;
                console.log(`editar_agendamento: AUTO-CORRECTED invalid id ${args.agendamentoId} → only active id ${correctedId}`);
                args.agendamentoId = correctedId;
              } else {
                console.log(`editar_agendamento: ownership check FAILED for agendamentoId=${args.agendamentoId}`);
                return {
                  code: "agendamento_id_invalido",
                  error: "O agendamento informado não pertence a você.",
                  message: "Use um dos IDs reais de agendamentosAtivos ou execute buscar_agendamento novamente nesta interação.",
                  agendamentosAtivos: activeAgendamentos,
                };
              }
            }
          }
        }

        let dataHoraInicio = args.dataHoraInicio || "";
        if (dataHoraInicio.includes(" ")) dataHoraInicio = dataHoraInicio.replace(" ", "T");
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dataHoraInicio)) dataHoraInicio += ":00";

        let editClienteId = args.clienteId;
        if (phoneNumber) {
          let tel2 = phoneNumber.replace(/\D/g, "");
          if (tel2.startsWith("55") && tel2.length >= 12) tel2 = tel2.substring(2);
          const ddd2 = tel2.substring(0, 2);
          let rest2 = tel2.substring(2);
          if (rest2.length === 8) rest2 = "9" + rest2;
          tel2 = ddd2 + rest2;
          const cliRes2 = await fetch(`${baseUrl}/clientes?telefone=${tel2}`, { headers });
          const cliData2 = await cliRes2.json();
          const cliList2 = cliData2?.data || cliData2;
          if (Array.isArray(cliList2) && cliList2.length > 0) {
            editClienteId = cliList2[0].id || cliList2[0].Id;
          }
        }

        const body = {
          servicoId: args.servicoId,
          clienteId: editClienteId,
          profissionalId: args.profissionalId,
          dataHoraInicio,
          duracaoEmMinutos: args.duracaoEmMinutos,
          valor: args.valor,
        };
        console.log(`editar_agendamento body:`, JSON.stringify(body));
        const res = await fetch(`${baseUrl}/agendamentos/${args.agendamentoId}`, {
          method: "PUT",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        console.log(`editar_agendamento response (${res.status}):`, text.slice(0, 500));
        if (res.status === 200 || res.status === 204) {
          return { success: true, message: "Agendamento alterado com sucesso" };
        }
        try { return { status: res.status, ...JSON.parse(text) }; } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      default:
        return { error: `Unknown tool: ${funcName}` };
    }
  } catch (error) {
    console.error(`Trinks tool error (${funcName}):`, error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { error: `Erro ao executar ${funcName}: ${errorMessage}` };
  }
}

// ===================== ONE BELEZA TOOL EXECUTION =====================

async function executeOneBelezaTool(tenant: any, toolCall: any, phoneNumber?: string): Promise<any> {
  const funcName = toolCall.function.name;
  let args: any = {};
  try { args = JSON.parse(toolCall.function.arguments || "{}"); } catch { /* empty */ }

  const baseUrl = "https://onechatbotapi.azurewebsites.net";
  const celular = tenant.onebeleza_celular || "";
  const rawToken = (tenant.onebeleza_token || "").trim();
  const bearerToken = rawToken.startsWith("Bearer ") ? rawToken : `Bearer ${rawToken}`;
  const authHeaders: Record<string, string> = {
    "Authorization": bearerToken,
    "Accept": "application/json",
  };

  try {
    switch (funcName) {
      case "buscar_cliente": {
        let tel = (phoneNumber || "").replace(/\D/g, "");
        if (tel.startsWith("55") && tel.length >= 12) tel = tel.substring(2);

        // Se já temos alias mapeado para este tenant + telefone real, usa o alias
        const effectiveTel = await resolveOneBelezaClientPhone(tenant.id, tel);

        const url = `${baseUrl}/api/Clientes/GetClientePeloNumero?Celular=${effectiveTel}`;
        console.log(`[OneBeleza] buscar_cliente URL: ${url} (real=${tel}, effective=${effectiveTel})`);
        const res = await fetchOneBelezaWithRetry(url, { headers: authHeaders });
        const text = await res.text();
        console.log(`[OneBeleza] buscar_cliente response (${res.status}):`, text.slice(0, 500));
        try { return JSON.parse(text); } catch { return { raw: text.slice(0, 200), status: res.status }; }
      }

      case "cadastrar_cliente": {
        let tel = (phoneNumber || "").replace(/\D/g, "");
        if (tel.startsWith("55") && tel.length >= 12) tel = tel.substring(2);

        // 🛡️ Defesa em profundidade: NUNCA chamar a API da One Beleza com nome inválido.
        // Mesmo que a barreira upstream (dispatcher) tenha sido contornada por uma
        // versão antiga em cache ou por outro caminho, aqui o cadastro é bloqueado.
        const candidateName = String(args?.nome || "").trim();
        if (!looksLikeRealName(candidateName)) {
          console.log(`[OneBeleza] cadastrar_cliente BLOCKED — nome inválido recebido: "${candidateName.slice(0, 100)}"`);
          try {
            const supabaseSvc = _serviceSupabase();
            await supabaseSvc.from("audit_logs").insert({
              tenant_id: tenant.id,
              actor_role: "service",
              entity: "onebeleza_cadastrar_cliente",
              entity_id: phoneNumber || tel,
              action: "onebeleza_register_blocked_api_guard",
              before: { arg_nome: candidateName.slice(0, 200), reason: "looks_not_like_name" },
            });
          } catch { /* ignore */ }
          return {
            error: "NOME_INVALIDO",
            blocked: true,
            message: "Cadastro recusado pelo sistema: o nome informado não parece um nome real (precisa ter 2 a 4 palavras, só letras, sem verbos/saudações/serviços). NÃO chame cadastrar_cliente de novo com a mesma string. Responda APENAS: 'Pra finalizar, me diz só seu nome e sobrenome?' e AGUARDE a próxima mensagem do cliente.",
          };
        }

        const { res, text, aliasUsed } = await registerOneBelezaClient(
          authHeaders,
          tel,
          candidateName,
          "[OneBeleza]",
          tenant.id,
        );
        let parsed: any;
        try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 200), status: res.status }; }
        if (aliasUsed) {
          // Anexa info pra IA saber que o cadastro foi resolvido via alias e pode seguir
          parsed = {
            ...(typeof parsed === "object" && parsed !== null ? parsed : { raw: parsed }),
            ok: res.ok || (res.status >= 200 && res.status < 300),
            aliasUsed,
            realPhone: tel,
            info: "Cliente cadastrado com telefone alternativo (o número original já estava em outra conta). O sistema usará o alias automaticamente em todas as próximas chamadas. Prossiga normalmente.",
          };
        }
        return parsed;
      }


      case "buscar_servicos": {
        const url = `${baseUrl}/api/Servicos/RetornarGrupoServicos?celular=${celular}`;
        console.log(`[OneBeleza] buscar_servicos URL: ${url}`);
        const res = await fetchOneBelezaWithRetry(url, { headers: authHeaders });
        const text = await res.text();
        console.log(`[OneBeleza] buscar_servicos response (${res.status}):`, text.slice(0, 1000));

        // Always read filter config and log diagnostic info — regardless of parse success
        const rawFilter = tenant?.agent_settings?.onebeleza_unit_filter;
        const filterList: string[] = Array.isArray(rawFilter)
          ? rawFilter.filter((s) => typeof s === "string" && s.trim())
          : (typeof rawFilter === "string" && rawFilter.trim() ? [rawFilter] : []);

        let parsed: any;
        try {
          parsed = JSON.parse(text);
        } catch {
          console.log(`[OneBeleza] buscar_servicos: JSON parse failed`);
          return { raw: text.slice(0, 200), status: res.status };
        }

        // Normalize: API may return array directly, or { data: [...] }, or { grupos: [...] }
        let groups: any[];
        if (Array.isArray(parsed)) {
          groups = parsed;
        } else if (Array.isArray(parsed?.data)) {
          groups = parsed.data;
        } else if (Array.isArray(parsed?.grupos)) {
          groups = parsed.grupos;
        } else {
          console.log(`[OneBeleza] buscar_servicos: response is not an array, returning as-is. Type: ${typeof parsed}, keys: ${parsed && typeof parsed === "object" ? Object.keys(parsed).join(",") : "n/a"}`);
          return parsed;
        }

        console.log(`[OneBeleza] filter check: rawFilter=${JSON.stringify(rawFilter)}, filterList=${JSON.stringify(filterList)}, groupsCount=${groups.length}, groupNames=${JSON.stringify(groups.map((g: any) => g?.descricao || ""))}`);

        if (filterList.length === 0) {
          console.log(`[OneBeleza] buscar_servicos: no unit filter configured, returning all ${groups.length} groups`);
          return groups;
        }

        const norm = (s: string) => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
        const needles = filterList.map(norm);
        const filtered = groups.filter((g: any) => {
          const name = norm(g?.descricao || "");
          return needles.some((n) => name.includes(n));
        });
        console.log(`[OneBeleza] buscar_servicos unit filter applied: ${groups.length} → ${filtered.length} groups (allowed: ${JSON.stringify(filterList)}, kept: ${JSON.stringify(filtered.map((g: any) => g?.descricao))})`);

        if (filtered.length === 0) {
          return {
            error: `Nenhum grupo de serviço da unidade configurada (${filterList.join(", ")}) foi encontrado. Grupos retornados: ${groups.map((g: any) => g?.descricao).join(" | ")}. Verifique onebeleza_unit_filter no tenant.`,
          };
        }

        return filtered;
      }

      case "buscar_horarios_disponiveis": {
        // OPÇÃO 2 (recomendado pela One Beleza para IA):
        // Retorna em UMA chamada todos os profissionais + horários disponíveis para um serviço/data.
        const date = String(args.date || args.dataNumero || "").trim();
        const servicoId = String(args.servicoId || args.servicosId || args.servicoid || "").trim();
        if (!date || !servicoId) {
          return { error: "Parâmetros obrigatórios: date (YYYY-MM-DD) e servicoId." };
        }

        // Validate date format & not in past (helps disambiguate empty results)
        const br = getBrasiliaDate();
        const isValidDate = /^\d{4}-\d{2}-\d{2}$/.test(date);
        const isPast = isValidDate && date < br.todayDate;

        const url = `${baseUrl}/api/Agendamento/HorariosTodosProfissionaisByDataServico?celular=${celular}&date=${date}&servicoId=${servicoId}`;
        console.log(`[OneBeleza] buscar_horarios_disponiveis URL: ${url}`);
        const res = await fetchOneBelezaWithRetry(url, { method: "POST", headers: authHeaders });
        const text = await res.text();
        console.log(`[OneBeleza] buscar_horarios_disponiveis response (${res.status}):`, text.slice(0, 1500));
        let parsed: any;
        try { parsed = JSON.parse(text); } catch { return { raw: text.slice(0, 200), status: res.status }; }

        // Filter past times if today
        if (date === br.todayDate && Array.isArray(parsed)) {
          const currentHHMMSS = `${String(br.hours).padStart(2, '0')}:${String(br.minutes).padStart(2, '0')}:00`;
          for (const item of parsed) {
            if (Array.isArray(item?.disponibilidades)) {
              for (const disp of item.disponibilidades) {
                if (Array.isArray(disp?.horarios)) {
                  disp.horarios = disp.horarios.filter((h: any) => !h?.horarioInicio || h.horarioInicio > currentHHMMSS);
                }
              }
            }
            if (item?.horarioInicio && item.horarioInicio <= currentHHMMSS) item._filtered = true;
          }
          parsed = parsed.filter((it: any) => !it._filtered);
        }

        // Detect "empty result" — server-side disambiguation so the AI doesn't say generic "no slots"
        const isEmpty = !Array.isArray(parsed) || parsed.length === 0 || parsed.every((it: any) => {
          const disps = Array.isArray(it?.disponibilidades) ? it.disponibilidades : [];
          if (disps.length === 0) return true;
          return disps.every((d: any) => !Array.isArray(d?.horarios) || d.horarios.length === 0);
        });

        if (isEmpty) {
          // Past date short-circuit
          if (isPast) {
            console.log(`[OneBeleza][diag] empty result servicoId=${servicoId} date=${date} reason=data_passada`);
            return {
              vazio: true,
              motivo: "data_invalida_ou_passada",
              mensagem: `A data ${date} já passou. Peça ao cliente outra data (a partir de ${br.todayDate}).`,
            };
          }

          // Discover whether the service has ANY professional enabled in this unit
          let profCount = 0;
          let profNames: string[] = [];
          try {
            const profUrl = `${baseUrl}/api/Profissionais/PesquisarProfissionais?celular=${celular}&servicosId=${servicoId}`;
            const profRes = await fetchOneBelezaWithRetry(profUrl, { headers: authHeaders });
            const profText = await profRes.text();
            const profParsed = JSON.parse(profText);
            if (Array.isArray(profParsed)) {
              profCount = profParsed.length;
              profNames = profParsed
                .map((p: any) => String(p?.nome || p?.nomeProfissional || "").trim())
                .filter(Boolean);
            }
          } catch (e) {
            console.log(`[OneBeleza][diag] profissionais lookup failed:`, (e as Error).message);
          }

          if (profCount === 0) {
            console.log(`[OneBeleza][diag] empty result servicoId=${servicoId} date=${date} reason=servico_sem_profissional profCount=0`);
            return {
              vazio: true,
              motivo: "servico_sem_profissional",
              mensagem: "Esse serviço não tem nenhum profissional habilitado nesta unidade. Ofereça um serviço equivalente OU escalar humano.",
            };
          }

          console.log(`[OneBeleza][diag] empty result servicoId=${servicoId} date=${date} reason=dia_sem_vaga profCount=${profCount} profs=${profNames.join("|")}`);
          return {
            vazio: true,
            motivo: "dia_sem_vaga",
            profissionais_habilitados: profNames,
            mensagem: `Nenhum horário em ${date}. Profissionais habilitados para este serviço: ${profNames.join(", ") || "(nomes indisponíveis)"}. Pergunte ao cliente outro dia.`,
          };
        }

        return parsed;
      }

      case "buscar_barbeiros_por_servico": {
        const url = `${baseUrl}/api/Profissionais/PesquisarProfissionais?celular=${celular}&servicosId=${args.servicosId}`;
        console.log(`[OneBeleza] buscar_barbeiros URL: ${url}`);
        const res = await fetchOneBelezaWithRetry(url, { headers: authHeaders });
        const text = await res.text();
        console.log(`[OneBeleza] buscar_barbeiros response (${res.status}):`, text.slice(0, 1000));
        try { return JSON.parse(text); } catch { return { raw: text.slice(0, 200), status: res.status }; }
      }

      case "buscar_datas_disponiveis": {
        const url = `${baseUrl}/api/Agendamento/RetornarDatasPorServico?celular=${celular}&servicosid=${args.servicosId}&profissionalid=${args.profissionalid}`;
        console.log(`[OneBeleza] buscar_datas URL: ${url}`);
        const res = await fetchOneBelezaWithRetry(url, { headers: authHeaders });
        const text = await res.text();
        console.log(`[OneBeleza] buscar_datas response (${res.status}):`, text.slice(0, 1000));
        try { return JSON.parse(text); } catch { return { raw: text.slice(0, 200), status: res.status }; }
      }

      case "buscar_horarios": {
        const url = `${baseUrl}/api/Agendamento/HorariosPorProfissionaisByDataServico?celular=${celular}&date=${args.date}&servicoId=${args.servicoId}&ProfissionalId=${args.ProfissionalId}`;
        console.log(`[OneBeleza] buscar_horarios URL: ${url}`);
        const res = await fetchOneBelezaWithRetry(url, {
          method: "POST",
          headers: authHeaders,
        });
        const text = await res.text();
        console.log(`[OneBeleza] buscar_horarios response (${res.status}):`, text.slice(0, 1000));
        try {
          const parsed = JSON.parse(text);
          
          // Filter past times if today
          const br = getBrasiliaDate();
          if (args.date === br.todayDate) {
            const currentHHMMSS = `${String(br.hours).padStart(2, '0')}:${String(br.minutes).padStart(2, '0')}:00`;
            if (Array.isArray(parsed)) {
              for (const item of parsed) {
                if (item.horarioInicio && item.horarioInicio <= currentHHMMSS) {
                  item._filtered = true;
                }
              }
              const filtered = parsed.filter((item: any) => !item._filtered);
              console.log(`[OneBeleza] Filtered past times: ${parsed.length} → ${filtered.length}`);
              return filtered;
            }
          }
          
          return parsed;
        } catch { return { raw: text.slice(0, 200), status: res.status }; }
      }

      case "agendar": {
        // Normalize args keys to handle case variations
        const normalizedArgs: Record<string, string> = {};
        for (const [k, v] of Object.entries(args)) {
          normalizedArgs[k.toLowerCase()] = String(v ?? "");
        }
        const aDataAg = normalizedArgs["datanumero"] || normalizedArgs["dataag"] || normalizedArgs["data"] || "";
        const aServicoId = normalizedArgs["servicoid"] || normalizedArgs["servicosid"] || "";
        const aProfissionalId = normalizedArgs["profissionalid"] || "";
        const aHorarioInicio = normalizeOneBelezaTime(normalizedArgs["horarioinicio"] || "");
        const aHorarioFim = normalizeOneBelezaTime(normalizedArgs["horariofim"] || "");

        // Validate IDs are not small/invented numbers
        const sIdNum = parseInt(aServicoId, 10);
        const pIdNum = parseInt(aProfissionalId, 10);
        if (aServicoId && sIdNum > 0 && sIdNum <= 10) {
          console.error(`[OneBeleza] agendar BLOCKED: servicoId=${aServicoId} is suspiciously small (likely invented)`);
          return { error: "servicoId inválido. Execute buscar_servicos novamente e use o servicosId retornado (número grande, ex: 2461).", blocked: true };
        }
        if (aProfissionalId && pIdNum > 0 && pIdNum <= 10) {
          console.error(`[OneBeleza] agendar BLOCKED: profissionalId=${aProfissionalId} is suspiciously small (likely invented)`);
          return { error: "profissionalId inválido. Execute buscar_barbeiros_por_servico novamente e use o profissionalId retornado (número grande, ex: 40658).", blocked: true };
        }

        // ⚠️ CRITICAL: the `celular` query param identifies the BOOKING CLIENT in the One Beleza API.
        // Using the tenant owner's phone (tenant.onebeleza_celular) makes the appointment fall under the owner.
        // We MUST use the conversation client's phone (the one writing on WhatsApp).
        let clienteTel = (phoneNumber || "").replace(/\D/g, "");
        if (clienteTel.startsWith("55") && clienteTel.length >= 12) clienteTel = clienteTel.substring(2);
        if (!clienteTel) {
          console.error(`[OneBeleza] agendar BLOCKED: empty client phone for booking`);
          return { error: "Telefone do cliente ausente; não é possível agendar.", blocked: true };
        }
        // Se houver alias mapeado, usa o alias na API
        const realClienteTel = clienteTel;
        clienteTel = await resolveOneBelezaClientPhone(tenant.id, clienteTel);

        // Resolve cliente (cliforcolsid) by the CLIENT phone
        let cliforcolsid = "";
        let clienteNome = "";
        try {
          const cliRes = await fetchOneBelezaWithRetry(`${baseUrl}/api/Clientes/GetClientePeloNumero?Celular=${clienteTel}`, { headers: authHeaders });
          const cliText = await cliRes.text();
          try {
            const cli = JSON.parse(cliText);
            cliforcolsid = String(
              cli?.cliforcolsid ||
              cli?.cliForColsId ||
              cli?.cliForColsid ||
              cli?.clienteId ||
              cli?.id ||
              ""
            ).trim();
            clienteNome = String(cli?.nome || cli?.Nome || "").trim();
          } catch { /* empty */ }
          console.log(`[OneBeleza] agendar resolved cliente: tel=${clienteTel} cliforcolsid=${cliforcolsid} nome="${clienteNome}"`);
        } catch (e) {
          console.error(`[OneBeleza] agendar failed to resolve cliente:`, (e as Error).message);
        }
        if (!cliforcolsid) {
          return { error: "Cliente não encontrado pelo telefone. Execute cadastrar_cliente antes de agendar.", blocked: true };
        }

        // Sanity guard: never allow the booking phone to be the tenant owner's phone
        const ownerTel = String(tenant.onebeleza_celular || "").replace(/\D/g, "");
        if (ownerTel && (ownerTel === clienteTel || ownerTel.endsWith(clienteTel) || clienteTel.endsWith(ownerTel))) {
          console.error(`[OneBeleza] agendar BLOCKED: client phone (${clienteTel}) matches tenant owner phone (${ownerTel})`);
          return { error: "Número do cliente coincide com o número da conta da barbearia. Agendamento bloqueado para evitar registro no dono.", blocked: true };
        }

        // ⚠️ Use the CLIENT phone in the URL — this is what the One Beleza API uses to attribute the booking.
        const url = `${baseUrl}/api/Agendamento/MarcarAgendamentoForm?celular=${clienteTel}`;

        // Build multipart form data
        const formData = new FormData();
        formData.append("dataAg", aDataAg);
        formData.append("servicoId", aServicoId);
        formData.append("profissionalId", aProfissionalId);
        formData.append("horarioInicio", aHorarioInicio);
        formData.append("horarioFim", aHorarioFim);
        formData.append("cliforcolsid", cliforcolsid);
        formData.append("cliForColsid", cliforcolsid);
        formData.append("cliForColsId", cliforcolsid);
        formData.append("clienteId", cliforcolsid);

        console.log(`[OneBeleza] agendar FINAL REQUEST → URL=${url} | clienteTel=${clienteTel} cliforcolsid=${cliforcolsid} nome="${clienteNome}" | dataAg=${aDataAg} servicoId=${aServicoId} profissionalId=${aProfissionalId} horarioInicio=${aHorarioInicio} horarioFim=${aHorarioFim} | ownerTel=${ownerTel}`);

        const res = await fetchOneBelezaWithRetry(url, {
          method: "POST",
          headers: { "Authorization": bearerToken },
          body: formData,
        });
        const text = await res.text();
        console.log(`[OneBeleza] agendar response (${res.status}):`, text.slice(0, 500));
        
        if (res.status === 200 || res.status === 201) {
          try { 
            const parsed = JSON.parse(text);
            return { id: parsed.id || parsed.Id || true, success: true, ...parsed };
          } catch { 
            return { id: true, success: true, message: text.slice(0, 200) };
          }
        }
        
        // Handle "Já existe um evento no horário" error
        if (res.status === 400 && text.includes("evento no hor")) {
          return { error: "Já existe um evento no horário.", conflict: true };
        }
        
        try { return JSON.parse(text); } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "buscar_agendamentos_dia": {
        const url = `${baseUrl}/api/Agendamento/GetTodosAgendamentosDia?date=${args.date}`;
        console.log(`[OneBeleza] buscar_agendamentos_dia URL: ${url}`);
        const res = await fetchOneBelezaWithRetry(url, { headers: authHeaders });
        const text = await res.text();
        console.log(`[OneBeleza] buscar_agendamentos_dia response (${res.status}):`, text.slice(0, 1000));
        try { return JSON.parse(text); } catch { return { raw: text.slice(0, 200), status: res.status }; }
      }

      case "confirmar_agendamento": {
        const url = `${baseUrl}/api/Agendamento/ConfirmarAgendamento?agendasId=${args.agendasId}&celular=${celular}`;
        console.log(`[OneBeleza] confirmar_agendamento URL: ${url}`);
        const res = await fetchOneBelezaWithRetry(url, {
          method: "POST",
          headers: authHeaders,
        });
        const text = await res.text();
        console.log(`[OneBeleza] confirmar_agendamento response (${res.status}):`, text.slice(0, 500));
        if (res.status === 200) {
          return { success: true, message: "Agendamento confirmado com sucesso" };
        }
        try { return JSON.parse(text); } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "desmarcar_agendamento": {
        const url = `${baseUrl}/api/Agendamento/DesmarcarAgendamento?celular=${celular}&agendasId=${args.agendasId}`;
        console.log(`[OneBeleza] desmarcar_agendamento URL: ${url}`);
        const res = await fetchOneBelezaWithRetry(url, {
          method: "DELETE",
          headers: authHeaders,
        });
        const text = await res.text();
        console.log(`[OneBeleza] desmarcar_agendamento response (${res.status}):`, text.slice(0, 500));
        if (res.status === 200 || res.status === 204) {
          return { success: true, message: "Agendamento desmarcado com sucesso" };
        }
        try { return JSON.parse(text); } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      default:
        return { error: `Unknown OneBeleza tool: ${funcName}` };
    }
  } catch (error) {
    console.error(`OneBeleza tool error (${funcName}):`, error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { error: `Erro ao executar ${funcName}: ${errorMessage}` };
  }
}

// ===================== NONE TOOL EXECUTION =====================

async function executeNoneTool(_tenant: any, toolCall: any): Promise<any> {
  const funcName = toolCall.function.name;
  // Provider "none" não expõe ferramentas. Se a IA tentar chamar algo,
  // devolvemos um erro instruindo-a a responder direto no texto.
  return {
    error: `A ferramenta "${funcName}" não existe neste estabelecimento. Responda diretamente no texto, sem chamar ferramentas.`,
  };
}

// ===================== FRIZZAR PROMPT SECTION =====================


// ===================== FRIZZAR TOOLS DEFINITION =====================

function buildFrizzarTools(tenant: any) {
  if (!tenant.frizzar_token) return undefined;

  return [
    {
      type: "function",
      function: {
        name: "buscar_cliente",
        description: "Busca um cliente pelo telefone. Retorna codigo (id), nome, telefone e ddi.",
        parameters: {
          type: "object",
          properties: {
            telefone: { type: "string", description: "Telefone com DDD, somente dígitos (ex: 11999998888)" },
            ddi: { type: "number", description: "DDI do país, padrão 55", default: 55 },
          },
          required: ["telefone"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "cadastrar_cliente",
        description: "Cadastra um novo cliente. Use somente se buscar_cliente retornar 404. Retorna o cliente criado (com codigo).",
        parameters: {
          type: "object",
          properties: {
            nome: { type: "string", description: "Nome completo (mín 2 chars, máx 70, somente letras e espaços)" },
            telefone: { type: "string", description: "Telefone com DDD, somente dígitos" },
            ddi: { type: "number", description: "DDI do país, padrão 55", default: 55 },
          },
          required: ["nome", "telefone"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "buscar_agendamentos",
        description: "Lista agendamentos abertos do cliente (a partir das últimas ~2 horas).",
        parameters: {
          type: "object",
          properties: {
            clienteId: { type: "number", description: "ID (codigo) do cliente retornado por buscar_cliente" },
          },
          required: ["clienteId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "listar_servicos",
        description: "Lista todos os serviços da empresa que aceitam agendamento online.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "listar_profissionais",
        description: "Lista profissionais que atendem TODOS os serviços informados e têm horário disponível. Sempre chame após listar_servicos e o cliente ter escolhido o(s) serviço(s).",
        parameters: {
          type: "object",
          properties: {
            servicos: {
              type: "array",
              description: "Lista de serviços escolhidos pelo cliente",
              items: {
                type: "object",
                properties: { codigo: { type: "number", description: "ID (codigo) do serviço" } },
                required: ["codigo"],
              },
            },
          },
          required: ["servicos"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "listar_horarios",
        description: "Lista horários LIVRES do profissional somente para a data solicitada. Use APENAS o campo horariosLivres da resposta. Para outro dia, faça uma nova chamada com a nova data.",
        parameters: {
          type: "object",
          properties: {
            profissionalId: { type: "number", description: "ID (codigo) do profissional" },
            data: { type: "string", description: "Data inicial no formato yyyy-MM-dd" },
            servicos: {
              type: "array",
              description: "Lista de serviços escolhidos",
              items: {
                type: "object",
                properties: { codigo: { type: "number" } },
                required: ["codigo"],
              },
            },
          },
          required: ["profissionalId", "data", "servicos"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "listar_horarios_geral",
        description: "ATALHO RECOMENDADO: lista horários LIVRES de VÁRIOS profissionais ao mesmo tempo, somente para a data solicitada. Use logo após listar_profissionais para já ter a agenda consolidada antes de perguntar preferência ao cliente. Para outro dia, faça uma nova chamada com a nova data. Retorna { data, resumo, profissionais: [{ profissionalId, nome, horariosLivres }] }.",
        parameters: {
          type: "object",
          properties: {
            profissionais: {
              type: "array",
              description: "Lista de profissionais a consultar. Use os retornados por listar_profissionais.",
              items: {
                type: "object",
                properties: {
                  codigo: { type: "number", description: "ID (codigo) do profissional" },
                  nome: { type: "string", description: "Nome do profissional (opcional, ajuda na resposta)" },
                },
                required: ["codigo"],
              },
            },
            data: { type: "string", description: "Data inicial no formato yyyy-MM-dd" },
            servicos: {
              type: "array",
              description: "Lista de serviços escolhidos pelo cliente",
              items: {
                type: "object",
                properties: { codigo: { type: "number" } },
                required: ["codigo"],
              },
            },
          },
          required: ["profissionais", "data", "servicos"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "agendar",
        description: "Cria o agendamento. Cada serviço gera um agendamento sequencial. Sempre confirme dia/hora/serviço com o cliente ANTES de chamar.",
        parameters: {
          type: "object",
          properties: {
            clienteId: { type: "number" },
            dia: { type: "string", description: "Data no formato yyyy-MM-dd" },
            hora: { type: "string", description: "Hora no formato HH:mm" },
            profissionalId: { type: "number" },
            servicos: {
              type: "array",
              items: {
                type: "object",
                properties: { codigo: { type: "number" } },
                required: ["codigo"],
              },
            },
          },
          required: ["clienteId", "dia", "hora", "profissionalId", "servicos"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "cancelar_agendamento",
        description: "Cancela um agendamento pelo ID. Se o body retornar status 405, o agendamento já foi realizado e não pode ser cancelado.",
        parameters: {
          type: "object",
          properties: {
            agendamentoId: { type: "number", description: "ID (codigo) do agendamento" },
          },
          required: ["agendamentoId"],
        },
      },
    },
  ];
}

// ===================== FRIZZAR TOOL EXECUTION =====================

// Memória in-process da última `listar_horarios` por conversa/profissional.
// Chave: `${tenantId}:${phoneNumber}:${profissionalId}` → { dia, listedAt }.
// Usada por `agendar` para travar tentativa de agendar em data diferente da consultada.
const frizzarLastListed = new Map<string, { dia: string; listedAt: number }>();

async function executeFrizzarTool(tenant: any, toolCall: any, _phoneNumber?: string): Promise<any> {
  const funcName = toolCall.function.name;
  let args: any = {};
  try { args = JSON.parse(toolCall.function.arguments || "{}"); } catch { /* empty */ }
  const lastListedKey = (profId: any) => `${tenant.id}:${_phoneNumber || ""}:${profId}`;


  // Resolução da URL base da Frizzar:
  // 1) override por tenant (campo frizzar_base_url) — útil se a Frizzar mudar o host;
  // 2) padrão = host atualmente em uso pela própria Frizzar (confirmado via integração n8n
  //    que já roda em produção). Apesar do nome "homologacao", é o endpoint REST oficial.
  //    O domínio "api.frizzar.com.br" listado na doc ainda não tem DNS publicado (NXDOMAIN).
  // 3) fallback secundário (mantido por segurança) caso o override aponte para um host quebrado.
  const DEFAULT_URL = "https://homologacao.frizzar.com.br:8446/api/bot";
  const normalizeBase = (raw: string): string => {
    let v = (raw || "").trim().replace(/\/+$/, "");
    if (!v) return "";
    // adiciona https:// se não houver protocolo
    if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
    return v;
  };
  const overrideUrl = normalizeBase(tenant.frizzar_base_url || "");
  const primaryBase = overrideUrl || DEFAULT_URL;
  const fallbackBase = overrideUrl && overrideUrl !== DEFAULT_URL ? DEFAULT_URL : null;

  const rawToken = (tenant.frizzar_token || "").trim();
  if (!rawToken) {
    return { error: "Frizzar token não configurado para este estabelecimento." };
  }
  const authHeader = rawToken.toLowerCase().startsWith("basic ") ? rawToken : `Basic ${rawToken}`;
  const headers: Record<string, string> = {
    "Authorization": authHeader,
    "Accept": "application/json",
  };
  const jsonHeaders: Record<string, string> = { ...headers, "Content-Type": "application/json" };

  // wrapper que tenta a URL primária, faz retry com backoff em 5xx transientes (502/503/504)
  // e, em caso de erro de rede/DNS ou 5xx persistente, repete na URL de fallback.
  const transientStatuses = new Set([502, 503, 504]);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const frizzarFetch = async (path: string, init?: RequestInit): Promise<Response> => {
    const tryFetch = async (base: string) => {
      const url = base + path;
      let lastRes: Response | null = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        console.log(`[Frizzar] -> ${init?.method || "GET"} ${url} (tentativa ${attempt}/3)`);
        const res = await fetch(url, init);
        if (!transientStatuses.has(res.status)) return res;
        console.warn(`[Frizzar] status transitório ${res.status} em ${url} — backoff`);
        lastRes = res;
        if (attempt < 3) await sleep(400 * attempt); // 400ms, 800ms
      }
      return lastRes!;
    };
    try {
      const res = await tryFetch(primaryBase);
      if (transientStatuses.has(res.status) && fallbackBase) {
        console.warn(`[Frizzar] 5xx persistente em ${primaryBase} — tentando fallback ${fallbackBase}`);
        return await tryFetch(fallbackBase);
      }
      return res;
    } catch (err) {
      const msg = (err as Error)?.message || String(err);
      const isNetwork = /dns|name not resolved|getaddrinfo|enotfound|network|fetch failed|connection|tcp/i.test(msg);
      if (fallbackBase && isNetwork) {
        console.warn(`[Frizzar] Falha de rede em ${primaryBase} (${msg}). Tentando fallback ${fallbackBase}.`);
        return await tryFetch(fallbackBase);
      }
      throw err;
    }
  };


  console.log(`[Frizzar] base primária=${primaryBase} | fallback=${fallbackBase ?? "(nenhum)"}`);

  const normalizePhone = (raw: string): string => {
    let tel = (raw || "").replace(/\D/g, "");
    // remove DDI 55 se vier no número (a API espera ddi separado)
    if (tel.startsWith("55") && tel.length >= 12) tel = tel.substring(2);
    return tel;
  };

  try {
    switch (funcName) {
      case "buscar_cliente": {
        const tel = normalizePhone(args.telefone);
        const ddi = args.ddi || 55;
        const path = `/buscar/cliente/${tel}/${ddi}`;
        const res = await frizzarFetch(path, { headers });
        const text = await res.text();
        console.log(`[Frizzar] buscar_cliente response (${res.status}):`, text.slice(0, 400));
        if (res.status === 404) {
          return { notFound: true, message: "Cliente não encontrado. Use cadastrar_cliente." };
        }
        if (transientStatuses.has(res.status)) {
          return {
            error: "Falha transitória ao consultar o cliente. NÃO mencione erro, sistema, instabilidade ou tente de novo ao cliente. Chame a ferramenta de escalar humano se existir; caso contrário responda APENAS: 'Só um instante, vou avisar o responsável pra te atender por aqui 🙏' e não prossiga com o fluxo.",
            upstreamStatus: res.status,
            retryable: true,
          };
        }
        try { return JSON.parse(text); } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }


      case "cadastrar_cliente": {
        const tel = normalizePhone(args.telefone);
        const body = {
          nome: args.nome,
          telefone: tel,
          ddi: args.ddi || 55,
        };
        console.log(`[Frizzar] cadastrar_cliente body:`, JSON.stringify(body));
        const res = await frizzarFetch(`/cadastrar/cliente`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify(body),
        });
        const text = await res.text();
        console.log(`[Frizzar] cadastrar_cliente response (${res.status}):`, text.slice(0, 400));
        try { return JSON.parse(text); } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "buscar_agendamentos": {
        const res = await frizzarFetch(`/buscar/agendamentos/${args.clienteId}`, { headers });
        const text = await res.text();
        console.log(`[Frizzar] buscar_agendamentos response (${res.status}):`, text.slice(0, 400));
        try { return JSON.parse(text); } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "listar_servicos": {
        const res = await frizzarFetch(`/listar/servicos`, { headers });
        const text = await res.text();
        console.log(`[Frizzar] listar_servicos response (${res.status}):`, text.slice(0, 600));
        try { return JSON.parse(text); } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "listar_profissionais": {
        const body = Array.isArray(args.servicos) ? args.servicos : [];
        if (body.length === 0) {
          return { error: "Forneça ao menos um serviço em 'servicos': [{codigo: N}]" };
        }
        console.log(`[Frizzar] listar_profissionais body:`, JSON.stringify(body));
        const res = await frizzarFetch(`/listar/profissionais`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify(body),
        });
        const text = await res.text();
        console.log(`[Frizzar] listar_profissionais response (${res.status}):`, text.slice(0, 600));
        let parsed: any;
        try { parsed = JSON.parse(text); } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
        // A API filtra por disponibilidade nas próximas horas — fora do expediente retorna [].
        // Quando vazio, oriente a IA a perguntar uma data específica e seguir para listar_horarios.
        if (Array.isArray(parsed) && parsed.length === 0) {
          return {
            profissionais: [],
            aviso: "Nenhum profissional com horário livre nas próximas horas (a API filtra por disponibilidade imediata). Pergunte ao cliente uma DATA específica (ex.: amanhã, sexta, 30/04) e tente listar_horarios para cada profissional conhecido, ou peça ao cliente o nome do profissional preferido.",
          };
        }
        return parsed;
      }

      case "listar_horarios": {
        const body = Array.isArray(args.servicos) ? args.servicos : [];
        if (!args.profissionalId || !args.data || body.length === 0) {
          return { error: "Faltam parâmetros: profissionalId, data (yyyy-MM-dd) e servicos." };
        }
        const path = `/listar/horarios/${args.profissionalId}/${args.data}`;
        console.log(`[Frizzar] listar_horarios body:`, JSON.stringify(body));
        const res = await frizzarFetch(path, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify(body),
        });
        const text = await res.text();
        console.log(`[Frizzar] listar_horarios response (${res.status}):`, text.slice(0, 600));
        try {
          const parsed = JSON.parse(text);
          // A Frizzar devolve um array com vários dias: [{dia, horariosLivres: ["08:00", ...]}, ...]
          // Normalizamos de forma ESTRITA: expomos somente a data solicitada.
          // Não enviamos outros dias para o modelo para evitar confusão/fabricação de horários.
          if (Array.isArray(parsed)) {
            // 🚨 Match EXATO da data pedida. Se a Frizzar não retornar o dia solicitado,
            // NÃO assuma parsed[0] (geralmente é o próximo dia disponível) — devolva vazio.
            const exato = parsed.find((d: any) => typeof d?.dia === "string" && d.dia.startsWith(args.data));
            if (exato && args.profissionalId) {
              frizzarLastListed.set(lastListedKey(args.profissionalId), { dia: args.data, listedAt: Date.now() });
            }
            return {
              data: args.data,
              diaSolicitadoEncontrado: Boolean(exato),
              horariosLivres: Array.isArray(exato?.horariosLivres) ? exato.horariosLivres : [],
              aviso: exato
                ? undefined
                : `A API não retornou a data ${args.data}; trate como sem horários nessa data e pergunte qual outro dia consultar.`,
            };
          }
          return parsed;
        } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "listar_horarios_geral": {
        const body = Array.isArray(args.servicos) ? args.servicos : [];
        const profs = Array.isArray(args.profissionais) ? args.profissionais : [];
        if (profs.length === 0 || !args.data || body.length === 0) {
          return { error: "Faltam parâmetros: profissionais (array com codigo), data (yyyy-MM-dd) e servicos." };
        }
        console.log(`[Frizzar] listar_horarios_geral data=${args.data} profs=${profs.map((p: any) => p.codigo).join(",")}`);

        const consultaUm = async (prof: any) => {
          const profissionalId = prof?.codigo;
          const nome = prof?.nome ?? null;
          if (!profissionalId) return { profissionalId: null, nome, erro: "codigo ausente", horariosLivres: [], diaSolicitadoEncontrado: false };
          try {
            const res = await frizzarFetch(`/listar/horarios/${profissionalId}/${args.data}`, {
              method: "POST",
              headers: jsonHeaders,
              body: JSON.stringify(body),
            });
            const text = await res.text();
            if (!res.ok) return { profissionalId, nome, erro: `status ${res.status}`, horariosLivres: [], diaSolicitadoEncontrado: false };
            const parsed = JSON.parse(text);
            if (!Array.isArray(parsed)) return { profissionalId, nome, horariosLivres: [], diaSolicitadoEncontrado: false, raw: parsed };
            // 🚨 Match EXATO. Sem fallback pra parsed[0] (que vira o próximo dia disponível)
            // e sem expor outros dias ao modelo.
            const exato = parsed.find((d: any) => typeof d?.dia === "string" && d.dia.startsWith(args.data));
            if (exato) {
              frizzarLastListed.set(lastListedKey(profissionalId), { dia: args.data, listedAt: Date.now() });
            }
            return {
              profissionalId,
              nome,
              data: args.data,
              diaSolicitadoEncontrado: Boolean(exato),
              horariosLivres: Array.isArray(exato?.horariosLivres) ? exato.horariosLivres : [],
            };
          } catch (e: any) {
            return { profissionalId, nome, erro: String(e?.message || e), horariosLivres: [], diaSolicitadoEncontrado: false };
          }
        };

        const resultados = await Promise.all(profs.map(consultaUm));
        const comHorario = resultados.filter((r: any) => Array.isArray(r.horariosLivres) && r.horariosLivres.length > 0);
        // Horários únicos consolidados (qualquer profissional) para a IA reconhecer o pool total.
        const horariosConsolidados = Array.from(new Set(
          comHorario.flatMap((r: any) => r.horariosLivres)
        )).sort();

        let resumo: string;
        if (comHorario.length === 0) {
          resumo = `Nenhum profissional com vaga em ${args.data}. Pergunte qual outro dia o cliente quer consultar; não sugira horários de outra data sem nova busca.`;
        } else if (comHorario.length === 1) {
          resumo = `Apenas 1 profissional livre em ${args.data}: ${comHorario[0].nome || comHorario[0].profissionalId}. NÃO pergunte preferência — proponha direto os horários dele.`;
        } else {
          resumo = `${comHorario.length} profissionais livres em ${args.data}. Se a agenda estiver cheia de opções, pergunte se há preferência; se o cliente já disse o horário desejado, escolha sem perguntar.`;
        }

        return {
          data: args.data,
          resumo,
          totalProfissionaisLivres: comHorario.length,
          horariosConsolidados,
          profissionais: resultados,
        };
      }

      case "agendar": {
        const body = Array.isArray(args.servicos) ? args.servicos : [];

        if (!args.clienteId || !args.dia || !args.hora || !args.profissionalId || body.length === 0) {
          return { error: "Faltam parâmetros: clienteId, dia, hora, profissionalId, servicos." };
        }

        // 🚨 TRAVA DE DATA: valida que `dia` bate com a última `listar_horarios` para este profissional.
        // Evita o bug em que a IA lista para 27 e tenta agendar 28 (ou vice-versa).
        const lastListed = frizzarLastListed.get(lastListedKey(args.profissionalId));
        if (lastListed && Date.now() - lastListed.listedAt < 30 * 60 * 1000 && lastListed.dia !== args.dia) {
          console.warn(`[Frizzar] BLOQUEIO data divergente: listada=${lastListed.dia} vs agendar=${args.dia} (prof=${args.profissionalId}, phone=${_phoneNumber})`);
          return {
            error: `Data divergente: você listou horários para ${lastListed.dia} mas tentou agendar em ${args.dia}. Confirme a data com o cliente e chame listar_horarios para a data correta ANTES de chamar agendar.`,
            ultimaDataListada: lastListed.dia,
            diaSolicitado: args.dia,
            profissionalId: args.profissionalId,
          };
        }


        // Helper: busca horários livres do profissional naquele dia (valida/devolve opções).
        const fetchHorariosLivres = async (): Promise<{ checked: boolean; horariosLivres: string[]; outrosDias: Array<{ dia: string; horariosLivres: string[] }> }> => {
          try {
            const hRes = await frizzarFetch(`/listar/horarios/${args.profissionalId}/${args.dia}`, {
              method: "POST",
              headers: jsonHeaders,
              body: JSON.stringify(body),
            });
            const hTxt = await hRes.text();
            const hParsed = JSON.parse(hTxt);
            if (Array.isArray(hParsed)) {
              // 🚨 Match EXATO — sem fallback pra parsed[0].
              const entry = hParsed.find((d: any) => typeof d?.dia === "string" && d.dia.startsWith(args.dia));
              return {
                checked: true,
                horariosLivres: Array.isArray(entry?.horariosLivres) ? entry.horariosLivres : [],
                outrosDias: hParsed
                  .filter((d: any) => d !== entry)
                  .map((d: any) => ({
                    dia: typeof d?.dia === "string" ? d.dia.slice(0, 10) : String(d?.dia ?? ""),
                    horariosLivres: Array.isArray(d?.horariosLivres) ? d.horariosLivres : [],
                  })),
              };
            }
          } catch { /* ignore */ }
          return { checked: false, horariosLivres: [], outrosDias: [] };
        };

        // Pré-validação: evita 500 quando o horário não está na grade livre.
        const disponibilidadePre = await fetchHorariosLivres();
        const horariosLivresPre = disponibilidadePre.horariosLivres;
        if (disponibilidadePre.checked && horariosLivresPre.length === 0) {
          return {
            error: `Sem vagas disponíveis em ${args.dia} para este profissional. NÃO peça confirmação e NÃO tente agendar nessa data. Ofereça outro dia ou opções de outrosDias.`,
            horariosLivres: [],
            outrosDias: disponibilidadePre.outrosDias,
            dia: args.dia,
            profissionalId: args.profissionalId,
          };
        }
        if (disponibilidadePre.checked && !horariosLivresPre.includes(args.hora)) {
          return {
            error: `Horário ${args.hora} indisponível em ${args.dia} para o profissional. Escolha um dos horários livres abaixo e tente novamente.`,
            horariosLivres: horariosLivresPre,
            outrosDias: disponibilidadePre.outrosDias,
            dia: args.dia,
            profissionalId: args.profissionalId,
          };
        }

        const path = `/agendar/cliente/${args.clienteId}/dia/${args.dia}/hora/${args.hora}/profissional/${args.profissionalId}`;
        console.log(`[Frizzar] agendar body:`, JSON.stringify(body));
        const res = await frizzarFetch(path, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify(body),
        });
        const text = await res.text();
        console.log(`[Frizzar] agendar response (${res.status}):`, text.slice(0, 600));
        if (res.status === 403) {
          return { error: "Cliente bloqueado ou limite de agendamentos atingido." };
        }
        // 500 / corpo vazio normalmente = slot indisponível ou conflito — devolve opções.
        if (!res.ok || !text.trim()) {
          const disponibilidadeAtual = horariosLivresPre.length > 0 ? disponibilidadePre : await fetchHorariosLivres();
          return {
            error: `Frizzar recusou o agendamento (status ${res.status}). Provavelmente o horário ${args.hora} acabou de ser ocupado ou é inválido. Ofereça um dos horários livres abaixo.`,
            horariosLivres: disponibilidadeAtual.horariosLivres,
            outrosDias: disponibilidadeAtual.outrosDias,
            dia: args.dia,
            profissionalId: args.profissionalId,
          };
        }
        try {
          const parsed = JSON.parse(text);
          // A Frizzar devolve um array de agendamentos criados (1 entrada por serviço).
          // Normalizamos para o agente: agendamentoId explícito + resumo amigável.
          if (Array.isArray(parsed) && parsed.length > 0) {
            const primeiro = parsed[0];
            return {
              ok: true,
              agendamentoId: primeiro?.codigo,
              inicioFormatado: primeiro?.inicioFormatado,
              profissional: primeiro?.funcionarioNome,
              servico: primeiro?.servicoNome,
              total: primeiro?.totalComanda,
              status: primeiro?.status,
              agendamentos: parsed,
            };
          }
          return parsed;
        } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "cancelar_agendamento": {
        const res = await frizzarFetch(`/cancelaragendamento/${args.agendamentoId}`, { headers });
        const text = await res.text();
        console.log(`[Frizzar] cancelar_agendamento response (${res.status}):`, text.slice(0, 400));
        try {
          const parsed = JSON.parse(text);
          if (parsed?.status === 405) {
            return { ...parsed, message: "Agendamento já realizado — não pode ser cancelado." };
          }
          return parsed;
        } catch {
          return { error: `Status ${res.status}`, raw: text.slice(0, 200) };
        }
      }

      default:
        return { error: `Ferramenta Frizzar desconhecida: ${funcName}` };
    }
  } catch (error) {
    console.error(`[Frizzar] tool error (${funcName}):`, error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { error: `Erro ao executar ${funcName}: ${errorMessage}` };
  }
}

// ===================== BEMP PROMPT SECTION =====================


// ===================== BEMP TOOLS DEFINITION =====================

function buildBempTools(tenant: any) {
  if (!tenant.bemp_domain || !tenant.bemp_token) return undefined;

  return [
    {
      type: "function",
      function: {
        name: "listar_unidades",
        description: "Lista todas as unidades (salões) disponíveis. Se retornar apenas uma, use direto sem perguntar ao cliente.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "listar_servicos",
        description: "Lista os serviços disponíveis para uma unidade específica.",
        parameters: {
          type: "object",
          properties: {
            salonId: { type: "number", description: "ID da unidade (vem de listar_unidades)" },
          },
          required: ["salonId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "listar_profissionais",
        description: "Lista profissionais disponíveis para uma unidade + serviço. No Bemp, rode SEMPRE antes de listar_horarios e antes de agendar, porque professionalId é obrigatório.",
        parameters: {
          type: "object",
          properties: {
            salonId: { type: "number" },
            serviceId: { type: "number" },
          },
          required: ["salonId", "serviceId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "listar_horarios",
        description: "Lista horários disponíveis para uma unidade + serviço + data. No Bemp, professionalId é OBRIGATÓRIO para gerar slots válidos para agendamento.",
        parameters: {
          type: "object",
          properties: {
            salonId: { type: "number" },
            serviceId: { type: "number" },
            data: { type: "string", description: "Data no formato yyyy-MM-dd" },
            professionalId: { type: "number", description: "OBRIGATÓRIO. Vem de listar_profissionais." },
          },
          required: ["salonId", "serviceId", "data", "professionalId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "consultar_cliente",
        description: "Verifica se o telefone do cliente atual já tem cadastro Bemp. Retorna nome e dados se existir.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "listar_agendamentos",
        description: "Lista agendamentos abertos do cliente atual (identificado pelo telefone).",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "agendar",
        description: "Cria um agendamento. ⚠️ professionalId é OBRIGATÓRIO — antes de chamar, rode listar_profissionais e (se houver mais de 1) confirme com o cliente qual ele prefere; em seguida rode listar_horarios COM professionalId e use o slot exato retornado. Telefone do cliente é injetado automático.",
        parameters: {
          type: "object",
          properties: {
            salonId: { type: "number" },
            serviceId: { type: "number" },
            professionalId: { type: "number", description: "OBRIGATÓRIO. Vem de listar_profissionais." },
            start: { type: "string", description: "Início do horário em ISO 8601 com timezone -03:00 (ex: 2026-04-29T13:30:00.000-03:00)" },
            end: { type: "string", description: "Fim do horário em ISO 8601 com timezone -03:00" },
            name: { type: "string", description: "Nome completo do cliente" },
          },
          required: ["salonId", "serviceId", "professionalId", "start", "end", "name"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "cancelar_agendamento",
        description: "Cancela um agendamento aberto do cliente atual pelo ID. Pegue o ID em listar_agendamentos.",
        parameters: {
          type: "object",
          properties: {
            agendamentoId: { type: "number", description: "ID do agendamento (campo `id` retornado por listar_agendamentos)" },
          },
          required: ["agendamentoId"],
        },
      },
    },
  ];
}

// ===================== BEMP TOOL EXECUTION =====================

async function executeBempTool(tenant: any, toolCall: any, phoneNumber?: string): Promise<any> {
  const rawFuncName = toolCall.function.name;
  let args: any = {};
  try { args = JSON.parse(toolCall.function.arguments || "{}"); } catch { /* empty */ }

  const funcName = ({
    buscar_cliente: "consultar_cliente",
    buscar_servicos: "listar_servicos",
    buscar_barbeiros: "listar_profissionais",
    buscar_barbeiros_por_servico: "listar_profissionais",
    buscar_horarios: "listar_horarios",
    buscar_horarios_disponiveis: "listar_horarios",
    buscar_agendamento: "listar_agendamentos",
    buscar_agendamentos: "listar_agendamentos",
    criar_agendamento: "agendar",
    desmarcar_agendamento: "cancelar_agendamento",
  } as Record<string, string>)[rawFuncName] || rawFuncName;

  if (funcName !== rawFuncName) {
    console.log(`[Bemp] alias mapped: ${rawFuncName} -> ${funcName}`);
  }

  const domain = (tenant.bemp_domain || "").trim().replace(/^https?:\/\//, "").replace(/\.bemp\.app.*$/, "").replace(/\/.*$/, "");
  const token = (tenant.bemp_token || "").trim();
  if (!domain || !token) {
    return { error: "Bemp não está configurado para este estabelecimento (domínio ou token ausente)." };
  }

  const apiBase = `https://${domain}.bemp.app/api`;
  const webhooksBase = `https://webhooks.bemp.app/webhooks`;
  const headers: Record<string, string> = {
    "Authorization": `Token ${token}`,
    "Accept": "application/json",
  };
  const jsonHeaders: Record<string, string> = { ...headers, "Content-Type": "application/json" };

  // Telefone do cliente atual: separar em country/area/number (Brasil DDI 55, DDD 2 dígitos)
  const splitPhone = (raw: string) => {
    const digits = (raw || "").replace(/\D/g, "");
    let rest = digits;
    let country = "55";
    if (rest.startsWith("55") && rest.length >= 12) {
      country = "55";
      rest = rest.substring(2);
    } else if (rest.length >= 11) {
      // assume Brasil sem DDI
      country = "55";
    }
    const area = rest.substring(0, 2);
    const number = rest.substring(2);
    return { country, area, number };
  };
  const phone = splitPhone(phoneNumber || "");

  const bempFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    console.log(`[Bemp] -> ${init?.method || "GET"} ${url}`);
    return await fetch(url, init);
  };

  let cachedSalons: any[] | null = null;
  const fetchBempSalons = async (): Promise<any[]> => {
    if (cachedSalons) return cachedSalons;
    const res = await bempFetch(`${apiBase}/salons`, { headers });
    const text = await res.text();
    console.log(`[Bemp] fetchBempSalons (${res.status}):`, text.slice(0, 400));
    try {
      const data = JSON.parse(text);
      cachedSalons = Array.isArray(data) ? data : [];
    } catch {
      cachedSalons = [];
    }
    return cachedSalons;
  };

  const resolveBempSalonId = async (rawSalonId: unknown) => {
    const salons = await fetchBempSalons();
    const requestedSalonId = toPositiveInteger(rawSalonId);

    if (requestedSalonId && salons.some((salon: any) => Number(salon?.id) === requestedSalonId)) {
      return { salonId: requestedSalonId, corrected: false, salons };
    }

    if (salons.length === 1) {
      const onlySalonId = toPositiveInteger(salons[0]?.id);
      if (onlySalonId) {
        console.log(`[Bemp] auto-corrected salonId ${requestedSalonId ?? "null"} -> ${onlySalonId}`);
        return { salonId: onlySalonId, corrected: requestedSalonId !== onlySalonId, salons };
      }
    }

    return {
      salonId: null,
      corrected: false,
      salons,
      error: requestedSalonId
        ? `salonId ${requestedSalonId} inválido para este domínio Bemp.`
        : "salonId é obrigatório na Bemp.",
      blocked: true,
      message: "Chame listar_unidades e use um salonId real retornado pela Bemp.",
      unidades_disponiveis: salons.map((salon: any) => ({ id: salon.id, name: salon.name })),
    };
  };

  try {
    switch (funcName) {
      case "listar_unidades": {
        const res = await bempFetch(`${apiBase}/salons`, { headers });
        const text = await res.text();
        console.log(`[Bemp] listar_unidades (${res.status}):`, text.slice(0, 400));
        try {
          const data = JSON.parse(text);
          if (Array.isArray(data)) {
            cachedSalons = data;
            return data.map((s: any) => ({ id: s.id, name: s.name, address: s.address, phone: s.phone }));
          }
          return data;
        } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "listar_servicos": {
        const salonResolution = await resolveBempSalonId(args.salonId);
        if (!salonResolution.salonId) return salonResolution;
        args.salonId = salonResolution.salonId;
        const res = await bempFetch(`${apiBase}/salons/${args.salonId}/services`, { headers });
        const text = await res.text();
        console.log(`[Bemp] listar_servicos (${res.status}):`, text.slice(0, 600));
        try {
          const data = JSON.parse(text);
          if (Array.isArray(data)) {
            return data.map((s: any) => ({
              id: s.id,
              name: s.name,
              duration_minutes: s.duration ? Math.round(s.duration / 60) : null,
              price: s.price,
              price_text: s.price_currency,
              group: s.group?.name,
            }));
          }
          return data;
        } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "listar_profissionais": {
        const salonResolution = await resolveBempSalonId(args.salonId);
        if (!salonResolution.salonId) return salonResolution;
        args.salonId = salonResolution.salonId;
        if (!args.serviceId) return { error: "Falta serviceId." };
        const res = await bempFetch(`${apiBase}/salons/${args.salonId}/services/${args.serviceId}/professionals`, { headers });
        const text = await res.text();
        console.log(`[Bemp] listar_profissionais (${res.status}):`, text.slice(0, 600));
        try {
          const data = JSON.parse(text);
          if (Array.isArray(data)) {
            return data.map((p: any) => ({ id: p.id, name: p.name }));
          }
          return data;
        } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "listar_horarios": {
        const salonResolution = await resolveBempSalonId(args.salonId);
        if (!salonResolution.salonId) return salonResolution;
        args.salonId = salonResolution.salonId;
        if (!args.serviceId || !args.data) {
          return { error: "Faltam salonId, serviceId e/ou data (yyyy-MM-dd)." };
        }
        if (!args.professionalId) {
          return {
            error: "professionalId é obrigatório para listar_horarios na Bemp.",
            blocked: true,
            message: "Antes de listar horários, chame listar_profissionais, use um professionalId real do retorno e só então rode listar_horarios.",
          };
        }
        const url = `${apiBase}/salons/${args.salonId}/services/${args.serviceId}/professionals/${args.professionalId}/slots/${args.data}`;
        const res = await bempFetch(url, { headers });
        const text = await res.text();
        console.log(`[Bemp] listar_horarios (${res.status}):`, text.slice(0, 600));
        try { return JSON.parse(text); } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "consultar_cliente": {
        if (!phone.number) return { error: "Telefone do cliente atual indisponível." };
        const url = `${webhooksBase}/whatsapp_customer?phone_country_code=${phone.country}&phone_area_code=${phone.area}&phone_number=${phone.number}`;
        const res = await bempFetch(url, { headers });
        const text = await res.text();
        console.log(`[Bemp] consultar_cliente (${res.status}):`, text.slice(0, 400));
        if (res.status === 404) return { notFound: true, message: "Cliente ainda não tem cadastro Bemp — será criado automaticamente ao agendar." };
        try { return JSON.parse(text); } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "listar_agendamentos": {
        if (!phone.number) return { error: "Telefone do cliente atual indisponível." };
        const url = `${webhooksBase}/whatsapp_schedule?phone_country_code=${phone.country}&phone_area_code=${phone.area}&phone_number=${phone.number}`;
        const res = await bempFetch(url, { headers });
        const text = await res.text();
        console.log(`[Bemp] listar_agendamentos (${res.status}):`, text.slice(0, 600));
        try { return JSON.parse(text); } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "agendar": {
        const salonResolution = await resolveBempSalonId(args.salonId);
        if (!salonResolution.salonId) return salonResolution;
        args.salonId = salonResolution.salonId;
        if (!args.serviceId || !args.start || !args.end || !args.name) {
          return { error: "Faltam parâmetros: salonId, serviceId, start, end, name." };
        }
        if (!phone.number) return { error: "Telefone do cliente atual indisponível para agendar." };

        // professional_id é OBRIGATÓRIO na Bemp. Se não veio, tenta usar a seleção persistida;
        // se ainda não houver, tenta auto-resolver apenas quando existir UM único profissional real.
        let professionalId = args.professionalId;
        if (!professionalId) {
          try {
            const profRes = await bempFetch(`${apiBase}/salons/${args.salonId}/services/${args.serviceId}/professionals`, { headers });
            const profText = await profRes.text();
            const profs = JSON.parse(profText);
            if (Array.isArray(profs) && profs.length === 1) {
              professionalId = profs[0].id;
              console.log(`[Bemp] agendar auto-resolved professionalId=${professionalId} (único)`);
            } else if (Array.isArray(profs) && profs.length > 1) {
              return {
                error: "professional_id é obrigatório.",
                blocked: true,
                message: "Antes de agendar, chame listar_profissionais e peça ao cliente para escolher um profissional. Em seguida chame listar_horarios COM professionalId e use o slot dessa resposta.",
                profissionais_disponiveis: profs.map((p: any) => ({ id: p.id, name: p.name })),
              };
            } else {
              return { error: "Nenhum profissional disponível para este serviço.", blocked: true };
            }
          } catch (e) {
            return { error: "Falha ao resolver profissional automaticamente. Chame listar_profissionais explicitamente.", blocked: true };
          }
        }

        const body: Record<string, unknown> = {
          salon_id: args.salonId,
          service_id: args.serviceId,
          professional_id: professionalId,
          start: args.start,
          end: args.end,
          name: args.name,
          phone_country_code: phone.country,
          phone_area_code: phone.area,
          phone_number: phone.number,
        };
        console.log(`[Bemp] agendar body:`, JSON.stringify(body));
        const res = await bempFetch(`${webhooksBase}/whatsapp_schedule`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify(body),
        });
        const text = await res.text();
        console.log(`[Bemp] agendar (${res.status}):`, text.slice(0, 600));

        // Detecção de inadimplência (Bemp + CelCash): se a Bemp recusou por pagamento pendente,
        // devolvemos um erro padronizado para a IA seguir a regra "subscription_overdue".
        const overdueRegex = /pagamento.*pendente|inadimpl|assinatura.*atras|atras.*assinatura|payment.*overdue|subscription.*overdue|em\s+atraso/i;
        if (!res.ok && overdueRegex.test(text)) {
          console.log(`[Bemp] agendar BLOQUEADO por pagamento pendente (cliente inadimplente).`);
          return {
            error: "subscription_overdue",
            blocked: true,
            message: "Cliente está com pagamento pendente na assinatura. NÃO tente agendar de novo. Responda ao cliente: \"Não consegui concluir seu agendamento porque há um pagamento pendente na sua assinatura. Deseja regularizar?\" e aguarde resposta.",
          };
        }

        try {
          const parsed = JSON.parse(text);
          if (res.ok) return { ok: true, ...parsed };
          return { error: `Status ${res.status}`, ...parsed };
        } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "cancelar_agendamento": {
        if (!args.agendamentoId) return { error: "Faltou agendamentoId." };
        if (!phone.number) return { error: "Telefone do cliente atual indisponível." };
        const url = `${webhooksBase}/whatsapp_schedule?phone_country_code=${phone.country}&phone_area_code=${phone.area}&phone_number=${phone.number}&id=${args.agendamentoId}`;
        const res = await bempFetch(url, { method: "DELETE", headers });
        const text = await res.text();
        console.log(`[Bemp] cancelar_agendamento (${res.status}):`, text.slice(0, 400));
        if (res.ok) return { ok: true, message: "Agendamento cancelado." };
        try { return { error: `Status ${res.status}`, ...JSON.parse(text) }; }
        catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      default:
        return { error: `Ferramenta Bemp desconhecida: ${funcName}` };
    }
  } catch (error) {
    console.error(`[Bemp] tool error (${funcName}):`, error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { error: `Erro ao executar ${funcName}: ${errorMessage}` };
  }
}

// ===================== ZAYLO (API ZAYLO) =====================

const ZAYLO_DEFAULT_BASE_URL = "https://fimdhqjzdyktzdijfoub.supabase.co/functions/v1/n8n-appointments";
const ZAYLO_DEFAULT_PUBLISHABLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZpbWRocWp6ZHlrdHpkaWpmb3ViIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ3MDY5MTgsImV4cCI6MjA4MDI4MjkxOH0.bN2RmxR4KbD4RozQ2AB-PHzUaQYKEoYvmKNn3QO9vNQ";


function buildZayloTools(tenant: any) {
  if (!tenant?.zaylo_barbershop_id) return undefined;
  return [
    {
      type: "function",
      function: {
        name: "obter_info",
        description: "OBRIGATÓRIA no primeiro sinal de agenda, preço, serviço, profissional ou disponibilidade. Retorna o catálogo real da clínica na Zaylo: dados, profissionais ativos (barbers) e serviços ativos (services) com UUIDs. Use esta tool ANTES de responder quando o cliente disser algo como 'quero agendar', 'Limpeza', 'quanto custa', 'tem horário'.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "obter_horarios_disponiveis",
        description: "Lista horários LIVRES do profissional para a data informada. Só use depois de já ter barber_id e service_id reais vindos de obter_info. Use APENAS os valores do campo available_times da resposta.",
        parameters: {
          type: "object",
          properties: {
            barber_id: { type: "string", description: "UUID do profissional (de obter_info → barbers[].id)" },
            service_id: { type: "string", description: "UUID do serviço (de obter_info → services[].id)" },
            date: { type: "string", description: "Data YYYY-MM-DD (fuso de Brasília)" },
            service_duration_minutes: { type: "number", description: "Duração do serviço em minutos (de obter_info → services[].duration_minutes). Passe sempre que souber." },
          },
          required: ["barber_id", "service_id", "date"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "criar_agendamento",
        description: "Cria um novo agendamento real na Zaylo. Só use depois de confirmar serviço, profissional, data e um horário EXATO retornado por obter_horarios_disponiveis. O sistema cria/identifica o cliente automaticamente pelo client_phone+client_name.",
        parameters: {
          type: "object",
          properties: {
            barber_id: { type: "string" },
            service_id: { type: "string" },
            date: { type: "string", description: "YYYY-MM-DD" },
            time: { type: "string", description: "HH:MM (exato de available_times)" },
            client_name: { type: "string" },
            client_phone: { type: "string", description: "Telefone com DDI (ex: +5511999998888)" },
            observacoes: { type: "string", description: "Observações opcionais para a clínica" },
          },
          required: ["barber_id", "service_id", "date", "time", "client_name", "client_phone"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "listar_agendamentos",
        description: "Lista agendamentos reais do cliente pelo telefone. Use para consultar, remarcar, confirmar ou cancelar.",
        parameters: {
          type: "object",
          properties: {
            client_phone: { type: "string", description: "Telefone com DDI (ex: +5511999998888)" },
          },
          required: ["client_phone"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "confirmar_agendamento",
        description: "Confirma um agendamento real na Zaylo. Use o appointment_id retornado por listar_agendamentos ou por criar_agendamento.",
        parameters: {
          type: "object",
          properties: {
            appointment_id: { type: "string" },
          },
          required: ["appointment_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "cancelar_agendamento",
        description: "Cancela um agendamento real na Zaylo pelo appointment_id retornado por listar_agendamentos.",
        parameters: {
          type: "object",
          properties: {
            appointment_id: { type: "string" },
            motivo: { type: "string", description: "Motivo do cancelamento (opcional)" },
          },
          required: ["appointment_id"],
        },
      },
    },
  ];
}

async function executeZayloTool(tenant: any, toolCall: any, phoneNumber?: string): Promise<any> {
  const funcName = toolCall.function.name;
  let args: any = {};
  try { args = JSON.parse(toolCall.function.arguments || "{}"); } catch { /* empty */ }

  const barbershopId = (tenant.zaylo_barbershop_id || "").trim();
  if (!barbershopId) return { error: "Zaylo barbershop_id não configurado para este estabelecimento." };

  const baseUrl = ((tenant.zaylo_base_url || "").trim().replace(/\/+$/, "")) || ZAYLO_DEFAULT_BASE_URL;
  const apiKey = (tenant.zaylo_publishable_key || "").trim() || ZAYLO_DEFAULT_PUBLISHABLE_KEY;

  // v2: header é x-api-key (mantém apikey/Authorization para retrocompat com servidores antigos)
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "X-API-Key": apiKey,
    "apikey": apiKey,
    "Authorization": `Bearer ${apiKey}`,
  };

  const normalizePhone = (raw: string): string => {
    let tel = (raw || "").trim();
    if (!tel) return tel;
    tel = tel.replace(/[^\d+]/g, "");
    if (!tel.startsWith("+")) tel = `+${tel}`;
    return tel;
  };

  const pad2 = (n: number) => String(n).padStart(2, "0");
  const toIsoBrasilia = (date: string, time: string): string => {
    // date: YYYY-MM-DD, time: HH:MM → "YYYY-MM-DDTHH:MM:00-03:00"
    const d = (date || "").trim();
    const t = (time || "").trim();
    if (!d || !t) return "";
    const [h, m] = t.split(":");
    return `${d}T${pad2(Number(h))}:${pad2(Number(m))}:00-03:00`;
  };

  const callZaylo = async (payload: Record<string, any>): Promise<any> => {
    console.log(`[Zaylo v2] -> POST ${baseUrl} action=${payload.action}`);
    const res = await fetch(baseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    console.log(`[Zaylo v2] ${payload.action} (${res.status}):`, text.slice(0, 600));
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* keep null */ }
    if (!res.ok) {
      return { error: parsed?.title || `Status ${res.status}`, status: res.status, detail: parsed?.detail || text.slice(0, 300) };
    }
    return parsed ?? { raw: text.slice(0, 300) };
  };

  // Helper: resolve clienteId via upsertClientByPhone (cria se necessário)
  const resolveClienteId = async (phone: string, name?: string): Promise<{ clienteId: string | null; error?: any }> => {
    const tel = normalizePhone(phone);
    if (!tel) return { clienteId: null, error: { error: "Telefone do cliente ausente." } };
    // Se temos nome, upsert direto
    if (name && name.trim()) {
      const r = await callZaylo({
        action: "upsertClientByPhone",
        barbershop_id: barbershopId,
        telefone: tel.replace(/^\+/, ""),
        nome: name.trim(),
      });
      if (r?.error) return { clienteId: null, error: r };
      return { clienteId: r?.id || null };
    }
    // Sem nome: tenta achar via listClients
    const r = await callZaylo({
      action: "listClients",
      barbershop_id: barbershopId,
      search: tel.replace(/^\+/, ""),
      page: 1,
      pageSize: 1,
    });
    if (r?.error) return { clienteId: null, error: r };
    const id = r?.items?.[0]?.id || null;
    return { clienteId: id };
  };

  try {
    switch (funcName) {
      case "obter_info": {
        // v2: getInfo só retorna dados da empresa. Buscamos em paralelo profissionais e serviços
        // e montamos o shape esperado { establishment, barbers, services }.
        const [est, profs, servs] = await Promise.all([
          callZaylo({ action: "getInfo", barbershop_id: barbershopId }),
          callZaylo({ action: "listProfessionals", barbershop_id: barbershopId }),
          callZaylo({ action: "listServices", barbershop_id: barbershopId }),
        ]);
        const firstErr = [est, profs, servs].find((r) => r?.error);
        if (firstErr) return firstErr;
        return {
          establishment: est,
          barbers: Array.isArray(profs?.items)
            ? profs.items.map((p: any) => ({ id: p.id, name: p.name, specialty: p.specialty }))
            : [],
          services: Array.isArray(servs?.items)
            ? servs.items.map((s: any) => ({
                id: s.id,
                name: s.name,
                description: s.description,
                price: s.price,
                duration_minutes: s.duration_minutes,
              }))
            : [],
        };
      }

      case "obter_horarios_disponiveis": {
        // v2: listProfessionalsWithAgenda (alias getAvailableTimes)
        const duration = Number(args.service_duration_minutes) > 0 ? Number(args.service_duration_minutes) : 30;
        const payload: Record<string, any> = {
          action: "listProfessionalsWithAgenda",
          barbershop_id: barbershopId,
          data: args.date,
          servicoDuracao: duration,
          professionalId: args.barber_id,
        };
        if (args.service_id) payload.servicoId = args.service_id;
        const r = await callZaylo(payload);
        if (r?.error) return r;
        // Achata: pega slots do profissional solicitado (ou o primeiro)
        const profs = Array.isArray(r?.profissionais) ? r.profissionais : [];
        const target = profs.find((p: any) => p?.id === args.barber_id) || profs[0];
        const slots = Array.isArray(target?.slots) ? target.slots : [];
        return {
          date: r?.data || args.date,
          barber_id: target?.id || args.barber_id,
          blocked: !!target?.blocked,
          available_times: slots.map((s: any) => s?.time).filter(Boolean),
        };
      }

      case "criar_agendamento": {
        const phone = normalizePhone(args.client_phone || phoneNumber || "");
        const { clienteId, error: cliErr } = await resolveClienteId(phone, args.client_name);
        if (cliErr) return cliErr;
        if (!clienteId) return { error: "Não foi possível identificar/criar o cliente." };
        const iso = toIsoBrasilia(args.date, args.time);
        if (!iso) return { error: "Data/hora inválidas para criar agendamento." };
        const r = await callZaylo({
          action: "createAppointment",
          barbershop_id: barbershopId,
          clienteId,
          dataHoraInicio: iso,
          profissionalId: args.barber_id,
          observacoes: args.observacoes,
          confirmado: true,
          source: "whatsapp",
          servicos: [{ servicoId: args.service_id, profissionalId: args.barber_id }],
        });
        if (r?.error) return r;
        return {
          ok: true,
          appointment_id: r?.id,
          appointment_date: iso,
          barber_id: args.barber_id,
          service_id: args.service_id,
        };
      }

      case "listar_agendamentos": {
        const phone = normalizePhone(args.client_phone || phoneNumber || "");
        const { clienteId, error: cliErr } = await resolveClienteId(phone);
        if (cliErr) return cliErr;
        if (!clienteId) return { items: [], total: 0, note: "Cliente ainda não cadastrado." };
        const r = await callZaylo({
          action: "listAppointments",
          barbershop_id: barbershopId,
          clienteId,
          page: 1,
          pageSize: 20,
        });
        if (r?.error) return r;
        return r;
      }

      case "confirmar_agendamento": {
        if (!args.appointment_id) return { error: "appointment_id é obrigatório." };
        return await callZaylo({
          action: "confirmAppointment",
          appointment_id: args.appointment_id,
        });
      }

      case "cancelar_agendamento": {
        if (!args.appointment_id) return { error: "appointment_id é obrigatório." };
        return await callZaylo({
          action: "cancelAppointment",
          appointment_id: args.appointment_id,
          motivo: args.motivo || "Cancelado via WhatsApp",
        });
      }

      default:
        return { error: `Ferramenta Zaylo desconhecida: ${funcName}` };
    }
  } catch (error) {
    console.error(`[Zaylo] tool error (${funcName}):`, error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { error: `Erro ao executar ${funcName}: ${errorMessage}` };
  }
}

// ===================== APPBARBER PROVIDER =====================

const APPBARBER_DEFAULT_BASE_URL = "https://proxy.zayloia.com";


function buildAppBarberTools(tenant: any) {
  if (!tenant?.appbarber_api_key || !tenant?.appbarber_establishment_code) return undefined;
  return [
    {
      type: "function",
      function: {
        name: "listar_servicos",
        description: "OBRIGATÓRIA no primeiro sinal de agendar/preço/serviço. Retorna o catálogo real de serviços do estabelecimento (service_code, service_description, service_interval em minutos, service_value).",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "listar_profissionais",
        description: "Lista todos os profissionais reais do estabelecimento via /v1/professional-list (professional_code/employee_code e nome). Use antes de consultar disponibilidade.",
        parameters: {
          type: "object",
          properties: {
            service_code: { type: "number", description: "Opcional — service_code obtido em listar_servicos, mantido apenas para compatibilidade." },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "listar_horarios",
        description: "Lista horários LIVRES para um serviço, profissional e data. professional_code é obrigatório; use APENAS os horários retornados em available_times.",
        parameters: {
          type: "object",
          properties: {
            service_code: { type: "number" },
            start_date: { type: "string", description: "Data YYYY-MM-DD" },
            professional_code: { type: "number", description: "professional_code/employee_code retornado por listar_profissionais" },
          },
          required: ["service_code", "professional_code", "start_date"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "listar_horarios_geral",
        description: "ATALHO RECOMENDADO: consulta horários LIVRES de TODOS os profissionais ao mesmo tempo (executa /v1/availability em paralelo) para um serviço e data. Use logo após listar_servicos para já ter a agenda consolidada ANTES de perguntar preferência de profissional. Retorna { resumo, totalProfissionaisLivres, horariosConsolidados, profissionais: [{ professional_code, name, available_times }] }.",
        parameters: {
          type: "object",
          properties: {
            service_code: { type: "number" },
            start_date: { type: "string", description: "Data YYYY-MM-DD" },
            professionals: {
              type: "array",
              description: "Opcional. Lista de profissionais a consultar [{ professional_code, name }]. Se omitido, o servidor busca automaticamente todos via /v1/professional-list.",
              items: {
                type: "object",
                properties: {
                  professional_code: { type: "number" },
                  name: { type: "string" },
                },
                required: ["professional_code"],
              },
            },
          },
          required: ["service_code", "start_date"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "criar_agendamento",
        description: "Cria o agendamento real no AppBarber. Só use depois de confirmar serviço, profissional, dia e horário EXATO de listar_horarios.",
        parameters: {
          type: "object",
          properties: {
            service_code: { type: "number" },
            professional_code: { type: "number" },
            start_date: { type: "string", description: "YYYY-MM-DD" },
            start_time: { type: "string", description: "HH:MM (exato de available_times)" },
            customer_name: { type: "string" },
            customer_phone: { type: "string", description: "Telefone com DDI (ex: 5561999998888 ou +55...)" },
            service_duration_minutes: { type: "number", description: "Duração em minutos (service_interval retornado por listar_servicos). Obrigatório para evitar rejeição da API." },
            scheduling_observation: { type: "string", description: "Observação opcional. O sistema sempre acrescenta nome e telefone para facilitar busca/cancelamento." },
          },
          required: ["service_code", "professional_code", "start_date", "start_time", "customer_name", "customer_phone", "service_duration_minutes"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "listar_agendamentos",
        description: "Lista comandas/agendamentos do cliente. Use ANTES de cancelar para obter invoice_code ou invoice_item_code. Primeiro consulta /v1/invoice/search por telefone; histórico é só fallback.",
        parameters: {
          type: "object",
          properties: {
            customer_phone: { type: "string", description: "Telefone do cliente (só dígitos, com ou sem DDI 55). Padrão: telefone da conversa." },
            start_date: { type: "string", description: "YYYY-MM-DD — início do período. Padrão: hoje (Brasília)." },
            end_date: { type: "string", description: "YYYY-MM-DD — fim do período (máx 31 dias após start_date). Padrão: hoje + 31 dias." },
            status_type: { type: "number", description: "1=Agendado, 2=Realizado, 3=Cancelado, 4=Bloqueado, 5=Ausente. Padrão: 1 (Agendado)." },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "cancelar_agendamento",
        description: "Cancela o agendamento no AppBarber. SEMPRE chame listar_agendamentos primeiro. Use invoice_code para cancelar a comanda inteira; use invoice_item_code + cancel_scope=item só para remover um serviço específico da comanda.",
        parameters: {
          type: "object",
          properties: {
            invoice_code: { type: "number", description: "invoice_code do agendamento (obtido em listar_agendamentos)." },
            invoice_item_code: { type: "number", description: "Opcional — invoice_item_code obtido em listar_agendamentos para remover apenas um item da comanda." },
            cancel_scope: { type: "string", enum: ["invoice", "item"], description: "Padrão invoice. Use item apenas quando for remover um item específico da comanda." },
            customer_phone: { type: "string", description: "Telefone do cliente (só dígitos). Padrão: telefone da conversa." },
            reason: { type: "string", description: "Motivo do cancelamento (ex: 'Cancelamento solicitado pelo cliente via WhatsApp')." },
          },
          required: [],
        },
      },
    },
  ];
}

async function executeAppBarberTool(tenant: any, toolCall: any, phoneNumber?: string): Promise<any> {
  const funcName = toolCall.function.name;
  let args: any = {};
  try { args = JSON.parse(toolCall.function.arguments || "{}"); } catch { /* empty */ }

  const apiKey = (tenant.appbarber_api_key || "").trim();
  const estCodeRaw = (tenant.appbarber_establishment_code || "").trim();
  const estCode = Number(estCodeRaw);
  if (!apiKey || !estCodeRaw) return { error: "Credenciais AppBarber não configuradas." };


  const baseUrl = ((tenant.appbarber_base_url || "").trim().replace(/\/+$/, "")) || APPBARBER_DEFAULT_BASE_URL;
  const headers: Record<string, string> = {
    "X-API-Key": apiKey,
    "Accept": "application/json",
    "Content-Type": "application/json",
  };

  const buildUrl = (path: string, qs: Record<string, any>): string => {
    const params = new URLSearchParams();
    params.set("establishment_code", estCodeRaw);
    for (const [k, v] of Object.entries(qs)) {
      if (v === undefined || v === null || v === "") continue;
      params.set(k, String(v));
    }
    return `${baseUrl}${path}?${params.toString()}`;
  };

  const callGet = async (path: string, qs: Record<string, any>): Promise<any> => {
    const url = buildUrl(path, qs);
    console.log(`[AppBarber] GET ${url}`);
    const res = await fetch(url, { method: "GET", headers });
    const text = await res.text();
    console.log(`[AppBarber] ${path} (${res.status}):`, text.slice(0, 500));
    let parsed: any = null; try { parsed = JSON.parse(text); } catch { /* keep null */ }
    if (!res.ok) {
      return { error: parsed?.message || parsed?.error || `HTTP ${res.status}`, status: res.status, details: parsed?.details };
    }
    return parsed ?? { raw: text.slice(0, 300) };
  };

  const normalizePhoneDigits = (raw: string): string => {
    let tel = (raw || "").trim().replace(/[^\d]/g, "");
    if (!tel) return "";
    // garante DDI 55 quando for telefone brasileiro sem DDI
    if (tel.length === 10 || tel.length === 11) tel = `55${tel}`;
    return tel;
  };

  const appBarberPhoneVariants = (raw: string): string[] => {
    const full = normalizePhoneDigits(raw);
    const variants = new Set<string>();
    const add = (value: string) => {
      const digits = String(value || "").replace(/\D/g, "");
      if (digits) variants.add(digits);
    };
    add(full);
    const local = full.startsWith("55") && (full.length === 12 || full.length === 13) ? full.slice(2) : full;
    add(local);
    // AppBarber documenta /invoice/search como DDD+número, sem DDI, e bases antigas
    // podem ter celular com ou sem o 9 após o DDD. Testamos as duas formas.
    if (local.length === 10) add(`${local.slice(0, 2)}9${local.slice(2)}`);
    if (local.length === 11 && local[2] === "9") add(`${local.slice(0, 2)}${local.slice(3)}`);
    for (const v of Array.from(variants)) {
      if (!v.startsWith("55") && (v.length === 10 || v.length === 11)) add(`55${v}`);
    }
    return Array.from(variants);
  };

  const extractAppBarberInvoiceList = (payload: any): any[] => {
    const looksLikeInvoice = (value: any) => value && typeof value === "object" && !Array.isArray(value) && (
      value.invoice_code != null || value.invoice_id != null || value.invoiceCode != null ||
      value.comanda_code != null || value.command_code != null ||
      (value.code != null && (value.customer_phone != null || value.client_phone != null || value.invoice_status != null || value.total_value != null || Array.isArray(value.items)))
    );
    const direct = [payload?.data, payload?.result, payload?.invoice, payload];
    for (const candidate of direct) {
      if (Array.isArray(candidate)) return candidate;
      if (looksLikeInvoice(candidate)) return [candidate];
    }
    const containers = [payload?.data, payload?.result, payload];
    const keys = ["invoices", "items", "records", "results", "appointments", "schedules", "data"];
    for (const container of containers) {
      if (!container || typeof container !== "object" || Array.isArray(container)) continue;
      for (const key of keys) {
        if (Array.isArray(container[key])) return container[key];
      }
    }
    return [];
  };

  const extractAppBarberInvoiceItems = (invoice: any): any[] => {
    for (const key of ["items", "invoice_items", "invoiceItems", "services", "service_items", "details"]) {
      if (Array.isArray(invoice?.[key]) && invoice[key].length > 0) return invoice[key];
    }
    return [null];
  };

  const firstValue = (...values: any[]) => values.find((value) => value !== undefined && value !== null && value !== "");
  const digitsOnly = (value: any): string => String(value || "").replace(/\D/g, "");
  const extractPhonesFromText = (value: any): string[] => {
    const text = String(value || "");
    if (!text) return [];
    const matches = text.match(/(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?9?\d{4}[-\s]?\d{4}/g) || [];
    return matches.map(digitsOnly).filter((phone) => phone.length >= 8);
  };
  const phoneCoreMatches = (targetPhone: string, ...recordValues: any[]): boolean => {
    const targetCore = digitsOnly(targetPhone).slice(-8);
    if (!targetCore) return false;
    for (const value of recordValues) {
      const candidates = [digitsOnly(value), ...extractPhonesFromText(value)];
      for (const candidate of candidates) {
        if (candidate && candidate.slice(-8) === targetCore) return true;
      }
    }
    return false;
  };

  const toPositiveNumber = (value: any): number | null => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const normalizeAppBarberStartDateTime = (date: any, time: any): string => {
    const day = String(date || "").trim().slice(0, 10);
    const rawTime = String(time || "").trim();
    const hhmm = rawTime.match(/^(\d{2}:\d{2})/)?.[1] || rawTime.slice(0, 5);
    return `${day} ${hhmm}`;
  };

  const resolveAppBarberServiceDuration = async (serviceCode: any, explicitDuration: any): Promise<number | null> => {
    const direct = toPositiveNumber(explicitDuration);
    if (direct) return direct;

    const r = await callGet("/v1/services", {});
    if (r?.error) return null;
    const items = Array.isArray(r?.data) ? r.data : [];
    const service = items.find((s: any) => Number(firstValue(s.service_code, s.code, s.id)) === Number(serviceCode));
    return toPositiveNumber(firstValue(service?.service_interval, service?.duration_minutes, service?.duration));
  };

  try {
    switch (funcName) {
      case "listar_servicos": {
        const r = await callGet("/v1/services", {});
        if (r?.error) return r;
        const items = Array.isArray(r?.data) ? r.data : [];
        return {
          services: items.map((s: any) => ({
            service_code: s.service_code,
            name: s.service_description,
            duration_minutes: s.service_interval,
            price: s.service_value,
            category_code: s.category_code,
            has_subscription: !!s.has_subscription,
          })),
        };
      }

      case "listar_profissionais": {
        const r = await callGet("/v1/professional-list", {});
        if (r?.error) return r;
        const items = Array.isArray(r?.data) ? r.data : [];
        return {
          professionals: items.map((p: any) => ({
            professional_code: firstValue(p.professional_code, p.employee_code, p.code, p.id),
            employee_code: firstValue(p.employee_code, p.professional_code, p.code, p.id),
            name: firstValue(p.professional_name, p.employee_name, p.employee_nickname, p.name),
            service_duration_minutes: firstValue(p.service_interval, p.professional_interval),
            rating: p.employee_evaluation,
            image: firstValue(p.employee_image, p.professional_image, p.image),
          })),
        };
      }

      case "listar_horarios": {
        if (!args.service_code || !args.professional_code || !args.start_date) return { error: "service_code, professional_code e start_date são obrigatórios." };
        const r = await callGet("/v1/availability", {
          service_code: args.service_code,
          start_date: args.start_date,
          professional_code: args.professional_code,
        });
        if (r?.error) return r;
        const blocks = Array.isArray(r?.data) ? r.data : [];
        const wantedProf = args.professional_code != null ? Number(args.professional_code) : null;
        // ⚠️ Bug conhecido da API: o filtro professional_code é IGNORADO no servidor
        // e a resposta vem com blocos de TODOS os profissionais. Precisamos filtrar
        // localmente pelo employee_code, senão oferecemos horário de outro barbeiro
        // e o POST /appointments retorna 422 "Choque de Horário".
        const filteredBlocks = blocks.filter((b: any) => {
          const prof = firstValue(b?.professional_code, b?.employee_code, b?.professional?.code, b?.employee?.code);
          return prof == null || Number(prof) === wantedProf;
        });
        const seen = new Set<string>();
        const times: string[] = [];
        const collectSlots = (value: any) => {
          if (!value) return;
          if (Array.isArray(value)) { value.forEach(collectSlots); return; }
          if (typeof value !== "object") return;
          const rawTime = firstValue(value.scheduling_time, value.time, value.start_time, value.hour);
          if (rawTime) {
            const str = String(rawTime).trim();
            const normalized = /^\d{2}:\d{2}$/.test(str) ? `${str}:00` : str.slice(0, 8);
            if (/^\d{2}:\d{2}:\d{2}$/.test(normalized) && !seen.has(normalized)) {
              seen.add(normalized);
              times.push(normalized);
            }
          }
          for (const key of ["avaliable", "available", "schedules", "slots", "times", "items"]) {
            if (Array.isArray(value[key])) collectSlots(value[key]);
          }
        };
        for (const block of filteredBlocks) {
          collectSlots(block);
        }
        times.sort();
        if (wantedProf != null && filteredBlocks.length === 0 && blocks.length > 0) {
          // O profissional pedido não aparece na resposta → não trabalha nesse dia
          return {
            date: args.start_date,
            service_code: args.service_code,
            professional_code: wantedProf,
            available_times: [],
            note: "Esse profissional não tem horários nesse dia. Ofereça outra data ou outro profissional.",
          };
        }
        return {
          date: args.start_date,
          service_code: args.service_code,
          professional_code: args.professional_code,
          available_times: times,
        };
      }

      case "listar_horarios_geral": {
        if (!args.service_code || !args.start_date) {
          return { error: "service_code e start_date são obrigatórios." };
        }

        // Resolve lista de profissionais: usa o array recebido ou busca via /v1/professional-list
        let profs: Array<{ professional_code: number; name: string | null }> = [];
        if (Array.isArray(args.professionals) && args.professionals.length > 0) {
          profs = args.professionals
            .map((p: any) => ({
              professional_code: Number(firstValue(p?.professional_code, p?.employee_code, p?.code, p?.id)),
              name: firstValue(p?.name, p?.professional_name, p?.employee_name) ?? null,
            }))
            .filter((p) => Number.isFinite(p.professional_code) && p.professional_code > 0);
        } else {
          const listRes = await callGet("/v1/professional-list", {});
          if (listRes?.error) return listRes;
          const items = Array.isArray(listRes?.data) ? listRes.data : [];
          profs = items
            .map((p: any) => ({
              professional_code: Number(firstValue(p?.professional_code, p?.employee_code, p?.code, p?.id)),
              name: firstValue(p?.professional_name, p?.employee_name, p?.employee_nickname, p?.name) ?? null,
            }))
            .filter((p) => Number.isFinite(p.professional_code) && p.professional_code > 0);
        }

        if (profs.length === 0) {
          return { error: "Nenhum profissional disponível para consultar disponibilidade." };
        }

        console.log(`[AppBarber] listar_horarios_geral data=${args.start_date} svc=${args.service_code} profs=${profs.map((p) => p.professional_code).join(",")}`);

        const collectTimes = (blocks: any[], wantedProf: number): string[] => {
          const seen = new Set<string>();
          const times: string[] = [];
          const filtered = blocks.filter((b: any) => {
            const prof = firstValue(b?.professional_code, b?.employee_code, b?.professional?.code, b?.employee?.code);
            return prof == null || Number(prof) === wantedProf;
          });
          const walk = (value: any) => {
            if (!value) return;
            if (Array.isArray(value)) { value.forEach(walk); return; }
            if (typeof value !== "object") return;
            const rawTime = firstValue(value.scheduling_time, value.time, value.start_time, value.hour);
            if (rawTime) {
              const str = String(rawTime).trim();
              const normalized = /^\d{2}:\d{2}$/.test(str) ? `${str}:00` : str.slice(0, 8);
              if (/^\d{2}:\d{2}:\d{2}$/.test(normalized) && !seen.has(normalized)) {
                seen.add(normalized);
                times.push(normalized);
              }
            }
            for (const key of ["avaliable", "available", "schedules", "slots", "times", "items"]) {
              if (Array.isArray(value[key])) walk(value[key]);
            }
          };
          for (const block of filtered) walk(block);
          times.sort();
          return times;
        };

        const consultaUm = async (prof: { professional_code: number; name: string | null }) => {
          try {
            const r = await callGet("/v1/availability", {
              service_code: args.service_code,
              start_date: args.start_date,
              professional_code: prof.professional_code,
            });
            if (r?.error) {
              return { professional_code: prof.professional_code, name: prof.name, available_times: [], erro: r.error };
            }
            const blocks = Array.isArray(r?.data) ? r.data : [];
            const available_times = collectTimes(blocks, prof.professional_code);
            return { professional_code: prof.professional_code, name: prof.name, available_times };
          } catch (e: any) {
            return { professional_code: prof.professional_code, name: prof.name, available_times: [], erro: String(e?.message || e) };
          }
        };

        const resultados = await Promise.all(profs.map(consultaUm));
        const comHorario = resultados.filter((r) => Array.isArray(r.available_times) && r.available_times.length > 0);

        // Horários consolidados → mapa hora → profissionais livres naquele horário
        const horariosMap = new Map<string, Array<{ professional_code: number; name: string | null }>>();
        for (const r of comHorario) {
          for (const t of r.available_times) {
            const hhmm = t.slice(0, 5);
            if (!horariosMap.has(hhmm)) horariosMap.set(hhmm, []);
            horariosMap.get(hhmm)!.push({ professional_code: r.professional_code, name: r.name });
          }
        }
        const horariosConsolidados = Array.from(horariosMap.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([time, professionals]) => ({ time, professionals }));

        let resumo: string;
        if (comHorario.length === 0) {
          resumo = `Nenhum profissional com vaga em ${args.start_date}. Ofereça outro dia — NÃO pergunte preferência de profissional.`;
        } else if (comHorario.length === 1) {
          resumo = `Apenas 1 profissional livre em ${args.start_date}: ${comHorario[0].name || comHorario[0].professional_code}. NÃO pergunte preferência — proponha direto os horários dele.`;
        } else {
          resumo = `${comHorario.length} profissionais livres em ${args.start_date}. Se o cliente já disse o horário, escolha um profissional disponível sem perguntar; senão ofereça os horariosConsolidados.`;
        }

        return {
          date: args.start_date,
          service_code: Number(args.service_code),
          resumo,
          totalProfissionaisLivres: comHorario.length,
          horariosConsolidados,
          profissionais: resultados,
        };
      }

      case "criar_agendamento": {
        const phoneDigits = normalizePhoneDigits(args.customer_phone || phoneNumber || "");
        if (!phoneDigits) return { error: "Telefone do cliente é obrigatório." };
        if (!args.service_code || !args.professional_code) return { error: "service_code e professional_code são obrigatórios." };
        if (!args.start_date || !args.start_time) return { error: "start_date e start_time são obrigatórios." };
        const startDateTime = normalizeAppBarberStartDateTime(args.start_date, args.start_time);
        if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(startDateTime)) {
          return { error: "start_date/start_time inválidos. Use start_date YYYY-MM-DD e start_time HH:MM.", recoverable: true };
        }
        const serviceDuration = await resolveAppBarberServiceDuration(args.service_code, args.service_duration_minutes);
        if (!serviceDuration) {
          return { error: "Duração do serviço não encontrada. Chame listar_servicos novamente e use service_interval como service_duration_minutes.", recoverable: true };
        }
        const url = buildUrl("/v1/appointments", {});
        const customerName = String(args.customer_name || "Cliente").trim();
        // Schema real do AppBarber (validado via erro 400):
        // customer_phone: bigint | customer_name: string | start_date: "YYYY-MM-DD HH:MM"
        // professionals: [{ professional_code }] | services: [{ service_code, duration }]
        const body: Record<string, unknown> = {
          establishment_code: Number(estCode),
          customer_phone: Number(phoneDigits),
          customer_name: customerName,
          start_date: startDateTime,
          professionals: [{ professional_code: Number(args.professional_code) }],
          services: [{ service_code: Number(args.service_code), duration: serviceDuration }],
          scheduling_observation: `Cliente: ${customerName} | WhatsApp: ${phoneDigits}`,
        };
        console.log(`[AppBarber] POST ${url} body=${JSON.stringify(body)}`);
        const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
        const text = await res.text();
        console.log(`[AppBarber] criar_agendamento (${res.status}):`, text.slice(0, 600));
        let parsed: any = null; try { parsed = JSON.parse(text); } catch { /* keep null */ }
        if (!res.ok) {
          const baseErr = parsed?.message || parsed?.data?.error_type || parsed?.error || `HTTP ${res.status}`;
          if (res.status === 422) {
            return {
              error: `Horário indisponível ou conflito de regra de negócio: ${baseErr}`,
              status: 422,
              recoverable: true,
              hint: "Chame listar_horarios novamente para o mesmo serviço/profissional e ofereça outro horário ao cliente. NÃO escale humano.",
              details: parsed?.data ?? parsed?.details,
            };
          }
          if (res.status === 429) {
            return { error: "Limite de requisições do AppBarber excedido. Aguarde alguns segundos e tente de novo.", status: 429, recoverable: true };
          }
          return { error: baseErr, status: res.status, details: parsed?.data ?? parsed?.details };
        }
        return {
          ok: true,
          appointment_id: parsed?.data?.appointment_code || parsed?.data?.scheduling_code || parsed?.data?.id || parsed?.appointment_code || parsed?.scheduling_code || null,
          start_date: body.start_date,
          service_code: Number(args.service_code),
          professional_code: Number(args.professional_code),
          raw: parsed?.data ?? parsed,
        };
      }

      case "listar_agendamentos": {
        const phoneDigits = normalizePhoneDigits(args.customer_phone || phoneNumber || "");
        // Datas padrão: -7 até +24 dias em Brasília. Cobre agendamentos recém-criados/cancelados
        // e respeita o limite de 31 dias da API AppBarber.
        const nowBrt = new Date(Date.now() - 3 * 60 * 60 * 1000);
        const fmt = (d: Date) => d.toISOString().slice(0, 10);
        const defaultStartDate = fmt(new Date(nowBrt.getTime() - 7 * 24 * 60 * 60 * 1000));
        const requestedStartDate = args.start_date || defaultStartDate;
        const startDate = requestedStartDate > defaultStartDate ? defaultStartDate : requestedStartDate;
        const maxEndFromStart = new Date(new Date(`${startDate}T00:00:00Z`).getTime() + 31 * 24 * 60 * 60 * 1000);
        const requestedEnd = args.end_date ? new Date(`${args.end_date}T00:00:00Z`) : new Date(nowBrt.getTime() + 24 * 24 * 60 * 60 * 1000);
        const endDate = fmt(requestedEnd.getTime() > maxEndFromStart.getTime() ? maxEndFromStart : requestedEnd);
        const statusType = args.status_type ?? 1;
        const phoneVariants = appBarberPhoneVariants(args.customer_phone || phoneNumber || "");
        const searchVariants = phoneVariants;
        const invoiceItems: any[] = [];
        const triedInvoicePhones: string[] = [];
        const invoiceSearchDiagnostics: any[] = [];
        for (const customerPhone of searchVariants.length ? searchVariants : phoneVariants) {
          triedInvoicePhones.push(customerPhone);
          const invoiceResult = await callGet("/v1/invoice/search", { customer_phone: customerPhone });
          if (invoiceResult?.error) {
            console.log(`[AppBarber] invoice/search failed for ${customerPhone}: ${JSON.stringify(invoiceResult).slice(0, 300)}`);
            invoiceSearchDiagnostics.push({ customer_phone: customerPhone, error: invoiceResult.error, status: invoiceResult.status });
            continue;
          }
          const data = extractAppBarberInvoiceList(invoiceResult);
          invoiceSearchDiagnostics.push({
            customer_phone: customerPhone,
            count: data.length,
            top_level_keys: invoiceResult && typeof invoiceResult === "object" ? Object.keys(invoiceResult).slice(0, 8) : [],
            data_keys: invoiceResult?.data && typeof invoiceResult.data === "object" && !Array.isArray(invoiceResult.data) ? Object.keys(invoiceResult.data).slice(0, 8) : [],
          });
          invoiceItems.push(...data);
        }

        const dedupedInvoiceItems = Array.from(new Map(invoiceItems.map((invoice: any, idx) => {
          const invoiceCode = firstValue(invoice?.invoice_code, invoice?.invoice_id, invoice?.invoiceCode, invoice?.comanda_code, invoice?.command_code, invoice?.code, invoice?.id, `idx:${idx}`);
          return [String(invoiceCode), invoice];
        })).values());

        const openInvoices = dedupedInvoiceItems.filter((it: any) => {
          const status = String(firstValue(it?.invoice_status, it?.status, it?.status_description, it?.invoiceStatus, ""))
            .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
          const closed = /CANCEL|REALIZ|CONCL|FINALIZ|FECHAD|CLOSED/.test(status);
          return !closed;
        });
        if (openInvoices.length > 0) {
          const appointments = openInvoices.flatMap((invoice: any) => {
            const items = extractAppBarberInvoiceItems(invoice);
            const invoiceObservation = firstValue(
              invoice.scheduling_observation,
              invoice.observation,
              invoice.notes,
              invoice.description,
              invoice.customer_observation,
            );
            const observationPhone = extractPhonesFromText(invoiceObservation)[0];
            return items.map((item: any) => ({
              source: "invoice_search",
              invoice_code: firstValue(invoice.invoice_code, invoice.invoice_id, invoice.invoiceCode, invoice.comanda_code, invoice.command_code, invoice.code, invoice.id),
              invoice_item_code: firstValue(item?.invoice_item_code, item?.invoiceItemCode, item?.item_code, item?.code, item?.id, null),
              client_name: firstValue(invoice.client_name, invoice.customer_name, invoice.name),
              client_phone: firstValue(invoice.client_phone, invoice.customer_phone, invoice.phone, observationPhone),
              service_description: firstValue(item?.item_description, item?.service_description, item?.description, item?.name, invoice.service_description, invoice.description, "Comanda AppBarber"),
              employee_name: firstValue(invoice.employee_name, invoice.professional_name, invoice.barber_name, item?.employee_name, null),
              scheduling_start: firstValue(invoice.scheduling_start, invoice.start_date, invoice.appointment_date, invoice.invoice_date, invoice.created_at),
              scheduling_status: firstValue(invoice.invoice_status, invoice.status, invoice.status_description, invoice.invoiceStatus),
              service_value: firstValue(item?.item_value, item?.service_value, item?.value, invoice.total_value, invoice.value),
              scheduling_observation: invoiceObservation,
              items: extractAppBarberInvoiceItems(invoice).filter(Boolean).map((entry: any) => ({
                invoice_item_code: firstValue(entry?.invoice_item_code, entry?.invoiceItemCode, entry?.item_code, entry?.code, entry?.id),
                item_description: firstValue(entry?.item_description, entry?.service_description, entry?.description, entry?.name),
                item_quantity: firstValue(entry?.item_quantity, entry?.quantity),
                item_value: firstValue(entry?.item_value, entry?.service_value, entry?.value),
                item_type: firstValue(entry?.item_type, entry?.type),
              })),
            }));
          });
          console.log(`[AppBarber] listar_agendamentos via invoice/search: tried=${JSON.stringify(triedInvoicePhones)}, found=${appointments.length}`);
          return {
            source: "invoice_search",
            period: { start_date: startDate, end_date: endDate, status_type: statusType },
            customer_phone: phoneDigits || null,
            searched_customer_phones: triedInvoicePhones,
            invoice_search_diagnostics: invoiceSearchDiagnostics,
            appointments,
            total: appointments.length,
          };
        }

        // Fallback: histórico de agendamentos por período, útil quando a comanda não aparece em /invoice/search.
        const callHistory = (historyStatusType: number) => callGet("/v1/appointments/history", {
          start_date: startDate,
          end_date: endDate,
          status_type: historyStatusType,
        });
        const r = await callHistory(statusType);
        if (r?.error) return r;
        const items = Array.isArray(r?.data) ? r.data : [];
        // Match por sufixo do telefone. Compara últimos 8 dígitos (núcleo do número),
        // ignorando DDI, DDD e o "9" extra que varia entre cadastros.
        const tail = (s: string, n: number) => s.slice(-n);
        const phoneCore = phoneDigits ? tail(phoneDigits, 8) : "";
        const filtered = phoneCore
          ? items.filter((it: any) => {
              return phoneCoreMatches(
                phoneDigits,
                it?.client_phone,
                it?.customer_phone,
                it?.phone,
                it?.scheduling_observation,
                it?.observation,
                it?.notes,
                it?.description,
              );
            })
          : items;
        const mapHistoryItem = (it: any) => ({
          source: "appointments_history",
          scheduling_code: it.scheduling_code,
          invoice_code: it.invoice_code,
          invoice_item_code: null,
          client_name: it.client_name,
          client_phone: it.client_phone,
          service_description: it.service_description,
          employee_name: it.employee_name,
          scheduling_start: it.scheduling_start,
          scheduling_status: it.scheduling_status,
          scheduling_observation: firstValue(it.scheduling_observation, it.observation, it.notes, it.description),
          service_value: it.service_value,
        });
        let canceledAppointments: any[] = [];
        if (filtered.length === 0 && Number(statusType) === 1 && phoneCore) {
          const canceledResult = await callHistory(3);
          const canceledItems = Array.isArray(canceledResult?.data) ? canceledResult.data : [];
          canceledAppointments = canceledItems
            .filter((it: any) => phoneCoreMatches(
              phoneDigits,
              it?.client_phone,
              it?.customer_phone,
              it?.phone,
              it?.scheduling_observation,
              it?.observation,
              it?.notes,
              it?.description,
            ))
            .map(mapHistoryItem);
          if (canceledAppointments.length > 0) {
            console.log(`[AppBarber] listar_agendamentos: found canceled/manual matches=${canceledAppointments.length}`);
          }
        }
        console.log(`[AppBarber] listar_agendamentos: total API=${items.length}, match telefone=${filtered.length}, phoneCore=${phoneCore}, allPhones=${JSON.stringify(items.map((it: any) => it?.client_phone))}`);
        return {
          source: "appointments_history",
          period: { start_date: startDate, end_date: endDate, status_type: statusType },
          customer_phone: phoneDigits || null,
          searched_customer_phones: triedInvoicePhones,
          invoice_search_diagnostics: invoiceSearchDiagnostics,
          appointments: filtered.map(mapHistoryItem),
          total: filtered.length,
          canceled_appointments: canceledAppointments,
          found_canceled: canceledAppointments.length > 0,
          note: canceledAppointments.length > 0 ? "Não há agendamento ativo para cancelar; encontrei registro cancelado para este telefone." : undefined,
          // Quando nada bate, devolve a lista bruta pra IA poder confirmar visualmente com o cliente
          // (útil se o cadastro AppBarber estiver com outro telefone)
          unmatched_sample: filtered.length === 0 && items.length > 0
            ? items.slice(0, 5).map((it: any) => ({
                scheduling_code: it.scheduling_code,
                invoice_code: it.invoice_code,
                client_name: it.client_name,
                client_phone: it.client_phone,
                service_description: it.service_description,
                scheduling_start: it.scheduling_start,
                scheduling_observation: firstValue(it.scheduling_observation, it.observation, it.notes, it.description),
              }))
            : undefined,
        };
      }


      case "cancelar_agendamento": {
        const phoneDigits = normalizePhoneDigits(args.customer_phone || phoneNumber || "");
        const cancelScope = String(args.cancel_scope || "invoice").toLowerCase();
        const reason = String(args.reason || "Cancelamento solicitado pelo cliente via WhatsApp");
        let removingItem = cancelScope === "item" && args.invoice_item_code;

        // Guard-rail: se for cancelar ITEM mas a comanda só tem 1 serviço, força cancelar comanda inteira.
        // Isso evita o fluxo "tenta item → falha → tenta comanda" observado em produção.
        if (removingItem && args.invoice_code && phoneDigits) {
          try {
            const searchUrl = buildUrl(`/v1/invoice/search`, { customer_phone: phoneDigits });
            const sRes = await fetch(searchUrl, { method: "GET", headers });
            const sText = await sRes.text();
            let sParsed: any = null; try { sParsed = JSON.parse(sText); } catch { /* keep null */ }
            const invoices = sParsed?.data?.invoices || sParsed?.data || sParsed?.invoices || [];
            const target = Array.isArray(invoices)
              ? invoices.find((inv: any) => String(inv?.invoice_code ?? inv?.code ?? inv?.id) === String(args.invoice_code))
              : null;
            const items = target?.items || target?.invoice_items || target?.services || [];
            if (Array.isArray(items) && items.length <= 1) {
              console.log(`[AppBarber] cancelar_agendamento: invoice ${args.invoice_code} tem ${items.length} item(s) — forçando cancelar COMANDA inteira em vez de item.`);
              removingItem = false;
            }
          } catch (e) {
            console.log(`[AppBarber] cancelar_agendamento: falha ao pré-checar itens da comanda:`, e instanceof Error ? e.message : e);
          }
        }

        if (removingItem) {
          const url = buildUrl(`/v1/invoice/item/${encodeURIComponent(String(args.invoice_item_code))}`, {});
          const body = { establishment_code: estCode, reason };
          console.log(`[AppBarber] DELETE ${url} body=${JSON.stringify(body)}`);
          const res = await fetch(url, { method: "DELETE", headers, body: JSON.stringify(body) });
          const text = await res.text();
          console.log(`[AppBarber] remover_item_comanda (${res.status}):`, text.slice(0, 600));
          let parsed: any = null; try { parsed = JSON.parse(text); } catch { /* keep null */ }
          if (res.ok) {
            return {
              ok: true,
              invoice_item_code: args.invoice_item_code,
              result: parsed?.data?.result || parsed?.message || "Item removido da comanda com sucesso",
            };
          }
          // Fallback automático: se item-cancel falhar (422/404) e tivermos invoice_code, cancela a comanda inteira.
          if (args.invoice_code && phoneDigits && (res.status === 422 || res.status === 404)) {
            console.log(`[AppBarber] item cancel falhou (${res.status}) — fallback para cancelar comanda inteira.`);
          } else {
            const baseErr = parsed?.message || parsed?.data?.error_type || parsed?.error || `HTTP ${res.status}`;
            if (res.status === 429) return { error: "Limite de requisições do AppBarber excedido. Aguarde alguns segundos e tente de novo.", status: 429, recoverable: true };
            return { error: baseErr, status: res.status, recoverable: res.status === 422, details: parsed?.data ?? parsed?.details };
          }
        }

        if (!args.invoice_code) return { error: "invoice_code é obrigatório. Use listar_agendamentos para obter." };
        if (!phoneDigits) return { error: "customer_phone é obrigatório." };
        const url = buildUrl(`/v1/invoice/${encodeURIComponent(String(args.invoice_code))}`, {});
        const body = {
          customer_phone: String(phoneDigits),
          establishment_code: estCode,
          reason,
        };
        console.log(`[AppBarber] DELETE ${url} body=${JSON.stringify(body)}`);
        const res = await fetch(url, { method: "DELETE", headers, body: JSON.stringify(body) });
        const text = await res.text();
        console.log(`[AppBarber] cancelar_agendamento (${res.status}):`, text.slice(0, 600));
        let parsed: any = null; try { parsed = JSON.parse(text); } catch { /* keep null */ }
        if (!res.ok) {
          const baseErr = parsed?.message || parsed?.data?.error_type || parsed?.error || `HTTP ${res.status}`;
          if (res.status === 422) {
            return { error: `Não foi possível cancelar: ${baseErr}`, status: 422, recoverable: true, details: parsed?.data ?? parsed?.details };
          }
          if (res.status === 429) {
            return { error: "Limite de requisições do AppBarber excedido. Aguarde alguns segundos e tente de novo.", status: 429, recoverable: true };
          }
          return { error: baseErr, status: res.status, details: parsed?.data ?? parsed?.details };
        }
        return {
          ok: true,
          invoice_code: args.invoice_code,
          result: parsed?.data?.result || "Comanda cancelada com sucesso",
        };
      }


      default:
        return { error: `Ferramenta AppBarber desconhecida: ${funcName}` };
    }
  } catch (error) {
    console.error(`[AppBarber] tool error (${funcName}):`, error);
    const msg = error instanceof Error ? error.message : String(error);
    return { error: `Erro ao executar ${funcName}: ${msg}` };
  }
}