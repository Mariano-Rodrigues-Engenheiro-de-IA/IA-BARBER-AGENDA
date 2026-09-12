// mcp-logs — servidor MCP (Streamable HTTP) somente leitura para investigação de logs/conversas.
// Mesma whitelist e validações da logs-reader REST, falando protocolo MCP (JSON-RPC 2.0).
// Isolada: não importa nem altera nada do whatsapp-webhook.
// Auth: "Authorization: Bearer <LOGS_READER_KEY>" (mesma chave da logs-reader).
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const LOGS_READER_KEY = (Deno.env.get("LOGS_READER_KEY") ?? "").trim();

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const PROTOCOL_VERSION = "2025-06-18";

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
  tenants: {
    columns:
      "id,name,slug,status,api_provider,agent_mode,agent_paused,economic_mode_enabled,whatsapp_number,test_phone_numbers,visibility,archived,created_at,updated_at",
    order: "created_at",
  },
};

const OPS = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in"]);

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function rpcResult(id: unknown, result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function rpcError(id: unknown, code: number, message: string) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

const TOOLS = [
  {
    name: "list_tables",
    title: "Listar tabelas liberadas",
    description:
      "Lista as tabelas somente-leitura disponíveis para investigação (logs da IA, mensagens, auditoria, CRM, follow-ups, tenants).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "read_logs",
    title: "Consultar logs/conversas",
    description:
      "Consulta somente-leitura em uma tabela liberada. Use phone (telefone WhatsApp com DDI), tenant_id, search (texto livre), since_hours (recorte relativo, ex.: 24 ou 720 para 30 dias), from/to (ISO), filter (coluna:op:valor), limit/offset, order/dir. Retorna linhas JSON.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Nome da tabela (obrigatório). Veja list_tables." },
        phone: { type: "string", description: "Telefone com DDI, ex.: 556183012868 (eq phone_number)." },
        tenant_id: { type: "string", description: "UUID do tenant (eq)." },
        search: { type: "string", description: "Busca ilike em campos de texto da tabela." },
        since_hours: { type: "number", description: "Recorte relativo em horas (ex.: 24, 720)." },
        from: { type: "string", description: "Data/hora inicial ISO." },
        to: { type: "string", description: "Data/hora final ISO." },
        filter: {
          type: "array",
          items: { type: "string" },
          description: 'Filtros "coluna:op:valor". Ops: eq,neq,gt,gte,lt,lte,like,ilike,is,in (in usa |).',
        },
        order: { type: "string", description: "Coluna de ordenação (default: created_at da tabela)." },
        dir: { type: "string", enum: ["asc", "desc"], description: "Direção (default desc)." },
        limit: { type: "number", description: `1..${MAX_LIMIT} (default ${DEFAULT_LIMIT}).` },
        offset: { type: "number", description: "Paginação." },
      },
      required: ["table"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
];

function toolText(id: unknown, payload: unknown, isError = false) {
  return rpcResult(id, {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  });
}

async function runReadLogs(args: Record<string, unknown>) {
  const table = typeof args.table === "string" ? args.table.trim() : "";
  const spec = TABLES[table];
  if (!spec) throw new Error(`Tabela não liberada: ${table}. Liberadas: ${Object.keys(TABLES).join(", ")}`);

  const allowedColumns = new Set(spec.columns.split(","));
  const str = (name: string): string | null => {
    const v = args[name];
    return typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null;
  };

  const limit = Math.min(Math.max(Number(str("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(Number(str("offset") ?? 0) || 0, 0);
  const orderColumn = str("order") ?? spec.order;
  if (!allowedColumns.has(orderColumn)) {
    throw new Error(`Coluna de ordenação inválida: ${orderColumn}. Permitidas: ${[...allowedColumns].join(", ")}`);
  }
  const ascending = (str("dir") ?? "desc").toLowerCase() === "asc";

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  let query = supabase.from(table).select(spec.columns);

  const phone = str("phone");
  if (phone && allowedColumns.has("phone_number")) query = query.eq("phone_number", phone);
  const tenantId = str("tenant_id");
  if (tenantId && allowedColumns.has("tenant_id")) query = query.eq("tenant_id", tenantId);

  const timeColumn = allowedColumns.has(spec.order) ? spec.order : "created_at";
  const sinceHours = Number(str("since_hours") ?? 0);
  if (sinceHours > 0) query = query.gte(timeColumn, new Date(Date.now() - sinceHours * 3600_000).toISOString());
  const from = str("from");
  if (from) query = query.gte(timeColumn, from);
  const to = str("to");
  if (to) query = query.lte(timeColumn, to);

  const search = str("search");
  if (search) {
    const searchable = ["user_message", "ai_response", "content", "summary", "notes", "ai_summary"].filter((c) =>
      allowedColumns.has(c),
    );
    if (searchable.length === 0) throw new Error(`search não suportado em ${table}`);
    const safe = search.replace(/[%,()]/g, " ");
    query = query.or(searchable.map((c) => `${c}.ilike.%${safe}%`).join(","));
  }

  const rawFilters = Array.isArray(args.filter) ? (args.filter as unknown[]).map(String) : [];
  for (const raw of rawFilters) {
    const [column, op, ...rest] = raw.split(":");
    const value = rest.join(":");
    if (!allowedColumns.has(column)) throw new Error(`Coluna não liberada no filtro: ${column}`);
    if (!OPS.has(op)) throw new Error(`Operador inválido: ${op}. Permitidos: ${[...OPS].join(", ")}`);
    if (op === "in") query = query.in(column, value.split("|"));
    else if (op === "is") query = query.is(column, value === "null" ? null : value === "true");
    else query = query.filter(column, op, value);
  }

  const { data, error } = await query.order(orderColumn, { ascending }).range(offset, offset + limit - 1);
  if (error) throw new Error(error.message);
  return { table, returned: data?.length ?? 0, limit, offset, rows: data ?? [] };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({
        name: "zaylo-logs",
        protocol: "MCP Streamable HTTP",
        auth: "Authorization: Bearer <LOGS_READER_KEY>",
        tools: TOOLS.map((t) => t.name),
      }),
      { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } },
    );
  }

  // Fail-closed: sem chave configurada, ninguém entra.
  if (!LOGS_READER_KEY) {
    return new Response(JSON.stringify({ error: "LOGS_READER_KEY não configurada" }), { status: 503 });
  }

  let msg: Record<string, unknown>;
  try {
    msg = (await req.json()) as Record<string, unknown>;
  } catch {
    return rpcError(null, -32700, "JSON inválido");
  }
  const id = msg.id ?? null;
  const method = typeof msg.method === "string" ? msg.method : "";

  // Notificações não têm resposta.
  if (method.startsWith("notifications/")) return new Response(null, { status: 202 });

  // Exige Bearer em TODAS as chamadas MCP (inclusive initialize). Isso força o
  // conector do Claude a apresentar a etapa de autenticação, em vez de concluir
  // o handshake sem token e omitir a etapa seguinte.
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!bearer || !timingSafeEqual(bearer, LOGS_READER_KEY)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "WWW-Authenticate": "Bearer", "Content-Type": "application/json" },
    });
  }

  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "zaylo-logs", version: "1.0.0" },
      instructions:
        "Servidor somente-leitura de investigação do painel Zaylo. Use list_tables para ver as tabelas e read_logs para consultar (phone, tenant_id, search, since_hours, filtros).",
    });
  }

  if (method === "ping") return rpcResult(id, {});

  if (method === "tools/list") return rpcResult(id, { tools: TOOLS });

  if (method === "tools/call") {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const name = typeof params.name === "string" ? params.name : "";
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    try {
      if (name === "list_tables") {
        return toolText(id, { tables: Object.keys(TABLES), note: "Use read_logs com table=<nome>." });
      }
      if (name === "read_logs") return toolText(id, await runReadLogs(args));
      return rpcError(id, -32602, `Ferramenta desconhecida: ${name}`);
    } catch (e) {
      return toolText(id, { error: e instanceof Error ? e.message : String(e) }, true);
    }
  }

  return rpcError(id, -32601, `Método não suportado: ${method}`);
});
