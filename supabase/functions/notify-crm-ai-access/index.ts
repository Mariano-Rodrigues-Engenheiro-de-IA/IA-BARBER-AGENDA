// Chamada pelo painel admin (usuário logado) quando o admin vincula um
// tenant a uma barbearia do CRM Zaylo — avisa o CRM (via a chave secreta
// compartilhada, guardada aqui, nunca exposta ao navegador) que o acesso
// ao Agente de IA está liberado para aquela barbearia.
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": req.headers.get("origin") ?? "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });


  try {
    // Exige usuário autenticado do próprio painel (admin) — não usa a
    // chave secreta compartilhada aqui, essa é só para a chamada de saída.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData } = await supa.auth.getUser();
    if (!userData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { barbershop_id, enabled } = await req.json();
    if (!barbershop_id) {
      return new Response(JSON.stringify({ error: "barbershop_id ausente" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const bridgeSecret = Deno.env.get("CRM_BRIDGE_SHARED_SECRET");
    // Rota pública do próprio CRM (não é Edge Function). O segredo é a única
    // credencial aceita por ela, e nunca trafega para o navegador.
    const crmUrl = Deno.env.get("CRM_NOTIFY_AI_ACCESS_URL") ?? "https://crm.zayloia.com/api/public/ai/set-access";
    if (!bridgeSecret) {
      return new Response(JSON.stringify({ error: "Ponte com o CRM não configurada (falta CRM_BRIDGE_SHARED_SECRET)." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }


    // Sanitiza (quebra de linha colada no secret estoura o fetch) e manda o
    // segredo nos três formatos que o CRM pode esperar — ele responde 401
    // quando não reconhece o cabeçalho.
    const safeSecret = bridgeSecret.replace(/[^\x21-\x7E]/g, "");
    const crmRes = await fetch(crmUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-shared-secret": safeSecret,
        "x-api-key": safeSecret,
        Authorization: `Bearer ${safeSecret}`,
      },
      body: JSON.stringify({ barbershop_id, enabled: enabled ?? true }),
    });
    if (!crmRes.ok) {
      const text = await crmRes.text().catch(() => "");
      return new Response(JSON.stringify({ error: `CRM respondeu ${crmRes.status}: ${text.slice(0, 200)}` }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
