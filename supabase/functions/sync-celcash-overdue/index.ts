// Sincroniza assinantes INADIMPLENTES da CelCash para celcash_overdue_subscribers.
//
// ⚠️ Função separada de propósito, não uma extensão de sync-celcash-subscribers:
// aquela tabela é um snapshot só de assinantes ATIVOS, usado pela IA de
// atendimento pra decidir preço de clube ("achou = é assinante ativo").
// Trazer inadimplentes pra lá quebraria essa lógica em produção. Esta função
// busca os mesmos dados da CelCash de novo (custo de 1 chamada extra à API),
// mas grava numa tabela própria, sem tocar em nada existente.
//
// Modos:
//  - { tenant_id: "uuid" }  -> sincroniza um tenant (admin only)
//  - { all: true }          -> sincroniza todos tenants com celcash_enabled=true (cron / service role)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function baseUrl(env: string) {
  return env === "production"
    ? "https://api-celcash.celcoin.com.br/v2"
    : "https://api-celcash.sandbox.cel.cash/v2";
}

function todayInSaoPaulo(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function normalizePhone(raw?: string | null): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10 || digits.length === 11) return `+55${digits}`;
  if (digits.startsWith("55") && digits.length >= 12) return `+${digits}`;
  return `+${digits}`;
}

function pickPhone(obj: any): string | null {
  if (!obj || typeof obj !== "object") return null;
  if (Array.isArray(obj.phones) && obj.phones.length) {
    const sorted = [...obj.phones].map(String).sort((a, b) => b.length - a.length);
    return sorted[0];
  }
  return (
    obj.phone || obj.mobile || obj.cellphone || obj.cell_phone ||
    obj.telefone || obj.celular || obj.phone_number || obj.phoneNumber ||
    obj.contact?.phone || obj.contact?.mobile || null
  );
}

async function getToken(env: string, galaxId: string, galaxHash: string) {
  const url = `${baseUrl(env)}/token`;
  const basic = btoa(`${galaxId}:${galaxHash}`);
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Authorization": `Basic ${basic}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      scope: "customers.read subscriptions.read transactions.read charges.read plans.read",
    }),
  });
  const text = await resp.text();
  let json: any; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!resp.ok || !json.access_token) {
    throw new Error(`CelCash token failed: HTTP ${resp.status} ${text.slice(0, 200)}`);
  }
  return json.access_token as string;
}

