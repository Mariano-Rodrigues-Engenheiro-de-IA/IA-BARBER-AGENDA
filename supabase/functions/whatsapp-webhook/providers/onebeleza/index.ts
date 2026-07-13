// ============================================================================
// PROVIDER ONE BELEZA — módulo isolado (extraído em jul/2026, mesmo padrão do
// Trinks/Frizzar/AppBarber/Bemp). Regra: nada de OneBeleza mora no index.ts
// principal.
// ----------------------------------------------------------------------------
// Dependências para fora do módulo: `createClient` do supabase-js (pra alias
// storage). Todos os utilitários pequenos estão DUPLICADOS aqui de propósito.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const normalizeUserFacingText = (value: unknown) => String(value ?? "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .trim();

function normalizeSearchText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function toPositiveInteger(value: unknown): number | null {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  const parsed = parseInt(normalized, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function dedupeByKey<T>(items: T[], getKey: (item: T) => string): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const item of items) {
    const key = getKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function _serviceSupabase() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

function _generateAliasPhone(tenantId: string, n: number) {
  const tHash = parseInt(tenantId.replace(/-/g, "").slice(0, 4), 16) % 10000;
  return `9${String(tHash).padStart(4, "0")}${String(n).padStart(6, "0")}`;
}

function getBrasiliaDate(): {
  dateComplete: string; todayName: string; todayDate: string;
  year: number; month: number; day: number; hours: number; minutes: number;
  timeHHMM: string; periodOfDay: string; greeting: string;
  dayType: string; todayDateBR: string;
} {
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
  const seconds = parseInt(get("second"));
  const dateComplete = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  const todayDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const todayDateBR = `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`;
  const brDate = new Date(Date.UTC(year, month - 1, day));
  const dow = brDate.getUTCDay();
  const dayNames = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
  const todayName = dayNames[dow];
  const timeHHMM = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  let periodOfDay: string;
  let greeting: string;
  if (hours >= 0 && hours < 6) { periodOfDay = "madrugada"; greeting = "boa madrugada"; }
  else if (hours < 12) { periodOfDay = "manhã"; greeting = "bom dia"; }
  else if (hours < 18) { periodOfDay = "tarde"; greeting = "boa tarde"; }
  else { periodOfDay = "noite"; greeting = "boa noite"; }
  const dayType = (dow === 0 || dow === 6) ? "fim de semana" : "dia útil";
  return { dateComplete, todayName, todayDate, year, month, day, hours, minutes, timeHHMM, periodOfDay, greeting, dayType, todayDateBR };
}

type AgentSessionState = any;

export const buildOneBelezaGenericEmail = (phone: unknown) => {
  const digits = digitsOnly(phone) || `${Date.now()}`;
  return `cliente+${digits}.${Date.now()}.${crypto.randomUUID().slice(0, 8)}@example.com`;
};

export const isOneBelezaPhoneInUseError = (status: number, responseText: string) => {
  if (status >= 200 && status < 300) {
    // Even on 2xx, server may return error-string body. Detect inline too.
    const n = normalizeUserFacingText(responseText);
    if (
      (n.includes("numero de telefone") || n.includes("telefone") || n.includes("celular")) &&
      (n.includes("ja esta associado") || n.includes("ja associado") || n.includes("outra conta"))
    ) return true;
    return false;
  }
  const normalized = normalizeUserFacingText(responseText);
  // Mensagem oficial: "O número de telefone já está associado a outra conta de usuário..."
  return (
    (normalized.includes("numero de telefone") || normalized.includes("telefone") || normalized.includes("celular")) &&
    (normalized.includes("ja esta associado") ||
      normalized.includes("ja associado") ||
      normalized.includes("outra conta") ||
      normalized.includes("ja esta cadastrado") ||
      normalized.includes("ja cadastrado") ||
      normalized.includes("ja existe"))
  );
};

export const isOneBelezaRegistrationSuccess = (status: number, responseText: string) => {
  if (status < 200 || status >= 300) return false;
  const raw = (responseText || "").trim();
  if (!raw) return false;
  const normalized = normalizeUserFacingText(raw);
  // Hard-fail keywords in the body
  if (
    normalized.startsWith("erro") ||
    normalized.includes("erro ao") ||
    normalized.includes("falha") ||
    normalized.includes("invalid") ||
    normalized.includes("inválid") ||
    normalized.includes("nao foi possivel") ||
    normalized.includes("não foi possível") ||
    normalized.includes("ja esta associado") ||
    normalized.includes("outra conta")
  ) return false;

  // If JSON, must contain something resembling an id/codigo
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const hasId = !!(parsed.codigo ?? parsed.id ?? parsed.clienteId ?? parsed.userId ?? parsed.usuarioId);
      const hasSuccessFlag = parsed.success === true || parsed.ok === true;
      // Some endpoints return {} or wrap inside data
      if (hasId || hasSuccessFlag) return true;
      if (parsed.data && typeof parsed.data === "object") {
        const d = parsed.data;
        if (d.codigo ?? d.id ?? d.clienteId ?? d.userId) return true;
      }
      // No clear success indicator — be conservative and fail
      return false;
    }
  } catch {
    // Plain text 2xx — error keywords already filtered above.
    // OneBeleza retorna textos como "Cadastro criado com sucesso !" → tratar como sucesso real.
    if (
      normalized.includes("cadastro criado") ||
      normalized.includes("criado com sucesso") ||
      normalized.includes("cadastrado com sucesso") ||
      normalized.includes("usuario cadastrado") ||
      normalized.includes("usuário cadastrado") ||
      normalized.includes("cliente cadastrado") ||
      (normalized.includes("sucesso") && !normalized.includes("nao") && !normalized.includes("não"))
    ) {
      return true;
    }
    return false;
  }
  return false;
};

export async function burnOneBelezaAlias(tenantId: string, aliasPhone: string, reason: string) {
  try {
    const supabase = _serviceSupabase();
    await supabase
      .from("onebeleza_client_aliases")
      .update({ burned_at: new Date().toISOString() } as any)
      .eq("tenant_id", tenantId)
      .eq("alias_phone", aliasPhone)
      .is("burned_at", null);
    console.log(`[OneBeleza][alias] BURNED tenant=${tenantId} alias=${aliasPhone} reason=${reason}`);
    await supabase.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_role: "service",
      entity: "onebeleza_alias",
      entity_id: aliasPhone,
      action: "onebeleza_alias_burned",
      after: { alias_phone: aliasPhone, reason },
    });
  } catch (e) {
    console.error(`[OneBeleza][alias] burn error:`, (e as Error).message);
  }
}

export async function getOrCreateOneBelezaAlias(
  tenantId: string,
  realPhone: string,
  realName?: string,
  forceNew = false,
): Promise<string> {
  const supabase = _serviceSupabase();
  const realDigits = digitsOnly(realPhone);

  // 1. Já existe um alias ATIVO (não queimado)?
  if (!forceNew) {
    const { data: existing } = await supabase
      .from("onebeleza_client_aliases")
      .select("alias_phone")
      .eq("tenant_id", tenantId)
      .eq("real_phone", realDigits)
      .is("burned_at", null)
      .maybeSingle();
    if (existing?.alias_phone) return existing.alias_phone;
  }

  // 2. Gera novo (com retry em colisão), sempre acima do total atual (inclui queimados)
  const { count } = await supabase
    .from("onebeleza_client_aliases")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId);
  let next = (count ?? 0) + 1;

  for (let attempt = 0; attempt < 8; attempt++) {
    const alias = _generateAliasPhone(tenantId, next + attempt);
    const { data, error } = await supabase
      .from("onebeleza_client_aliases")
      .insert({
        tenant_id: tenantId,
        real_phone: realDigits,
        alias_phone: alias,
        real_name: realName || null,
      })
      .select("alias_phone")
      .maybeSingle();
    if (!error && data?.alias_phone) {
      console.log(`[OneBeleza][alias] created tenant=${tenantId} real=${realDigits} alias=${alias}`);
      try {
        await supabase.from("audit_logs").insert({
          tenant_id: tenantId,
          actor_role: "service",
          entity: "onebeleza_alias",
          entity_id: alias,
          action: forceNew ? "onebeleza_alias_rotated" : "created",
          after: { real_phone: realDigits, alias_phone: alias, real_name: realName || null },
        });
      } catch { /* ignore */ }
      return alias;
    }
    // Caso de colisão no alias_phone: tenta o próximo número
  }
  throw new Error("Falha ao gerar alias OneBeleza após múltiplas tentativas");
}

export async function resolveOneBelezaClientPhone(
  tenantId: string,
  realPhone: string,
): Promise<string> {
  const realDigits = digitsOnly(realPhone);
  if (!realDigits) return realDigits;
  try {
    const supabase = _serviceSupabase();
    const { data } = await supabase
      .from("onebeleza_client_aliases")
      .select("alias_phone")
      .eq("tenant_id", tenantId)
      .eq("real_phone", realDigits)
      .is("burned_at", null)
      .maybeSingle();
    if (data?.alias_phone) {
      console.log(`[OneBeleza][alias] resolved tenant=${tenantId} real=${realDigits} -> alias=${data.alias_phone}`);
      return data.alias_phone;
    }
  } catch (e) {
    console.error("[OneBeleza][alias] resolve error:", (e as Error).message);
  }
  return realDigits;
}

export async function fetchOneBelezaWithRetry(
  url: string,
  options?: RequestInit,
  maxRetries = 2,
  retryDelayMs = 1000,
): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(url, options);
      // 429 (rate-limit) e 5xx são transitórios — mesmo backoff que já existia para 5xx.
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        console.log(`[OneBeleza] HTTP ${res.status} on ${url}, retrying in ${retryDelayMs}ms (attempt ${attempt + 1}/${maxRetries})...`);
        if (attempt < maxRetries - 1) {
          await new Promise((r) => setTimeout(r, retryDelayMs));
          continue;
        }
      }
      return res;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.log(`[OneBeleza] fetch error on ${url}: ${lastError.message}, retrying in ${retryDelayMs}ms (attempt ${attempt + 1}/${maxRetries})...`);
      if (attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }
  }
  if (lastError) {
    throw lastError;
  }
  return fetch(url, options);
}

