import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;

const AI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-5-mini";

const SYSTEM_PROMPT =
  "Você é um extrator de memória persistente de CRM para um salão/barbearia. " +
  "Responda APENAS JSON válido (sem markdown) no formato " +
  "{\"should_update\": boolean, \"summary\": string, \"reason\": string}.\n\n" +
  "REGRA PRINCIPAL: seja GENEROSO. should_update=true sempre que houver QUALQUER fato útil sobre o cliente:\n" +
  "- Nome do cliente\n" +
  "- Serviço(s) mencionado(s), perguntado(s) ou agendado(s)\n" +
  "- Profissional citado/preferido\n" +
  "- Janela de horário típica\n" +
  "- Plano, clube, assinatura, pacote\n" +
  "- Restrição, alergia, observação útil\n" +
  "- Status da última interação (ex: 'agendou corte com X em DATA', 'pediu preço de barba', 'primeiro contato — interesse em sobrancelha')\n\n" +
  "Só responda should_update=false quando NÃO houver QUALQUER fato extraível do histórico.\n\n" +
  "REGRA DE MERGE: receba currentSummary e devolva uma versão ATUALIZADA que PRESERVE o que já era verdade e adicione/refine. " +
  "Não apague info anterior. Consolide; máximo 600 caracteres, PT-BR, factual, sem floreio, sem citar 'cliente disse'.";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function extractSummary(tenantName: string, currentSummary: string, history: any[]) {
  const body = {
    model: MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: JSON.stringify({
          tenantName,
          currentSummary,
          recentHistory: history.slice(-20),
        }),
      },
    ],
    max_completion_tokens: 320,
  };

  const resp = await fetch(AI_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`AI ${resp.status}: ${t.slice(0, 200)}`);
  }
  const json = await resp.json();
  const raw = String(json?.choices?.[0]?.message?.content || "").trim();
  const block = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!block) throw new Error("no JSON block");
  const parsed = JSON.parse(block);
  return {
    shouldUpdate: !!parsed?.should_update,
    summary: String(parsed?.summary || "").trim().slice(0, 1200),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // ===== Auth guard: CRON_SECRET header, service-role bearer, or admin JWT =====
    const cronSecret = Deno.env.get("CRON_SECRET");
    const providedSecret = req.headers.get("x-cron-secret") || req.headers.get("x-webhook-secret");
    const authHeader = req.headers.get("Authorization") || "";
    const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const secretOk = !!(cronSecret && providedSecret && providedSecret === cronSecret);
    const serviceOk = !!(bearer && bearer === SERVICE_ROLE);
    let adminOk = false;
    if (!secretOk && !serviceOk && bearer) {
      const anonClient = createClient(
        SUPABASE_URL,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: authHeader } } }
      );
      const { data: { user } } = await anonClient.auth.getUser();
      if (user) {
        const { data: isAdmin } = await supabase.rpc("has_role", { _user_id: user.id, _role: "admin" });
        adminOk = !!isAdmin;
      }
    }
    if (!secretOk && !serviceOk && !adminOk) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const raw = await req.json().catch(() => ({}));
    const { tenant_id, force = false, dry_run = false } = raw;
    // Clamp limit to prevent runaway OpenAI spend per call
    const rawLimit = Number(raw.limit ?? 200);
    const limit = Math.max(1, Math.min(500, Number.isFinite(rawLimit) ? rawLimit : 200));


    // Pick candidate phone+tenant pairs from chat_messages (recent activity first)
    let q = supabase
      .from("chat_messages")
      .select("tenant_id, phone_number, created_at")
      .order("created_at", { ascending: false })
      .limit(5000);
    if (tenant_id) q = q.eq("tenant_id", tenant_id);

    const { data: msgs, error: msgsErr } = await q;
    if (msgsErr) throw msgsErr;

    const seen = new Set<string>();
    const pairs: { tenant_id: string; phone_number: string }[] = [];
    for (const m of msgs || []) {
      if (!m.phone_number || /[^0-9]/.test(m.phone_number) || m.phone_number.length >= 14) continue;
      const k = `${m.tenant_id}|${m.phone_number}`;
      if (seen.has(k)) continue;
      seen.add(k);
      pairs.push({ tenant_id: m.tenant_id, phone_number: m.phone_number });
      if (pairs.length >= limit) break;
    }

    let processed = 0, updated = 0, skipped = 0, errors = 0;
    const errorSamples: string[] = [];

    for (const p of pairs) {
      processed++;
      try {
        const { data: leadRows } = await supabase
          .from("crm_leads")
          .select("id, ai_summary, name")
          .eq("tenant_id", p.tenant_id)
          .eq("phone_number", p.phone_number)
          .limit(1);
        const lead = leadRows?.[0];
        const currentSummary = (lead?.ai_summary || "").trim();
        if (currentSummary && !force) { skipped++; continue; }

        const { data: history } = await supabase
          .from("chat_messages")
          .select("role, content, created_at")
          .eq("tenant_id", p.tenant_id)
          .eq("phone_number", p.phone_number)
          .order("created_at", { ascending: true })
          .limit(40);

        const userMsgs = (history || []).filter((m: any) => m.role === "user");
        if (userMsgs.length < 2) { skipped++; continue; }

        const { data: tenantRow } = await supabase
          .from("tenants")
          .select("name")
          .eq("id", p.tenant_id)
          .maybeSingle();

        const { shouldUpdate, summary } = await extractSummary(
          tenantRow?.name || "",
          currentSummary,
          history || [],
        );

        if (!shouldUpdate || !summary || summary === currentSummary) { skipped++; continue; }

        if (!dry_run) {
          if (lead) {
            await supabase
              .from("crm_leads")
              .update({ ai_summary: summary, ai_summary_updated_at: new Date().toISOString() })
              .eq("id", lead.id);
          } else {
            await supabase.from("crm_leads").insert({
              tenant_id: p.tenant_id,
              phone_number: p.phone_number,
              label_id: "novo",
              ai_summary: summary,
              ai_summary_updated_at: new Date().toISOString(),
            } as any);
          }
        }
        updated++;
        // gentle rate-limit
        await new Promise((r) => setTimeout(r, 150));
      } catch (e: any) {
        errors++;
        if (errorSamples.length < 5) errorSamples.push(`${p.phone_number}: ${e?.message || e}`);
      }
    }

    return new Response(
      JSON.stringify({ tenant_id: tenant_id || null, processed, updated, skipped, errors, errorSamples, dry_run }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e: any) {
    return new Response(
      JSON.stringify({ error: e?.message || String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
