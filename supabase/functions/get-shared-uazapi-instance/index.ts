// Ponte entre projetos: permite que o CRM-BARBER consulte, ANTES de criar
// uma instância UAZAPI nova, se esse cliente (casado pelo e-mail do dono —
// já conhecido automaticamente, sem precisar perguntar nada ao usuário) já
// tem uma instância ativa aqui na IA — evitando ter duas sessões WhatsApp
// Web diferentes brigando pelo mesmo número. Protegida por uma chave
// secreta compartilhada — nunca pública.
import { createClient } from "npm:@supabase/supabase-js@2";

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
    const { email } = await req.json();
    const emailNorm = (email || "").trim().toLowerCase();
    if (!emailNorm) {
      return new Response(JSON.stringify({ error: "email ausente" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: match } = await supa
      .from("tenants")
      .select("id, email, uazapi_token")
      .not("uazapi_token", "is", null)
      .ilike("email", emailNorm)
      .maybeSingle();

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