export const shouldRetryOneBelezaWithEmail = (status: number, responseText: string) => {
  if (status >= 200 && status < 300) return false;
  const normalized = normalizeUserFacingText(responseText);

  return /\b(e-?mail|email)\b/.test(normalized) && (
    normalized.includes("obrigat") ||
    normalized.includes("required") ||
    normalized.includes("necessar") ||
    normalized.includes("inval") ||
    normalized.includes("ja esta em uso") ||
    normalized.includes("em uso") ||
    normalized.includes("already in use") ||
    normalized.includes("choose another")
  );
};

export async function verifyOneBelezaClientExists(
  authHeaders: Record<string, string>,
  celular: string,
): Promise<boolean> {
  try {
    const url = `https://onechatbotapi.azurewebsites.net/api/Clientes/GetClientePeloNumero?Celular=${celular}`;
    const r = await fetchOneBelezaWithRetry(url, { headers: authHeaders });
    const t = await r.text();
    if (!r.ok) return false;
    try {
      const parsed = JSON.parse(t);
      if (Array.isArray(parsed)) return parsed.length > 0;
      if (parsed && typeof parsed === "object") {
        return !!(parsed.codigo ?? parsed.id ?? parsed.clienteId);
      }
      return false;
    } catch {
      return false;
    }
  } catch (e) {
    console.error(`[OneBeleza] verifyClient error:`, (e as Error).message);
    return false;
  }
}

