// ============================================================================
// PROVIDER BEMP — módulo isolado (extraído em jul/2026, mesmo padrão do
// Frizzar/AppBarber/Trinks). Regra: nada de Bemp mora no index.ts principal.
// Se precisar mexer em outra API, esse arquivo aqui não deve ser tocado.
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

// ===================== BEMP TOOLS DEFINITION =====================

export function buildBempTools(tenant: any) {
  if (!tenant.bemp_domain || !tenant.bemp_token) return undefined;

  return [
    {
      type: "function",
      function: {
        name: "listar_unidades",
        description: "Lista todas as unidades (salões) disponíveis. Se retornar apenas uma, use direto sem perguntar ao cliente.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "listar_servicos",
        description: "Lista os serviços disponíveis para uma unidade específica.",
        parameters: {
          type: "object",
          properties: {
            salonId: { type: "number", description: "ID da unidade (vem de listar_unidades)" },
          },
          required: ["salonId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "listar_profissionais",
        description: "Lista profissionais disponíveis para uma unidade + serviço. No Bemp, rode SEMPRE antes de listar_horarios e antes de agendar, porque professionalId é obrigatório.",
        parameters: {
          type: "object",
          properties: {
            salonId: { type: "number" },
            serviceId: { type: "number" },
          },
          required: ["salonId", "serviceId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "listar_horarios",
        description: "Lista horários disponíveis para uma unidade + serviço + data. No Bemp, professionalId é OBRIGATÓRIO para gerar slots válidos para agendamento.",
        parameters: {
          type: "object",
          properties: {
            salonId: { type: "number" },
            serviceId: { type: "number" },
            data: { type: "string", description: "Data no formato yyyy-MM-dd" },
            professionalId: { type: "number", description: "OBRIGATÓRIO. Vem de listar_profissionais." },
          },
          required: ["salonId", "serviceId", "data", "professionalId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "listar_horarios_geral",
        description: "🚀 ATALHO. Consulta horários disponíveis de TODOS os profissionais habilitados para o serviço + data ao mesmo tempo (fanout paralelo). Use ANTES de perguntar preferência de profissional. Retorna { resumo, totalProfissionaisLivres, horariosConsolidados: [{ start, end, start_text, end_text, professionals: [{ professionalId, name }] }], profissionais: [{ professionalId, name, available_slots }] }.",
        parameters: {
          type: "object",
          properties: {
            salonId: { type: "number" },
            serviceId: { type: "number" },
            data: { type: "string", description: "Data no formato yyyy-MM-dd" },
            professionalIds: {
              type: "array",
              items: { type: "number" },
              description: "Opcional. Se vazio, busca todos os profissionais habilitados para o serviço.",
            },
          },
          required: ["salonId", "serviceId", "data"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "consultar_cliente",
        description: "Verifica se o telefone do cliente atual já tem cadastro Bemp. Retorna nome e dados se existir.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "listar_agendamentos",
        description: "Lista agendamentos abertos do cliente atual (identificado pelo telefone).",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "agendar",
        description: "Cria um agendamento. ⚠️ professionalId é OBRIGATÓRIO — antes de chamar, rode listar_profissionais e (se houver mais de 1) confirme com o cliente qual ele prefere; em seguida rode listar_horarios COM professionalId e use o slot exato retornado. Telefone do cliente é injetado automático.",
        parameters: {
          type: "object",
          properties: {
            salonId: { type: "number" },
            serviceId: { type: "number" },
            professionalId: { type: "number", description: "OBRIGATÓRIO. Vem de listar_profissionais." },
            start: { type: "string", description: "Início do horário em ISO 8601 com timezone -03:00 (ex: 2026-04-29T13:30:00.000-03:00)" },
            end: { type: "string", description: "Fim do horário em ISO 8601 com timezone -03:00" },
            name: { type: "string", description: "Nome completo do cliente" },
          },
          required: ["salonId", "serviceId", "professionalId", "start", "end", "name"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "cancelar_agendamento",
        description: "Cancela um agendamento aberto do cliente atual pelo ID. Pegue o ID em listar_agendamentos.",
        parameters: {
          type: "object",
          properties: {
            agendamentoId: { type: "number", description: "ID do agendamento (campo `id` retornado por listar_agendamentos)" },
          },
          required: ["agendamentoId"],
        },
      },
    },
  ];
}

// ===================== BEMP TOOL EXECUTION =====================

export async function executeBempTool(tenant: any, toolCall: any, phoneNumber?: string, sessionState?: any): Promise<any> {
  const rawFuncName = toolCall.function.name;
  let args: any = {};
  try { args = JSON.parse(toolCall.function.arguments || "{}"); } catch { /* empty */ }

  const funcName = ({
    buscar_cliente: "consultar_cliente",
    buscar_servicos: "listar_servicos",
    buscar_barbeiros: "listar_profissionais",
    buscar_barbeiros_por_servico: "listar_profissionais",
    buscar_horarios: "listar_horarios",
    buscar_horarios_disponiveis: "listar_horarios",
    buscar_agendamento: "listar_agendamentos",
    buscar_agendamentos: "listar_agendamentos",
    criar_agendamento: "agendar",
    desmarcar_agendamento: "cancelar_agendamento",
  } as Record<string, string>)[rawFuncName] || rawFuncName;

  if (funcName !== rawFuncName) {
    console.log(`[Bemp] alias mapped: ${rawFuncName} -> ${funcName}`);
  }

  const domain = (tenant.bemp_domain || "").trim().replace(/^https?:\/\//, "").replace(/\.bemp\.app.*$/, "").replace(/\/.*$/, "");
  const token = (tenant.bemp_token || "").trim();
  if (!domain || !token) {
    return { error: "Bemp não está configurado para este estabelecimento (domínio ou token ausente)." };
  }

  const apiBase = `https://${domain}.bemp.app/api`;
  const webhooksBase = `https://webhooks.bemp.app/webhooks`;
  const headers: Record<string, string> = {
    "Authorization": `Token ${token}`,
    "Accept": "application/json",
  };
  const jsonHeaders: Record<string, string> = { ...headers, "Content-Type": "application/json" };

  // Telefone do cliente atual: separar em country/area/number (Brasil DDI 55, DDD 2 dígitos)
  const splitPhone = (raw: string) => {
    const digits = (raw || "").replace(/\D/g, "");
    let rest = digits;
    let country = "55";
    if (rest.startsWith("55") && rest.length >= 12) {
      country = "55";
      rest = rest.substring(2);
    } else if (rest.length >= 11) {
      // assume Brasil sem DDI
      country = "55";
    }
    const area = rest.substring(0, 2);
    const number = rest.substring(2);
    return { country, area, number };
  };
  const phone = splitPhone(phoneNumber || "");

  // Retry em 429 e 5xx transitórios (mesma abordagem de Frizzar/OneBeleza).
  const bempTransientStatuses = new Set([429, 502, 503, 504]);
  const bempFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    let lastRes: Response | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`[Bemp] -> ${init?.method || "GET"} ${url} (tentativa ${attempt}/3)`);
      const res = await fetch(url, init);
      if (!bempTransientStatuses.has(res.status)) return res;
      console.warn(`[Bemp] status transitório ${res.status} em ${url} — backoff`);
      lastRes = res;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 400 * attempt));
    }
    return lastRes!;
  };

  // Classificação genérica de falha da Bemp em 2 eixos: retryable + clientMessage.
  // Objetivo: separar "deu ruim agora, vale tentar de novo" (transitório) de
  // "não vai adiantar tentar, é regra de negócio" (definitivo). Consumido pelo
  // MultiBookingGuard pra pular o loop de recuperação quando não há o que
  // recuperar, e pra devolver a mensagem certa ao cliente sem alucinação da IA.
  const classifyBempFailure = (
    status: number,
    text: string,
  ): { retryable: boolean; clientMessage?: string; reason?: string } => {
    const body = (text || "").toLowerCase();

    // 1) Inadimplência / assinatura em atraso (Bemp + CelCash).
    // Cobre "pendente" (adj) e "pendência(s)" (subst) via `pend\w*`, em qualquer
    // ordem em relação a "pagamento"/"assinatura" (janela de 40 chars). O texto
    // real do provider é "...pendência no pagamento da sua assinatura..." — o
    // padrão antigo (`pagamento.*pendente`) não cobria essa forma.
    if (/(?:pagamento|assinatura).{0,40}pend\w*|pend\w*.{0,40}(?:pagamento|assinatura)|inadimpl|em\s+atraso|assinatura.{0,40}(atras|vencid)|payment.*overdue|subscription.*overdue/i.test(body)) {
      return {
        retryable: false,
        reason: "subscription_overdue",
        clientMessage:
          'Não consegui concluir seu agendamento porque há um pagamento pendente na sua assinatura. Deseja regularizar?',
      };
    }

    // 2) Regras de negócio / conflitos / dados rejeitados pela API — não adianta
    //    tentar de novo com os mesmos dados. Sem clientMessage: o guard usa fallback
    //    neutro em vez de vazar detalhe técnico ou o texto "cru" do provider.
    if ([400, 402, 403, 409, 422].includes(status)) {
      return { retryable: false, reason: `http_${status}` };
    }

    // 3) Transitórios (429/5xx): já passaram pelo retry interno; se chegou aqui,
    //    ainda são transitórios sob o ponto de vista da IA.
    if (status === 429 || status >= 500) {
      return { retryable: true, reason: `http_${status}` };
    }

    // 4) Default conservador: tratar como transitório (não bloquear recovery).
    return { retryable: true, reason: `http_${status}` };
  };

  let cachedSalons: any[] | null = null;
  const fetchBempSalons = async (): Promise<any[]> => {
    if (cachedSalons) return cachedSalons;
    const res = await bempFetch(`${apiBase}/salons`, { headers });
    const text = await res.text();
    console.log(`[Bemp] fetchBempSalons (${res.status}):`, text.slice(0, 400));
    try {
      const data = JSON.parse(text);
      cachedSalons = Array.isArray(data) ? data : [];
    } catch {
      cachedSalons = [];
    }
    return cachedSalons;
  };

  const resolveBempSalonId = async (rawSalonId: unknown) => {
    const salons = await fetchBempSalons();
    const requestedSalonId = toPositiveInteger(rawSalonId);

    if (requestedSalonId && salons.some((salon: any) => Number(salon?.id) === requestedSalonId)) {
      return { salonId: requestedSalonId, corrected: false, salons };
    }

    if (salons.length === 1) {
      const onlySalonId = toPositiveInteger(salons[0]?.id);
      if (onlySalonId) {
        console.log(`[Bemp] auto-corrected salonId ${requestedSalonId ?? "null"} -> ${onlySalonId}`);
        return { salonId: onlySalonId, corrected: requestedSalonId !== onlySalonId, salons };
      }
    }

    return {
      salonId: null,
      corrected: false,
      salons,
      error: requestedSalonId
        ? `salonId ${requestedSalonId} inválido para este domínio Bemp.`
        : "salonId é obrigatório na Bemp.",
      blocked: true,
      message: "Chame listar_unidades e use um salonId real retornado pela Bemp.",
      unidades_disponiveis: salons.map((salon: any) => ({ id: salon.id, name: salon.name })),
    };
  };

  try {
    switch (funcName) {
      case "listar_unidades": {
        const res = await bempFetch(`${apiBase}/salons`, { headers });
        const text = await res.text();
        console.log(`[Bemp] listar_unidades (${res.status}):`, text.slice(0, 400));
        try {
          const data = JSON.parse(text);
          if (Array.isArray(data)) {
            cachedSalons = data;
            return data.map((s: any) => ({ id: s.id, name: s.name, address: s.address, phone: s.phone }));
          }
          return data;
        } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "listar_servicos": {
        const salonResolution = await resolveBempSalonId(args.salonId);
        if (!salonResolution.salonId) return salonResolution;
        args.salonId = salonResolution.salonId;
        const res = await bempFetch(`${apiBase}/salons/${args.salonId}/services`, { headers });
        const text = await res.text();
        console.log(`[Bemp] listar_servicos (${res.status}):`, text.slice(0, 600));
        try {
          const data = JSON.parse(text);
          if (Array.isArray(data)) {
            return data.map((s: any) => ({
              id: s.id,
              name: s.name,
              duration_minutes: s.duration ? Math.round(s.duration / 60) : null,
              price: s.price,
              price_text: s.price_currency,
              group: s.group?.name,
            }));
          }
          return data;
        } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "listar_profissionais": {
        const salonResolution = await resolveBempSalonId(args.salonId);
        if (!salonResolution.salonId) return salonResolution;
        args.salonId = salonResolution.salonId;
        if (!args.serviceId) return { error: "Falta serviceId." };
        const res = await bempFetch(`${apiBase}/salons/${args.salonId}/services/${args.serviceId}/professionals`, { headers });
        const text = await res.text();
        console.log(`[Bemp] listar_profissionais (${res.status}):`, text.slice(0, 600));
        try {
          const data = JSON.parse(text);
          if (Array.isArray(data)) {
            return data.map((p: any) => ({ id: p.id, name: p.name }));
          }
          return data;
        } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "listar_horarios": {
        const salonResolution = await resolveBempSalonId(args.salonId);
        if (!salonResolution.salonId) return salonResolution;
        args.salonId = salonResolution.salonId;
        if (!args.serviceId || !args.data) {
          return { error: "Faltam salonId, serviceId e/ou data (yyyy-MM-dd)." };
        }
        if (!args.professionalId) {
          return {
            error: "professionalId é obrigatório para listar_horarios na Bemp.",
            blocked: true,
            message: "Antes de listar horários, chame listar_profissionais, use um professionalId real do retorno e só então rode listar_horarios.",
          };
        }
        const url = `${apiBase}/salons/${args.salonId}/services/${args.serviceId}/professionals/${args.professionalId}/slots/${args.data}`;
        const res = await bempFetch(url, { headers });
        const text = await res.text();
        console.log(`[Bemp] listar_horarios (${res.status}):`, text.slice(0, 600));
        try { return JSON.parse(text); } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "listar_horarios_geral": {
        const salonResolution = await resolveBempSalonId(args.salonId);
        if (!salonResolution.salonId) return salonResolution;
        args.salonId = salonResolution.salonId;
        if (!args.serviceId || !args.data) {
          return { error: "Faltam salonId, serviceId e/ou data (yyyy-MM-dd)." };
        }

        // 1) Resolve profissionais: usa lista informada OU busca todos do serviço.
        let profs: Array<{ id: number; name: string }> = [];
        const requestedIds = Array.isArray(args.professionalIds)
          ? args.professionalIds.map((v: any) => toPositiveInteger(v)).filter((v: any): v is number => !!v)
          : [];
        try {
          const profRes = await bempFetch(`${apiBase}/salons/${args.salonId}/services/${args.serviceId}/professionals`, { headers });
          const profText = await profRes.text();
          const profData = JSON.parse(profText);
          if (Array.isArray(profData)) {
            profs = profData
              .map((p: any) => ({ id: Number(p?.id), name: String(p?.name || "") }))
              .filter((p) => p.id > 0);
          }
        } catch (e) {
          return { error: "Falha ao listar profissionais para o serviço.", details: String(e) };
        }
        if (requestedIds.length > 0) {
          profs = profs.filter((p) => requestedIds.includes(p.id));
        }
        if (profs.length === 0) {
          return { error: "Nenhum profissional disponível para este serviço.", profissionais: [] };
        }

        console.log(`[Bemp] listar_horarios_geral salon=${args.salonId} svc=${args.serviceId} data=${args.data} profs=${profs.map((p) => p.id).join(",")}`);

        // 2) Fanout paralelo de slots por profissional.
        const results = await Promise.all(profs.map(async (p) => {
          try {
            const url = `${apiBase}/salons/${args.salonId}/services/${args.serviceId}/professionals/${p.id}/slots/${args.data}`;
            const res = await bempFetch(url, { headers });
            const text = await res.text();
            const data = JSON.parse(text);
            const slots = Array.isArray(data) ? data : [];
            return { prof: p, slots };
          } catch (e) {
            console.log(`[Bemp] horarios_geral falha prof=${p.id}:`, String(e));
            return { prof: p, slots: [] as any[] };
          }
        }));

        // 3) Consolida por start.
        const consolidatedMap = new Map<string, {
          start: string;
          end: string;
          start_text?: string;
          end_text?: string;
          professionals: Array<{ professionalId: number; name: string }>;
        }>();
        const profissionais: any[] = [];
        for (const { prof, slots } of results) {
          const availableSlots: any[] = [];
          for (const slot of slots) {
            const start = String(slot?.start || "");
            const end = String(slot?.end || "");
            if (!start || !end) continue;
            const start_text = typeof slot?.start_text === "string" ? slot.start_text : undefined;
            const end_text = typeof slot?.end_text === "string" ? slot.end_text : undefined;
            availableSlots.push({ start, end, start_text, end_text });
            const key = start;
            if (!consolidatedMap.has(key)) {
              consolidatedMap.set(key, { start, end, start_text, end_text, professionals: [] });
            }
            const entry = consolidatedMap.get(key)!;
            if (!entry.professionals.some((x) => x.professionalId === prof.id)) {
              entry.professionals.push({ professionalId: prof.id, name: prof.name });
            }
          }
          profissionais.push({
            professionalId: prof.id,
            name: prof.name,
            total: availableSlots.length,
            available_slots: availableSlots,
          });
        }

        const horariosConsolidados = Array.from(consolidatedMap.values())
          .sort((a, b) => a.start.localeCompare(b.start));
        const totalProfissionaisLivres = profissionais.filter((p) => p.total > 0).length;

        return {
          salonId: args.salonId,
          serviceId: args.serviceId,
          data: args.data,
          resumo: totalProfissionaisLivres === 0
            ? `Nenhum profissional disponível em ${args.data}.`
            : `${totalProfissionaisLivres} profissional(is) com horários em ${args.data}: ${horariosConsolidados.length} horário(s) únicos.`,
          totalProfissionaisLivres,
          horariosConsolidados,
          profissionais,
        };
      }

      case "consultar_cliente": {
        if (!phone.number) return { error: "Telefone do cliente atual indisponível." };
        const url = `${webhooksBase}/whatsapp_customer?phone_country_code=${phone.country}&phone_area_code=${phone.area}&phone_number=${phone.number}`;
        const res = await bempFetch(url, { headers });
        const text = await res.text();
        console.log(`[Bemp] consultar_cliente (${res.status}):`, text.slice(0, 400));
        if (res.status === 404) return { notFound: true, message: "Cliente ainda não tem cadastro Bemp — será criado automaticamente ao agendar." };
        try { return JSON.parse(text); } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "listar_agendamentos": {
        if (!phone.number) return { error: "Telefone do cliente atual indisponível." };
        const url = `${webhooksBase}/whatsapp_schedule?phone_country_code=${phone.country}&phone_area_code=${phone.area}&phone_number=${phone.number}`;
        const res = await bempFetch(url, { headers });
        const text = await res.text();
        console.log(`[Bemp] listar_agendamentos (${res.status}):`, text.slice(0, 600));
        let parsed: any;
        try { parsed = JSON.parse(text); } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }

        // Bemp devolve { code, status, data: [...] } ou { data: [...] }. Extrai a lista.
        const rawList: any[] = Array.isArray(parsed) ? parsed
          : Array.isArray(parsed?.data) ? parsed.data
          : Array.isArray(parsed?.appointments) ? parsed.appointments
          : [];

        // Categoriza por status + data — mesma abordagem do fix da Trinks:
        // - Status inativos (closed/canceled/finished/no_show) no PASSADO = inativo.
        // - Status inativos com data HOJE/FUTURO tratamos como potencialmente confirmado
        //   marcado errado pelo salão (comum na Bemp — status "closed" antes do horário).
        // - Qualquer outro status (open/confirmed/scheduled/…) = ativo.
        const INACTIVE_STATUSES = new Set(["closed", "cancelled", "canceled", "finished", "no_show", "no-show", "noshow"]);
        const nowMs = Date.now();
        const startOfTodayMs = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00-03:00").getTime();

        const ativos: any[] = [];
        const inativos: any[] = [];
        for (const ap of rawList) {
          const status = String(ap?.status || "").toLowerCase().trim();
          const startMs = ap?.start ? new Date(ap.start).getTime() : NaN;
          const isPast = Number.isFinite(startMs) && startMs < startOfTodayMs;
          const isInactiveStatus = INACTIVE_STATUSES.has(status);
          if (isInactiveStatus && isPast) {
            inativos.push(ap);
          } else {
            // ativo real OU status inativo mas data hoje/futuro (provável "confirmado marcado errado")
            ativos.push(ap);
          }
        }

        let resumo = "";
        if (ativos.length === 0 && inativos.length === 0) {
          resumo = "Nenhum agendamento encontrado para este cliente na Bemp.";
        } else if (ativos.length === 0 && inativos.length > 0) {
          resumo = `Nenhum agendamento ativo. Existem ${inativos.length} agendamento(s) inativo(s) (cancelado/finalizado no passado) — informe o cliente do status real em vez de dizer "não achei".`;
        } else if (ativos.length > 0) {
          const closedAtivos = ativos.filter((a) => INACTIVE_STATUSES.has(String(a?.status || "").toLowerCase().trim()));
          if (closedAtivos.length > 0) {
            resumo = `${ativos.length} agendamento(s) na janela ativa. ATENÇÃO: ${closedAtivos.length} está(ão) marcado(s) como "${closedAtivos[0]?.status}" mas com data hoje/futura — provavelmente o salão marcou como finalizado antes do horário; trate como CONFIRMADO ativo.`;
          } else {
            resumo = `${ativos.length} agendamento(s) ativo(s).`;
          }
        }

        return {
          agendamentosAtivos: ativos,
          agendamentosInativos: inativos,
          resumo,
        };
      }

      case "agendar": {
        const salonResolution = await resolveBempSalonId(args.salonId);
        if (!salonResolution.salonId) return salonResolution;
        args.salonId = salonResolution.salonId;
        if (!args.serviceId || !args.start || !args.end || !args.name) {
          return { error: "Faltam parâmetros: salonId, serviceId, start, end, name." };
        }
        if (!phone.number) return { error: "Telefone do cliente atual indisponível para agendar." };

        // 🛡️ Catálogo: se listar_servicos rodou nesta conversa, serviceId precisa estar no catálogo.
        {
          const bempCat = (((sessionState as any)?.bempServiceCatalog) || []) as Array<{ id: number; name: string }>;
          const sid = Number(args.serviceId);
          if (bempCat.length > 0 && sid > 0 && !bempCat.some((s) => s.id === sid)) {
            console.warn(`[Bemp] agendar BLOCKED: serviceId=${sid} fora do catálogo (${bempCat.map((s) => s.id).join(",")})`);
            return {
              error: `serviceId ${sid} não está no catálogo listado nesta conversa. Chame listar_servicos novamente e use um dos IDs retornados.`,
              blocked: true,
              validServiceIds: bempCat.map((s) => s.id),
            };
          }
        }

        // professional_id é OBRIGATÓRIO na Bemp. Se não veio, tenta usar a seleção persistida;
        // se ainda não houver, tenta auto-resolver apenas quando existir UM único profissional real.
        let professionalId = args.professionalId;
        if (!professionalId) {
          try {
            const profRes = await bempFetch(`${apiBase}/salons/${args.salonId}/services/${args.serviceId}/professionals`, { headers });
            const profText = await profRes.text();
            const profs = JSON.parse(profText);
            if (Array.isArray(profs) && profs.length === 1) {
              professionalId = profs[0].id;
              console.log(`[Bemp] agendar auto-resolved professionalId=${professionalId} (único)`);
            } else if (Array.isArray(profs) && profs.length > 1) {
              return {
                error: "professional_id é obrigatório.",
                blocked: true,
                message: "Antes de agendar, chame listar_profissionais e peça ao cliente para escolher um profissional. Em seguida chame listar_horarios COM professionalId e use o slot dessa resposta.",
                profissionais_disponiveis: profs.map((p: any) => ({ id: p.id, name: p.name })),
              };
            } else {
              return { error: "Nenhum profissional disponível para este serviço.", blocked: true };
            }
          } catch (e) {
            return { error: "Falha ao resolver profissional automaticamente. Chame listar_profissionais explicitamente.", blocked: true };
          }
        }

        const body: Record<string, unknown> = {
          salon_id: args.salonId,
          service_id: args.serviceId,
          professional_id: professionalId,
          start: args.start,
          end: args.end,
          name: args.name,
          phone_country_code: phone.country,
          phone_area_code: phone.area,
          phone_number: phone.number,
        };
        console.log(`[Bemp] agendar body:`, JSON.stringify(body));
        const res = await bempFetch(`${webhooksBase}/whatsapp_schedule`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify(body),
        });
        const text = await res.text();
        console.log(`[Bemp] agendar (${res.status}):`, text.slice(0, 600));

        const failure = !res.ok ? classifyBempFailure(res.status, text) : null;

        // Inadimplência / erros de negócio detectados pela classificação: devolvemos
        // um erro estruturado com retryable=false + clientMessage pra o MultiBookingGuard
        // pular recovery e usar a mensagem determinística correta.
        if (failure && !failure.retryable && failure.reason === "subscription_overdue") {
          console.log(`[Bemp] agendar BLOQUEADO por pagamento pendente (cliente inadimplente).`);
          return {
            error: "subscription_overdue",
            blocked: true,
            retryable: false,
            clientMessage: failure.clientMessage,
            message: "Cliente está com pagamento pendente na assinatura. NÃO tente agendar de novo. Responda ao cliente: \"" + failure.clientMessage + "\" e aguarde resposta.",
          };
        }

        try {
          const parsed = JSON.parse(text);
          if (res.ok) return { ok: true, ...parsed };
          return {
            error: `Status ${res.status}`,
            retryable: failure?.retryable ?? true,
            ...(failure?.clientMessage ? { clientMessage: failure.clientMessage } : {}),
            ...(failure?.reason ? { failureReason: failure.reason } : {}),
            ...parsed,
          };
        } catch {
          return {
            error: `Status ${res.status}`,
            retryable: failure?.retryable ?? true,
            ...(failure?.clientMessage ? { clientMessage: failure.clientMessage } : {}),
            ...(failure?.reason ? { failureReason: failure.reason } : {}),
            raw: text.slice(0, 200),
          };
        }
      }

      case "cancelar_agendamento": {
        if (!args.agendamentoId) return { error: "Faltou agendamentoId." };
        if (!phone.number) return { error: "Telefone do cliente atual indisponível." };
        const url = `${webhooksBase}/whatsapp_schedule?phone_country_code=${phone.country}&phone_area_code=${phone.area}&phone_number=${phone.number}&id=${args.agendamentoId}`;
        const res = await bempFetch(url, { method: "DELETE", headers });
        const text = await res.text();
        console.log(`[Bemp] cancelar_agendamento (${res.status}):`, text.slice(0, 400));
        if (res.ok) return { ok: true, message: "Agendamento cancelado." };
        const failure = classifyBempFailure(res.status, text);
        try {
          return {
            error: `Status ${res.status}`,
            retryable: failure.retryable,
            ...(failure.clientMessage ? { clientMessage: failure.clientMessage } : {}),
            ...(failure.reason ? { failureReason: failure.reason } : {}),
            ...JSON.parse(text),
          };
        }
        catch {
          return {
            error: `Status ${res.status}`,
            retryable: failure.retryable,
            ...(failure.clientMessage ? { clientMessage: failure.clientMessage } : {}),
            ...(failure.reason ? { failureReason: failure.reason } : {}),
            raw: text.slice(0, 200),
          };
        }
      }

      default:
        return { error: `Ferramenta Bemp desconhecida: ${funcName}` };
    }
  } catch (error) {
    console.error(`[Bemp] tool error (${funcName}):`, error);
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
  if (r.ok !== true) return null;
  const bempData = (r.data || {}) as Record<string, any>;
  const startIso = bempData.start || args.start;
  const serviceName = bempData.service_name;
  const professionalName = bempData.professional_name;
  return {
    succeeded: true,
    bookedCount: 1,
    serviceName,
    dateStr: typeof startIso === "string" ? startIso : "",
    professionalName,
    fallbackSuffix: serviceName ? undefined : `(serviço ${args.serviceId ?? args.service_id ?? "?"})`,
  };
}

export function extractBookedServiceNames(tc: any, _sessionState?: any): string[] {
  const r = tc?.result || {};
  const name = r?.data?.service_name;
  return name ? [String(name)] : [];
}

// ============================================================================
// 🛡️ PhantomConfirmationGuard — CONFIG ISOLADA DA BEMP
// ============================================================================
export const phantomGuardConfig = {
  enabled: true,
  bookingToolNames: ["agendar"],
  searchToolNames: ["listar_agendamentos"],
  // 🛡️ PhantomCancelGuard em MODO SOMBRA (detecta + registra, não bloqueia).
  cancelToolNames: ["cancelar_agendamento"],
  shadow: true,
  recoveryToolNames: [
    "listar_unidades",
    "listar_servicos",
    "listar_profissionais",
    "listar_horarios",
    "listar_horarios_geral",
    "consultar_cliente",
    "listar_agendamentos",
    "agendar",
  ],
};

// ============================================================================
// 🛡️ BOOKING GUARDS — CONFIG ISOLADA DA BEMP
// Desligados de propósito: MultiBookingGuard / CancelGuard / RescheduleGuard
// genéricos geravam mais falso positivo do que correção nesta API. Se um dia
// forem reativados, será com regras próprias declaradas AQUI.
// ============================================================================
export const bookingGuardsConfig = {
  multiBooking: {
    enabled: false,
    bookingToolNames: [] as string[],
    primaryBookingToolName: "",
    useIntentShape: false,
    skipWhenSingleVisit: false,
    allowMultiRecoveryAfterSuccess: false,
    useAlternativesShortCircuit: false,
    recoveryToolChoice: "auto" as const,
  },
  cancel: { enabled: false, cancelToolNames: [] as string[] },
  reschedule: { enabled: false, cancelToolNames: [] as string[], bookingToolNames: [] as string[] },
};
