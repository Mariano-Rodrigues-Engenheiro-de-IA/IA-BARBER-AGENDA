// logs-reader — API REST somente leitura para investigação de logs/conversas.
// Isolada: não importa nem altera nada do whatsapp-webhook.
// Auth: header "x-api-key: <LOGS_READER_KEY>" (ou "?key=" para ferramentas que só fazem GET).
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const LOGS_READER_KEY = (Deno.env.get("LOGS_READER_KEY") ?? "").trim();

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

// Whitelist: tabela -> colunas legíveis + coluna de ordenação padrão.
// Nunca inclua colunas com token/segredo (ex.: tenants.*_token, *_api_key, *_hash).
const TABLES: Record<string, { columns: string; order: string }> = {
  agent_logs: {
    columns:
      "id,tenant_id,phone_number,user_message,ai_response,tool_calls,errors,model_used,total_tokens,duration_ms,session_blocked,created_at,http_trace",
    order: "created_at",
  },
  chat_messages: {
    columns: "id,tenant_id,phone_number,role,content,message_id,processed,created_at",
    order: "created_at",
  },
  ai_audit_findings: {
    columns:
      "id,tenant_id,agent_log_id,provider,phone_number,category,severity,summary,evidence_conversation,evidence_tool,tool_names,review_status,reviewed_at,model_used,turn_at,created_at",
    order: "created_at",
  },
  ai_audit_runs: {
    columns:
      "id,tenant_id,agent_log_id,provider,phone_number,status,issues_count,discarded_count,model_used,error_message,turn_at,created_at",
    order: "created_at",
  },
  conversation_state: {
    columns: "id,tenant_id,phone_number,state,pending_bookings,created_at,updated_at",
    order: "updated_at",
  },
  conversation_pauses: {
    columns: "id,tenant_id,phone_number,paused,created_at,updated_at",
    order: "updated_at",
  },
  crm_leads: {
    columns:
      "id,tenant_id,phone_number,name,label_id,label_name,notes,flag_labels,board_id,ai_summary,ai_summary_updated_at,created_at,updated_at",
    order: "updated_at",
  },
  crm_lead_history: {
    columns: "id,lead_id,from_label,to_label,changed_by,changed_at",
    order: "changed_at",
  },
  follow_ups: {
    columns:
      "id,tenant_id,phone_number,status,link_sent_at,follow_up_at,sent_at,confirmed_at,follow_up_message,sequence_id,step_order,matched_keyword,cancelled_at,cancel_reason,created_at",
    order: "created_at",
  },
  audit_logs: {
    columns: "id,tenant_id,user_id,actor_role,action,entity,entity_id,before,after,created_at",
    order: "created_at",
  },
  // Apenas identificação e configuração não sensível do tenant.
  tenants: {
    columns:
      "id,name,slug,status,api_provider,agent_mode,agent_paused,economic_mode_enabled,whatsapp_number,test_phone_numbers,visibility,archived,created_at,updated_at",
    order: "created_at",
  },
};

