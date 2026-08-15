import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { AsyncLocalStorage } from "node:async_hooks";
// MODO ECONÔMICO / SITE DE CHAT — módulo isolado (jul/2026).
import {
  ensureWebChatSession,
  sendEconomicModeInvite,
  buildWebChatUrl,
  buildInviteText,
  handleWebChatRequest,
} from "./webchat/index.ts";

import { buildTrinksPromptSection, buildOneBelezaPromptSection, buildNonePromptSection, buildFrizzarPromptSection, buildBempPromptSection, buildAppBarberPromptSection, buildGlobalPromptSection } from "../_shared/provider-prompts.ts";
// PROVIDER FRIZZAR — módulo isolado (extraído em jul/2026 pra evitar que
// mexer em outra API quebre a Frizzar). Regra: nada de Frizzar mora aqui.
import {
  buildFrizzarTools,
  executeFrizzarTool,
  frizzarGetLastListed,
  frizzarSetLastListed,
  isRecoverableFrizzarScheduleResult,
  buildFrizzarScheduleRecoveryInstruction,
  evaluateSuccessfulBooking as evaluateFrizzarBooking,
  extractBookedServiceNames as extractFrizzarBookedServiceNames,
  phantomGuardConfig as frizzarPhantomGuardConfig,
  bookingGuardsConfig as frizzarBookingGuardsConfig,
} from "./providers/frizzar/index.ts";
import {
  buildAppBarberTools,
  executeAppBarberTool,
  evaluateSuccessfulBooking as evaluateAppBarberBooking,
  extractBookedServiceNames as extractAppBarberBookedServiceNames,
  phantomGuardConfig as appbarberPhantomGuardConfig,
  bookingGuardsConfig as appbarberBookingGuardsConfig,
} from "./providers/appbarber/index.ts";
import {
  buildBempTools,
  executeBempTool,
  evaluateSuccessfulBooking as evaluateBempBooking,
  extractBookedServiceNames as extractBempBookedServiceNames,
  phantomGuardConfig as bempPhantomGuardConfig,
  bookingGuardsConfig as bempBookingGuardsConfig,
} from "./providers/bemp/index.ts";
// PROVIDER ONE BELEZA — módulo isolado (extraído em jul/2026).
import {
  buildOneBelezaTools,
  executeOneBelezaTool,
  buildOneBelezaGenericEmail,
  isOneBelezaPhoneInUseError,
  isOneBelezaRegistrationSuccess,
  burnOneBelezaAlias,
  getOrCreateOneBelezaAlias,
  resolveOneBelezaClientPhone,
  fetchOneBelezaWithRetry,
  shouldRetryOneBelezaWithEmail,
  verifyOneBelezaClientExists,
  registerOneBelezaClient,
  resolveOneBelezaServiceId,
  resolveOneBelezaProfessionalId,
  resolveOneBelezaToolArgs,
  reconcileOneBelezaAgendaId,
  normalizeOneBelezaDate,
  normalizeOneBelezaTime,
  getOneBelezaUnitFilterList,
  getAllowedOneBelezaServiceIds,
  extractOneBelezaServiceOptions,
  extractOneBelezaProfessionalOptions,
  extractOneBelezaProfessionalOptionsFromAvailability,
  extractOneBelezaSlotOptions,
  buildNormalizedOneBelezaAgendarArgs,
  reconcileOneBelezaSchedulingArgs,
  buildOneBelezaSchedulingValidationResult,
  hydrateOneBelezaSessionStateFromProvider,
  evaluateSuccessfulBooking as evaluateOneBelezaBooking,
  extractBookedServiceNames as extractOneBelezaBookedServiceNames,
  phantomGuardConfig as onebelezaPhantomGuardConfig,
  bookingGuardsConfig as onebelezaBookingGuardsConfig,
  type OneBelezaServiceOption,
  type OneBelezaProfessionalOption,
  type OneBelezaSlotOption,
} from "./providers/onebeleza/index.ts";
// PROVIDER TRINKS — módulo isolado (extraído em jul/2026 na mesma linha do
// Frizzar/AppBarber). Nada de Trinks deve morar neste arquivo.
import {
  buildTrinksTools,
  executeTrinksTool,
  fetchActiveAppointmentsByPhone,
  maybeHandleDirectCancellationConfirmation,
  evaluateSuccessfulBooking as evaluateTrinksBooking,
  extractBookedServiceNames as extractTrinksBookedServiceNames,
  phantomGuardConfig as trinksPhantomGuardConfig,
  bookingGuardsConfig as trinksBookingGuardsConfig,
} from "./providers/trinks/index.ts";

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

const ALLOWED_ORIGINS = ["https://zayloia.com", "https://www.zayloia.com", "https://painelzaylo.lovable.app"];
// O site de chat do modo econômico é público e roda no domínio publicado ou em
// previews do Lovable — por isso aceitamos também *.lovable.app e localhost em dev.
function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const u = new URL(origin);
    if (u.hostname.endsWith(".lovable.app")) return true;
    if (u.hostname.endsWith(".lovableproject.com")) return true;
    if (u.hostname.endsWith(".lovable.dev")) return true;
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return true;
  } catch { /* ignore */ }
  return false;
}
function buildCorsHeaders(origin: string | null) {
  const allowOrigin = origin && isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, token, x-mode",
  };
}


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
const _uazLabelsCache = new Map<string, { fetchedAt: number; labels: Array<{ id: string; rawId: string; name: string }> }>();

async function fetchUazapiLabels(uazapiUrl: string, uazapiToken: string): Promise<Array<{ id: string; rawId: string; name: string }>> {
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
        // Some UAZAPI versions return instance-prefixed IDs (e.g. "instance:7").
        // We keep both forms: the canonical ("7") and the raw catalog value.
        id: normalizeWhatsAppLabelId(l.id ?? l.label_id ?? l.labelId ?? l.value) || "",
        rawId: String(l.id ?? l.label_id ?? l.labelId ?? l.value ?? ""),
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

// Trava estrutural para o resumo/CRM do cliente (crm_leads.ai_summary). O resumo é
// memória de PERFIL/PREFERÊNCIA (ex: "prefere corte com o Vinícius", "cliente do
// plano VIP") — NUNCA histórico de agendamento específico (data, horário,
// confirmação de uma ação concreta). Bug real: o resumo guardou "corte com
// Vinícius às 15h confirmado", e numa conversa futura a IA reafirmou esse fato
// antigo como se fosse confirmação de uma solicitação NOVA, sem chamar nenhuma
// ferramenta. Usada nos DOIS caminhos que escrevem em crm_leads.ai_summary — a
// tool explícita atualizar_resumo_cliente E o extrator automático
// (persistClientSummary, chamado por maybeAutoPersistClientSummary a cada turno).
const SUMMARY_FORBIDDEN_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\b\d{1,2}[:h]\d{2}\b/i, label: "horário específico (ex: 15:00, 15h30)" },
  { re: /\b\d{1,2}\s*h(?:s|oras?)?\b/i, label: "horário específico (ex: 15h, 15 horas)" },
  { re: /\b\d{4}-\d{2}-\d{2}\b/, label: "data no formato yyyy-MM-dd" },
  { re: /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/, label: "data no formato dd/mm" },
  { re: /\b(hoje|amanh[ãa]|depois\s+de\s+amanh[ãa]|ontem)(?![a-záéíóúâêôãõç])/i, label: "referência relativa de dia (hoje/amanhã/ontem)" },
  { re: /\b(segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo)(?:-feira)?\s+(que\s+vem|pr[óo]xima?|passad[ao])\b/i, label: "dia da semana relativo (ex: sexta que vem)" },
  { re: /\b(confirmad[oa]|confirmei|confirmou|agendad[oa]|agendei|agendou|marcad[oa]|marquei|marcou|reservad[oa]|reservei|reservou|desmarc\w+|cancel\w+|remarc\w+)\b/i, label: "linguagem de confirmação/agendamento (agendou/marcou/confirmou/cancelou)" },
  { re: /\bagendamento(s)?\b/i, label: "menção a agendamento específico" },
  { re: /\b(hor[áa]rio\s+(marcado|reservado|confirmado|agendado))\b/i, label: "horário marcado/reservado" },
];

function findForbiddenSummaryContent(resumo: string): { re: RegExp; label: string } | null {
  return SUMMARY_FORBIDDEN_PATTERNS.find((p) => p.re.test(resumo)) || null;
}


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


// ===== One Beleza alias helpers (handle "phone already in use globally") =====

// Detect responses that *look* like success (HTTP 2xx) but actually carry an error message in body.
// Examples observed in production:
//   "Erro ao realizar login com o cadastro"
//   "Erro ao cadastrar..."
// Returns true ONLY when we have strong evidence the registration succeeded.


// Marca um alias como queimado para que nunca mais seja reutilizado.





const parseTimestampMs = (value: unknown) => {
  const timestamp = new Date(String(value ?? "")).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
};

// Verifica se um cadastro foi realmente persistido consultando a API por telefone.

// ===================== HTTP TRACE (auditoria ponta a ponta) =====================
// Captura TODA requisição HTTP de saída feita durante o processamento de uma
// mensagem (APIs de agenda, UAZAPI, OpenAI) com corpo enviado e corpo recebido,
// para exibição no Monitor. Chamadas ao próprio Supabase são ignoradas.
// Segredos (token/apikey/authorization) nunca são gravados.
type HttpTraceEntry = {
  seq: number;
  at: string;
  method: string;
  url: string;
  request_body: string | null;
  status: number | null;
  ok: boolean;
  duration_ms: number;
  response_body: string | null;
  error?: string;
  truncated?: boolean;
};

const httpTraceStore = new AsyncLocalStorage<HttpTraceEntry[]>();
const HTTP_TRACE_MAX_CALLS = 60;
const HTTP_TRACE_MAX_BODY = 4000;

function redactTraceText(text: string | null): string | null {
  if (!text) return text;
  return text
    .replace(/("?(?:token|apikey|api_key|authorization|password|galax_hash|secret)"?\s*[:=]\s*"?)([^"&,\s}]+)/gi, "$1***")
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/g, "$1***");
}

function truncateTraceBody(text: string | null): { body: string | null; truncated: boolean } {
  if (!text) return { body: text, truncated: false };
  if (text.length <= HTTP_TRACE_MAX_BODY) return { body: text, truncated: false };
  return { body: text.slice(0, HTTP_TRACE_MAX_BODY) + `\n…(+${text.length - HTTP_TRACE_MAX_BODY} chars)`, truncated: true };
}

const __originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input: any, init?: any) => {
  const bucket = httpTraceStore.getStore();
  if (!bucket) return __originalFetch(input, init);

  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  // Ignora tráfego interno do Supabase (ruído: chat_messages, logs, state)
  if (supabaseUrl && url.startsWith(supabaseUrl)) return __originalFetch(input, init);
  if (bucket.length >= HTTP_TRACE_MAX_CALLS) return __originalFetch(input, init);

  const method = (init?.method || (typeof input === "object" ? input?.method : "") || "GET").toUpperCase();
  let reqBody: string | null = null;
  try {
    if (typeof init?.body === "string") reqBody = init.body;
    else if (init?.body instanceof URLSearchParams) reqBody = init.body.toString();
    else if (init?.body instanceof FormData) {
      const parts: string[] = [];
      for (const [k, v] of (init.body as FormData).entries()) parts.push(`${k}=${typeof v === "string" ? v : "[file]"}`);
      reqBody = parts.join("&");
    }
  } catch { /* ignore */ }

  const entry: HttpTraceEntry = {
    seq: bucket.length + 1,
    at: new Date().toISOString(),
    method,
    url: redactTraceText(url.split("?")[0] + (url.includes("?") ? "?" + url.split("?").slice(1).join("?") : "")) || url,
    request_body: null,
    status: null,
    ok: false,
    duration_ms: 0,
    response_body: null,
  };
  const reqTrunc = truncateTraceBody(redactTraceText(reqBody));
  entry.request_body = reqTrunc.body;

  const started = Date.now();
  try {
    const res = await __originalFetch(input, init);
    entry.status = res.status;
    entry.ok = res.ok;
    entry.duration_ms = Date.now() - started;
    let text: string | null = null;
    try {
      const clone = res.clone();
      text = await clone.text();
    } catch { text = null; }
    const resTrunc = truncateTraceBody(redactTraceText(text));
    entry.response_body = resTrunc.body;
    entry.truncated = reqTrunc.truncated || resTrunc.truncated;
    bucket.push(entry);
    return res;
  } catch (e: any) {
    entry.duration_ms = Date.now() - started;
    entry.error = e?.message || String(e);
    bucket.push(entry);
    throw e;
  }
};

function getHttpTrace(): HttpTraceEntry[] {
  return httpTraceStore.getStore() || [];
}

// Limite defensivo: http_trace muito grande já fez o INSERT em agent_logs falhar
// (payload gigante / statement timeout), fazendo a conversa "desaparecer" do monitor.
const MAX_TRACE_ENTRIES = 120;
function getHttpTraceCapped(): HttpTraceEntry[] {
  const trace = getHttpTrace();
  if (trace.length <= MAX_TRACE_ENTRIES) return trace;
  return trace.slice(trace.length - MAX_TRACE_ENTRIES);
}

// Gravação do log NUNCA pode ser silenciosa: se falhar com o payload completo,
// tenta versões progressivamente menores para garantir o registro da conversa.
async function insertAgentLogResilient(supabase: any, row: Record<string, unknown>) {
  const attempts: Array<Record<string, unknown>> = [
    row,
    { ...row, http_trace: null },
    { ...row, http_trace: null, tool_calls: null },
  ];
  for (let i = 0; i < attempts.length; i++) {
    try {
      const { error } = await supabase.from("agent_logs").insert(attempts[i]);
      if (!error) {
        if (i > 0) console.warn(`[AgentLog] gravado em modo reduzido (tentativa ${i + 1}): payload completo falhou`);
        return;
      }
      console.error(`[AgentLog] insert falhou (tentativa ${i + 1}): ${error.message}`);
    } catch (e: any) {
      console.error(`[AgentLog] insert exception (tentativa ${i + 1}):`, e?.message || e);
    }
  }
  console.error("[AgentLog] NÃO foi possível registrar a execução no monitor");
}


// ===================== UAZAPI SEND COM RETRY =====================
// 503/502/504/429 da UAZAPI são falhas transitórias DO LADO DELES (gateway/instância
// momentaneamente indisponível). Sem retry, a IA responde no sistema mas o cliente
// não recebe nada no WhatsApp. 3 tentativas com backoff curto resolvem o caso comum.

// "digitando..." no WhatsApp: a UAZAPI mostra a presença de digitação durante o
// `delay` do /send/text (e "gravando áudio" durante o delay do /send/media type=ptt).
// Com delay 0 a mensagem simplesmente aparecia do nada. Aqui o tempo é proporcional
// ao tamanho do texto, com piso e teto pra não parecer robótico nem demorar demais.
function typingDelayMs(text: string): number {
  const chars = (text || "").length;
  return Math.min(6000, Math.max(1200, Math.round(chars * 45)));
}

