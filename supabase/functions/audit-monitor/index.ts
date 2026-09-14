// ============================================================================
// MONITOR 24H — IA auditora do atendimento
// Lê agent_logs (somente leitura, isolado do whatsapp-webhook), compara
// pedido do cliente x resposta final x retorno real das ferramentas e grava
// achados em ai_audit_findings. Todo achado precisa citar evidência real:
// trecho da conversa + trecho do retorno da ferramenta. Sem prova, descarta.
//
// Modelo fixo (gpt-5-mini) via OpenAI direta — mesmo padrão do atendente.
// Sem fallback entre providers: falha vira erro registrado e o turno volta
// para a fila de reprocessamento, nunca troca de modelo em silêncio.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  buildDossier,
  RELEVANT_TOOLS,
  hasRelevantTool,
  hasDetectedGuardSignal,
  claimsCompletedAction,
  silentModeViolation,
  validateFinding,
  findingSignature,
  normalizeForProof,
  SEVERITY_BY_CATEGORY,
  AUDIT_CATEGORIES,
} from "./auditor.ts";
import { getDefaultProviderPrompt } from "../_shared/provider-prompts.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

// Modelo fixo aprovado: o mesmo do agente de atendimento.
const AUDITOR_MODEL = "gpt-5-mini";
const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const MAX_ATTEMPTS = 6;

// Prompt padrão vive em _shared/provider-prompts.ts (provider "auditor") e é
// editável na aba Prompts do painel (tabela provider_prompts).
const DEFAULT_SYSTEM_PROMPT = getDefaultProviderPrompt("auditor");

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          category: { type: "string", enum: AUDIT_CATEGORIES },
          severity: { type: "string", enum: ["baixa", "media", "alta"] },
          summary: { type: "string" },
          evidence_conversation: { type: "string" },
          evidence_tool: { type: "string" },
        },
        required: ["category", "severity", "summary", "evidence_conversation", "evidence_tool"],
      },
    },
  },
  required: ["findings"],
};

type AuditTrace = {
  endpoint: string;
  model_requested: string;
  model_returned?: string | null;
  http_status?: number | null;
  request_id?: string | null;
  duration_ms?: number;
  usage?: unknown;
  attempts?: number;
};

class AuditCallError extends Error {
  status: number;
  retryable: boolean;
  circuitBreaker: boolean;
  trace: AuditTrace;
  constructor(message: string, opts: { status: number; retryable: boolean; circuitBreaker: boolean; trace: AuditTrace }) {
    super(message);
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.circuitBreaker = opts.circuitBreaker;
    this.trace = opts.trace;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callOpenAIOnce(dossier: string, apiKey: string, systemPrompt: string, attempt: number) {
  const started = Date.now();
  const trace: AuditTrace = { endpoint: OPENAI_ENDPOINT, model_requested: AUDITOR_MODEL, attempts: attempt };
  let res: Response;
  try {
    res = await fetch(OPENAI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: AUDITOR_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: dossier },
        ],
        response_format: { type: "json_schema", json_schema: { name: "auditoria", strict: true, schema: RESPONSE_SCHEMA } },
        reasoning_effort: "low",
        max_completion_tokens: 4000,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
  } catch (e) {
    trace.duration_ms = Date.now() - started;
    throw new AuditCallError(`rede: ${String((e as Error).message ?? e).slice(0, 300)}`, {
      status: 0, retryable: true, circuitBreaker: false, trace,
    });
  }

  trace.http_status = res.status;
  trace.request_id = res.headers.get("x-request-id");
  trace.duration_ms = Date.now() - started;

  if (!res.ok) {
    const body = await res.text();
    const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
    // 401/402/403 = crédito/configuração: para a cadeia inteira, não adianta
    // tentar o próximo turno — o mesmo erro se repetiria.
    const circuitBreaker = res.status === 401 || res.status === 402 || res.status === 403;
    const retryAfter = res.headers.get("retry-after");
    throw new AuditCallError(`openai ${res.status}: ${body.slice(0, 400)}`, {
      status: res.status, retryable, circuitBreaker,
      trace: { ...trace, retry_after: retryAfter } as AuditTrace,
    });
  }

  // SSE (chat completions): acumula o texto final; resposta de uma chamada só.
  let text = "";
  let modelReturned: string | null = null;
  let usage: unknown = null;
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const evt of events) {
      for (const line of evt.split("\n").filter((l) => l.startsWith("data:"))) {
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const parsed = JSON.parse(payload);
          if (typeof parsed?.model === "string") modelReturned = parsed.model;
          if (parsed?.usage) usage = parsed.usage;
          const delta = parsed?.choices?.[0]?.delta?.content;
          if (typeof delta === "string") text += delta;
          const finish = parsed?.choices?.[0]?.finish_reason;
          if (finish === "length") throw new Error("resposta truncada por limite de tokens");
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
    }
  }
  trace.model_returned = modelReturned;
  trace.usage = usage;
  trace.duration_ms = Date.now() - started;