const OPS = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in"]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (req.method !== "GET" && req.method !== "POST") {
    return json({ error: "Método não permitido. Use GET ou POST." }, 405);
  }

  // Fail-closed: sem chave configurada, ninguém entra.
  if (!LOGS_READER_KEY) return json({ error: "LOGS_READER_KEY não configurada" }, 503);

  const url = new URL(req.url);
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const provided =
    (req.headers.get("x-api-key") ?? "").trim() || url.searchParams.get("key")?.trim() || bearer;
  if (!provided || !timingSafeEqual(provided, LOGS_READER_KEY)) {
    return json({ error: "Unauthorized" }, 401);
  }

  let body: Record<string, unknown> = {};
  if (req.method === "POST") {
    try {
      body = (await req.json()) ?? {};
    } catch {
      return json({ error: "Body inválido (JSON esperado)" }, 400);
    }
  }
  const param = (name: string): string | null => {
    const fromBody = body[name];
    if (typeof fromBody === "string" || typeof fromBody === "number") return String(fromBody);
    return url.searchParams.get(name);
  };

  const table = param("table");
  if (!table) {
    return json({
      usage: {
        auth: 'header "x-api-key: <chave>" (ou ?key=<chave>)',
        tables: Object.keys(TABLES),
        params: {
          table: "obrigatório, uma das tables acima",
          phone: "atalho para phone_number (eq)",
          tenant_id: "atalho para tenant_id (eq)",
          search: "busca ilike em user_message/ai_response/content/summary quando existir",
          since_hours: "recorte de tempo relativo (ex.: 24, 720)",
          from: "ISO date/timestamp inicial",
          to: "ISO date/timestamp final",
          filter: 'coluna:op:valor, repetível. Ex.: filter=status:eq:open (ops: ' +
            [...OPS].join(",") + ")",
          order: "coluna de ordenação (default: created_at)",
          dir: "asc|desc (default desc)",
          limit: `1..${MAX_LIMIT} (default ${DEFAULT_LIMIT})`,
          offset: "paginação",
          count: "1 para retornar total aproximado",
        },
        examples: [
          "/functions/v1/logs-reader?table=agent_logs&phone=556183012868&limit=20",
          "/functions/v1/logs-reader?table=chat_messages&phone=556183012868&since_hours=24&dir=asc",
          "/functions/v1/logs-reader?table=ai_audit_findings&filter=review_status:eq:open&limit=50",
        ],
      },
    });
  }

  const spec = TABLES[table];
  if (!spec) return json({ error: `Tabela não liberada: ${table}`, allowed: Object.keys(TABLES) }, 400);

  const allowedColumns = new Set(spec.columns.split(","));
  const limit = Math.min(Math.max(Number(param("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(Number(param("offset") ?? 0) || 0, 0);
  const orderColumn = param("order") ?? spec.order;
  if (!allowedColumns.has(orderColumn)) return json({ error: `Coluna de ordenação inválida: ${orderColumn}` }, 400);
  const ascending = (param("dir") ?? "desc").toLowerCase() === "asc";

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  let query = supabase
    .from(table)
    .select(spec.columns, param("count") === "1" ? { count: "estimated" } : undefined);

  const phone = param("phone");
  if (phone && allowedColumns.has("phone_number")) query = query.eq("phone_number", phone);
  const tenantId = param("tenant_id");
  if (tenantId && allowedColumns.has("tenant_id")) query = query.eq("tenant_id", tenantId);

  const timeColumn = allowedColumns.has(spec.order) ? spec.order : "created_at";
  const sinceHours = Number(param("since_hours") ?? 0);
  if (sinceHours > 0) {
    query = query.gte(timeColumn, new Date(Date.now() - sinceHours * 3600_000).toISOString());
  }
  const from = param("from");
  if (from) query = query.gte(timeColumn, from);
  const to = param("to");
  if (to) query = query.lte(timeColumn, to);

  const search = param("search");
  if (search) {
    const searchable = ["user_message", "ai_response", "content", "summary", "notes", "ai_summary"].filter((c) =>
      allowedColumns.has(c),
    );
    if (searchable.length === 0) return json({ error: `search não suportado em ${table}` }, 400);
    const safe = search.replace(/[%,()]/g, " ");
    query = query.or(searchable.map((c) => `${c}.ilike.%${safe}%`).join(","));
  }

  const rawFilters = [
    ...url.searchParams.getAll("filter"),
    ...(Array.isArray(body.filter) ? (body.filter as unknown[]).map(String) : []),
    ...(typeof body.filter === "string" ? [body.filter] : []),
  ];
  for (const raw of rawFilters) {
    const [column, op, ...rest] = raw.split(":");
    const value = rest.join(":");
    if (!allowedColumns.has(column)) return json({ error: `Coluna não liberada no filtro: ${column}` }, 400);
    if (!OPS.has(op)) return json({ error: `Operador inválido: ${op}`, allowed: [...OPS] }, 400);
    if (op === "in") query = query.in(column, value.split("|"));
    else if (op === "is") query = query.is(column, value === "null" ? null : value === "true");
    else query = query.filter(column, op, value);
  }

  const { data, error, count } = await query
    .order(orderColumn, { ascending })
    .range(offset, offset + limit - 1);

  if (error) return json({ error: error.message }, 400);

  return json({ table, count: count ?? null, returned: data?.length ?? 0, limit, offset, rows: data ?? [] });
});