// A presença é iniciada de forma assíncrona pela UAZAPI. Por isso, esta chamada
// apenas a inicia e dá um curto tempo para propagação; a duração real fica no
// `delay` nativo do /send/text ou /send/media, que mantém a presença até o envio.
async function uazapiTypingPresence(
  uazapiUrl: string,
  uazapiToken: string,
  number: string,
  ms: number,
  presence: "composing" | "recording" = "composing",
): Promise<void> {
  try {
    const response = await fetch(`${uazapiUrl}/message/presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json", "token": uazapiToken },
      body: JSON.stringify({ number, presence, delay: ms }),
    });
    if (!response.ok) {
      const details = await response.text().catch(() => "");
      console.warn(`[UAZAPI Presence] ${presence} falhou: status=${response.status} body=${details.slice(0, 300)}`);
    }
  } catch (error: any) {
    console.warn(`[UAZAPI Presence] ${presence} falhou: ${error?.message || String(error)}`);
  }
  // /message/presence responde antes de publicar o estado no WhatsApp.
  await new Promise((resolve) => setTimeout(resolve, 350));
}

async function uazapiSendTextWithRetry(
  uazapiUrl: string,
  uazapiToken: string,
  number: string,
  text: string,
  attempts = 3,
): Promise<{ ok: boolean; status: number | null; data: any; error: string | null; attempts: number }> {
  const transient = new Set([408, 429, 500, 502, 503, 504]);
  let lastStatus: number | null = null;
  let lastError: string | null = null;
  const delay = typingDelayMs(text);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      if (attempt === 1) await uazapiTypingPresence(uazapiUrl, uazapiToken, number, delay);
      const res = await fetch(`${uazapiUrl}/send/text`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json", "token": uazapiToken },
        body: JSON.stringify({ number, text, delay: attempt === 1 ? delay : 0, readchat: true }),
      });
      const data = await res.json().catch(() => ({} as any));
      lastStatus = res.status;
      if (res.ok) return { ok: true, status: res.status, data, error: null, attempts: attempt };
      lastError = `UAZAPI status ${res.status}`;
      if (!transient.has(res.status) || attempt === attempts) {
        return { ok: false, status: res.status, data, error: lastError, attempts: attempt };
      }
    } catch (e: any) {
      lastError = `UAZAPI fetch error: ${e?.message || String(e)}`;
      if (attempt === attempts) return { ok: false, status: lastStatus, data: null, error: lastError, attempts: attempt };
    }
    const backoff = attempt === 1 ? 800 : 2500;
    console.warn(`[UAZAPI] envio falhou (${lastError}) — tentativa ${attempt}/${attempts}, aguardando ${backoff}ms`);
    await new Promise((r) => setTimeout(r, backoff));
  }
  return { ok: false, status: lastStatus, data: null, error: lastError, attempts };
}

const handleWebhookRequest = async (req: Request): Promise<Response> => {
  const corsHeaders = buildCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // ===== WEB CHAT (MODO ECONÔMICO) =====
  // Canal público identificado pelo token da URL do site. Roda a MESMA IA.
  if (req.headers.get("x-mode") === "webchat") {
    return await handleWebChatRequest(req, {
      corsHeaders,
      createServiceClient: () =>
        createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!),
      callAIAgent: callAIAgent as any,
      getHttpTrace: () => getHttpTrace(),
    });
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

      // Funis do CRM configurados pelo cliente (pode ter vários) — anexado
      // ao objeto tenant pra não precisar mudar a assinatura das funções
      // que já recebem "tenant" (buildToolsForProvider, buildSystemPrompt).
      if (tenant.crm_zetta_token) {
        const { data: crmFunnels } = await svc
          .from("tenant_crm_funnels")
          .select("funnel_id, funnel_name, stages")
          .eq("tenant_id", tenantId);
        (tenant as any).crm_funnels = crmFunnels ?? [];
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

      // ⚠️ A UAZAPI às vezes entrega o eco da nossa própria mensagem SEM o campo
      // fromMe no lugar esperado (visto em produção: fromMe=undefined com o texto
      // que a IA acabou de enviar). Por isso olhamos todos os lugares possíveis e
      // aceitamos também a string "true".
      const truthyFlag = (v: unknown) => v === true || v === "true";
      const fromMe = truthyFlag(payload.fromMe) ||
        truthyFlag(msg.fromMe) ||
        truthyFlag(msg.key?.fromMe) ||
        truthyFlag(payload.message?.fromMe) ||
        truthyFlag(payload.data?.fromMe) ||
        truthyFlag(payload.data?.key?.fromMe) ||
        truthyFlag(payload.messages?.[0]?.fromMe) ||
        truthyFlag(payload.chat?.lastMessage_fromMe) ||
        (payload.sender && payload.owner && payload.sender === payload.owner) ||
        (!!digitsOnly(payload.sender || "") && !!digitsOnly(payload.chat?.owner || payload.owner || "") &&
          digitsOnly(payload.sender || "") === digitsOnly(payload.chat?.owner || payload.owner || ""));
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

      // ❌ = reset universal da memória deste cliente.
      // Roda ANTES do skip de fromMe e do debounce por três motivos:
      //   1. O dono do salão pode mandar ❌ do próprio WhatsApp (fromMe=true) pra
      //      resetar a memória de um cliente específico — antes esse caminho caía no
      //      "skipped_fromMe_stored" e nunca limpava nada, o que gerou o bug real
      //      relatado (resumo do CRM continuava intacto depois do ❌).
      //   2. WhatsApp/teclado emoji às vezes anexa variation selector (U+FE0F) ou
      //      zero-width chars — a checagem antiga `=== "❌"` falhava silenciosamente
      //      nessas variantes. Aqui normalizamos antes de comparar.
      //   3. Se o ❌ estiver junto num batch, ainda queremos apagar tudo — a
      //      intenção do reset é destruir o contexto acumulado, não preservá-lo.
      const normalizedForReset = String(messageContent || "")
        .replace(/[\uFE0E\uFE0F\u200D\u200B]/g, "")
        .trim();
      if (normalizedForReset === "❌") {
        const ownerDigitsReset = digitsOnly(payload.chat?.owner || payload.owner || payload.to || "");
        const { data: activeTenantsReset } = await supabase
          .from("tenants")
          .select("id, name, whatsapp_number, uazapi_url, uazapi_token")
          .eq("status", "active");
        // ATENÇÃO: NUNCA usar um fallback tipo "primeira barbearia da lista"
        // aqui — se não conseguirmos confirmar com certeza qual barbearia
        // mandou o ❌, o correto é NÃO resetar nada. O fallback antigo
        // (`|| lista[0]`) causava um bug grave: quando a identificação
        // falhava (ex: barbearia recém-criada sem whatsapp_number salvo
        // ainda, ou dados do payload vazios), o sistema resetava a
        // memória e mandava "Memória limpa!" para uma barbearia
        // COMPLETAMENTE ALEATÓRIA — vazamento real entre clientes
        // diferentes, relatado pelo Mariano.
        const tenantForReset = ownerDigitsReset
          ? (activeTenantsReset || []).find((t: any) =>
              t.whatsapp_number ? exactDigitsMatch(ownerDigitsReset, t.whatsapp_number) : false,
            )
          : undefined;

        if (tenantForReset) {
          await supabase
            .from("chat_messages")
            .delete()
            .eq("tenant_id", tenantForReset.id)
            .eq("phone_number", phoneNumber);
          await supabase
            .from("conversation_state")
            .delete()
            .eq("tenant_id", tenantForReset.id)
            .eq("phone_number", phoneNumber);
          const { data: crmResetRows, error: crmResetErr } = await supabase
            .from("crm_leads")
            // ai_summary é NOT NULL no banco; apagar = string vazia.
            // O bug real acontecia porque tentar gravar NULL falhava e o resumo antigo
            // continuava disponível para a IA no próximo turno.
            .update({ ai_summary: "", ai_summary_updated_at: null })
            .eq("tenant_id", tenantForReset.id)
            .eq("phone_number", phoneNumber)
            .select("id");
          console.log(`[MemoryReset EARLY] phone=${phoneNumber} tenant=${tenantForReset.id} fromMe=${fromMe} summary_cleared_rows=${crmResetRows?.length ?? 0} err=${crmResetErr?.message || "none"}`);

          const uazapiUrl = tenantForReset.uazapi_url || Deno.env.get("UAZAPI_URL");
          const uazapiToken = tenantForReset.uazapi_token || Deno.env.get("UAZAPI_TOKEN");
          if (uazapiUrl && uazapiToken) {
            try {
              await fetch(`${uazapiUrl}/send/text`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Accept": "application/json", "token": uazapiToken },
                body: JSON.stringify({ number: phoneNumber, text: "🔄 Memória limpa! Pode começar uma nova conversa.", delay: 1000 }),
              });
            } catch (e: any) {
              console.warn(`[MemoryReset EARLY] send confirmation failed: ${e?.message || e}`);
            }
          }
        } else {
          console.warn(`[MemoryReset EARLY] Reset IGNORADO (intencional) — não foi possível identificar com certeza qual barbearia mandou o ❌ (ownerDigits="${ownerDigitsReset}"), phone=${phoneNumber}. Isso evita apagar/vazar dados de um cliente errado.`);
        }
        return new Response(JSON.stringify({ status: "memory_reset" }), {
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

      // 🔒 ANTI-ECO (fail-closed): mesmo sem fromMe, se o texto recebido for
      // idêntico a algo que a própria IA enviou nos últimos 3 minutos NESTE tenant
      // (qualquer chat — o eco às vezes chega num @lid diferente do número real),
      // é o eco da nossa mensagem. Responder isso fazia a IA conversar sozinha.
      if (messageContent && messageContent.trim().length > 8) {
        const echoNorm = messageContent.trim().replace(/\s+/g, " ").toLowerCase();
        const threeMinAgo = new Date(Date.now() - 180_000).toISOString();
        const { data: recentOwnMsgs } = await supabase
          .from("chat_messages")
          .select("content")
          .eq("tenant_id", tenant.id)
          .eq("role", "assistant")
          .gte("created_at", threeMinAgo)
          .order("created_at", { ascending: false })
          .limit(60);
        const isSelfEcho = (recentOwnMsgs || []).some((m: any) => {
          const stored = String(m.content || "").trim().replace(/\s+/g, " ").toLowerCase()
            .replace(/^\[atendente humano\]:\s*/i, "");
          return stored.length > 8 && (stored === echoNorm || stored.includes(echoNorm));
        });
        if (isSelfEcho) {
          console.warn(`[AntiEco] Mensagem ignorada: eco da própria IA (tenant=${tenant.id}, phone=${phoneNumber}) -> "${messageContent.slice(0, 80)}"`);
          return new Response(JSON.stringify({ status: "skipped_self_echo" }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }


      // 🧪 Modo de teste: a IA só responde os números autorizados do tenant.
      // Em modo de produção (padrão), responde todo mundo.
      const _agentMode = (tenant as any).agent_mode === "test" ? "test" : "production";
      const _testNumbers: string[] = Array.isArray((tenant as any).test_phone_numbers)
        ? (tenant as any).test_phone_numbers
        : [];
      // Normaliza número BR: remove DDI 55 e o 9º dígito de celular, para que
      // 5561983012868 e 556183012868 sejam considerados o mesmo contato.
      const _brKey = (raw: string) => {
        let d = String(raw ?? "").replace(/\D/g, "");
        if (d.length > 11 && d.startsWith("55")) d = d.slice(2);
        if (d.length === 11 && d[2] === "9") d = d.slice(0, 2) + d.slice(3); // DDD + 8 dígitos
        return d;
      };
      const _allowedTestDigits = new Set(
        _testNumbers.map((n) => String(n ?? "").replace(/\D/g, "")).filter(Boolean),
      );
      const _incomingDigits = String(phoneNumber ?? "").replace(/\D/g, "");
      const _incomingKey = _brKey(_incomingDigits);
      const _matchesTestNumber = [..._allowedTestDigits].some((d) => {
        if (!d) return false;
        if (d === _incomingDigits || d.endsWith(_incomingDigits) || _incomingDigits.endsWith(d)) return true;
        const k = _brKey(d);
        return !!k && !!_incomingKey && k === _incomingKey;
      });

      const testModeBlocked = _agentMode === "test" && !_matchesTestNumber;
      if (testModeBlocked) {
        console.log(`[TEST-MODE] Tenant ${tenant.name} em modo de teste — ${phoneNumber} não autorizado. Mensagem salva sem resposta.`);
      }

      // 🛑 IA pausada manualmente pelo cliente — NÃO chama a IA, mas SALVA a mensagem
      // para que o atendente humano veja no painel de Conversas e tenha histórico/memória.
      if (tenant.agent_paused || testModeBlocked) {
        console.log(`[PAUSED] Tenant ${tenant.name} não responderá (pausado=${!!tenant.agent_paused}, modo_teste_bloqueado=${testModeBlocked}). Salvando mensagem sem resposta.`);

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
        return new Response(JSON.stringify({ ok: true, ignored: testModeBlocked ? "test_mode" : "agent_paused", stored: true }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ===== 💸 MODO ECONÔMICO =====
      // Quando ligado, a IA NÃO responde no WhatsApp: o cliente recebe um convite
      // (botão nativo com fallback texto) para continuar o atendimento no site da
      // empresa. Se ele já está conversando no site (sessão ativa nos últimos 60min),
      // apenas guardamos a mensagem, sem reenviar convite (evita spam).
      if ((tenant as any).economic_mode_enabled === true) {
        const _msgIdEco = msg.key?.id || msg.id || payload.key?.id || payload.id || null;
        try {
          const session = await ensureWebChatSession(supabase, tenant.id, phoneNumber, senderName || null);
          if (!session) throw new Error("no_session");

          const { data: existingEco } = _msgIdEco
            ? await supabase.from("chat_messages").select("id").eq("message_id", _msgIdEco).maybeSingle()
            : { data: null };
          if (!existingEco) {
            await supabase.from("chat_messages").insert({
              tenant_id: tenant.id,
              phone_number: phoneNumber,
              role: "user",
              content: messageContent || "[Mensagem recebida]",
              message_id: _msgIdEco,
              processed: true,
            });
          }

          const lastSeen = session.last_seen_at ? new Date(session.last_seen_at).getTime() : 0;
          const lastInvite = session.invite_sent_at ? new Date(session.invite_sent_at).getTime() : 0;
          const now = Date.now();
          const siteActive = lastSeen > 0 && now - lastSeen < 60 * 60 * 1000;
          const invitedRecently = lastInvite > 0 && now - lastInvite < 30 * 60 * 1000;

          if (siteActive || invitedRecently) {
            console.log(`[EconomicMode] ${tenant.name}: convite não reenviado (siteActive=${siteActive}, invitedRecently=${invitedRecently}).`);
            return new Response(JSON.stringify({ ok: true, economic_mode: true, invited: false, reason: siteActive ? "site_active" : "invited_recently" }), {
              status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }

          const uazUrlEco = tenant.uazapi_url || Deno.env.get("UAZAPI_URL") || "";
          const uazTokEco = tenant.uazapi_token || Deno.env.get("UAZAPI_TOKEN") || "";
          const link = buildWebChatUrl(session.token);
          const sent = await sendEconomicModeInvite({
            uazapiUrl: uazUrlEco,
            uazapiToken: uazTokEco,
            number: phoneNumber,
            text: buildInviteText(tenant),
            buttonLabel: "Continuar atendimento",
            url: link,
            footerText: tenant.name || undefined,
          });
          console.log(`[EconomicMode] convite para ${phoneNumber} via ${sent.via} (ok=${sent.ok}) → ${link}`);

          if (sent.ok) {
            await supabase.from("web_chat_sessions")
              .update({ invite_sent_at: new Date().toISOString() })
              .eq("id", session.id);
            await supabase.from("chat_messages").insert({
              tenant_id: tenant.id,
              phone_number: phoneNumber,
              role: "assistant",
              content: `${buildInviteText(tenant)}\n\n👉 ${link}`,
              processed: true,
            });
          }

          return new Response(JSON.stringify({ ok: true, economic_mode: true, invited: sent.ok, via: sent.via }), {
            status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (e: any) {
          // Fail-safe: se o modo econômico falhar, NÃO caímos no fluxo normal da IA
          // (isso geraria custo justamente onde o cliente quis economizar).
          console.error("[EconomicMode] falha ao enviar convite:", e?.message || e);
          return new Response(JSON.stringify({ ok: true, economic_mode: true, invited: false, error: String(e?.message || e) }), {
            status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
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

        // Read live WhatsApp state from payload.
        // ⚠️ UAZAPI nem sempre envia wa_label no evento "messages". Quando vier vazio,
        // NÃO podemos assumir que o contato está sem etiquetas (isso apagava a IA OFF
        // e liberava a IA). Nesse caso consultamos /chat/details ao vivo.
        let waLabelIds = extractWhatsAppLabelIds(payload);
        let waLabelsKnown = waLabelIds.length > 0;
        if (!waLabelsKnown) {
          try {
            const uazUrlLbl = tenant.uazapi_url || Deno.env.get("UAZAPI_URL");
            const uazTokenLbl = tenant.uazapi_token || Deno.env.get("UAZAPI_TOKEN");
            if (uazUrlLbl && uazTokenLbl) {
              const { response: detRes, payload: chatDetails } = await fetchUazChatDetails(uazUrlLbl, uazTokenLbl, phoneNumber);
              if (detRes.ok) {
                waLabelIds = extractWhatsAppLabelIds(chatDetails);
                waLabelsKnown = true;
                console.log(`[IA OFF Check] Labels via /chat/details: ${JSON.stringify(waLabelIds)}`);
              }
            }
          } catch (e) {
            console.error("[IA OFF Check] /chat/details failed:", e);
          }
        }
        const waHasIaOff = iaOffLabelIds.length > 0 && waLabelIds.some((id: string) => iaOffLabelIds.includes(id));

        console.log(`[IA OFF Check] wa_label: ${JSON.stringify(waLabelIds)} | known: ${waLabelsKnown} | iaOffIds: ${JSON.stringify(iaOffLabelIds)} | dbHasIaOff: ${dbHasIaOff} | waHasIaOff: ${waHasIaOff}`);


        // ----- Bidirectional flag reconciliation (WhatsApp = source of truth) -----
        // Build the desired flag set from WhatsApp, but only for labels configured as type:"flag".
        // Unknown labels (e.g. funnel labels) are ignored here.
        if (waLabelsKnown && allConfiguredFlagIds.length > 0) {
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

        // Final decision: WhatsApp state wins quando conhecemos as etiquetas ao vivo.
        // Se NÃO conseguimos ler o estado do WhatsApp, o DB manda (fail-safe: pausa).
        if (waHasIaOff || (!waLabelsKnown && dbHasIaOff)) {
          console.log(`IA OFF flag detected for ${phoneNumber} in tenant ${tenant.name} (waHasIaOff=${waHasIaOff}, waLabelsKnown=${waLabelsKnown}), skipping AI`);
          return new Response(JSON.stringify({ status: "ia_off" }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        if (waLabelsKnown && dbHasIaOff && !waHasIaOff) {

          console.log(`[IA OFF Check] DB had stale IA OFF flag for ${phoneNumber} but WhatsApp does not — clearing stale flag and releasing AI`);
          // ⚠️ CRÍTICO: precisa REMOVER a flag do DB, senão o recheck pós-debounce
          // lê o DB, ainda encontra a IA OFF antiga e bloqueia a resposta pra sempre.
          // Isso é especialmente importante pra tenants que não têm coluna IA OFF
          // configurada no Kanban (allConfiguredFlagIds não inclui o ID vindo do
          // fallback UAZAPI, então a reconciliação bidirecional acima não limpa).
          try {
            if (leadData?.[0]) {
              const cleaned = flagLabels.filter(
                (f: string) => !iaOffLabelIds.includes(f) && !/ia\s*off/i.test(f),
              );
              await supabase.from("crm_leads")
                .update({ flag_labels: cleaned, updated_at: new Date().toISOString() })
                .eq("id", leadData[0].id);
              console.log(`[IA OFF Check] Cleared stale IA OFF flag for ${phoneNumber} in DB`);
            }
          } catch (e) {
            console.error("[IA OFF Check] Failed to clear stale IA OFF flag:", e);
          }
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

      // Nota: o handler antigo de ❌ vivia aqui e só rodava depois do skip de
      // fromMe + resolução de tenant + debounce. Ele foi movido pra bem antes
      // (logo após o parse do phoneNumber) pra funcionar também quando o dono do
      // salão manda ❌ do próprio WhatsApp e pra normalizar variantes com
      // variation selector. Ver bloco "MemoryReset EARLY" acima.


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
            errors: [{ message: `Pipeline error: ${errMsg}`, level: "error" }],
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
        const send = await uazapiSendTextWithRetry(uazapiUrl, uazapiToken, phoneNumber, part);
        const sendData = send.data || {};
        console.log(`UAZAPI send part ${i + 1}/${messageParts.length} (tentativas: ${send.attempts}):`, JSON.stringify(sendData).slice(0, 200));
        sentMessageId = (sendData?.id || sendData?.messageId || sendData?.key?.id || null) as string | null;
        if (i === 0) {
          tFirstSend = Date.now();
          if (!send.ok) firstSendError = `${send.error} (após ${send.attempts} tentativa(s))`;
        }
        if (!send.ok) console.error(`UAZAPI send falhou parte ${i + 1}: ${send.error}`);


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

      const logErrors: LogEntry[] = [...(agentResult?.errors || [])];
      if (firstSendError) logErrors.push({ message: firstSendError, level: "error" });

      await insertAgentLogResilient(supabase, {
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
        http_trace: getHttpTraceCapped(),
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
};

Deno.serve((req) => httpTraceStore.run([], () => handleWebhookRequest(req)));

// ===================== AUTO-REGISTER CLIENT =====================

async function autoRegisterClient(_tenant: any, phoneNumber: string, provider: string): Promise<void> {
  console.log(`[AutoRegister] Skipped generic auto-registration for ${provider}/${phoneNumber} — waiting for explicit client name.`);
}

// ===================== AI AGENT =====================

// Nível de severidade dos logs de erro/aviso do agente. "warning" = sistema
// funcionando como projetado (trava intencional, recuperação de conflito,
// dedupe, etc.). "error" = falha de verdade que merece atenção humana.
type LogEntry = { message: string; level: "error" | "warning" };

interface AgentResult {
  response: string;
  toolCalls: { name: string; args: any; result: any; blocked?: boolean; deduplicated?: boolean; originalArgs?: any; resolvedArgs?: any; correctionReason?: string }[];
  errors: LogEntry[];
  model: string;
  durationMs: number;
  sessionBlocked: boolean;
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
  selectedSalonId: number | null;
  // Persistent selections (survive across messages)
  selectedServiceId: number | null;
  selectedProfessionalId: number | null;
  selectedDate: string | null;
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
  // FRIZZAR — memória persistida da última `listar_horarios` por profissional.
  // Migrado do Map in-process (que sumia entre cold starts de instâncias diferentes
  // do Deno, causando falso "não listou antes" e bloqueando agendamento legítimo).
  frizzarListedByProfessional?: Array<{
    profissionalId: number;
    dia: string;
    listedAt: number; // epoch ms
  }>;
  // FRIZZAR — ownership do clienteId desta conversa (evita vazamento cruzado
  // do tipo do bug antigo da Trinks: IA passa clienteId de outra pessoa em
  // buscar_agendamentos e recebe agendamentos alheios).
  frizzarClienteId?: number | null;
  // FRIZZAR — profissionais válidos vindos de listar_profissionais /
  // listar_horarios_geral. Bloqueia profissionalId alucinado em `agendar`.
  frizzarValidProfessionalIds?: number[];
  // APPBARBER — profissionais válidos vindos de listar_profissionais /
  // listar_horarios / listar_horarios_geral. Bloqueia professional_code
  // alucinado em `criar_agendamento` (grave: /v1/availability tem bug que
  // ignora filtro por profissional e devolve grade de todos).
  appbarberValidProfessionalCodes?: number[];
  appbarberServiceCatalog?: Array<{
    service_code: number;
    name: string;
    duration_minutes: number | null;
  }>;
  // APPBARBER — slots reais consultados por serviço/profissional/data.
  // Usado para montar uma ÚNICA comanda com múltiplos serviços quando a IA
  // consultou disponibilidade de corte + sobrancelha, mas tenta criar só o
  // primeiro service_code. Evita depender do LLM/guard para completar depois.
  appbarberSlotOptions?: Array<{
    service_code: number;
    service_name: string;
    duration_minutes: number | null;
    professional_code: number;
    professional_name: string;
    start_date: string;
    start_time: string;
  }>;
  // Segunda fonte de legitimidade do PhantomConfirmationGuard: registra a
  // última busca bem-sucedida de agendamento ativo (buscar_agendamento[s|_dia],
  // listar_agendamentos). Serve pra permitir reafirmar/orientar sobre agendamento
  // criado FORA da IA (ex: cliente marcou no app e depois mandou "vou atrasar").
  // TTL curto (10 min) e invalidada por qualquer cancel posterior.
  recentActiveBookingsLookup?: {
    at: number; // epoch ms
    toolName: string;
    count: number;
    times: string[]; // HH:MM extraídos do payload
    dates: string[]; // YYYY-MM-DD ou DD/MM[/YYYY]
  } | null;
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
    selectedSalonId: null,
    selectedServiceId: null,
    selectedProfessionalId: null,
    selectedDate: null,
    executedToolNames: [],
    explicitClientName: null,
    awaitingNameForRegistration: false,
    recentCompletedActions: [],
    recentAssistantReplies: [],
    frizzarListedByProfessional: [],
    frizzarClienteId: null,
    frizzarValidProfessionalIds: [],
    appbarberValidProfessionalCodes: [],
    appbarberServiceCatalog: [],
    appbarberSlotOptions: [],
    recentActiveBookingsLookup: null,
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
      selectedSalonId: s.selectedSalonId ?? null,
      selectedServiceId: s.selectedServiceId ?? null,
      selectedProfessionalId: s.selectedProfessionalId ?? null,
      selectedDate: s.selectedDate ?? null,
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
      // Frizzar service-catalog (mesma ideia da Trinks — bloqueia servicoId alucinado)
      ...(Array.isArray(s.frizzarServiceCatalog) ? { frizzarServiceCatalog: s.frizzarServiceCatalog } : { frizzarServiceCatalog: [] }),
      // Bemp / AppBarber service catalogs (bloqueio de service_code alucinado)
      ...(Array.isArray(s.bempServiceCatalog) ? { bempServiceCatalog: s.bempServiceCatalog } : { bempServiceCatalog: [] }),
      ...(Array.isArray(s.appbarberServiceCatalog) ? { appbarberServiceCatalog: s.appbarberServiceCatalog } : { appbarberServiceCatalog: [] }),
      // Ownership tracking (Frizzar/AppBarber) — impede cancelamento de agendamento de terceiro
      ...(Array.isArray(s.frizzarValidAgendasIds) ? { frizzarValidAgendasIds: s.frizzarValidAgendasIds } : { frizzarValidAgendasIds: [] }),
      ...(Array.isArray(s.appbarberValidInvoiceCodes) ? { appbarberValidInvoiceCodes: s.appbarberValidInvoiceCodes } : { appbarberValidInvoiceCodes: [] }),
      // FRIZZAR — ownership do clienteId + catálogo de profissionais válidos
      frizzarClienteId: typeof s.frizzarClienteId === "number" ? s.frizzarClienteId : null,
      ...(Array.isArray(s.frizzarValidProfessionalIds)
        ? { frizzarValidProfessionalIds: s.frizzarValidProfessionalIds.filter((n: any) => typeof n === "number").slice(0, 100) }
        : { frizzarValidProfessionalIds: [] }),
      ...(Array.isArray(s.appbarberValidProfessionalCodes)
        ? { appbarberValidProfessionalCodes: s.appbarberValidProfessionalCodes.filter((n: any) => typeof n === "number").slice(0, 100) }
        : { appbarberValidProfessionalCodes: [] }),
      ...(Array.isArray(s.appbarberSlotOptions)
        ? {
            appbarberSlotOptions: s.appbarberSlotOptions
              .filter((slot: any) => slot && typeof slot.service_code === "number" && typeof slot.professional_code === "number" && typeof slot.start_date === "string" && typeof slot.start_time === "string")
              .slice(-300),
          }
        : { appbarberSlotOptions: [] }),
      trinksSelectedServiceId: typeof s.trinksSelectedServiceId === "number" ? s.trinksSelectedServiceId : null,
      trinksSelectedServiceDuration: typeof s.trinksSelectedServiceDuration === "number" ? s.trinksSelectedServiceDuration : null,
      trinksSelectedServiceName: typeof s.trinksSelectedServiceName === "string" ? s.trinksSelectedServiceName : null,
      trinksLockUpdatedAt: typeof s.trinksLockUpdatedAt === "number" ? s.trinksLockUpdatedAt : 0,
      frizzarListedByProfessional: Array.isArray(s.frizzarListedByProfessional)
        ? s.frizzarListedByProfessional
            .filter((r: any) => r && typeof r.profissionalId === "number" && typeof r.dia === "string" && typeof r.listedAt === "number")
            .slice(-30)
        : [],
      recentActiveBookingsLookup: (s.recentActiveBookingsLookup && typeof s.recentActiveBookingsLookup === "object"
        && typeof s.recentActiveBookingsLookup.at === "number"
        && typeof s.recentActiveBookingsLookup.count === "number"
        && Array.isArray(s.recentActiveBookingsLookup.times)
        && Array.isArray(s.recentActiveBookingsLookup.dates))
        ? {
            at: s.recentActiveBookingsLookup.at,
            toolName: String(s.recentActiveBookingsLookup.toolName || ""),
            count: s.recentActiveBookingsLookup.count,
            times: s.recentActiveBookingsLookup.times.filter((t: any) => typeof t === "string").slice(0, 30),
            dates: s.recentActiveBookingsLookup.dates.filter((d: any) => typeof d === "string").slice(0, 30),
          }
        : null,
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
      executedToolNames: state.executedToolNames,
      selectedSalonId: state.selectedSalonId,
      selectedServiceId: state.selectedServiceId,
      selectedProfessionalId: state.selectedProfessionalId,
      selectedDate: state.selectedDate,
      explicitClientName: state.explicitClientName,
      awaitingNameForRegistration: state.awaitingNameForRegistration ?? false,
      recentCompletedActions: (state.recentCompletedActions || []).slice(-12),
      recentAssistantReplies: (state.recentAssistantReplies || []).slice(-6),
      // Trinks service-lock (sobrevive entre mensagens; impede troca silenciosa de serviço)
      trinksServiceCatalog: Array.isArray((state as any).trinksServiceCatalog)
        ? (state as any).trinksServiceCatalog.slice(0, 200)
        : [],
      // Frizzar service-catalog (bloqueia servicoId fora do que foi listado nesta conversa)
      frizzarServiceCatalog: Array.isArray((state as any).frizzarServiceCatalog)
        ? (state as any).frizzarServiceCatalog.slice(0, 200)
        : [],
      // Bemp / AppBarber service catalogs
      bempServiceCatalog: Array.isArray((state as any).bempServiceCatalog)
        ? (state as any).bempServiceCatalog.slice(0, 200)
        : [],
      appbarberServiceCatalog: Array.isArray((state as any).appbarberServiceCatalog)
        ? (state as any).appbarberServiceCatalog.slice(0, 200)
        : [],
      // Ownership caches
      frizzarValidAgendasIds: Array.isArray((state as any).frizzarValidAgendasIds)
        ? (state as any).frizzarValidAgendasIds.slice(0, 50)
        : [],
      appbarberValidInvoiceCodes: Array.isArray((state as any).appbarberValidInvoiceCodes)
        ? (state as any).appbarberValidInvoiceCodes.slice(0, 50)
        : [],
      // FRIZZAR — ownership do cliente + profissionais válidos
      frizzarClienteId: (state as any).frizzarClienteId ?? null,
      frizzarValidProfessionalIds: Array.isArray((state as any).frizzarValidProfessionalIds)
        ? (state as any).frizzarValidProfessionalIds.slice(0, 100)
        : [],
      // APPBARBER — profissionais válidos (bloqueia professional_code alucinado)
      appbarberValidProfessionalCodes: Array.isArray((state as any).appbarberValidProfessionalCodes)
        ? (state as any).appbarberValidProfessionalCodes.slice(0, 100)
        : [],
      appbarberSlotOptions: Array.isArray((state as any).appbarberSlotOptions)
        ? (state as any).appbarberSlotOptions.slice(-300)
        : [],
      trinksSelectedServiceId: (state as any).trinksSelectedServiceId ?? null,
      trinksSelectedServiceDuration: (state as any).trinksSelectedServiceDuration ?? null,
      trinksSelectedServiceName: (state as any).trinksSelectedServiceName ?? null,
      trinksLockUpdatedAt: (state as any).trinksLockUpdatedAt ?? 0,
      // Frizzar: última grade listada por profissional (persistida cross-instância)
      frizzarListedByProfessional: Array.isArray((state as any).frizzarListedByProfessional)
        ? (state as any).frizzarListedByProfessional.slice(-30)
        : [],
      recentActiveBookingsLookup: (state as any).recentActiveBookingsLookup ?? null,
    };

    await supabase
      .from("conversation_state")
      .upsert(
        { tenant_id: tenantId, phone_number: phoneNumber, state: stateToSave },
        { onConflict: "tenant_id,phone_number" }
      );
    console.log(`[State] Saved for ${phoneNumber}: services=${state.oneBelezaServiceOptions.length}, allowed=${state.allowedServiceIds.length}, profs=${state.oneBelezaProfessionalOptions.length}, slots=${state.oneBelezaSlotOptions.length}, bempSalons=${state.bempSalonOptions.length}, tools=${state.executedToolNames.length}, recentActions=${(state.recentCompletedActions || []).length}, sel=${state.selectedSalonId}/${state.selectedServiceId}/${state.selectedProfessionalId}/${state.selectedDate}`);
  } catch (err) {
    console.error("[State] Save failed:", err);
  }
}

// ===================== ACTIVE BOOKINGS LOOKUP TRACKING =====================
// Segunda fonte de legitimidade do PhantomConfirmationGuard: quando o cliente
// tem agendamento criado FORA da IA (ex: pelo app do provider), o ledger de
// ações criadas nesta sessão fica vazio. Se a IA acabou de rodar uma tool de
// leitura (buscar_agendamento[s|_dia] / listar_agendamentos) e recebeu ao
// menos 1 agendamento ativo, isso conta como prova válida de que o agendamento
// existe de verdade. Guard fica frouxo por 10 min e é invalidado por qualquer
// cancel bem-sucedido posterior.

const ACTIVE_BOOKING_LOOKUP_TOOLS = new Set([
  "buscar_agendamento",       // Trinks
  "buscar_agendamentos",      // Frizzar (retorno array)
  "buscar_agendamentos_dia",  // OneBeleza
  "listar_agendamentos",      // Bemp + AppBarber
]);
const ACTIVE_BOOKING_LOOKUP_TTL_MS = 10 * 60 * 1000;

function _extractTimesAndDatesFromPayload(payload: unknown): { times: string[]; dates: string[]; count: number } {
  let count = 0;
  if (Array.isArray(payload)) {
    count = payload.length;
  } else if (payload && typeof payload === "object") {
    const anyP = payload as any;
    if (Array.isArray(anyP.appointments)) count = anyP.appointments.length;
    else if (Array.isArray(anyP.data)) count = anyP.data.length;
    else if (Array.isArray(anyP.agendamentos)) count = anyP.agendamentos.length;
    else if (Array.isArray(anyP.items)) count = anyP.items.length;
    else if (anyP.id || anyP.agendamentoId || anyP.invoice_code) count = 1;
  }
  let json = "";
  try { json = typeof payload === "string" ? payload : JSON.stringify(payload ?? {}); } catch { json = ""; }
  // Extração ancorada: pega HH:MM que vem logo depois de uma data ISO (yyyy-MM-dd
  // com "T" ou espaço como separador — Trinks/Bemp/AppBarber usam esse formato),
  // ou em campos de horário nomeados (hora/horario/time/hour/inicio), ou em
  // strings JSON que contenham exatamente HH:MM(:SS). Evita capturar segundos
  // (":00" final de ISO) e offsets de timezone (-03:00). Ver bug documentado
  // na conversa: \b não ativa entre "T" e dígito, o que fazia o regex antigo
  // capturar "00:00" (segundos) em "2026-07-09T09:00:00".
  const timeSet = new Set<string>();
  const pushTime = (h: string, m: string) => {
    const hh = h.padStart(2, "0");
    const hn = Number(hh);
    if (hn >= 0 && hn <= 23) timeSet.add(`${hh}:${m}`);
  };
  for (const m of json.matchAll(/\d{4}-\d{2}-\d{2}[T ](\d{2}):(\d{2})/g)) pushTime(m[1], m[2]);
  for (const m of json.matchAll(/"(?:hora|horario|hora_?inicio|hora_?fim|inicio|fim|time|hour|start|end)"\s*:\s*"(\d{1,2}):(\d{2})(?::\d{2})?"/gi)) pushTime(m[1], m[2]);
  for (const m of json.matchAll(/"(\d{1,2}):(\d{2})(?::\d{2})?"/g)) pushTime(m[1], m[2]);
  const times = Array.from(timeSet);
  const dates = Array.from(new Set([
    ...(json.match(/\b\d{4}-\d{2}-\d{2}\b/g) || []),
    ...(json.match(/\b\d{2}\/\d{2}(?:\/\d{4})?\b/g) || []),
  ]));
  return { times, dates, count };
}

function recordActiveBookingsLookup(state: AgentSessionState, toolName: string, toolResult: unknown): void {
  const { times, dates, count } = _extractTimesAndDatesFromPayload(toolResult);
  if (count <= 0) return; // busca vazia não conta como prova
  state.recentActiveBookingsLookup = {
    at: Date.now(),
    toolName,
    count,
    times,
    dates,
  };
  console.log(`[ActiveBookingsLookup] ${toolName}: count=${count} times=${times.join(",")} dates=${dates.slice(0, 5).join(",")}`);
}

function isActiveBookingLookupStillValid(state: AgentSessionState): boolean {
  const lu = state.recentActiveBookingsLookup;
  if (!lu || lu.count <= 0) return false;
  if (Date.now() - lu.at > ACTIVE_BOOKING_LOOKUP_TTL_MS) return false;
  // Invalidação por cancel bem-sucedido depois da busca
  const cancelAfter = (state.recentCompletedActions || []).some((a) => {
    if (a.category !== "booking_cancel" || a.status !== "success") return false;
    const t = Date.parse(a.completedAt);
    return Number.isFinite(t) && t > lu.at;
  });
  return !cancelAfter;
}

function responseCitesLookupBooking(text: string, state: AgentSessionState): boolean {
  const lu = state.recentActiveBookingsLookup;
  if (!lu) return false;
  const responseTimes = new Set<string>((text.match(/\b([01]?\d|2[0-3]):[0-5]\d\b/g) || []));
  const responseHourOnly = new Set<string>(
    (text.match(/\b(\d{1,2})\s*h(?![a-z0-9])/gi) || []).map((s) => (s.match(/\d+/) || [""])[0].replace(/^0+/, "") || "0"),
  );
  const lookupTimes = new Set<string>(lu.times);
  const lookupHourOnly = new Set<string>(lu.times.map((t) => (t.split(":")[0] || "").replace(/^0+/, "") || "0"));
  for (const rt of responseTimes) {
    if (lookupTimes.has(rt)) return true;
    const h = (rt.split(":")[0] || "").replace(/^0+/, "") || "0";
    if (lookupHourOnly.has(h)) return true;
  }
  for (const h of responseHourOnly) {
    if (lookupHourOnly.has(h)) return true;
  }
  // Fallback: se cita uma data que aparece na busca
  const responseDates = new Set<string>([
    ...((text.match(/\b\d{4}-\d{2}-\d{2}\b/g) || [])),
    ...((text.match(/\b\d{2}\/\d{2}(?:\/\d{4})?\b/g) || [])),
  ]);
  for (const d of responseDates) {
    if (lu.dates.includes(d)) return true;
  }
  return false;
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
    // Cobre todas as variantes por provider: trinks (servicoId), onebeleza
    // (servicoid), frizzar (serviceId), appbarber (service_code), bemp (servicos[])
    const candidates = [args.serviceId, args.servicoId, args.servicosId, args.servicoid, args.service_code, args.serviceCode];
    for (const c of candidates) if (c) serviceIds.push(String(c));
    if (Array.isArray(args.servicos)) {
      for (const s of args.servicos) {
        const sid = s?.codigo ?? s?.servicoId ?? s?.servicosId ?? s?.id ?? s?.service_code;
        if (sid) serviceIds.push(String(sid));
      }
    }
    const dt = pick("dataHoraInicio", "start");
    const date = pick("dia", "data", "date", "dataNumero", "start_date") || (dt ? dt.slice(0, 10) : "");
    const time = pick("hora", "horario", "time", "horarioInicio", "start_time") || (dt.length >= 16 ? dt.slice(11, 16) : "");
    const prof = pick("profissionalId", "professionalId", "barberId", "professional_code", "employee_code");
    const clientHint = pick("clienteId", "clientId", "nome", "name", "customer_name", "customer_phone");
    return `${toolName}|${serviceIds.sort().join(",")}|${date}|${time}|${prof}|${clientHint}`;
  }

  if (toolName === "cancelar_agendamento" || toolName === "desmarcar_agendamento" || toolName === "confirmar_agendamento") {
    return `${toolName}|${pick("agendamentoId", "appointmentId", "id", "agendasId", "invoice_code", "invoice_item_code")}`;
  }

  if (toolName === "editar_agendamento") {
    return `${toolName}|${pick("agendamentoId", "appointmentId", "id", "invoice_code")}|${pick("dataHoraInicio", "start", "data", "start_date")}|${pick("hora", "time", "start_time")}`;
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
      const date = args?.dia || args?.data || args?.date || args?.dataNumero || args?.start_date || (typeof args?.dataHoraInicio === "string" ? args.dataHoraInicio.slice(0, 10) : "") || (typeof args?.start === "string" ? args.start.slice(0, 10) : "");
      const time = args?.hora || args?.horario || args?.time || args?.horarioInicio || args?.start_time || (typeof args?.dataHoraInicio === "string" && args.dataHoraInicio.length >= 16 ? args.dataHoraInicio.slice(11, 16) : "") || (typeof args?.start === "string" && args.start.length >= 16 ? args.start.slice(11, 16) : "");
      const prof = args?.profissionalId || args?.professionalId || args?.barberId || args?.professional_code || args?.employee_code || "";
      return `agendamento concluído (data=${date || "?"} hora=${time || "?"} prof=${prof || "?"}) id=${result?.id || result?.agendamentoId || result?.invoice_code || "?"}`;
    }
    if (toolName === "cancelar_agendamento" || toolName === "desmarcar_agendamento") {
      return `cancelamento concluído id=${args?.agendamentoId || args?.id || args?.agendasId || args?.invoice_code || "?"}`;
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
// content vazio, etc.). Cobre Frizzar / Trinks / One Beleza / Bemp.
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

// isRecoverableFrizzarScheduleResult + buildFrizzarScheduleRecoveryInstruction
// foram movidos para providers/frizzar/index.ts (jul/2026).



// ===================== ID RESOLUTION LAYER =====================






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



function normalizeSearchText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function normalizeServiceText(value: unknown): string {
  return normalizeSearchText(value)
    .replace(/[^a-z0-9\s+]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitServiceNameTokens(value: unknown): string[] {
  return normalizeServiceText(value)
    .split(/\s*(?:\+|\be\b|,|\/|&|\bmais\b|\bjunto\b|\bcom\b)\s*/i)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3);
}

function serviceNameImpliesAnotherService(bookedServiceName: string, candidateServiceName: string): boolean {
  const booked = normalizeServiceText(bookedServiceName);
  const candidate = normalizeServiceText(candidateServiceName);
  if (!booked || !candidate || booked === candidate) return false;

  // Se o serviço reservado já é um combo explícito do catálogo (ex.: "Corte + sobrancelha"),
  // não devemos criar outro item de "sobrancelha". Se o serviço reservado é só "Corte",
  // ele NÃO cobre "sobrancelha" — aí a fusão determinística entra.
  const bookedParts = splitServiceNameTokens(booked);
  if (bookedParts.length >= 2 && bookedParts.some((part) => part === candidate || part.includes(candidate) || candidate.includes(part))) {
    return true;
  }

  return booked.includes(candidate) || candidate.includes(booked);
}

// inferAppBarberServicesForSameSlot foi movido para providers/appbarber/index.ts.











// ============================================================================
// MULTI-BOOKING GUARD (Camadas 1+2+3)
// Impede que a IA responda "tá tudo certo" quando prometeu N agendamentos
// (dentro do limite automático) e executou menos. A correção é a IA continuar chamando a tool de
// agendamento com os dados já presentes — sem pedir dados de novo e sem humano.
// Só é acionado quando a IA tentou criar pelo menos 1 agendamento no turno.
// ============================================================================

const MAX_AUTO_BOOKINGS = 6;
const MAX_GUARD_RECOVERY_ROUNDS = 3;
const BOOKING_TOOL_NAMES = new Set(["agendar", "criar_agendamento"]);
// Regex Camada 3 — confirmação implícita de sucesso no texto da IA.
// Não depende de palavra específica de "agendei" — cobre também "te espero", "show", etc.
const IMPLICIT_CONFIRMATION_RE =
  /\b(confirm|agendei|marquei|marcado|pronto|feito|t[aá]\s+marcado|t[aá]\s+combinado|show|beleza|te\s+espero|te\s+aguard|at[eé]\s+l[aá]|nos\s+vemos)\b/i;

/** Conta quantas vezes o modelo TENTOU chamar agendar/criar_agendamento no turno (sucesso ou não). */
function countBookingCallAttempts(logToolCalls: any[]): number {
  return (logToolCalls || []).filter((tc) => tc && BOOKING_TOOL_NAMES.has(tc.name)).length;
}

// ============================================================================
// 🛡️ PhantomConfirmationGuard — CONFIG POR PROVIDER (isolada)
// Cada API declara os próprios nomes de ferramenta no seu módulo
// (providers/<api>/index.ts → phantomGuardConfig). Aqui só o dispatcher.
// Assim, remover/ajustar uma API não mexe no comportamento das outras.
// ============================================================================
type PhantomGuardConfig = {
  enabled: boolean;
  bookingToolNames: string[];
  searchToolNames: string[];
  recoveryToolNames: string[];
};
const PHANTOM_GUARD_CONFIG_BY_PROVIDER: Record<string, PhantomGuardConfig> = {
  trinks: trinksPhantomGuardConfig,
  appbarber: appbarberPhantomGuardConfig,
  bemp: bempPhantomGuardConfig,
  onebeleza: onebelezaPhantomGuardConfig,
  frizzar: frizzarPhantomGuardConfig,
};
function getPhantomGuardConfig(provider: string): PhantomGuardConfig | null {
  const cfg = PHANTOM_GUARD_CONFIG_BY_PROVIDER[provider];
  return cfg && cfg.enabled ? cfg : null;
}

// ============================================================================
// 🛡️ MultiBooking / Cancel / Reschedule Guards — CONFIG POR PROVIDER (isolada)
// Cada API declara em providers/<api>/index.ts → bookingGuardsConfig se cada
// guard roda e com quais nomes de ferramenta. Hoje só Frizzar e AppBarber estão
// ligados, cada um com sua própria config; as demais ficam desligadas.
// ============================================================================
type BookingGuardsConfig = {
  multiBooking: {
    enabled: boolean;
    bookingToolNames: string[];
    primaryBookingToolName: string;
    useIntentShape: boolean;
    skipWhenSingleVisit: boolean;
    useAlternativesShortCircuit: boolean;
    recoveryToolChoice: "required" | "auto";
  };
  cancel: { enabled: boolean; cancelToolNames: string[] };
  reschedule: { enabled: boolean; cancelToolNames: string[]; bookingToolNames: string[] };
};
const BOOKING_GUARDS_CONFIG_BY_PROVIDER: Record<string, BookingGuardsConfig> = {
  frizzar: frizzarBookingGuardsConfig,
  appbarber: appbarberBookingGuardsConfig,
  trinks: trinksBookingGuardsConfig,
  bemp: bempBookingGuardsConfig,
  onebeleza: onebelezaBookingGuardsConfig,
};
const DISABLED_BOOKING_GUARDS: BookingGuardsConfig = {
  multiBooking: {
    enabled: false,
    bookingToolNames: [],
    primaryBookingToolName: "",
    useIntentShape: false,
    skipWhenSingleVisit: false,
    useAlternativesShortCircuit: false,
    recoveryToolChoice: "auto",
  },
  cancel: { enabled: false, cancelToolNames: [] },
  reschedule: { enabled: false, cancelToolNames: [], bookingToolNames: [] },
};
function getBookingGuardsConfig(provider: string): BookingGuardsConfig {
  return BOOKING_GUARDS_CONFIG_BY_PROVIDER[provider] || DISABLED_BOOKING_GUARDS;
}


/**
 * Conta agendamentos EFETIVAMENTE criados no turno, com regras específicas por provider.
 * Validado contra o código real de cada execute<Provider>Tool.
 * Retorna { count, breakdown } onde breakdown lista cada booking pra montar mensagem.
 */
// Extrai o nome real do(s) serviço(s) reservado(s) com sucesso nesta rodada.
// Usado pelo classificador do MultiBookingGuard pra reconciliar "o cliente falou
// X" com "o serviço que de fato foi agendado já é um combo cobrindo X sozinho"
// (ex: cliente diz "corte e barba", mas o catálogo já vende isso como 1 serviço).
// Dispatcher que delega a extração do nome do serviço reservado pro módulo
// do provider correto. A lógica específica de cada API vive no provider.
function extractBookedServiceNames(
  logToolCalls: Array<{ name: string; args: any; result: any; blocked?: boolean }>,
  provider: string,
  sessionState: any,
): string[] {
  const perProviderExtractor: Record<string, (tc: any, s: any) => string[]> = {
    trinks: extractTrinksBookedServiceNames,
    onebeleza: extractOneBelezaBookedServiceNames,
    frizzar: extractFrizzarBookedServiceNames,
    bemp: extractBempBookedServiceNames,
    appbarber: extractAppBarberBookedServiceNames,
  };
  const extractor = perProviderExtractor[provider];
  if (!extractor) return [];
  const names: string[] = [];
  for (const tc of logToolCalls || []) {
    if (!tc || tc.blocked || !BOOKING_TOOL_NAMES.has(tc.name)) continue;
    for (const name of extractor(tc, sessionState)) {
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

// Formata data/hora de agendamento de forma humanizada: "hoje às HH:MM" se for
// hoje (fuso America/Sao_Paulo), ou "DD/MM às HH:MM" caso contrário. Aceita
// ISO completo (yyyy-MM-ddTHH:mm ou yyyy-MM-dd HH:MM) ou data+hora separadas.
function formatBookingWhen(dateStr: string, timeStr?: string): string {
  const cleaned = String(dateStr || "").trim();
  const m = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return timeStr ? `${cleaned} às ${timeStr}` : cleaned || "horário";

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  let hour = m[4];
  let minute = m[5];

  if (timeStr) {
    const tm = String(timeStr).trim().match(/^(\d{1,2})[:h](\d{2})/);
    if (tm) {
      hour = tm[1].padStart(2, "0");
      minute = tm[2];
    }
  }

  const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
  const [ty, tmo, td] = todayStr.split("-").map(Number);
  const isToday = year === ty && month === tmo && day === td;

  const timePart = hour && minute ? `${hour}:${minute}` : null;
  if (isToday) return timePart ? `hoje às ${timePart}` : "hoje";
  const dateFormatted = `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}`;
  return timePart ? `${dateFormatted} às ${timePart}` : dateFormatted;
}

// Monta o summary humanizado a partir da BookingEvaluation devolvida pelo
// provider. Toda a lógica de "hoje às HH:MM" fica aqui; cada provider só devolve
// os pedaços crus (data, hora, nome do serviço/profissional). Se um dia mudar o
// formato de exibição, muda só neste ponto — nenhum provider precisa saber.
function formatBookingSummary(ev: {
  serviceName?: string;
  dateStr: string;
  timeStr?: string;
  professionalName?: string;
  extraServiceCount?: number;
  fallbackSuffix?: string;
}): string {
  const when = formatBookingWhen(ev.dateStr, ev.timeStr);
  const head = ev.serviceName ? `${ev.serviceName} ${when}` : when;
  const withPro = ev.professionalName ? `${head} com ${ev.professionalName}` : head;
  const withCount = ev.extraServiceCount && ev.extraServiceCount > 1
    ? `${withPro} (${ev.extraServiceCount} serviços)`
    : withPro;
  if (!ev.serviceName && ev.fallbackSuffix) return `${withCount} ${ev.fallbackSuffix}`;
  return withCount;
}

// Dispatcher que delega a avaliação de sucesso pro módulo do provider correto.
// A parte transversal (alreadyBooked/blocked/error/status>=400) fica aqui;
// cada provider só decide "esse `tc` é sucesso? quantos? qual summary?".
function countSuccessfulBookingsInTurn(
  logToolCalls: any[],
  provider: string,
  sessionState?: any,
): { count: number; breakdown: Array<{ tool: string; summary: string }>; executions: number } {
  const breakdown: Array<{ tool: string; summary: string }> = [];
  let count = 0;
  // executions = quantas chamadas distintas de agendar/criar_agendamento tiveram sucesso
  // nesta rodada. Diferente de `count`, que pode ser inflado por bookedCount>1 dentro
  // da MESMA chamada (ex.: Frizzar aceita servicos:[A,B] no mesmo agendar → 1 execução,
  // mas count=2 se cada serviço vira uma linha). Usado pelo classifier para não inflar
  // "prometidos" só porque há N nomes de serviço dentro de UMA única execução.
  let executions = 0;
  // Frizzar pode receber duas chamadas separadas para serviços da mesma pessoa
  // na mesma visita. Para o MultiBookingGuard isso continua sendo UMA visita;
  // deduplica pela identidade operacional da comanda sem afetar outros providers.
  const frizzarVisitKeys = new Set<string>();

  const perProviderEvaluator: Record<string, (tc: any, s?: any) => {
    succeeded: boolean;
    bookedCount: number;
    serviceName?: string;
    dateStr: string;
    timeStr?: string;
    professionalName?: string;
    extraServiceCount?: number;
    fallbackSuffix?: string;
  } | null> = {
    trinks: evaluateTrinksBooking,
    onebeleza: evaluateOneBelezaBooking,
    frizzar: evaluateFrizzarBooking,
    bemp: evaluateBempBooking,
    appbarber: evaluateAppBarberBooking,
  };
  const evaluator = perProviderEvaluator[provider];

  for (const tc of logToolCalls || []) {
    if (!tc || !BOOKING_TOOL_NAMES.has(tc.name)) continue;
    const r = tc.result;
    if (!r || typeof r !== "object") continue;
    const args = tc.args || {};
    const isAlreadyBooked = r.alreadyBooked === true || r.status === "SUCESSO_ANTERIOR_JA_REGISTRADO";

    // Duplicidade já registrada conta como concluído — senão o guard tenta
    // repetir a mesma reserva e zera `criados`.
    if (isAlreadyBooked) {
      const when = formatBookingWhen(
        String(args.dia || args.data || args.date || args.dataHoraInicio || args.start || args.start_date || ""),
        String(args.hora || args.horario || args.time || args.start_time || ""),
      );
      breakdown.push({ tool: tc.name, summary: `${when} (já registrado)` });
      count += 1;
      executions += 1;
      continue;
    }

    // Regra transversal: bloqueado ou com erro NUNCA conta.
    if (r.blocked === true) continue;
    if (r.error) continue;
    if (Array.isArray(r.Errors) && r.Errors.length > 0) continue;
    if (typeof r.status === "number" && r.status >= 400) continue;

    if (!evaluator) continue;
    const ev = evaluator(tc, sessionState);
    if (!ev?.succeeded) continue;
    if (provider === "frizzar") {
      const visitKey = [
        String(args.clienteId ?? ""),
        String(args.dia ?? ""),
        String(args.hora ?? ""),
        String(args.profissionalId ?? ""),
      ].join("|");
      if (frizzarVisitKeys.has(visitKey)) continue;
      frizzarVisitKeys.add(visitKey);
    }
    const summary = formatBookingSummary(ev);
    count += ev.bookedCount;
    executions += 1;
    for (let i = 0; i < ev.bookedCount; i++) breakdown.push({ tool: tc.name, summary });
  }

  return { count, breakdown, executions };
}

function parseSmallPtNumber(value: string): number | null {
  const v = String(value || "").toLowerCase();
  const map: Record<string, number> = {
    "1": 1,
    um: 1,
    uma: 1,
    "2": 2,
    dois: 2,
    duas: 2,
    "3": 3,
    tres: 3,
    três: 3,
    "4": 4,
    quatro: 4,
    "5": 5,
    cinco: 5,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
  };
  return map[v] ?? null;
}

// ⚠️ FRIZZAR-ONLY: chamada só via classifyPendingBookings / heuristicPromisedFromWindow,
// que hoje só rodam dentro do MultiBookingGuard (gated em provider === "frizzar").
// Se um dia religar o guard noutro provider, revisar as regras abaixo antes.
function countExplicitProfessionalSelections(text: string): number {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return 0;

  // Caso real Frizzar: "corte com Gabriel / corte e barba com Luan" = 2 reservas.
  // Uma combinação de serviços com UM profissional ("corte e barba com Gabriel")
  // continua sendo 1 reserva; só sobe quando há 2+ seleções "com Nome".
  const professionalMentions = normalized.match(/\bcom\s+[A-ZÁÀÂÃÉÊÍÓÔÕÚÇ][A-Za-zÀ-ÿ'-]*/g) || [];
  if (professionalMentions.length >= 2) return professionalMentions.length;

  // Caso real: cliente responde só "Pode ser Luan e Gabriel" depois da IA
  // listar profissionais. Não há "com Nome", mas há 2 nomes próprios unidos.
  // Exclui termos comuns de serviço para não transformar "Corte e Barba" em 2 pessoas.
  const properNameMatches = normalized.match(/\b[A-ZÁÀÂÃÉÊÍÓÔÕÚÇ][A-Za-zÀ-ÿ'-]{2,}\b/g) || [];
  const ignored = new Set([
    "Pode", "Hoje", "Amanhã", "Amanha", "Corte", "Barba", "Sobrancelha", "Acabamento",
    "Combo", "Masculino", "Feminino", "Infantil", "Idoso", "Express", "Limpeza",
    "Hidratação", "Hidratacao", "Depilação", "Depilacao", "Nariz", "Orelha",
    // Verbos/comandos comuns no começo da frase não são nomes de profissional.
    // Caso real Trinks: "Marca 18:00 com Ramon" virava 2 porque contava
    // "Marca" + "Ramon" como dois nomes próprios.
    "Marca", "Marcar", "Agende", "Agenda", "Agendar", "Quero", "Queria", "Gostaria",
    "Por", "Favor", "Obrigado", "Obrigada", "Boa", "Bom", "Oi", "Ola", "Olá",
  ]);
  const names = [...new Set(properNameMatches.filter((name) => !ignored.has(name)))];
  const hasSelectionConnector = /\b(?:pode\s+ser|prefiro|quero|marca|marcar|agenda|agendar|fechado|beleza|sim)\b/i.test(normalized)
    || /\b[A-ZÁÀÂÃÉÊÍÓÔÕÚÇ][A-Za-zÀ-ÿ'-]{2,}\b\s*(?:,|\/|\be\b|\bou\b)\s*\b[A-ZÁÀÂÃÉÊÍÓÔÕÚÇ][A-Za-zÀ-ÿ'-]{2,}\b/.test(normalized);
  if (hasSelectionConnector && names.length >= 2) return names.length;

  return professionalMentions.length;
}

function countExplicitUserTimeSelections(text: string): number {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return 0;

  const explicitUserTimes = new Set<string>();
  const timeRe = /\b(\d{1,2})(?::|h)(\d{2})?\b/gi;
  const normalizeTimeToken = (m: RegExpExecArray): string | null => {
    const h = Number(m[1]);
    if (h < 0 || h > 23) return null;
    const mm = m[2] ? m[2].padStart(2, "0") : "00";
    return `${h.toString().padStart(2, "0")}:${mm}`;
  };

  let userMatch: RegExpExecArray | null;
  while ((userMatch = timeRe.exec(normalized)) !== null) {
    const token = normalizeTimeToken(userMatch);
    if (token) explicitUserTimes.add(token);
  }

  // Hora solta ("14 e 15") só conta em contexto de escolha/agendamento.
  const hourOnlyContextRe = /\b(?:pode\s+ser|prefiro|quero|marca|marcar|agenda|agendar|[aà]s?|e|ou)\s+(\d{1,2})\b(?!\s*[:h]\d{2})/gi;
  let hourOnlyMatch: RegExpExecArray | null;
  while ((hourOnlyMatch = hourOnlyContextRe.exec(normalized)) !== null) {
    const h = Number(hourOnlyMatch[1]);
    if (h >= 0 && h <= 23) explicitUserTimes.add(`${h.toString().padStart(2, "0")}:00`);
  }

  return explicitUserTimes.size;
}

function hasHighConfidenceHeuristicOverride(messages: any[]): boolean {
  const visible = messages.filter(
    (m: any) =>
      (m?.role === "user" || m?.role === "assistant") &&
      typeof m?.content === "string" &&
      m.content.trim(),
  );
  const lastUser = [...visible].reverse().find((m: any) => m.role === "user")?.content || "";

  // Só permite a heurística passar por cima do LLM quando há sinal determinístico
  // de multi-agendamento na fala do cliente, ou uma confirmação curta após oferta.
  // Evita o caso Trinks: LLM acertou 1, heurística errou 2, e o guard bloqueou.
  return (
    countExplicitProfessionalSelections(lastUser) >= 2 ||
    countExplicitUserTimeSelections(lastUser) >= 2 ||
    isAffirmativeReply(lastUser)
  );
}

// ⚠️ FRIZZAR-ONLY: só usado por classifyPendingBookings (ver aviso acima).
function extractBookingCountFromReasoning(reasoning: string): number | null {
  const text = String(reasoning || "");
  const direct = text.match(/total\s*(?:de\s*)?(\d{1,2})\s*agendamentos?/i)
    || text.match(/=\s*(\d{1,2})\s*agendamentos?/i);
  if (direct) return Number(direct[1]);

  const bookingWords = "agendamentos?|appointments?|bookings?|reservas?|marcações?|marcacoes?|horários?|horarios?|slots?|pessoas?|people|clientes?|clients?|profissionais?|professionals?";
  const before = new RegExp(`\\b(\\d{1,2}|um|uma|dois|duas|tr[eê]s|quatro|cinco)\\b[^.]{0,80}\\b(${bookingWords})\\b`, "i").exec(text);
  const after = new RegExp(`\\b(${bookingWords})\\b[^.]{0,80}\\b(\\d{1,2}|um|uma|dois|duas|tr[eê]s|quatro|cinco)\\b`, "i").exec(text);
  if (before) return parseSmallPtNumber(before[1]);
  if (after) return parseSmallPtNumber(after[2]);

  const beforeEn = new RegExp(`\\b(one|two|three|four|five)\\b[^.]{0,80}\\b(${bookingWords})\\b`, "i").exec(text);
  const afterEn = new RegExp(`\\b(${bookingWords})\\b[^.]{0,80}\\b(one|two|three|four|five)\\b`, "i").exec(text);
  if (beforeEn) return parseSmallPtNumber(beforeEn[1]);
  if (afterEn) return parseSmallPtNumber(afterEn[2]);
  return null;
}

/**
 * Fallback heurístico determinístico: se o LLM falhar, olha a ÚLTIMA fala do
 * atendente antes da última mensagem do cliente e conta horários distintos
 * ofertados (14h, 14:00, 15h30 etc). Cobre o caso "IA ofereceu 14h e 15h,
 * cliente respondeu 'sim'" sem depender do classificador.
 */
function heuristicPromisedFromWindow(messages: any[], attempts: number): number {
  const visible = messages.filter(
    (m: any) =>
      (m?.role === "user" || m?.role === "assistant") &&
      typeof m?.content === "string" &&
      m.content.trim(),
  );
  // Última fala do atendente ANTES da última mensagem do cliente.
  let lastAssistant = "";
  for (let i = visible.length - 1; i >= 0; i--) {
    if (visible[i].role === "assistant") { lastAssistant = visible[i].content; break; }
  }
  if (!lastAssistant) return Math.max(1, attempts);

  const lastUser = [...visible].reverse().find((m: any) => m.role === "user")?.content || "";
  const professionalSelections = countExplicitProfessionalSelections(lastUser);
  if (professionalSelections >= 2) {
    return Math.max(1, attempts, professionalSelections);
  }

  const timeRe = /\b(\d{1,2})(?::|h)(\d{2})?\b/gi;
  const normalizeTimeToken = (m: RegExpExecArray): string | null => {
    const h = Number(m[1]);
    if (h < 0 || h > 23) return null;
    const mm = m[2] ? m[2].padStart(2, "0") : "00";
    return `${h.toString().padStart(2, "0")}:${mm}`;
  };

  // Se o CLIENTE explicitamente escolheu 2+ horários na própria mensagem
  // (ex.: "pode ser 14 e 15"), isso é promessa multi-booking mesmo sem "sim" seco.
  const explicitUserTimes = countExplicitUserTimeSelections(lastUser);
  if (explicitUserTimes >= 2) {
    return Math.max(1, attempts, explicitUserTimes);
  }

  // Só interpreta múltiplos horários da ÚLTIMA fala da IA como múltiplos
  // agendamentos quando a última fala do cliente é uma confirmação curta.
  // Caso real: cliente respondeu "Hoje, 15:20" depois de uma lista de 7 horários;
  // a heurística contava os 7 horários ofertados e escalava humano indevidamente.
  if (!isAffirmativeReply(lastUser)) return Math.max(1, attempts);

  // Quebra em frases e SÓ conta horários em frases que soam como oferta de
  // slot pra agendar. Frases sobre horário de funcionamento são explicitamente
  // excluídas (senão "funcionamos das 9h às 19h30" viraria 2 promessas).
  const OFFER_CTX_RE =
    /\b(tenho|temos|consegui|consigo|dispon[ií]vel|dispon[ií]veis|livre|livres|vago|vagos|hor[aá]rio|hor[aá]rios|slot|slots|[aà]s?\s+\d|op[çc][aã]o|op[çc][oõ]es|posso\s+(?:agendar|marcar|encaixar)|ou\s+\d|entre\s+\d)\b/i;
  const NON_BOOKING_CTX_RE =
    /\b(funcionamos|funcionamento|abrimos|fechamos|abertos?|fechados?|atendemos|atendimento|expediente|hor[aá]rio\s+de\s+funcionamento|hor[aá]rio\s+comercial|de\s+segunda|seg\s+a\s+|dom(?:ingo)?|s[aá]bado|feriado)\b/i;

  const sentences = lastAssistant
    .split(/(?<=[.!?\n])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const set = new Set<string>();
  for (const sent of sentences) {
    if (NON_BOOKING_CTX_RE.test(sent)) continue;
    if (!OFFER_CTX_RE.test(sent)) continue;
    let m: RegExpExecArray | null;
    timeRe.lastIndex = 0;
    while ((m = timeRe.exec(sent)) !== null) {
      const token = normalizeTimeToken(m);
      if (token) set.add(token);
    }
  }
  const distinct = set.size;
  // Só usamos a heurística quando ela viu 2+ horários OFERTADOS em contexto de
  // agendamento. 1 horário isolado não sobe a promessa acima de attempts —
  // evita falso positivo em "às 14h com o Luan, confirma?" quando é 1 booking só.
  const heuristicPromised = distinct >= 2 ? distinct : 0;
  return Math.max(1, attempts, heuristicPromised);
}


/**
 * Camada 1 lazy. Só é chamada quando gatilho estrutural disparou.
 * Retorna quantos agendamentos DISTINTOS o cliente confirmou/pediu na janela.
 * Fallback (LLM falhou/timeout): heurística por horários ofertados na última
 * fala do atendente — nunca só max(1, attempts), que já mordeu no teste.
 */
async function classifyPendingBookings(params: {
  messages: any[];
  aiEndpoint: string;
  aiAuthKey: string;
  modelUsed: string;
  attempts: number;
  bookedServiceNames?: string[];
  bookedExecutionCount?: number;
  priorTurnBookings?: string[];
}): Promise<{
  total: number;
  source: "llm" | "fallback";
  reasoning?: string;
  intentShape?: {
    distinctPeople: number;
    distinctTimes: number;
    distinctProfessionals: number;
    sameVisitServicesOnly: boolean;
  };
}> {
  const { messages, aiEndpoint, aiAuthKey, modelUsed, attempts, bookedServiceNames, bookedExecutionCount, priorTurnBookings } = params;
  const fallback = () => ({
    total: heuristicPromisedFromWindow(messages, attempts),
    source: "fallback" as const,
  });

  // Janela: últimas ~6 mensagens do histórico visível (só role/content, sem tool_calls).
  const window = messages
    .filter((m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string" && m.content.trim())
    .slice(-6)
    .map((m: any) => ({ role: m.role, content: m.content.slice(0, 800) }));

  if (window.length === 0) return fallback();

  const servicosInfo = bookedServiceNames && bookedServiceNames.length > 0
    ? `Serviço(s) REALMENTE reservado(s) com sucesso nesta rodada (nome exato do catálogo do negócio): ${JSON.stringify(bookedServiceNames)}. Se um desses nomes já é um combo que cobre tudo que o cliente pediu numa mesma fala (ex: cliente disse "corte e barba" e o serviço reservado se chama "Corte e Barba" ou similar), conte esse serviço como 1 agendamento — não infle o número só porque o cliente usou "e"/"mais" na frase. O catálogo do negócio, não a frase do cliente, decide se é 1 serviço ou 2.`
    : "";
  const execInfo = typeof bookedExecutionCount === "number" && bookedExecutionCount > 0
    ? `Chamadas de "agendar/criar_agendamento" que tiveram sucesso NESTA rodada: ${bookedExecutionCount}. Uma única execução bem-sucedida representa 1 visita/comanda mesmo que contenha vários serviços no mesmo array (ex: {servicos:[corte, barba]} para o MESMO cliente/profissional/horário sequencial = 1 agendamento, não 2). Só considere prometidos > número de execuções bem-sucedidas se a fala do cliente exigir múltiplas execuções separadas (2+ pessoas distintas, 2+ horários distintos, ou 2+ profissionais distintos). Diferença de NOMES de serviço dentro da mesma execução NÃO justifica inflar o total.`
    : "";
  const priorInfo = priorTurnBookings && priorTurnBookings.length > 0
    ? `Agendamentos JÁ concluídos em RODADAS ANTERIORES desta conversa (não conte de novo, mesmo que apareçam citados na janela): ${JSON.stringify(priorTurnBookings)}. Só conte pedidos NOVOS feitos pelo cliente nesta rodada atual.`
    : "";

  const sys = [
    "Você é um classificador de intenção.",
    "Dada a janela de conversa a seguir entre CLIENTE e ATENDENTE, conte quantos AGENDAMENTOS DISTINTOS o cliente pediu/confirmou nesta rodada.",
    "Regras:",
    "- Cada horário distinto = 1 agendamento. Cada serviço adicional na MESMA hora = +1 agendamento (ex: corte+barba+sobrancelha = 3), EXCETO quando o catálogo do negócio já vende essa combinação como um serviço único OU quando o negócio permite vários serviços na MESMA visita/comanda (mesmo cliente, mesmo profissional, horários sequenciais) — nesses casos conta como 1.",
    "- Cada pessoa distinta = +1 (ex: '2 cortes pra amanhã' = 2).",
    "- Se o atendente ofereceu opções e o cliente respondeu apenas 'sim'/'pode'/'beleza'/'fechado', considere que ele aceitou TODAS as opções ofertadas na última fala do atendente.",
    "- Se não há intenção clara de agendar, retorne 1.",
    "- Nunca retorne 0.",
    ...(servicosInfo ? [servicosInfo.trim()] : []),
    ...(execInfo ? [execInfo.trim()] : []),
    ...(priorInfo ? [priorInfo.trim()] : []),
    "- IMPORTANTE PARA FRIZZAR: vários serviços para a MESMA pessoa, na MESMA visita, formam 1 agendamento/comanda. Corte + barba não são 2 agendamentos. Duas pessoas, ainda que no mesmo horário, são 2 agendamentos.",
    '- Preencha também as dimensões da intenção: pessoas distintas, horários distintos e profissionais distintos. Se a conversa diz "dois cortes", "para mim e outra pessoa", "nós dois" ou equivalente, distinct_people deve ser 2 mesmo quando a última resposta do cliente for apenas "sim".',
    'Responda APENAS em JSON: {"total_bookings_requested": <numero>, "distinct_people": <numero>, "distinct_times": <numero>, "distinct_professionals": <numero>, "same_visit_services_only": <boolean>, "reasoning": "<curto>"}',
  ].join("\n");

  const isGpt5 = modelUsed.includes("gpt-5");
  const body = JSON.stringify({
    model: modelUsed,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: JSON.stringify(window) },
    ],
    // gpt-5 conta tokens de reasoning dentro de max_completion_tokens; 200 zerava
    // o content e caía no fallback. Damos folga generosa (é JSON curto de saída).
    max_completion_tokens: isGpt5 ? 1500 : 300,
    response_format: { type: "json_object" },
    ...(isGpt5 ? { reasoning_effort: "minimal" } : {}),
  });

  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(aiEndpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${aiAuthKey}`, "Content-Type": "application/json" },
      body,
      signal: ctrl.signal,
    });
    clearTimeout(to);
    if (!resp.ok) {
      console.warn(`[MultiBookingGuard] classifier HTTP ${resp.status}`);
      return fallback();
    }
    const j = await resp.json();
    const raw = j?.choices?.[0]?.message?.content;
    if (typeof raw !== "string" || !raw.trim()) {
      console.warn(`[MultiBookingGuard] classifier empty content (finish=${j?.choices?.[0]?.finish_reason})`);
      return fallback();
    }
    const parsed = JSON.parse(raw);
    let n = Number(parsed?.total_bookings_requested);
    if (!Number.isFinite(n) || n < 1) return fallback();
    const dimension = (value: unknown): number => {
      const parsedValue = Number(value);
      return Number.isFinite(parsedValue) && parsedValue >= 1
        ? Math.min(Math.floor(parsedValue), 10)
        : 1;
    };
    const intentShape = {
      distinctPeople: dimension(parsed?.distinct_people),
      distinctTimes: dimension(parsed?.distinct_times),
      distinctProfessionals: dimension(parsed?.distinct_professionals),
      sameVisitServicesOnly: parsed?.same_visit_services_only === true,
    };

    // 🚨 FIX — o classificador às vezes erra a própria conta: o texto de
    // `reasoning` soma corretamente (ex: "corte (1) + avô (1) = total 2
    // agendamentos"), mas o campo `total_bookings_requested` sai divergente
    // (ex: 1). Caso real: reasoning dizia "total 2 agendamentos" mas o campo
    // veio 1 — o guard liberou achando 1/1 completo, e o segundo pedido
    // (avô) nunca foi processado. Reconcilia: se o texto do reasoning
    // menciona um número maior, usa o maior dos dois (nunca o menor —
    // mesma lógica defensiva já usada no resto do guard).
    const reasoningText = String(parsed?.reasoning || "");
    const reasoningN = extractBookingCountFromReasoning(reasoningText);
    if (reasoningN != null) {
      if (Number.isFinite(reasoningN) && reasoningN > n) {
        console.warn(`[MultiBookingGuard] classifier inconsistente: total_bookings_requested=${n} mas reasoning menciona ${reasoningN}. Usando o maior.`);
        n = reasoningN;
      }
    }

    let capped = Math.min(Math.floor(n), 10); // sanity cap
    // Se o LLM disse 1 mas a heurística viu 2+ horários ofertados + resposta curta,
    // acredita na heurística. Rede de segurança contra o mesmo bug que já mordeu.
    const heuristic = heuristicPromisedFromWindow(messages, attempts);
    const lastUserText = [...window].reverse().find((m: any) => m.role === "user")?.content || "";
    // Proteção anti-falso-positivo: com uma única chamada de agendamento no turno,
    // se a mensagem do cliente NÃO é confirmação curta e a heurística não viu
    // nenhuma evidência determinística de múltiplas reservas (horários explícitos
    // ou múltiplos "com Profissional"), não deixa o classificador inflar para 4, 7 etc.
    // Caso real: cliente disse "Hoje, 15:20" e o LLM contou 7 horários da lista anterior.
    // Pula o clamp quando o reasoning do próprio LLM enumerou explicitamente
    // ≥2 (extrator determinístico já validou — ex: "corte + sobrancelha +
    // epilação = 3 agendamentos"). O clamp é pra defender contra LLM que
    // conta horários de uma lista anterior; não contra enumeração explícita.
    const reasoningBackedMulti = reasoningN != null && reasoningN >= 2;
    if (
      attempts === 1 &&
      heuristic <= 1 &&
      !isAffirmativeReply(lastUserText) &&
      capped > 1 &&
      !reasoningBackedMulti
    ) {
      console.warn(`[MultiBookingGuard] classifier clamped ${capped}→1 for single-attempt non-affirmative turn.`);
      capped = 1;
    }
    const heuristicOverrideAllowed = heuristic > capped && hasHighConfidenceHeuristicOverride(messages);
    const total = heuristicOverrideAllowed ? heuristic : capped;
    if (heuristic > capped && !heuristicOverrideAllowed) {
      console.warn(`[MultiBookingGuard] heuristic ignored: llm=${capped} heur=${heuristic} sem sinal determinístico de multi-agendamento.`);
    }
    return {
      total,
      source: "llm",
      reasoning: `${String(parsed?.reasoning || "").slice(0, 160)} | llm=${capped} heur=${heuristic}${heuristic > capped ? ` heur_${heuristicOverrideAllowed ? "used" : "ignored"}` : ""}`,
      intentShape,
    };
  } catch (e) {
    console.warn(`[MultiBookingGuard] classifier failed:`, (e as Error)?.message);
    return fallback();
  }
}


