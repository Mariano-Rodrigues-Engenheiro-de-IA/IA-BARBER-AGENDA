// ============================================================================
// PROVIDER FRIZZAR — módulo isolado
// ----------------------------------------------------------------------------
// Este arquivo concentra TODO o código específico da API Frizzar que estava
// espalhado em `whatsapp-webhook/index.ts`. Regra do projeto:
//   "Se eu mexer na Frizzar, tenho certeza que não quebrou a Trinks."
//
// ⚠️ Zero mudança de comportamento nesta extração. É pura movimentação:
//   - buildFrizzarTools               (definição das tools do OpenAI)
//   - executeFrizzarTool              (execução real das tools)
//   - frizzarGetLastListed/set        (memória da última listar_horarios)
//   - isRecoverableFrizzarScheduleResult
//   - buildFrizzarScheduleRecoveryInstruction
//
// Dependências para fora do módulo: NENHUMA (util `toPositiveInteger` é
// duplicado localmente pra manter o provider realmente independente — igual à
// filosofia "1 projeto por API"). Se precisar migrar o util pra `_shared`
// depois, é decisão sua, aviso antes.
// ============================================================================

// Util local (duplicado de index.ts pra não criar acoplamento no shared).
function toPositiveInteger(value: unknown): number | null {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  const parsed = parseInt(normalized, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// Normaliza o campo `dia` retornado pela Frizzar para yyyy-MM-dd no fuso
// America/Sao_Paulo. A API às vezes devolve `"2026-07-21"`, às vezes um ISO
// completo com timezone (`"2026-07-20T21:00:00-03:00"` = 21/07 BRT, mas
// `startsWith("2026-07-21")` retornaria false). Sem isso, dias inteiros com
// grade cheia foram interpretados como "sem vaga".
function frizzarNormalizeApiDay(rawDia: unknown): string | null {
  if (typeof rawDia !== "string" || !rawDia) return null;
  // Caso simples: já vem como yyyy-MM-dd (com ou sem sufixo T...)
  const bare = rawDia.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(bare) && !rawDia.includes("T") && !rawDia.includes("Z") && !/[+-]\d{2}:?\d{2}$/.test(rawDia)) {
    return bare;
  }
  // ISO com timezone: converter para BRT (America/Sao_Paulo)
  const parsed = new Date(rawDia);
  if (isNaN(parsed.getTime())) return /^\d{4}-\d{2}-\d{2}$/.test(bare) ? bare : null;
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric", month: "2-digit", day: "2-digit",
    });
    return fmt.format(parsed); // en-CA => yyyy-MM-dd
  } catch {
    return /^\d{4}-\d{2}-\d{2}$/.test(bare) ? bare : null;
  }
}

function frizzarMatchesRequestedDay(rawDia: unknown, requested: string): boolean {
  // `dia` é um dia de agenda, não um instante. Algumas instalações devolvem
  // meia-noite com offset/UTC; converter esse valor de fuso pode deslocá-lo
  // para o dia anterior. O prefixo literal tem prioridade e a normalização
  // fica apenas como fallback para formatos alternativos.
  if (typeof rawDia === "string" && rawDia.slice(0, 10) === requested) return true;
  const n = frizzarNormalizeApiDay(rawDia);
  return !!n && n === requested;
}

// ===================== FRIZZAR TOOLS DEFINITION =====================

