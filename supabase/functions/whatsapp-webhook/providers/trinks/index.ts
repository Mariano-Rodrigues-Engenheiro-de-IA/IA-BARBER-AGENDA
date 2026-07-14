// ============================================================================
// PROVIDER TRINKS — módulo isolado
// ----------------------------------------------------------------------------
// Este arquivo concentra TODO o código específico da API Trinks que estava em
// `whatsapp-webhook/index.ts`. Regra do projeto:
//   "Se eu mexer na Trinks, tenho certeza que não quebrou os outros providers."
//
// ⚠️ Zero mudança de comportamento nesta extração. É pura movimentação:
//   - buildTrinksTools               (definição das tools do OpenAI)
//   - executeTrinksTool              (execução real das tools + travas)
//   - fetchActiveAppointmentsByPhone (helper usado no atalho de cancelamento)
//   - todos os helpers trinks*       (phoneVariants, resolveClienteIds, etc.)
//   - caches in-process trinksKnownProfs / trinksLastListed
//
// Dependências para fora do módulo: NENHUMA. Os utilitários pequenos
// (`normalizeUserFacingText`, `getBrasiliaDate`) são duplicados localmente pra
// manter o provider realmente independente — mesma filosofia dos módulos
// frizzar/ e appbarber/ ("1 projeto por API").
// ============================================================================

// ===================== HELPERS LOCAIS (duplicados de index.ts) =====================

