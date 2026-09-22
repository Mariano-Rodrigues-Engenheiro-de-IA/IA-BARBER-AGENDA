// Roda via pg_cron a cada 5 minutos: consulta o status real da conexão
// do WhatsApp (UAZAPI) de CADA TENANT ATIVO, compara com o último
// status já conhecido (tenants.last_known_connection_status), e se
// MUDOU (conectou <-> desconectou), avisa o DONO DA PLATAFORMA
// (Mariano) — configuração única e global em
// platform_connection_alert_config, não por cliente.
//
// ⚠️ Desafio real considerado: se o WhatsApp de um cliente acabou de
// CAIR, tentar mandar o aviso PELA INSTÂNCIA DAQUELE MESMO cliente
// pode falhar (círculo vicioso). Por isso o aviso é SEMPRE mandado
// pela instância CENTRAL (UAZAPI_URL/UAZAPI_TOKEN das variáveis de
// ambiente), nunca pela instância do cliente que mudou de status —
// resolve o problema de raiz, já que o número do Mariano não depende
// de nenhum cliente específico estar de pé.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function resolveConnected(statusPayload: any): boolean {
  // Mesmo critério já usado no painel do cliente (Connection.tsx) pra
  // decidir se está conectado — mantém consistência.
  const rawStatus = statusPayload?.instance?.status;
  return rawStatus === "connected" || statusPayload?.status?.connected === true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const apikey = req.headers.get("apikey") ?? "";
  const expectedKeys = [
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY"),
    Deno.env.get("SUPABASE_ANON_KEY"),
  ].filter((k): k is string => !!k);
  let authorized = !!apikey && expectedKeys.includes(apikey);
  const providedSecret = req.headers.get("x-cron-secret");
  if (!authorized && providedSecret) {
    const cronSecret = Deno.env.get("CRON_SECRET");
    if (cronSecret && providedSecret === cronSecret) {
      authorized = true;
    } else {
      const { data: internalToken } = await supabase.rpc(
        "get_internal_cron_token",
      );
      authorized =
        typeof internalToken === "string" && providedSecret === internalToken;
    }
  }
  if (!authorized) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let checked = 0,
    changed = 0,
    errors = 0;

  try {
    const { data: platformConfig, error: cfgErr } = await supabase
      .from("platform_connection_alert_config")
      .select(
        "active, owner_phone_e164, connected_message_template, disconnected_message_template",
      )
      .eq("id", true)
      .maybeSingle();
    if (cfgErr) {
      return new Response(
        JSON.stringify({ ok: false, error: cfgErr.message }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    if (!platformConfig?.active || !platformConfig.owner_phone_e164) {
      return new Response(
        JSON.stringify({ ok: true, note: "config_inactive_or_missing" }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const centralUazapiUrl = Deno.env.get("UAZAPI_URL");
    const centralUazapiToken = Deno.env.get("UAZAPI_TOKEN");
    if (!centralUazapiUrl || !centralUazapiToken) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "instância central (UAZAPI_URL/UAZAPI_TOKEN) não configurada",
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const { data: tenants, error: tErr } = await supabase
      .from("tenants")
      .select(
        "id, name, uazapi_url, uazapi_token, status, last_known_connection_status",
      )
      .eq("status", "active");
    if (tErr) {
      return new Response(JSON.stringify({ ok: false, error: tErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    for (const tenant of tenants ?? []) {
      if (!tenant.uazapi_url || !tenant.uazapi_token) continue;
      checked++;

      const statusRes = await fetch(
        `${String(tenant.uazapi_url).replace(/\/+$/, "")}/instance/status`,
        {
          headers: { token: tenant.uazapi_token },
        },
      ).catch(() => null);
      if (!statusRes) continue; // rede falhou nessa rodada — tenta de novo na próxima
      const statusData = await statusRes.json().catch(() => null);
      if (!statusData) continue;

      const nowConnected = resolveConnected(statusData);
      const nowStatus = nowConnected ? "connected" : "disconnected";

      // Primeira checagem desse tenant (nunca verificou antes) — só
      // registra, não dispara (senão todo mundo levaria um aviso na
      // primeira vez que o recurso for ligado, mesmo sem ter mudado nada).
      if (tenant.last_known_connection_status === null) {
        await supabase
          .from("tenants")
          .update({ last_known_connection_status: nowStatus })
          .eq("id", tenant.id);
        continue;
      }

      if (tenant.last_known_connection_status === nowStatus) continue; // sem mudança

      changed++;
      const template = nowConnected
        ? platformConfig.connected_message_template
        : platformConfig.disconnected_message_template;
      const message = template.replace(
        /\{empresa\}/g,
        tenant.name || "Cliente",
      );

      const phoneDigits = String(platformConfig.owner_phone_e164).replace(
        /\D/g,
        "",
      );
      const sendRes = await fetch(
        `${centralUazapiUrl.replace(/\/+$/, "")}/send/text`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            token: centralUazapiToken,
          },
          body: JSON.stringify({ number: phoneDigits, text: message }),
        },
      ).catch(() => null);
      if (!sendRes?.ok) errors++;

      await supabase
        .from("tenants")
        .update({ last_known_connection_status: nowStatus })
        .eq("id", tenant.id);
    }

    return new Response(
      JSON.stringify({ ok: true, checked, changed, errors }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
