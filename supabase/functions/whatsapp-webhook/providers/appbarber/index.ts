// ============================================================================
// PROVIDER APPBARBER — módulo isolado (extraído em jul/2026, mesmo padrão do
// Frizzar). Regra: nada de AppBarber mora no index.ts principal. Se precisar
// mexer em outra API, esse arquivo aqui não deve ser tocado.
// ----------------------------------------------------------------------------
// Dependências para fora do módulo: NENHUMA (util `toPositiveInteger` está
// duplicada localmente de propósito, pra não amarrar esse módulo ao index).
// ============================================================================

function toPositiveInteger(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return i > 0 ? i : null;
}

// Classificação genérica de falha da AppBarber. Mesmo padrão já validado na Bemp
// (jul/2026, caso de pendência de pagamento), com 4 eixos INDEPENDENTES:
//   - retryable=false  → MultiBookingGuard NÃO roda recovery (definitivo).
//     Se vier `clientMessage`, o guard usa essa mensagem determinística em vez
//     de deixar a IA improvisar confirmação falsa.
//   - retryable=true   → guard pode rodar recovery normal (default).
//   - recoverable      → controla o BookingGuard do index.ts, NÃO o MultiBookingGuard.
//     true = existe caminho de saída, a IA resolve sozinha; false = escalar humano.
//     Quando omitido, cai em `retryable` (comportamento histórico).
//   - clientMessage vs recoveryDirective → DUAS AUDIÊNCIAS, nunca misturar:
//     `clientMessage` pode ser enviado LITERALMENTE ao cliente pelo MultiBookingGuard
//     (index.ts:7200), então tem que ser texto de WhatsApp — sem nome de API, sem
//     procedimento interno, sem imperativo dirigido ao agente.
//     `recoveryDirective` é instrução para a IA e NUNCA chega ao cliente.
//     ⚠️ Regressão real (25/08, 9Cinco): o texto de `future_appointments_limit` estava
//     escrito como diretiva de agente dentro de `clientMessage` e vazou ao cliente em
//     3 mensagens de WhatsApp. Ver bemp/index.ts:635-636 para o padrão correto.
// Exportada para teste unitário (ver src/test/appbarber-failure.test.ts).
// É função pura: sem rede, sem Deno, sem estado — dá pra travar cada caso real
// do Relatório de Bugs como teste de regressão.
export function classifyAppBarberFailure(
  status: number,
  rawText: string | undefined,
  parsed: any,
): {
  retryable: boolean;
  recoverable?: boolean;
  clientMessage?: string;
  recoveryDirective?: string;
  reason: string;
} {
  const msg = String(parsed?.message || parsed?.error || rawText || "").toLowerCase();

  // 1) Auth / config quebrada — não adianta a IA insistir, é problema do tenant.
  //    Sem clientMessage: o guard usa fallback genérico ("já te retorno").
  if (status === 401 || status === 403) {
    return { retryable: false, reason: `auth_${status}` };
  }

  // 2) 404 no endpoint de criar — endpoint/estabelecimento inválido, definitivo.
  if (status === 404) {
    return { retryable: false, reason: "not_found" };
  }

  // 3) Regra de negócio explícita da AppBarber (placeholders para casos reais
  //    que aparecerem — mesma evolução da Bemp). Se em algum log real
  //    aparecer uma mensagem definitiva (ex.: "cliente bloqueado",
  //    "estabelecimento inativo"), adicionar o match aqui.
  if (/estabelecimento (inativo|bloqueado|suspenso)/i.test(msg)) {
    return {
      retryable: false,
      reason: "establishment_inactive",
      clientMessage:
        "Não consegui concluir esse agendamento agora porque o estabelecimento está temporariamente indisponível no sistema. Assim que normalizar, te confirmo.",
    };
  }

  // 4) 422 = "horário indisponível / conflito". Retryable no sentido do guard:
  //    a IA pode oferecer outro horário. Sem clientMessage — deixa o fluxo
  //    normal de recovery/oferta de novos slots correr.
  if (/limite de agendamentos futuros.*excedido|agendamentos futuros foi excedido/i.test(msg)) {
    return {
      // Não adianta repetir o MESMO agendamento — o limite vai bater de novo.
      retryable: false,
      // Mas NÃO é falha de sistema: existe caminho de saída (remarcar). Sem este
      // recoverable=true o BookingGuard (index.ts:6705) injeta "chame escalate_human",
      // gerando escalação falsa para a equipe a cada ocorrência.
      recoverable: true,
      reason: "future_appointments_limit",
      // AUDIÊNCIA: cliente. Pode sair literalmente no WhatsApp.
      // ⚠️ Este texto passa por IMPLICIT_CONFIRMATION_RE e IMPLIED_FINALIZATION_RE
      // no index.ts. Evitar "marcado", "confirmado" e a sequência
      // "horário reservado" — qualquer um faz um guard tratar a mensagem como
      // confirmação falsa e trocá-la por um fallback de erro. Ver o teste de
      // invariante em src/test/appbarber-failure.test.ts.
      clientMessage:
        "Vi aqui que você já tem um agendamento ativo com a gente. "
        + "Quer que eu troque para esse novo horário, ou prefere manter o atual?",
      // AUDIÊNCIA: modelo. Nunca chega ao cliente.
      recoveryDirective:
        "O cliente já tem um agendamento futuro ativo e a API não permite um segundo. " +
        "Chame listar_agendamentos para localizar o agendamento atual e pergunte ao cliente se ele quer TROCAR " +
        "(cancelar o atual e criar o novo) ou MANTER o que já existe. Só depois da resposta dele, se for trocar, " +
        "chame cancelar_agendamento e em seguida criar_agendamento. Não tente criar outro horário direto.",
    };
  }
  if (status === 422) return { retryable: true, reason: "conflict_422" };

  // 5) 429 e 5xx são transitórios por definição.
  if (status === 429 || status >= 500) return { retryable: true, reason: `transient_${status}` };

  // 6) Default: retryable=true (mesma postura conservadora da Bemp).
  return { retryable: true, reason: `http_${status}` };
}


// ===================== APPBARBER PROVIDER =====================

const APPBARBER_DEFAULT_BASE_URL = "https://proxy.zayloia.com";