/** Mensagem determinística quando a recuperação automática esgotou as tentativas.
 * NUNCA promete continuar tentando em background: deixa claro que a equipe será acionada. */
function buildPartialBookingFallback(
  criados: number,
  prometidos: number,
  breakdown: Array<{ tool: string; summary: string }>,
): string {
  const feitos = breakdown.length > 0
    ? breakdown.map((b) => b.summary).filter((s) => !!s).join("; ")
    : "";
  const faltam = Math.max(0, prometidos - criados);
  const partes: string[] = [];
  if (criados > 0 && feitos) {
    partes.push(`Consegui agendar: ${feitos}.`);
  } else if (criados > 0) {
    partes.push(`Consegui registrar ${criados} agendamento${criados > 1 ? "s" : ""}.`);
  }
  if (faltam > 0) {
    const alvo = criados > 0
      ? (faltam > 1 ? `os outros ${faltam} serviços` : "o segundo serviço")
      : (faltam > 1 ? `os ${faltam} agendamentos` : "o agendamento");
    partes.push(`Porém, tive um probleminha ao tentar finalizar ${alvo}.`);
    partes.push("Vou acionar a equipe aqui pra concluir isso pra você o mais rápido possível.");
  } else {
    partes.push("Vou acionar a equipe aqui pra concluir o restante o mais rápido possível.");
  }
  return partes.join(" ");
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

  // Funis do CRM externo (tenant_crm_funnels) — necessários para gerar as
  // ferramentas crm_mover_para_* e a seção do prompt. Carregado aqui porque
  // este é o único ponto comum a TODOS os canais (WhatsApp, chat do site e
  // simulador); antes só o simulador anexava, então no WhatsApp real a IA
  // ficava sem nenhuma ferramenta de CRM.
  if (tenant?.crm_zetta_token && !Array.isArray((tenant as any).crm_funnels)) {
    try {
      const { data: crmFunnels } = await supabase
        .from("tenant_crm_funnels")
        .select("funnel_id, funnel_name, stages")
        .eq("tenant_id", tenant.id);
      (tenant as any).crm_funnels = crmFunnels ?? [];
      console.log(`[CRM] Funis carregados para ${tenant.id}: ${((crmFunnels ?? []) as any[]).length}`);
    } catch (e: any) {
      console.warn("[CRM] falha ao carregar funis:", e?.message || e);
      (tenant as any).crm_funnels = [];
    }
  }

  const logToolCalls: AgentResult["toolCalls"] = [];
  const logErrors: LogEntry[] = [];
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

    // 🚨 Mesma trava estrutural aplicada aqui — este é o segundo caminho (o
    // extrator automático via maybeAutoPersistClientSummary) que escreve na
    // mesma coluna que a tool atualizar_resumo_cliente. O prompt do extrator
    // abaixo chega a SUGERIR guardar "agendou corte com X em DATA" — por isso
    // não dá pra confiar só na tool explícita, precisa bloquear aqui também.
    const violated = findForbiddenSummaryContent(cleaned);
    if (violated) {
      console.warn(`[SummaryAuto] BLOQUEADO (persistClientSummary) — contém ${violated.label}: "${cleaned.slice(0, 100)}"`);
      return false;
    }

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

    // Espelha no CRM externo — mesmo comportamento da tool explícita
    // atualizar_resumo_cliente, para que TODO update de resumo (automático
    // ou pedido pela IA) chegue no CRM. Best-effort: nunca falha a resposta.
    if (tenant?.crm_zetta_token) {
      try {
        const crmRes = await fetch("https://crm.zayloia.com/api/public/ai/update-summary", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${tenant.crm_zetta_token}` },
          body: JSON.stringify({ phone: phoneNumber, summary: cleaned }),
        });
        if (!crmRes.ok) console.warn(`[SummaryAuto] sync com CRM falhou (${crmRes.status})`);
      } catch (e) {
        console.warn("[SummaryAuto] erro de rede sincronizando com CRM:", e instanceof Error ? e.message : e);
      }
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
              "REGRA PRINCIPAL: o resumo é ESTRITAMENTE um PERFIL DURÁVEL do cliente. Contém APENAS:\n" +
              "- Nome do cliente\n" +
              "- Serviço(s) que costuma pedir (ex: 'costuma fazer corte e barba') — nunca associado a data/hora\n" +
              "- Profissional preferido (só o nome, sem dia/hora)\n" +
              "- Janela de horário TÍPICA e GENÉRICA (ex: 'prefere manhãs', 'costuma vir aos sábados') — nunca dia/hora específicos\n" +
              "- Plano, clube, assinatura, pacote\n" +
              "- Restrição, alergia, observação útil (ex: 'alérgico a X', 'cabelo cacheado')\n\n" +
              "🚫 PROIBIDO no summary (nunca inclua, mesmo que apareça no histórico):\n" +
              "- Agendamentos específicos (passados, presentes ou futuros)\n" +
              "- Datas de qualquer formato (dd/mm, yyyy-MM-dd, 'hoje', 'amanhã', 'ontem', 'sexta que vem')\n" +
              "- Horários específicos (15h, 15:00, 15h30, 'às 10')\n" +
              "- Qualquer verbo de ação de agendamento: agendou, marcou, confirmou, reservou, cancelou, desmarcou, remarcou\n" +
              "- A palavra 'agendamento' em si\n" +
              "- Status de confirmação de qualquer atendimento concreto\n\n" +
              "Motivo: esses dados mudam a cada atendimento e pertencem ao sistema de agendamento, não ao perfil. Incluí-los aqui já causou bug real (resumo antigo sendo reafirmado como se fosse confirmação de um pedido novo) e confunde a IA.\n\n" +
              "Se a única coisa relevante da interação for algo com data/hora ou agendamento (ex: 'agendou corte pra amanhã às 15h com Vinícius'), extraia SÓ a parte durável (ex: 'gosta de corte, prefere o Vinícius') e descarte a parte temporal/transacional. Se não sobrar nada durável, responda should_update=false.\n\n" +
              "Só responda should_update=false quando a mensagem for puramente social (oi/tchau/ok/obrigado) E não existir currentSummary.\n\n" +
              "REGRA DE MERGE: receba currentSummary e devolva uma versão ATUALIZADA que PRESERVE o que já era verdade e adicione/refine o novo. Não apague info anterior de perfil. Se o currentSummary recebido contiver conteúdo proibido (datas, horários, palavras 'agendou/marcou/confirmou/agendamento'), REMOVA essa parte ao reescrever — o resumo devolvido deve estar 100% limpo dessas menções. Consolide; máximo 600 caracteres, PT-BR, factual, sem floreio, sem citar 'cliente disse'.",
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
      logErrors.push({ message: `AI gateway error (final fallback): ${finalResponse.status} ${errText.slice(0, 200)}`, level: "error" });
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
      // Auto-diretivas do modelo em PT que escaparam do scratchpad (ex: "Não enviar nada.",
      // "Não responder", "Sem resposta", "Não é necessário responder"). O modelo escreve
      // isso pra si mesmo quando decide ficar em silêncio (ex: após tool escalate_human
      // já ter enviado a mensagem ao cliente). NUNCA pode virar mensagem pro cliente.
      /^\s*n[aã]o\s+(enviar|enviar\s+nada|responder|responda|mandar|mandar\s+nada|escrever|escrever\s+nada)\b[\s.!]*$/i,
      /^\s*(sem\s+resposta|sem\s+mensagem|nenhuma\s+resposta|nada\s+a\s+(enviar|responder|dizer))\s*[.!]*$/i,
      /^\s*n[aã]o\s+[eé]\s+necess[aá]rio\s+(responder|enviar|mandar)/i,
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
    ...history
      // Histórico persistido nunca deve reentrar como role:"tool": tool messages
      // só são válidas imediatamente após o assistant.tool_calls da MESMA request.
      // Se uma delas entra em nova chamada isolada, o gateway retorna 400
      // "messages with role 'tool' must be a response to a preceding message".
      .filter((m: any) => m?.role === "user" || m?.role === "assistant")
      .map((m: any) => ({
        role: m.role,
        content: typeof m.content === "string" ? `${tsPrefix(m.created_at)}${m.content}` : m.content,
      })),
  ];

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
    logErrors.push({ message: `AI gateway error (initial): ${response.status} ${errText.slice(0, 200)}`, level: "error" });
    // 🚨 Política global: NUNCA expor erro técnico ao cliente. Escala humano de imediato.
    console.warn(`[AIGatewayFallback] Falha no gateway para ${phoneNumber}, escalando humano sem expor erro.`);
    logErrors.push({ message: `AI gateway: falha → escalar humano (sem expor erro ao cliente)`, level: "error" });
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
  // Assinaturas (nome + argumentos) executadas NESTE turno — usado para impedir
  // que a IA dispare a mesma ferramenta idêntica duas vezes na mesma resposta,
  // sem travar a ferramenta para o resto da conversa.
  const executedToolSignaturesThisTurn: Set<string> = new Set<string>();


  while (assistantMessage?.tool_calls && rounds < maxRounds) {

    rounds++;
    messages.push(assistantMessage);
    // OpenAI exige que, após uma mensagem assistant com tool_calls, venham
    // somente respostas role:"tool" para TODOS os tool_call_ids antes de
    // qualquer system/user/assistant. Nudges do guard ficam pendentes até o fim
    // do for, evitando o 400 "messages with role 'tool' must be a response...".
    const postToolSystemMessages: Array<{ role: "system"; content: string }> = [];

    for (const toolCall of assistantMessage.tool_calls) {
      // Marcadores para a linha do tempo do Monitor IA: em qual rodada a ferramenta
      // rodou e qual faixa do http_trace pertence a ela (logs "por dentro" da tool).
      const __traceStartSeq = getHttpTrace().length + 1;
      const __toolStartedAt = new Date().toISOString();
      const __toolStartedMs = Date.now();
      let parsedArgs = parseToolArguments(toolCall.function.arguments);
      const originalParsedArgs = JSON.parse(JSON.stringify(parsedArgs || {}));
      let toolCallToExecute = toolCall;
      let correctionReason: string | null = null;

      // AppBarber trabalha com telefone local (DDD + número), sem o DDI 55.
      // Normalize ANTES dos guards, da execução e do agent_logs para que o prefixo
      // não apareça nem mesmo nos argumentos registrados da ferramenta.
      if (provider === "appbarber") {
        let changed = false;
        if (parsedArgs?.customer_phone) {
          const original = String(parsedArgs.customer_phone);
          const digits = original.replace(/\D/g, "");
          const withoutCountryCode = (digits.startsWith("55") && (digits.length === 12 || digits.length === 13))
            ? digits.slice(2)
            : digits;
          const normalized = withoutCountryCode.length === 10
            ? `${withoutCountryCode.slice(0, 2)}9${withoutCountryCode.slice(2)}`
            : withoutCountryCode;
          if (normalized !== original) {
            parsedArgs.customer_phone = normalized;
            changed = true;
          }
        }
        if (typeof parsedArgs?.scheduling_observation === "string") {
          const original = parsedArgs.scheduling_observation;
          const normalized = original
            .replace(/\b55(\d{2})(\d{8})\b/g, (_match: string, ddd: string, number: string) => `${ddd}9${number}`)
            .replace(/\b55(\d{11})\b/g, "$1")
            .replace(/\b(\d{2})(\d{8})\b/g, (_match: string, ddd: string, number: string) => `${ddd}9${number}`);
          if (normalized !== original) {
            parsedArgs.scheduling_observation = normalized;
            changed = true;
          }
        }
        if (changed) {
          correctionReason = "Argumentos AppBarber normalizados (DDD + 9 + número, sem DDI 55)";
          toolCallToExecute = { ...toolCall, function: { ...toolCall.function, arguments: JSON.stringify(parsedArgs) } };
        }
      }

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
              status: "SUCESSO_ANTERIOR_JA_REGISTRADO",
              alreadyDone: true,
              blocked: true,
              priorAction: { at: prior.completedAt, summary: prior.summary, resultId: prior.resultId ?? null, minutesAgo: ageMin },
              instruction_pt: `Esta ação JÁ FOI CONCLUÍDA COM SUCESSO nesta conversa há ${ageMin} minuto(s): ${prior.summary}. Isto NÃO é um erro — a operação está feita. AÇÃO OBRIGATÓRIA: responda ao cliente confirmando que já está tudo certo (ex: "Perfeito! Seu agendamento já está confirmado para <data/hora>. Te esperamos!"). PROIBIDO: (1) chamar novamente qualquer ferramenta de agendamento/cancelamento/edição para esta mesma ação; (2) escalar para atendente humano; (3) dizer ao cliente que vai chamar a equipe, verificar com o responsável ou pedir para aguardar. Só repita a ação se o cliente PEDIR EXPLICITAMENTE algo DIFERENTE (outro horário, outro serviço, outra pessoa).`,
            };
            wasBlocked = true;
            sessionBlocked = true;
            messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(toolResult) });
            logToolCalls.push({ name: toolCall.function.name, args: parsedArgs, result: toolResult, blocked: true, deduplicated: true, round: rounds, started_at: __toolStartedAt, duration_ms: Date.now() - __toolStartedMs, trace_from: __traceStartSeq, trace_to: getHttpTrace().length } as any);
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
        const isReadOnlyTool = /^(buscar_|listar_|consultar_|verificar_|get_|list_|obter_)/i.test(toolKey) || toolKey === "cadastrar_cliente" || toolKey === "atualizar_resumo_cliente" || toolKey === "calcular";
      // Scheduling and cancel/edit tools may legitimately repeat (different services or
      // multiple appointments). They have their own per-service / per-id dedup logic below.
      const isSchedulingOrCancelTool = [
        "criar_agendamento", "agendar", "editar_agendamento",
        "cancelar_agendamento", "desmarcar_agendamento", "confirmar_agendamento",
      ].includes(toolKey);
      // Check if this is a custom tool of type "add_label" (always allow repeats)
      const matchedCustomTool = getEnabledCustomTools(tenant).find((ct: any) => ct.name === toolKey);
      const isAddLabelTool = matchedCustomTool?.type === "add_label";
      // escalate_human pode repetir: a IA pode precisar escalar de novo em outro
      // momento da conversa (ex.: nova falha ou novo pedido de atendimento humano).
      const isEscalateHumanTool = matchedCustomTool?.type === "escalate_human";
      // Ferramentas customizadas são informativas/reversíveis (enviar texto, imagem,
      // áudio, vídeo, documento, localização, link, combo, PIX, contato, etiquetas).
      // O cliente pode legitimamente pedir o mesmo conteúdo de novo mais tarde, então
      // elas NÃO ficam travadas para a conversa inteira — apenas não podem repetir
      // com argumentos idênticos dentro do MESMO turno (evita envio duplicado).
      const isRepeatableCustomTool = !!matchedCustomTool;
      const turnSignature = `${toolKey}::${JSON.stringify(parsedArgs ?? {})}`;
      if (isRepeatableCustomTool && executedToolSignaturesThisTurn.has(turnSignature)) {
        console.log(`[DedupGuard] ${toolKey} BLOCKED: mesma chamada repetida neste turno`);
        toolResult = {
          message: `A ferramenta "${toolKey}" já foi executada agora, com os mesmos dados, nesta mesma resposta. Não repita — siga respondendo ao cliente.`,
          blocked: true,
          deduplicated: true,
        };
        wasBlocked = true;
        messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(toolResult) });
        logToolCalls.push({ name: toolCall.function.name, args: parsedArgs, result: toolResult, blocked: true, deduplicated: true, round: rounds, started_at: __toolStartedAt, duration_ms: Date.now() - __toolStartedMs, trace_from: __traceStartSeq, trace_to: getHttpTrace().length } as any);
        continue;
      }
      if (isRepeatableCustomTool) executedToolSignaturesThisTurn.add(turnSignature);

      if (executedToolsThisSession.has(toolKey) && !isReadOnlyTool && !isAddLabelTool && !isEscalateHumanTool && !isRepeatableCustomTool && !isSchedulingOrCancelTool) {


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
                matchedCustomTool?.config?.label_name || matchedCustomTool?.display_name || matchedCustomTool?.name,
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
        logToolCalls.push({ name: toolCall.function.name, args: parsedArgs, result: toolResult, blocked: true, deduplicated: true, round: rounds, started_at: __toolStartedAt, duration_ms: Date.now() - __toolStartedMs, trace_from: __traceStartSeq, trace_to: getHttpTrace().length } as any);
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
          parsedArgs?.service_code,
          parsedArgs?.serviceCode,
        ];
        if (Array.isArray(parsedArgs?.servicos)) {
          for (const s of parsedArgs.servicos) {
            candidateIds.push(s?.codigo, s?.servicoId, s?.servicosId);
          }
        }
        if (Array.isArray(parsedArgs?.services)) {
          for (const s of parsedArgs.services) {
            candidateIds.push(s?.service_code, s?.serviceCode, s?.code, s?.id);
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
          (typeof parsedArgs?.start_time === "string" && parsedArgs.start_time) ||
          (dt && dt.length >= 16 ? dt.slice(11, 16) : "");
        const prof =
          toPositiveInteger(parsedArgs?.profissionalId) ??
          toPositiveInteger(parsedArgs?.professionalId) ??
          toPositiveInteger(parsedArgs?.professional_code) ??
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

          const lastFrizzarListedForProfessional = frizzarGetLastListed(sessionState, parsedArgs?.profissionalId);
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

      let exactSlotAlreadyBooked =
        isSchedulingTool &&
        attemptedSlotSignature !== "" &&
        attemptedServiceIds.length > 0 &&
        sessionState.scheduledSlotSignatures.includes(attemptedSlotSignature);

      // ===== DB-LEVEL DUPLICATE BOOKING GUARD (race-condition safe) =====
      // O snapshot de sessionState pode estar desatualizado quando duas mensagens
      // do mesmo cliente entram em janelas de debounce paralelas. Consultamos
      // agent_logs em tempo real por qualquer booking bem-sucedido nos últimos
      // 20 min com a MESMA assinatura de slot (serviços+data+hora+profissional)
      // ou, se a assinatura estiver vazia (provedor sem args normalizáveis),
      // por qualquer booking bem-sucedido no mesmo minuto — barra tentativa duplicada.
      if (isSchedulingTool && !exactSlotAlreadyBooked && phoneNumber) {
        try {
          const sinceIso = new Date(Date.now() - 20 * 60 * 1000).toISOString();
          const { data: recentLogs } = await supabase
            .from("agent_logs")
            .select("tool_calls, created_at")
            .eq("tenant_id", tenant.id)
            .eq("phone_number", phoneNumber)
            .gte("created_at", sinceIso)
            .order("created_at", { ascending: false })
            .limit(6);

          const bookingNamesSet = new Set(["criar_agendamento", "agendar"]);
          const computeSig = (args: any): { sig: string; svc: number[] } => {
            const ids: number[] = [];
            for (const v of [args?.serviceId, args?.servicoId, args?.servicoid, args?.servicosId]) {
              const n = toPositiveInteger(v);
              if (typeof n === "number") ids.push(n);
            }
            if (Array.isArray(args?.servicos)) {
              for (const s of args.servicos) {
                for (const v of [s?.codigo, s?.servicoId, s?.servicosId]) {
                  const n = toPositiveInteger(v);
                  if (typeof n === "number") ids.push(n);
                }
              }
            }
            const dt: string =
              (typeof args?.dataHoraInicio === "string" && args.dataHoraInicio) ||
              (typeof args?.start === "string" && args.start) || "";
            const date =
              (typeof args?.dia === "string" && args.dia) ||
              (typeof args?.data === "string" && args.data) ||
              (typeof args?.date === "string" && args.date) ||
              (dt ? dt.slice(0, 10) : "");
            const time =
              (typeof args?.hora === "string" && args.hora) ||
              (typeof args?.horario === "string" && args.horario) ||
              (typeof args?.time === "string" && args.time) ||
              (dt && dt.length >= 16 ? dt.slice(11, 16) : "");
            const prof =
              toPositiveInteger(args?.profissionalId) ??
              toPositiveInteger(args?.professionalId) ?? "";
            return { sig: `${[...ids].sort((a, b) => a - b).join(",")}|${date}|${time}|${prof}`, svc: ids };
          };

          for (const row of (recentLogs || [])) {
            const calls = Array.isArray(row?.tool_calls) ? row.tool_calls : [];
            for (const tc of calls) {
              if (!tc || !bookingNamesSet.has(tc?.name)) continue;
              if (tc?.blocked) continue;
              const r = tc?.result;
              const succeeded = r && typeof r === "object" && !r.error && !r.blocked &&
                (r.id || r.ok || r.agendamentoId || r.success || r.appointmentId);
              if (!succeeded) continue;
              const priorSig = computeSig(tc?.args || {});
              if (priorSig.sig && priorSig.svc.length > 0 && priorSig.sig === attemptedSlotSignature) {
                exactSlotAlreadyBooked = true;
                console.log(`[DupBookingGuard] DB match — prior successful booking at ${row.created_at} sig=${priorSig.sig}`);
                break;
              }
            }
            if (exactSlotAlreadyBooked) break;
          }
        } catch (e) {
          console.error("[DupBookingGuard] lookup error:", e);
        }
      }

      if (isSchedulingTool && exactSlotAlreadyBooked) {
        console.log(`${toolCall.function.name} BLOCKED: exact slot already booked (${attemptedSlotSignature})`);
        toolResult = {
          message: "Esse agendamento exato (mesmos serviços, data, hora e profissional) JÁ FOI CRIADO nesta conversa há poucos minutos. NÃO tente agendar de novo. Apenas responda ao cliente confirmando que o agendamento já está registrado — sem chamar mais ferramentas de agendamento.",
          blocked: true,
          alreadyBooked: true,
        };
        wasBlocked = true;
        // Duplicidade exata não é falha nem motivo de pausa: a ação já foi concluída.
        // garante persistência da assinatura no state para próximas mensagens
        if (attemptedSlotSignature && !sessionState.scheduledSlotSignatures.includes(attemptedSlotSignature)) {
          sessionState.scheduledSlotSignatures.push(attemptedSlotSignature);
        }
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
              // Auto-correct: if start matches a known slot, use that slot's end (avoid blocking on calculated end times)
              const startMatch = matchingSlots.find((slot) => slot.start === requestedStart);
              if (startMatch) {
                parsedArgs.end = startMatch.end;
                if (startMatch.professionalId && !requestedProfessionalId) {
                  parsedArgs.professionalId = startMatch.professionalId;
                }
                if (startMatch.serviceId && !requestedServiceId) {
                  parsedArgs.serviceId = startMatch.serviceId;
                }
                if (startMatch.salonId && !requestedSalonId) {
                  parsedArgs.salonId = startMatch.salonId;
                }
                corrections.push(`end auto-corrigido de ${requestedEnd} para ${startMatch.end} (slot Bemp oficial)`);
                console.log(`[BempResolver] agendar auto-corrected end: ${requestedEnd} -> ${startMatch.end}`);
              } else {
                toolResult = {
                  error: "O horário informado não bate com os slots válidos retornados pela Bemp.",
                  blocked: true,
                  message: "Use exatamente um start/end retornado por listar_horarios_geral ou listar_horarios.",
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
          const resolvableTools = ["buscar_barbeiros_por_servico", "buscar_horarios", "buscar_horarios_disponiveis", "agendar"];
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
            }, phoneNumber, { supabase, simulatorMode, sessionState });
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
          toolResult = await executeToolForProvider(provider, tenant, toolCallToExecute, phoneNumber, { supabase, simulatorMode, sessionState });
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
            const httpStatus = typeof r.status === "number" ? r.status : null;
            const succeeded = !r.error && !r.blocked && r.success !== false
              && !(Array.isArray(r.Errors) && r.Errors.length > 0)
              && !(httpStatus !== null && httpStatus >= 400);
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

        if (provider === "bemp" && toolCall.function.name === "listar_horarios_geral" && toolResult && Array.isArray((toolResult as any).horariosConsolidados)) {
          const salonId = toPositiveInteger(parsedArgs?.salonId);
          const serviceId = toPositiveInteger(parsedArgs?.serviceId);
          const date = typeof parsedArgs?.data === "string" ? parsedArgs.data : null;
          const newSlots: any[] = [];
          const newProfs: any[] = [];
          for (const entry of (toolResult as any).horariosConsolidados as any[]) {
            for (const prof of (entry.professionals || [])) {
              newSlots.push({
                salonId: salonId ?? null,
                serviceId: serviceId ?? null,
                professionalId: Number(prof.professionalId),
                date,
                start: String(entry.start || ""),
                end: String(entry.end || ""),
                start_text: entry.start_text,
                end_text: entry.end_text,
              });
            }
          }
          for (const p of ((toolResult as any).profissionais || [])) {
            const id = Number(p.professionalId);
            if (id > 0) newProfs.push({ salonId: salonId ?? null, serviceId: serviceId ?? null, professionalId: id, name: String(p.name || "") });
          }
          sessionState.bempSlotOptions = dedupeByKey(
            [...sessionState.bempSlotOptions, ...newSlots.filter((s) => s.start && s.end)],
            (slot) => `${slot.salonId ?? "any"}:${slot.serviceId ?? "any"}:${slot.professionalId ?? "any"}:${slot.start}:${slot.end}`,
          );
          sessionState.bempProfessionalOptions = dedupeByKey(
            [...sessionState.bempProfessionalOptions, ...newProfs],
            (p) => `${p.salonId ?? "any"}:${p.serviceId ?? "any"}:${p.professionalId}`,
          );
          if (salonId) sessionState.selectedSalonId = salonId;
          if (serviceId) sessionState.selectedServiceId = serviceId;
          if (date) sessionState.selectedDate = date;
          console.log(`Tracked Bemp horarios_geral: slots=${sessionState.bempSlotOptions.length} profs=${sessionState.bempProfessionalOptions.length}`);
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

        // ===== FRIZZAR: catálogo de serviços (bloqueia servicoId alucinado em agendar) =====
        if (provider === "frizzar" && toolCall.function.name === "listar_servicos" && Array.isArray(toolResult)) {
          const catalog = toolResult
            .map((s: any) => ({
              codigo: toPositiveInteger(s?.codigo) ?? null,
              nome: typeof s?.nome === "string" ? s.nome : "",
            }))
            .filter((s: any) => s.codigo);
          (sessionState as any).frizzarServiceCatalog = catalog;
          console.log(`[FrizzarLock] catalog tracked: ${catalog.length} serviços`);
        }

        // ===== BEMP: catálogo de serviços (bloqueia serviceId alucinado em agendar) =====
        if (provider === "bemp" && toolCall.function.name === "listar_servicos" && Array.isArray(toolResult)) {
          const catalog = toolResult
            .map((s: any) => ({ id: toPositiveInteger(s?.id) ?? null, name: typeof s?.name === "string" ? s.name : "" }))
            .filter((s: any) => s.id);
          (sessionState as any).bempServiceCatalog = catalog;
          console.log(`[BempLock] catalog tracked: ${catalog.length} serviços`);
        }

        // ===== APPBARBER: catálogo de serviços (bloqueia service_code alucinado em criar_agendamento) =====
        if (provider === "appbarber" && toolCall.function.name === "listar_servicos" && toolResult && Array.isArray((toolResult as any)?.services)) {
          const catalog = (toolResult as any).services
            .map((s: any) => ({
              service_code: toPositiveInteger(s?.service_code) ?? null,
              name: typeof s?.name === "string" ? s.name : "",
              duration_minutes: toPositiveInteger(s?.duration_minutes) ?? null,
            }))
            .filter((s: any) => s.service_code);
          (sessionState as any).appbarberServiceCatalog = catalog;
          console.log(`[AppBarberLock] catalog tracked: ${catalog.length} serviços`);
        }

        // ===== APPBARBER: slots consultados por serviço/profissional/data =====
        // Guardamos as consultas reais para validar que criar_agendamento use um
        // horário/profissional efetivamente listado. Importante: AppBarber NÃO deve
        // receber múltiplos `services[]` soltos; multi-serviço só via combo cadastrado.
        if (provider === "appbarber" && toolResult && !(toolResult as any)?.error && ["listar_horarios", "listar_horarios_geral"].includes(toolCall.function.name)) {
          const catalog = (((sessionState as any).appbarberServiceCatalog || []) as Array<{ service_code: number; name: string; duration_minutes: number | null }>);
          const serviceCode = toPositiveInteger(parsedArgs?.service_code ?? (toolResult as any)?.service_code);
          const service = catalog.find((s) => s.service_code === serviceCode);
          const serviceName = service?.name || `Serviço ${serviceCode || ""}`.trim();
          const duration = service?.duration_minutes ?? null;
          const startDate = String(parsedArgs?.start_date || (toolResult as any)?.date || "").slice(0, 10);
          const slotOptions: NonNullable<AgentSessionState["appbarberSlotOptions"]> = [];

          if (serviceCode && startDate && toolCall.function.name === "listar_horarios" && Array.isArray((toolResult as any)?.available_times)) {
            const professionalCode = toPositiveInteger(parsedArgs?.professional_code ?? (toolResult as any)?.professional_code);
            if (professionalCode) {
              for (const time of (toolResult as any).available_times) {
                const hhmm = String(time || "").slice(0, 5);
                if (/^\d{2}:\d{2}$/.test(hhmm)) {
                  slotOptions.push({ service_code: serviceCode, service_name: serviceName, duration_minutes: duration, professional_code: professionalCode, professional_name: "", start_date: startDate, start_time: hhmm });
                }
              }
            }
          }

          if (serviceCode && startDate && toolCall.function.name === "listar_horarios_geral" && Array.isArray((toolResult as any)?.profissionais)) {
            for (const prof of (toolResult as any).profissionais) {
              const professionalCode = toPositiveInteger(prof?.professional_code);
              if (!professionalCode || !Array.isArray(prof?.available_times)) continue;
              for (const time of prof.available_times) {
                const hhmm = String(time || "").slice(0, 5);
                if (/^\d{2}:\d{2}$/.test(hhmm)) {
                  slotOptions.push({ service_code: serviceCode, service_name: serviceName, duration_minutes: duration, professional_code: professionalCode, professional_name: String(prof?.name || ""), start_date: startDate, start_time: hhmm });
                }
              }
            }
          }

          if (slotOptions.length > 0) {
            (sessionState as any).appbarberSlotOptions = dedupeByKey(
              [...(((sessionState as any).appbarberSlotOptions || []) as NonNullable<AgentSessionState["appbarberSlotOptions"]>), ...slotOptions].slice(-500),
              (slot) => `${slot.service_code}:${slot.professional_code}:${slot.start_date}:${slot.start_time}`,
            );
            console.log(`[AppBarber] tracked slot options: +${slotOptions.length} total=${((sessionState as any).appbarberSlotOptions || []).length}`);
          }
        }

        // ===== FRIZZAR: rastreia agendasIds do cliente após buscar_agendamentos (para checagem de propriedade em cancelar_agendamento).
        // A Frizzar retorna cada agendamento com o campo `codigo` (é o próprio agendamentoId
        // usado depois em cancelar_agendamento). Os aliases agendamentoId/agendaId/id existem
        // como salvaguarda caso a API mude a nomenclatura no futuro.
        if (provider === "frizzar" && toolCall.function.name === "buscar_agendamentos" && Array.isArray(toolResult)) {
          const ids = toolResult
            .map((a: any) => toPositiveInteger(a?.codigo) ?? toPositiveInteger(a?.agendamentoId) ?? toPositiveInteger(a?.agendaId) ?? toPositiveInteger(a?.id))
            .filter((n: any): n is number => typeof n === "number");
          (sessionState as any).frizzarValidAgendasIds = ids;
          console.log(`[Frizzar] validAgendasIds tracked: [${ids.join(",")}]`);
        }

        // ===== APPBARBER: catálogo de profissionais válidos (bloqueia professional_code alucinado em criar_agendamento).
        // Alimentado por listar_profissionais, listar_horarios e listar_horarios_geral.
        // Grave porque /v1/availability tem bug conhecido: ignora filtro por profissional
        // e devolve grade de todos, então sem trava a IA pode oferecer horário do barbeiro errado.
        if (provider === "appbarber" && toolResult && !(toolResult as any)?.error) {
          const collectCodes = (): number[] => {
            const out: number[] = [];
            if (toolCall.function.name === "listar_profissionais" && Array.isArray((toolResult as any)?.professionals)) {
              for (const p of (toolResult as any).professionals) {
                const code = toPositiveInteger(p?.professional_code) ?? toPositiveInteger(p?.employee_code);
                if (typeof code === "number") out.push(code);
              }
            }
            if (toolCall.function.name === "listar_horarios_geral" && Array.isArray((toolResult as any)?.profissionais)) {
              for (const p of (toolResult as any).profissionais) {
                const code = toPositiveInteger(p?.professional_code);
                if (typeof code === "number") out.push(code);
              }
            }
            if (toolCall.function.name === "listar_horarios") {
              const code = toPositiveInteger((toolResult as any)?.professional_code);
              if (typeof code === "number") out.push(code);
            }
            return out;
          };
          const newCodes = collectCodes();
          if (newCodes.length > 0) {
            const existing = new Set(((sessionState as any).appbarberValidProfessionalCodes || []) as number[]);
            for (const c of newCodes) existing.add(c);
            (sessionState as any).appbarberValidProfessionalCodes = Array.from(existing).slice(0, 100);
            console.log(`[AppBarber] validProfessionalCodes += [${newCodes.join(",")}] (total=${(sessionState as any).appbarberValidProfessionalCodes.length})`);
          }
        }

        // ===== APPBARBER: rastreia invoice_codes do cliente após listar_agendamentos (checagem de propriedade em cancelar_agendamento).
        if (provider === "appbarber" && toolCall.function.name === "listar_agendamentos" && toolResult && Array.isArray((toolResult as any)?.appointments)) {
          const codes = (toolResult as any).appointments
            .map((a: any) => toPositiveInteger(a?.invoice_code))
            .filter((n: any) => typeof n === "number");
          (sessionState as any).appbarberValidInvoiceCodes = codes;
          console.log(`[AppBarber] validInvoiceCodes tracked: [${codes.join(",")}]`);
        }

        // ===== ACTIVE BOOKINGS LOOKUP TRACKING (5 providers) =====
        // Registra qualquer busca bem-sucedida de agendamento ativo do cliente
        // atual. Roda DEPOIS dos filtros de ownership acima, então o payload
        // aqui já reflete só os agendamentos que pertencem a este telefone.
        // Serve como 2ª fonte de legitimidade pro PhantomConfirmationGuard —
        // permite reafirmar/orientar sobre agendamento criado fora da IA
        // (ex: no app do provider) sem cair no bloqueio de alucinação.
        try {
          if (
            ACTIVE_BOOKING_LOOKUP_TOOLS.has(toolCall.function.name) &&
            !wasBlocked &&
            toolResult &&
            !(toolResult as any)?.error &&
            !(toolResult as any)?.blocked &&
            !(toolResult as any)?.empty
          ) {
            recordActiveBookingsLookup(sessionState, toolCall.function.name, toolResult);
          }
        } catch (e) {
          console.warn(`[ActiveBookingsLookup] record failed: ${(e as any)?.message || e}`);
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
            frizzarSetLastListed(sessionState, profId, data);
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
      }

      // Build enhanced log entry
      const logEntry: AgentResult["toolCalls"][0] = {
        name: toolCall.function.name,
        args: parsedArgs,
        result: toolResult,
        blocked: wasBlocked,
        round: rounds,
        started_at: __toolStartedAt,
        duration_ms: Date.now() - __toolStartedMs,
        trace_from: __traceStartSeq,
        trace_to: getHttpTrace().length,
      } as any;
      
      // Add correction info if applicable
      if (correctionReason) {
        logEntry.originalArgs = originalParsedArgs;
        logEntry.resolvedArgs = parsedArgs;
        logEntry.correctionReason = correctionReason;
      }
      
      logToolCalls.push(logEntry);

      if (toolResult?.error) {
        const isIntentionalBlock = toolResult?.blocked === true;
        logErrors.push({
          message: `Tool ${toolCall.function.name}: ${JSON.stringify(toolResult.error).slice(0, 200)}`,
          level: isIntentionalBlock ? "warning" : "error",
        });
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
        const alreadyBooked = r.alreadyBooked === true || r.status === "SUCESSO_ANTERIOR_JA_REGISTRADO";
        const succeeded = alreadyBooked || (!r.error && !r.blocked && r.success !== false
          && !(Array.isArray(r.Errors) && r.Errors.length > 0)
          && (r.id || r.ok || r.success === true || r.agendamentoId || r.appointment_id || r.data));
        if (!succeeded) {
          if (provider === "frizzar" && toolCall.function.name === "agendar" && isRecoverableFrizzarScheduleResult(r)) {
            const recoveryInstruction = buildFrizzarScheduleRecoveryInstruction(r, parsedArgs);
            const lastToolMessage = messages[messages.length - 1] as any;
            if (lastToolMessage?.role === "tool" && lastToolMessage.tool_call_id === toolCall.id) {
              lastToolMessage.content = JSON.stringify({ ...r, instrucao: recoveryInstruction });
            }
            logErrors.push({ message: `[BookingGuard] Frizzar agendar failed with recoverable availability — injected alternatives directive`, level: "warning" });
            continue;
          }
          // Conflitos recuperáveis (ex.: AppBarber 422 — choque de horário). NÃO escalar.
          if (r?.recoverable === true) {
            const recoveryMsg = [
              "⚠️ Conflito de horário ao tentar agendar (não é falha de sistema).",
              `Motivo: ${r?.error || "horário indisponível"}.`,
              r?.hint
                ? `Ação OBRIGATÓRIA: siga este hint técnico da ferramenta: ${r.hint}`
                : "Ação OBRIGATÓRIA: chame listar_horarios novamente para o serviço/profissional/data corretos e ofereça ao cliente os horários realmente livres.",
              "NÃO escale humano. NÃO diga que houve erro/problema. NÃO confirme o agendamento.",
              "Fale de forma natural: o horário escolhido acabou de ficar indisponível e ofereça as alternativas que vierem da próxima consulta.",
            ].join(" ");
            const lastToolMessage = messages[messages.length - 1] as any;
            if (lastToolMessage?.role === "tool" && lastToolMessage.tool_call_id === toolCall.id) {
              lastToolMessage.content = JSON.stringify({ ...r, instrucao: recoveryMsg });
            }
            logErrors.push({ message: `[BookingGuard] ${toolCall.function.name} recoverable conflict — injected retry directive`, level: "warning" });
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
          postToolSystemMessages.push({ role: "system", content: guardMsg });
          logErrors.push({ message: `[BookingGuard] Booking tool ${toolCall.function.name} failed — injected escalate directive`, level: "error" });
        } else {
          // ✅ SUCESSO: força a IA a PARAR de chamar ferramentas e responder agora.
          // Sem isso, em alguns casos a IA chama listar_horarios/listar_agendamentos
          // depois do agendar bem-sucedido, estoura o limite de rounds e acaba
          // entregando uma resposta vazia ao cliente — mesmo com a reserva criada.
          const successMsg = alreadyBooked
            ? [
              "✅ AGENDAMENTO JÁ ESTAVA REGISTRADO.",
              "PARE imediatamente de chamar ferramentas — NÃO chame escalar_humano, agendar de novo, listar_horarios nem qualquer outra. NADA.",
              "Sua PRÓXIMA ação OBRIGATÓRIA é responder ao cliente em PORTUGUÊS, em UMA mensagem curta de WhatsApp, confirmando naturalmente que esse agendamento já ficou registrado.",
              "NÃO diga que houve erro, conflito, bloqueio ou falha. NÃO fale em atendimento humano.",
            ].join(" ")
            : [
              "✅ AGENDAMENTO CRIADO COM SUCESSO.",
              "PARE imediatamente de chamar ferramentas — NÃO chame listar_horarios, listar_agendamentos, buscar_agendamento, agendar de novo, nem qualquer outra. NADA.",
              "Sua PRÓXIMA ação OBRIGATÓRIA é responder ao cliente em PORTUGUÊS, em UMA mensagem curta de WhatsApp, confirmando:",
              "(1) que o agendamento foi feito; (2) data e horário; (3) serviço; (4) profissional. Use os dados do último resultado da ferramenta.",
              "Não invente preço nem nada que não esteja no resultado. Termine com uma despedida curta (ex: 'até lá!' ou um emoji).",
            ].join(" ");
          postToolSystemMessages.push({ role: "system", content: successMsg });
        }
      }
    }

    if (postToolSystemMessages.length > 0) {
      messages.push(...postToolSystemMessages);
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
      logErrors.push({ message: `AI gateway error (round ${rounds}): ${response.status} ${errText.slice(0, 200)}`, level: "error" });
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
  // Flag: quando o MultiBookingGuard sobrescreve finalResponse, essa resposta é
  // intencional/correta e NÃO deve ser passada pelo ReplyDedup (que poderia
  // regenerá-la sem contexto do guard e voltar a mentir "tá tudo confirmado").
  let guardOverrideResponse = false;

  // Strip leaked internal prefixes (NEVER expose to client)
  finalResponse = stripInternalPrefixes(finalResponse);

  // Detect leaked reasoning/scratchpad (e.g., "Vou proceed. Need next user input.") and regenerate
  if (finalResponse && isLeakedReasoningResponse(finalResponse)) {
    console.warn(`[LeakDetected] Discarding leaked reasoning response: "${finalResponse.slice(0, 120)}"`);
    logErrors.push({ message: `Leaked reasoning detected and discarded: "${finalResponse.slice(0, 120)}"`, level: "warning" });
    finalResponse = "";
  }

  if (!finalResponse) {
    const recoveredResponseRaw = await requestFinalNaturalResponse(messages);
    const recoveredResponse = stripInternalPrefixes(recoveredResponseRaw || "");
    if (recoveredResponse && !isLeakedReasoningResponse(recoveredResponse)) {
      finalResponse = recoveredResponse;
    } else if (recoveredResponse) {
      console.warn(`[LeakDetected] Recovery also leaked, discarding: "${recoveredResponse.slice(0, 120)}"`);
      logErrors.push({ message: `Recovery response also leaked: "${recoveredResponse.slice(0, 120)}"`, level: "error" });
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
      logErrors.push({ message: `Resposta vazia após agendamento bem-sucedido — usado fallback determinístico.`, level: "warning" });
      finalResponse = bookingFallback;
    } else {
      // Last-resort fallback: stay completely silent rather than send a generic line that
      // breaks character. Returning empty string prevents the webhook from sending a message.
      finalResponse = "";
    }
  }

  // ============================================================================
  // 🛡️ PHANTOM CONFIRMATION GUARD
  // ÚNICA função: impedir a IA de PROMETER/INDUZIR que um agendamento NOVO foi
  // finalizado quando ela não criou nada de verdade nesta rodada.
  //
  // Importante: confirmação de agendamento PRÉ-EXISTENTE enviada pela barbearia
  // (mensagem [ATENDENTE HUMANO] / lembrete externo: "posso confirmar?") NÃO é
  // criação nova e NÃO deve acionar este guard. Nesse cenário o agendamento já
  // existe; o cliente está apenas respondendo ao estabelecimento.
  //
  // O MultiBookingGuard abaixo só roda quando houve pelo menos 1 tentativa de
  // criação; este guard cobre o caso complementar: 0 tentativas + resposta final
  // que deixa o cliente entender que está tudo criado/confirmado.
  // ============================================================================
  const _bookingAttempts = countBookingCallAttempts(logToolCalls);
  // ⚠️ ESCOPO: definido POR PROVIDER, no módulo de cada API
  // (providers/<api>/index.ts → phantomGuardConfig). Se um dia o AppBarber
  // (ou qualquer outro) sair do ar ou precisar de regra própria, basta mexer
  // no módulo dele — os demais não são afetados.
  const _phantomCfg = getPhantomGuardConfig(provider);

  if (finalResponse && !guardOverrideResponse && _bookingAttempts === 0 && _phantomCfg) {

    const lastAssistantMessage = getLastAssistantMessage(history) || "";
    const lastAssistantWasHuman = /^\s*\[\s*ATENDENTE\s+HUMANO\s*\]/i.test(lastAssistantMessage);
    const userIsShortConfirmation = isAffirmativeReply(userMessage || "");

    // Se o cliente respondeu "sim/ok/pode" a uma mensagem manual da barbearia,
    // isso é confirmação de agendamento já existente. Não é fluxo de criação da
    // IA, então este guard fica completamente fora do caminho.
    const isHumanExistingBookingConfirmation = lastAssistantWasHuman && userIsShortConfirmation;

    // Contexto estrutural de CRIAÇÃO NOVA: a ÚLTIMA mensagem da IA (não humana)
    // ofereceu/ancorou um horário e pediu confirmação; o cliente respondeu curto
    // confirmando. Neste ponto a IA precisa chamar agendar/criar_agendamento.
    // Se ela apenas disser "tudo certo, te esperamos", isso é promessa fantasma.
    const isNewBookingFinalStep = !lastAssistantWasHuman
      && userIsShortConfirmation
      && !!lastAssistantMessage
      && isBookingTimeConfirmationPrompt(lastAssistantMessage);

    // Claim explícito de criação nova — ainda útil para pegar "já agendei" mesmo
    // quando a mensagem anterior não foi detectada como prompt de confirmação.
    const CONFIRM_CLAIM_RE = /\b(?:(?:j[aá]\s+)?agendei|acabei\s+de\s+agendar|acabo\s+de\s+agendar|criei\s+(?:o\s+)?(?:seu\s+)?agendamento|criei\s+(?:a\s+)?(?:sua\s+)?reserva|marcamos\s+(?:seu|o)\s+hor[aá]rio|agendamento\s+(?:criado|feito|realizado)\s+com\s+sucesso|reserva\s+(?:criada|feita)\s+com\s+sucesso|prontinho[^.!?]{0,60}(?:agendei|criei|marcamos))\b/i;
    // Frases que não dizem "agendei", mas no ÚLTIMO PASSO de criação dão ao
    // cliente a impressão inequívoca de que pode ir à barbearia.
    const IMPLIED_FINALIZATION_RE = /\b(?:(?:tudo|ta|tá|esta|está)\s+(?:certo|confirmad[oa]|combinado)|confirmad[oa]|hor[aá]rio\s+(?:confirmad[oa]|marcad[oa]|reservad[oa])|agendamento\s+(?:confirmad[oa]|marcad[oa]|reservad[oa])|reserva\s+(?:confirmad[oa]|marcad[oa]|reservad[oa])|te\s+esperamos|esperamos\s+voc[eê]|at[eé]\s+(?:l[aá]|mais\s+tarde|amanh[aã])|fechado(?:\s+ent[aã]o)?|combinado(?:\s+ent[aã]o)?)\b/i;
    const CANCEL_CONTEXT_RE = /\bcancel|desmarc/i;
    const sentences = finalResponse.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
    const hasExplicitCreationClaim = sentences.some((s) => CONFIRM_CLAIM_RE.test(s) && !CANCEL_CONTEXT_RE.test(s) && !s.endsWith("?"));
    const hasImpliedFinalizationClaim = isNewBookingFinalStep
      && sentences.some((s) => IMPLIED_FINALIZATION_RE.test(s) && !CANCEL_CONTEXT_RE.test(s) && !s.endsWith("?"));
    const claimsNewBookingConfirmed = !isHumanExistingBookingConfirmation
      && (hasExplicitCreationClaim || hasImpliedFinalizationClaim);

    if (claimsNewBookingConfirmed) {
      // Só é alucinação de verdade se NÃO houver nenhum agendamento real JÁ EXISTENTE
      // registrado nesta sessão (senão pode ser reconfirmação legítima — ex: cliente
      // responde "positivo"/"sim" a um lembrete de agendamento feito dias atrás).
      //
      // 🚨 IMPORTANTE: usa a lista CRUA (sessionState.recentCompletedActions), NÃO
      // pruneRecentActions() — essa função aplica ACTION_LEDGER_TTL_MS (30 min),
      // que é curto demais pra esta checagem específica (um agendamento real segue
      // válido por dias, não só nos primeiros 30 min). Os outros 3 usos de
      // pruneRecentActions() (anti-loop, limpeza do ledger, texto injetado no
      // prompt) continuam com os 30 min originais — não tocados, é checagem
      // separada e isolada só pra este guard. O tamanho da lista já é limitado
      // por ACTION_LEDGER_MAX (12) em recordCompletedAction, então não cresce
      // sem limite mesmo sem o filtro de tempo aqui.
      const recentBookingSuccess = (sessionState.recentCompletedActions || []).some(
        (a) => a.category === "booking" && a.status === "success",
      );

      // 2ª fonte de legitimidade: busca recente bem-sucedida de agendamento
      // ativo do cliente (buscar_agendamento[s|_dia] / listar_agendamentos)
      // cujo horário/data aparece no texto da resposta. Cobre o caso do
      // agendamento criado FORA da IA (ex: cliente marcou no app do provider
      // e depois mandou "vou atrasar"), que nunca entra em recentCompletedActions.
      // TTL curto (10 min) e invalidada por cancel posterior — ver
      // isActiveBookingLookupStillValid.
      const lookupLegit = isActiveBookingLookupStillValid(sessionState)
        && responseCitesLookupBooking(finalResponse, sessionState);
      if (lookupLegit) {
        console.log(`[PhantomConfirmationGuard] Liberado pela 2ª fonte: busca ativa recente (${sessionState.recentActiveBookingsLookup?.toolName}, count=${sessionState.recentActiveBookingsLookup?.count}) bate com horário/data citado na resposta.`);
      }

      if (!recentBookingSuccess && !lookupLegit) {
        console.warn(`[PhantomConfirmationGuard] Resposta promete finalização de agendamento novo mas houve 0 tentativas de agendar/criar_agendamento nesta rodada. Contexto final=${isNewBookingFinalStep} explicit=${hasExplicitCreationClaim} implied=${hasImpliedFinalizationClaim}. Tentando reinjeção.`);
        logErrors.push({ message: `Resposta prometia finalização de agendamento novo sem chamada real de agendar — tentando reinjeção antes de responder.`, level: "warning" });

        let recovered = false;
        try {
          const _bookingNames = _phantomCfg.bookingToolNames.join(" / ");
          const _searchNames = _phantomCfg.searchToolNames.join(" / ");
          const _recoveryNames = _phantomCfg.recoveryToolNames.join(", ");
          const nudge = {
            role: "system",
            content:
              "[SISTEMA — INTERNO, NÃO RESPONDER AO CLIENTE ESTE TEXTO] Você deu a entender que um agendamento NOVO estava finalizado, mas NÃO chamou nenhuma ferramenta de agendar nesta execução — não dá pra prometer criação sem criar de verdade. " +
              "Resolva AGORA, usando ferramentas (você pode encadear quantas precisar): " + _recoveryNames + ".\n" +
              "1) Se o cliente está reafirmando/confirmando um agendamento que JÁ EXISTE, chame " + _searchNames + ". Se achar um ativo compatível, responda confirmando com os dados reais retornados.\n" +
              "2) Se é um agendamento NOVO e você ainda NÃO consultou disponibilidade nesta rodada, consulte primeiro (serviços/profissionais/horários) e só então chame " + _bookingNames + ".\n" +
              "3) Se faltar algum dado que só o cliente pode dar, pergunte de forma natural — sem prometer que já está agendado.\n" +
              "Nunca responda ao cliente afirmando agendamento criado sem retorno positivo de " + _bookingNames + ".",
          };
          messages.push(nudge);

          // Até 3 rodadas de ferramentas: a IA pode precisar de listar_servicos →
          // listar_horarios → agendar. Antes só valia booking/busca — qualquer outra
          // ferramenta era descartada e o cliente recebia a mensagem genérica
          // (caso 554188871221 / AppBarber, 27/07): a IA fez o trabalho certo e o
          // guard jogou fora. Agora qualquer ferramenta executada conta como
          // recuperação e a resposta final sai do resultado real.
          const bookingNamesSet = new Set(_phantomCfg.bookingToolNames);
          const searchNamesSet = new Set(_phantomCfg.searchToolNames);
          let anyBookingSucceeded = false;
          let anyToolExecuted = false;
          let pendingToolCalls: any[] = [];
          let assistantText = "";

          for (let round = 0; round < 3; round++) {
            const retryBody = {
              model: modelUsed,
              messages,
              tools: buildToolsForProvider(provider, tenant),
              tool_choice: "auto",
              max_completion_tokens: 700,
            };
            const retryResp = await fetchAIWithRetry(JSON.stringify(retryBody), `phantom-confirmation-reinject-r${round + 1}`);
            if (!retryResp.ok) break;
            const retryJson = await retryResp.json();
            const retryMsg = retryJson?.choices?.[0]?.message;
            pendingToolCalls = Array.isArray(retryMsg?.tool_calls) ? retryMsg.tool_calls : [];
            assistantText = String(retryMsg?.content || "").trim();
            if (pendingToolCalls.length === 0) break;

            messages.push(retryMsg);
            for (const tc of pendingToolCalls) {
              let tResult: any;
              try {
                tResult = await executeToolForProvider(provider, tenant, tc, phoneNumber, { supabase, simulatorMode, sessionState });
              } catch (e) {
                tResult = { error: `Erro ao executar ${tc?.function?.name}: ${(e as Error)?.message || "erro desconhecido"}` };
              }
              messages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: typeof tResult === "string" ? tResult : JSON.stringify(tResult ?? {}),
              });
              const tname = tc?.function?.name;
              anyToolExecuted = true;
              const ok = tResult && !tResult.error && !tResult.blocked;
              if (bookingNamesSet.has(tname) && ok) anyBookingSucceeded = true;
              if (ok && (bookingNamesSet.has(tname) || searchNamesSet.has(tname))) {
                logToolCalls.push({ name: tname, args: parseToolArguments(tc.function?.arguments), result: tResult });
              }
            }
            if (anyBookingSucceeded) break;
          }

          if (anyBookingSucceeded) {
            const det = buildDeterministicBookingConfirmation(logToolCalls);
            if (det) {
              finalResponse = det;
              guardOverrideResponse = true;
              recovered = true;
            }
          }

          if (!recovered && anyToolExecuted) {
            // A IA já viu resultados reais de ferramenta. Fecha com uma rodada de
            // texto puro (sem tools) pra ela responder com base neles — confirmando,
            // oferecendo alternativa ou pedindo o dado que falta.
            try {
              const finalBody = { model: modelUsed, messages, max_completion_tokens: 500 };
              const finalResp = await fetchAIWithRetry(JSON.stringify(finalBody), "phantom-confirmation-final-answer");
              if (finalResp.ok) {
                const finalJson = await finalResp.json();
                const finalMsgText = finalJson?.choices?.[0]?.message?.content?.trim();
                if (finalMsgText) {
                  finalResponse = finalMsgText;
                  guardOverrideResponse = true;
                  recovered = true;
                }
              }
            } catch (e) {
              console.error(`[PhantomConfirmationGuard] final-answer exception: ${(e as Error)?.message}`);
            }
            if (!recovered && assistantText) {
              finalResponse = assistantText;
              guardOverrideResponse = true;
              recovered = true;
            }
          }
        } catch (e) {
          console.error(`[PhantomConfirmationGuard] reinject exception: ${(e as Error)?.message}`);
        }

        if (!recovered) {
          finalResponse = "Deixa eu confirmar aqui rapidinho e já te retorno.";
          guardOverrideResponse = true;
        }
      }
    }
  }

  // ============================================================================
  // 🛡️ MULTI-BOOKING GUARD — 1 GUARDA POR API (personalizado)
  // Gatilho estrutural: só roda se a IA TENTOU criar pelo menos 1 agendamento
  // no turno (agendar/criar_agendamento). Independente do texto de saída.
  //
  // ⚠️ ESCOPO ATIVO: apenas providers com semântica de multi-booking já validada.
  //  - "frizzar": em produção há tempo, funciona bem (validação da Bendita).
  //  - "appbarber": personalização = `services[]` (comanda) conta N no
  //    countSuccessfulBookingsInTurn; permite fundir múltiplos serviços num único
  //    criar_agendamento sem falso positivo.
  //
  // ❌ Removidos (Trinks, Bemp, OneBeleza) — o guard genérico estava causando
  // mais falsos positivos do que corrigindo. Cada um será reintroduzido com
  // regras próprias da API depois de validar em produção.
  const _guardsCfg = getBookingGuardsConfig(provider);
  const _mbCfg = _guardsCfg.multiBooking;
  const _mbBookingNames = new Set(_mbCfg.bookingToolNames);
  if (_bookingAttempts > 0 && _mbCfg.enabled) {

    const { count: criados, breakdown, executions: bookedExecutionCount } = countSuccessfulBookingsInTurn(logToolCalls, provider, sessionState);
    const bookedServiceNames = extractBookedServiceNames(logToolCalls, provider, sessionState);
    // 🔒 Passa pro classificador as reservas já criadas em RODADAS ANTERIORES
    // desta conversa, pra ele não contá-las de novo quando a janela de mensagens
    // ainda cita a confirmação (caso real: cliente já tinha 1 agendamento
    // concluído no turno anterior; ao pedir um NOVO, o classificador contou 2
    // e o guard entrou em recovery loop pedindo IA "completar" o que já existia).
    const priorTurnBookings: string[] = ((sessionState.recentCompletedActions || []) as any[])
      .filter((a) => a && a.category === "booking_create" && a.status === "success" && typeof a.summary === "string")
      .map((a) => String(a.summary))
      .slice(-6);
    const cls = await classifyPendingBookings({
      messages,
      aiEndpoint,
      aiAuthKey,
      modelUsed,
      attempts: _bookingAttempts,
      bookedServiceNames,
      bookedExecutionCount,
      priorTurnBookings,
    });
    let prometidos = cls.total;

    // 🔒 FRIZZAR: a unidade do guard é VISITA/COMANDA, não quantidade de
    // serviços. O classificador devolve dimensões separadas para impedir os dois
    // erros opostos observados em produção:
    //  - corte + barba, mesma pessoa/visita => 1;
    //  - duas pessoas, mesmo horário => 2.
    // Não usamos apenas a última fala (que pode ser só "Sim"); a classificação
    // considera a janela inteira da negociação imediatamente anterior.
    if (_mbCfg.useIntentShape && cls.intentShape) {
      const { distinctPeople, distinctTimes, distinctProfessionals, sameVisitServicesOnly } = cls.intentShape;
      const visitsByDimensions = Math.max(distinctPeople, distinctTimes, distinctProfessionals);
      if (sameVisitServicesOnly && visitsByDimensions === 1) {
        prometidos = 1;
      } else if (visitsByDimensions > 1) {
        prometidos = visitsByDimensions;
      }
    }

    // 🔒 Clamp determinístico "1 execução = 1 visita".
    // Caso real Frizzar (Blackburn/Heider): cliente pediu "corte e barba" (1 pessoa,
    // 1 visita), a IA fez 1 única chamada de `agendar` com servicos:[corte, barba]
    // na mesma comanda. bookedExecutionCount=1, criados=1, mas o LLM classificou
    // prometidos=2 só porque viu 2 nomes distintos. Sem sinal determinístico de
    // múltiplas pessoas OU múltiplos horários OU múltiplos profissionais na fala do
    // cliente, forçamos prometidos = executions para não disparar recovery falso.
    if (bookedExecutionCount >= 1 && prometidos > bookedExecutionCount) {
      const visibleMsgs = messages.filter((m: any) =>
        (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string" && m.content.trim()
      );
      const lastUser = [...visibleMsgs].reverse().find((m: any) => m.role === "user")?.content || "";
      const explicitPeople = countExplicitProfessionalSelections(lastUser);
      const explicitTimes = countExplicitUserTimeSelections(lastUser);
      const classifiedMultiSignal = _mbCfg.useIntentShape && cls.intentShape
        ? Math.max(
          cls.intentShape.distinctPeople,
          cls.intentShape.distinctTimes,
          cls.intentShape.distinctProfessionals,
        ) >= 2
        : false;
      const hasMultiSignal = explicitPeople >= 2 || explicitTimes >= 2 || classifiedMultiSignal;
      if (!hasMultiSignal) {
        console.log(
          `[MultiBookingGuard] clamp 1-exec-1-visita: prometidos=${prometidos} → ${bookedExecutionCount} (executions=${bookedExecutionCount}, explicitPeople=${explicitPeople}, explicitTimes=${explicitTimes}, reasoning="${cls.reasoning || ""}")`,
        );
        prometidos = bookedExecutionCount;
      }
    }

    console.log(
      `[MultiBookingGuard] attempts=${_bookingAttempts} criados=${criados} executions=${bookedExecutionCount} prometidos=${prometidos} (src=${cls.source}) provider=${provider} reasoning="${cls.reasoning || ""}"`,
    );

    // Log estruturado no rastro de tool_calls pra auditoria.
    const guardLog = (acao: string) => {
      logToolCalls.push({
        name: "__multi_booking_guard__",
        args: { phase: "response_guard" },
        result: {
          layer: "multi_booking_guard",
          provider,
          attempts: _bookingAttempts,
          prometidos,
          criados,
          criados_por_tool: breakdown,
          acao,
          classifier_source: cls.source,
          classifier_reasoning: cls.reasoning,
          ...(_mbCfg.useIntentShape && cls.intentShape ? { classifier_intent_shape: cls.intentShape } : {}),
        },
      });
    };

    if (_mbCfg.skipWhenSingleVisit && prometidos <= 1) {
      // Não sequestra falhas de disponibilidade de uma visita simples. O
      // BookingGuard/provider já devolve as alternativas corretas; este guard
      // existe exclusivamente para garantir múltiplas visitas.
      guardLog("not_multi_booking");
    } else if (prometidos > MAX_AUTO_BOOKINGS) {
      // Escalada humana — mais de 3 agendamentos na mesma conversa.
      console.warn(`[MultiBookingGuard] prometidos=${prometidos} > ${MAX_AUTO_BOOKINGS} → acima do limite automático desta rodada, sem escalar humano.`);
      logErrors.push({ message: `Multi-booking > ${MAX_AUTO_BOOKINGS} (${prometidos}) — acima do limite automático.`, level: "warning" });
      finalResponse = buildPartialBookingFallback(criados, prometidos, breakdown);
      guardOverrideResponse = true;
      guardLog("over_limit_no_human");
    } else if (criados < prometidos) {
      // 🚫 Curto-circuito: se alguma tentativa de agendar/criar nesta rodada falhou
      // com retryable=false, não adianta rodar o loop de recuperação — a IA vai
      // bater no mesmo erro definitivo (ex: pagamento pendente, conflito, 4xx de
      // regra de negócio). Usa clientMessage devolvido pelo provider (mensagem
      // determinística) em vez de deixar a IA improvisar confirmação falsa.
      const definitiveFailure = (logToolCalls || []).find((tc: any) => {
        if (!tc || !_mbBookingNames.has(tc.name)) return false;
        const r = tc.result;
        return r && typeof r === "object" && r.retryable === false;
      });
      if (definitiveFailure) {
        const r: any = definitiveFailure.result;
        console.warn(`[MultiBookingGuard] falha definitiva detectada (reason=${r.failureReason || r.error}) — pulando recovery.`);
        logErrors.push({ message: `Multi-booking abortado por falha definitiva: ${r.failureReason || r.error}`, level: "warning" });
        // Se já rolou pelo menos um agendamento com sucesso, usar o fallback
        // transparente (o que criou + probleminha no restante + aciona equipe).
        // Se nada foi criado, respeita o clientMessage do provider.
        const partialCount = countSuccessfulBookingsInTurn(logToolCalls, provider, sessionState);
        if (partialCount.count > 0 && partialCount.count < prometidos) {
          finalResponse = buildPartialBookingFallback(partialCount.count, prometidos, partialCount.breakdown);
        } else {
          finalResponse = (typeof r.clientMessage === "string" && r.clientMessage.trim())
            ? r.clientMessage.trim()
            : "Não consegui concluir esse agendamento agora. Vou acionar a equipe aqui pra resolver e já te retorno.";
        }
        guardOverrideResponse = true;
        guardLog("definitive_failure_no_recovery");
      } else {
      // 🔀 FRIZZAR — "escolha do cliente pendente": quando `agendar` devolveu
      // um erro estruturado com alternativas (horário indisponível MAS outros
      // barbeiros têm vaga, ou dia sem vaga com outrosDias), NÃO faz sentido
      // rodar o recovery loop com `tool_choice: required` — a IA vai tentar
      // agendar cegamente de novo ou ficar chamando `listar_horarios` sem
      // parar (foi o que aconteceu no caso 2868). O correto é uma rodada
      // EXTRA de texto (sem forçar tool) pra IA compor a resposta oferecendo
      // as alternativas que o provider já devolveu no payload da tool.
      const alternativesFailure = _mbCfg.useAlternativesShortCircuit
        ? (logToolCalls || []).find((tc: any) => {
            if (!tc || !_mbBookingNames.has(tc.name)) return false;
            const r = tc.result;
            if (!r || typeof r !== "object" || !r.error) return false;
            const hasPeers = Array.isArray(r.horariosOutrosProfissionais) && r.horariosOutrosProfissionais.length > 0;
            const hasPeerHours = Array.isArray(r.horariosLivres) && r.horariosLivres.length > 0;
            const hasOtherDays = Array.isArray(r.outrosDias) && r.outrosDias.length > 0;
            return hasPeers || hasPeerHours || hasOtherDays;
          })
        : null;
      if (alternativesFailure) {
        console.warn(`[MultiBookingGuard] Frizzar devolveu alternativas estruturadas — pulando recovery loop, forçando resposta em texto com alternativas.`);
        try {
          const nudge = [
            `[SISTEMA — INTERNO, NÃO REPETIR AO CLIENTE]`,
            `A última tentativa de agendar devolveu ERRO com alternativas prontas no payload da tool (horariosOutrosProfissionais, horariosLivres do próprio profissional ou outrosDias).`,
            `NÃO chame nenhuma tool agora. NÃO peça desculpa técnica genérica ("tive um probleminha").`,
            `Responda ao cliente em UMA mensagem curta e natural oferecendo, nesta ordem: 1) se houver outros barbeiros com EXATAMENTE o horário pedido no mesmo dia, ofereça esses barbeiros com nome; 2) se não houver, ofereça horários próximos do MESMO profissional no MESMO dia (horariosLivres); 3) só se nenhum barbeiro tiver o horário e o profissional pedido não tiver vaga naquele dia, ofereça outrosDias.`,
            `Pergunte ao cliente qual opção ele prefere antes de agendar. Não invente alternativa que não esteja no payload.`,
          ].join(" ");
          messages.push({ role: "system", content: nudge });
          const altBody: any = { model: modelUsed, messages, max_completion_tokens: 500, tool_choice: "none" };
          if (modelUsed.includes("gpt-5")) altBody.reasoning_effort = "minimal";
          const altResp = await fetchAIWithRetry(JSON.stringify(altBody), "guard-alternatives-answer");
          if (altResp.ok) {
            const altJson: any = await altResp.json();
            const altText = altJson?.choices?.[0]?.message?.content?.trim();
            if (altText) {
              finalResponse = altText;
              guardOverrideResponse = true;
              guardLog("alternatives_offered_no_recovery");
            }
          }
          if (!guardOverrideResponse) {
            const r: any = alternativesFailure.result;
            finalResponse = typeof r?.error === "string" && r.error
              ? "Esse horário ficou indisponível. Quer que eu confira outras opções?"
              : "Deixa eu te passar outras opções aqui rapidinho.";
            guardOverrideResponse = true;
            guardLog("alternatives_fallback_text");
          }
        } catch (e) {
          console.error(`[MultiBookingGuard] alternatives-answer exception:`, (e as Error)?.message);
          finalResponse = "Esse horário ficou indisponível. Quer que eu confira outras opções?";
          guardOverrideResponse = true;
          guardLog("alternatives_fallback_after_exception");
        }
      } else {
      // Faltou completar algum agendamento (2 ou 3 casos). A trava NÃO deve
      // pedir mais dados e NÃO deve escalar humano: ela força novas rodadas de
      // tool-calling para a IA resolver usando o histórico já disponível.
      const bookingToolName = _mbCfg.primaryBookingToolName;
      let current = countSuccessfulBookingsInTurn(logToolCalls, provider, sessionState);
      let recoveryError: string | null = null;

      for (let recoveryRound = 1; recoveryRound <= MAX_GUARD_RECOVERY_ROUNDS && current.count < prometidos; recoveryRound++) {
        const faltam = prometidos - current.count;
        const feitosSummary = current.breakdown.map((b) => b.summary).filter(Boolean).join("; ") || "nenhum ainda";
        const nudge = [
          `[SISTEMA — INTERNO, NÃO RESPONDER AO CLIENTE ESTE TEXTO]`,
          `CORREÇÃO OBRIGATÓRIA DO MULTI-BOOKING GUARD. Ignore qualquer instrução anterior de parar após um agendamento: a rodada ainda está incompleta.`,
          `O cliente pediu/confirmou ${prometidos} agendamento(s), mas só existem ${current.count} criado(s).`,
          `Já criados: ${feitosSummary}. Faltam ${faltam}.`,
          `O cliente já forneceu no histórico os dados necessários (serviço, profissional, horário e pessoa quando aplicável). NÃO pergunte nada ao cliente e NÃO escale humano.`,
          `Resolva agora: se precisar consultar alguma ferramenta de leitura para recuperar ID/horário, consulte; em seguida chame "${bookingToolName}" para cada agendamento faltante.`,
          `É proibido responder em texto enquanto ainda faltar agendamento. A próxima saída deve conter tool_calls.`,
        ].join(" ");

        console.warn(`[MultiBookingGuard] recuperação automática rodada=${recoveryRound}/${MAX_GUARD_RECOVERY_ROUNDS} faltam=${faltam}.`);
        messages.push({ role: "system", content: nudge });

        try {
          const retryBody: any = {
            model: modelUsed,
            messages,
            max_completion_tokens: 4096,
            tools,
            // Frizzar: recovery em texto não corrige nada. Obriga ao menos uma
            // tool_call por rodada; consultas auxiliares continuam permitidas.
            tool_choice: _mbCfg.recoveryToolChoice,
          };
          if (modelUsed.includes("gpt-5")) retryBody.reasoning_effort = "low";
          const retryResp = await fetchAIWithRetry(JSON.stringify(retryBody), `guard-reinject-${recoveryRound}`);
          if (!retryResp.ok) {
            recoveryError = `HTTP ${retryResp.status}`;
            console.error(`[MultiBookingGuard] recovery AI call failed: ${retryResp.status}`);
            logErrors.push({ message: `Multi-booking recovery HTTP ${retryResp.status}`, level: "error" });
            continue;
          }

          const retryJson: any = await retryResp.json();
          const retryMsg: any = retryJson?.choices?.[0]?.message;
          const retryToolCalls: any[] = Array.isArray(retryMsg?.tool_calls) ? retryMsg.tool_calls : [];
          if (retryToolCalls.length === 0) {
            recoveryError = "retry sem tool_calls";
            console.warn(`[MultiBookingGuard] recuperação rodada=${recoveryRound} veio sem tool_calls; reforçando.`);
            logErrors.push({ message: `Multi-booking recovery sem tool_calls na rodada ${recoveryRound}`, level: "warning" });
            continue;
          }

          messages.push(retryMsg);
          let executed = 0;
          for (const tc of retryToolCalls) {
            const tname = tc?.function?.name;
            const isBookingTool = _mbBookingNames.has(tname);
            if (!isBookingTool && (typeof tname !== "string" || isWriteToolName(tname))) {
              messages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: JSON.stringify({ skipped: true, reason: "MultiBookingGuard: nesta recuperação só são permitidas consultas auxiliares e tools de agendamento." }),
              });
              continue;
            }
            current = countSuccessfulBookingsInTurn(logToolCalls, provider, sessionState);
            if (isBookingTool && current.count >= prometidos) {
              messages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: JSON.stringify({ skipped: true, reason: "MultiBookingGuard: quantidade prometida já foi concluída; chamada extra bloqueada para evitar duplicidade." }),
              });
              continue;
            }

            try {
              const tResult = await executeToolForProvider(
                provider,
                tenant,
                tc,
                phoneNumber,
                { supabase, simulatorMode, sessionState },
              );
              messages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: typeof tResult === "string" ? tResult : JSON.stringify(tResult ?? {}),
              });
              logToolCalls.push({
                name: tname,
                args: parseToolArguments(tc.function?.arguments),
                result: tResult,
              });
              executed++;
            } catch (e) {
              recoveryError = (e as Error)?.message || "erro";
              console.error(`[MultiBookingGuard] recovery tool ${tname} failed:`, recoveryError);
              logErrors.push({ message: `Guard recovery ${tname}: ${recoveryError}`, level: "error" });
              messages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: JSON.stringify({ error: `Erro ao executar ${tname}: ${recoveryError}` }),
              });
            }
          }

          current = countSuccessfulBookingsInTurn(logToolCalls, provider, sessionState);
          console.log(`[MultiBookingGuard] recuperação rodada=${recoveryRound} tools_executadas=${executed} total_ok=${current.count}/${prometidos}`);
        } catch (e) {
          recoveryError = (e as Error)?.message || "erro";
          console.error(`[MultiBookingGuard] recovery exception:`, recoveryError);
          logErrors.push({ message: `Multi-booking recovery exception: ${recoveryError}`, level: "error" });
        }
      }

      if (current.count >= prometidos) {
        const allSummaries = current.breakdown.map((b) => b.summary).filter(Boolean);
        const detConfirm = buildDeterministicBookingConfirmation(logToolCalls);
        finalResponse = allSummaries.length > 0
          ? `Prontinho! Consegui confirmar: ${allSummaries.join("; ")}. Te esperamos!`
          : (detConfirm || `Prontinho! Consegui confirmar os ${prometidos} agendamentos. Te esperamos!`);
        guardOverrideResponse = true;
        guardLog("recovery_completed");
      } else {
        console.warn(`[MultiBookingGuard] recuperação esgotada sem completar: ${current.count}/${prometidos}. Não escalando humano.`);
        logErrors.push({ message: `Multi-booking recovery esgotada: ${current.count}/${prometidos}${recoveryError ? ` (${recoveryError})` : ""}`, level: "error" });
        finalResponse = buildPartialBookingFallback(current.count, prometidos, current.breakdown);
        guardOverrideResponse = true;
        guardLog("recovery_exhausted_no_human");
      }
      } // fim else (sem falha definitiva → executou recovery loop)
      } // fim else (sem alternatives failure → executou recovery loop tradicional)
    } else {
      // criados >= prometidos → libera. Camada 3 abaixo cobre mismatch texto↔ação.
      guardLog("released");
    }

    // 🛡️ PROMISE-TO-CONTINUE GUARD — nunca deixar a IA prometer que vai
    // "continuar tentando" depois que o turno de ferramentas já acabou. Esse texto
    // é ruim operacionalmente porque o webhook não executa nada em background; se
    // ficou parcial, a resposta correta é acionar humano/equipe.
    if (
      finalResponse &&
      provider === "appbarber" &&
      /(?:ainda\s+falta|falta\s+concluir|vou\s+continuar\s+tentando|continuar\s+tentando\s+por\s+aqui)/i.test(finalResponse)
    ) {
      const current = countSuccessfulBookingsInTurn(logToolCalls, provider, sessionState);
      if (current.count > 0) {
        console.warn(`[PromiseToContinueGuard] AppBarber response prometia continuar tentando após tools; substituindo por fallback com escalação.`);
        logErrors.push({ message: `Resposta prometia continuar tentando após encerramento das tools — corrigida para acionar equipe.`, level: "warning" });
        finalResponse = buildPartialBookingFallback(current.count, current.count + 1, current.breakdown);
        guardOverrideResponse = true;
        guardLog("promise_to_continue_rewritten");
      }
    }

    // Camada 3 — mismatch texto↔execução. Se ainda restar incompleto, bloqueia
    // qualquer texto de confirmação total. Não escala humano e não pede dados.
    const postGuardCount = countSuccessfulBookingsInTurn(logToolCalls, provider, sessionState);
    if (
      prometidos <= MAX_AUTO_BOOKINGS &&
      postGuardCount.count < prometidos &&
      finalResponse &&
      IMPLICIT_CONFIRMATION_RE.test(finalResponse)
    ) {
      console.warn(`[MultiBookingGuard] Camada 3: texto sugere confirmação total mas criados<prometidos. Bloqueando confirmação falsa.`);
      logErrors.push({ message: `Mismatch texto↔execução detectado — confirmação falsa bloqueada.`, level: "warning" });
      finalResponse = buildPartialBookingFallback(postGuardCount.count, prometidos, postGuardCount.breakdown);
      guardOverrideResponse = true;
    }

    // Pausa a conversa apenas em cenários realmente bloqueantes (ex.: overflow > limite automático).
    if (sessionBlocked && !simulatorMode) {
      try {
        await supabase
          .from("conversation_pauses")
          .upsert(
            { tenant_id: tenant.id, phone_number: phoneNumber, paused: true },
            { onConflict: "tenant_id,phone_number" },
          );
        console.log(`[MultiBookingGuard] conversation_pauses set for ${phoneNumber} (blocking condition)`);
      } catch (e) {
        console.error("[MultiBookingGuard] failed to record pause:", (e as Error)?.message);
      }
    }
  }
  // ============================================================================
  // FIM MULTI-BOOKING GUARD
  // ============================================================================

  // ============================================================================
  // 🛡️ CANCEL GUARD — impede a IA de afirmar "cancelei" quando a ferramenta de
  // cancelamento falhou nesta rodada. Cobre `cancelar_agendamento` (Trinks,
  // Frizzar, Bemp, AppBarber) E `desmarcar_agendamento` (OneBeleza) — sem o
  // segundo nome, cancelamento da OneBeleza ficava sem guard e a IA podia
  // afirmar cancelamento falso.
  // ============================================================================
  const _cancelCfg = _guardsCfg.cancel;
  const CANCEL_TOOL_NAMES = new Set(_cancelCfg.cancelToolNames);
  if (finalResponse && !guardOverrideResponse && _cancelCfg.enabled) {
    const cancelAttempted = (logToolCalls || []).some((tc) => CANCEL_TOOL_NAMES.has(tc?.name));
    if (cancelAttempted) {
      // Todas as chamadas de cancelamento do turno precisam ter dado certo.
      // Antes usávamos `.some()` — se o cliente pedia cancelar 2 e só 1 caía,
      // a resposta afirmando "cancelei os dois" passava sem correção.
      const cancelCalls = (logToolCalls || []).filter((tc) => CANCEL_TOOL_NAMES.has(tc?.name));
      const cancelAllSucceeded = cancelCalls.length > 0 && cancelCalls.every((tc) => {
        const r: any = tc.result || {};
        return !r.error && r.blocked !== true;
      });
      const claimsCancelled = /cancel(ei|ado|ada|amos)|desmarqu(ei|ei|amos)|j[aá]\s+(cancel|desmarqu)/i.test(finalResponse);
      if (!cancelAllSucceeded && claimsCancelled) {
        const failedCount = cancelCalls.filter((tc) => {
          const r: any = tc.result || {};
          return !!r.error || r.blocked === true;
        }).length;
        console.warn(`[CancelGuard] cancelamento incompleto (${failedCount}/${cancelCalls.length} falharam) mas a resposta afirmava sucesso. Corrigindo.`);
        logErrors.push({ message: `Cancelamento parcial/falhou (${failedCount}/${cancelCalls.length}) mas resposta afirmava sucesso — corrigido pelo CancelGuard.`, level: "warning" });
        finalResponse = "Tive uma instabilidade aqui pra confirmar seu cancelamento. Já acionei o responsável pra garantir isso pra você — só um momento 🙏";
        guardOverrideResponse = true;
      }
    }
  }

  // ============================================================================
  // FIM CANCEL GUARD
  // ============================================================================

  // ============================================================================
  // 🛡️ RESCHEDULE GUARD — cenário "cancelou o antigo, novo falhou"
  // Se no mesmo turno a IA CANCELOU com sucesso E tentou criar/agendar mas
  // FALHOU, o cliente fica sem agendamento. Aqui a gente injeta 1 rodada extra
  // forçando a IA a recriar usando os dados que já estão no contexto
  // (chat_messages + sessionState). Sem escalar humano, sem pedir dado ao
  // cliente. Se ainda assim falhar, envia mensagem determinística avisando
  // que vai continuar tentando por aqui (o item de rollback via `editar_agendamento`
  // atômico só existe hoje na Trinks — cobrir os outros 4 fica pra P2).
  // ============================================================================
  const _reschedCfg = _guardsCfg.reschedule;
  const _reschedCancelNames = new Set(_reschedCfg.cancelToolNames);
  const _reschedBookingNames = new Set(_reschedCfg.bookingToolNames);
  if (finalResponse && !guardOverrideResponse && _reschedCfg.enabled) {
    const cancelOk = (logToolCalls || []).some((tc) => {
      if (!_reschedCancelNames.has(tc?.name)) return false;
      const r: any = tc.result || {};
      return !r.error && r.blocked !== true;
    });
    const bookingFailed = (logToolCalls || []).some((tc) => {
      if (!_reschedBookingNames.has(tc?.name)) return false;
      const r: any = tc.result || {};
      return !!r.error || r.blocked === true || r.success === false;
    });
    const bookingOk = (logToolCalls || []).some((tc) => {
      if (!_reschedBookingNames.has(tc?.name)) return false;
      const r: any = tc.result || {};
      if (r.error || r.blocked === true) return false;
      if (r.success === false) return false;
      return true;
    });
    if (cancelOk && bookingFailed && !bookingOk) {
      console.warn(`[RescheduleGuard] cancel OK + criar FAIL no mesmo turno para ${phoneNumber}. Tentando recuperação.`);
      logErrors.push({ message: `Remarcação incompleta detectada (cancelou o antigo, novo falhou) — tentando reinjeção sem pedir dados ao cliente.`, level: "warning" });
      let recovered = false;
      try {
        const nudge = {
          role: "system",
          content:
            "[SISTEMA — INTERNO, NÃO RESPONDER AO CLIENTE ESTE TEXTO] Você cancelou o agendamento antigo com sucesso, mas a criação do novo falhou. O cliente NÃO PODE ficar sem agendamento. " +
            "Use os dados que já estão no histórico (serviço, profissional, data, hora — tanto do antigo quanto do que o cliente pediu agora) e chame a ferramenta de agendar/criar_agendamento AGORA. " +
            "Se o erro anterior foi de horário indisponível, tente o horário original do agendamento cancelado como fallback. " +
            "PROIBIDO: pedir dados ao cliente, escalar pra humano, ou dizer que vai chamar alguém. Você resolve aqui.",
        };
        messages.push(nudge);
        const retryBody = { model: modelUsed, messages, tools: buildToolsForProvider(provider, tenant), tool_choice: "auto", max_completion_tokens: 700 };
        const retryResp = await fetchAIWithRetry(JSON.stringify(retryBody), "reschedule-guard-reinject");
        if (retryResp.ok) {
          const retryJson = await retryResp.json();
          const retryMsg = retryJson?.choices?.[0]?.message;
          const retryToolCalls = Array.isArray(retryMsg?.tool_calls) ? retryMsg.tool_calls : [];
          if (retryToolCalls.length > 0) {
            messages.push(retryMsg);
            let anyBookingSucceeded = false;
            for (const tc of retryToolCalls) {
              let tResult: any;
              try {
                tResult = await executeToolForProvider(provider, tenant, tc, phoneNumber, { supabase, simulatorMode, sessionState });
              } catch (e) {
                tResult = { error: `Erro ao executar ${tc?.function?.name}: ${(e as Error)?.message || "erro desconhecido"}` };
              }
              messages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: typeof tResult === "string" ? tResult : JSON.stringify(tResult ?? {}),
              });
              const toolName = tc?.function?.name;
              logToolCalls.push({ name: toolName, args: parseToolArguments(tc.function?.arguments), result: tResult });
              if (_reschedBookingNames.has(toolName) && tResult && !tResult.error && !tResult.blocked && tResult.success !== false) {
                anyBookingSucceeded = true;
              }
            }
            if (anyBookingSucceeded) {
              const det = buildDeterministicBookingConfirmation(logToolCalls);
              if (det) {
                finalResponse = det;
                guardOverrideResponse = true;
                recovered = true;
              }
            }
          }
        }
      } catch (e) {
        console.error(`[RescheduleGuard] reinject exception: ${(e as Error)?.message}`);
      }
      if (!recovered) {
        finalResponse = "Peraí, tive um problema técnico ao remarcar seu horário agora. Vou refazer aqui e já te confirmo em instantes 🙏";
        guardOverrideResponse = true;
      }
    }
  }
  // ============================================================================
  // FIM RESCHEDULE GUARD
  // ============================================================================





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
        logErrors.push({ message: `Loop de listagem de horários detectado (sig=${signature})`, level: "warning" });
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
  if (finalResponse && !guardOverrideResponse) {
    const dupHit = findSimilarRecentReply(sessionState, finalResponse);
    if (dupHit) {
      console.warn(`[ReplyDedup] Resposta similar à enviada há ${Math.round((Date.now() - Date.parse(dupHit.entry.at)) / 60000)}min (sim=${dupHit.sim.toFixed(2)}) para ${phoneNumber}. Tentando regenerar.`);
      logErrors.push({ message: `Reply repetida detectada (sim=${dupHit.sim.toFixed(2)}); regenerando.`, level: "warning" });
      // Detecta se a última mensagem do cliente é um acknowledgement puro
      // (ok/valeu/emoji) — só nesse caso o silêncio é aceitável. Se o cliente
      // trouxe qualquer conteúdo substantivo (nome de serviço, horário, nome
      // próprio, dúvida), a IA DEVE responder, mesmo que precise reformular.
      const lastUserMsg = [...messages].reverse().find((m: any) => m?.role === "user");
      const lastUserText = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "";
      const ackNorm = lastUserText.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9\s]/g, "").trim();
      const isPureAck = ackNorm.length <= 3 || /^(ok|okay|blz|beleza|valeu|vlw|obg|obrigad[oa]|tmj|sim|nao|não|uhum|aham|kk+|rs+)$/.test(ackNorm);

      try {
        const antiRepeatReminder = {
          role: "system" as const,
          content: isPureAck
            ? `ALERTA: você acabou de gerar uma mensagem quase idêntica a "${dupHit.entry.text.slice(0, 200)}" que já enviou há poucos minutos. A última mensagem do cliente é apenas um "ok/valeu/emoji" sem conteúdo novo — devolva STRING VAZIA (não envie nada). Nunca reenvie a mesma resposta.`
            : `ALERTA: você acabou de gerar uma mensagem quase idêntica a "${dupHit.entry.text.slice(0, 200)}" que já enviou há poucos minutos. A última mensagem do cliente TEM CONTEÚDO NOVO ("${lastUserText.slice(0, 160)}") e precisa ser respondida. NÃO repita a mensagem anterior nem uma paráfrase — avance a conversa reconhecendo o que o cliente acabou de dizer e faça a próxima pergunta ou ação. É obrigatório responder algo diferente; não devolva string vazia.`,
        };
        const regenRaw = await requestFinalNaturalResponse([...messages, antiRepeatReminder]);
        const regen = stripInternalPrefixes(regenRaw || "").trim();
        if (regen && !isLeakedReasoningResponse(regen)) {
          const stillDup = findSimilarRecentReply(sessionState, regen);
          if (stillDup) {
            if (isPureAck) {
              console.warn(`[ReplyDedup] Regeneração ainda duplicada (sim=${stillDup.sim.toFixed(2)}) e cliente só mandou ack. Silenciando.`);
              logErrors.push({ message: `Regeneração ainda duplicada — mensagem suprimida (ack).`, level: "warning" });
              finalResponse = "";
            } else {
              // Cliente trouxe contexto novo — melhor mandar duplicado do que ficar mudo.
              console.warn(`[ReplyDedup] Regeneração ainda duplicada (sim=${stillDup.sim.toFixed(2)}) mas cliente trouxe contexto novo. Enviando mesmo assim.`);
              logErrors.push({ message: `Regeneração ainda duplicada, mas cliente trouxe contexto novo — enviado assim mesmo.`, level: "warning" });
              finalResponse = regen;
            }
          } else {
            finalResponse = regen;
          }
        } else {
          if (isPureAck) {
            console.log(`[ReplyDedup] Regeneração vazia → silêncio intencional para ${phoneNumber}.`);
            finalResponse = "";
          } else {
            // Cliente trouxe contexto novo e regeneração falhou — mantém a resposta original
            // para não deixar o cliente sem retorno.
            console.warn(`[ReplyDedup] Regeneração vazia mas cliente trouxe contexto novo — mantendo resposta original.`);
            logErrors.push({ message: `Regeneração vazia com contexto novo do cliente — mantida resposta original.`, level: "warning" });
            // finalResponse já contém a resposta original
          }
        }
      } catch (e) {
        console.error("[ReplyDedup] Falha ao regenerar:", (e as any)?.message);
        if (isPureAck) {
          finalResponse = "";
        }
        // se não é ack, mantém finalResponse original
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

/** Ferramenta universal de calculadora — modelos de linguagem "calculam de
 * cabeça" gerando texto, o que frequentemente erra em contas com várias
 * casas decimais ou vários passos (ex: orçamentos com quantidade × preço
 * unitário + acabamento + margem). Forçar a IA a usar essa ferramenta pra
 * QUALQUER cálculo numérico garante que a conta é feita em código de
 * verdade (JS), nunca "adivinhada" — resolve o problema relatado pelo
 * Mariano (erros de cálculo no fluxo antigo do n8n, especificamente para
 * orçamentos da gráfica que ele vai adicionar). */
const CALCULADORA_TOOL = {
  type: "function" as const,
  function: {
    name: "calcular",
    description:
      "Calcula o resultado EXATO de uma expressão matemática. Use SEMPRE que precisar fazer qualquer conta com mais de um passo, valores decimais, ou multiplicação/divisão — NUNCA calcule de cabeça, mesmo que pareça simples. Essencial para orçamentos (quantidade × preço unitário, somar acabamentos, aplicar desconto/margem, etc.) e qualquer outro cálculo numérico da conversa.",
    parameters: {
      type: "object",
      properties: {
        expressao: {
          type: "string",
          description:
            "Expressão matemática em notação padrão, só números e operadores + - * / ( ). Ex: '150 * 0.35 + 45.90 * 2'. Escreva a conta completa numa expressão só, não peça pra calcular em etapas separadas.",
        },
      },
      required: ["expressao"],
    },
  },
};

/** Avalia uma expressão aritmética com segurança (só dígitos, operadores
 * básicos e parênteses — sem eval genérico, sem acesso a nada do ambiente).
 * Rejeita qualquer caractere fora desse conjunto antes mesmo de tentar
 * calcular. */
function safeCalculate(expressao: string): { ok: true; resultado: number } | { ok: false; error: string } {
  const cleaned = String(expressao || "").trim();
  if (!cleaned) return { ok: false, error: "Expressão vazia." };
  if (!/^[0-9+\-*/().,\s]+$/.test(cleaned)) {
    return { ok: false, error: "Expressão contém caracteres não permitidos — use só números e + - * / ( )." };
  }
  const normalized = cleaned.replace(/,/g, ".");
  try {
    // new Function com entrada já validada pelo regex acima (só dígitos,
    // operadores e parênteses) — não é eval genérico, não executa nada
    // além de aritmética.
    // eslint-disable-next-line no-new-func
    const result = new Function(`"use strict"; return (${normalized});`)();
    if (typeof result !== "number" || !Number.isFinite(result)) {
      return { ok: false, error: "A expressão não resultou em um número válido." };
    }
    return { ok: true, resultado: Math.round(result * 100) / 100 };
  } catch {
    return { ok: false, error: "Não consegui interpretar essa expressão — confira a sintaxe." };
  }
}

/** Transforma o nome de uma etapa (ex: "Já Interessou!") num identificador
 * válido para nome de função (ex: "ja_interessou") — sem acentos, minúsculo,
 * só letras/números/underscore. Usado para montar nomes de ferramenta
 * legíveis em vez de UUIDs técnicos. */
function slugifyStageName(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "etapa";
}

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
    case "appbarber":
      providerTools = buildAppBarberTools(tenant);
      break;
    case "none":
      providerTools = buildNoneTools(tenant);
      break;
    default:
      providerTools = buildTrinksTools(tenant);
  }

  // Ferramentas do CRM externo: uma por etapa, de CADA funil que o cliente
  // configurou (pode ter vários — cada um vira uma linha em
  // tenant_crm_funnels). Cache de etapas evita consultar a API externa a
  // cada mensagem.
  const crmFunnels: Array<{ funnel_id: string; funnel_name: string; stages: { id: string; name: string }[] }> =
    Array.isArray((tenant as any)?.crm_funnels) ? (tenant as any).crm_funnels : [];
  if (tenant?.crm_zetta_token && crmFunnels.length > 0) {
    const usedSlugs = new Set<string>();
    const crmTools = crmFunnels.flatMap((funnel) =>
      (funnel.stages || []).map((stage: { id: string; name: string }) => {
        // Nome legível ("mover_para_respondeu") em vez do UUID técnico —
        // mais fácil pra IA reconhecer e usar corretamente. Se duas etapas
        // (do mesmo funil ou de funis diferentes) geram o mesmo slug,
        // desambigua com um sufixo numérico.
        let slug = slugifyStageName(stage.name);
        if (usedSlugs.has(slug)) {
          let i = 2;
          while (usedSlugs.has(`${slug}_${i}`)) i++;
          slug = `${slug}_${i}`;
        }
        usedSlugs.add(slug);
        return {
          type: "function",
          function: {
            name: `crm_mover_para_${slug}`,
            description: `Move o lead atual para a etapa "${stage.name}" do funil "${funnel.funnel_name}" no CRM. Use quando um sinal claro da conversa indicar que o lead mudou de estágio nessa etapa (ex: chegou, respondeu, demonstrou interesse, confirmou, desistiu — dependendo do que essa etapa representa). Não chame para toda mensagem, só quando o estágio realmente mudou.`,
            parameters: { type: "object", properties: {}, required: [] },
          },
        };
      }),
    );
    providerTools = [...(providerTools || []), ...crmTools];
  }

  // Universal client-summary tool (all providers)
  providerTools = [...(providerTools || []), ATUALIZAR_RESUMO_TOOL, CALCULADORA_TOOL];

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
  opts?: { supabase?: any; simulatorMode?: boolean; sessionState?: AgentSessionState },
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

  // ===== Universal tool: calcular
  // Sem efeito colateral (não mexe em banco/CRM), então funciona igual no
  // simulador e em produção — sempre executa de verdade, a exatidão da
  // conta é o ponto inteiro dessa ferramenta.
  if (funcName === "calcular") {
    let toolArgs: any = {}; try { toolArgs = JSON.parse(toolCall.function.arguments || "{}"); } catch { /* empty */ }
    const expressao = String(toolArgs?.expressao ?? "");
    const calc = safeCalculate(expressao);
    if (!calc.ok) return { ok: false, error: calc.error };
    return { ok: true, resultado: calc.resultado };
  }

  // ===== Universal tool: atualizar_resumo_cliente
  if (funcName === "atualizar_resumo_cliente") {
    let toolArgs: any = {}; try { toolArgs = JSON.parse(toolCall.function.arguments || "{}"); } catch { /* empty */ }
    const resumo = String(toolArgs?.resumo ?? "").trim().slice(0, 1200);
    if (!resumo) return { ok: false, error: "Resumo vazio." };

    // Trava estrutural compartilhada — ver findForbiddenSummaryContent() (top-level).
    // Também aplicada dentro de persistClientSummary(), que é o segundo caminho
    // (automático) que escreve na mesma coluna — ambos precisam da mesma validação.
    const violated = findForbiddenSummaryContent(resumo);
    if (violated) {
      console.warn(`[ResumoCliente] BLOQUEADO — resumo contém ${violated.label}: "${resumo.slice(0, 100)}"`);
      return {
        ok: false,
        error: `Resumo rejeitado: contém ${violated.label}. O resumo do cliente é só para PREFERÊNCIAS DURÁVEIS (serviço favorito, plano, profissional preferido, frequência) — nunca datas, horários ou confirmações de agendamentos específicos, que ficam em outro lugar do sistema. Reescreva sem essa informação.`,
      };
    }

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
    } finally {
      // Sincroniza o mesmo resumo com o CRM externo (Zaylo), em card
      // separado da anotação manual do vendedor de lá — mesmo padrão já
      // usado em crm_mover_para_ (Bearer token do tenant). Só tenta se o
      // CRM estiver configurado; nunca bloqueia nem falha a resposta
      // principal por causa disso (é um "melhor esforço", a fonte de
      // verdade do resumo continua sendo aqui).
      if (tenant?.crm_zetta_token && phoneNumber) {
        try {
          const crmRes = await fetch("https://crm.zayloia.com/api/public/ai/update-summary", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${tenant.crm_zetta_token}` },
            body: JSON.stringify({ phone: phoneNumber, summary: resumo }),
          });
          if (!crmRes.ok) {
            console.warn(`[atualizar_resumo_cliente] sync com CRM falhou (${crmRes.status})`);
          }
        } catch (syncErr) {
          console.warn("[atualizar_resumo_cliente] erro de rede sincronizando com CRM:", syncErr instanceof Error ? syncErr.message : syncErr);
        }
      }
    }
  }

  // ===== CRM externo: crm_mover_para_{slug_do_nome_da_etapa}
  if (funcName.startsWith("crm_mover_para_")) {
    const slug = funcName.slice("crm_mover_para_".length);
    if (!tenant?.crm_zetta_token) {
      return { ok: false, error: "Integração com o CRM não está configurada." };
    }
    // Resolve o slug de volta para o funil + nome real da etapa,
    // procurando em TODOS os funis configurados (o cliente pode ter
    // vários) — a API do CRM já aceita nome em texto, não precisa do
    // UUID técnico de nenhum dos dois.
    const crmFunnelsExec: Array<{ funnel_id: string; funnel_name: string; stages: { id: string; name: string }[] }> =
      Array.isArray((tenant as any)?.crm_funnels) ? (tenant as any).crm_funnels : [];
    let matchedFunnelName: string | null = null;
    let stageName: string | null = null;
    // Reproduz a MESMA desambiguação usada na geração das ferramentas
    // (buildToolsForProvider): quando dois funis têm etapas de mesmo nome, a
    // segunda vira "<slug>_2". Sem isso, a IA chamaria uma ferramenta que
    // existe e o executor diria "etapa não encontrada".
    const usedSlugsExec = new Set<string>();
    for (const funnel of crmFunnelsExec) {
      for (const s of funnel.stages || []) {
        let candidate = slugifyStageName(s.name);
        if (usedSlugsExec.has(candidate)) {
          let i = 2;
          while (usedSlugsExec.has(`${candidate}_${i}`)) i++;
          candidate = `${candidate}_${i}`;
        }
        usedSlugsExec.add(candidate);
        if (candidate === slug) {
          matchedFunnelName = funnel.funnel_name;
          stageName = s.name;
          break;
        }
      }
      if (stageName) break;
    }
    if (!matchedFunnelName || !stageName) {
      return { ok: false, error: `Etapa "${slug}" não encontrada em nenhum funil configurado.` };
    }
    if (simulator) {
      return { ok: true, simulated: true, message: `Lead seria movido no CRM (simulado, funil "${matchedFunnelName}", etapa "${stageName}").` };
    }
    if (!phoneNumber) return { ok: false, error: "Telefone do lead indisponível." };
    try {
      const res = await fetch("https://crm.zayloia.com/api/public/ai/move-lead", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tenant.crm_zetta_token}` },
        body: JSON.stringify({ phone: phoneNumber, funnel: matchedFunnelName, stage: stageName }),
      });
      const text = await res.text();
      let parsed: any;
      try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 300) }; }
      if (!res.ok || parsed?.ok === false) {
        console.error(`[crm_mover_para] falhou (${res.status}):`, JSON.stringify(parsed).slice(0, 300));
        return { ok: false, error: parsed?.error || `Falha ao mover lead (HTTP ${res.status})` };
      }
      return { ok: true, action: parsed.action };
    } catch (e: any) {
      console.error("[crm_mover_para] erro de rede:", e?.message);
      return { ok: false, error: e?.message || "Falha de rede ao mover lead no CRM." };
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
      return executeTrinksTool(tenant, toolCall, phoneNumber, opts?.sessionState);
    case "onebeleza":
      return executeOneBelezaTool(tenant, toolCall, phoneNumber, opts?.sessionState);
    case "frizzar":
      return executeFrizzarTool(tenant, toolCall, phoneNumber, opts?.sessionState);
    case "bemp":
      return executeBempTool(tenant, toolCall, phoneNumber, opts?.sessionState);
    case "appbarber":
      return executeAppBarberTool(tenant, toolCall, phoneNumber, opts?.sessionState);
    case "none":
      return executeNoneTool(tenant, toolCall);
    default:
      return executeTrinksTool(tenant, toolCall, phoneNumber, opts?.sessionState);
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

async function postChatLabel(
  uazapiUrl: string,
  uazapiToken: string,
  phoneNumber: string,
  labelId: string,
  shouldBePresent: boolean,
  logContext: string,
): Promise<{ res: Response; payload: any }> {
  // UAZAPI /chat/labels accepts the phone in `number` plus exactly one
  // operation field. Do not send chatId/labelId/action: that is a different
  // contract and the provider rejects it with "Use only one operation".
  const labelBody = shouldBePresent
    ? { number: digitsOnly(phoneNumber), add_labelid: String(labelId) }
    : { number: digitsOnly(phoneNumber), remove_labelid: String(labelId) };

  console.log(`[${logContext}] Label ${shouldBePresent ? "ADD" : "REMOVE"} attempt: POST /chat/labels`, JSON.stringify(labelBody));

  const res = await fetch(`${uazapiUrl}/chat/labels`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "token": uazapiToken },
    body: JSON.stringify(labelBody),
  });
  const payload = await readResponsePayload(res);
  console.log(`[${logContext}] Label result status: ${res.status} body:`, JSON.stringify(payload).slice(0, 300));
  return { res, payload };
}

async function ensureChatLabelState(
  uazapiUrl: string,
  uazapiToken: string,
  phoneNumber: string,
  labelId: string,
  desiredState: "present" | "absent",
  logContext: string,
  labelNameHint?: string | null,
): Promise<EnsureLabelStateResult> {
  const shouldBePresent = desiredState === "present";
  const canonicalLabelId = normalizeWhatsAppLabelId(labelId) || String(labelId);

  const getChatLabelState = async (): Promise<{ reached: boolean; labelIds: string[]; chatIds: string[] } | null> => {
    try {
      const { response, payload } = await fetchUazChatDetails(uazapiUrl, uazapiToken, phoneNumber);
      if (!response.ok) return null;
      const labelIds = extractWhatsAppLabelIds(payload);
      const isPresent = labelIds.includes(canonicalLabelId);
      const chatIds = [payload?.wa_chatlid, payload?.wa_chatid, payload?.id, `${digitsOnly(phoneNumber)}@s.whatsapp.net`]
        .map((value) => String(value ?? "").trim())
        .filter((value) => value.includes("@"));
      return { reached: shouldBePresent ? isPresent : !isPresent, labelIds, chatIds: [...new Set(chatIds)] };
    } catch (error) {
      console.warn(`[${logContext}] Could not read current label state:`, error);
      return null;
    }
  };

  const desiredStateReached = async (targetLabelId = canonicalLabelId): Promise<boolean> => {
    try {
      const { response, payload } = await fetchUazChatDetails(uazapiUrl, uazapiToken, phoneNumber);
      if (!response.ok) return false;
      const normalizedTargetId = normalizeWhatsAppLabelId(targetLabelId) || targetLabelId;
      const isPresent = extractWhatsAppLabelIds(payload).includes(normalizedTargetId);
      return shouldBePresent ? isPresent : !isPresent;
    } catch (error) {
      console.warn(`[${logContext}] Could not verify label state after provider error:`, error);
      return false;
    }
  };

  // Avoid calling UAZAPI when the chat is already in the requested state. Besides
  // being idempotent, this prevents its known 500 response when adding an existing
  // label (the mutation is unnecessary and must not surface as a tool failure).
  if (await desiredStateReached()) {
    console.log(`[${logContext}] Label ${canonicalLabelId} already ${shouldBePresent ? "present" : "absent"}; skipping mutation`);
    return { success: true, changed: false, already: true };
  }

  await getChatLabelState();

  let { res, payload: resPayload } = await postChatLabel(uazapiUrl, uazapiToken, phoneNumber, canonicalLabelId, shouldBePresent, logContext);

  // UAZAPI can return 500 after applying the mutation. Verify before retrying so a
  // successful label change is not reported as an error or accidentally repeated.
  if (!res.ok && await desiredStateReached()) {
    console.log(`[${logContext}] Provider returned ${res.status}, but label ${canonicalLabelId} reached the desired state`);
    return { success: true, changed: true, already: false, status: res.status, details: resPayload };
  }

  // ===== AUTO-CURA DE ID DE ETIQUETA =====
  // A UAZAPI devolve 500 "Error adding label to/from chat" quando o label_id salvo no
  // Kanban não existe mais na conta (etiqueta recriada no WhatsApp → novo ID).
  // Nesse caso resolvemos o ID atual pelo NOME da etiqueta e tentamos de novo.
  if (!res.ok) {
    try {
      const liveLabels = await fetchUazapiLabels(uazapiUrl, uazapiToken);
      const idExists = liveLabels.some((l) => String(l.id) === canonicalLabelId);
      console.log(`[${logContext}] Label ${canonicalLabelId} exists on account: ${idExists} | available: ${JSON.stringify(liveLabels.map((l) => `${l.rawId}:${l.name}`)).slice(0, 500)}`);

      const norm = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();
      const byId = liveLabels.find((l) => l.id === canonicalLabelId);
      const byName = labelNameHint
        ? (liveLabels.find((l) => norm(l.name) === norm(String(labelNameHint)))
          || liveLabels.find((l) => norm(l.name).startsWith(norm(String(labelNameHint)))))
        : undefined;

      // Candidatos de ID: canônico, ID cru do catálogo (algumas versões da UAZAPI
      // só aceitam o valor prefixado "instancia:29") e o ID resolvido pelo nome.
      const idCandidates = [
        canonicalLabelId,
        byId?.rawId,
        byName?.id,
        byName?.rawId,
      ].filter((v): v is string => !!v && v !== "");
      const uniqueIds = [...new Set(idCandidates)].filter((v) => v !== canonicalLabelId);

      const attempts = [canonicalLabelId, ...uniqueIds];

      for (const attemptId of attempts) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const retry = await postChatLabel(uazapiUrl, uazapiToken, phoneNumber, attemptId, shouldBePresent, `${logContext}:retry`);
        res = retry.res;
        resPayload = retry.payload;
        if (res.ok || await desiredStateReached(attemptId)) {
          return {
            success: true,
            changed: true,
            already: false,
            status: res.status,
            details: { ...(resPayload && typeof resPayload === "object" ? resPayload : {}), resolved_label_id: attemptId },
          };
        }
      }
    } catch (e) {
      console.error(`[${logContext}] Label self-heal failed:`, e);
    }
  }


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

  console.log(`[${logContext}] Label ${canonicalLabelId} ${shouldBePresent ? "added" : "removed"} successfully`);
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
        const delay = typingDelayMs(text);
        await uazapiTypingPresence(uazapiUrl, uazapiToken, phoneNumber, delay);
        const res = await fetch(`${uazapiUrl}/send/text`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json", "token": uazapiToken },
          body: JSON.stringify({ number: phoneNumber, text, delay, readchat: true }),
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
        const sbEscalate = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
        const extractSentMessageId = (payload: any): string | null => {
          if (!payload || typeof payload !== "object") return null;
          return payload?.messageid || payload?.id || payload?.message?.id || payload?.messages?.[0]?.id || null;
        };

        const silentMode = config.silent_mode === true;
        if (!silentMode) {
          const clientText = config.text || "Vou transferir você para um atendente. Aguarde um momento! 🙋";
          try {
            const delay = typingDelayMs(clientText);
            await uazapiTypingPresence(uazapiUrl, uazapiToken, phoneNumber, delay);
            const clientRes = await fetch(`${uazapiUrl}/send/text`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "Accept": "application/json", "token": uazapiToken },
              body: JSON.stringify({ number: phoneNumber, text: clientText, delay, readchat: true }),
            });
            const clientData = await readResponsePayload(clientRes);
            const clientMsgId = extractSentMessageId(clientData);
            // Persistir mensagem enviada ao cliente (conta como saída da IA p/ métrica Meta)
            try {
              await sbEscalate.from("chat_messages").insert({
                tenant_id: tenant.id,
                phone_number: phoneNumber,
                role: "assistant",
                content: clientText,
                message_id: clientMsgId,
                processed: true,
              });
            } catch (persistErr: any) {
              console.error("[EscalateHuman] persist client msg error:", persistErr?.message || persistErr);
            }
          } catch (e: any) {
            console.error("[EscalateHuman] send client msg error:", e?.message || e);
          }
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

          try {
            const humanRes = await fetch(`${uazapiUrl}/send/text`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "Accept": "application/json", "token": uazapiToken },
              body: JSON.stringify({ number: humanNumber, text: summaryText, delay: 1000 }),
            });
            const humanData = await readResponsePayload(humanRes);
            const humanMsgId = extractSentMessageId(humanData);
            // Persistir mensagem enviada ao atendente humano (conta como saída da IA p/ métrica Meta)
            try {
              await sbEscalate.from("chat_messages").insert({
                tenant_id: tenant.id,
                phone_number: humanNumber,
                role: "assistant",
                content: summaryText,
                message_id: humanMsgId,
                processed: true,
              });
            } catch (persistErr: any) {
              console.error("[EscalateHuman] persist human msg error:", persistErr?.message || persistErr);
            }
            console.log(`[EscalateHuman] Summary sent to human ${humanNumber}`);
          } catch (e: any) {
            console.error("[EscalateHuman] send human msg error:", e?.message || e);
          }
        }

        const labelId = config.label_id;
        if (labelId) {
          try {
            const labelResult = await ensureChatLabelState(uazapiUrl, uazapiToken, phoneNumber, String(labelId), "present", "EscalateHuman", config.label_name || toolDef.display_name || toolDef.name);
            if (!labelResult.success) {
              console.error(`[EscalateHuman] Error ensuring label ${labelId}: ${labelResult.error}`, JSON.stringify(labelResult.details ?? null).slice(0, 200));
              return {
                success: false,
                error: labelResult.error || "Atendimento avisado, mas não foi possível aplicar a etiqueta IA OFF.",
                status: labelResult.status,
                details: labelResult.details,
                type: toolType,
              };
            } else {
              console.log(`[EscalateHuman] Label ${labelId} ensured present (${labelResult.already ? "already present" : "changed"})`);
              // CRM upsert
              await upsertCrmLead(sbEscalate, tenant.id, phoneNumber, String(labelId), "Escalado Humano", "ai");
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
          const labelResult = await ensureChatLabelState(uazapiUrl, uazapiToken, phoneNumber, String(labelId), "present", `CustomTool:add_label:${labelId}`, config.label_name || toolDef.display_name || toolDef.name);
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
          const labelResult = await ensureChatLabelState(uazapiUrl, uazapiToken, phoneNumber, String(labelId), "absent", `CustomTool:remove_label:${labelId}`, config.label_name || toolDef.display_name || toolDef.name);
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

        // Presença: só áudio mostra "gravando áudio..." (delay). Imagem/vídeo/documento
        // vão sem delay — não faz sentido "digitando" nem "gravando" pra mídia.
        const sendPayload: any = {
          number: phoneNumber,
          type: mediaType,
          file: mediaUrl,
          delay: 0,
        };

        if (config.caption) sendPayload.caption = config.caption;
        // Áudio: presença "gravando áudio..." antes do envio.
        if (toolType === "send_audio") {
          sendPayload.delay = 3500;
          await uazapiTypingPresence(uazapiUrl, uazapiToken, phoneNumber, 3500, "recording");
        }

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
              const delay = typingDelayMs(itemConfig.text);
              await uazapiTypingPresence(uazapiUrl, uazapiToken, phoneNumber, delay);
              res = await fetch(`${uazapiUrl}/send/text`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Accept": "application/json", "token": uazapiToken },
                body: JSON.stringify({ number: phoneNumber, text: itemConfig.text, delay, readchat: true }),
              });
              break;
            }
            case "image":
            case "audio":
            case "video":
            case "document": {
              if (!itemConfig.url) { results.push({ type: itemType, skipped: true }); continue; }
              const mediaType = itemType === "audio" ? "ptt" : itemType === "video" ? "video" : itemType === "image" ? "image" : "document";
              sendPayload = { number: phoneNumber, type: mediaType, file: itemConfig.url, delay: 0 };
              if (itemConfig.caption) sendPayload.caption = itemConfig.caption;
              if (itemType === "audio") {
                sendPayload.delay = 3500;
                await uazapiTypingPresence(uazapiUrl, uazapiToken, phoneNumber, 3500, "recording");
              }
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

// (normalizePhoneForTrinks removido — não era usado em lugar nenhum)


function isAffirmativeReply(value: string): boolean {
  const raw = value.trim();
  if (["👍", "👍🏻", "👍🏼", "👍🏽", "👍🏾", "👍🏿", "✅"].includes(raw)) return true;

  const normalized = normalizeUserFacingText(raw);
  if (!normalized) return false;

  return /^(sim|s|ok|okay|pode|pode sim|pode ser|pode confirmar|confirmo|confirmo sim|confirmado|positivo|isso|isso mesmo|certo|beleza|perfeito|fechado|combinado|show|tranquilo|sim pode|pode cancelar|sim pode cancelar)$/.test(normalized);
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
  return /\b(posso confirmar|posso marcar|posso reservar|quer confirmar|quer que eu confirme|quer que eu marque|quer que eu reserve|confirmo pra voce|confirmo para voce|vou confirmar|vou marcar|vou reservar|fecho pra voce|fecho para voce|fechar esse horario|confirmar esse horario|pode ser esse horario|pode ser esse horario pro|pode ser esse horario para|pode ser esse|esse horario serve|serve esse horario|fechou nesse horario|confirmando)\b/.test(normalized);
}

// isSingleCancellationConfirmationPrompt e maybeHandleDirectCancellationConfirmation
// foram movidos para providers/trinks/index.ts (atalho de cancelamento é Trinks-only).

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
  globalPromptOverride?: string | null,
): string {
  const br = getBrasiliaDate();
  const dateComplete = br.dateComplete;
  const todayName = br.todayName;
  const todayDate = br.todayDate;
  const customPrompt = tenant.agent_system_prompt || "";

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

  const humanAttendantBlock = `\n## 🧑‍💼 MENSAGENS DO ATENDENTE HUMANO\nNo histórico, mensagens com role "assistant" que começam com o prefixo \`[ATENDENTE HUMANO]:\` foram enviadas MANUALMENTE pelo dono/atendente da empresa (pelo app ou direto pelo WhatsApp), NÃO por você.\n\nRegras quando isso aparece:\n- Trate o conteúdo como contexto verdadeiro e já realizado pelo humano (ex: confirmações, avisos, combinados).\n- NÃO repita ações que o humano já fez. Ex: se o atendente humano enviou "Confirma seu agendamento de hoje 19h?" e o cliente respondeu "Sim", você NÃO deve criar um novo agendamento — apenas continue a conversa naturalmente (ex: "Perfeito, te esperamos!").\n- Antes de chamar qualquer ferramenta de criar/cancelar/editar agendamento, verifique se o atendente humano já tratou o assunto na conversa recente.\n- Mensagens "assistant" SEM esse prefixo foram enviadas por você (IA) — pode considerar como suas.\n\n🚨🚨 REGRA CRÍTICA — RESPOSTA CURTA DO CLIENTE A UMA PERGUNTA DO ATENDENTE HUMANO:\nSe a ÚLTIMA mensagem \`assistant\` no histórico é \`[ATENDENTE HUMANO]:\` E a mensagem atual do cliente é uma resposta curta ("sim", "ok", "confirmo", "pode ser", "isso", "👍", "não", "pode confirmar", "confirmado" etc.), você DEVE interpretá-la como resposta DIRETA àquela mensagem do atendente humano. NUNCA ignore o contexto tratando como início de conversa novo.\n\nEspecialmente para MENSAGENS DE CONFIRMAÇÃO DE AGENDAMENTO enviadas pelo atendente/sistema (ex: "Você tem agendado X no dia DD/MM HH:MM com Fulano. Posso confirmar seu horário?"):\n- Cliente respondeu SIM/OK/CONFIRMO/POSITIVO → agradeça e encerre naturalmente. Ex: "Perfeito, Kevin! Seu horário está confirmado para <dia> às <hora> com <profissional>. Te esperamos! 💈"\n- Cliente respondeu NÃO/NÃO POSSO/CANCELA → pergunte se quer remarcar ou cancelar, e siga o fluxo apropriado.\n- Cliente respondeu com nova data/hora → siga o fluxo de remarcação.\n- É PROIBIDO responder "Como posso te ajudar?", "Bom dia!", "Em que posso ajudar hoje?" ou qualquer abertura genérica ignorando a confirmação pendente. Isso é ERRO GRAVE.\n- É PROIBIDO chamar qualquer ferramenta de criar/editar agendamento nesse caso — o agendamento já existe, o cliente só está confirmando.\n\n🚨 PROIBIDO TERMINANTEMENTE: NUNCA, em hipótese alguma, inclua na sua resposta ao cliente os marcadores internos \`[ATENDENTE HUMANO]\`, \`[ATENDENTE HUMANO]:\`, \`[SISTEMA]\`, \`[SYSTEM]\`, \`[INTERNO]\`, \`[CONTEXTO]\` ou qualquer outro rótulo entre colchetes que apareça no histórico. Esses marcadores são APENAS para SEU uso interno de leitura — o cliente NUNCA deve vê-los. Sua resposta deve ser sempre uma mensagem natural, limpa, sem prefixos técnicos. Se precisar referenciar algo que o atendente humano disse, parafraseie em linguagem natural (ex: "como combinamos", "como te avisamos") — JAMAIS copie o texto com o prefixo.\n\n🚨🚨 PROIBIDO COPIAR/REPRODUZIR O CONTEÚDO DE MENSAGENS [ATENDENTE HUMANO]:\n- NUNCA copie, reescreva ou "imite" o TEXTO de uma mensagem \`[ATENDENTE HUMANO]:\` na sua resposta. Mesmo sem o prefixo, é PROIBIDO reenviar o conteúdo dele.\n- NUNCA envie LEMBRETES DE CONFIRMAÇÃO DE AGENDAMENTO (ex: "Olá Fulano, você possui um agendamento com X em DD/MM às HH:MM" + link). Lembretes/confirmações são responsabilidade do sistema externo do estabelecimento, NÃO sua. Você NUNCA gera esse tipo de mensagem por conta própria.\n- NUNCA reenvie URLs/links de confirmação (ex: cashbarber.com.br/.../confirmacao/...) que tenham aparecido no histórico. Esses links são únicos por agendamento e foram enviados pelo humano/sistema — repetir é ERRO GRAVE.\n- NUNCA reenvie nomes de profissionais, horários ou valores que você só conhece porque viu numa mensagem \`[ATENDENTE HUMANO]:\` anterior — esses dados podem estar desatualizados. EXCEÇÃO: quando o cliente está CONFIRMANDO um agendamento que o atendente acabou de enviar (regra acima), você PODE — e DEVE — mencionar os dados (data/hora/profissional) daquela mensagem específica para fechar a confirmação com clareza.\n- Você só envia UMA resposta por vez, focada na ÚLTIMA mensagem do cliente. NÃO concatene várias "mensagens fantasma" copiando frases curtas do histórico do atendente (ex: "👍🏻", "Eu que agradeço", "Boa tarde", "😉"). Se a resposta natural é curta, mande curta.\n- Se você não tem informação NOVA e legítima a enviar agora, responda apenas o necessário à última mensagem do cliente — NUNCA "complete" com trechos que pareçam plausíveis tirados do histórico.\n`;

  const existingBookingLookupBlock = `\n## 🔍 REAFIRMAR AGENDAMENTO EXISTENTE (criado FORA da IA)\nQuando o cliente fala sobre um agendamento que você NÃO criou nesta conversa (ex: "vou atrasar", "posso chegar mais cedo?", "confirma meu horário de amanhã?"), ANTES de reafirmar ou orientar, chame a ferramenta de busca de agendamento apropriada do provider na MESMA rodada (buscar_agendamento / buscar_agendamentos / buscar_agendamentos_dia / listar_agendamentos, conforme o provider) e use SÓ os dados que voltarem.\n\n- Se a busca trouxer o agendamento → responda normalmente (ex: "tranquilo, te esperamos até HH:MM").\n- Se a busca vier vazia → diga isso com clareza ("não achei nenhum agendamento ativo em <data>, pode confirmar comigo?") — NUNCA invente confirmação de algo que não apareceu na busca.\n- NUNCA reafirme horário/data que você só viu em mensagem antiga do histórico sem confirmar na busca desta rodada.\n`;

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
As informações acima (hora atual, período do dia, data, dia da semana, saudação adequada) são CONTEXTO INTERNO PARA VOCÊ — NÃO são roteiro de mensagem (ver também regra de horário de funcionamento no bloco de regras globais).
- Comparação interna: se AGORA < fechamento de hoje → ainda está aberto. Se cliente pedir horário FUTURO de hoje, só recuse se for DEPOIS do fechamento.
- Se o "Status da sessão" for 🆕 NOVA SESSÃO, releia o histórico (cada mensagem traz prefixo \`[DD/MM HH:MM]\`) e siga a "REGRA GLOBAL — VIRADA DE DIA / CONVERSA ANTIGA" antes de assumir que "amanhã"/"hoje" antigos do cliente ainda valem.



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
${existingBookingLookupBlock}
${(typeof globalPromptOverride === "string" && globalPromptOverride.trim().length > 0) ? globalPromptOverride : buildGlobalPromptSection(tenant)}
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
  } else if (provider === "appbarber") {
    providerPrompt = buildAppBarberPromptSection(tenant);
  } else if (provider === "none") {
    providerPrompt = buildNonePromptSection(tenant);
  }

  const customSection = customPrompt ? `\nINSTRUÇÕES ADICIONAIS DO ESTABELECIMENTO:\n${customPrompt}` : "";

  // Inject custom tools instructions
  const enabledCustomTools = getEnabledCustomTools(tenant);
  let customToolsSection = "";
  if (enabledCustomTools.length > 0) {
    const toolInstructions = enabledCustomTools.map((ct: any) =>
      `- **${ct.display_name}** (ferramenta: ${ct.name}): ${ct.prompt_instruction}`
    ).join("\n");
    customToolsSection = `\n\n------------------------------------------\n\n## 🔧 FERRAMENTAS CUSTOMIZADAS\n\nVocê tem acesso às seguintes ferramentas extras. Use conforme as instruções:\n\n${toolInstructions}\n\n⚠️ Quando usar uma ferramenta customizada, a mensagem/mídia será enviada DIRETAMENTE ao cliente. Após executar, confirme ao cliente que enviou (ex: "Enviei a localização!" ou "Mandei a chave PIX!"). NÃO repita o conteúdo da ferramenta na mensagem de texto.`;
  }

  // Instrução sobre as ferramentas de mover lead pelo funil do CRM externo
  // (uma ferramenta por etapa, geradas em buildToolsForProvider). Sem essa
  // seção explícita, o modelo depende só da description de cada tool para
  // decidir usar — funciona, mas fica mais confiável com uma instrução
  // dedicada, no mesmo padrão das ferramentas customizadas acima.
  const crmFunnelsForPrompt: Array<{ funnel_id: string; funnel_name: string; stages: { id: string; name: string }[] }> =
    Array.isArray((tenant as any)?.crm_funnels) ? (tenant as any).crm_funnels : [];
  let crmToolsSection = "";
  if (tenant?.crm_zetta_token && crmFunnelsForPrompt.length > 0) {
    const funnelBlocks = crmFunnelsForPrompt
      .filter((f) => (f.stages || []).length > 0)
      .map((f) => {
        const stageList = (f.stages || [])
          .map((s: { id: string; name: string }) => `  - "${s.name}" (ferramenta: crm_mover_para_${slugifyStageName(s.name)})`)
          .join("\n");
        return `Funil "${f.funnel_name}":\n${stageList}`;
      })
      .join("\n\n");
    crmToolsSection = `\n\n------------------------------------------\n\n## 📋 FUNIS DE VENDAS (CRM)\n\nEste lead está sendo acompanhado no(s) seguinte(s) funil(is), com as respectivas etapas:\n\n${funnelBlocks}\n\nMova o lead para a etapa correta assim que um sinal claro da conversa indicar mudança de estágio (ex: o lead respondeu pela primeira vez, demonstrou interesse, perguntou preço, confirmou, ou desistiu — dependendo do que cada etapa acima representa no seu funil). Mover para uma etapa nova já tira o lead da etapa anterior automaticamente dentro do MESMO funil, não é preciso "remover" antes. Não mova a cada mensagem — só quando o estágio realmente mudar.`;
  }

  // providerPrompt vai por ÚLTIMO para sobrescrever instruções conflitantes do prompt customizado (ex.: tenant que descreve a API em texto cru)
  return basePrompt + "\n\n" + customSection + customToolsSection + crmToolsSection + "\n\n" + providerPrompt;
}

// ===================== TRINKS PROMPT SECTION =====================


// ===================== ONE BELEZA PROMPT SECTION =====================


// ===================== NONE PROMPT SECTION =====================



// (TRINKS TOOLS extraído para providers/trinks/index.ts)

// ===================== ONE BELEZA TOOLS =====================


// ===================== NONE TOOLS =====================

function buildNoneTools(_tenant: any) {
  // Provider "none" não usa ferramentas. O link de agendamento é enviado
  // diretamente no texto da resposta, conforme regra do system prompt.
  return undefined;
}

// (TRINKS TOOL EXECUTION extraído para providers/trinks/index.ts)

// ===================== ONE BELEZA TOOL EXECUTION =====================


// ===================== NONE TOOL EXECUTION =====================

async function executeNoneTool(_tenant: any, toolCall: any): Promise<any> {
  const funcName = toolCall.function.name;
  // Provider "none" não expõe ferramentas. Se a IA tentar chamar algo,
  // devolvemos um erro instruindo-a a responder direto no texto.
  return {
    error: `A ferramenta "${funcName}" não existe neste estabelecimento. Responda diretamente no texto, sem chamar ferramentas.`,
  };
}

// ===================== FRIZZAR =====================
// Extraído para providers/frizzar/index.ts (jul/2026).
// Aqui ficou apenas o import no topo do arquivo — nada de Frizzar mora neste arquivo.


// ===================== BEMP PROVIDER =====================
// Extraído para ./providers/bemp/index.ts em jul/2026 (mesmo padrão Frizzar/AppBarber/Trinks).

// ===================== APPBARBER PROVIDER =====================
// Extraído para ./providers/appbarber/index.ts em jul/2026 (mesmo padrão Frizzar).