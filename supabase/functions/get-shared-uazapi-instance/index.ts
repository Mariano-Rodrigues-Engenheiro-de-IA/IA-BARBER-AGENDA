// Ponte entre projetos: permite que o CRM-BARBER consulte, ANTES de criar
// uma instância UAZAPI nova, se esse número de telefone já tem uma
// instância ativa aqui na IA — evitando ter duas sessões WhatsApp Web
// diferentes brigando pelo mesmo número (o que estava derrubando uma das
// duas). Protegida por uma chave secreta compartilhada — nunca pública.
import { createClient } from "npm:@supabase/supabase-js@2";

function digitsOnly(s: string): string {
  return (s || "").replace(/\D/g, "");
}

Deno.serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type, x-shared-secret",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const sharedSecret = Deno.env.get("CRM_BRIDGE_SHARED_SECRET");
  if (!sharedSecret || req.headers.get("x-shared-secret") !== sharedSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const { phone } = await req.json();
    const phoneDigits = digitsOnly(phone || "");
    if (!phoneDigits) {
      return new Response(JSON.stringify({ error: "phone ausente" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: tenants } = await supa
      .from("tenants")
      .select("id, whatsapp_number, uazapi_token")
      .not("uazapi_token", "is", null);

    const match = (tenants ?? []).find((t: any) => digitsOnly(t.whatsapp_number || "") === phoneDigits);
    if (!match) {
      return new Response(JSON.stringify({ found: false }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ found: true, uazapi_token: match.uazapi_token }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