// ⚠️ Bug conhecido da API AppBarber: o filtro `professional_code` do
// /v1/availability é IGNORADO — a resposta sempre traz os blocos de TODOS os
// profissionais. Pior: em estabelecimentos com a opção "Sem preferência"
// habilitada (ex.: 9Cinco), vem um bloco extra com employee_code = "" cujos
// slots são a UNIÃO da agenda da equipe inteira (cada slot traz o
// employee_code de quem está livre naquele horário).
// Se aceitarmos esse bloco genérico, TODO profissional recebe a mesma lista.
// Regra correta (uma única função usada por listar_horarios e
// listar_horarios_geral):
//   1. Bloco com employee_code numérico → só entra se for o profissional pedido.
//   2. Bloco sem employee_code ("Sem preferência") → só entram os slots cujo
//      employee_code é o profissional pedido.
//   3. Fallback: se o profissional pedido não aparece em NENHUM lugar do payload
//      e existem slots sem dono, a agenda é genérica do estabelecimento
//      (formato de estabelecimentos sem "Sem preferência") → usa esses slots.
function appBarberCollectTimes(blocks: any[], wantedProf: number | null): string[] {
  const pick = (...values: any[]) => values.find((v) => v !== undefined && v !== null && v !== "");
  const codeOf = (value: any): number | null => {
    const raw = pick(value?.professional_code, value?.employee_code, value?.professional?.code, value?.employee?.code);
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const normalizeTime = (raw: any): string | null => {
    if (!raw) return null;
    const str = String(raw).trim();
    const normalized = /^\d{2}:\d{2}$/.test(str) ? `${str}:00` : str.slice(0, 8);
    return /^\d{2}:\d{2}:\d{2}$/.test(normalized) ? normalized : null;
  };

  const matched = new Set<string>();
  const untagged = new Set<string>();
  let profAppearsInPayload = false;

  const walk = (value: any, blockProf: number | null, blockIdentified: boolean) => {
    if (!value) return;
    if (Array.isArray(value)) { value.forEach((v) => walk(v, blockProf, blockIdentified)); return; }
    if (typeof value !== "object") return;

    const slotProf = codeOf(value) ?? (blockIdentified ? blockProf : null);
    if (wantedProf != null && slotProf === wantedProf) profAppearsInPayload = true;

    const time = normalizeTime(pick(value.scheduling_time, value.time, value.start_time, value.hour));
    if (time) {
      if (wantedProf == null) {
        matched.add(time);
      } else if (slotProf === wantedProf) {
        matched.add(time);
      } else if (slotProf == null) {
        untagged.add(time);
      }
    }
    for (const key of ["avaliable", "available", "schedules", "slots", "times", "items"]) {
      if (Array.isArray(value[key])) walk(value[key], blockProf, blockIdentified);
    }
  };

  for (const block of blocks) {
    const blockProf = codeOf(block);
    walk(block, blockProf, blockProf != null);
  }

  const result = matched.size > 0 || profAppearsInPayload
    ? Array.from(matched)
    : Array.from(untagged);
  return result.sort();
}




export function buildAppBarberTools(tenant: any) {
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
        description: "ATALHO RECOMENDADO: consulta horários LIVRES de TODOS os profissionais ao mesmo tempo (executa /v1/availability em paralelo) para UM service_code real e data. Para cliente pedindo combo/múltiplos serviços, use o service_code do combo cadastrado retornado em listar_servicos. Retorna { resumo, totalProfissionaisLivres, horariosConsolidados, profissionais: [{ professional_code, name, available_times }] }.",
        parameters: {
          type: "object",
          properties: {
            service_code: { type: "number", description: "service_code real retornado em listar_servicos. Se for combo cadastrado, use o service_code efetivo que o servidor retornou para esse combo." },
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
        description: "Cria o agendamento real no AppBarber. Só use depois de confirmar serviço(s), profissional, dia e horário EXATO de listar_horarios/listar_horarios_geral. MÚLTIPLOS SERVIÇOS NA MESMA VISITA: se houver combo cadastrado no catálogo cobrindo os serviços, use o service_code do combo numa única chamada. Se NÃO houver combo, faça UMA chamada de criar_agendamento por serviço, em sequência (mesmo profissional, mesmo cliente, horário consecutivo) — não precisa esperar entre as chamadas. NÃO use o parâmetro services[] com mais de um item: testado em produção (09/09) e confirmado quebrado do lado do AppBarber (retorna 422 'Choque de Horário', errorCode 20022, mesmo com disponibilidade real confirmada).",
        parameters: {
          type: "object",
          properties: {
            service_code: { type: "number", description: "service_code real retornado em listar_servicos. Use quando for um único serviço (ou o combo cadastrado)." },
            services: {
              type: "array",
              description: "Múltiplos serviços na MESMA visita, numa única chamada (só quando não existir combo cadastrado cobrindo eles). O primeiro item é o serviço principal usado na checagem de disponibilidade.",
              items: {
                type: "object",
                properties: {
                  service_code: { type: "number" },
                  duration: { type: "number", description: "Duração em minutos (service_interval)." },
                },
                required: ["service_code"],
              },
            },
            professional_code: { type: "number" },
            start_date: { type: "string", description: "YYYY-MM-DD" },
            start_time: { type: "string", description: "HH:MM (exato de available_times)" },
            customer_name: { type: "string" },
            customer_phone: { type: "string", description: "Telefone local SEM DDI 55 (ex: 61999998888). Use o telefone da conversa removendo o prefixo 55." },
            service_duration_minutes: { type: "number", description: "Duração em minutos (service_interval retornado por listar_servicos). Obrigatório para evitar rejeição da API." },
            scheduling_observation: { type: "string", description: "Observação opcional. O sistema sempre acrescenta nome e telefone para facilitar busca/cancelamento." },
          },
          required: ["professional_code", "start_date", "start_time", "customer_name", "customer_phone"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "listar_agendamentos",
        description: "Lista os agendamentos/comandas DESTE cliente. Use ANTES de cancelar para obter invoice_code ou invoice_item_code. Consulta comandas abertas (/v1/invoice/search) E a agenda (/v1/appointments/history) filtrada no servidor pelo telefone da conversa — agendamentos futuros só aparecem via agenda.",
        parameters: {
          type: "object",
          properties: {
            customer_phone: { type: "string", description: "Telefone local do cliente SEM DDI 55 (só dígitos). Padrão: telefone da conversa removendo o prefixo 55." },
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
            customer_phone: { type: "string", description: "Telefone local do cliente SEM DDI 55 (só dígitos). Padrão: telefone da conversa removendo o prefixo 55." },
            reason: { type: "string", description: "Motivo do cancelamento (ex: 'Cancelamento solicitado pelo cliente via WhatsApp')." },
            confirm_cancel_all_items: { type: "boolean", description: "Obrigatório = true quando a comanda alvo tem 2+ serviços e a intenção é realmente cancelar TODOS eles de uma vez (não usar quando só 1 dos serviços deve ser movido/cancelado — nesse caso use invoice_item_code + cancel_scope='item')." },
          },
          required: [],
        },
      },
    },
  ];
}

export async function executeAppBarberTool(tenant: any, toolCall: any, phoneNumber?: string, sessionState?: any): Promise<any> {
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

  // AppBarber cadastra clientes SEM o DDI 55 (padrão do app: DDD+9+numero, 11 dígitos).
  // Enviar com "55" na frente cria cadastro duplicado porque a busca interna do app
  // não encontra o cliente existente. Sempre retornar formato local.
  const appBarberLocalPhone = (raw: string): string => {
    const full = normalizePhoneDigits(raw);
    if (!full) return "";
    const local = full.startsWith("55") && (full.length === 12 || full.length === 13)
      ? full.slice(2)
      : full;
    // Números móveis antigos podem chegar com DDD + 8 dígitos. O AppBarber
    // usa sempre DDD + 9 + 8 dígitos (ex.: 61983012868).
    if (local.length === 10) return `${local.slice(0, 2)}9${local.slice(2)}`;
    return local;
  };

  const appBarberPhoneVariants = (raw: string): string[] => {
    // CONFIRMADO pelo Mariano: o AppBarber usa telefone LOCAL, sem DDI 55.
    // Ainda não está confirmado se o cadastro tem ou não o 9º dígito em
    // todos os casos (caso Gabriel/9Cinco mostrou uma inconsistência), então
    // seguimos tentando as duas formas locais — com e sem o 9 — nessa ordem.
    const full = normalizePhoneDigits(raw);
    if (!full) return [];
    const local = full.startsWith("55") && (full.length === 12 || full.length === 13) ? full.slice(2) : full;

    // Garante as duas formas locais (com e sem o 9), a partir de qualquer
    // tamanho de entrada (10 ou 11 dígitos).
    let localWith9: string;
    let localWithout9: string;
    if (local.length === 11 && local[2] === "9") {
      localWith9 = local;
      localWithout9 = local.slice(0, 2) + local.slice(3);
    } else if (local.length === 10) {
      localWithout9 = local;
      localWith9 = `${local.slice(0, 2)}9${local.slice(2)}`;
    } else {
      // Formato inesperado (nem 10 nem 11 dígitos) — usa como veio, sem tentar completar.
      localWith9 = local;
      localWithout9 = local;
    }

    const variants = [localWith9, localWithout9];
    // Remove duplicatas mantendo a ordem (ex.: quando with9 === without9 no formato inesperado).
    return Array.from(new Set(variants.filter(Boolean)));
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

  const getAppBarberCatalog = (): Array<{ service_code: number; name: string; duration_minutes?: number | null; is_combo?: boolean }> => {
    return Array.isArray((sessionState as any)?.appbarberServiceCatalog) ? (sessionState as any).appbarberServiceCatalog : [];
  };

  const findAppBarberCatalogEntry = (code: any) => {
    const n = toPositiveInteger(code);
    if (!n) return null;
    return getAppBarberCatalog().find((s) => Number(s.service_code) === n) || null;
  };

  const findRegisteredComboForServices = (services: Array<{ service_code: number }>) => {
    if (services.length < 2) return null;
    const catalog = getAppBarberCatalog();
    const selected = services
      .map((service) => findAppBarberCatalogEntry(service.service_code))
      .filter(Boolean) as Array<{ service_code: number; name: string }>;
    if (selected.length < 2) return null;
    const selectedTokens = selected.map((service) => {
      const parts = _abSplitServiceNameTokens(service.name || "");
      return parts.length > 0 ? parts : [_abNormalizeServiceText(service.name || "")].filter(Boolean);
    });
    const candidates = catalog.filter((service) => service.is_combo || _abSplitServiceNameTokens(service.name || "").length >= 2);
    for (const candidate of candidates) {
      const comboName = _abNormalizeServiceText(candidate.name || "");
      if (!comboName) continue;
      const coversAll = selectedTokens.every((tokens) => tokens.some((token) => token.length >= 3 && comboName.includes(token)));
      if (coversAll) return candidate;
    }
    return null;
  };

  try {
    switch (funcName) {
      case "listar_servicos": {
        const r = await callGet("/v1/services", {});
        if (r?.error) return r;
        const items = Array.isArray(r?.data) ? r.data : [];
        return {
          services: items.map((s: any) => {
            const effectiveCode = toPositiveInteger(s.service_code);
            const name = String(s.service_description || "");
            return {
              service_code: effectiveCode,
              is_combo: _abSplitServiceNameTokens(name).length >= 2,
              name,
              duration_minutes: s.service_interval,
              price: s.service_value,
              category_code: s.category_code,
              has_subscription: !!s.has_subscription,
            };
          }),
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
        const requestedCode = toPositiveInteger(args.service_code);
        if (!requestedCode || !args.professional_code || !args.start_date) return { error: "service_code, professional_code e start_date são obrigatórios." };
        const r = await callGet("/v1/availability", {
          service_code: requestedCode,
          start_date: args.start_date,
          professional_code: args.professional_code,
        });
        if (r?.error) return r;
        const blocks = Array.isArray(r?.data) ? r.data : [];
        const wantedProf = args.professional_code != null ? Number(args.professional_code) : null;
        // Filtro local obrigatório (a API ignora professional_code) — ver
        // appBarberCollectTimes no topo do arquivo.
        const times = appBarberCollectTimes(blocks, wantedProf);
        if (wantedProf != null && times.length === 0 && blocks.length > 0) {
          // O profissional pedido não tem slot livre nesse dia
          return {
            date: args.start_date,
            service_code: requestedCode,
            professional_code: wantedProf,
            available_times: [],
            note: "Esse profissional não tem horários nesse dia. Ofereça outra data ou outro profissional.",
          };
        }
        return {
          date: args.start_date,
          service_code: requestedCode,
          professional_code: args.professional_code,
          available_times: times,
        };
      }

      case "listar_horarios_geral": {
        const requestedCode = toPositiveInteger(args.service_code);
        if (!requestedCode || !args.start_date) {
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
            .filter((p: any) => Number.isFinite(p.professional_code) && p.professional_code > 0);
        } else {
          const listRes = await callGet("/v1/professional-list", {});
          if (listRes?.error) return listRes;
          const items = Array.isArray(listRes?.data) ? listRes.data : [];
          profs = items
            .map((p: any) => ({
              professional_code: Number(firstValue(p?.professional_code, p?.employee_code, p?.code, p?.id)),
              name: firstValue(p?.professional_name, p?.employee_name, p?.employee_nickname, p?.name) ?? null,
            }))
            .filter((p: any) => Number.isFinite(p.professional_code) && p.professional_code > 0);
        }

        if (profs.length === 0) {
          return { error: "Nenhum profissional disponível para consultar disponibilidade." };
        }

        console.log(`[AppBarber] listar_horarios_geral data=${args.start_date} svc=${args.service_code} profs=${profs.map((p) => p.professional_code).join(",")}`);

        // Mesmo filtro local usado por listar_horarios (sem duplicar lógica).
        const collectTimes = (blocks: any[], wantedProf: number): string[] =>
          appBarberCollectTimes(blocks, wantedProf);


        const consultaUm = async (prof: { professional_code: number; name: string | null }) => {
          try {
            const r = await callGet("/v1/availability", {
              service_code: requestedCode,
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
        // ⚠️ Corrigido (10/09): profissionais com ERRO (ex: 429, falha de rede) e
        // profissionais genuinamente SEM vaga ficavam indistinguíveis — os dois
        // caem em available_times:[]. Caso real: 4 dias seguidos com HTTP 429 em
        // TODOS os 8 profissionais foram reportados como "Nenhum profissional com
        // vaga... Ofereça outro dia", quando na verdade a consulta nunca chegou a
        // acontecer de verdade. A IA (e o cliente) receberam "está lotado" quando
        // o correto era "não consegui verificar agora".
        const comErro = resultados.filter((r: any) => !!r.erro);

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
        if (comHorario.length === 0 && comErro.length === profs.length) {
          // Nenhum profissional foi genuinamente consultado — 100% falhou.
          resumo = `Não consegui verificar a agenda de ${args.start_date} agora (falha técnica ao consultar todos os ${profs.length} profissionais). NÃO afirme que não há vaga nesse dia — informe que houve um problema técnico e tente novamente, ou ofereça consultar outro dia enquanto isso.`;
        } else if (comHorario.length === 0 && comErro.length > 0) {
          // Parte falhou, parte foi consultada com sucesso e realmente não tinha vaga.
          resumo = `Nenhum profissional com vaga confirmada em ${args.start_date} (${comErro.length} de ${profs.length} não puderam ser verificados por falha técnica — os demais foram checados e não têm vaga). Ofereça outro dia, mas sem certeza total de que não há vaga nenhuma nesse dia.`;
        } else if (comHorario.length === 0) {
          resumo = `Nenhum profissional com vaga em ${args.start_date}. Ofereça outro dia — NÃO pergunte preferência de profissional.`;
        } else if (comHorario.length === 1) {
          resumo = `Apenas 1 profissional livre em ${args.start_date}: ${comHorario[0].name || comHorario[0].professional_code}. NÃO pergunte preferência — proponha direto os horários dele.`;
        } else {
          resumo = `${comHorario.length} profissionais livres em ${args.start_date}. Se o cliente já disse o horário, escolha um profissional disponível sem perguntar; senão ofereça os horariosConsolidados.`;
        }

        return {
          date: args.start_date,
          service_code: requestedCode,
          resumo,
          totalProfissionaisLivres: comHorario.length,
          totalComFalhaTecnica: comErro.length,
          horariosConsolidados,
          profissionais: resultados,
        };
      }

      case "criar_agendamento": {
        // 🛡️ Anti-alucinação: mesma proteção do listar_agendamentos — força usar
        // o telefone da conversa e loga quando a IA tenta um número diferente.
        const _convDigits = normalizePhoneDigits(phoneNumber || "");
        const _argDigits = normalizePhoneDigits(args.customer_phone || "");
        if (_argDigits && _convDigits && _argDigits !== _convDigits) {
          console.warn(`[AppBarber] criar_agendamento: IA passou telefone (${_argDigits}) diferente do da conversa (${_convDigits}) — usando o da conversa.`);
        }
        const phoneDigits = normalizePhoneDigits(phoneNumber || args.customer_phone || "");
        if (!phoneDigits) return { error: "Telefone do cliente é obrigatório." };
        const requestedServices = (Array.isArray(args.services) && args.services.length > 0
          ? args.services
          : [{ service_code: args.service_code, duration: args.service_duration_minutes }])
          .map((service: any) => ({
            service_code: toPositiveInteger(service?.service_code ?? service?.serviceCode ?? service?.code ?? service?.id),
            duration: toPositiveInteger(service?.duration ?? service?.service_duration_minutes ?? service?.duration_minutes),
          }))
          .filter((service: any) => typeof service.service_code === "number");
        const primaryServiceCode = requestedServices[0]?.service_code ?? toPositiveInteger(args.service_code);
        if (!primaryServiceCode || !args.professional_code) return { error: "service_code e professional_code são obrigatórios." };
        // 🛡️ Catálogo: se listar_servicos rodou nesta conversa, service_code precisa estar no catálogo.
        {
          const abCat = getAppBarberCatalog();
          const invalidServiceCodes = requestedServices
            .map((service: any) => service.service_code)
            .filter((code: number) => code > 0 && !abCat.some((s) => s.service_code === code));
          if (abCat.length > 0 && invalidServiceCodes.length > 0) {
            console.warn(`[AppBarber] criar_agendamento BLOCKED: service_codes=${invalidServiceCodes.join(",")} fora do catálogo (${abCat.map((s) => s.service_code).join(",")})`);
            return {
              error: `service_code ${invalidServiceCodes.join(", ")} não está no catálogo desta conversa. Chame listar_servicos novamente e use um dos codes retornados.`,
              blocked: true,
              validServiceCodes: abCat.map((s) => s.service_code),
            };
          }
        }
        if (requestedServices.length > 1) {
          const combo = findRegisteredComboForServices(requestedServices);
          if (combo?.service_code) {
            const comboCode = combo.service_code;
            return {
              error: `O cliente pediu múltiplos serviços na mesma visita. No AppBarber isso deve usar o combo cadastrado "${combo.name}" (service_code ${comboCode}), não services[] separados — caso contrário a API retorna Choque de Horário.`,
              blocked: true,
              recoverable: true,
              retryable: true,
              reason: "registered_combo_required",
              combo: {
                service_code: combo.service_code,
                name: combo.name,
                duration_minutes: combo.duration_minutes ?? null,
              },
              hint: `Chame listar_horarios_geral novamente para ${combo.name} usando service_code=${comboCode} e só depois chame criar_agendamento com UM único service_code. NÃO use services[] com corte + sobrancelha separados.`,
            };
          }
          // ✅ Sem combo cadastrado cobrindo os serviços: em vez de bloquear (o que
          // empurrava a IA para DUAS chamadas separadas de criar_agendamento — e a
          // segunda batia em `future_appointments_limit`, deixando o cliente com
          // metade do pedido), seguimos com services[] na MESMA comanda. A trava de
          // slots consecutivos (Correção B, logo abaixo) é quem garante que a soma
          // das durações cabe no horário escolhido.
          console.log(`[AppBarber] criar_agendamento multi-serviço sem combo cadastrado — seguindo com services[]=${requestedServices.map((s: any) => s.service_code).join(",")} na mesma comanda.`);
        }
        // 🛡️ Ownership de profissional: se algum listar_* rodou, professional_code precisa estar no catálogo.
        // Grave porque /v1/availability tem bug conhecido (ignora filtro por profissional) — sem essa trava,
        // a IA pode oferecer horário de um professional_code que nem existe e só descobrir no 422 do POST.
        {
          const validProfs = (((sessionState as any)?.appbarberValidProfessionalCodes) || []) as number[];
          const pc = Number(args.professional_code);
          if (validProfs.length > 0 && pc > 0 && !validProfs.includes(pc)) {
            console.warn(`[AppBarber] criar_agendamento BLOCKED: professional_code=${pc} não pertence ao catálogo (${validProfs.join(",")})`);
            return {
              error: `professional_code ${pc} não está entre os profissionais listados nesta conversa. Chame listar_profissionais e use um dos codes retornados.`,
              blocked: true,
              validProfessionalCodes: validProfs,
            };
          }
        }
        if (!args.start_date || !args.start_time) return { error: "start_date e start_time são obrigatórios." };
        const startDateTime = normalizeAppBarberStartDateTime(args.start_date, args.start_time);
        if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(startDateTime)) {
          return { error: "start_date/start_time inválidos. Use start_date YYYY-MM-DD e start_time HH:MM.", recoverable: true };
        }
        // 🛡️ Correção A — checagem prévia obrigatória.
        // Se o par (service, prof, data, hora) não aparece em appbarberSlotOptions
        // (populado a cada listar_horarios / listar_horarios_geral bem-sucedido),
        // rejeitamos e pedimos pra IA re-consultar. Evita o 422 "Choque de Horário"
        // quando a IA vai direto pro POST sem listar valer (caso 556183012868).
        {
          const slotOptions = (((sessionState as any)?.appbarberSlotOptions) || []) as Array<{
            service_code: number;
            professional_code: number;
            start_date: string;
            start_time: string;
            duration_minutes: number | null;
          }>;
          const wantedDate = String(args.start_date).slice(0, 10);
          const wantedTime = String(args.start_time).slice(0, 5);
          const pc = Number(args.professional_code);
          if (slotOptions.length > 0) {
            // professional_code === 0 = consulta registrada sem profissional
            // identificado (listar_horarios sem esse argumento). Vale como
            // checagem prévia para qualquer profissional — o horário foi
            // realmente consultado na API, só não sabemos de quem era a grade.
            const hasChecked = slotOptions.some((s) =>
              s.service_code === primaryServiceCode &&
              (s.professional_code === pc || s.professional_code === 0) &&
              s.start_date === wantedDate &&
              s.start_time.slice(0, 5) === wantedTime
            );
            if (!hasChecked) {
              console.warn(`[AppBarber] criar_agendamento BLOCKED: sem checagem prévia em slotOptions para svc=${primaryServiceCode} prof=${pc} ${wantedDate} ${wantedTime}`);
              return {
                error: `Sem confirmação prévia de disponibilidade para service_code=${primaryServiceCode}, professional_code=${pc} em ${wantedDate} ${wantedTime}. Chame listar_horarios ANTES de criar_agendamento.`,
                blocked: true,
                reason: "no_availability_check",
                // Sem recoverable=true o BookingGuard injeta "chame escalate_human"
                // e a IA escala — foi o que aconteceu em 28/08, quando o cliente
                // mudou a data ("próximo sábado, não esse") e a IA tentou criar
                // sem revalidar. O caminho de saída é óbvio e está no hint abaixo:
                // basta consultar a agenda da data nova. Não é caso de humano.
                recoverable: true,
                recoveryDirective:
                  "Você tentou agendar um horário que não foi verificado na agenda. "
                  + "Chame listar_horarios com o service_code, o professional_code e a start_date corretos, "
                  + "e ofereça ao cliente apenas horários que aparecerem em available_times. "
                  + "Se a data mudou durante a conversa, é obrigatório consultar a agenda da data NOVA antes de agendar.",
                hint: "Chame listar_horarios (ou listar_horarios_geral) com service_code, professional_code e start_date. Só ofereça horários que aparecerem em available_times.",
              };
            }
          }
        }
        const serviceItems: Array<{ service_code: number; duration: number }> = [];
        for (const service of requestedServices) {
          const duration = await resolveAppBarberServiceDuration(service.service_code, service.duration);
          if (!duration) {
            return { error: `Duração do serviço ${service.service_code} não encontrada. Chame listar_servicos novamente e use service_interval como service_duration_minutes.`, recoverable: true };
          }
          serviceItems.push({ service_code: service.service_code, duration });
        }
        // 🛡️ Correção B — combo multi-serviço não cabe em 1 slot só.
        // A API /v1/availability é ESTRITAMENTE por-serviço-único: duration_minutes,
        // total_duration e service_interval são silenciosamente ignorados (comprovado
        // por probe no proxy em jul/2026 — resposta idêntica ao baseline). Quando o
        // cliente pediu N serviços (ex: corte 45 + barba 30 = 75min) e a IA só
        // checou o primeiro, validamos client-side que os slots de 15min consecutivos
        // cobrem a duração total. Regra: cada slot presente na resposta de um serviço
        // de duração d garante [slot, slot+d] livre. Encadeando slots presentes a
        // cada 15min de T até T+(D-d), cobrimos [T, T+D] onde D=total.
        if (serviceItems.length > 0) {
          const totalDuration = serviceItems.reduce((sum, item) => sum + item.duration, 0);
          const primaryDuration = serviceItems[0].duration;
          if (totalDuration > primaryDuration) {
            const slotOptions = (((sessionState as any)?.appbarberSlotOptions) || []) as Array<{
              service_code: number;
              professional_code: number;
              start_date: string;
              start_time: string;
            }>;
            const wantedDate = String(args.start_date).slice(0, 10);
            const pc = Number(args.professional_code);
            const primaryTimes = new Set(
              slotOptions
                .filter((s) => s.service_code === primaryServiceCode && s.professional_code === pc && s.start_date === wantedDate)
                .map((s) => s.start_time.slice(0, 5))
            );
            if (primaryTimes.size > 0) {
              const [hh, mm] = String(args.start_time).slice(0, 5).split(":").map(Number);
              const startMin = hh * 60 + mm;
              const chainEnd = totalDuration - primaryDuration;
              const missing: string[] = [];
              for (let offset = 0; offset <= chainEnd; offset += 15) {
                const t = startMin + offset;
                const key = `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
                if (!primaryTimes.has(key)) missing.push(key);
              }
              if (missing.length > 0) {
                console.warn(`[AppBarber] criar_agendamento BLOCKED combo ${totalDuration}min@${args.start_time}: slots ausentes ${missing.join(",")} svc=${primaryServiceCode} prof=${pc}`);
                return {
                  error: `Combo de ${totalDuration}min começando em ${args.start_time} não cabe: os slots ${missing.join(", ")} não estão livres para o profissional ${pc}. A grade AppBarber só confirmou [${args.start_time}, +${primaryDuration}min].`,
                  blocked: true,
                  reason: "combo_slots_not_consecutive",
                  totalDurationMinutes: totalDuration,
                  primaryDurationMinutes: primaryDuration,
                  missingSlots: missing,
                  hint: "Ofereça só horários T onde T, T+15, T+30... T+(totalDuration-primaryDuration) TODOS apareçam em available_times do serviço principal. Se nenhum couber, ofereça outro dia ou dividir os serviços em horários separados.",
                };
              }
            }
          }
        }
        const url = buildUrl("/v1/appointments", {});
        const rawName = String(args.customer_name || "").trim();
        // 🛡️ Anti-cadastro-fantasma: bloqueia nome genérico/curto ou vazio.
        // Já pegamos casos da IA criar cliente com nome "CLIENTE" no AppBarber.
        const invalidNamePattern = /^(cliente|client|customer|whatsapp|wpp|zap|teste|test|sem\s*nome|-+|\.+|n\/?a)$/i;
        if (!rawName || rawName.length < 3 || invalidNamePattern.test(rawName) || !/[a-zA-ZÀ-ú]/.test(rawName)) {
          return {
            error: `customer_name inválido ("${rawName || "vazio"}"). Pergunte o nome REAL do cliente antes de agendar — não use "Cliente" nem palavras genéricas. Se o cliente já se identificou nesta conversa, use aquele nome.`,
            blocked: true,
            reason: "invalid_customer_name",
            // ⚠️ Sem recoverable=true o BookingGuard (index.ts) injeta "chame
            // escalate_human" — exatamente o que o prompt proíbe para nome vazio.
            // Foi essa contradição código×prompt que produziu os casos V28-Jellson,
            // V29-Felipe e 25/08-Ansysar: a IA obedeceu a diretiva do código.
            recoverable: true,
            // ITEM 8 (set/2026): em 7 dos 8 casos medidos em 30 dias o cliente JÁ
            // havia dito o nome nesta mesma conversa e a IA mandou "Cliente"/vazio.
            // Antes a diretiva proibia reaproveitar qualquer nome e obrigava a
            // perguntar — o turno morria sem agendamento mesmo com o nome na tela.
            recoveryDirective:
              "O nome do cliente está vazio ou é genérico e a ferramenta foi bloqueada antes de chamar a API. " +
              "PRIMEIRO: releia as mensagens DESTA conversa. Se o cliente já se identificou aqui (ou o nome vem do CRM no contexto), " +
              "use esse nome real e chame criar_agendamento de novo AGORA, mantendo service_code, professional_code, duração, data e hora já definidos. " +
              "SOMENTE se não existir nenhum nome real nesta conversa, pergunte o nome ao cliente NESTA resposta, com naturalidade, e não chame criar_agendamento até ele responder. " +
              "Nunca invente nome e nunca use pushName do WhatsApp.",
          };
        }
        const customerName = rawName;
        // AppBarber armazena telefone SEM DDI 55 (formato: 61983012868).
        // Enviar "5561983012868" cria cadastro duplicado. Sempre local (DDD+9+numero).
        const customerPhoneLocal = appBarberLocalPhone(phoneDigits);
        // Schema real do AppBarber (validado via erro 400):
        // customer_phone: bigint | customer_name: string | start_date: "YYYY-MM-DD HH:MM"
        // professionals: [{ professional_code }] | services: [{ service_code, duration }]
        const body: Record<string, unknown> = {
          establishment_code: Number(estCode),
          customer_phone: Number(customerPhoneLocal || phoneDigits),
          customer_name: customerName,
          start_date: startDateTime,
          professionals: [{ professional_code: Number(args.professional_code) }],
          services: serviceItems,
          scheduling_observation: `Cliente: ${customerName} | WhatsApp: ${customerPhoneLocal || phoneDigits}`,
        };
        console.log(`[AppBarber] POST ${url} body=${JSON.stringify(body)}`);
        // Retry 429 antes de devolver rate-limit à IA (2 tentativas extras, backoff 800/1600ms).
        let res: Response;
        let text = "";
        {
          let attempt = 0;
          const maxAttempts = 3;
          while (true) {
            attempt++;
            res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
            text = await res.text();
            console.log(`[AppBarber] criar_agendamento (${res.status}, attempt ${attempt}):`, text.slice(0, 600));
            if (res.status !== 429 || attempt >= maxAttempts) break;
            await new Promise((r) => setTimeout(r, 800 * attempt));
          }
        }
        let parsed: any = null; try { parsed = JSON.parse(text); } catch { /* keep null */ }
        if (!res.ok) {
          const baseErr = parsed?.message || parsed?.data?.error_type || parsed?.error || `HTTP ${res.status}`;
          const failure = classifyAppBarberFailure(res.status, text, parsed);
          if (!failure.retryable) {
            console.warn(`[AppBarber] criar_agendamento FALHA DEFINITIVA (${failure.reason}) → MultiBookingGuard não vai tentar recovery.`);
          }
          if (res.status === 422) {
            return {
              error: `Horário indisponível ou conflito de regra de negócio: ${baseErr}`,
              status: 422,
              // recoverable é eixo próprio: só cai em `retryable` quando o
              // classificador não opina (ver classifyAppBarberFailure).
              recoverable: failure.recoverable ?? failure.retryable,
              retryable: failure.retryable,
              ...(failure.clientMessage ? { clientMessage: failure.clientMessage } : {}),
              ...(failure.recoveryDirective ? { recoveryDirective: failure.recoveryDirective } : {}),
              failureReason: failure.reason,
              // Quando o classificador mandou uma diretiva específica, ela vale mais que
              // o hint genérico de choque de horário — que descreveria a falha errada.
              hint: failure.recoveryDirective
                ?? "Chame listar_horarios novamente para o mesmo serviço/profissional e ofereça outro horário ao cliente. NÃO escale humano.",
              details: parsed?.data ?? parsed?.details,
            };
          }
          if (res.status === 429) {
            return {
              error: "Limite de requisições do AppBarber excedido. Aguarde alguns segundos e tente de novo.",
              status: 429,
              recoverable: true,
              retryable: failure.retryable,
              failureReason: failure.reason,
            };
          }
          return {
            error: baseErr,
            status: res.status,
            retryable: failure.retryable,
            ...(failure.recoverable !== undefined ? { recoverable: failure.recoverable } : {}),
            ...(failure.clientMessage ? { clientMessage: failure.clientMessage } : {}),
            ...(failure.recoveryDirective
              ? { recoveryDirective: failure.recoveryDirective, hint: failure.recoveryDirective }
              : {}),
            failureReason: failure.reason,
            details: parsed?.data ?? parsed?.details,
          };
        }
        return {
          ok: true,
          appointment_id: parsed?.data?.appointment_code || parsed?.data?.scheduling_code || parsed?.data?.id || parsed?.appointment_code || parsed?.scheduling_code || null,
          start_date: body.start_date,
          service_code: primaryServiceCode,
          service_codes: serviceItems.map((service) => service.service_code),
          services: serviceItems,
          professional_code: Number(args.professional_code),
          raw: parsed?.data ?? parsed,
        };
      }

      case "listar_agendamentos": {
        // 🛡️ Anti-alucinação: a IA às vezes inventa/troca o DDD do cliente
        // (caso real: conversa vinda de 556183012868 e IA passou 558183012868,
        // trocando DDD 61→81, resultando em busca vazia). O telefone verdadeiro
        // do cliente é SEMPRE o da conversa (phoneNumber). Ignoramos args.customer_phone
        // como fonte primária e só logamos quando a IA tenta um número diferente,
        // pra ficar rastreável no monitor do agente.
        const convDigits = normalizePhoneDigits(phoneNumber || "");
        const argDigits = normalizePhoneDigits(args.customer_phone || "");
        if (argDigits && convDigits && argDigits !== convDigits) {
          console.warn(`[AppBarber] listar_agendamentos: IA passou telefone (${argDigits}) diferente do da conversa (${convDigits}) — usando o da conversa.`);
        }
        const effectivePhone = phoneNumber || args.customer_phone || "";
        const phoneDigits = normalizePhoneDigits(effectivePhone);
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
        const phoneVariants = appBarberPhoneVariants(effectivePhone);
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
          invoiceSearchDiagnostics.push({ customer_phone: customerPhone, count: data.length });
          invoiceItems.push(...data);
        }

        const dedupedInvoiceItems = Array.from(new Map(invoiceItems.map((invoice: any, idx) => {
          const invoiceCode = firstValue(invoice?.invoice_code, invoice?.invoice_id, invoice?.invoiceCode, invoice?.comanda_code, invoice?.command_code, invoice?.code, invoice?.id, `idx:${idx}`);
          return [String(invoiceCode), invoice];
        })).values());

        const isClosedStatus = (raw: any) => {
          const status = String(raw || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
          return /CANCEL|REALIZ|CONCL|FINALIZ|FECHAD|CLOSED/.test(status);
        };

        const openInvoices = dedupedInvoiceItems.filter((it: any) =>
          !isClosedStatus(firstValue(it?.invoice_status, it?.status, it?.status_description, it?.invoiceStatus, ""))
        );

        const invoiceAppointments = openInvoices.flatMap((invoice: any) => {
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

        // ===== AGENDA (/v1/appointments/history) — filtrada NO SERVIDOR pelo telefone =====
        // Por que é obrigatório: /v1/invoice/search só devolve COMANDA ABERTA (cliente
        // já no salão). Agendamento futuro tem status "Agendado" e NUNCA aparece lá —
        // validado em produção (agendamento de 20/08 criado pela IA: invoice/search=[]
        // e history=1 linha). Sem isso, listar_agendamentos nunca acha nada.
        //
        // Privacidade: a resposta bruta do endpoint traz a agenda inteira, então o
        // filtro por telefone acontece AQUI e só as linhas do cliente da conversa
        // vão para a IA (nunca fazemos dump global).
        //
        // Detalhe crítico da API: end_date é EXCLUSIVO — start_date == end_date
        // devolve 0 linhas. Sempre garantimos end_date > start_date.
        const historyStart = startDate;
        let historyEnd = endDate;
        if (historyEnd <= historyStart) {
          historyEnd = fmt(new Date(new Date(`${historyStart}T00:00:00Z`).getTime() + 24 * 60 * 60 * 1000));
        }
        const historyDiagnostics: any[] = [];
        const historyRowsForClient: any[] = [];
        // status_type 1 = Agendado, 2 = Realizado/Confirmado. Cancelado (3) fica fora.
        for (const historyStatus of [1, 2]) {
          const historyResult = await callGet("/v1/appointments/history", {
            start_date: historyStart,
            end_date: historyEnd,
            status_type: historyStatus,
          });
          if (historyResult?.error) {
            historyDiagnostics.push({ status_type: historyStatus, error: historyResult.error, status: historyResult.status });
            continue;
          }
          const rows = Array.isArray(historyResult?.data) ? historyResult.data : extractAppBarberInvoiceList(historyResult);
          // Agendamento criado pela IA fica como "Sem Cadastro" com client_phone null:
          // o AppBarber move o telefone para scheduling_observation ("Cel 61999998888.").
          // Por isso comparamos também a observação.
          const mine = rows.filter((row: any) =>
            phoneVariants.some((variant) => phoneCoreMatches(variant, row?.client_phone, row?.scheduling_observation, row?.client_name)) &&
            !isClosedStatus(row?.scheduling_status)
          );
          historyDiagnostics.push({ status_type: historyStatus, total_rows: rows.length, matched: mine.length });
          historyRowsForClient.push(...mine);
        }

        const historyAppointments = historyRowsForClient.map((row: any) => ({
          source: "appointments_history",
          invoice_code: firstValue(row?.invoice_code, row?.invoice_id, row?.code),
          invoice_item_code: null,
          scheduling_code: firstValue(row?.scheduling_code, null),
          client_name: firstValue(row?.client_name, null),
          client_phone: firstValue(row?.client_phone, extractPhonesFromText(row?.scheduling_observation)[0], null),
          service_description: firstValue(row?.service_description, row?.description, "Agendamento AppBarber"),
          employee_name: firstValue(row?.employee_name, row?.professional_name, null),
          scheduling_start: firstValue(row?.scheduling_start, row?.start_date, null),
          scheduling_status: firstValue(row?.scheduling_status, row?.status, "Agendado"),
          service_value: firstValue(row?.service_value, row?.value, null),
          scheduling_observation: firstValue(row?.scheduling_observation, null),
        }));

        // Merge sem duplicar: comanda aberta tem prioridade (traz invoice_item_code).
        const seenInvoiceCodes = new Set(
          invoiceAppointments.map((a: any) => String(a.invoice_code ?? "")).filter(Boolean)
        );
        const appointments = [
          ...invoiceAppointments,
          ...historyAppointments.filter((a: any) => {
            const code = String(a.invoice_code ?? "");
            if (code && seenInvoiceCodes.has(code)) return false;
            if (code) seenInvoiceCodes.add(code);
            return true;
          }),
        ];

        console.log(`[AppBarber] listar_agendamentos: tried=${JSON.stringify(triedInvoicePhones)}, comandas_abertas=${invoiceAppointments.length}, agenda=${historyAppointments.length}, total=${appointments.length}, periodo=${historyStart}→${historyEnd}`);

        // Nota removida deliberadamente (09/09): o campo "note" sugerindo perguntar sobre
        // outro telefone/data foi escrito pensando só no cenário de busca intencional
        // (cliente quer cancelar/remarcar/confirmar algo que deveria existir). Mas essa
        // mesma ferramenta também é chamada na VERIFICAÇÃO PREVENTIVA antes do primeiro
        // criar_agendamento da conversa, onde retorno vazio é o resultado NORMAL e
        // esperado (cliente novo, sem conflito). O note competia com a instrução do
        // prompt ("se vazio, prossiga normalmente com criar_agendamento") e às vezes
        // vencia — caso real: cliente Odair José Gaiari, 09/09, ~17 min de atraso porque
        // a IA perguntou sobre outro telefone em vez de seguir com o agendamento. Os dois
        // cenários de uso já têm instrução própria e completa no prompt, então a ferramenta
        // não precisa (e não deve) sugerir nada.
        return {
          source: appointments.length === 0
            ? "invoice_search+appointments_history"
            : (invoiceAppointments.length > 0 ? "invoice_search+appointments_history" : "appointments_history"),
          period: { start_date: historyStart, end_date: historyEnd, status_type: statusType },
          customer_phone: phoneDigits || null,
          searched_customer_phones: triedInvoicePhones,
          invoice_search_diagnostics: invoiceSearchDiagnostics,
          history_diagnostics: historyDiagnostics,
          appointments,
          total: appointments.length,
        };
      }


      case "cancelar_agendamento": {
        // AppBarber espera telefone SEM o DDI 55 em todas as rotas (search e delete).
        const phoneDigits = appBarberLocalPhone(normalizePhoneDigits(args.customer_phone || phoneNumber || ""));
        const cancelScope = String(args.cancel_scope || "invoice").toLowerCase();
        const reason = String(args.reason || "Cancelamento solicitado pelo cliente via WhatsApp");
        let removingItem = cancelScope === "item" && args.invoice_item_code;

        // 🛡️ Ownership: se listar_agendamentos já rodou nesta conversa, invoice_code precisa pertencer ao cliente.
        {
          const validCodes = (((sessionState as any)?.appbarberValidInvoiceCodes) || []) as number[];
          const reqCode = toPositiveInteger(args.invoice_code);
          if (validCodes.length > 0 && reqCode && !validCodes.includes(reqCode)) {
            console.warn(`[AppBarber] cancelar_agendamento BLOCKED: invoice_code=${reqCode} não pertence ao cliente (válidos: ${validCodes.join(",")})`);
            return {
              error: `invoice_code ${reqCode} não pertence ao cliente desta conversa. Rode listar_agendamentos novamente e use um dos codes retornados.`,
              blocked: true,
              ownership_mismatch: true,
              validInvoiceCodes: validCodes,
            };
          }
        }


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
          // Retry 429 (2 tentativas extras, backoff 800/1600ms).
          let res: Response; let text = "";
          {
            let attempt = 0; const maxAttempts = 3;
            while (true) {
              attempt++;
              res = await fetch(url, { method: "DELETE", headers, body: JSON.stringify(body) });
              text = await res.text();
              console.log(`[AppBarber] remover_item_comanda (${res.status}, attempt ${attempt}):`, text.slice(0, 600));
              if (res.status !== 429 || attempt >= maxAttempts) break;
              await new Promise((r) => setTimeout(r, 800 * attempt));
            }
          }
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

        // ⚠️ Proteção (10/09, caso real Eduardo Gregolin): cancelar a comanda
        // inteira quando ela tem 2+ itens apaga TODOS os serviços, mesmo quando
        // a intenção real era mover só 1 (ex: remarcação parcial). No caso real,
        // isso cancelou barba+cabelo quando só a barba deveria mudar de horário
        // — o cabelo nunca foi recriado, cliente ficou sem avisar. Exige
        // confirmação explícita (confirm_cancel_all_items: true) sempre que a
        // comanda alvo tiver 2+ itens e a IA não estiver cancelando por item.
        if (!removingItem) {
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
            if (Array.isArray(items) && items.length >= 2 && args.confirm_cancel_all_items !== true) {
              const nomes = items.map((it: any) => it?.item_description || it?.service_description || it?.description || "serviço").join(", ");
              console.warn(`[AppBarber] cancelar_agendamento BLOCKED: invoice_code=${args.invoice_code} tem ${items.length} itens (${nomes}) e a IA tentou cancelar a comanda inteira sem confirmar.`);
              return {
                error: `Esta comanda tem ${items.length} serviços (${nomes}), e você está tentando cancelar TODOS de uma vez.`,
                blocked: true,
                recoverable: true,
                multi_item_invoice: true,
                items_in_invoice: items.map((it: any) => ({
                  invoice_item_code: it?.invoice_item_code,
                  description: it?.item_description || it?.service_description || it?.description,
                })),
                recoveryDirective: `Esta comanda tem ${items.length} serviços (${nomes}). Se a intenção do cliente é mover/cancelar SÓ UM desses serviços, mantendo o(s) outro(s) intacto(s), use cancelar_agendamento com invoice_item_code do item específico + cancel_scope: "item" — NÃO cancele a comanda inteira. Se o cliente realmente quer cancelar TODOS os serviços dessa comanda, chame cancelar_agendamento de novo com os mesmos parâmetros e adicione confirm_cancel_all_items: true.`,
              };
            }
          } catch (e) {
            console.log(`[AppBarber] cancelar_agendamento: falha ao pré-checar itens antes de cancelar comanda inteira:`, e instanceof Error ? e.message : e);
          }
        }

        const url = buildUrl(`/v1/invoice/${encodeURIComponent(String(args.invoice_code))}`, {});
        const body = {
          customer_phone: String(phoneDigits),
          establishment_code: estCode,
          reason,
        };
        console.log(`[AppBarber] DELETE ${url} body=${JSON.stringify(body)}`);
        // Retry 429 (2 tentativas extras, backoff 800/1600ms).
        let res: Response; let text = "";
        {
          let attempt = 0; const maxAttempts = 3;
          while (true) {
            attempt++;
            res = await fetch(url, { method: "DELETE", headers, body: JSON.stringify(body) });
            text = await res.text();
            console.log(`[AppBarber] cancelar_agendamento (${res.status}, attempt ${attempt}):`, text.slice(0, 600));
            if (res.status !== 429 || attempt >= maxAttempts) break;
            await new Promise((r) => setTimeout(r, 800 * attempt));
          }
        }
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

// ===================== HELPERS DE NOME DE SERVIÇO (locais) =====================
// Duplicados do index.ts pra manter o módulo independente. Só usados pelo
// inferAppBarberServicesForSameSlot abaixo.

function _abNormalizeServiceText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s+]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function _abSplitServiceNameTokens(value: unknown): string[] {
  return _abNormalizeServiceText(value)
    .split(/\s*(?:\+|\be\b|,|\/|&|\bmais\b|\bjunto\b|\bcom\b)\s*/i)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3);
}

function _abServiceNameImpliesAnotherService(bookedServiceName: string, candidateServiceName: string): boolean {
  const booked = _abNormalizeServiceText(bookedServiceName);
  const candidate = _abNormalizeServiceText(candidateServiceName);
  if (!booked || !candidate || booked === candidate) return false;
  const bookedParts = _abSplitServiceNameTokens(booked);
  if (bookedParts.length >= 2 && bookedParts.some((part) => part === candidate || part.includes(candidate) || candidate.includes(part))) {
    return true;
  }
  return booked.includes(candidate) || candidate.includes(booked);
}

function _abDedupeByKey<T>(items: T[], getKey: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = getKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// AppBarber-only: dado um `criar_agendamento` com 1 service_code, tenta inferir
// outros serviços do MESMO slot (mesma pessoa/data/hora) que o cliente mencionou
// na conversa. Usado pelo dispatcher pra fundir múltiplos serviços numa única
// chamada (a API AppBarber aceita `services[]` no mesmo agendamento).
export function inferAppBarberServicesForSameSlot(
  args: any,
  sessionState: any,
  contextText = "",
): Array<{ service_code: number; name: string; duration_minutes: number | null }> {
  const requestedServiceCode = toPositiveInteger(args?.service_code);
  const requestedProfessionalCode = toPositiveInteger(args?.professional_code);
  const requestedDate = typeof args?.start_date === "string" ? args.start_date.slice(0, 10) : "";
  const requestedTime = String(args?.start_time || "").slice(0, 5);
  if (!requestedServiceCode || !requestedProfessionalCode || !requestedDate || !/^\d{2}:\d{2}$/.test(requestedTime)) return [];

  const catalog = ((sessionState?.appbarberServiceCatalog) || []) as Array<{ service_code: number; name: string; duration_minutes?: number | null }>;
  const slots = ((sessionState?.appbarberSlotOptions) || []) as Array<{
    service_code: number;
    service_name: string;
    duration_minutes: number | null;
    professional_code: number;
    professional_name: string;
    start_date: string;
    start_time: string;
  }>;

  if (catalog.length === 0 || slots.length === 0) return [];
  const requestedCatalog = catalog.find((s) => Number(s.service_code) === requestedServiceCode);
  if (!requestedCatalog) return [];

  const servicesAtSameSlot = slots
    .filter((slot) =>
      slot.service_code > 0 &&
      slot.professional_code === requestedProfessionalCode &&
      slot.start_date === requestedDate &&
      slot.start_time.slice(0, 5) === requestedTime,
    )
    .map((slot) => {
      const catalogItem = catalog.find((s) => Number(s.service_code) === Number(slot.service_code));
      return {
        service_code: Number(slot.service_code),
        name: catalogItem?.name || slot.service_name || `Serviço ${slot.service_code}`,
        duration_minutes: toPositiveInteger(catalogItem?.duration_minutes ?? slot.duration_minutes),
      };
    });

  const deduped = _abDedupeByKey(servicesAtSameSlot, (service) => String(service.service_code));
  if (!deduped.some((service) => service.service_code === requestedServiceCode)) return [];

  const requestedName = requestedCatalog.name || "";
  const normalizedContext = _abNormalizeServiceText(contextText);
  return deduped.filter((service) => {
    if (service.service_code === requestedServiceCode) return true;
    const candidate = _abNormalizeServiceText(service.name);
    const candidateParts = _abSplitServiceNameTokens(service.name);
    const mentionedByClientOrAssistant = candidate.length >= 3 && (
      normalizedContext.includes(candidate) ||
      candidateParts.some((part) => part.length >= 3 && normalizedContext.includes(part))
    );
    if (!mentionedByClientOrAssistant) return false;
    return !_abServiceNameImpliesAnotherService(requestedName, service.name);
  });
}

// ===================== BOOKING EVALUATION (MultiBookingGuard support) =====================
export interface BookingEvaluation {
  succeeded: boolean;
  bookedCount: number;
  serviceName?: string;
  dateStr: string;
  timeStr?: string;
  professionalName?: string;
  extraServiceCount?: number;
  fallbackSuffix?: string;
}

export function evaluateSuccessfulBooking(tc: any, _sessionState?: any): BookingEvaluation | null {
  const r = tc?.result || {};
  const args = tc?.args || {};
  const succeeded = r.ok === true && !!r.appointment_id;
  if (!succeeded) return null;
  // AppBarber: 1 chamada de criar_agendamento = 1 pessoa em 1 horário, mesmo
  // que o array `services` tenha N itens (combo tipo "corte + barba" cai na
  // mesma visita). Contamos SEMPRE 1 reserva. A quantidade extra de serviços
  // fica em `extraServiceCount` só para exibição na mensagem — nunca no
  // bookedCount (senão o MultiBookingGuard acha que faltou reserva). Mesma
  // correção já aplicada na Frizzar (caso Matheus/Henrico, jul/2026).
  const abServices = Array.isArray(args?.services) ? args.services : [];
  const serviceCount = abServices.length;
  return {
    succeeded: true,
    bookedCount: 1,
    dateStr: String(args.start_date || ""),
    timeStr: String(args.start_time || ""),
    ...(serviceCount > 1 ? { extraServiceCount: serviceCount } : {}),
  };
}

export function extractBookedServiceNames(tc: any, _sessionState?: any): string[] {
  const r = tc?.result || {};
  const name = r?.service_name ?? r?.data?.service_name;
  return name ? [String(name)] : [];
}

// ============================================================================
// 🛡️ PhantomConfirmationGuard — CONFIG ISOLADA DO APPBARBER
// Nomes de ferramentas usados pelo guard genérico do webhook. Mantido aqui para
// que mexer/remover o AppBarber não afete os outros providers.
// ============================================================================
export const phantomGuardConfig = {
  enabled: true,
  bookingToolNames: ["criar_agendamento"],
  searchToolNames: ["listar_agendamentos"],
  // Liga a detecção de cancelamento/remarcação fantasma (ver PhantomGuardConfig
  // no index.ts). Só o AppBarber por enquanto — os outros providers seguem sem
  // o campo e portanto sem a checagem.
  cancelToolNames: ["cancelar_agendamento"],
  // 👁️ MODO OBSERVAÇÃO: detecta e registra em agent_logs, mas NÃO altera a
  // resposta. Manter assim por 1-2 semanas para medir a taxa de disparo antes
  // de ligar o bloqueio de verdade — bloquear cancelamento legítimo por engano
  // seria pior que o bug que estamos caçando.
  shadow: true,
  // Ferramentas que a IA pode legitimamente precisar chamar na reinjeção para
  // completar o fluxo (ex: nunca listou horários antes de prometer). Se ela
  // chamar qualquer uma delas, o turno é considerado recuperado e a IA responde
  // com base no resultado real — nunca cai na mensagem genérica.
  recoveryToolNames: [
    "listar_servicos",
    "listar_profissionais",
    "listar_horarios",
    "listar_horarios_geral",
    "listar_agendamentos",
    "criar_agendamento",
  ],
};

// ============================================================================
// 🛡️ BOOKING GUARDS — CONFIG ISOLADA DO APPBARBER
// MultiBookingGuard / CancelGuard / RescheduleGuard só rodam para este provider
// com estes nomes de ferramenta. Mexer aqui não afeta nenhuma outra API.
// ============================================================================
export const bookingGuardsConfig = {
  multiBooking: {
    enabled: true,
    bookingToolNames: ["criar_agendamento"],
    primaryBookingToolName: "criar_agendamento",
    // Multi-serviço vira `services[]` numa única comanda; a contagem por
    // execução já resolve, não precisa do classificador de forma de intenção.
    useIntentShape: false,
    // ⚠️ Ligado em 10/09 (pedido 1.3), com semântica RESTRITA no index.ts: o
    // guard só se retira quando prometidos<=1 E nada ficou faltando
    // (criados >= prometidos). Não pode se retirar quando prometidos=1 e
    // criados=0, porque é exatamente esse o caminho da recuperação do ITEM 8
    // (reinjeção com os códigos já obtidos / pergunta de nome) — desligar ali
    // reabriria os 15 casos de agendamento único que ficavam no fallback.
    skipWhenSingleVisit: true,
    allowMultiRecoveryAfterSuccess: false,
    useAlternativesShortCircuit: false,
    // ⚠️ Corrigido (10/09): estava "auto", permitindo a IA responder só texto
    // na rodada de recuperação em vez de completar a chamada de
    // criar_agendamento que faltava (padrão medido: "recovery sem tool_calls",
    // causa raiz de baixa recuperação no AppBarber vs Frizzar, que já usa
    // "required" e recupera 63% contra ~17% do AppBarber). O caso de nome
    // bloqueado continua protegido à parte (ver _nameBlocked na chamada de
    // recuperação, index.ts) — ali a saída certa é texto (perguntar o nome),
    // e isso não muda com esta config.
    recoveryToolChoice: "required" as const,
  },
  cancel: {
    enabled: true,
    cancelToolNames: ["cancelar_agendamento"],
  },
  reschedule: {
    enabled: true,
    cancelToolNames: ["cancelar_agendamento"],
    bookingToolNames: ["criar_agendamento"],
  },
};