  // Resposta vazia não é "sem achados": é falha da chamada e deve ir para a fila.
  if (!text.trim()) {
    throw new AuditCallError("resposta vazia da auditora (stream sem conteúdo)", {
      status: 200, retryable: true, circuitBreaker: false, trace,
    });
  }

  let parsed: any = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AuditCallError("resposta da auditora não era JSON válido", {
      status: 200, retryable: true, circuitBreaker: false, trace,
    });
  }
  if (!Array.isArray(parsed.findings)) {
    throw new AuditCallError("resposta da auditora sem o campo findings", {
      status: 200, retryable: true, circuitBreaker: false, trace,
    });
  }
  return { findings: parsed.findings as any[], trace };
}

async function auditOneTurn(dossier: string, apiKey: string, systemPrompt: string) {
  const maxAttempts = 3;
  let lastError: AuditCallError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await callOpenAIOnce(dossier, apiKey, systemPrompt, attempt);
    } catch (e) {
      if (!(e instanceof AuditCallError)) throw e;
      lastError = e;
      if (e.circuitBreaker || !e.retryable || attempt === maxAttempts) break;
      const retryAfterSec = Number((e.trace as any)?.retry_after ?? 0);
      const waitMs = retryAfterSec > 0 ? retryAfterSec * 1000 : Math.min(2000 * 2 ** (attempt - 1), 15000);
      await sleep(waitMs);
    }
  }
  throw lastError;
}

