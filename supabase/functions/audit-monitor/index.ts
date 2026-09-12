// ============================================================================
// MONITOR 24H — IA auditora do atendimento
// Lê agent_logs (somente leitura, isolado do whatsapp-webhook), compara
// pedido do cliente x resposta final x retorno real das ferramentas e grava
// achados em ai_audit_findings. Todo achado precisa citar evidência real:
// trecho da conversa + trecho do retorno da ferramenta. Sem prova, descarta.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { buildDossier, RELEVANT_TOOLS, hasRelevantTool, validateFinding, findingSignature, normalizeForProof, SEVERITY_BY_CATEGORY, AUDIT_CATEGORIES } from "./auditor.ts";
import { getDefaultProviderPrompt } from "../_shared/provider-prompts.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const AUDITOR_MODEL = "openai/gpt-5.4-mini";

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

async function auditOneTurn(dossier: string, apiKey: string, systemPrompt: string) {
  const res = await fetch("https://ai.gateway.lovable.dev/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": apiKey,
      "X-Lovable-AIG-SDK": "fetch",
    },
    body: JSON.stringify({
      model: AUDITOR_MODEL,
      instructions: systemPrompt,
      input: dossier,
      stream: true,
      text: { format: { type: "json_schema", name: "auditoria", strict: true, schema: RESPONSE_SCHEMA } },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`gateway ${res.status}: ${body.slice(0, 400)}`);
  }

  // SSE: acumula o texto final (resposta de uma chamada só, sem render progressivo).
  let text = "";
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
      const dataLines = evt.split("\n").filter((l) => l.startsWith("data:"));
      for (const line of dataLines) {
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const parsed = JSON.parse(payload);
          if (parsed?.type === "response.output_text.delta" && typeof parsed.delta === "string") {
            text += parsed.delta;
          } else if (parsed?.type === "response.completed") {
            const outputText = parsed?.response?.output_text;
            if (typeof outputText === "string" && outputText) text = outputText;
          } else if (parsed?.type === "response.failed" || parsed?.type === "error") {
            throw new Error(`resposta falhou: ${JSON.stringify(parsed).slice(0, 300)}`);
          }
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
    }
  }

  let parsed: any = {};
  try {
    parsed = JSON.parse(text || "{}");
  } catch {
    throw new Error("resposta da auditora não era JSON válido");
  }
  return Array.isArray(parsed.findings) ? parsed.findings : [];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const cronSecret = Deno.env.get("CRON_SECRET");
  const apiKey = Deno.env.get("LOVABLE_API_KEY");

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
      const { data: isAdmin } = await asUser.rpc("has_role", { _user_id: userData.user.id, _role: "admin" });
      if (isAdmin === true) authorized = true;
    }
  }
  if (!authorized) return json({ error: "Unauthorized" }, 401);
  if (!apiKey) return json({ error: "LOVABLE_API_KEY ausente" }, 500);

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

    // ===== Atendimentos candidatos =====
    let logQuery = supabase
      .from("agent_logs")
      .select("id, tenant_id, phone_number, user_message, ai_response, tool_calls, errors, created_at")
      .in("tenant_id", tenantIds)
      .order("created_at", { ascending: false })
      .limit(limit * 6);
    if (explicitLogIds.length) {
      logQuery = logQuery.in("id", explicitLogIds);
    } else {
      logQuery = logQuery.gte("created_at", new Date(Date.now() - lookbackMinutes * 60_000).toISOString());
    }
    const { data: logs, error: lErr } = await logQuery;
    if (lErr) throw lErr;

    const candidateIds = (logs ?? []).map((l: any) => l.id);
    const { data: alreadyRun } = candidateIds.length
      ? await supabase.from("ai_audit_runs").select("agent_log_id").in("agent_log_id", candidateIds)
      : { data: [] as any[] };
    const done = new Set((alreadyRun ?? []).map((r: any) => r.agent_log_id));

    let audited = 0;
    let skipped = 0;
    let issues = 0;
    const results: any[] = [];

    for (const log of logs ?? []) {
      if (audited >= limit) break;
      if (done.has(log.id) && !explicitLogIds.length) continue;

      const toolCalls = Array.isArray(log.tool_calls) ? log.tool_calls : [];
      if (!hasRelevantTool(toolCalls)) {
        skipped++;
        if (!dryRun && !done.has(log.id)) {
          await supabase.from("ai_audit_runs").insert({
            tenant_id: log.tenant_id,
            agent_log_id: log.id,
            provider: providerById.get(log.tenant_id) ?? null,
            phone_number: log.phone_number,
            status: "skipped_no_tools",
            turn_at: log.created_at,
          });
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

      let rawFindings: any[] = [];
      let errorMessage: string | null = null;
      try {
        rawFindings = await auditOneTurn(dossier, apiKey, systemPrompt);
      } catch (e) {
        errorMessage = String((e as Error).message ?? e).slice(0, 500);
      }

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

      const auditContext = { aiResponse: log.ai_response, toolCalls, timeReference };
      const accepted: any[] = [];
      let discarded = 0;
      // Mesmo fato (mesmo trecho de conversa) não pode virar dois achados em
      // categorias diferentes: fica só o de maior severidade.
      const factRank: Record<string, number> = { alta: 3, media: 2, baixa: 1 };
      const byFact = new Map<string, any>();
      for (const f of rawFindings) {
        const ok = validateFinding(f, conversationText, toolText, auditContext);
        if (!ok) { discarded++; continue; }
        const sig = findingSignature(f);
        if (seenSignatures.has(sig)) { discarded++; continue; }
        seenSignatures.add(sig);
        // Severidade determinística por categoria (o modelo não decide).
        f.severity = SEVERITY_BY_CATEGORY[String(f.category)] ?? f.severity ?? "media";
        const fact = normalizeForProof(String(f.evidence_conversation ?? "")).slice(0, 120);
        const current = byFact.get(fact);
        if (current) {
          discarded++;
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
        accepted: accepted.map((f) => ({ category: f.category, severity: f.severity, summary: f.summary })),
        discarded,
      });

      if (dryRun) continue;

      if (accepted.length) {
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
            model_used: AUDITOR_MODEL,
            turn_at: log.created_at,
          })),
        );
        if (fErr) console.error("[audit-monitor] falha ao gravar achados", fErr);
      }

      const { error: rErr } = await supabase.from("ai_audit_runs").upsert(
        {
          tenant_id: log.tenant_id,
          agent_log_id: log.id,
          provider: providerById.get(log.tenant_id) ?? null,
          phone_number: log.phone_number,
          status: errorMessage ? "error" : "audited",
          issues_count: accepted.length,
          discarded_count: discarded,
          model_used: AUDITOR_MODEL,
          error_message: errorMessage,
          turn_at: log.created_at,
        },
        { onConflict: "agent_log_id" },
      );
      if (rErr) console.error("[audit-monitor] falha ao gravar execução", rErr);
    }

    return json({ audited, skipped, issues, dry_run: dryRun, results });
  } catch (e) {
    console.error("[audit-monitor] erro", e);
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