export async function registerOneBelezaClient(
  authHeaders: Record<string, string>,
  tel: string,
  nome: string,
  logPrefix: string,
  tenantId?: string,
): Promise<{ res: Response; text: string; aliasUsed?: string }> {
  const regUrl = "https://onetotemapi.azurewebsites.net/api/OLoginChatBot/CadastrarUsuario";

  const doRegister = async (celular: string, withEmail?: string) => {
    const body: Record<string, unknown> = { celular, nome: nome || "Cliente" };
    if (withEmail) body.email = withEmail;
    console.log(`${logPrefix} cadastrar_cliente URL: ${regUrl}`, JSON.stringify(body));
    const r = await fetchOneBelezaWithRetry(regUrl, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const t = await r.text();
    console.log(`${logPrefix} cadastrar_cliente response (${r.status}):`, t.slice(0, 500));
    return { r, t };
  };

  // 1. Tenta com telefone real
  let { r: res, t: text } = await doRegister(tel);

  // 2. Se erro de email → retry com email gerado
  if (shouldRetryOneBelezaWithEmail(res.status, text)) {
    const fallbackEmail = buildOneBelezaGenericEmail(tel);
    console.log(`${logPrefix} cadastrar_cliente retry with generated email: ${fallbackEmail}`);
    ({ r: res, t: text } = await doRegister(tel, fallbackEmail));
  }

  // Caminho feliz com telefone real
  if (isOneBelezaRegistrationSuccess(res.status, text)) {
    return { res, text };
  }

  // 3. Fallback de alias — só se temos tenant E o erro é "telefone já associado"
  //     ou se a resposta foi 2xx mas com corpo de erro (falso sucesso).
  const realPhoneTaken = isOneBelezaPhoneInUseError(res.status, text);
  const falseSuccess = res.status >= 200 && res.status < 300 && !isOneBelezaRegistrationSuccess(res.status, text);

  if (tenantId && (realPhoneTaken || falseSuccess)) {
    const MAX_ALIAS_TRIES = 5;
    let forceNew = false;
    for (let attempt = 1; attempt <= MAX_ALIAS_TRIES; attempt++) {
      let alias: string;
      try {
        alias = await getOrCreateOneBelezaAlias(tenantId, tel, nome, forceNew);
      } catch (e) {
        console.error(`${logPrefix} cadastrar_cliente alias generation error:`, (e as Error).message);
        break;
      }
      console.log(`${logPrefix} cadastrar_cliente attempt ${attempt}/${MAX_ALIAS_TRIES} with alias=${alias} (real=${tel})`);
      const aliasEmail = buildOneBelezaGenericEmail(alias);
      let aliasRes: Response;
      let aliasText: string;
      ({ r: aliasRes, t: aliasText } = await doRegister(alias, aliasEmail));
      if (shouldRetryOneBelezaWithEmail(aliasRes.status, aliasText)) {
        ({ r: aliasRes, t: aliasText } = await doRegister(alias));
      }

      // Sucesso real?
      if (isOneBelezaRegistrationSuccess(aliasRes.status, aliasText)) {
        // Verifica via GET para garantir persistência
        const exists = await verifyOneBelezaClientExists(authHeaders, alias);
        if (exists) {
          return { res: aliasRes, text: aliasText, aliasUsed: alias };
        }
        await burnOneBelezaAlias(tenantId, alias, "registration_returned_success_but_verify_failed");
        forceNew = true;
        continue;
      }

      // Falhou — alias está queimado (telefone associado ou falso-sucesso)
      const aliasTaken = isOneBelezaPhoneInUseError(aliasRes.status, aliasText);
      const aliasFalseSuccess = aliasRes.status >= 200 && aliasRes.status < 300;

      // Antes de queimar por "falso-sucesso", verifica se o cliente foi de fato
      // criado na API. Alguns endpoints retornam 2xx com corpo ambíguo, mas o
      // cadastro foi persistido — nesse caso o alias deve permanecer ativo.
      if (aliasFalseSuccess && !aliasTaken) {
        const existsAfterAmbiguous = await verifyOneBelezaClientExists(authHeaders, alias);
        if (existsAfterAmbiguous) {
          console.log(`${logPrefix} cadastrar_cliente ambiguous 2xx but client exists in API → keep alias=${alias}`);
          return { res: aliasRes, text: aliasText, aliasUsed: alias };
        }
      }

      const reason = aliasTaken
        ? "alias_phone_already_associated"
        : (aliasFalseSuccess ? "alias_registration_false_success" : `alias_registration_failed_${aliasRes.status}`);
      await burnOneBelezaAlias(tenantId, alias, reason);
      forceNew = true;
      // Atualiza last response para retornar caso esgote tentativas
      res = aliasRes;
      text = aliasText;
    }
    console.error(`${logPrefix} cadastrar_cliente esgotou ${MAX_ALIAS_TRIES} tentativas de alias`);
  }

  return { res, text };
}

export interface OneBelezaServiceOption {
  servicosId: number;
  descricao: string;
}

export interface OneBelezaProfessionalOption {
  servicosId: number | null;
  profissionalId: number;
  nomeProfissional: string;
}

export interface OneBelezaSlotOption {
  date: string;
  servicoId: number;
  profissionalId: number;
  horarioInicio: string;
  horarioFim: string;
}

export function resolveOneBelezaServiceId(
  args: any,
  sessionState: AgentSessionState,
): { id: number | null; corrected: boolean; reason: string | null } {
  const rawId = toPositiveInteger(args?.servicosId ?? args?.servicoId ?? args?.servicoid);
  
  if (!rawId) {
    // Use selected if available
    if (sessionState.selectedServiceId) {
      return { id: sessionState.selectedServiceId, corrected: true, reason: `servicoId ausente, usando seleção persistida ${sessionState.selectedServiceId}` };
    }
    return { id: null, corrected: false, reason: null };
  }

  // Check if the ID is valid
  const isValid = sessionState.oneBelezaServiceOptions.some(o => o.servicosId === rawId);
  if (isValid) {
    return { id: rawId, corrected: false, reason: null };
  }

  // Try to find by closest match or use selected
  if (sessionState.selectedServiceId) {
    const selectedValid = sessionState.oneBelezaServiceOptions.some(o => o.servicosId === sessionState.selectedServiceId);
    if (selectedValid) {
      return { id: sessionState.selectedServiceId, corrected: true, reason: `servicoId ${rawId} inválido, corrigido para ${sessionState.selectedServiceId} (persistido)` };
    }
  }

  // Single option auto-correct
  if (sessionState.oneBelezaServiceOptions.length === 1) {
    const onlyId = sessionState.oneBelezaServiceOptions[0].servicosId;
    return { id: onlyId, corrected: true, reason: `servicoId ${rawId} inválido, corrigido para único válido ${onlyId}` };
  }

  return { id: rawId, corrected: false, reason: null };
}

export function resolveOneBelezaProfessionalId(
  args: any,
  sessionState: AgentSessionState,
  servicoId: number | null,
): { id: number | null; corrected: boolean; reason: string | null } {
  const rawId = toPositiveInteger(args?.profissionalId ?? args?.ProfissionalId ?? args?.profissionalid);
  
  if (!rawId) {
    if (sessionState.selectedProfessionalId) {
      return { id: sessionState.selectedProfessionalId, corrected: true, reason: `profissionalId ausente, usando seleção persistida ${sessionState.selectedProfessionalId}` };
    }
    return { id: null, corrected: false, reason: null };
  }

  // Check if the ID is valid in known professionals
  const validProfessionals = sessionState.oneBelezaProfessionalOptions.filter(
    o => o.servicosId === servicoId || o.servicosId === null
  );

  if (validProfessionals.length === 0) {
    // No professionals tracked yet — let it through
    return { id: rawId, corrected: false, reason: null };
  }

  const isValid = validProfessionals.some(o => o.profissionalId === rawId);
  if (isValid) {
    return { id: rawId, corrected: false, reason: null };
  }

  // Use persisted selection
  if (sessionState.selectedProfessionalId) {
    const selectedValid = validProfessionals.some(o => o.profissionalId === sessionState.selectedProfessionalId);
    if (selectedValid) {
      return { id: sessionState.selectedProfessionalId, corrected: true, reason: `profissionalId ${rawId} inválido, corrigido para ${sessionState.selectedProfessionalId} (persistido)` };
    }
  }

  // Single option auto-correct
  if (validProfessionals.length === 1) {
    const onlyId = validProfessionals[0].profissionalId;
    return { id: onlyId, corrected: true, reason: `profissionalId ${rawId} inválido, corrigido para único válido ${onlyId}` };
  }

  // Block with helpful error
  return { id: null, corrected: false, reason: `profissionalId ${rawId} não encontrado entre os válidos: ${validProfessionals.map(p => `${p.profissionalId} (${p.nomeProfissional})`).join(", ")}` };
}

export function resolveOneBelezaToolArgs(
  toolName: string,
  parsedArgs: any,
  sessionState: AgentSessionState,
): IdResolutionResult {
  const result: IdResolutionResult = {
    resolvedArgs: { ...parsedArgs },
    corrected: false,
    correctionReason: null,
    blocked: false,
    blockMessage: null,
  };

  const corrections: string[] = [];
  const shouldGuardServiceId = ["buscar_barbeiros_por_servico", "buscar_horarios", "buscar_horarios_disponiveis", "agendar"].includes(toolName);
  const allowedServiceIds = getAllowedOneBelezaServiceIds(sessionState);

  if (shouldGuardServiceId && allowedServiceIds.length > 0) {
    const incomingServiceId = toPositiveInteger(
      parsedArgs?.servicosId ?? parsedArgs?.servicoId ?? parsedArgs?.servicoid,
    );

    if (incomingServiceId && !allowedServiceIds.includes(incomingServiceId)) {
      result.blocked = true;
      result.blockMessage = `servicosId ${incomingServiceId} não pertence à unidade desta barbearia. Use APENAS um destes IDs: ${allowedServiceIds.join(", ")}.`;
      return result;
    }

    // Unit guard: prevent silently switching between gservsID groups (e.g., Barbearia ↔ Estúdio) mid-flow
    const unitMap = (sessionState as any).oneBelezaServiceUnitMap as
      | Record<string, { gservsID: number; descricao: string }>
      | undefined;
    const selectedUnit = (sessionState as any).selectedUnit as
      | { gservsID: number; descricao: string }
      | undefined;
    if (incomingServiceId && unitMap && unitMap[String(incomingServiceId)]) {
      const incomingUnit = unitMap[String(incomingServiceId)];
      if (selectedUnit && selectedUnit.gservsID !== incomingUnit.gservsID) {
        result.blocked = true;
        result.blockMessage = `servicosId ${incomingServiceId} pertence a "${incomingUnit.descricao}", mas o cliente já está sendo atendido em "${selectedUnit.descricao}". Confirme com o cliente se ele quer trocar de unidade antes de prosseguir.`;
        return result;
      }
      // Auto-set selected unit if not yet defined
      if (!selectedUnit) {
        (sessionState as any).selectedUnit = incomingUnit;
        console.log(`[State] Auto-selected OneBeleza unit: ${incomingUnit.descricao} (gservsID=${incomingUnit.gservsID}) via servicosId=${incomingServiceId}`);
      }
    }
  }

  if (toolName === "buscar_barbeiros_por_servico") {
    const svc = resolveOneBelezaServiceId(parsedArgs, sessionState);
    if (svc.id && svc.corrected) {
      result.resolvedArgs.servicosId = String(svc.id);
      corrections.push(svc.reason!);
    } else if (!svc.id && sessionState.oneBelezaServiceOptions.length > 0) {
      result.blocked = true;
      result.blockMessage = `servicosId ${parsedArgs?.servicosId ?? "(ausente)"} inválido. Opções válidas: ${sessionState.oneBelezaServiceOptions.map(o => `${o.servicosId} (${o.descricao})`).join(", ")}`;
    }
  }

  if (toolName === "buscar_horarios_disponiveis") {
    const svc = resolveOneBelezaServiceId({ servicoId: parsedArgs?.servicoId ?? parsedArgs?.servicosId }, sessionState);
    if (svc.id && svc.corrected) {
      result.resolvedArgs.servicoId = String(svc.id);
      corrections.push(svc.reason!);
    } else if (!svc.id && svc.reason) {
      result.blocked = true;
      result.blockMessage = svc.reason;
    }
    const rawDate = normalizeOneBelezaDate(parsedArgs?.date);
    if (!rawDate && sessionState.selectedDate) {
      result.resolvedArgs.date = sessionState.selectedDate;
      corrections.push(`date ausente, usando data persistida ${sessionState.selectedDate}`);
    }
  }

  if (toolName === "buscar_horarios") {
    const svc = resolveOneBelezaServiceId({ servicoId: parsedArgs?.servicoId }, sessionState);
    if (svc.id && svc.corrected) {
      result.resolvedArgs.servicoId = String(svc.id);
      corrections.push(svc.reason!);
    }
    const prof = resolveOneBelezaProfessionalId(parsedArgs, sessionState, svc.id ?? toPositiveInteger(parsedArgs?.servicoId));
    if (prof.id && prof.corrected) {
      result.resolvedArgs.ProfissionalId = String(prof.id);
      corrections.push(prof.reason!);
    } else if (!prof.id && prof.reason) {
      result.blocked = true;
      result.blockMessage = prof.reason;
    }

    // Resolve date from persisted state
    const rawDate = normalizeOneBelezaDate(parsedArgs?.date);
    if (!rawDate && sessionState.selectedDate) {
      result.resolvedArgs.date = sessionState.selectedDate;
      corrections.push(`date ausente, usando data persistida ${sessionState.selectedDate}`);
    }
  }

  if (toolName === "agendar") {
    // Service
    const svc = resolveOneBelezaServiceId({ servicoId: parsedArgs?.servicoid ?? parsedArgs?.servicoId ?? parsedArgs?.servicosId }, sessionState);
    if (svc.id && svc.corrected) {
      result.resolvedArgs.servicoid = String(svc.id);
      corrections.push(svc.reason!);
    }
    // Professional
    const prof = resolveOneBelezaProfessionalId(parsedArgs, sessionState, svc.id);
    if (prof.id && prof.corrected) {
      result.resolvedArgs.profissionalId = String(prof.id);
      corrections.push(prof.reason!);
    }
    // Date
    const rawDate = normalizeOneBelezaDate(parsedArgs?.dataNumero ?? parsedArgs?.dataAg ?? parsedArgs?.date ?? parsedArgs?.data);
    if (!rawDate && sessionState.selectedDate) {
      result.resolvedArgs.dataNumero = sessionState.selectedDate;
      corrections.push(`dataNumero ausente, usando data persistida ${sessionState.selectedDate}`);
    }
  }

  if (corrections.length > 0) {
    result.corrected = true;
    result.correctionReason = corrections.join("; ");
    console.log(`[IDResolver] ${toolName} corrections: ${result.correctionReason}`);
  }

  return result;
}

export function reconcileOneBelezaAgendaId(
  hallucinated: number,
  sessionState: AgentSessionState,
  messages: any[],
): number | null {
  const validIds = sessionState.validAgendasIds;
  const agendaOptions = (sessionState as any).oneBelezaAgendaOptions as any[] | undefined;

  if (validIds.length === 1) return validIds[0];

  if (agendaOptions && agendaOptions.length > 0) {
    const lastAssistantMsg = [...messages].reverse().find((m: any) => m.role === "assistant" && typeof m.content === "string");
    const assistantText = lastAssistantMsg?.content || "";

    const timeMatch = assistantText.match(/(\d{1,2})[h:](\d{2})/);
    if (timeMatch) {
      const mentionedTime = `${timeMatch[1].padStart(2, "0")}:${timeMatch[2]}`;
      const matchByTime = agendaOptions.find((a: any) => (a.horarioInicio || "").substring(0, 5) === mentionedTime);
      if (matchByTime) return matchByTime.agendasId;
    }

    for (const agenda of agendaOptions) {
      if (agenda.descricaoServico && assistantText.toLowerCase().includes(agenda.descricaoServico.toLowerCase())) {
        const serviceMatches = agendaOptions.filter((a: any) => a.descricaoServico?.toLowerCase() === agenda.descricaoServico.toLowerCase());
        if (serviceMatches.length === 1) return serviceMatches[0].agendasId;
      }
    }
  }

  console.log(`[OneBeleza] reconcileAgendaId: fallback to first valid ID ${validIds[0]}`);
  return validIds[0];
}

export function normalizeOneBelezaDate(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";

  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return normalized;
  }

  const brMatch = normalized.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (brMatch) {
    const [, day, month, year] = brMatch;
    return `${year}-${month}-${day}`;
  }

  return normalized;
}

export function normalizeOneBelezaTime(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";

  if (/^\d{2}:\d{2}$/.test(normalized)) {
    return `${normalized}:00`;
  }

  return normalized;
}

export function getOneBelezaUnitFilterList(tenant: any): string[] {
  const rawFilter = tenant?.agent_settings?.onebeleza_unit_filter;
  const list = Array.isArray(rawFilter)
    ? rawFilter.filter((value: unknown) => typeof value === "string" && value.trim())
    : (typeof rawFilter === "string" && rawFilter.trim() ? [rawFilter] : []);

  return dedupeByKey(list.map((value) => value.trim()), (value) => normalizeSearchText(value));
}

export function getAllowedOneBelezaServiceIds(sessionState: AgentSessionState): number[] {
  if (sessionState.allowedServiceIds.length > 0) {
    return dedupeByKey(sessionState.allowedServiceIds, (id) => String(id));
  }

  return dedupeByKey(
    sessionState.oneBelezaServiceOptions.map((option) => option.servicosId),
    (id) => String(id),
  );
}

