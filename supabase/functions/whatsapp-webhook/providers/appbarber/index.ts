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

// ===================== APPBARBER PROVIDER =====================

const APPBARBER_DEFAULT_BASE_URL = "https://proxy.zayloia.com";


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
        description: "ATALHO RECOMENDADO: consulta horários LIVRES de TODOS os profissionais ao mesmo tempo (executa /v1/availability em paralelo) para um serviço e data. Use logo após listar_servicos para já ter a agenda consolidada ANTES de perguntar preferência de profissional. Retorna { resumo, totalProfissionaisLivres, horariosConsolidados, profissionais: [{ professional_code, name, available_times }] }.",
        parameters: {
          type: "object",
          properties: {
            service_code: { type: "number" },
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
        description: "Cria o agendamento real no AppBarber. Só use depois de confirmar serviço, profissional, dia e horário EXATO de listar_horarios.",
        parameters: {
          type: "object",
          properties: {
            service_code: { type: "number" },
            professional_code: { type: "number" },
            start_date: { type: "string", description: "YYYY-MM-DD" },
            start_time: { type: "string", description: "HH:MM (exato de available_times)" },
            customer_name: { type: "string" },
            customer_phone: { type: "string", description: "Telefone com DDI (ex: 5561999998888 ou +55...)" },
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
            customer_phone: { type: "string", description: "Telefone do cliente (só dígitos, com ou sem DDI 55). Padrão: telefone da conversa." },
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
            customer_phone: { type: "string", description: "Telefone do cliente (só dígitos). Padrão: telefone da conversa." },
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

  const appBarberPhoneVariants = (raw: string): string[] => {
    const full = normalizePhoneDigits(raw);
    const variants = new Set<string>();
    const add = (value: string) => {
      const digits = String(value || "").replace(/\D/g, "");
      if (digits) variants.add(digits);
    };
    add(full);
    const local = full.startsWith("55") && (full.length === 12 || full.length === 13) ? full.slice(2) : full;
    add(local);
    // AppBarber documenta /invoice/search como DDD+número, sem DDI, e bases antigas
    // podem ter celular com ou sem o 9 após o DDD. Testamos as duas formas.
    if (local.length === 10) add(`${local.slice(0, 2)}9${local.slice(2)}`);
    if (local.length === 11 && local[2] === "9") add(`${local.slice(0, 2)}${local.slice(3)}`);
    for (const v of Array.from(variants)) {
      if (!v.startsWith("55") && (v.length === 10 || v.length === 11)) add(`55${v}`);
    }
    return Array.from(variants);
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

  try {
    switch (funcName) {
      case "listar_servicos": {
        const r = await callGet("/v1/services", {});
        if (r?.error) return r;
        const items = Array.isArray(r?.data) ? r.data : [];
        return {
          services: items.map((s: any) => ({
            service_code: s.service_code,
            name: s.service_description,
            duration_minutes: s.service_interval,
            price: s.service_value,
            category_code: s.category_code,
            has_subscription: !!s.has_subscription,
          })),
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
        if (!args.service_code || !args.professional_code || !args.start_date) return { error: "service_code, professional_code e start_date são obrigatórios." };
        const r = await callGet("/v1/availability", {
          service_code: args.service_code,
          start_date: args.start_date,
          professional_code: args.professional_code,
        });
        if (r?.error) return r;
        const blocks = Array.isArray(r?.data) ? r.data : [];
        const wantedProf = args.professional_code != null ? Number(args.professional_code) : null;
        // ⚠️ Bug conhecido da API: o filtro professional_code é IGNORADO no servidor
        // e a resposta vem com blocos de TODOS os profissionais. Precisamos filtrar
        // localmente pelo employee_code, senão oferecemos horário de outro barbeiro
        // e o POST /appointments retorna 422 "Choque de Horário".
        const filteredBlocks = blocks.filter((b: any) => {
          const prof = firstValue(b?.professional_code, b?.employee_code, b?.professional?.code, b?.employee?.code);
          return prof == null || Number(prof) === wantedProf;
        });
        const seen = new Set<string>();
        const times: string[] = [];
        const collectSlots = (value: any) => {
          if (!value) return;
          if (Array.isArray(value)) { value.forEach(collectSlots); return; }
          if (typeof value !== "object") return;
          const rawTime = firstValue(value.scheduling_time, value.time, value.start_time, value.hour);
          if (rawTime) {
            const str = String(rawTime).trim();
            const normalized = /^\d{2}:\d{2}$/.test(str) ? `${str}:00` : str.slice(0, 8);
            if (/^\d{2}:\d{2}:\d{2}$/.test(normalized) && !seen.has(normalized)) {
              seen.add(normalized);
              times.push(normalized);
            }
          }
          for (const key of ["avaliable", "available", "schedules", "slots", "times", "items"]) {
            if (Array.isArray(value[key])) collectSlots(value[key]);
          }
        };
        for (const block of filteredBlocks) {
          collectSlots(block);
        }
        times.sort();
        if (wantedProf != null && filteredBlocks.length === 0 && blocks.length > 0) {
          // O profissional pedido não aparece na resposta → não trabalha nesse dia
          return {
            date: args.start_date,
            service_code: args.service_code,
            professional_code: wantedProf,
            available_times: [],
            note: "Esse profissional não tem horários nesse dia. Ofereça outra data ou outro profissional.",
          };
        }
        return {
          date: args.start_date,
          service_code: args.service_code,
          professional_code: args.professional_code,
          available_times: times,
        };
      }

      case "listar_horarios_geral": {
        if (!args.service_code || !args.start_date) {
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

        const collectTimes = (blocks: any[], wantedProf: number): string[] => {
          const seen = new Set<string>();
          const times: string[] = [];
          const filtered = blocks.filter((b: any) => {
            const prof = firstValue(b?.professional_code, b?.employee_code, b?.professional?.code, b?.employee?.code);
            return prof == null || Number(prof) === wantedProf;
          });
          const walk = (value: any) => {
            if (!value) return;
            if (Array.isArray(value)) { value.forEach(walk); return; }
            if (typeof value !== "object") return;
            const rawTime = firstValue(value.scheduling_time, value.time, value.start_time, value.hour);
            if (rawTime) {
              const str = String(rawTime).trim();
              const normalized = /^\d{2}:\d{2}$/.test(str) ? `${str}:00` : str.slice(0, 8);
              if (/^\d{2}:\d{2}:\d{2}$/.test(normalized) && !seen.has(normalized)) {
                seen.add(normalized);
                times.push(normalized);
              }
            }
            for (const key of ["avaliable", "available", "schedules", "slots", "times", "items"]) {
              if (Array.isArray(value[key])) walk(value[key]);
            }
          };
          for (const block of filtered) walk(block);
          times.sort();
          return times;
        };

        const consultaUm = async (prof: { professional_code: number; name: string | null }) => {
          try {
            const r = await callGet("/v1/availability", {
              service_code: args.service_code,
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
          service_code: Number(args.service_code),
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
          const abCat = (((sessionState as any)?.appbarberServiceCatalog) || []) as Array<{ service_code: number; name: string }>;
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
        const serviceItems: Array<{ service_code: number; duration: number }> = [];
        for (const service of requestedServices) {
          const duration = await resolveAppBarberServiceDuration(service.service_code, service.duration);
          if (!duration) {
            return { error: `Duração do serviço ${service.service_code} não encontrada. Chame listar_servicos novamente e use service_interval como service_duration_minutes.`, recoverable: true };
          }
          serviceItems.push({ service_code: service.service_code, duration });
        }
        const url = buildUrl("/v1/appointments", {});
        const customerName = String(args.customer_name || "Cliente").trim();
        // Schema real do AppBarber (validado via erro 400):
        // customer_phone: bigint | customer_name: string | start_date: "YYYY-MM-DD HH:MM"
        // professionals: [{ professional_code }] | services: [{ service_code, duration }]
        const body: Record<string, unknown> = {
          establishment_code: Number(estCode),
          customer_phone: Number(phoneDigits),
          customer_name: customerName,
          start_date: startDateTime,
          professionals: [{ professional_code: Number(args.professional_code) }],
          services: serviceItems,
          scheduling_observation: `Cliente: ${customerName} | WhatsApp: ${phoneDigits}`,
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
          if (res.status === 422) {
            return {
              error: `Horário indisponível ou conflito de regra de negócio: ${baseErr}`,
              status: 422,
              recoverable: true,
              hint: "Chame listar_horarios novamente para o mesmo serviço/profissional e ofereça outro horário ao cliente. NÃO escale humano.",
              details: parsed?.data ?? parsed?.details,
            };
          }
          if (res.status === 429) {
            return { error: "Limite de requisições do AppBarber excedido. Aguarde alguns segundos e tente de novo.", status: 429, recoverable: true };
          }
          return { error: baseErr, status: res.status, details: parsed?.data ?? parsed?.details };
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
        const phoneDigits = normalizePhoneDigits(args.customer_phone || phoneNumber || "");
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