const normalizeUserFacingText = (value: unknown) => String(value ?? "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .trim();

function getBrasiliaDate(): { todayDate: string; hours: number; minutes: number } {
  const now = new Date();
  const brFormatter = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const parts = brFormatter.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || "0";
  const year = parseInt(get("year"));
  const month = parseInt(get("month"));
  const day = parseInt(get("day"));
  const hours = parseInt(get("hour"));
  const minutes = parseInt(get("minute"));
  const todayDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { todayDate, hours, minutes };
}

// ===================== TRINKS TOOLS =====================

export function buildTrinksTools(tenant: any) {
  if (!tenant.trinks_api_key || !tenant.trinks_establishment_id) return undefined;

  return [
    {
      type: "function",
      function: {
        name: "buscar_cliente",
        description: "Busca um cliente pelo telefone. Use SEMPRE como primeira ação para verificar se o cliente existe. Se retornar totalRecords: 0 ou data: [] → cliente não existe, usar cadastrar_cliente. Se retornar dados → guardar o id do cliente.",
        parameters: {
          type: "object",
          properties: {
            telefone: { type: "string", description: "Telefone do cliente (DDD+número, sem código do país)" },
          },
          required: ["telefone"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "cadastrar_cliente",
        description: "Cadastra um novo cliente no sistema Trinks. Use quando buscar_cliente retornar vazio (cliente não existe). Envie o nome do cliente e o telefone.",
        parameters: {
          type: "object",
          properties: {
            nome: { type: "string", description: "Nome do cliente" },
            telefone: { type: "string", description: "Telefone completo do cliente (com DDD)" },
          },
          required: ["nome", "telefone"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "listar_profissionais",
        description: "Lista todos os profissionais/barbeiros do estabelecimento. Retorna lista com: id, nome, apelido.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: "listar_servicos",
        description: "Lista todos os serviços disponíveis no estabelecimento. Retorna lista com: id, nome, descricao, categoria, duracaoEmMinutos, preco.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: "listar_servicos_profissional",
        description: "Lista os serviços que um profissional específico realiza. SOMENTE PARA CONSULTA. O ID retornado NÃO deve ser usado como profissionalId no criar_agendamento. Para profissionalId, use EXCLUSIVAMENTE listar_profissionais.",
        parameters: {
          type: "object",
          properties: {
            profissionalId: { type: "integer", description: "ID numérico do profissional (obtido de listar_profissionais)" },
          },
          required: ["profissionalId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "listar_horarios",
        description: "Lista os horários disponíveis dos profissionais em uma data. Retorna lista de profissionais com seus horariosVagos. Use APENAS horariosVagos, IGNORE intervalosVagos.",
        parameters: {
          type: "object",
          properties: {
            data: { type: "string", description: "Data no formato YYYY-MM-DD" },
            servicoDuracao: { type: "integer", description: "Duração do serviço em minutos (obtido de listar_servicos)" },
          },
          required: ["data", "servicoDuracao"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "buscar_agendamento",
        description: "Busca os agendamentos de um cliente. Pode passar clienteId OU telefone (o sistema resolve automaticamente). Se retornar data: [] → cliente não tem agendamentos. Guardar o id do agendamento para cancelar ou editar.",
        parameters: {
          type: "object",
          properties: {
            clienteId: { type: "integer", description: "ID do cliente (obtido de buscar_cliente). Opcional se telefone for informado." },
            telefone: { type: "string", description: "Telefone do cliente. Se informado, o sistema busca o clienteId automaticamente." },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "criar_agendamento",
        description: "Cria um agendamento para o cliente. ⚠️ SÓ EXECUTE DEPOIS QUE O CLIENTE CONFIRMAR EXPLICITAMENTE (respondeu 'sim', 'ok', 'pode', etc.). NUNCA execute logo após o cliente escolher um horário — primeiro mostre o resumo e AGUARDE confirmação. ANTES de usar, DEVE ter: clienteId, servicoId, duracaoEmMinutos, valor (de listar_servicos), profissionalId (de listar_profissionais), dataHoraInicio no formato YYYY-MM-DDTHH:mm:ss.",
        parameters: {
          type: "object",
          properties: {
            servicoId: { type: "integer", description: "ID do serviço" },
            clienteId: { type: "integer", description: "ID do cliente" },
            profissionalId: { type: "integer", description: "ID do profissional" },
            dataHoraInicio: { type: "string", description: "Data e hora no formato YYYY-MM-DDTHH:mm:ss" },
            duracaoEmMinutos: { type: "integer", description: "Duração em minutos" },
            valor: { type: "number", description: "Valor do serviço" },
          },
          required: ["servicoId", "clienteId", "profissionalId", "dataHoraInicio", "duracaoEmMinutos", "valor"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "cancelar_agendamento",
        description: "Cancela um agendamento. Use SOMENTE agendamentoId real vindo de buscar_agendamento na interação atual. Se o cliente pedir 'os 2', 'ambos' ou 'todos', chame esta ferramenta uma vez para cada ID real. Se a ferramenta retornar code='agendamento_id_invalido', reutilize imediatamente os IDs de agendamentosAtivos.",
        parameters: {
          type: "object",
          properties: {
            agendamentoId: { type: "integer", description: "ID real do agendamento (obtido de buscar_agendamento na interação atual)" },
            motivo: { type: "string", description: "Motivo do cancelamento" },
          },
          required: ["agendamentoId", "motivo"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "editar_agendamento",
        description: "Edita/remarca um agendamento existente. ANTES de usar, DEVE ter: agendamentoId (de buscar_agendamento), e os novos dados. Resposta vazia = sucesso.",
        parameters: {
          type: "object",
          properties: {
            agendamentoId: { type: "integer", description: "ID do agendamento (obtido de buscar_agendamento)" },
            servicoId: { type: "integer", description: "ID do serviço" },
            clienteId: { type: "integer", description: "ID do cliente" },
            profissionalId: { type: "integer", description: "ID do profissional" },
            dataHoraInicio: { type: "string", description: "Nova data e hora no formato YYYY-MM-DDTHH:mm:ss" },
            duracaoEmMinutos: { type: "integer", description: "Duração em minutos" },
            valor: { type: "number", description: "Valor do serviço" },
          },
          required: ["agendamentoId", "servicoId", "clienteId", "profissionalId", "dataHoraInicio", "duracaoEmMinutos", "valor"],
        },
      },
    },
  ];
}

// ===================== TRINKS TOOL EXECUTION =====================

// 🚨 TRAVAS TRINKS (in-process, sobrevivem entre invocações warm)
// Cache de IDs válidos de profissionais por tenant (TTL 30min) — bloqueia IDs alucinados (ex.: 1, 1001).
const trinksKnownProfs = new Map<string, { ids: Set<number>; fetchedAt: number }>();
// Cache da última `listar_horarios` por conversa — { data, slotsByProf: prof->Set<HH:MM> }
// Bloqueia `criar_agendamento` em horário/data fora do que foi efetivamente consultado.
const trinksLastListed = new Map<string, { data: string; slotsByProf: Map<number, Set<string>>; listedAt: number }>();
const TRINKS_CACHE_TTL_MS = 30 * 60 * 1000;

// Gera variantes brasileiras de telefone (com/sem 55, com/sem 9º dígito).
function trinksPhoneVariants(raw: string): string[] {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return [];
  const variants = new Set<string>();
  const add = (v: string) => { const d = v.replace(/\D/g, ""); if (d.length >= 10 && d.length <= 13) variants.add(d); };
  let local = digits;
  if (local.startsWith("55") && (local.length === 12 || local.length === 13)) local = local.slice(2);
  while (local.startsWith("0") && local.length > 10) local = local.slice(1);
  add(local);
  if (local.length === 10) add(`${local.slice(0, 2)}9${local.slice(2)}`);
  if (local.length === 11 && local[2] === "9") add(`${local.slice(0, 2)}${local.slice(3)}`);
  for (const v of Array.from(variants)) add(`55${v}`);
  return Array.from(variants);
}

async function trinksFetchClientesByTelefone(baseUrl: string, headers: Record<string, string>, telefone: string): Promise<any[]> {
  const search = new URLSearchParams({ telefone, pageSize: "100" });
  try {
    const r = await fetch(`${baseUrl}/clientes?${search.toString()}`, { headers });
    const j = await r.json();
    if (!r.ok) {
      console.warn(`[Trinks] falha /clientes ${search.toString()}: status=${r.status} body=${JSON.stringify(j).slice(0, 300)}`);
      return [];
    }
    const list = Array.isArray(j?.data) ? j.data : (Array.isArray(j) ? j : []);
    return list;
  } catch (e) {
    console.warn(`[Trinks] falha /clientes ${search.toString()}: ${(e as Error).message}`);
    return [];
  }
}

// Formata data YYYY-MM-DD (local).
function trinksFmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Retorna janela padrão usada em /agendamentos (ontem → +120 dias).
// Trinks EXIGE dataInicio + dataFim — sem eles, retorna vazio.
function trinksAgendaWindow(): { dataInicio: string; dataFim: string } {
  const now = new Date();
  const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const to = new Date(now.getTime() + 120 * 24 * 60 * 60 * 1000);
  return { dataInicio: trinksFmtDate(from), dataFim: trinksFmtDate(to) };
}

// Resolve TODOS os clienteIds de um telefone (cobre cadastros duplicados na Trinks).
export async function trinksResolveClienteIds(baseUrl: string, headers: Record<string, string>, phone: string): Promise<number[]> {
  const clienteIds: number[] = [];
  const seen = new Set<number>();
  const clienteRecs = new Map<number, any>();
  const variants = trinksPhoneVariants(phone);
  if (variants.length === 0) return [];

  const initial = await Promise.all(variants.map(async (tel) => {
    try {
      return await trinksFetchClientesByTelefone(baseUrl, headers, tel);
    } catch { return []; }
  }));
  for (const list of initial) {
    for (const c of list) {
      const cid = Number(c.id || c.Id);
      if (Number.isFinite(cid) && !seen.has(cid)) { seen.add(cid); clienteIds.push(cid); clienteRecs.set(cid, c); }
    }
  }

  // Telefones adicionais do cadastro Trinks (pode revelar outros IDs)
  const stored = new Set<string>();
  for (const c of clienteRecs.values()) {
    const tels = Array.isArray(c.telefones) ? c.telefones : (Array.isArray(c.Telefones) ? c.Telefones : []);
    for (const t of tels) {
      const ddd = String(t.ddd || t.Ddd || "");
      const num = String(t.numero || t.Numero || "");
      if (ddd && num) for (const v of trinksPhoneVariants(`${ddd}${num}`)) stored.add(v);
    }
  }
  const extras = [...stored].filter((p) => !variants.includes(p));
  if (extras.length > 0) {
    const extraResults = await Promise.all(extras.map(async (tel) => {
      try {
        return await trinksFetchClientesByTelefone(baseUrl, headers, tel);
      } catch { return []; }
    }));
    for (const list of extraResults) {
      for (const c of list) {
        const cid = Number(c.id || c.Id);
        if (Number.isFinite(cid) && !seen.has(cid)) { seen.add(cid); clienteIds.push(cid); }
      }
    }
  }
  return clienteIds;
}

function trinksAppointmentStatusName(appointment: any): string {
  return String(appointment?.status?.nome || appointment?.status || "").trim();
}

function trinksIsActionableAppointment(appointment: any): boolean {
  const statusName = normalizeUserFacingText(trinksAppointmentStatusName(appointment));
  // A Trinks pode retornar variações de status por estabelecimento. Para remarcação/cancelamento,
  // é mais seguro considerar ativo tudo que ainda não é claramente finalizado/cancelado.
  if (!statusName) return true;
  const finalStatuses = [
    "cancelado",
    "cancelada",
    "desmarcado",
    "desmarcada",
    "finalizado",
    "finalizada",
    "concluido",
    "concluida",
    "realizado",
    "realizada",
    "atendido",
    "atendida",
    "faltou",
    "ausente",
    "nao compareceu",
    "no show",
  ];
  return !finalStatuses.some((s) => statusName.includes(s));
}

async function trinksFetchAgendamentos(baseUrl: string, headers: Record<string, string>, params: Record<string, string | number>): Promise<any[]> {
  const { dataInicio, dataFim } = trinksAgendaWindow();
  const search = new URLSearchParams({ dataInicio, dataFim });
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value).trim()) search.set(key, String(value));
  }

  try {
    const r = await fetch(`${baseUrl}/agendamentos?${search.toString()}`, { headers });
    const j = await r.json();
    if (!r.ok) {
      console.warn(`[Trinks] falha /agendamentos ${search.toString()}: status=${r.status} body=${JSON.stringify(j).slice(0, 300)}`);
      return [];
    }
    const list = Array.isArray(j?.data) ? j.data : (Array.isArray(j) ? j : []);
    return list;
  } catch (e) {
    console.warn(`[Trinks] falha /agendamentos ${search.toString()}: ${(e as Error).message}`);
    return [];
  }
}

// Lista agendamentos acionáveis por clienteId e, como fallback obrigatório, por telefone direto.
// Na Trinks existem casos em que /clientes?telefone retorna um cadastro, mas /agendamentos?clienteId
// não traz o agendamento que /agendamentos?telefone encontra. Por isso usamos os dois caminhos.
export async function trinksListActiveByClienteIds(baseUrl: string, headers: Record<string, string>, clienteIds: number[], phone?: string, opts?: { includeInactive?: boolean }): Promise<any[]> {
  const queries: Record<string, string | number>[] = [];
  for (const cid of clienteIds) {
    if (Number.isFinite(Number(cid))) queries.push({ clienteId: Number(cid) });
  }
  if (phone) {
    for (const telefone of trinksPhoneVariants(phone)) queries.push({ telefone });
  }
  if (queries.length === 0) return [];

  const results = await Promise.all(queries.map((params) => trinksFetchAgendamentos(baseUrl, headers, params)));
  const seen = new Set<number>();
  const out: any[] = [];
  for (const list of results) {
    for (const a of list) {
      // Para LEITURA (buscar_agendamento), incluímos até finalizados/realizados —
      // o cliente pode estar só perguntando "tá confirmado hoje?" sobre um
      // agendamento que a barbearia já marcou como Finalizado no sistema.
      // Para cancelar/remarcar o filtro estrito continua valendo (default).
      if (!opts?.includeInactive && !trinksIsActionableAppointment(a)) continue;
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      out.push(a);
    }
  }

  // 🚨 FIX — o parâmetro `telefone` mandado direto pro /agendamentos da Trinks
  // parece NÃO filtrar do lado da API (evidência real de produção: consulta sem
  // nenhum clienteId resolvido ainda assim devolveu dezenas de agendamentos de
  // clientes completamente diferentes). Sem esse filtro extra, isso vazava dados
  // de outros clientes pra conversa errada, e causava rejeição de cancelamentos
  // válidos (o mesmo agendamento "sumia" entre uma chamada e outra).
  //
  // Mantemos a busca por telefone (o comentário original documenta casos reais
  // em que ela achava agendamento que a busca só por clienteId perdia), mas
  // filtramos o resultado combinado: só aceita um agendamento se o `cliente.id`
  // que a própria Trinks devolveu bater com um dos clienteIds que JÁ resolvemos
  // com confiança (via /clientes?telefone=, que filtra corretamente). Se não
  // resolvemos NENHUM clienteId, não há como validar com segurança — devolve
  // vazio em vez de confiar cegamente na busca por telefone.
  const knownIds = new Set(clienteIds.map((c) => Number(c)).filter((c) => Number.isFinite(c)));
  if (knownIds.size === 0) return [];
  const filtered = out.filter((a) => knownIds.has(Number(a?.cliente?.id)));

  filtered.sort((a, b) => String(a.dataHoraInicio || "").localeCompare(String(b.dataHoraInicio || "")));
  return filtered;
}

// Atalho usado pelo fluxo determinístico de confirmação direta de cancelamento
// (fora do laço da IA). Retorna lista simplificada dos agendamentos ativos do
// telefone informado. Continua Trinks-only (guardado pelas credenciais).
export async function fetchActiveAppointmentsByPhone(tenant: any, phoneNumber: string) {
  if (!tenant?.trinks_api_key || !tenant?.trinks_establishment_id || !phoneNumber) return [];

  const baseUrl = "https://api.trinks.com/v1";
  const headers: Record<string, string> = {
    "X-Api-Key": tenant.trinks_api_key,
    "Accept": "application/json",
    "estabelecimentoId": tenant.trinks_establishment_id,
  };

  try {
    const clienteIds = await trinksResolveClienteIds(baseUrl, headers, phoneNumber);
    const activeRaw = await trinksListActiveByClienteIds(baseUrl, headers, clienteIds, phoneNumber);
    return activeRaw.map((a: any) => ({
      id: a.id,
      status: a.status?.nome,
      servico: a.servico?.nome,
      profissional: a.profissional?.nome,
      clienteId: a.cliente?.id,
      dataHoraInicio: a.dataHoraInicio,
    }));
  } catch (error) {
    console.error("fetchActiveAppointmentsByPhone error:", error);
    return [];
  }
}

export async function executeTrinksTool(tenant: any, toolCall: any, phoneNumber?: string, sessionState?: any): Promise<any> {
  const funcName = toolCall.function.name;
  let args: any = {};
  try { args = JSON.parse(toolCall.function.arguments || "{}"); } catch { /* empty */ }

  const baseUrl = "https://api.trinks.com/v1";
  const headers: Record<string, string> = {
    "X-Api-Key": tenant.trinks_api_key,
    "Accept": "application/json",
    "estabelecimentoId": tenant.trinks_establishment_id,
  };

  try {
    switch (funcName) {
      case "buscar_cliente": {
        let tel = (args.telefone || "").replace(/\D/g, "");
        if (tel.startsWith("55") && tel.length >= 12) tel = tel.substring(2);
        const ddd = tel.substring(0, 2);
        let rest = tel.substring(2);
        if (rest.length === 8) rest = "9" + rest;
        tel = ddd + rest;

        const url = `${baseUrl}/clientes?telefone=${tel}`;
        console.log(`buscar_cliente URL: ${url}`);
        const res = await fetch(url, { headers });
        const text = await res.text();
        console.log(`buscar_cliente response (${res.status}):`, text.slice(0, 500));
        try { return JSON.parse(text); } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "cadastrar_cliente": {
        let tel = (args.telefone || "").replace(/\D/g, "");
        // Remove DDI 55 repetidamente (cobre casos com "55" duplicado vindos do WhatsApp/AI)
        while (tel.startsWith("55") && tel.length > 11) tel = tel.substring(2);
        // Remove zero à esquerda do DDD (ex.: "035...")
        while (tel.startsWith("0") && tel.length > 11) tel = tel.substring(1);

        const ddd = tel.substring(0, 2);
        let numero = tel.substring(2);
        // Garante 9º dígito para celulares brasileiros
        if (numero.length === 8) numero = "9" + numero;

        if (!ddd || ddd.length !== 2 || numero.length !== 9) {
          const err = `Telefone inválido após normalização: original="${args.telefone}", ddd="${ddd}", numero="${numero}". Esperado DDD(2) + numero(9, iniciando em 9).`;
          console.error(`cadastrar_cliente ${err}`);
          return { error: err };
        }

        const body = {
          nome: args.nome,
          telefones: [{ ddi: "55", ddd, numero, tipoId: 1 }],
        };
        console.log("cadastrar_cliente body:", JSON.stringify(body));
        const res = await fetch(`${baseUrl}/clientes`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        console.log(`cadastrar_cliente response (${res.status}):`, text.slice(0, 500));
        try { return JSON.parse(text); } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "listar_profissionais": {
        const res = await fetch(`${baseUrl}/profissionais`, { headers });
        const data = await res.json();
        const list = data?.data || data;
        if (Array.isArray(list)) {
          const mapped = list.map((p: any) => ({
            id: p.id || p.Id,
            nome: p.nome || p.Nome,
            apelido: p.apelido || p.Apelido,
          }));
          // Popula cache de IDs válidos para travar alucinação em criar_agendamento.
          const ids = new Set<number>(mapped.map((p: any) => Number(p.id)).filter((n: number) => Number.isFinite(n)));
          trinksKnownProfs.set(tenant.id, { ids, fetchedAt: Date.now() });
          console.log(`[Trinks] cache profs atualizado: tenant=${tenant.id} ids=${[...ids].join(",")}`);
          return mapped;
        }
        return data;
      }

      case "listar_servicos": {
        const res = await fetch(`${baseUrl}/servicos?somenteVisiveisCliente=true`, { headers });
        const data = await res.json();
        const list = data?.data || data;
        if (Array.isArray(list)) {
          return list.map((s: any) => ({
            id: s.id || s.Id,
            nome: s.nome || s.Nome,
            descricao: s.descricao || s.Descricao || "",
            preco: s.preco || s.Preco || s.valor || s.Valor,
            duracaoEmMinutos: s.duracaoEmMinutos || s.DuracaoEmMinutos || s.duracao,
            categoria: s.categoria || s.Categoria,
          }));
        }
        return data;
      }

      case "listar_servicos_profissional": {
        const profId = args.profissionalId;
        const res = await fetch(`${baseUrl}/profissionais/${profId}/servicos`, { headers });
        const data = await res.json();
        const list = data?.data || data;
        if (Array.isArray(list)) {
          return list.map((s: any) => ({
            id: s.id || s.Id,
            nome: s.nome || s.Nome,
            duracaoEmMinutos: s.duracaoEmMinutos || s.DuracaoEmMinutos || s.duracao,
            preco: s.preco || s.Preco || s.valor || s.Valor,
          }));
        }
        return data;
      }

      case "listar_horarios": {
        const url = `${baseUrl}/agendamentos/profissionais/${args.data}?servicoDuracao=${args.servicoDuracao}`;
        console.log(`listar_horarios URL: ${url}`);
        const res = await fetch(url, { headers });
        const text = await res.text();
        console.log(`listar_horarios response (${res.status}):`, text.slice(0, 1000));
        try {
          const parsed = JSON.parse(text);

          const br = getBrasiliaDate();
          const todayStr = br.todayDate;
          const currentHHMM = `${String(br.hours).padStart(2, '0')}:${String(br.minutes).padStart(2, '0')}`;

          if (args.data === todayStr) {
            const profissionais = parsed?.data || parsed;
            if (Array.isArray(profissionais)) {
              for (const prof of profissionais) {
                if (Array.isArray(prof.horariosVagos)) {
                  const before = prof.horariosVagos.length;
                  prof.horariosVagos = prof.horariosVagos.filter((h: string) => h > currentHHMM);
                  console.log(`Filtered past times for ${prof.nome || prof.id}: ${before} → ${prof.horariosVagos.length} (now: ${currentHHMM})`);
                }
              }
            }
          }

          // ===== FILTRO ANTI-BURACO (greedy slot packing) =====
          // Para cada profissional, mantém um slot e descarta os próximos que
          // cairiam dentro da janela [inicio, inicio+duracao). Isso evita que
          // a IA ofereça 9:00 + 9:20 (que criariam um buraco órfão de 20min
          // quando o cliente escolher um dos dois). Aplicado SEMPRE — se um
          // slot intermediário é o único disponível, ele continua sendo o
          // primeiro da lista e portanto é preservado.
          try {
            const dur = Number(args.servicoDuracao);
            const profissionais = parsed?.data || parsed;
            if (Array.isArray(profissionais) && Number.isFinite(dur) && dur > 0) {
              const toMin = (h: string) => {
                const [hh, mm] = String(h).slice(0, 5).split(":").map(Number);
                return hh * 60 + mm;
              };
              for (const prof of profissionais) {
                if (!Array.isArray(prof.horariosVagos) || prof.horariosVagos.length === 0) continue;
                const sorted = [...prof.horariosVagos]
                  .map((h: string) => String(h).slice(0, 5))
                  .filter((h: string) => /^\d{2}:\d{2}$/.test(h))
                  .sort();
                const kept: string[] = [];
                let nextAllowed = -Infinity;
                for (const h of sorted) {
                  const m = toMin(h);
                  if (m >= nextAllowed) {
                    kept.push(h);
                    nextAllowed = m + dur;
                  }
                }
                const before = prof.horariosVagos.length;
                prof.horariosVagos = kept;
                console.log(`[AntiBuraco] ${prof.nome || prof.id}: ${before} → ${kept.length} slots (dur=${dur}min)`);
              }
            }
          } catch (e) { console.warn("[AntiBuraco] falha:", (e as Error).message); }

          // Popula cache de slots reais por profissional para travar criar_agendamento alucinado.
          try {
            const profissionais = parsed?.data || parsed;
            if (Array.isArray(profissionais) && args.data) {
              const slotsByProf = new Map<number, Set<string>>();
              for (const prof of profissionais) {
                const pid = Number(prof?.id || prof?.Id);
                if (!Number.isFinite(pid)) continue;
                const slots = new Set<string>(
                  Array.isArray(prof.horariosVagos) ? prof.horariosVagos.map((h: string) => String(h).slice(0, 5)) : []
                );
                slotsByProf.set(pid, slots);
              }
              const key = `${tenant.id}:${phoneNumber || ""}`;
              trinksLastListed.set(key, { data: args.data, slotsByProf, listedAt: Date.now() });
              console.log(`[Trinks] cache horários: ${key} data=${args.data} profs=${slotsByProf.size}`);
            }
          } catch (e) { console.warn("[Trinks] falha ao cachear horários:", (e as Error).message); }

          // ===== AGENDAMENTO INTELIGENTE (consolidação) =====
          // Enriquecemos o retorno com uma visão consolidada para a IA decidir
          // sem perguntar "tem preferência de barbeiro?" quando não for necessário.
          try {
            const profissionais = (parsed?.data || parsed) as any[];
            if (Array.isArray(profissionais)) {
              const profsLivres = profissionais
                .filter((p) => Array.isArray(p?.horariosVagos) && p.horariosVagos.length > 0)
                .map((p) => ({
                  id: Number(p?.id || p?.Id),
                  nome: p?.nome || p?.Nome || "",
                  qtdHorarios: p.horariosVagos.length,
                  primeirosHorarios: p.horariosVagos.slice(0, 6),
                }));

              const consolidado: Record<string, Array<{ id: number; nome: string }>> = {};
              for (const p of profissionais) {
                if (!Array.isArray(p?.horariosVagos)) continue;
                const pid = Number(p?.id || p?.Id);
                const pnome = p?.nome || p?.Nome || "";
                for (const h of p.horariosVagos) {
                  const slot = String(h).slice(0, 5);
                  if (!consolidado[slot]) consolidado[slot] = [];
                  consolidado[slot].push({ id: pid, nome: pnome });
                }
              }

              let dica = "";
              if (profsLivres.length === 0) {
                dica = "NENHUM profissional livre nessa data. Ofereça outro dia — NÃO pergunte preferência de barbeiro.";
              } else if (profsLivres.length === 1) {
                dica = `APENAS 1 profissional livre (${profsLivres[0].nome}). NÃO pergunte preferência — ofereça direto os horários desse barbeiro.`;
              } else {
                dica = "Múltiplos profissionais livres. Se o cliente JÁ mencionou um horário, escolha automaticamente um barbeiro disponível naquele horário (sem perguntar). Se não mencionou horário, ofereça opções consolidadas OU pergunte preferência.";
              }

              (parsed as any).profissionaisLivres = profsLivres;
              (parsed as any).horariosConsolidados = consolidado;
              (parsed as any).dica = dica;
            }
          } catch (e) { console.warn("[Trinks] falha ao consolidar horários:", (e as Error).message); }

          return parsed;
        } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "buscar_agendamento": {
        const clienteIds: number[] = [];
        if (args.clienteId) clienteIds.push(Number(args.clienteId));

        const resolvePhone = phoneNumber || args.telefone || "";
        if (resolvePhone) {
          const resolved = await trinksResolveClienteIds(baseUrl, headers, resolvePhone);
          for (const cid of resolved) if (!clienteIds.includes(cid)) clienteIds.push(cid);
          console.log(`buscar_agendamento: total ${clienteIds.length} clienteId(s): ${clienteIds.join(",")}`);
        }

        if (clienteIds.length === 0 && !resolvePhone) {
          return { data: [], message: "Cliente não encontrado" };
        }

        const activeRaw = await trinksListActiveByClienteIds(baseUrl, headers, clienteIds, resolvePhone, { includeInactive: true });
        const allActive = activeRaw.map((a: any) => ({
          id: a.id,
          status: a.status?.nome,
          servico: a.servico?.nome,
          profissional: a.profissional?.nome,
          clienteId: a.cliente?.id,
          dataHoraInicio: a.dataHoraInicio,
          duracaoEmMinutos: a.duracaoEmMinutos,
          valor: a.valor,
          servicoId: a.servico?.id,
          profissionalId: a.profissional?.id,
        }));

        // Separa ativos (Agendado/Confirmado/qualquer status não-final) de inativos
        // (Cancelado/Finalizado/Realizado/etc). A IA precisa dessa distinção pra
        // não dizer "não achei agendamento" quando na verdade só existe Cancelado,
        // e pra tratar Finalizado no FUTURO como confirmação (a barbearia costuma
        // marcar agendamentos futuros como Finalizado por engano no sistema).
        const ativos: any[] = [];
        const inativos: any[] = [];
        for (const a of allActive) {
          const s = normalizeUserFacingText(a.status || "");
          const isCancelado = /cancel|desmarc|faltou|ausente|no ?show|nao compareceu/.test(s);
          const isFinalizado = /finaliz|conclu|realiz|atendid/.test(s);
          if (isCancelado) {
            inativos.push({ ...a, _categoria: "cancelado" });
          } else if (isFinalizado) {
            const dt = a.dataHoraInicio ? new Date(a.dataHoraInicio).getTime() : 0;
            // Finalizado com data no futuro (ou hoje ainda por vir) provavelmente
            // é agendamento confirmado marcado por engano — tratamos como ativo.
            if (dt && dt > Date.now() - 6 * 60 * 60 * 1000) {
              ativos.push({ ...a, _categoria: "confirmado_marcado_como_finalizado" });
            } else {
              inativos.push({ ...a, _categoria: "finalizado" });
            }
          } else {
            ativos.push({ ...a, _categoria: "ativo" });
          }
        }

        const resumo = ativos.length > 0
          ? `Encontrei ${ativos.length} agendamento(s) ativo(s).${inativos.length > 0 ? ` (${inativos.length} inativo(s) foram ignorados — NÃO os mencione ao cliente a menos que ele pergunte especificamente.)` : ""}`
          : (inativos.length > 0
              ? `NÃO há agendamentos ATIVOS, mas EXISTE(M) ${inativos.length} agendamento(s) INATIVO(S): ${inativos.map(i => `${i._categoria} (${i.servico} em ${i.dataHoraInicio})`).join("; ")}. Informe ao cliente o status real (ex: "seu agendamento consta como Cancelado no sistema") — NUNCA diga "não achei nenhum agendamento".`
              : "Nenhum agendamento encontrado para este cliente.");

        return {
          data: ativos,
          agendamentosAtivos: ativos,
          agendamentosInativos: inativos,
          totalAtivos: ativos.length,
          totalInativos: inativos.length,
          totalRecords: allActive.length,
          clienteIdsConsultados: clienteIds,
          resumo,
        };
      }

      case "criar_agendamento": {
        // 🚨 TRAVA 0 — campos obrigatórios vazios. Evita 400/500 silencioso na Trinks
        // e impede a IA de chutar agendamento sem ter coletado os dados.
        const missing: string[] = [];
        if (!args.servicoId && !Number(args.servicoId)) missing.push("servicoId");
        if (!args.profissionalId && !Number(args.profissionalId)) missing.push("profissionalId");
        if (!args.dataHoraInicio || typeof args.dataHoraInicio !== "string") missing.push("dataHoraInicio");
        if (!args.duracaoEmMinutos && !Number(args.duracaoEmMinutos)) missing.push("duracaoEmMinutos");
        if (args.valor === undefined || args.valor === null || args.valor === "") missing.push("valor");
        if (missing.length > 0) {
          console.warn(`[Trinks] BLOQUEIO criar_agendamento campos vazios: ${missing.join(", ")}`);
          return {
            error: `Campos obrigatórios ausentes em criar_agendamento: ${missing.join(", ")}. Obtenha esses valores das tools (listar_servicos, listar_profissionais, listar_horarios) ANTES de chamar criar_agendamento.`,
            camposFaltantes: missing,
            blocked: true,
          };
        }

        // 🚨 TRAVA 0.5 — servicoId alucinado (não veio de listar_servicos desta conversa).
        // Caso real: IA passou servicoId=2461 ("Unha de Fibra de Vidro — Manutenção") no
        // lugar do serviço de corte que o cliente pediu. A API aceita porque o serviço
        // existe no estabelecimento, mas o cliente recebe algo completamente diferente.
        // Aqui bloqueamos qualquer código que não tenha vindo de um listar_servicos
        // desta mesma conversa.
        {
          const catalog = (((sessionState as any)?.trinksServiceCatalog) || []) as Array<{ id: number; nome: string; duracao: number }>;
          if (Array.isArray(catalog) && catalog.length > 0) {
            const reqSid = Number(args.servicoId);
            if (!Number.isFinite(reqSid) || !catalog.some((s) => s.id === reqSid)) {
              console.warn(`[Trinks] BLOQUEIO servicoId fora do catálogo listado: ${args.servicoId} (válidos: ${catalog.map((s) => `${s.id}=${s.nome}`).slice(0, 20).join(", ")})`);
              return {
                error: `servicoId ${args.servicoId} não corresponde a nenhum serviço retornado por listar_servicos nesta conversa. Escolha um dos ids abaixo pelo NOME do serviço que o cliente pediu (nunca chute o código).`,
                servicoIdRecebido: args.servicoId,
                servicosValidos: catalog.map((s) => ({ id: s.id, nome: s.nome })).slice(0, 30),
                blocked: true,
              };
            }
          }
        }


        let resolvedClienteId = args.clienteId;


        if (phoneNumber) {
          const resolvedIds = await trinksResolveClienteIds(baseUrl, headers, phoneNumber);
          if (resolvedIds.length > 0) {
            resolvedClienteId = resolvedIds[0];
            console.log(`criar_agendamento: resolved clienteId=${resolvedClienteId} from phone`);
          }
        }

        let dataHoraInicio = args.dataHoraInicio || "";
        if (dataHoraInicio.includes(" ")) dataHoraInicio = dataHoraInicio.replace(" ", "T");
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dataHoraInicio)) dataHoraInicio += ":00";

        // 🚨 TRAVA 1 — profissionalId alucinado.
        const profCache = trinksKnownProfs.get(tenant.id);
        const profId = Number(args.profissionalId);
        if (profCache && Date.now() - profCache.fetchedAt < TRINKS_CACHE_TTL_MS) {
          if (!Number.isFinite(profId) || !profCache.ids.has(profId)) {
            console.warn(`[Trinks] BLOQUEIO profissionalId inválido: ${args.profissionalId} (válidos: ${[...profCache.ids].join(",")})`);
            return {
              error: `profissionalId inválido: ${args.profissionalId}. Use APENAS um ID retornado por listar_profissionais.`,
              profissionalIdRecebido: args.profissionalId,
              profissionaisValidos: [...profCache.ids],
              blocked: true,
            };
          }
        }

        // 🚨 TRAVA 2 — data/horário fora do que foi listado.
        const slotsCache = trinksLastListed.get(`${tenant.id}:${phoneNumber || ""}`);
        if (slotsCache && Date.now() - slotsCache.listedAt < TRINKS_CACHE_TTL_MS) {
          const m = dataHoraInicio.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
          if (m) {
            const [_, dataReq, horaReq] = m;
            if (dataReq !== slotsCache.data) {
              console.warn(`[Trinks] BLOQUEIO data divergente: listada=${slotsCache.data} vs agendar=${dataReq}`);
              return {
                error: `Data divergente: você listou horários para ${slotsCache.data} mas tentou agendar em ${dataReq}. Chame listar_horarios para a data correta ANTES de criar_agendamento.`,
                ultimaDataListada: slotsCache.data,
                dataSolicitada: dataReq,
                blocked: true,
              };
            }
            const slotsProf = Number.isFinite(profId) ? slotsCache.slotsByProf.get(profId) : undefined;
            if (slotsProf && slotsProf.size > 0 && !slotsProf.has(horaReq)) {
              console.warn(`[Trinks] BLOQUEIO horário fora da grade: prof=${profId} hora=${horaReq} disponíveis=${[...slotsProf].join(",")}`);
              return {
                error: `Horário ${horaReq} não está disponível em ${dataReq} para o profissional ${profId}. Escolha um dos horários abaixo e tente novamente.`,
                horariosDisponiveis: [...slotsProf],
                data: dataReq,
                profissionalId: profId,
                blocked: true,
              };
            }
          }
        }


        // Check for duplicates — usa TODOS os clienteIds do telefone (cobre cadastros duplicados)
        try {
          const dedupIds: number[] = [];
          if (resolvedClienteId) dedupIds.push(Number(resolvedClienteId));
          if (phoneNumber) {
            const extra = await trinksResolveClienteIds(baseUrl, headers, phoneNumber);
            for (const cid of extra) if (!dedupIds.includes(cid)) dedupIds.push(cid);
          }
          const activeAg = await trinksListActiveByClienteIds(baseUrl, headers, dedupIds, phoneNumber);
          // Duplicata de verdade = mesmo cliente + mesma data/hora + MESMO profissional.
          // Duas pessoas diferentes (mesmo clienteId na Trinks, já que não há campo "de quem")
          // podem legitimamente ter agendamentos no mesmo horário com profissionais diferentes —
          // isso não é duplicidade, é o cenário normal de "corte pra mim e corte+barba pro meu pai".
          // Se não conseguirmos identificar o profissional do agendamento já existente, mantemos
          // o comportamento conservador de ANTES (bloqueia) — só liberamos quando temos certeza
          // de que é um profissional diferente.
          const isDuplicate = activeAg.some((a: any) => {
            if (a.dataHoraInicio !== dataHoraInicio) return false;
            const existingProfId = a.profissionalId ?? a.profissional?.id ?? a.funcionarioId ?? a.funcionario?.id;
            if (existingProfId === undefined || existingProfId === null) return true;
            return Number(existingProfId) === profId;
          });
          if (isDuplicate) {
            console.log(`criar_agendamento: DUPLICATE detected for ${dataHoraInicio}`);
            return {
              id: "duplicate",
              message: "Já existe um agendamento ativo neste horário. NÃO crie outro. Confirme ao cliente que já está agendado.",
              blocked: true,
            };
          }
        } catch (dedupErr) {
          console.error("criar_agendamento dedup check failed:", dedupErr);
        }

        const body = {
          servicoId: args.servicoId,
          clienteId: resolvedClienteId,
          profissionalId: args.profissionalId,
          dataHoraInicio,
          duracaoEmMinutos: args.duracaoEmMinutos,
          valor: args.valor,
        };
        console.log("criar_agendamento body:", JSON.stringify(body));
        // Retry loop 429 — Trinks rate-limita quando várias requests caem na mesma
        // janela de ~1s (rajada normal do fluxo IA: buscar/listar/criar). Backoff mais
        // agressivo garante que a retentativa caia numa janela nova.
        // Sequência: 4 tentativas com waits 1500ms / 4000ms / 8000ms (total ~13,5s pior caso).
        let res: Response;
        let text = "";
        let attempt = 0;
        const maxAttempts = 4;
        const backoffMs = [1500, 4000, 8000];
        while (true) {
          attempt++;
          res = await fetch(`${baseUrl}/agendamentos`, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          text = await res.text();
          console.log(`criar_agendamento response (${res.status}, attempt ${attempt}):`, text.slice(0, 500));
          if (res.status !== 429 || attempt >= maxAttempts) break;
          const wait = backoffMs[attempt - 1] ?? 8000;
          console.log(`criar_agendamento: 429 recebido, aguardando ${wait}ms antes de retry ${attempt + 1}/${maxAttempts}`);
          await new Promise((r) => setTimeout(r, wait));
        }
        if (res.status === 429) {
          return {
            error: "RATE_LIMIT_TRINKS",
            status: 429,
            recoverable: true,
            message: "Trinks limitou as requisições (429). Aguarde alguns segundos e tente criar o agendamento novamente — a ação NÃO foi concluída.",
          };
        }
        try { return JSON.parse(text); } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "cancelar_agendamento": {
        if (phoneNumber) {
          const clienteIds = await trinksResolveClienteIds(baseUrl, headers, phoneNumber);
          {
            const activeRaw = await trinksListActiveByClienteIds(baseUrl, headers, clienteIds, phoneNumber);
            const activeAgendamentos = activeRaw.map((a: any) => ({
              id: a.id,
              status: a.status?.nome,
              servico: a.servico?.nome,
              profissional: a.profissional?.nome,
              clienteId: a.cliente?.id,
              dataHoraInicio: a.dataHoraInicio,
            }));
            const owns = activeAgendamentos.some((a: any) => a.id === args.agendamentoId);
            if (!owns) {
              const idx = args.agendamentoId;
              if (Number.isInteger(idx) && idx >= 1 && idx <= activeAgendamentos.length) {
                const correctedId = activeAgendamentos[idx - 1].id;
                console.log(`cancelar_agendamento: AUTO-CORRECTED positional id ${idx} → real id ${correctedId}`);
                args.agendamentoId = correctedId;
              } else if (activeAgendamentos.length === 1) {
                const correctedId = activeAgendamentos[0].id;
                console.log(`cancelar_agendamento: AUTO-CORRECTED invalid id ${args.agendamentoId} → only active id ${correctedId}`);
                args.agendamentoId = correctedId;
              } else if (activeAgendamentos.length === 0) {
                // Sem agendamentos ativos localizáveis — deixa passar (IA pode estar usando ID vindo de outra fonte).
                console.log(`cancelar_agendamento: nenhum agendamento ativo encontrado por telefone; seguindo com id fornecido ${args.agendamentoId}`);
              } else {
                console.log(`cancelar_agendamento: ownership check FAILED for agendamentoId=${args.agendamentoId}, cannot auto-correct`);
                return {
                  code: "agendamento_id_invalido",
                  error: "O agendamento informado não pertence a você.",
                  message: "Use um dos IDs reais de agendamentosAtivos ou execute buscar_agendamento novamente nesta interação.",
                  agendamentosAtivos: activeAgendamentos,
                };
              }
            }
          }
        }

        const url = `${baseUrl}/agendamentos/${args.agendamentoId}/status/cancelado`;
        const body = {
          quemCancelou: 1,
          motivo: args.motivo || "Cancelado pelo cliente via WhatsApp",
        };
        console.log(`cancelar_agendamento URL: ${url}`, JSON.stringify(body));

        // Retry loop: Trinks costuma retornar 429 quando 2 cancels chegam quase juntos.
        // Fazemos até 3 tentativas com backoff antes de devolver o 429 pra IA.
        let res: Response;
        let text = "";
        let attempt = 0;
        const maxAttempts = 3;
        while (true) {
          attempt++;
          res = await fetch(url, {
            method: "PATCH",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          text = await res.text();
          console.log(`cancelar_agendamento response (${res.status}, attempt ${attempt}):`, text.slice(0, 500));
          if (res.status !== 429 || attempt >= maxAttempts) break;
          const backoff = 800 * attempt; // 800ms, 1600ms
          await new Promise((r) => setTimeout(r, backoff));
        }

        if (res.status === 200 || res.status === 204) {
          return { success: true, message: "Agendamento cancelado com sucesso" };
        }
        if (res.status === 429) {
          return {
            error: "RATE_LIMIT_TRINKS",
            status: 429,
            recoverable: true,
            message: "Trinks limitou as requisições (429). Aguarde alguns segundos e chame cancelar_agendamento novamente para este mesmo agendamentoId — a ação NÃO foi concluída.",
          };
        }
        try { return { status: res.status, error: `Status ${res.status}`, ...JSON.parse(text) }; } catch { return { error: `Status ${res.status}`, status: res.status, raw: text.slice(0, 200) }; }
      }

      case "editar_agendamento": {
        let editClienteId = args.clienteId;
        if (phoneNumber) {
          const clienteIds = await trinksResolveClienteIds(baseUrl, headers, phoneNumber);
          {
            editClienteId = editClienteId || clienteIds[0];
            const activeRaw = await trinksListActiveByClienteIds(baseUrl, headers, clienteIds, phoneNumber);
            const activeAgendamentos = activeRaw.map((a: any) => ({
              id: a.id,
              status: a.status?.nome,
              servico: a.servico?.nome,
              profissional: a.profissional?.nome,
              clienteId: a.cliente?.id,
              dataHoraInicio: a.dataHoraInicio,
            }));
            const owns = activeAgendamentos.some((a: any) => a.id === args.agendamentoId);
            if (!owns) {
              const idx = args.agendamentoId;
              if (Number.isInteger(idx) && idx >= 1 && idx <= activeAgendamentos.length) {
                const correctedId = activeAgendamentos[idx - 1].id;
                console.log(`editar_agendamento: AUTO-CORRECTED positional id ${idx} → real id ${correctedId}`);
                args.agendamentoId = correctedId;
              } else if (activeAgendamentos.length === 1) {
                const correctedId = activeAgendamentos[0].id;
                console.log(`editar_agendamento: AUTO-CORRECTED invalid id ${args.agendamentoId} → only active id ${correctedId}`);
                args.agendamentoId = correctedId;
              } else if (activeAgendamentos.length === 0) {
                console.log(`editar_agendamento: nenhum agendamento ativo encontrado por telefone; seguindo com id fornecido ${args.agendamentoId}`);
              } else {
                console.log(`editar_agendamento: ownership check FAILED for agendamentoId=${args.agendamentoId}`);
                return {
                  code: "agendamento_id_invalido",
                  error: "O agendamento informado não pertence a você.",
                  message: "Use um dos IDs reais de agendamentosAtivos ou execute buscar_agendamento novamente nesta interação.",
                  agendamentosAtivos: activeAgendamentos,
                };
              }
            }
            // Auto-preenche clienteId com o dono real do agendamento (evita reatribuir agendamento a outro cadastro)
            const target = activeAgendamentos.find((a: any) => a.id === args.agendamentoId);
            if (target?.clienteId) editClienteId = target.clienteId;
          }
        }

        let dataHoraInicio = args.dataHoraInicio || "";
        if (dataHoraInicio.includes(" ")) dataHoraInicio = dataHoraInicio.replace(" ", "T");
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dataHoraInicio)) dataHoraInicio += ":00";

        const body = {
          servicoId: args.servicoId,
          clienteId: editClienteId,
          profissionalId: args.profissionalId,
          dataHoraInicio,
          duracaoEmMinutos: args.duracaoEmMinutos,
          valor: args.valor,
        };
        console.log(`editar_agendamento body:`, JSON.stringify(body));
        // Retry loop 429/5xx — mesmo padrão de criar_agendamento/cancelar_agendamento.
        // Trinks rate-limita quando várias requests chegam quase juntas; sem retry
        // uma remarcação legítima vira falha definitiva e escala humano à toa.
        let res!: Response;
        let text = "";
        const maxAttempts = 3;
        const backoffMs = [800, 1600, 3000];
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          res = await fetch(`${baseUrl}/agendamentos/${args.agendamentoId}`, {
            method: "PUT",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          text = await res.text();
          console.log(`editar_agendamento response (${res.status}, attempt ${attempt}):`, text.slice(0, 500));
          const transient = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
          if (!transient || attempt >= maxAttempts) break;
          const wait = backoffMs[attempt - 1] ?? 3000;
          console.log(`editar_agendamento: ${res.status} transiente, aguardando ${wait}ms antes de retry ${attempt + 1}/${maxAttempts}`);
          await new Promise((r) => setTimeout(r, wait));
        }
        if (res.status === 200 || res.status === 204) {
          return { success: true, message: "Agendamento alterado com sucesso" };
        }
        if (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) {
          return {
            error: `Trinks respondeu ${res.status} após ${maxAttempts} tentativas.`,
            status: res.status,
            recoverable: true,
            message: "Trinks limitou/instabilizou as requisições. Aguarde alguns segundos e chame editar_agendamento novamente com os MESMOS dados — a remarcação NÃO foi concluída e nenhum dado do agendamento mudou. NÃO invente que o horário mudou, NÃO peça dados novos ao cliente.",
          };
        }
        try { return { status: res.status, ...JSON.parse(text) }; } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }


      default:
        return { error: `Unknown tool: ${funcName}` };
    }
  } catch (error) {
    console.error(`Trinks tool error (${funcName}):`, error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { error: `Erro ao executar ${funcName}: ${errorMessage}` };
  }
}

// ===================== ATALHO DE CANCELAMENTO DIRETO (Trinks-only) =====================
// Quando a IA acabou de perguntar "quer cancelar esse agendamento?" e o cliente
// respondeu "sim/ok/pode/etc.", este atalho executa o cancelamento sem passar
// pelo loop de tool-calling. Só funciona pra Trinks porque só a Trinks tem o
// fetchActiveAppointmentsByPhone + executeTrinksTool + cancelar_agendamento
// bem definidos hoje.

function _trinksIsAffirmativeReply(value: string): boolean {
  const raw = value.trim();
  if (["👍", "👍🏻", "👍🏼", "👍🏽", "👍🏾", "👍🏿", "✅"].includes(raw)) return true;
  const normalized = normalizeUserFacingText(raw);
  if (!normalized) return false;
  return /^(sim|s|ok|okay|pode|pode sim|isso|isso mesmo|confirmo|confirmado|certo|beleza|perfeito|sim pode|pode cancelar|sim pode cancelar)$/.test(normalized);
}

function _trinksGetLastAssistantMessage(history: { role: string; content: string }[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message?.role === "assistant" && typeof message.content === "string" && message.content.trim()) {
      return message.content.trim();
    }
  }
  return null;
}

function _trinksIsSingleCancellationConfirmationPrompt(value: string): boolean {
  const normalized = normalizeUserFacingText(value);
  if (!normalized.includes("quer cancelar")) return false;
  const words = new Set(normalized.split(" "));
  return words.has("esse") || words.has("esta") || words.has("este");
}

export async function maybeHandleDirectCancellationConfirmation(
  tenant: any,
  phoneNumber: string,
  history: { role: string; content: string }[],
  userMessage: string,
): Promise<string | null> {
  if (!_trinksIsAffirmativeReply(userMessage)) return null;

  const lastAssistantMessage = _trinksGetLastAssistantMessage(history);
  if (!lastAssistantMessage || !_trinksIsSingleCancellationConfirmationPrompt(lastAssistantMessage)) {
    return null;
  }

  const activeAgendamentos = await fetchActiveAppointmentsByPhone(tenant, phoneNumber);
  console.log(
    `Direct cancel confirmation detected for ${phoneNumber}: ${activeAgendamentos.length} active appointment(s)`,
  );

  if (activeAgendamentos.length === 0) {
    return "Não encontrei esse agendamento. Pode já ter sido cancelado.";
  }
  if (activeAgendamentos.length > 1) {
    return "Encontrei mais de um agendamento ativo. Me diz qual deles você quer cancelar.";
  }

  const target = activeAgendamentos[0];
  const cancelResult = await executeTrinksTool(
    tenant,
    {
      function: {
        name: "cancelar_agendamento",
        arguments: JSON.stringify({ agendamentoId: target.id, motivo: "Solicitação do cliente" }),
      },
    },
    phoneNumber,
  );

  console.log("Direct cancel confirmation result:", JSON.stringify(cancelResult).slice(0, 500));

  if (cancelResult?.success) return "✅ Cancelado! Se precisar remarcar, é só falar.";
  if (cancelResult?.status === 404) return "Não encontrei esse agendamento. Pode já ter sido cancelado.";
  if (cancelResult?.status === 405) return "Esse agendamento já foi realizado e não pode ser cancelado.";
  return "Tive um probleminha aqui. Pode tentar novamente?";
}

// ===================== BOOKING EVALUATION (MultiBookingGuard support) =====================
// Chamado pelo countSuccessfulBookingsInTurn no index.ts. Retorna null se o
// resultado da tool não caracteriza sucesso; se sucesso, devolve os campos
// crus que o main usa pra montar o summary humano com formatBookingWhen.
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

export function evaluateSuccessfulBooking(tc: any, sessionState?: any): BookingEvaluation | null {
  const r = tc?.result || {};
  const args = tc?.args || {};
  const succeeded = !r.code && (typeof r.id !== "undefined" || typeof r.data !== "undefined" || r.success === true);
  if (!succeeded) return null;
  const catalog = (sessionState?.trinksServiceCatalog || []) as Array<{ id: number; nome: string }>;
  const serviceName = catalog.find((s) => Number(s.id) === Number(args.servicoId))?.nome;
  return {
    succeeded: true,
    bookedCount: 1,
    serviceName,
    dateStr: String(args.dataHoraInicio || ""),
    fallbackSuffix: serviceName ? undefined : `(serviço ${args.servicoId ?? "?"})`,
  };
}

export function extractBookedServiceNames(tc: any, sessionState?: any): string[] {
  const args = tc?.args || {};
  const catalog = (sessionState?.trinksServiceCatalog || []) as Array<{ id: number; nome: string }>;
  const name = catalog.find((s) => Number(s.id) === Number(args.servicoId))?.nome;
  return name ? [name] : [];
}