async function fetchAllSubscriptions(env: string, token: string) {
  const all: any[] = [];
  const limit = 100;
  let startAt = 0;
  for (let i = 0; i < 500; i++) {
    // Confirmado diretamente na API CelCash: `status` aceita uma lista
    // separada por vírgula. Assinaturas encerradas/canceladas não podem gerar
    // inadimplência e eram a maior parte das páginas (cerca de 90s desperdiçados).
    const params = new URLSearchParams({
      limit: String(limit),
      startAt: String(startAt),
      status: "active,waitingPayment",
    });
    const url = `${baseUrl(env)}/subscriptions?${params}`;

    // A CelCash devolve 5xx/429 esporádicos (às vezes página HTML do Cloudflare).
    // Tentamos novamente com espera progressiva em vez de abortar a sincronização.
    let resp!: Response;
    let text = "";
    let json: any = null;
    let lastStatus = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      resp = await fetch(url, {
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      text = await resp.text();
      try { json = JSON.parse(text); } catch { json = null; }
      lastStatus = resp.status;
      if (resp.ok) break;
      const retryable = resp.status >= 500 || resp.status === 429 || resp.status === 403;
      if (!retryable || attempt === 3) break;
      const retryAfter = Number(resp.headers.get("retry-after")) * 1000;
      const waitMs = Math.max(Number.isFinite(retryAfter) ? retryAfter : 0, 1500 * Math.pow(2, attempt));
      console.warn(`[CelCashOverdue] /subscriptions HTTP ${resp.status}; nova tentativa em ${waitMs}ms (startAt ${startAt})`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
    if (!resp.ok) {
      // Não repassamos o corpo bruto: pode ser HTML de WAF e polui o painel.
      const kind = lastStatus >= 500
        ? "instabilidade na CelCash"
        : lastStatus === 429
        ? "limite de requisições"
        : "acesso recusado";
      throw new Error(
        `CelCash assinaturas HTTP ${lastStatus} (${kind}) após 4 tentativas, página ${startAt}; lista anterior preservada.`,
      );
    }

    const items: any[] =
      json?.Subscriptions || json?.subscriptions || json?.data || json?.items || (Array.isArray(json) ? json : []);
    if (!items.length) break;
    all.push(...items);
    if (items.length < limit) break;
    startAt += items.length;
  }
  return all;
}

async function fetchPlansMap(env: string, token: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const limit = 100;
  let startAt = 0;
  for (let i = 0; i < 100; i++) {
    const url = `${baseUrl(env)}/plans?limit=${limit}&startAt=${startAt}`;
    const resp = await fetch(url, {
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    });
    const text = await resp.text();
    let json: any; try { json = JSON.parse(text); } catch { json = null; }
    if (!resp.ok) {
      console.warn(`[CelCashOverdue] /plans HTTP ${resp.status}: ${text.slice(0, 200)}`);
      break;
    }
    const items: any[] =
      json?.Plans || json?.plans || json?.data || json?.items || (Array.isArray(json) ? json : []);
    if (!items.length) break;
    for (const p of items) {
      const name = p.name || p.Name || p.title || null;
      if (!name) continue;
      const keys = [p.galaxPayId, p.GalaxPayId, p.myId, p.MyId, p.id].filter((x) => x !== undefined && x !== null);
      for (const k of keys) map.set(String(k), String(name));
    }
    if (items.length < limit) break;
    startAt += items.length;
  }
  return map;
}

// ⚠️ Reescrito (16/09): confirmado com dados reais (raw_payload de 2
// assinantes + relatório de transações exportado do painel) que o status
// da ASSINATURA ("active"/"waitingPayment") NÃO reflete corretamente quem
// está em atraso — vistos casos reais de assinatura "active" com a
// transação mais recente vencida há quase 2 meses, nunca reenviada pra
// cobrança ("status": "notSend"). A CelCash só muda o status da
// assinatura pra "waitingPayment" depois de bastante atraso acumulado —
// só isso perdia todo mundo com atraso recente (visto: relatório real da
// CelCash com 9 pessoas com transações negadas/com erro nos últimos 10
// dias, nenhuma capturada pela lógica antiga).
//
// Lógica nova, baseada só na TRANSAÇÃO mais recente de cada assinatura
// (campo Transactions[], já confirmado existir no payload real):
//   - Acha a transação com o maior "payday" (a mais recente).
//   - Se o status dela for "captured" (confirmado = pago com sucesso),
//     a pessoa está em dia — não importa se há transações futuras.
//   - Senão, se o "payday" dessa transação já passou, está inadimplente
//     — usa o "value" e "payday" DELA (não um campo genérico da
//     assinatura, que não existe no payload real).
//   - Se o "payday" ainda não chegou, ainda não é inadimplente (cobrança
//     futura normal).
// ⚠️ Adicionado (16/09): confirmado com dado real (Raimundo Mesquita) que
// o array Transactions[] embutido em cada assinatura de /subscriptions
// pode estar DESATUALIZADO — faltava a tentativa de cobrança mais recente
// (setembro), mesmo já tendo sido tentada e negada de verdade (confirmado
// no relatório visual da CelCash). Existe um endpoint dedicado
// GET /transactions (docs.prod.cloud.galaxpay.com.br/transactions/list)
// que deve refletir isso corretamente. Busca as transações recentes por
// esse endpoint e junta com as já embutidas — usa o que for mais recente
// das duas fontes por assinatura, pra não perder dado se uma das fontes
// falhar ou vier incompleta.
//
// CelCash: busca dirigida às assinaturas conhecidas, sem varrer a conta inteira.
// Esta sincronização lista somente pagamentos EM ABERTO com vencimento HOJE.
// O endpoint dedicado é a fonte atual; o array embutido da assinatura é antigo.
interface CelCashTransaction {
  galaxPayId?: string | number;
  subscriptionGalaxPayId?: string | number;
  subscriptionMyId?: string | number;
  payday?: string;
  status?: string;
  value?: number | string;
}

function isOpenTransaction(transaction: CelCashTransaction): boolean {
  const status = String(transaction.status ?? "").toLowerCase();
  // Estados liquidados não representam pagamento em aberto. Os demais são
  // preservados porque a CelCash possui estados de falha adicionais que o
  // filtro do endpoint não aceitava e que estavam sumindo da lista.
  return !["captured", "payexternal", "free", "reversed"].includes(status);
}

async function fetchRecentTransactions(
  env: string,
  token: string,
  deadlineAt: number,
) {
  const all: CelCashTransaction[] = [];
  const diagnostics = {
    pages: 0, batches: 1, subscriptions: 0, total: 0, duplicates: 0,
    lastHttpStatus: null as number | null,
    lastRawSample: null as string | null,
    error: null as string | null, stoppedReason: "all_batches_complete",
  };
  const deadline = deadlineAt;
  const limit = 100;
  const today = todayInSaoPaulo();
  const seen = new Set<string>();

  async function fetchPage(startAt: number): Promise<CelCashTransaction[]> {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("CelCash: busca incompleta (limite de tempo); lista anterior preservada.");
        const params = new URLSearchParams({
          limit: String(limit), startAt: String(startAt),
          order: "payday.asc",
        });
        let resp: Response | null = null;
        for (let attempt = 0; attempt < 4; attempt++) {
          const requestRemaining = deadline - Date.now();
          if (requestRemaining <= 0) throw new Error("CelCash: busca incompleta (limite de tempo); lista anterior preservada.");
          resp = await fetch(`${baseUrl(env)}/transactions?${params}`, {
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            signal: AbortSignal.timeout(Math.min(20_000, requestRemaining)),
          });
          diagnostics.pages++;
          diagnostics.lastHttpStatus = resp.status;
          if (resp.ok || (resp.status !== 403 && resp.status !== 429) || attempt === 3) break;

          const retryAfter = resp.headers.get("retry-after");
          const retryAfterMs = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : 0;
          const waitMs = Math.max(retryAfterMs, 1500 * (2 ** attempt));
          console.warn(`[CelCashOverdue] HTTP ${resp.status} temporário; nova tentativa ${attempt + 2}/4 em ${waitMs}ms; página ${startAt / limit + 1}`);
          await resp.body?.cancel();
          if (Date.now() + waitMs >= deadline) {
            throw new Error("CelCash: busca incompleta (limite de tempo); lista anterior preservada.");
          }
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
        if (!resp) throw new Error("CelCash: resposta de transações ausente; lista anterior preservada.");
        if (!resp.ok) {
          // Classifica a resposta sem registrar corpo bruto (pode conter dados sensíveis).
          const errorBody = (await resp.text()).toLowerCase();
          const reason = /rate.?limit|too many|muitas requisi|limite de requisi/.test(errorBody)
            ? "limite de requisições informado pela API"
            : /expired|expirad/.test(errorBody)
            ? "expiração informada pela API"
            : /scope|permission|permiss|unauthorized|não autorizado|nao autorizado/.test(errorBody)
            ? "restrição de autorização informada pela API"
            : /cloudflare|access denied|forbidden|waf/.test(errorBody)
            ? "acesso recusado; causa específica não informada"
            : "causa não identificada na resposta";
          const retryAfter = resp.headers.get("retry-after");
          const retrySeconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : null;
          const diagnostic = `HTTP ${resp.status}; ${reason}; página ${startAt / limit + 1}${retrySeconds !== null ? `; Retry-After ${retrySeconds}s` : ""}`;
          console.warn(`[CelCashOverdue] ${diagnostic}`);
          throw new Error(`CelCash transactions ${diagnostic}; lista anterior preservada.`);
        }
        const json: unknown = await resp.json();
        const body = json && typeof json === "object" ? json as Record<string, unknown> : {};
        const items = Array.isArray(json) ? json : body.Transactions ?? body.transactions ?? body.data ?? body.items;
        if (!Array.isArray(items)) throw new Error("CelCash: resposta de transações inválida; lista anterior preservada.");
        console.info(`[CelCashOverdue] startAt=${startAt} recebidas=${items.length}`);
        return items as CelCashTransaction[];
  }

  // O endpoint não oferece filtro por vencimento. Como payday.asc é ordenado,
  // localizamos a página de "90 dias atrás" por saltos exponenciais + busca
  // binária, sem percorrer anos de histórico nem depender do status da
  // assinatura. A partir dali, paginamos pra frente até ultrapassar hoje —
  // cobre toda a janela de inadimplência recente, não só o que couber numa
  // única página de margem antes de hoje (correção de 16/09: buscar a
  // fronteira de "hoje" e recuar 1 página só não é suficiente quando há
  // muitas transações por dia — perdia vencidos de dias anteriores).
  const cutoffDate90 = new Date();
  cutoffDate90.setDate(cutoffDate90.getDate() - 90);
  const cutoffStr90 = cutoffDate90.toISOString().slice(0, 10);

  let lowPage = 0;
  let highPage = 1;
  while (true) {
    const page = await fetchPage(highPage * limit);
    const lastPayday = String(page[page.length - 1]?.payday ?? "");
    if (!page.length || lastPayday >= cutoffStr90) break;
    lowPage = highPage;
    highPage *= 2;
  }
  while (highPage - lowPage > 1) {
    const middlePage = Math.floor((lowPage + highPage) / 2);
    const page = await fetchPage(middlePage * limit);
    const lastPayday = String(page[page.length - 1]?.payday ?? "");
    if (!page.length || lastPayday >= cutoffStr90) highPage = middlePage;
    else lowPage = middlePage;
  }

  let startAt = Math.max(0, (highPage - 1) * limit);
  while (true) {
    const items = await fetchPage(startAt);
    for (const tx of items) {
      if (!tx || typeof tx !== "object") throw new Error("CelCash: transação inválida.");
      const payday = String(tx.payday ?? "");
      if (payday > today || !isOpenTransaction(tx)) continue;
      const id = String(tx.galaxPayId ?? "");
      if (!id) throw new Error(`CelCash: transação sem galaxPayId (startAt ${startAt}); lista anterior preservada.`);
      if (seen.has(id)) diagnostics.duplicates++;
      else {
        seen.add(id);
        all.push(tx);
      }
    }
    const lastPayday = String(items[items.length - 1]?.payday ?? "");
    if (items.length < limit || lastPayday > today) break;
    startAt += items.length;
  }
  diagnostics.stoppedReason = "today_complete";
  diagnostics.total = all.length;
  return { transactions: all, diagnostics };
}


function deriveOverdueFromTransactions(sub: any, extraTransactionsBySubscription: Map<string, any[]>): { isOverdue: boolean; overdueCents: number; dueDate: string | null } {
  const rawStatus = String(sub.status || "").toLowerCase();
  // Assinatura cancelada/encerrada nunca conta como pendência de cobrança.
  if (rawStatus === "closed" || /cancel/.test(rawStatus)) {
    return { isOverdue: false, overdueCents: 0, dueDate: null };
  }

  const subId = String(sub.galaxPayId ?? sub.id ?? sub.myId ?? "");
  const fromEndpoint: any[] = extraTransactionsBySubscription.get(subId) || [];
  const today = todayInSaoPaulo();
  const openOverdue = fromEndpoint.filter((t) => t && String(t.payday ?? "") <= today && isOpenTransaction(t));
  if (!openOverdue.length) {
    return { isOverdue: false, overdueCents: 0, dueDate: null };
  }

  const mostRecentDueDate = openOverdue.reduce((latest, t) => {
    const p = String(t.payday ?? "");
    return p > latest ? p : latest;
  }, "");

  return {
    isOverdue: true,
    overdueCents: openOverdue.reduce((sum, t) => sum + Math.round(Number(t.value) || 0), 0),
    dueDate: mostRecentDueDate || today,
  };
}

async function syncTenantOverdue(supabase: any, tenant: any) {
  // Orçamento total do tenant: a busca precisa terminar antes do limite de
  // tempo da própria Edge Function, senão a chamada morre com 504 e o painel
  // recebe "non-2xx" sem diagnóstico algum.
  const tenantDeadline = Date.now() + 100_000;
  try {
    if (!tenant.celcash_galax_id || !tenant.celcash_galax_hash) {
      throw new Error("Credenciais CelCash ausentes");
    }
    const env = tenant.celcash_env || "sandbox";
    const token = await getToken(env, tenant.celcash_galax_id, tenant.celcash_galax_hash);
    const { transactions: recentTransactions, diagnostics: transactionsDiagnostics } = await fetchRecentTransactions(
      env,
      token,
      tenantDeadline,
    );
    // Cada transação traz a assinatura e o cliente completos. Isso inclui
    // pagamentos abertos de contratos inativos/interrompidos sem listar todas
    // as assinaturas da conta.
    const subsById = new Map<string, any>();
    for (const transaction of recentTransactions as Array<CelCashTransaction & { Subscription?: any; subscription?: any }>) {
      const subscription = transaction.Subscription ?? transaction.subscription;
      const subId = String(transaction.subscriptionGalaxPayId ?? subscription?.galaxPayId ?? "");
      if (subscription && subId) subsById.set(subId, subscription);
    }
    const subs = Array.from(subsById.values());
    const extraTransactionsBySubscription = new Map<string, any[]>();
    for (const t of recentTransactions) {
      const subId = String(t.subscriptionGalaxPayId ?? t.subscriptionMyId ?? "");
      if (!subId || subId === "undefined" || subId === "null") continue;
      if (!extraTransactionsBySubscription.has(subId)) extraTransactionsBySubscription.set(subId, []);
      extraTransactionsBySubscription.get(subId)?.push(t);
    }

    const rows = subs.map((s: any) => {
      const customer = s.Customer || s.customer || s.client || s.payer || {};
      const phoneRaw = pickPhone(customer) || pickPhone(s);
      const phoneE164 = normalizePhone(phoneRaw);
      const { isOverdue, overdueCents, dueDate } = deriveOverdueFromTransactions(s, extraTransactionsBySubscription);
      const customerEmail = Array.isArray(customer.emails) ? customer.emails[0] : (customer.email || null);
      const planIdRaw = s.planGalaxPayId ?? s.PlanGalaxPayId ?? s.planMyId ?? s.PlanMyId ?? s.plan_id ?? s.Plan?.galaxPayId ?? s.plan?.id ?? null;
      const planIdStr = planIdRaw !== null && planIdRaw !== undefined ? String(planIdRaw) : null;
      return {
        tenant_id: tenant.id,
        celcash_customer_id: String(
          customer.galaxPayId ?? customer.id ?? customer.myId ?? s.customer_id ?? s.payer_id ?? ""
        ),
        celcash_subscription_id: String(s.galaxPayId ?? s.id ?? s.myId ?? s.subscription_id ?? ""),
        phone_e164: phoneE164,
        phone_raw: phoneRaw ? String(phoneRaw) : null,
        name: customer.name || customer.fullName || customer.full_name || s.name || null,
        email: customerEmail,
        plan_id: planIdStr,
        plan_name: s.Plan?.name || s.plan?.name || s.plan_name || s.planName || null,
        overdue_amount_cents: overdueCents,
        next_due_date: dueDate,
        last_payment_date: s.last_payment_date || s.lastPaymentDate || null,
        raw_payload: s,
        synced_at: new Date().toISOString(),
        _isOverdue: isOverdue,
      };
    }).filter((r) => r.celcash_customer_id && r.celcash_customer_id !== "undefined" && r.celcash_customer_id !== "");

    // Só inadimplentes — o oposto do filtro em sync-celcash-subscribers.
    const overdueRows = rows.filter((r) => r._isOverdue).map(({ _isOverdue, ...r }) => r);

    const byCustomer = new Map<string, any>();
    for (const r of overdueRows) byCustomer.set(`${r.tenant_id}::${r.celcash_customer_id}`, r);
    const dedupedRows = Array.from(byCustomer.values());

    let upserted = 0;
    const chunkSize = 50;
    for (let i = 0; i < dedupedRows.length; i += chunkSize) {
      const chunk = dedupedRows.slice(i, i + chunkSize);
      const { error } = await supabase
        .from("celcash_overdue_subscribers")
        .upsert(chunk, { onConflict: "tenant_id,celcash_customer_id" });
      if (error) throw new Error(`Upsert error: ${error.message}`);
      upserted += chunk.length;
    }

    // Remove quem não veio neste sync (voltou a ficar em dia, ou cancelou).
    const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: removedRows } = await supabase
      .from("celcash_overdue_subscribers")
      .delete()
      .eq("tenant_id", tenant.id)
      .lt("synced_at", cutoff)
      .select("id");
    const removed = removedRows?.length || 0;

    return {
      tenant_id: tenant.id,
      fetched: recentTransactions.length,
      overdue_upserted: upserted,
      removed,
      transactions_endpoint: transactionsDiagnostics,
    };
  } catch (e: any) {
    return { tenant_id: tenant.id, error: e.message || String(e) };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const body = await req.json().catch(() => ({}));
    const authHeader = req.headers.get("Authorization") || "";
    const isCronCall = body.all === true;

    let tenants: any[] = [];

    if (isCronCall) {
      const cronSecret = Deno.env.get("CRON_SECRET");
      const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const providedSecret = req.headers.get("x-cron-secret") || req.headers.get("x-webhook-secret");
      const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      const secretOk = !!(cronSecret && providedSecret && providedSecret === cronSecret);
      const serviceOk = !!(bearer && bearer === serviceRoleKey);
      if (!secretOk && !serviceOk) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data } = await supabase
        .from("tenants")
        .select("id, name, celcash_galax_id, celcash_galax_hash, celcash_env, celcash_enabled")
        .eq("celcash_enabled", true);
      tenants = data || [];
    } else {
      if (!authHeader.startsWith("Bearer ")) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const anonClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: authHeader } } }
      );
      const { data: { user } } = await anonClient.auth.getUser();
      if (!user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!body.tenant_id) {
        return new Response(JSON.stringify({ error: "tenant_id is required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // ⚠️ Adicionado (16/09): antes só admin podia chamar essa sincronização
      // sob demanda. Botão "Sincronizar agora" no painel do cliente precisa
      // que o próprio dono do tenant também consiga, sem depender de acesso
      // admin nem de credenciais do Supabase (que a Lovable gerencia, o
      // cliente não tem acesso). Mesmo padrão já usado em
      // evaluate-celcash-billing e lookup-celcash-subscriber.
      const { data: isAdmin } = await supabase.rpc("has_role", { _user_id: user.id, _role: "admin" });
      let allowed = !!isAdmin;
      if (!allowed) {
        const { data: membership } = await supabase
          .from("tenant_users")
          .select("tenant_id")
          .eq("user_id", user.id)
          .eq("tenant_id", body.tenant_id)
          .maybeSingle();
        allowed = !!membership;
      }
      if (!allowed) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data } = await supabase
        .from("tenants")
        .select("id, name, celcash_galax_id, celcash_galax_hash, celcash_env, celcash_enabled")
        .eq("id", body.tenant_id)
        .single();
      if (!data) {
        return new Response(JSON.stringify({ error: "Tenant not found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      tenants = [data];
    }

    const results = [];
    // Nunca estourar o tempo da requisição: sobrando pouco, os tenants
    // restantes voltam marcados (nunca descartados em silêncio).
    const requestDeadline = Date.now() + 220_000;
    for (const t of tenants) {
      if (Date.now() > requestDeadline) {
        results.push({ tenant_id: t.id, error: "Sincronização não executada nesta rodada (limite de tempo da requisição); tente novamente." });
        continue;
      }
      results.push(await syncTenantOverdue(supabase, t));
    }

    return new Response(JSON.stringify({ success: true, results }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message || "Internal error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