export function extractOneBelezaServiceOptions(toolResult: any): OneBelezaServiceOption[] {
  if (!Array.isArray(toolResult)) return [];

  const options: OneBelezaServiceOption[] = [];

  for (const groupOrService of toolResult) {
    const groupedServices = Array.isArray(groupOrService?.servicos)
      ? groupOrService.servicos
      : [groupOrService];

    for (const service of groupedServices) {
      const servicosId = toPositiveInteger(service?.servicosId ?? service?.servicoId ?? service?.id);
      if (!servicosId) continue;

      options.push({
        servicosId,
        descricao: String(service?.descricao || groupOrService?.descricao || `Serviço ${servicosId}`),
      });
    }
  }

  return dedupeByKey(options, (option) => String(option.servicosId));
}

export function extractOneBelezaProfessionalOptions(toolResult: any, args: any): OneBelezaProfessionalOption[] {
  if (!Array.isArray(toolResult)) return [];

  const servicosId = toPositiveInteger(args?.servicosId ?? args?.servicoId ?? args?.servicoid);
  const options = toolResult.flatMap((item: any) => {
    const profissionalId = toPositiveInteger(item?.profissionalId ?? item?.id);
    if (!profissionalId) return [];

    return [{
      servicosId,
      profissionalId,
      nomeProfissional: String(item?.nomeProfissional || item?.nome || item?.descricao || `Profissional ${profissionalId}`),
    }];
  });

  return dedupeByKey(options, (option) => `${option.servicosId ?? "any"}:${option.profissionalId}`);
}

export function extractOneBelezaProfessionalOptionsFromAvailability(toolResult: any, args: any): OneBelezaProfessionalOption[] {
  if (!Array.isArray(toolResult)) return [];

  const servicosId = toPositiveInteger(args?.servicoId ?? args?.servicosId ?? args?.servicoid);
  const options: OneBelezaProfessionalOption[] = [];

  for (const item of toolResult) {
    const disponibilidades = Array.isArray(item?.disponibilidades) ? item.disponibilidades : [];
    for (const disponibilidade of disponibilidades) {
      const profissionalId = toPositiveInteger(disponibilidade?.profissionalId);
      if (!profissionalId) continue;

      options.push({
        servicosId,
        profissionalId,
        nomeProfissional: String(
          disponibilidade?.profissionalNome || disponibilidade?.nomeProfissional || disponibilidade?.nome || `Profissional ${profissionalId}`,
        ),
      });
    }
  }

  return dedupeByKey(options, (option) => `${option.servicosId ?? "any"}:${option.profissionalId}`);
}

export function extractOneBelezaSlotOptions(toolResult: any, args: any): OneBelezaSlotOption[] {
  if (!Array.isArray(toolResult)) return [];

  const date = normalizeOneBelezaDate(args?.date ?? args?.dataNumero ?? args?.dataAg ?? args?.data);
  const fallbackServiceId = toPositiveInteger(args?.servicoId ?? args?.servicoid ?? args?.servicosId);
  const fallbackProfessionalId = toPositiveInteger(args?.ProfissionalId ?? args?.profissionalId ?? args?.profissionalid);
  const slots: OneBelezaSlotOption[] = [];

  const pushSlot = (
    servicoIdValue: unknown,
    profissionalIdValue: unknown,
    horarioInicioValue: unknown,
    horarioFimValue: unknown,
  ) => {
    const servicoId = toPositiveInteger(servicoIdValue);
    const profissionalId = toPositiveInteger(profissionalIdValue);
    const horarioInicio = String(horarioInicioValue ?? "").trim();
    const horarioFim = String(horarioFimValue ?? "").trim();

    if (!date || !servicoId || !profissionalId || !horarioInicio || !horarioFim) return;

    slots.push({
      date,
      servicoId,
      profissionalId,
      horarioInicio,
      horarioFim,
    });
  };

  for (const item of toolResult) {
    if (Array.isArray(item?.disponibilidades)) {
      const itemServiceId = toPositiveInteger(item?.servicoId ?? item?.servicosId ?? fallbackServiceId);

      for (const disponibilidade of item.disponibilidades) {
        const itemProfessionalId = toPositiveInteger(disponibilidade?.profissionalId ?? fallbackProfessionalId);
        const horarios = Array.isArray(disponibilidade?.horarios) ? disponibilidade.horarios : [];

        for (const horario of horarios) {
          pushSlot(
            itemServiceId,
            itemProfessionalId,
            horario?.horarioInicio,
            horario?.horarioFinal ?? horario?.horarioFim,
          );
        }
      }
    }

    pushSlot(
      item?.servicoId ?? fallbackServiceId,
      item?.profissionalId ?? fallbackProfessionalId,
      item?.horarioInicio,
      item?.horarioFinal ?? item?.horarioFim,
    );
  }

  return dedupeByKey(
    slots,
    (slot) => `${slot.date}:${slot.servicoId}:${slot.profissionalId}:${slot.horarioInicio}:${slot.horarioFim}`,
  );
}

export function buildNormalizedOneBelezaAgendarArgs(parsedArgs: any, slot: OneBelezaSlotOption): any {
  return {
    ...parsedArgs,
    dataNumero: slot.date,
    servicoid: String(slot.servicoId),
    profissionalId: String(slot.profissionalId),
    horarioInicio: slot.horarioInicio,
    horarioFim: slot.horarioFim,
  };
}

export function reconcileOneBelezaSchedulingArgs(
  parsedArgs: any,
  sessionState: AgentSessionState,
): { args: any; adjusted: boolean; corrected: boolean } {
  const servicoId = toPositiveInteger(parsedArgs?.servicoid ?? parsedArgs?.servicoId ?? parsedArgs?.servicosId);
  const profissionalId = toPositiveInteger(parsedArgs?.profissionalId ?? parsedArgs?.ProfissionalId ?? parsedArgs?.profissionalid);
  const dataNumero = normalizeOneBelezaDate(parsedArgs?.dataNumero ?? parsedArgs?.dataAg ?? parsedArgs?.date ?? parsedArgs?.data);
  const horarioInicio = normalizeOneBelezaTime(parsedArgs?.horarioInicio);
  const horarioFim = normalizeOneBelezaTime(parsedArgs?.horarioFim ?? parsedArgs?.horarioFinal);

  const normalizedArgs = {
    ...parsedArgs,
    ...(dataNumero ? { dataNumero } : {}),
    ...(servicoId ? { servicoid: String(servicoId) } : {}),
    ...(profissionalId ? { profissionalId: String(profissionalId) } : {}),
    ...(horarioInicio ? { horarioInicio } : {}),
    ...(horarioFim ? { horarioFim } : {}),
  };

  // AUTO-FILL profissionalId quando ausente: se temos slots no estado da sessão
  // que combinam servicoId + data + horarioInicio, escolhemos o profissional do
  // primeiro slot compatível (= "qualquer barbeiro" se vários).
  let effectiveProfissionalId = profissionalId;
  if (!effectiveProfissionalId && servicoId && dataNumero && horarioInicio) {
    const candidateSlots = sessionState.oneBelezaSlotOptions.filter((slot) => {
      if (slot.servicoId !== servicoId) return false;
      if (slot.date !== dataNumero) return false;
      if (slot.horarioInicio !== horarioInicio) return false;
      if (horarioFim && slot.horarioFim !== horarioFim) return false;
      return true;
    });
    if (candidateSlots.length > 0) {
      effectiveProfissionalId = candidateSlots[0].profissionalId;
      normalizedArgs.profissionalId = String(effectiveProfissionalId);
      console.log(
        `[OneBeleza] reconcile auto-filled profissionalId=${effectiveProfissionalId} from slot match (servico=${servicoId}, data=${dataNumero}, inicio=${horarioInicio}, candidates=${candidateSlots.length})`,
      );
    }
  }

  if (!servicoId || !effectiveProfissionalId || !dataNumero || !horarioInicio) {
    return {
      args: normalizedArgs,
      adjusted: JSON.stringify(normalizedArgs) !== JSON.stringify(parsedArgs),
      corrected: !!effectiveProfissionalId && effectiveProfissionalId !== profissionalId,
    };
  }

  // Reatribui para que o restante do código use o valor efetivo
  const profissionalIdResolved = effectiveProfissionalId;

  const validSlotOptionsForDate = sessionState.oneBelezaSlotOptions.filter((slot) => {
    if (slot.servicoId !== servicoId) return false;
    if (slot.date !== dataNumero) return false;
    return true;
  });

  const validSlotOptions = validSlotOptionsForDate.filter((slot) => slot.profissionalId === profissionalIdResolved);

  const wasAutoFilled = !profissionalId && !!profissionalIdResolved;

  if (validSlotOptions.length === 0 && horarioInicio) {
    const uniqueStartMatchAcrossProfessionals = validSlotOptionsForDate.filter((slot) => {
      if (slot.horarioInicio !== horarioInicio) return false;
      if (horarioFim && slot.horarioFim !== horarioFim) return false;
      return true;
    });

    if (uniqueStartMatchAcrossProfessionals.length === 1) {
      return {
        args: buildNormalizedOneBelezaAgendarArgs(normalizedArgs, uniqueStartMatchAcrossProfessionals[0]),
        adjusted: true,
        corrected: true,
      };
    }
  }

  if (validSlotOptions.length === 0) {
    return {
      args: normalizedArgs,
      adjusted: JSON.stringify(normalizedArgs) !== JSON.stringify(parsedArgs),
      corrected: false,
    };
  }

  const exactMatch = validSlotOptions.find(
    (slot) => slot.horarioInicio === horarioInicio && slot.horarioFim === horarioFim,
  );
  if (exactMatch) {
    const exactArgs = buildNormalizedOneBelezaAgendarArgs(normalizedArgs, exactMatch);
    return {
      args: exactArgs,
      adjusted: JSON.stringify(exactArgs) !== JSON.stringify(parsedArgs),
      corrected: wasAutoFilled,
    };
  }


  const startOnlyMatch = validSlotOptions.find((slot) => slot.horarioInicio === horarioInicio);
  if (!startOnlyMatch) {
    return {
      args: normalizedArgs,
      adjusted: JSON.stringify(normalizedArgs) !== JSON.stringify(parsedArgs),
      corrected: false,
    };
  }

  return {
    args: buildNormalizedOneBelezaAgendarArgs(normalizedArgs, startOnlyMatch),
    adjusted: true,
    corrected: horarioFim !== startOnlyMatch.horarioFim,
  };
}