function nextRetryDelayMs(attempts: number, circuitBreaker: boolean): number {
  if (circuitBreaker) return 30 * 60_000; // crédito/config: re-tenta em 30 min
  return Math.min(2 ** attempts * 60_000, 60 * 60_000); // backoff exponencial, teto 1h
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const cronSecret = Deno.env.get("CRON_SECRET");
  const apiKey = Deno.env.get("OPENAI_API_KEY");

  // ===== Auth fail-closed: cron secret, service-role, ou admin autenticado =====
  const providedSecret = req.headers.get("x-cron-secret");
  const authHeader = req.headers.get("Authorization") || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  let authorized = Boolean(cronSecret && providedSecret && providedSecret === cronSecret);
  if (!authorized && bearer && bearer === serviceRoleKey) authorized = true;
  // Token interno do agendador (guardado no banco, nunca exposto em código nem chat)
  if (!authorized && providedSecret) {
    const asService = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
    const { data: internalToken } = await asService.rpc("get_internal_cron_token");
    if (typeof internalToken === "string" && providedSecret === internalToken) authorized = true;
  }
  if (!authorized && bearer) {
    const asUser = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData } = await asUser.auth.getUser();
    if (userData?.user) {
      const userId = userData.user.id;
      const asService = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
      const { data: roleRows } = await asService.from("user_roles").select("role").eq("user_id", userId);
      const roles = new Set((roleRows || []).map((r: any) => r.role));
      if (roles.has("admin")) {
        authorized = true;
      } else if (roles.has("staff")) {
        // Colaborador só entra se tiver o módulo "ai-monitor" liberado
        const { data: mod } = await asService
          .from("staff_module_access")
          .select("module")
          .eq("user_id", userId)
          .eq("module", "ai-monitor")
          .maybeSingle();
        if (mod) authorized = true;
      }
    }
  }
  if (!authorized) return json({ error: "Unauthorized" }, 401);
  if (!apiKey) return json({ error: "OPENAI_API_KEY ausente" }, 500);

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  let body: any = {};
  try {
    body = await req.json();
  } catch { /* cron manda body simples */ }

  const explicitLogIds: string[] = Array.isArray(body?.log_ids) ? body.log_ids.filter((x: unknown) => typeof x === "string") : [];
  const tenantFilter: string | null = typeof body?.tenant_id === "string" ? body.tenant_id : null;
  const lookbackMinutes = Number.isFinite(body?.lookback_minutes) ? Math.min(Number(body.lookback_minutes), 60 * 24 * 7) : 360;
  const limit = Number.isFinite(body?.limit) ? Math.min(Math.max(Number(body.limit), 1), 40) : 15;
  const dryRun = body?.dry_run === true;

  // Prompt editado na aba Prompts (provider "auditor") vence o padrão do código.
  let systemPrompt = DEFAULT_SYSTEM_PROMPT;
  {
    const { data: promptRow } = await supabase
      .from("provider_prompts")
      .select("content")
      .eq("provider", "auditor")
      .maybeSingle();
    const override = typeof promptRow?.content === "string" ? promptRow.content.trim() : "";
    if (override.length > 200) systemPrompt = override;
  }

  try {
    // ===== Tenants elegíveis =====
    let tenantQuery = supabase
      .from("tenants")
      .select("id, name, api_provider, agent_settings, archived")
      .eq("archived", false);
    if (tenantFilter) tenantQuery = tenantQuery.eq("id", tenantFilter);
    const { data: tenants, error: tErr } = await tenantQuery;
    if (tErr) throw tErr;

    const eligible = (tenants ?? []).filter((t: any) => {
      if (tenantFilter || explicitLogIds.length) return true; // execução manual/validação
      const enabled = (t.agent_settings ?? {})?.ai_monitor_enabled;
      return enabled === true || enabled === "true";
    });
    if (!eligible.length) return json({ audited: 0, skipped: 0, issues: 0, reason: "nenhuma empresa com monitor ativo" });

    const providerById = new Map(eligible.map((t: any) => [t.id, t.api_provider]));
    const tenantIds = eligible.map((t: any) => t.id);

    // ===== Fila de reprocessamento: erros anteriores voltam primeiro =====
    const nowIso = new Date().toISOString();
    const previousAttempts = new Map<string, number>();
    let retryIds: string[] = [];
    if (!explicitLogIds.length) {
      const { data: errored } = await supabase
        .from("ai_audit_runs")
        .select("agent_log_id, attempts")
        .in("tenant_id", tenantIds)
        .eq("status", "error")
        .lt("attempts", MAX_ATTEMPTS)
        .or(`next_retry_at.is.null,next_retry_at.lte.${nowIso}`)
        .order("created_at", { ascending: true })
        .limit(limit);
      retryIds = (errored ?? []).map((r: any) => r.agent_log_id);
      for (const r of errored ?? []) previousAttempts.set(r.agent_log_id, Number(r.attempts ?? 1));
    }

    // ===== Atendimentos candidatos =====
    let logs: any[] = [];
    if (explicitLogIds.length) {
      const { data, error } = await supabase
        .from("agent_logs")
        .select("id, tenant_id, phone_number, user_message, ai_response, tool_calls, errors, created_at")
        .in("id", explicitLogIds);
      if (error) throw error;
      logs = data ?? [];
    } else {
      const byId = new Map<string, any>();
      if (retryIds.length) {
        const { data: retryLogs, error: rErr } = await supabase
          .from("agent_logs")
          .select("id, tenant_id, phone_number, user_message, ai_response, tool_calls, errors, created_at")
          .in("id", retryIds);
        if (rErr) throw rErr;
        for (const l of retryLogs ?? []) byId.set(l.id, l);
      }
      const { data: freshLogs, error: lErr } = await supabase
        .from("agent_logs")
        .select("id, tenant_id, phone_number, user_message, ai_response, tool_calls, errors, created_at")
        .in("tenant_id", tenantIds)
        .gte("created_at", new Date(Date.now() - lookbackMinutes * 60_000).toISOString())
        .order("created_at", { ascending: false })
        .limit(limit * 6);
      if (lErr) throw lErr;
      for (const l of freshLogs ?? []) if (!byId.has(l.id)) byId.set(l.id, l);
      // Reprocessa os mais antigos primeiro (fila), depois os frescos.
      logs = [...byId.values()].sort((a, b) => {
        const ar = previousAttempts.has(a.id) ? 0 : 1;
        const br = previousAttempts.has(b.id) ? 0 : 1;
        if (ar !== br) return ar - br;
        return String(a.created_at).localeCompare(String(b.created_at));
      });
    }

    const candidateIds = logs.map((l: any) => l.id);
    const { data: alreadyRun } = candidateIds.length
      ? await supabase.from("ai_audit_runs").select("agent_log_id, status").in("agent_log_id", candidateIds)
      : { data: [] as any[] };
    // Só "error" volta para a fila; audited/skipped não reprocessam sozinhos.
    // Execução manual por IDs força nova auditoria mesmo de turnos já concluídos.
    const done = new Set(
      explicitLogIds.length
        ? []
        : (alreadyRun ?? [])
            .filter((r: any) => r.status !== "error")
            .map((r: any) => r.agent_log_id),
    );

    let audited = 0;
    let skipped = 0;
    let issues = 0;
    let circuitTripped = false;
    const results: any[] = [];

    for (const log of logs) {
      if (audited >= limit) break;
      if (circuitTripped) break;
      if (done.has(log.id)) continue;

      const toolCalls = Array.isArray(log.tool_calls) ? log.tool_calls : [];

      // R1 (determinística, sem LLM): escalação silenciosa + resposta ao cliente.
      const silent = silentModeViolation(toolCalls, log.ai_response);

      const mustAudit =
        hasRelevantTool(toolCalls) ||
        hasDetectedGuardSignal(toolCalls) || // R3: guard "detected_*" nunca é pulado
        claimsCompletedAction(log.ai_response); // R2: afirmou ação concluída

      if (!mustAudit && !silent.violated) {
        skipped++;
        if (!dryRun) {
          await supabase.from("ai_audit_runs").upsert(
            {
              tenant_id: log.tenant_id,
              agent_log_id: log.id,
              provider: providerById.get(log.tenant_id) ?? null,
              phone_number: log.phone_number,
              status: "skipped_no_tools",
              turn_at: log.created_at,
            },
            { onConflict: "agent_log_id" },
          );
        }
        continue;
      }

      // Contexto da conversa imediatamente anterior ao turno
      const { data: history } = await supabase
        .from("chat_messages")
        .select("role, content, created_at")
        .eq("tenant_id", log.tenant_id)
        .eq("phone_number", log.phone_number)
        .lte("created_at", log.created_at)
        .order("created_at", { ascending: false })
        .limit(14);

      // Reação do cliente depois da resposta — prova real de atendimento incompleto
      const { data: afterRaw } = await supabase
        .from("chat_messages")
        .select("role, content, created_at")
        .eq("tenant_id", log.tenant_id)
        .eq("phone_number", log.phone_number)
        .gt("created_at", log.created_at)
        .order("created_at", { ascending: true })
        .limit(4);

      const { dossier, conversationText, toolText, timeReference } = buildDossier(
        log,
        (history ?? []).slice().reverse(),
        toolCalls,
        afterRaw ?? [],
      );

      // Achados já reportados nesta conversa (14 dias) — não repetir o mesmo
      // problema só porque a conversa seguiu em outros turnos.
      const { data: priorFindings } = await supabase
        .from("ai_audit_findings")
        .select("category, summary, evidence_tool, evidence_conversation")
        .eq("tenant_id", log.tenant_id)
        .eq("phone_number", log.phone_number)
        .gte("created_at", new Date(Date.now() - 14 * 24 * 60 * 60_000).toISOString())
        .limit(200);
      const seenSignatures = new Set((priorFindings ?? []).map((f: any) => findingSignature(f)));

      const deterministicFindings: any[] = [];
      if (silent.violated) {
        const det = {
          category: "violacao_silent_mode",
          severity: SEVERITY_BY_CATEGORY["violacao_silent_mode"],
          summary: "A ferramenta de escalação retornou modo silencioso (proibido enviar mensagem) e a IA respondeu ao cliente mesmo assim.",
          evidence_conversation: String(log.ai_response ?? "").slice(0, 2000),
          evidence_tool: silent.evidence,
        };
        const sig = findingSignature(det);
        if (!seenSignatures.has(sig)) {
          seenSignatures.add(sig);
          deterministicFindings.push(det);
        }
      }

      let rawFindings: any[] = [];
      let errorMessage: string | null = null;
      let trace: AuditTrace | null = null;
      // Turno resolvido 100% em código (só violação de silent_mode, sem nada
      // mais a auditar) não gasta chamada de modelo.
      const needsModel = mustAudit;
      if (needsModel) {
        try {
          const out = await auditOneTurn(dossier, apiKey, systemPrompt);
          rawFindings = out.findings;
          trace = out.trace;
        } catch (e) {
          if (e instanceof AuditCallError) {
            trace = e.trace;
            if (e.circuitBreaker) circuitTripped = true;
          }
          errorMessage = String((e as Error).message ?? e).slice(0, 500);
        }
      }

      const auditContext = { aiResponse: log.ai_response, toolCalls, timeReference };
      const accepted: any[] = [...deterministicFindings];
      let discarded = 0;
      const discardedDetails: any[] = [];
      // Mesmo fato (mesmo trecho de conversa) não pode virar dois achados em
      // categorias diferentes: fica só o de maior severidade.
      const factRank: Record<string, number> = { alta: 3, media: 2, baixa: 1 };
      const byFact = new Map<string, any>();
      for (const f of rawFindings) {
        const reason = validateFinding(f, conversationText, toolText, auditContext);
        if (reason) {
          discarded++;
          discardedDetails.push({ category: f?.category ?? null, summary: String(f?.summary ?? "").slice(0, 300), reason });
          continue;
        }
        const sig = findingSignature(f);
        if (seenSignatures.has(sig)) {
          discarded++;
          discardedDetails.push({ category: f.category, summary: String(f.summary).slice(0, 300), reason: "duplicado" });
          continue;
        }
        seenSignatures.add(sig);
        // Severidade determinística por categoria (o modelo não decide).
        f.severity = SEVERITY_BY_CATEGORY[String(f.category)] ?? f.severity ?? "media";
        const fact = normalizeForProof(String(f.evidence_conversation ?? "")).slice(0, 120);
        const current = byFact.get(fact);
        if (current) {
          discarded++;
          discardedDetails.push({ category: f.category, summary: String(f.summary).slice(0, 300), reason: "mesmo_fato" });
          if ((factRank[f.severity] ?? 0) > (factRank[current.severity] ?? 0)) byFact.set(fact, f);
          continue;
        }
        byFact.set(fact, f);
      }
      accepted.push(...byFact.values());

      audited++;
      issues += accepted.length;
      results.push({
        agent_log_id: log.id,
        tenant_id: log.tenant_id,
        phone_number: log.phone_number,
        at: log.created_at,
        error: errorMessage,
        deterministic: deterministicFindings.length,
        accepted: accepted.map((f) => ({ category: f.category, severity: f.severity, summary: f.summary })),
        discarded,
      });

      if (dryRun) continue;

      // ===== Persistência: falha ao gravar achados NÃO pode marcar "audited" =====
      if (!errorMessage && accepted.length) {
        const { error: fErr } = await supabase.from("ai_audit_findings").insert(
          accepted.map((f) => ({
            tenant_id: log.tenant_id,
            agent_log_id: log.id,
            provider: providerById.get(log.tenant_id) ?? null,
            phone_number: log.phone_number,
            category: f.category,
            severity: f.severity,
            summary: String(f.summary).slice(0, 1200),
            evidence_conversation: String(f.evidence_conversation).slice(0, 2000),
            evidence_tool: String(f.evidence_tool).slice(0, 2000),
            tool_names: toolCalls.map((tc: any) => String(tc?.name ?? "")).filter((n: string) => RELEVANT_TOOLS.includes(n)),
            model_used: needsModel ? AUDITOR_MODEL : null,
            turn_at: log.created_at,
          })),
        );
        if (fErr) errorMessage = `falha ao gravar achados: ${String(fErr.message ?? fErr).slice(0, 300)}`;
      }

      const attempts = (previousAttempts.get(log.id) ?? 0) + 1;
      const { error: rErr } = await supabase.from("ai_audit_runs").upsert(
        {
          tenant_id: log.tenant_id,
          agent_log_id: log.id,
          provider: providerById.get(log.tenant_id) ?? null,
          phone_number: log.phone_number,
          status: errorMessage ? "error" : "audited",
          issues_count: accepted.length,
          discarded_count: discarded,
          discarded_details: discardedDetails.length ? discardedDetails : null,
          model_used: needsModel ? AUDITOR_MODEL : null,
          error_message: errorMessage,
          http_trace: trace ?? (needsModel ? null : { deterministic: true }),
          attempts,
          next_retry_at: errorMessage ? new Date(Date.now() + nextRetryDelayMs(attempts, circuitTripped)).toISOString() : null,
          turn_at: log.created_at,
        },
        { onConflict: "agent_log_id" },
      );
      if (rErr) console.error("[audit-monitor] falha ao gravar execução", rErr);
    }

    // ===== Saúde do próprio monitor: 3 erros seguidos geram incidente =====
    let healthAlert = false;
    try {
      const { data: lastRuns } = await supabase
        .from("ai_audit_runs")
        .select("status")
        .order("created_at", { ascending: false })
        .limit(3);
      const threeErrors = (lastRuns ?? []).length === 3 && (lastRuns ?? []).every((r: any) => r.status === "error");
      if (threeErrors && !dryRun) {
        const { data: recentIncident } = await supabase
          .from("audit_logs")
          .select("id")
          .eq("action", "ai_monitor_health_incident")
          .gte("created_at", new Date(Date.now() - 6 * 60 * 60_000).toISOString())
          .limit(1);
        if (!recentIncident?.length) {
          healthAlert = true;
          await supabase.from("audit_logs").insert({
            tenant_id: null,
            user_id: null,
            actor_role: "system",
            action: "ai_monitor_health_incident",
            entity: "ai_audit_runs",
            entity_id: null,
            before: null,
            after: { motivo: "3 execuções consecutivas com erro", ultima_verificacao: nowIso },
          });
        }
      }
    } catch (e) {
      console.error("[audit-monitor] falha ao registrar saúde", e);
    }

    return json({ audited, skipped, issues, retried: retryIds.length, circuit_tripped: circuitTripped, health_alert: healthAlert, dry_run: dryRun, results });
  } catch (e) {
    console.error("[audit-monitor] erro", e);
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
