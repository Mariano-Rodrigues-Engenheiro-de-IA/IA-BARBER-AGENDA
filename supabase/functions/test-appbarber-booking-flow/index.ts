// Test Mode: cria uma comanda de exemplo no AppBarber e cancela em seguida,
// validando todo o fluxo (services → professionals → availability → POST
// /appointments → /invoice/search → DELETE /invoice/{code}).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const DEFAULT_BASE_URL = "https://proxy.zayloia.com";
const DEFAULT_TEST_PHONE = "61911112222";
const DEFAULT_TEST_NAME = "Teste Zaylo (cancelar)";

type Step = {
  name: string;
  ok: boolean;
  detail: string;
  http_status?: number;
  elapsed_ms?: number;
  data?: any;
};

function snippet(text: string, max = 400) {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function ymd(d: Date) {
  return d.toISOString().slice(0, 10);
}

function pad(n: number) {
  return n.toString().padStart(2, "0");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const anonClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await anonClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: isAdmin } = await supabase.rpc("has_role", {
      _user_id: user.id, _role: "admin",
    });
    if (!isAdmin) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const tenantId = body?.tenant_id;
    const testPhone = String(body?.test_phone || DEFAULT_TEST_PHONE).replace(/\D/g, "");
    const testName = String(body?.test_name || DEFAULT_TEST_NAME);
    if (!tenantId) {
      return new Response(JSON.stringify({ error: "tenant_id is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: tenant, error: tErr } = await supabase
      .from("tenants")
      .select("appbarber_api_key, appbarber_establishment_code, appbarber_base_url")
      .eq("id", tenantId)
      .single();

    if (tErr || !tenant) {
      return new Response(JSON.stringify({ success: false, message: "Tenant não encontrado" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const apiKey = (tenant.appbarber_api_key || "").trim();
    const estCode = (tenant.appbarber_establishment_code || "").trim();
    const baseUrl = ((tenant.appbarber_base_url || DEFAULT_BASE_URL).trim()).replace(/\/+$/, "");
    if (!apiKey || !estCode) {
      return new Response(JSON.stringify({
        success: false,
        message: "Credenciais AppBarber incompletas (x-api-key e establishment_code).",
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const headers = { "x-api-key": apiKey, "Accept": "application/json", "Content-Type": "application/json" };
    const steps: Step[] = [];

    const buildUrl = (path: string, params: Record<string, any> = {}) => {
      const u = new URL(`${baseUrl}${path}`);
      u.searchParams.set("establishment_code", estCode);
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
      }
      return u.toString();
    };

    const callGet = async (name: string, path: string, params: Record<string, any> = {}) => {
      const url = buildUrl(path, params);
      const t0 = Date.now();
      try {
        const res = await fetch(url, { method: "GET", headers });
        const text = await res.text();
        const elapsed = Date.now() - t0;
        let parsed: any = null; try { parsed = JSON.parse(text); } catch { /* */ }
        const step: Step = {
          name,
          ok: res.ok,
          http_status: res.status,
          elapsed_ms: elapsed,
          detail: res.ok ? `GET ${path} OK` : `GET ${path} HTTP ${res.status}: ${snippet(text, 250)}`,
          data: parsed ?? text,
        };
        steps.push(step);
        return { ok: res.ok, status: res.status, parsed, text };
      } catch (e: any) {
        steps.push({ name, ok: false, detail: `GET ${path} falhou: ${e?.message || e}`, elapsed_ms: Date.now() - t0 });
        return { ok: false, status: 0, parsed: null, text: "" };
      }
    };

    // 1) services
    const services = await callGet("listar_servicos", "/v1/services");
    if (!services.ok) return done(false, "Falha ao listar serviços.", steps);
    const serviceList: any[] = Array.isArray(services.parsed) ? services.parsed : (services.parsed?.data ?? []);
    const service = serviceList.find((s) => s && (s.service_code ?? s.code));
    if (!service) return done(false, "Nenhum serviço retornado pelo AppBarber.", steps);
    const service_code = Number(service.service_code ?? service.code);
    const service_name = service.service_description || service.description || service.name || `#${service_code}`;
    const service_duration_minutes = Number(service.service_duration || service.duration || 30) || 30;
    steps.push({ name: "selecionar_servico", ok: true, detail: `Selecionado: ${service_name} (code=${service_code}, dur=${service_duration_minutes}min)` });

    // 2) professionals
    const profs = await callGet("listar_profissionais", "/v1/professionals", { service_code });
    if (!profs.ok) return done(false, "Falha ao listar profissionais.", steps);
    const profList: any[] = Array.isArray(profs.parsed) ? profs.parsed : (profs.parsed?.data ?? []);
    const prof = profList.find((p) => p && (p.employee_code ?? p.professional_code ?? p.code));
    if (!prof) return done(false, "Nenhum profissional disponível para o serviço.", steps);
    const professional_code = Number(prof.employee_code ?? prof.professional_code ?? prof.code);
    const professional_name = prof.employee_name || prof.name || `#${professional_code}`;
    steps.push({ name: "selecionar_profissional", ok: true, detail: `Selecionado: ${professional_name} (code=${professional_code})` });

    // 3) availability - probe next 14 days até achar horário
    let chosenDate = "";
    let chosenTime = "";
    const nowBrt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    for (let i = 1; i <= 14 && !chosenTime; i++) {
      const d = new Date(nowBrt.getTime() + i * 24 * 60 * 60 * 1000);
      const date = ymd(d);
      const av = await callGet(`disponibilidade_${date}`, "/v1/availability", { service_code, start_date: date, professional_code });
      if (!av.ok) continue;
      const blocks: any[] = Array.isArray(av.parsed?.data) ? av.parsed.data : [];
      const wanted = blocks.filter((b: any) => Number(b?.employee_code) === professional_code);
      const slots: string[] = [];
      for (const b of (wanted.length ? wanted : blocks)) {
        const list = Array.isArray(b?.avaliable) ? b.avaliable : (Array.isArray(b?.available) ? b.available : []);
        for (const s of list) {
          const t = String(s?.scheduling_time || "").slice(0, 5);
          if (t) slots.push(t);
        }
      }
      slots.sort();
      if (slots.length) {
        chosenDate = date;
        chosenTime = slots[0];
        steps.push({ name: "selecionar_horario", ok: true, detail: `Horário escolhido: ${chosenDate} ${chosenTime} (entre ${slots.length} opções)` });
        break;
      }
    }
    if (!chosenTime) return done(false, "Nenhum horário disponível nos próximos 14 dias.", steps);

    // 4) criar agendamento
    const createUrl = buildUrl("/v1/appointments");
    const createBody = {
      establishment_code: estCode,
      customer_phone: Number(testPhone),
      customer_name: testName,
      start_date: `${chosenDate} ${chosenTime}`,
      professionals: [{ professional_code }],
      services: [{ service_code, duration: service_duration_minutes }],
    };
    let createStep: Step = { name: "criar_agendamento", ok: false, detail: "" };
    let appointmentInfo: any = null;
    try {
      const t0 = Date.now();
      const res = await fetch(createUrl, { method: "POST", headers, body: JSON.stringify(createBody) });
      const text = await res.text();
      let parsed: any = null; try { parsed = JSON.parse(text); } catch { /* */ }
      createStep = {
        name: "criar_agendamento",
        ok: res.ok,
        http_status: res.status,
        elapsed_ms: Date.now() - t0,
        detail: res.ok ? `POST /v1/appointments OK (${chosenDate} ${chosenTime})` : `POST /v1/appointments HTTP ${res.status}: ${snippet(text, 300)}`,
        data: parsed ?? text,
      };
      appointmentInfo = parsed?.data ?? parsed;
      steps.push(createStep);
      if (!res.ok) return done(false, `Falha ao criar agendamento de teste (HTTP ${res.status}).`, steps);
    } catch (e: any) {
      createStep.detail = `POST /v1/appointments falhou: ${e?.message || e}`;
      steps.push(createStep);
      return done(false, "Erro de rede ao criar agendamento.", steps);
    }

    // 5) localizar invoice via /v1/invoice/search
    let invoiceCode: any = appointmentInfo?.invoice_code || appointmentInfo?.invoiceCode || null;
    const phoneVariants = Array.from(new Set([
      testPhone,
      testPhone.startsWith("55") ? testPhone.slice(2) : `55${testPhone}`,
    ]));
    for (const cp of phoneVariants) {
      const r = await callGet(`invoice_search_${cp}`, "/v1/invoice/search", { customer_phone: cp });
      if (!r.ok) continue;
      const list: any[] = Array.isArray(r.parsed?.data) ? r.parsed.data
        : Array.isArray(r.parsed) ? r.parsed
        : Array.isArray(r.parsed?.items) ? r.parsed.items
        : [];
      const match = list.find((it: any) => {
        const status = String(it?.invoice_status || it?.status || "").toUpperCase();
        const isOpen = !/CANCEL|REALIZ|CONCL|FINALIZ|FECHAD|CLOSED/.test(status);
        return isOpen;
      }) || list[0];
      if (match) {
        invoiceCode = invoiceCode || match.invoice_code || match.invoice_id || match.code || match.id;
        if (invoiceCode) {
          steps.push({ name: "localizar_comanda", ok: true, detail: `Comanda encontrada (invoice_code=${invoiceCode}) via telefone ${cp}` });
          break;
        }
      }
    }

    if (!invoiceCode) {
      steps.push({ name: "localizar_comanda", ok: false, detail: "Não foi possível extrair invoice_code da resposta. Verifique o parse." });
      return done(false, "Agendamento criado, mas comanda não foi localizada para cancelamento. Cancele manualmente no painel AppBarber.", steps);
    }

    // 6) cancelar comanda
    const cancelUrl = `${baseUrl}/v1/invoice/${encodeURIComponent(String(invoiceCode))}`;
    try {
      const t0 = Date.now();
      const res = await fetch(cancelUrl, {
        method: "DELETE",
        headers,
        body: JSON.stringify({
          customer_phone: String(testPhone),
          establishment_code: estCode,
          reason: "Teste automatizado de fluxo (Zaylo) — cancelamento imediato.",
        }),
      });
      const text = await res.text();
      let parsed: any = null; try { parsed = JSON.parse(text); } catch { /* */ }
      steps.push({
        name: "cancelar_comanda",
        ok: res.ok,
        http_status: res.status,
        elapsed_ms: Date.now() - t0,
        detail: res.ok ? `DELETE /v1/invoice/${invoiceCode} OK` : `DELETE /v1/invoice/${invoiceCode} HTTP ${res.status}: ${snippet(text, 300)}`,
        data: parsed ?? text,
      });
      if (!res.ok) return done(false, `Comanda criada (code=${invoiceCode}) mas cancelamento falhou (HTTP ${res.status}). Cancele manualmente.`, steps);
    } catch (e: any) {
      steps.push({ name: "cancelar_comanda", ok: false, detail: `DELETE falhou: ${e?.message || e}` });
      return done(false, "Erro de rede ao cancelar a comanda de teste.", steps);
    }

    return done(true, `Fluxo completo validado: criou e cancelou a comanda ${invoiceCode} em ${chosenDate} ${chosenTime} (${service_name} c/ ${professional_name}).`, steps);
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function done(success: boolean, message: string, steps: Step[]) {
  return new Response(JSON.stringify({ success, message, steps }), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