export function buildOneBelezaSchedulingValidationResult(
  parsedArgs: any,
  sessionState: AgentSessionState,
): any | null {
  const allowedServiceIds = getAllowedOneBelezaServiceIds(sessionState);

  if (sessionState.oneBelezaServiceOptions.length === 0) {
    return {
      error: "Antes de agendar, execute buscar_servicos nesta interação e use um servicosId real do retorno.",
      blocked: true,
    };
  }

  if (sessionState.oneBelezaProfessionalOptions.length === 0) {
    return {
      error: "Antes de agendar, execute buscar_barbeiros_por_servico nesta interação e use um profissionalId real do retorno.",
      blocked: true,
    };
  }

  if (sessionState.oneBelezaSlotOptions.length === 0) {
    return {
      error: "Antes de agendar, execute buscar_horarios nesta interação e use exatamente um horário retornado.",
      blocked: true,
    };
  }

  const servicoId = toPositiveInteger(parsedArgs?.servicoid ?? parsedArgs?.servicoId ?? parsedArgs?.servicosId);
  const profissionalId = toPositiveInteger(parsedArgs?.profissionalId ?? parsedArgs?.ProfissionalId ?? parsedArgs?.profissionalid);
  const dataNumero = normalizeOneBelezaDate(parsedArgs?.dataNumero ?? parsedArgs?.dataAg ?? parsedArgs?.date ?? parsedArgs?.data);
  const horarioInicio = normalizeOneBelezaTime(parsedArgs?.horarioInicio);
  const horarioFim = normalizeOneBelezaTime(parsedArgs?.horarioFim ?? parsedArgs?.horarioFinal);

  if (servicoId && allowedServiceIds.length > 0 && !allowedServiceIds.includes(servicoId)) {
    return {
      error: `servicoId ${servicoId} não pertence à unidade desta barbearia. Use APENAS um dos IDs permitidos: ${allowedServiceIds.join(", ")}.`,
      allowedServiceIds,
      blocked: true,
    };
  }

  if (!servicoId || !sessionState.oneBelezaServiceOptions.some((option) => option.servicosId === servicoId)) {
    return {
      error: `servicoId ${servicoId ?? "(ausente)"} inválido. Use APENAS um servicosId real retornado por buscar_servicos nesta interação.`,
      validServiceOptions: sessionState.oneBelezaServiceOptions,
      blocked: true,
    };
  }

  const validProfessionalOptions = dedupeByKey(
    sessionState.oneBelezaProfessionalOptions.filter((option) => option.servicosId === servicoId || option.servicosId === null),
    (option) => String(option.profissionalId),
  );

  if (
    validProfessionalOptions.length > 0 &&
    (!profissionalId || !validProfessionalOptions.some((option) => option.profissionalId === profissionalId))
  ) {
    // Mensagem mais didática: lista nomes + IDs reais e dica de auto-fill quando há horário
    const optsForPrompt = validProfessionalOptions.map((o) => ({
      profissionalId: o.profissionalId,
      nome: o.nomeProfissional,
    }));
    const hint = horarioInicio
      ? ` Se o cliente disse "qualquer barbeiro", escolha o primeiro profissionalId da lista que tenha esse horário disponível e chame agendar novamente com esse profissionalId.`
      : ` Pergunte ao cliente qual desses profissionais ele prefere, ou se "qualquer barbeiro", use o primeiro da lista.`;
    return {
      error: `profissionalId ${profissionalId ?? "(ausente)"} inválido para o serviço ${servicoId}. Use APENAS um dos profissionalId reais listados.${hint}`,
      validProfessionalOptions: optsForPrompt,
      blocked: true,
    };
  }

  if (!dataNumero || !horarioInicio || !horarioFim) {
    return {
      error: "dataNumero, horarioInicio e horarioFim são obrigatórios e devem vir EXATAMENTE do retorno de buscar_horarios.",
      validSlotOptions: sessionState.oneBelezaSlotOptions.slice(0, 20),
      blocked: true,
    };
  }

  const validSlotOptions = sessionState.oneBelezaSlotOptions.filter((slot) => {
    if (slot.servicoId !== servicoId) return false;
    if (profissionalId && slot.profissionalId !== profissionalId) return false;
    if (slot.date !== dataNumero) return false;
    return true;
  });

  if (validSlotOptions.length === 0) {
    return {
      error: `A combinação serviço=${servicoId}, profissional=${profissionalId ?? "(ausente)"} e data=${dataNumero || "(ausente)"} não foi retornada por buscar_horarios nesta interação.`,
      validSlotOptions: sessionState.oneBelezaSlotOptions.slice(0, 20),
      blocked: true,
    };
  }

  const matchingSlot = validSlotOptions.find(
    (slot) => slot.horarioInicio === horarioInicio && slot.horarioFim === horarioFim,
  );

  if (!matchingSlot) {
    return {
      error: `Horário ${horarioInicio} → ${horarioFim} inválido para serviço=${servicoId}, profissional=${profissionalId ?? "(ausente)"} e data=${dataNumero}. Use APENAS uma combinação EXATA retornada por buscar_horarios nesta interação.`,
      validSlotOptions: validSlotOptions.slice(0, 20),
      blocked: true,
    };
  }

  return null;
}

export async function hydrateOneBelezaSessionStateFromProvider(
  tenant: any,
  parsedArgs: any,
  sessionState: AgentSessionState,
): Promise<void> {
  const servicoId = toPositiveInteger(parsedArgs?.servicoid ?? parsedArgs?.servicoId ?? parsedArgs?.servicosId);
  const profissionalId = toPositiveInteger(parsedArgs?.profissionalId ?? parsedArgs?.ProfissionalId ?? parsedArgs?.profissionalid);
  const dataNumero = normalizeOneBelezaDate(parsedArgs?.dataNumero ?? parsedArgs?.dataAg ?? parsedArgs?.date ?? parsedArgs?.data);

  if (!servicoId) return;

  const hasService = sessionState.oneBelezaServiceOptions.some((option) => option.servicosId === servicoId);
  if (!hasService) {
    const serviceResult = await executeOneBelezaTool(
      tenant,
      { function: { name: "buscar_servicos", arguments: "{}" } },
    );
    const serviceOptions = extractOneBelezaServiceOptions(serviceResult);
    if (serviceOptions.length > 0) {
      sessionState.oneBelezaServiceOptions = dedupeByKey(
        [...sessionState.oneBelezaServiceOptions, ...serviceOptions],
        (option) => String(option.servicosId),
      );
      sessionState.allowedServiceIds = dedupeByKey(
        [...sessionState.allowedServiceIds, ...serviceOptions.map((option) => option.servicosId)],
        (id) => String(id),
      );
      console.log(`Hydrated OneBeleza service IDs: [${sessionState.oneBelezaServiceOptions.map((option) => option.servicosId).join(", ")}]`);
    }
  }

  if (profissionalId) {
    const hasProfessional = sessionState.oneBelezaProfessionalOptions.some(
      (option) => option.profissionalId === profissionalId && (option.servicosId === servicoId || option.servicosId === null),
    );

    if (!hasProfessional) {
      const professionalArgs = { servicosId: String(servicoId) };
      const professionalResult = await executeOneBelezaTool(
        tenant,
        {
          function: {
            name: "buscar_barbeiros_por_servico",
            arguments: JSON.stringify(professionalArgs),
          },
        },
      );
      const professionalOptions = extractOneBelezaProfessionalOptions(professionalResult, professionalArgs);
      if (professionalOptions.length > 0) {
        sessionState.oneBelezaProfessionalOptions = dedupeByKey(
          [...sessionState.oneBelezaProfessionalOptions, ...professionalOptions],
          (option) => `${option.servicosId ?? "any"}:${option.profissionalId}`,
        );
        console.log(`Hydrated OneBeleza professional IDs: [${sessionState.oneBelezaProfessionalOptions.map((option) => option.profissionalId).join(", ")}]`);
      }
    }
  }

  const effectiveProfessionalId = (() => {
    if (!profissionalId) return null;
    const isTrackedForService = sessionState.oneBelezaProfessionalOptions.some(
      (option) => option.profissionalId === profissionalId && (option.servicosId === servicoId || option.servicosId === null),
    );
    return isTrackedForService ? profissionalId : null;
  })();

  if (dataNumero && (!effectiveProfessionalId || sessionState.oneBelezaSlotOptions.length === 0)) {
    const consolidatedArgs = {
      date: dataNumero,
      servicoId: String(servicoId),
    };
    const consolidatedResult = await executeOneBelezaTool(
      tenant,
      {
        function: {
          name: "buscar_horarios_disponiveis",
          arguments: JSON.stringify(consolidatedArgs),
        },
      },
    );
    const consolidatedProfessionalOptions = extractOneBelezaProfessionalOptionsFromAvailability(consolidatedResult, consolidatedArgs);
    const consolidatedSlotOptions = extractOneBelezaSlotOptions(consolidatedResult, consolidatedArgs);

    if (consolidatedProfessionalOptions.length > 0) {
      sessionState.oneBelezaProfessionalOptions = dedupeByKey(
        [...sessionState.oneBelezaProfessionalOptions, ...consolidatedProfessionalOptions],
        (option) => `${option.servicosId ?? "any"}:${option.profissionalId}`,
      );
      console.log(`Hydrated OneBeleza professional IDs (from consolidated): [${sessionState.oneBelezaProfessionalOptions.map((option) => option.profissionalId).join(", ")}]`);
    }

    if (consolidatedSlotOptions.length > 0) {
      sessionState.oneBelezaSlotOptions = dedupeByKey(
        [...sessionState.oneBelezaSlotOptions, ...consolidatedSlotOptions],
        (slot) => `${slot.date}:${slot.servicoId}:${slot.profissionalId}:${slot.horarioInicio}:${slot.horarioFim}`,
      );
      console.log(`Hydrated OneBeleza slot options (from consolidated): ${sessionState.oneBelezaSlotOptions.length}`);
    }
  }

  if (effectiveProfessionalId && dataNumero) {
    const hasSlot = sessionState.oneBelezaSlotOptions.some(
      (slot) => slot.servicoId === servicoId && slot.profissionalId === effectiveProfessionalId && slot.date === dataNumero,
    );

    if (!hasSlot) {
      const slotArgs = {
        date: dataNumero,
        servicoId: String(servicoId),
        ProfissionalId: String(effectiveProfessionalId),
      };
      const slotResult = await executeOneBelezaTool(
        tenant,
        {
          function: {
            name: "buscar_horarios",
            arguments: JSON.stringify(slotArgs),
          },
        },
      );
      const slotOptions = extractOneBelezaSlotOptions(slotResult, slotArgs);
      if (slotOptions.length > 0) {
        sessionState.oneBelezaSlotOptions = dedupeByKey(
          [...sessionState.oneBelezaSlotOptions, ...slotOptions],
          (slot) => `${slot.date}:${slot.servicoId}:${slot.profissionalId}:${slot.horarioInicio}:${slot.horarioFim}`,
        );
        console.log(`Hydrated OneBeleza slot options: ${sessionState.oneBelezaSlotOptions.length}`);
      }
    }
  }
}

