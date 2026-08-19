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

// Classificação genérica de falha da AppBarber em 2 eixos: retryable + clientMessage.
// Mesmo padrão já validado na Bemp (jul/2026, caso de pendência de pagamento):
//   - retryable=false  → MultiBookingGuard NÃO roda recovery (definitivo).
//     Se vier `clientMessage`, o guard usa essa mensagem determinística em vez
//     de deixar a IA improvisar confirmação falsa.
//   - retryable=true   → guard pode rodar recovery normal (default).
// Hoje a AppBarber não tem um cenário de erro de negócio definitivo mapeado
// como "assinatura vencida" da Bemp, então a lista abaixo é conservadora e
// serve principalmente como estrutura pronta pra receber casos reais assim
// que aparecerem — mesmo caminho evolutivo que a Bemp teve.
function classifyAppBarberFailure(
  status: number,
  rawText: string | undefined,
  parsed: any,
): { retryable: boolean; clientMessage?: string; reason: string } {
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
      retryable: false,
      reason: "future_appointments_limit",
      clientMessage:
        "Não consegui criar outro agendamento porque já existe um agendamento futuro ativo para esse cliente no AppBarber. Se a intenção for remarcar, primeiro é obrigatório localizar e cancelar o agendamento antigo; depois criar o novo. Não tente criar outro horário direto.",
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
        description: "Cria o agendamento real no AppBarber. Só use depois de confirmar UM service_code real, profissional, dia e horário EXATO de listar_horarios/listar_horarios_geral. Para combo/múltiplos serviços, use o service_code do combo cadastrado — nunca services[] separados.",
        parameters: {
          type: "object",
          properties: {
            service_code: { type: "number", description: "service_code real retornado em listar_servicos. Para combo/múltiplos serviços, use o service_code do combo cadastrado." },
            professional_code: { type: "number" },
            start_date: { type: "string", description: "YYYY-MM-DD" },
            start_time: { type: "string", description: "HH:MM (exato de available_times)" },
            customer_name: { type: "string" },
            customer_phone: { type: "string", description: "Telefone local SEM DDI 55 (ex: 61999998888). Use o telefone da conversa removendo o prefixo 55." },
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
    // A doc/comentário original dizia que o AppBarber só aceita telefone
    // local (sem DDI 55), e sempre com o 9º dígito — mas isso não bateu na
    // prática (caso Gabriel/9Cinco, 18/08): mesmo com o telefone cadastrado
    // no AppBarber sendo IDÊNTICO ao formato buscado (44999462664, local,
    // com 9), a busca não encontrou o cliente. Sem acesso à documentação
    // técnica oficial pra confirmar o formato exato que a API espera,
    // passamos a tentar TODAS as combinações plausíveis — com e sem DDI 55,
    // com e sem o 9º dígito — nessa ordem (local com 9 primeiro, que é o
    // formato mais comum, depois as demais).
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

    const variants = [
      localWith9, // local, com 9 — formato mais comum de cadastro
      localWithout9, // local, sem 9
      `55${localWith9}`, // com DDI 55, com 9
      `55${localWithout9}`, // com DDI 55, sem 9
    ];
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
          service_code: requestedCode,
          resumo,
          totalProfissionaisLivres: comHorario.length,
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
          return {
            error: "O AppBarber não aceita criar vários services[] separados na mesma visita sem um combo cadastrado/selecionado; isso causa Choque de Horário.",
            blocked: true,
            recoverable: true,
            retryable: true,
            reason: "multi_service_without_combo",
            hint: "Se existir um combo no catálogo cobrindo esses serviços, use esse combo e consulte disponibilidade dele. Se não existir, ofereça dividir em horários separados.",
          };
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
            const hasChecked = slotOptions.some((s) =>
              s.service_code === primaryServiceCode &&
              s.professional_code === pc &&
              s.start_date === wantedDate &&
              s.start_time.slice(0, 5) === wantedTime
            );
            if (!hasChecked) {
              console.warn(`[AppBarber] criar_agendamento BLOCKED: sem checagem prévia em slotOptions para svc=${primaryServiceCode} prof=${pc} ${wantedDate} ${wantedTime}`);
              return {
                error: `Sem confirmação prévia de disponibilidade para service_code=${primaryServiceCode}, professional_code=${pc} em ${wantedDate} ${wantedTime}. Chame listar_horarios ANTES de criar_agendamento.`,
                blocked: true,
                reason: "no_availability_check",
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
              recoverable: failure.retryable,
              retryable: failure.retryable,
              ...(failure.clientMessage ? { clientMessage: failure.clientMessage } : {}),
              failureReason: failure.reason,
              hint: "Chame listar_horarios novamente para o mesmo serviço/profissional e ofereça outro horário ao cliente. NÃO escale humano.",
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
            ...(failure.clientMessage ? { clientMessage: failure.clientMessage } : {}),
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

        // ⚠️ Fallback /v1/appointments/history REMOVIDO intencionalmente.
        // Esse endpoint devolve a agenda inteira do estabelecimento (todos os clientes)
        // e a equipe técnica do AppBarber sinalizou isso como "acesso a arquivos restritos".
        // Se /v1/invoice/search não acha pelo telefone, devolvemos vazio — sem dump global.
        console.log(`[AppBarber] listar_agendamentos: invoice/search não retornou comandas abertas para ${JSON.stringify(triedInvoicePhones)} — NÃO consultando /appointments/history (acesso restrito).`);
        return {
          source: "invoice_search",
          period: { start_date: startDate, end_date: endDate, status_type: statusType },
          customer_phone: phoneDigits || null,
          searched_customer_phones: triedInvoicePhones,
          invoice_search_diagnostics: invoiceSearchDiagnostics,
          appointments: [],
          total: 0,
          note: "Nenhuma comanda ativa encontrada para este telefone no AppBarber. Confirme com o cliente o número usado no cadastro da barbearia.",
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
    skipWhenSingleVisit: false,
    useAlternativesShortCircuit: false,
    recoveryToolChoice: "auto" as const,
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