export function buildFrizzarTools(tenant: any) {
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
        description: "Lista profissionais que atendem TODOS os serviços informados. O campo proximoHorario da API NÃO comprova disponibilidade ou indisponibilidade na data desejada e não deve ser mostrado ao cliente. Sempre chame listar_horarios_geral com os profissionais retornados e a data pedida antes de afirmar que há ou não há vagas.",
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

// ===================== FRIZZAR SCHEDULE RECOVERY HELPERS =====================

export function isRecoverableFrizzarScheduleResult(result: any): boolean {
  if (!result || typeof result !== "object" || !result.error) return false;
  const errorText = String(result.error || "");
  if (/cliente bloqueado|limite de agendamentos/i.test(errorText)) return false;
  const hasSameDaySlots = Array.isArray(result.horariosLivres);
  const hasOtherDaySlots = Array.isArray(result.outrosDias);
  return hasSameDaySlots || hasOtherDaySlots || /hor[aá]rio.*indispon[ií]vel|sem vagas|hor[aá]rios livres|ofere[cç]a um dos hor[aá]rios|antes de agendar|data divergente/i.test(errorText);
}

export function buildFrizzarScheduleRecoveryInstruction(result: any, args: any = {}): string {
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

// ===================== FRIZZAR LAST-LISTED MEMORY =====================

// Memória persistida da última `listar_horarios` por profissional (por conversa).
// Antes era um Map module-level, que sumia entre cold starts de instâncias
// diferentes do Deno — gerando falso "não listou antes" e bloqueando agendamento
// legítimo. Agora vive dentro de `sessionState.frizzarListedByProfessional` e
// atravessa reinício de instância normalmente.
export function frizzarGetLastListed(state: any, profissionalId: any): { dia: string; listedAt: number } | null {
  const pid = toPositiveInteger(profissionalId);
  if (!pid || !state?.frizzarListedByProfessional) return null;
  const entry = state.frizzarListedByProfessional.find((e: any) => e.profissionalId === pid);
  return entry ? { dia: entry.dia, listedAt: entry.listedAt } : null;
}

export function frizzarSetLastListed(state: any, profissionalId: any, dia: string): void {
  const pid = toPositiveInteger(profissionalId);
  if (!pid || !state || !dia) return;
  if (!Array.isArray(state.frizzarListedByProfessional)) state.frizzarListedByProfessional = [];
  const list = state.frizzarListedByProfessional;
  const idx = list.findIndex((e: any) => e.profissionalId === pid);
  const record = { profissionalId: pid, dia, listedAt: Date.now() };
  if (idx >= 0) list[idx] = record;
  else list.push(record);
  if (list.length > 30) state.frizzarListedByProfessional = list.slice(-30);
}

// ===================== FRIZZAR TOOL EXECUTION =====================

export async function executeFrizzarTool(tenant: any, toolCall: any, _phoneNumber?: string, sessionState?: any): Promise<any> {
  const funcName = toolCall.function.name;
  let args: any = {};
  try { args = JSON.parse(toolCall.function.arguments || "{}"); } catch { /* empty */ }

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
  // 429 (rate-limit) tratado como transitório junto com 5xx: mesmo backoff.
  const transientStatuses = new Set([429, 502, 503, 504]);
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
        if (attempt < 3) await sleep(400 * attempt);
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
    if (tel.startsWith("55") && tel.length >= 12) tel = tel.substring(2);
    return tel;
  };

  const transientErrorPayload = (context: string, status: number) => ({
    error: `Falha transitória ao ${context}. NÃO mencione erro, sistema, instabilidade ou tente de novo ao cliente. Chame a ferramenta de escalar humano se existir; caso contrário responda APENAS: 'Só um instante, vou avisar o responsável pra te atender por aqui 🙏' e não prossiga com o fluxo.`,
    upstreamStatus: status,
    retryable: true,
  });

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
          return transientErrorPayload("consultar o cliente", res.status);
        }
        try {
          const parsed = JSON.parse(text);
          const cid = toPositiveInteger(parsed?.codigo);
          if (cid && sessionState) {
            (sessionState as any).frizzarClienteId = cid;
            console.log(`[Frizzar] frizzarClienteId tracked (buscar_cliente)=${cid}`);
          }
          return parsed;
        } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
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
        if (transientStatuses.has(res.status)) {
          return transientErrorPayload("cadastrar o cliente", res.status);
        }
        try {
          const parsed = JSON.parse(text);
          const cid = toPositiveInteger(parsed?.codigo);
          if (cid && sessionState) {
            (sessionState as any).frizzarClienteId = cid;
            console.log(`[Frizzar] frizzarClienteId tracked (cadastrar_cliente)=${cid}`);
          }
          return parsed;
        } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "buscar_agendamentos": {
        {
          const ownerCid = toPositiveInteger((sessionState as any)?.frizzarClienteId);
          const reqCid = toPositiveInteger(args.clienteId);
          if (ownerCid && reqCid && ownerCid !== reqCid) {
            console.warn(`[Frizzar] buscar_agendamentos BLOCKED: clienteId=${reqCid} não pertence a esta conversa (real=${ownerCid})`);
            return {
              error: `clienteId ${reqCid} não pertence ao cliente desta conversa. Use clienteId=${ownerCid} (o retornado por buscar_cliente/cadastrar_cliente neste atendimento).`,
              blocked: true,
              ownership_mismatch: true,
              clienteIdEsperado: ownerCid,
            };
          }
        }
        const res = await frizzarFetch(`/buscar/agendamentos/${args.clienteId}`, { headers });
        const text = await res.text();
        console.log(`[Frizzar] buscar_agendamentos response (${res.status}):`, text.slice(0, 400));
        if (transientStatuses.has(res.status)) {
          return transientErrorPayload("consultar seus agendamentos", res.status);
        }
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
        if (Array.isArray(parsed) && sessionState) {
          const ids = parsed
            .map((p: any) => toPositiveInteger(p?.codigo))
            .filter((n: any): n is number => typeof n === "number");
          const existing = new Set(((sessionState as any).frizzarValidProfessionalIds || []) as number[]);
          for (const id of ids) existing.add(id);
          (sessionState as any).frizzarValidProfessionalIds = Array.from(existing).slice(0, 100);
          // Cache nome→id para poder mostrar o barbeiro em mensagens de erro
          // (caso 553488498243: erro do `agendar` não mencionava qual barbeiro).
          const nomes = (sessionState as any).frizzarProfessionalNames || {};
          for (const p of parsed) {
            const cid = toPositiveInteger(p?.codigo);
            const nome = typeof p?.nome === "string" ? p.nome.trim() : "";
            if (cid && nome) nomes[cid] = nome;
          }
          (sessionState as any).frizzarProfessionalNames = nomes;
          console.log(`[Frizzar] frizzarValidProfessionalIds += [${ids.join(",")}] (total=${(sessionState as any).frizzarValidProfessionalIds.length})`);
        }
        if (Array.isArray(parsed) && parsed.length === 0) {
          return {
            profissionais: [],
            disponibilidadeVerificada: false,
            aviso: "A listagem de profissionais veio vazia, mas isso NÃO comprova agenda lotada. Não diga que não há vagas sem consultar a grade da data solicitada. Se houver profissionais já conhecidos nesta conversa, use-os em listar_horarios_geral; caso contrário, peça preferência de profissional ou outra data sem afirmar indisponibilidade.",
          };
        }
        // `proximoHorario` já divergiu da grade real da própria Frizzar: em
        // 21/07/2026 apontou o dia seguinte para todos os profissionais, embora
        // `/listar/horarios/{id}/{data}` ainda tivesse várias vagas no mesmo dia.
        // Não expomos esse resumo inconsistente como fonte de disponibilidade.
        const profissionais = Array.isArray(parsed)
          ? parsed.map((profissional: any) => {
              if (!profissional || typeof profissional !== "object") return profissional;
              const { proximoHorario: _proximoHorarioIgnorado, ...dadosConfiaveis } = profissional;
              return dadosConfiaveis;
            })
          : parsed;
        return {
          profissionais,
          disponibilidadeVerificada: false,
          acaoObrigatoria: "Chame listar_horarios_geral com estes profissionais, os serviços escolhidos e a data pedida. Somente essa grade pode confirmar se há ou não vagas.",
        };
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
          if (Array.isArray(parsed)) {
            const exato = parsed.find((d: any) => frizzarMatchesRequestedDay(d?.dia, args.data));
            if (exato && args.profissionalId) {
              frizzarSetLastListed(sessionState, args.profissionalId, args.data);
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
        const profissionaisInformados = Array.isArray(args.profissionais) ? args.profissionais : [];
        if (!args.data || body.length === 0) {
          return { error: "Faltam parâmetros: data (yyyy-MM-dd) e servicos." };
        }

        // Não confiar apenas na lista montada pela IA: ela pode estar
        // incompleta ou reaproveitada de outro serviço. Recarregamos os
        // profissionais elegíveis diretamente da Frizzar com os mesmos
        // serviços desta consulta e unimos pelo código.
        let profissionaisDescobertos: any[] = [];
        try {
          const profissionaisRes = await frizzarFetch(`/listar/profissionais`, {
            method: "POST",
            headers: jsonHeaders,
            body: JSON.stringify(body),
          });
          const profissionaisText = await profissionaisRes.text();
          console.log(`[Frizzar] listar_horarios_geral descoberta de profissionais (${profissionaisRes.status}):`, profissionaisText.slice(0, 1200));
          if (profissionaisRes.ok) {
            const profissionaisParsed = JSON.parse(profissionaisText);
            if (Array.isArray(profissionaisParsed)) profissionaisDescobertos = profissionaisParsed;
          }
        } catch (error) {
          console.warn(`[Frizzar] listar_horarios_geral não conseguiu atualizar profissionais:`, (error as Error)?.message || String(error));
        }

        const profissionaisPorId = new Map<number, { codigo: number; nome: string | null }>();
        for (const profissional of [...profissionaisDescobertos, ...profissionaisInformados]) {
          const codigo = toPositiveInteger(profissional?.codigo);
          if (!codigo) continue;
          const atual = profissionaisPorId.get(codigo);
          profissionaisPorId.set(codigo, {
            codigo,
            nome: typeof profissional?.nome === "string" && profissional.nome.trim()
              ? profissional.nome.trim()
              : atual?.nome ?? null,
          });
        }
        const profs = Array.from(profissionaisPorId.values());
        if (profs.length === 0) {
          return {
            data: args.data,
            disponibilidadeVerificada: false,
            error: "A Frizzar não retornou profissionais elegíveis para consultar a grade. NÃO diga que não há vagas; encaminhe para atendimento humano.",
            blocked: true,
          };
        }
        console.log(`[Frizzar] listar_horarios_geral data=${args.data} profs=${profs.map((p: any) => p.codigo).join(",")}`);

        const consultaUm = async (prof: any, rodada: number) => {
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
            console.log(`[Frizzar] listar_horarios_geral profissional=${profissionalId} rodada=${rodada} response (${res.status}):`, text.slice(0, 1200));
            if (!res.ok) return { profissionalId, nome, erro: `status ${res.status}`, horariosLivres: [], diaSolicitadoEncontrado: false };
            const parsed = JSON.parse(text);
            if (!Array.isArray(parsed)) {
              console.warn(`[Frizzar] listar_horarios_geral profissional=${profissionalId} retornou formato inesperado:`, JSON.stringify(parsed).slice(0, 1200));
              return {
                profissionalId,
                nome,
                erro: `formato inesperado da API (esperava array de dias, recebeu ${parsed === null ? "null" : typeof parsed})`,
                horariosLivres: [],
                diaSolicitadoEncontrado: false,
                raw: parsed,
              };
            }
            const exato = parsed.find((d: any) => frizzarMatchesRequestedDay(d?.dia, args.data));
            if (exato) {
              frizzarSetLastListed(sessionState, profissionalId, args.data);
            }
            return {
              profissionalId,
              nome,
              data: args.data,
              diaSolicitadoEncontrado: Boolean(exato),
              erro: exato ? undefined : `data ${args.data} ausente na resposta`,
              horariosLivres: Array.isArray(exato?.horariosLivres) ? exato.horariosLivres : [],
            };
          } catch (e: any) {
            return { profissionalId, nome, erro: String(e?.message || e), horariosLivres: [], diaSolicitadoEncontrado: false };
          }
        };

        // A Frizzar já devolveu HTTP 200 + grade vazia para TODOS os barbeiros e,
        // minutos depois, dezenas de horários para a mesma data/serviço. Os casos
        // ocorreram quando este fanout disparava as consultas simultaneamente com
        // o mesmo token. Portanto consultamos sequencialmente e uma resposta
        // totalmente vazia precisa ser reproduzida em 3 rodadas independentes
        // antes de poder significar "sem vaga".
        const consultarRodada = async (rodada: number) => {
          const rodadaResultados: any[] = [];
          for (const prof of profs) {
            rodadaResultados.push(await consultaUm(prof, rodada));
            if (profs.length > 1) await sleep(150);
          }
          return rodadaResultados;
        };

        let resultados = await consultarRodada(1);
        const rodadaSemVagaConfiavel = (itens: any[]) => itens.length > 0 && itens.every((r: any) =>
          !r?.erro && r?.diaSolicitadoEncontrado === true && Array.isArray(r?.horariosLivres) && r.horariosLivres.length === 0
        );

        if (rodadaSemVagaConfiavel(resultados)) {
          console.warn(`[Frizzar] grade vazia para todos na rodada 1 (${args.data}); iniciando contraprova sequencial.`);
          await sleep(800);
          const segundaRodada = await consultarRodada(2);
          if (!rodadaSemVagaConfiavel(segundaRodada)) {
            resultados = segundaRodada;
            console.warn(`[Frizzar] falso vazio detectado: rodada 2 divergiu da rodada 1 em ${args.data}.`);
          } else {
            await sleep(1600);
            const terceiraRodada = await consultarRodada(3);
            if (!rodadaSemVagaConfiavel(terceiraRodada)) {
              resultados = terceiraRodada;
              console.warn(`[Frizzar] falso vazio detectado: rodada 3 divergiu das anteriores em ${args.data}.`);
            } else {
              resultados = terceiraRodada;
              console.log(`[Frizzar] grade vazia confirmada em 3 rodadas independentes para ${args.data}.`);
            }
          }
        }
        if (sessionState) {
          const ids = resultados
            .map((r: any) => toPositiveInteger(r?.profissionalId))
            .filter((n: any): n is number => typeof n === "number");
          const existing = new Set(((sessionState as any).frizzarValidProfessionalIds || []) as number[]);
          for (const id of ids) existing.add(id);
          (sessionState as any).frizzarValidProfessionalIds = Array.from(existing).slice(0, 100);
          const nomes = (sessionState as any).frizzarProfessionalNames || {};
          for (const r of resultados) {
            const cid = toPositiveInteger(r?.profissionalId);
            const nome = typeof r?.nome === "string" ? r.nome.trim() : "";
            if (cid && nome) nomes[cid] = nome;
          }
          (sessionState as any).frizzarProfessionalNames = nomes;
        }
        if (resultados.length > 0 && resultados.every((r: any) => r?.erro && r.horariosLivres?.length === 0)) {
          const anyTransient = resultados.some((r: any) => typeof r?.erro === "string" && /status (5\d\d|429)/i.test(r.erro));
          if (anyTransient) {
            return transientErrorPayload("consultar a grade de horários", 503);
          }
        }
        const comHorario = resultados.filter((r: any) => Array.isArray(r.horariosLivres) && r.horariosLivres.length > 0);
        const comErro = resultados.filter((r: any) => r?.erro);
        const horariosConsolidados = Array.from(new Set(
          comHorario.flatMap((r: any) => r.horariosLivres)
        )).sort();

        // Se ninguém retornou horário, sondar próximos 7 dias com UM profissional
        // para não devolver só "encaminhar humano" — caso 553899459400 recebeu
        // essa mensagem mesmo com a agenda tendo vaga.
        let sugestaoProximosDias: Array<{ dia: string; totalHorarios: number }> = [];
        if (comHorario.length === 0 && profs.length > 0) {
          const probe = profs[0];
          const baseDate = new Date(`${args.data}T12:00:00-03:00`);
          if (!isNaN(baseDate.getTime())) {
            const acumulados = new Map<string, number>();
            for (let offset = 1; offset <= 7 && acumulados.size < 3; offset++) {
              const d = new Date(baseDate.getTime() + offset * 86400000);
              const proxima = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
              try {
                const res = await frizzarFetch(`/listar/horarios/${probe.codigo}/${proxima}`, { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) });
                if (!res.ok) continue;
                const parsedDias = JSON.parse(await res.text());
                if (!Array.isArray(parsedDias)) continue;
                const exato = parsedDias.find((e: any) => frizzarMatchesRequestedDay(e?.dia, proxima));
                const total = Array.isArray(exato?.horariosLivres) ? exato.horariosLivres.length : 0;
                if (total > 0) acumulados.set(proxima, total);
              } catch { /* segue para próximo dia */ }
              await sleep(120);
            }
            sugestaoProximosDias = Array.from(acumulados.entries()).map(([dia, totalHorarios]) => ({ dia, totalHorarios }));
          }
        }

        let resumo: string;
        if (comHorario.length === 0 && comErro.length > 0 && comErro.length === resultados.length) {
          resumo = `Consulta de horários falhou em ${args.data} para todos os profissionais (${comErro.length}). NÃO diga ao cliente que não há vaga; peça desculpas por instabilidade momentânea e ofereça tentar novamente.`;
        } else if (comHorario.length === 0 && comErro.length > 0) {
          resumo = `Consulta parcial em ${args.data}: ${comErro.length} profissional(is) falharam na consulta e ${resultados.length - comErro.length} responderam sem horários. NÃO afirme categoricamente "sem vaga" — os que falharam podem ter grade livre. Peça desculpas por instabilidade e ofereça reconsultar, ou pergunte outra data.`;
        } else if (comHorario.length === 0) {
          const proxTxt = sugestaoProximosDias.length > 0
            ? ` Já verifiquei os próximos dias e há vagas em: ${sugestaoProximosDias.map((s) => `${s.dia} (${s.totalHorarios} horários)`).join(", ")}. Ofereça esses dias ao cliente PRIMEIRO em vez de encaminhar humano.`
            : ` Nenhum dos próximos 7 dias retornou vaga também — aí sim ofereça encaminhar para atendimento humano.`;
          resumo = `Não foi possível confirmar a grade de ${args.data}: todos os profissionais retornaram uma resposta vazia. NÃO diga ao cliente que não há vagas nesta data.${proxTxt}`;
        } else if (comHorario.length === 1) {
          resumo = `Apenas 1 profissional livre em ${args.data}: ${comHorario[0].nome || comHorario[0].profissionalId}. NÃO pergunte preferência — proponha direto os horários dele.${comErro.length > 0 ? ` (${comErro.length} outro(s) profissional(is) falharam na consulta — mencionar apenas se cliente pedir preferência.)` : ""}`;
        } else {
          resumo = `${comHorario.length} profissionais livres em ${args.data}. Se a agenda estiver cheia de opções, pergunte se há preferência; se o cliente já disse o horário desejado, escolha sem perguntar.`;
        }

        return {
          data: args.data,
          resumo,
          disponibilidadeVerificada: comHorario.length > 0,
          totalProfissionaisLivres: comHorario.length,
          totalProfissionaisComErro: comErro.length,
          horariosConsolidados,
          profissionais: resultados,
          sugestaoProximosDias,
        };
      }

      case "agendar": {
        const body = Array.isArray(args.servicos) ? args.servicos : [];

        if (!args.clienteId || !args.dia || !args.hora || !args.profissionalId || body.length === 0) {
          return { error: "Faltam parâmetros: clienteId, dia, hora, profissionalId, servicos." };
        }

        {
          const ownerCid = toPositiveInteger((sessionState as any)?.frizzarClienteId);
          const reqCid = toPositiveInteger(args.clienteId);
          if (ownerCid && reqCid && ownerCid !== reqCid) {
            console.warn(`[Frizzar] agendar BLOCKED: clienteId=${reqCid} não pertence a esta conversa (real=${ownerCid})`);
            return {
              error: `clienteId ${reqCid} não pertence ao cliente desta conversa. Use clienteId=${ownerCid} (o retornado por buscar_cliente/cadastrar_cliente neste atendimento) antes de agendar.`,
              blocked: true,
              ownership_mismatch: true,
              clienteIdEsperado: ownerCid,
            };
          }
        }

        {
          const validProfs = ((sessionState as any)?.frizzarValidProfessionalIds || []) as number[];
          const reqPid = toPositiveInteger(args.profissionalId);
          if (Array.isArray(validProfs) && validProfs.length > 0 && reqPid && !validProfs.includes(reqPid)) {
            console.warn(`[Frizzar] agendar BLOCKED: profissionalId=${reqPid} fora dos válidos (${validProfs.join(",")})`);
            return {
              error: `profissionalId ${reqPid} não corresponde a nenhum profissional retornado por listar_profissionais/listar_horarios_geral nesta conversa. Escolha um dos códigos abaixo pelo NOME.`,
              blocked: true,
              profissionaisValidos: validProfs,
            };
          }
        }

        {
          const catalog = (((sessionState as any)?.frizzarServiceCatalog) || []) as Array<{ codigo: number; nome: string }>;
          if (Array.isArray(catalog) && catalog.length > 0) {
            const invalidCodes = body
              .map((s: any) => toPositiveInteger(s?.codigo))
              .filter((c: number | null) => c !== null && !catalog.some((s) => s.codigo === c));
            if (invalidCodes.length > 0) {
              console.warn(`[Frizzar] BLOQUEIO servicoId fora do catálogo listado: ${invalidCodes.join(", ")} (válidos: ${catalog.map((s) => `${s.codigo}=${s.nome}`).slice(0, 20).join(", ")})`);
              return {
                error: `Código(s) de serviço ${invalidCodes.join(", ")} não corresponde(m) a nenhum serviço retornado por listar_servicos nesta conversa. Escolha os códigos abaixo pelo NOME do serviço que o cliente pediu (nunca chute o código).`,
                codigosRecebidos: body.map((s: any) => s?.codigo),
                servicosValidos: catalog.map((s) => ({ codigo: s.codigo, nome: s.nome })).slice(0, 30),
                blocked: true,
              };
            }
          }
        }

        const lastListed = frizzarGetLastListed(sessionState, args.profissionalId);
        if (lastListed && Date.now() - lastListed.listedAt < 30 * 60 * 1000 && lastListed.dia !== args.dia) {
          console.warn(`[Frizzar] BLOQUEIO data divergente: listada=${lastListed.dia} vs agendar=${args.dia} (prof=${args.profissionalId}, phone=${_phoneNumber})`);
          return {
            error: `Data divergente: você listou horários para ${lastListed.dia} mas tentou agendar em ${args.dia}. Confirme a data com o cliente e chame listar_horarios para a data correta ANTES de chamar agendar.`,
            ultimaDataListada: lastListed.dia,
            diaSolicitado: args.dia,
            profissionalId: args.profissionalId,
          };
        }

        const fetchHorariosLivres = async (): Promise<{ checked: boolean; horariosLivres: string[]; outrosDias: Array<{ dia: string; horariosLivres: string[] }>; reason?: "technical_failure" }> => {
          try {
            const hRes = await frizzarFetch(`/listar/horarios/${args.profissionalId}/${args.dia}`, {
              method: "POST",
              headers: jsonHeaders,
              body: JSON.stringify(body),
            });
            const hTxt = await hRes.text();
            const hParsed = JSON.parse(hTxt);
            if (Array.isArray(hParsed)) {
              const entry = hParsed.find((d: any) => frizzarMatchesRequestedDay(d?.dia, args.dia));
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
            console.warn(`[Frizzar] pré-validação recebeu formato inesperado (não-array); bloqueando por precaução.`);
            return { checked: false, horariosLivres: [], outrosDias: [], reason: "technical_failure" };
          } catch (err) {
            console.error(`[Frizzar] pré-validação falhou tecnicamente, bloqueando por precaução:`, err);
            return { checked: false, horariosLivres: [], outrosDias: [], reason: "technical_failure" };
          }
        };

        const disponibilidadePre = await fetchHorariosLivres();
        const horariosLivresPre = disponibilidadePre.horariosLivres;
        if (!disponibilidadePre.checked && disponibilidadePre.reason === "technical_failure") {
          return {
            error: `Não consegui confirmar a grade de horários livres da Frizzar agora (instabilidade ou resposta inesperada). NÃO agende sem revalidar. Chame listar_horarios do profissional ${args.profissionalId} no dia ${args.dia} de novo antes de tentar; se o horário ${args.hora} ainda aparecer livre, tente agendar mais uma vez.`,
            dia: args.dia,
            profissionalId: args.profissionalId,
          };
        }

        // Caso 553488498243: quando o horário escolhido cai fora da lista do
        // profissional (ou ele fica sem vaga), a IA precisa oferecer OUTROS
        // BARBEIROS no mesmo dia antes de mudar de dia. Sondamos aqui e
        // devolvemos estruturado por barbeiro, com nome legível.
        const buscarHorariosOutrosProfissionais = async (): Promise<Array<{ profissionalId: number; nome: string; horariosLivres: string[] }>> => {
          const validProfs = (((sessionState as any)?.frizzarValidProfessionalIds) || []) as number[];
          const nomes = (((sessionState as any)?.frizzarProfessionalNames) || {}) as Record<string, string>;
          const outros = validProfs.filter((pid) => pid !== toPositiveInteger(args.profissionalId)).slice(0, 5);
          const resultado: Array<{ profissionalId: number; nome: string; horariosLivres: string[] }> = [];
          for (const pid of outros) {
            try {
              const r = await frizzarFetch(`/listar/horarios/${pid}/${args.dia}`, { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) });
              if (!r.ok) continue;
              const parsedDias = JSON.parse(await r.text());
              if (!Array.isArray(parsedDias)) continue;
              const exato = parsedDias.find((d: any) => frizzarMatchesRequestedDay(d?.dia, args.dia));
              const horarios = Array.isArray(exato?.horariosLivres) ? exato.horariosLivres : [];
              if (horarios.length > 0) {
                resultado.push({ profissionalId: pid, nome: nomes[String(pid)] || `Profissional ${pid}`, horariosLivres: horarios });
              }
            } catch { /* ignore */ }
            await sleep(120);
          }
          return resultado;
        };
        const nomes = (((sessionState as any)?.frizzarProfessionalNames) || {}) as Record<string, string>;
        const nomeEscolhido = nomes[String(args.profissionalId)] || `Profissional ${args.profissionalId}`;

        if (disponibilidadePre.checked && horariosLivresPre.length === 0) {
          const outrosProfs = await buscarHorariosOutrosProfissionais();
          const dica = outrosProfs.length > 0
            ? ` No MESMO DIA, ${outrosProfs.length} outro(s) barbeiro(s) têm vaga (veja horariosOutrosProfissionais). Ofereça essas opções PRIMEIRO antes de mudar de dia.`
            : ` Nenhum outro barbeiro tem vaga em ${args.dia} também; aí sim ofereça outro dia usando outrosDias.`;
          return {
            error: `${nomeEscolhido} está sem vagas em ${args.dia}.${dica} NÃO peça confirmação e NÃO tente agendar nessa data com esse profissional.`,
            profissionalNome: nomeEscolhido,
            horariosLivres: [],
            horariosOutrosProfissionais: outrosProfs,
            outrosDias: disponibilidadePre.outrosDias,
            dia: args.dia,
            profissionalId: args.profissionalId,
          };
        }
        if (disponibilidadePre.checked && !horariosLivresPre.includes(args.hora)) {
          const outrosProfs = await buscarHorariosOutrosProfissionais();
          const outrosComHora = outrosProfs.filter((p) => p.horariosLivres.includes(args.hora));
          const dica = outrosComHora.length > 0
            ? ` MAS ${outrosComHora.map((p) => p.nome).join(", ")} tem(êm) exatamente ${args.hora} livre no MESMO dia — ofereça isso ao cliente.`
            : outrosProfs.length > 0
              ? ` Outro(s) barbeiro(s) têm outras vagas no MESMO dia (veja horariosOutrosProfissionais). Ofereça essas alternativas antes de mudar de dia.`
              : ` Nenhum outro barbeiro tem vaga em ${args.dia}; aí sim ofereça horariosLivres de ${nomeEscolhido} ou outrosDias.`;
          return {
            error: `${args.hora} indisponível com ${nomeEscolhido} em ${args.dia}.${dica}`,
            profissionalNome: nomeEscolhido,
            horariosLivres: horariosLivresPre,
            horariosOutrosProfissionais: outrosProfs,
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
        {
          const validIds = (((sessionState as any)?.frizzarValidAgendasIds) || []) as number[];
          const reqId = toPositiveInteger(args.agendamentoId);
          if (validIds.length > 0 && reqId && !validIds.includes(reqId)) {
            console.warn(`[Frizzar] cancelar_agendamento BLOCKED: agendamentoId=${reqId} não pertence ao cliente (válidos: ${validIds.join(",")})`);
            return {
              error: `agendamentoId ${reqId} não pertence ao cliente desta conversa. Rode buscar_agendamentos novamente e use um dos IDs retornados.`,
              blocked: true,
              ownership_mismatch: true,
              validAgendamentoIds: validIds,
            };
          }
        }
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
  const succeeded = r.ok === true && (r.agendamentoId != null || Array.isArray(r.agendamentos));
  if (!succeeded) return null;
  let serviceName: string | undefined;
  let serviceCount = 0;
  if (Array.isArray(r.agendamentos) && r.agendamentos.length > 0) {
    serviceName = r.agendamentos[0]?.servicoNome;
    serviceCount = r.agendamentos.length;
  }
  return {
    succeeded: true,
    bookedCount: 1,
    serviceName,
    dateStr: String(args.dia || ""),
    timeStr: String(args.hora || ""),
    extraServiceCount: serviceCount > 1 ? serviceCount : undefined,
  };
}

export function extractBookedServiceNames(tc: any, _sessionState?: any): string[] {
  const r = tc?.result || {};
  const names: string[] = [];
  if (Array.isArray(r?.agendamentos)) {
    for (const item of r.agendamentos) {
      if (item?.servicoNome && !names.includes(item.servicoNome)) names.push(item.servicoNome);
    }
  }
  return names;
}