export function buildOneBelezaTools(tenant: any) {
  if (!tenant.onebeleza_token || !tenant.onebeleza_celular) return undefined;

  return [
    {
      type: "function",
      function: {
        name: "buscar_cliente",
        description: "Busca um cliente pelo telefone. Use SEMPRE como primeira ação. Se retornar vazio → cliente não existe, usar cadastrar_cliente.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: "cadastrar_cliente",
        description: "Cadastra um novo cliente. Use quando buscar_cliente retornar vazio. Envie apenas o nome do cliente.",
        parameters: {
          type: "object",
          properties: {
            nome: { type: "string", description: "Nome do cliente" },
          },
          required: ["nome"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "buscar_servicos",
        description: "Lista todos os serviços disponíveis separados por grupos. Retorna servicoId necessário para os próximos passos.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: "buscar_horarios_disponiveis",
        description: "🔥 FERRAMENTA OTIMIZADA: para uma data + serviço, retorna TODOS os profissionais habilitados E seus horários disponíveis em UMA ÚNICA chamada. Use SEMPRE após buscar_servicos. Resposta inclui disponibilidades[].profissionalId + disponibilidades[].horarios[].horarioInicio/horarioFinal.",
        parameters: {
          type: "object",
          properties: {
            date: { type: "string", description: "Data no formato YYYY-MM-DD" },
            servicoId: { type: "string", description: "ID do serviço retornado por buscar_servicos (campo servicosId)" },
          },
          required: ["date", "servicoId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "agendar",
        description: "Cria o agendamento. ⚠️ SÓ EXECUTE APÓS CONFIRMAÇÃO DO CLIENTE. Use os nomes EXATOS dos parâmetros: dataNumero, servicoid, profissionalId, horarioInicio, horarioFim.",
         parameters: {
           type: "object",
           properties: {
             dataNumero: { type: "string", description: "Data no formato YYYY-MM-DD" },
             servicoid: { type: "string", description: "ID numérico do serviço — campo 'servicosId' retornado por BUSCAR SERVIÇOS" },
             profissionalId: { type: "string", description: "ID numérico do profissional — retornado por BUSCAR_BARBEIROS_POR_SERVICO" },
             horarioInicio: { type: "string", description: "Horário início no formato HH:MM:SS — retornado por BUSCAR HORÁRIOS" },
             horarioFim: { type: "string", description: "Horário fim no formato HH:MM:SS — retornado por BUSCAR HORÁRIOS" },
           },
           required: ["dataNumero", "servicoid", "profissionalId", "horarioInicio", "horarioFim"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "buscar_agendamentos_dia",
        description: "Busca todos os agendamentos de um dia específico. Útil para confirmação e lembretes.",
        parameters: {
          type: "object",
          properties: {
            date: { type: "string", description: "Data no formato YYYY-MM-DD" },
          },
          required: ["date"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "confirmar_agendamento",
        description: "Confirma um agendamento existente.",
        parameters: {
          type: "object",
          properties: {
            agendasId: { type: "string", description: "ID do agendamento a confirmar" },
          },
          required: ["agendasId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "desmarcar_agendamento",
        description: "Desmarca/cancela um agendamento existente.",
        parameters: {
          type: "object",
          properties: {
            agendasId: { type: "string", description: "ID do agendamento a desmarcar" },
          },
          required: ["agendasId"],
        },
      },
    },
  ];
}

export async function executeOneBelezaTool(tenant: any, toolCall: any, phoneNumber?: string, sessionState?: any): Promise<any> {
  const funcName = toolCall.function.name;
  let args: any = {};
  try { args = JSON.parse(toolCall.function.arguments || "{}"); } catch { /* empty */ }

  const baseUrl = "https://onechatbotapi.azurewebsites.net";
  const celular = tenant.onebeleza_celular || "";
  const rawToken = (tenant.onebeleza_token || "").trim();
  const bearerToken = rawToken.startsWith("Bearer ") ? rawToken : `Bearer ${rawToken}`;
  const authHeaders: Record<string, string> = {
    "Authorization": bearerToken,
    "Accept": "application/json",
  };

  try {
    switch (funcName) {
      case "buscar_cliente": {
        let tel = (phoneNumber || "").replace(/\D/g, "");
        if (tel.startsWith("55") && tel.length >= 12) tel = tel.substring(2);

        // Se já temos alias mapeado para este tenant + telefone real, usa o alias
        const effectiveTel = await resolveOneBelezaClientPhone(tenant.id, tel);

        const url = `${baseUrl}/api/Clientes/GetClientePeloNumero?Celular=${effectiveTel}`;
        console.log(`[OneBeleza] buscar_cliente URL: ${url} (real=${tel}, effective=${effectiveTel})`);
        const res = await fetchOneBelezaWithRetry(url, { headers: authHeaders });
        const text = await res.text();
        console.log(`[OneBeleza] buscar_cliente response (${res.status}):`, text.slice(0, 500));
        try { return JSON.parse(text); } catch { return { raw: text.slice(0, 200), status: res.status }; }
      }

      case "cadastrar_cliente": {
        let tel = (phoneNumber || "").replace(/\D/g, "");
        if (tel.startsWith("55") && tel.length >= 12) tel = tel.substring(2);

        // 🛡️ Defesa em profundidade: NUNCA chamar a API da One Beleza com nome inválido.
        // Mesmo que a barreira upstream (dispatcher) tenha sido contornada por uma
        // versão antiga em cache ou por outro caminho, aqui o cadastro é bloqueado.
        const candidateName = String(args?.nome || "").trim();
        if (!looksLikeRealName(candidateName)) {
          console.log(`[OneBeleza] cadastrar_cliente BLOCKED — nome inválido recebido: "${candidateName.slice(0, 100)}"`);
          try {
            const supabaseSvc = _serviceSupabase();
            await supabaseSvc.from("audit_logs").insert({
              tenant_id: tenant.id,
              actor_role: "service",
              entity: "onebeleza_cadastrar_cliente",
              entity_id: phoneNumber || tel,
              action: "onebeleza_register_blocked_api_guard",
              before: { arg_nome: candidateName.slice(0, 200), reason: "looks_not_like_name" },
            });
          } catch { /* ignore */ }
          return {
            error: "NOME_INVALIDO",
            blocked: true,
            message: "Cadastro recusado pelo sistema: o nome informado não parece um nome real (precisa ter 2 a 4 palavras, só letras, sem verbos/saudações/serviços). NÃO chame cadastrar_cliente de novo com a mesma string. Responda APENAS: 'Pra finalizar, me diz só seu nome e sobrenome?' e AGUARDE a próxima mensagem do cliente.",
          };
        }

        const { res, text, aliasUsed } = await registerOneBelezaClient(
          authHeaders,
          tel,
          candidateName,
          "[OneBeleza]",
          tenant.id,
        );
        let parsed: any;
        try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 200), status: res.status }; }
        if (aliasUsed) {
          // Anexa info pra IA saber que o cadastro foi resolvido via alias e pode seguir
          parsed = {
            ...(typeof parsed === "object" && parsed !== null ? parsed : { raw: parsed }),
            ok: res.ok || (res.status >= 200 && res.status < 300),
            aliasUsed,
            realPhone: tel,
            info: "Cliente cadastrado com telefone alternativo (o número original já estava em outra conta). O sistema usará o alias automaticamente em todas as próximas chamadas. Prossiga normalmente.",
          };
        }
        return parsed;
      }


      case "buscar_servicos": {
        const url = `${baseUrl}/api/Servicos/RetornarGrupoServicos?celular=${celular}`;
        console.log(`[OneBeleza] buscar_servicos URL: ${url}`);
        const res = await fetchOneBelezaWithRetry(url, { headers: authHeaders });
        const text = await res.text();
        console.log(`[OneBeleza] buscar_servicos response (${res.status}):`, text.slice(0, 1000));

        // Always read filter config and log diagnostic info — regardless of parse success
        const rawFilter = tenant?.agent_settings?.onebeleza_unit_filter;
        const filterList: string[] = Array.isArray(rawFilter)
          ? rawFilter.filter((s) => typeof s === "string" && s.trim())
          : (typeof rawFilter === "string" && rawFilter.trim() ? [rawFilter] : []);

        let parsed: any;
        try {
          parsed = JSON.parse(text);
        } catch {
          console.log(`[OneBeleza] buscar_servicos: JSON parse failed`);
          return { raw: text.slice(0, 200), status: res.status };
        }

        // Normalize: API may return array directly, or { data: [...] }, or { grupos: [...] }
        let groups: any[];
        if (Array.isArray(parsed)) {
          groups = parsed;
        } else if (Array.isArray(parsed?.data)) {
          groups = parsed.data;
        } else if (Array.isArray(parsed?.grupos)) {
          groups = parsed.grupos;
        } else {
          console.log(`[OneBeleza] buscar_servicos: response is not an array, returning as-is. Type: ${typeof parsed}, keys: ${parsed && typeof parsed === "object" ? Object.keys(parsed).join(",") : "n/a"}`);
          return parsed;
        }

        console.log(`[OneBeleza] filter check: rawFilter=${JSON.stringify(rawFilter)}, filterList=${JSON.stringify(filterList)}, groupsCount=${groups.length}, groupNames=${JSON.stringify(groups.map((g: any) => g?.descricao || ""))}`);

        if (filterList.length === 0) {
          console.log(`[OneBeleza] buscar_servicos: no unit filter configured, returning all ${groups.length} groups`);
          return groups;
        }

        const norm = (s: string) => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
        const needles = filterList.map(norm);
        const filtered = groups.filter((g: any) => {
          const name = norm(g?.descricao || "");
          return needles.some((n) => name.includes(n));
        });
        console.log(`[OneBeleza] buscar_servicos unit filter applied: ${groups.length} → ${filtered.length} groups (allowed: ${JSON.stringify(filterList)}, kept: ${JSON.stringify(filtered.map((g: any) => g?.descricao))})`);

        if (filtered.length === 0) {
          return {
            error: `Nenhum grupo de serviço da unidade configurada (${filterList.join(", ")}) foi encontrado. Grupos retornados: ${groups.map((g: any) => g?.descricao).join(" | ")}. Verifique onebeleza_unit_filter no tenant.`,
          };
        }

        return filtered;
      }

      case "buscar_horarios_disponiveis": {
        // OPÇÃO 2 (recomendado pela One Beleza para IA):
        // Retorna em UMA chamada todos os profissionais + horários disponíveis para um serviço/data.
        const date = String(args.date || args.dataNumero || "").trim();
        const servicoId = String(args.servicoId || args.servicosId || args.servicoid || "").trim();
        if (!date || !servicoId) {
          return { error: "Parâmetros obrigatórios: date (YYYY-MM-DD) e servicoId." };
        }

        // Validate date format & not in past (helps disambiguate empty results)
        const br = getBrasiliaDate();
        const isValidDate = /^\d{4}-\d{2}-\d{2}$/.test(date);
        const isPast = isValidDate && date < br.todayDate;

        const url = `${baseUrl}/api/Agendamento/HorariosTodosProfissionaisByDataServico?celular=${celular}&date=${date}&servicoId=${servicoId}`;
        console.log(`[OneBeleza] buscar_horarios_disponiveis URL: ${url}`);
        const res = await fetchOneBelezaWithRetry(url, { method: "POST", headers: authHeaders });
        const text = await res.text();
        console.log(`[OneBeleza] buscar_horarios_disponiveis response (${res.status}):`, text.slice(0, 1500));
        let parsed: any;
        try { parsed = JSON.parse(text); } catch { return { raw: text.slice(0, 200), status: res.status }; }

        // Filter past times if today
        if (date === br.todayDate && Array.isArray(parsed)) {
          const currentHHMMSS = `${String(br.hours).padStart(2, '0')}:${String(br.minutes).padStart(2, '0')}:00`;
          for (const item of parsed) {
            if (Array.isArray(item?.disponibilidades)) {
              for (const disp of item.disponibilidades) {
                if (Array.isArray(disp?.horarios)) {
                  disp.horarios = disp.horarios.filter((h: any) => !h?.horarioInicio || h.horarioInicio > currentHHMMSS);
                }
              }
            }
            if (item?.horarioInicio && item.horarioInicio <= currentHHMMSS) item._filtered = true;
          }
          parsed = parsed.filter((it: any) => !it._filtered);
        }

        // Detect "empty result" — server-side disambiguation so the AI doesn't say generic "no slots"
        const isEmpty = !Array.isArray(parsed) || parsed.length === 0 || parsed.every((it: any) => {
          const disps = Array.isArray(it?.disponibilidades) ? it.disponibilidades : [];
          if (disps.length === 0) return true;
          return disps.every((d: any) => !Array.isArray(d?.horarios) || d.horarios.length === 0);
        });

        if (isEmpty) {
          // Past date short-circuit
          if (isPast) {
            console.log(`[OneBeleza][diag] empty result servicoId=${servicoId} date=${date} reason=data_passada`);
            return {
              vazio: true,
              motivo: "data_invalida_ou_passada",
              mensagem: `A data ${date} já passou. Peça ao cliente outra data (a partir de ${br.todayDate}).`,
            };
          }

          // Discover whether the service has ANY professional enabled in this unit
          let profCount = 0;
          let profNames: string[] = [];
          try {
            const profUrl = `${baseUrl}/api/Profissionais/PesquisarProfissionais?celular=${celular}&servicosId=${servicoId}`;
            const profRes = await fetchOneBelezaWithRetry(profUrl, { headers: authHeaders });
            const profText = await profRes.text();
            const profParsed = JSON.parse(profText);
            if (Array.isArray(profParsed)) {
              profCount = profParsed.length;
              profNames = profParsed
                .map((p: any) => String(p?.nome || p?.nomeProfissional || "").trim())
                .filter(Boolean);
            }
          } catch (e) {
            console.log(`[OneBeleza][diag] profissionais lookup failed:`, (e as Error).message);
          }

          if (profCount === 0) {
            console.log(`[OneBeleza][diag] empty result servicoId=${servicoId} date=${date} reason=servico_sem_profissional profCount=0`);
            return {
              vazio: true,
              motivo: "servico_sem_profissional",
              mensagem: "Esse serviço não tem nenhum profissional habilitado nesta unidade. Ofereça um serviço equivalente OU escalar humano.",
            };
          }

          console.log(`[OneBeleza][diag] empty result servicoId=${servicoId} date=${date} reason=dia_sem_vaga profCount=${profCount} profs=${profNames.join("|")}`);
          return {
            vazio: true,
            motivo: "dia_sem_vaga",
            profissionais_habilitados: profNames,
            mensagem: `Nenhum horário em ${date}. Profissionais habilitados para este serviço: ${profNames.join(", ") || "(nomes indisponíveis)"}. Pergunte ao cliente outro dia.`,
          };
        }

        return parsed;
      }

      case "buscar_barbeiros_por_servico": {
        const url = `${baseUrl}/api/Profissionais/PesquisarProfissionais?celular=${celular}&servicosId=${args.servicosId}`;
        console.log(`[OneBeleza] buscar_barbeiros URL: ${url}`);
        const res = await fetchOneBelezaWithRetry(url, { headers: authHeaders });
        const text = await res.text();
        console.log(`[OneBeleza] buscar_barbeiros response (${res.status}):`, text.slice(0, 1000));
        try { return JSON.parse(text); } catch { return { raw: text.slice(0, 200), status: res.status }; }
      }

      case "buscar_horarios": {
        const url = `${baseUrl}/api/Agendamento/HorariosPorProfissionaisByDataServico?celular=${celular}&date=${args.date}&servicoId=${args.servicoId}&ProfissionalId=${args.ProfissionalId}`;
        console.log(`[OneBeleza] buscar_horarios URL: ${url}`);
        const res = await fetchOneBelezaWithRetry(url, {
          method: "POST",
          headers: authHeaders,
        });
        const text = await res.text();
        console.log(`[OneBeleza] buscar_horarios response (${res.status}):`, text.slice(0, 1000));
        try {
          const parsed = JSON.parse(text);
          
          // Filter past times if today
          const br = getBrasiliaDate();
          if (args.date === br.todayDate) {
            const currentHHMMSS = `${String(br.hours).padStart(2, '0')}:${String(br.minutes).padStart(2, '0')}:00`;
            if (Array.isArray(parsed)) {
              for (const item of parsed) {
                if (item.horarioInicio && item.horarioInicio <= currentHHMMSS) {
                  item._filtered = true;
                }
              }
              const filtered = parsed.filter((item: any) => !item._filtered);
              console.log(`[OneBeleza] Filtered past times: ${parsed.length} → ${filtered.length}`);
              return filtered;
            }
          }
          
          return parsed;
        } catch { return { raw: text.slice(0, 200), status: res.status }; }
      }

      case "agendar": {
        // Normalize args keys to handle case variations
        const normalizedArgs: Record<string, string> = {};
        for (const [k, v] of Object.entries(args)) {
          normalizedArgs[k.toLowerCase()] = String(v ?? "");
        }
        const aDataAg = normalizedArgs["datanumero"] || normalizedArgs["dataag"] || normalizedArgs["data"] || "";
        const aServicoId = normalizedArgs["servicoid"] || normalizedArgs["servicosid"] || "";
        const aProfissionalId = normalizedArgs["profissionalid"] || "";
        const aHorarioInicio = normalizeOneBelezaTime(normalizedArgs["horarioinicio"] || "");
        const aHorarioFim = normalizeOneBelezaTime(normalizedArgs["horariofim"] || "");

        // Validate IDs are not small/invented numbers
        const sIdNum = parseInt(aServicoId, 10);
        const pIdNum = parseInt(aProfissionalId, 10);
        if (aServicoId && sIdNum > 0 && sIdNum <= 10) {
          console.error(`[OneBeleza] agendar BLOCKED: servicoId=${aServicoId} is suspiciously small (likely invented)`);
          return { error: "servicoId inválido. Execute buscar_servicos novamente e use o servicosId retornado (número grande, ex: 2461).", blocked: true };
        }
        if (aProfissionalId && pIdNum > 0 && pIdNum <= 10) {
          console.error(`[OneBeleza] agendar BLOCKED: profissionalId=${aProfissionalId} is suspiciously small (likely invented)`);
          return { error: "profissionalId inválido. Execute buscar_barbeiros_por_servico novamente e use o profissionalId retornado (número grande, ex: 40658).", blocked: true };
        }

        // 🛡️ Catálogo: se buscar_servicos já rodou nesta conversa, o servicoId
        // precisa estar em allowedServiceIds. Evita alucinação de IDs plausíveis
        // (números grandes que passam pelo filtro de "número pequeno" acima).
        const allowedServiceIds: number[] = Array.isArray(sessionState?.allowedServiceIds)
          ? sessionState!.allowedServiceIds
          : [];
        if (aServicoId && sIdNum > 0 && allowedServiceIds.length > 0 && !allowedServiceIds.includes(sIdNum)) {
          console.warn(`[OneBeleza] agendar BLOCKED: servicoId=${sIdNum} não está no catálogo desta conversa (${allowedServiceIds.join(",")})`);
          return {
            error: `servicoId ${sIdNum} não corresponde a nenhum serviço listado nesta conversa. Chame buscar_servicos novamente e use um dos IDs retornados.`,
            blocked: true,
            allowedServiceIds,
          };
        }

        // ⚠️ CRITICAL: the `celular` query param identifies the BOOKING CLIENT in the One Beleza API.
        // Using the tenant owner's phone (tenant.onebeleza_celular) makes the appointment fall under the owner.
        // We MUST use the conversation client's phone (the one writing on WhatsApp).
        let clienteTel = (phoneNumber || "").replace(/\D/g, "");
        if (clienteTel.startsWith("55") && clienteTel.length >= 12) clienteTel = clienteTel.substring(2);
        if (!clienteTel) {
          console.error(`[OneBeleza] agendar BLOCKED: empty client phone for booking`);
          return { error: "Telefone do cliente ausente; não é possível agendar.", blocked: true };
        }
        // Se houver alias mapeado, usa o alias na API
        const realClienteTel = clienteTel;
        clienteTel = await resolveOneBelezaClientPhone(tenant.id, clienteTel);

        // Resolve cliente (cliforcolsid) by the CLIENT phone
        let cliforcolsid = "";
        let clienteNome = "";
        try {
          const cliRes = await fetchOneBelezaWithRetry(`${baseUrl}/api/Clientes/GetClientePeloNumero?Celular=${clienteTel}`, { headers: authHeaders });
          const cliText = await cliRes.text();
          try {
            const cli = JSON.parse(cliText);
            cliforcolsid = String(
              cli?.cliforcolsid ||
              cli?.cliForColsId ||
              cli?.cliForColsid ||
              cli?.clienteId ||
              cli?.id ||
              ""
            ).trim();
            clienteNome = String(cli?.nome || cli?.Nome || "").trim();
          } catch { /* empty */ }
          console.log(`[OneBeleza] agendar resolved cliente: tel=${clienteTel} cliforcolsid=${cliforcolsid} nome="${clienteNome}"`);
        } catch (e) {
          console.error(`[OneBeleza] agendar failed to resolve cliente:`, (e as Error).message);
        }
        if (!cliforcolsid) {
          return { error: "Cliente não encontrado pelo telefone. Execute cadastrar_cliente antes de agendar.", blocked: true };
        }

        // Sanity guard: never allow the booking phone to be the tenant owner's phone
        const ownerTel = String(tenant.onebeleza_celular || "").replace(/\D/g, "");
        if (ownerTel && (ownerTel === clienteTel || ownerTel.endsWith(clienteTel) || clienteTel.endsWith(ownerTel))) {
          console.error(`[OneBeleza] agendar BLOCKED: client phone (${clienteTel}) matches tenant owner phone (${ownerTel})`);
          return { error: "Número do cliente coincide com o número da conta da barbearia. Agendamento bloqueado para evitar registro no dono.", blocked: true };
        }

        // ⚠️ Use the CLIENT phone in the URL — this is what the One Beleza API uses to attribute the booking.
        const url = `${baseUrl}/api/Agendamento/MarcarAgendamentoForm?celular=${clienteTel}`;

        // Build multipart form data
        const formData = new FormData();
        formData.append("dataAg", aDataAg);
        formData.append("servicoId", aServicoId);
        formData.append("profissionalId", aProfissionalId);
        formData.append("horarioInicio", aHorarioInicio);
        formData.append("horarioFim", aHorarioFim);
        formData.append("cliforcolsid", cliforcolsid);
        formData.append("cliForColsid", cliforcolsid);
        formData.append("cliForColsId", cliforcolsid);
        formData.append("clienteId", cliforcolsid);

        console.log(`[OneBeleza] agendar FINAL REQUEST → URL=${url} | clienteTel=${clienteTel} cliforcolsid=${cliforcolsid} nome="${clienteNome}" | dataAg=${aDataAg} servicoId=${aServicoId} profissionalId=${aProfissionalId} horarioInicio=${aHorarioInicio} horarioFim=${aHorarioFim} | ownerTel=${ownerTel}`);

        const res = await fetchOneBelezaWithRetry(url, {
          method: "POST",
          headers: { "Authorization": bearerToken },
          body: formData,
        });
        const text = await res.text();
        console.log(`[OneBeleza] agendar response (${res.status}):`, text.slice(0, 500));
        
        if (res.status === 200 || res.status === 201) {
          try { 
            const parsed = JSON.parse(text);
            return { id: parsed.id || parsed.Id || true, success: true, ...parsed };
          } catch { 
            return { id: true, success: true, message: text.slice(0, 200) };
          }
        }
        
        // Handle "Já existe um evento no horário" error
        if (res.status === 400 && text.includes("evento no hor")) {
          return { error: "Já existe um evento no horário.", conflict: true };
        }
        
        try { return JSON.parse(text); } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "buscar_agendamentos_dia": {
        const url = `${baseUrl}/api/Agendamento/GetTodosAgendamentosDia?date=${args.date}`;
        console.log(`[OneBeleza] buscar_agendamentos_dia URL: ${url}`);
        const res = await fetchOneBelezaWithRetry(url, { headers: authHeaders });
        const text = await res.text();
        console.log(`[OneBeleza] buscar_agendamentos_dia response (${res.status}):`, text.slice(0, 1000));
        try { return JSON.parse(text); } catch { return { raw: text.slice(0, 200), status: res.status }; }
      }

      case "confirmar_agendamento": {
        const url = `${baseUrl}/api/Agendamento/ConfirmarAgendamento?agendasId=${args.agendasId}&celular=${celular}`;
        console.log(`[OneBeleza] confirmar_agendamento URL: ${url}`);
        const res = await fetchOneBelezaWithRetry(url, {
          method: "POST",
          headers: authHeaders,
        });
        const text = await res.text();
        console.log(`[OneBeleza] confirmar_agendamento response (${res.status}):`, text.slice(0, 500));
        if (res.status === 200) {
          return { success: true, message: "Agendamento confirmado com sucesso" };
        }
        try { return JSON.parse(text); } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }

      case "desmarcar_agendamento": {
        // 🛡️ Ownership check — bloqueia desmarcar de ID que não está na lista
        // filtrada por telefone (validAgendasIds populada por buscar_agendamentos_dia,
        // linha ~6112). Evita cancelar agendamento de outro cliente por ID alucinado.
        const validIds: number[] = Array.isArray((sessionState as any)?.validAgendasIds)
          ? (sessionState as any).validAgendasIds
          : [];
        const requestedId = Number(args.agendasId);
        if (validIds.length > 0 && !validIds.includes(requestedId)) {
          console.warn(`[OneBeleza] desmarcar_agendamento ownership_mismatch: id=${requestedId} não está em validAgendasIds=[${validIds.join(",")}]`);
          return {
            blocked: true,
            reason: "ownership_mismatch",
            message: `Esse agendamento não pertence a este cliente. Chame buscar_agendamentos_dia primeiro para pegar o ID correto.`,
            validIds,
          };
        }
        const url = `${baseUrl}/api/Agendamento/DesmarcarAgendamento?celular=${celular}&agendasId=${args.agendasId}`;
        console.log(`[OneBeleza] desmarcar_agendamento URL: ${url}`);
        const res = await fetchOneBelezaWithRetry(url, {
          method: "DELETE",
          headers: authHeaders,
        });
        const text = await res.text();
        console.log(`[OneBeleza] desmarcar_agendamento response (${res.status}):`, text.slice(0, 500));
        if (res.status === 200 || res.status === 204) {
          return { success: true, message: "Agendamento desmarcado com sucesso" };
        }
        try { return JSON.parse(text); } catch { return { error: `Status ${res.status}`, raw: text.slice(0, 200) }; }
      }


      default:
        return { error: `Unknown OneBeleza tool: ${funcName}` };
    }
  } catch (error) {
    console.error(`OneBeleza tool error (${funcName}):`, error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { error: `Erro ao executar ${funcName}: ${errorMessage}` };
  }
}

