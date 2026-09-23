// Ponte entre projetos: permite que o CRM-BARBER consulte, ANTES de criar
// uma instância UAZAPI nova, se esse número de telefone já tem uma
// instância ativa aqui na IA — evitando ter duas sessões WhatsApp Web
// diferentes brigando pelo mesmo número. Telefone é mais confiável que
// e-mail como critério de casamento: o usuário pode digitar um e-mail
// diferente/errado em cada sistema, mas o número que efetivamente conecta
// no WhatsApp é um dado técnico, sem essa ambiguidade. Protegida por uma
// chave secreta compartilhada — nunca pública.
import { createClient } from "npm:@supabase/supabase-js@2";

function digitsOnly(s: string): string {
  return (s || "").replace(/\D/g, "");
}

/** Gera as variantes possíveis de um número brasileiro (DDD + local),
 * cobrindo a ambiguidade do 9º dígito do celular: alguns cadastros
 * antigos guardam sem o 9 (DDD + 8 dígitos), outros com (DDD + 9
 * dígitos) - sem isso, "61983758823" e "6183758823" (o mesmo número,
 * só que sem o 9) nunca batiam na comparação. */
function phoneVariants(raw: string): string[] {
  let d = digitsOnly(raw);
  if (d.length > 11 && d.startsWith("55")) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) return [d];
  const ddd = d.slice(0, 2);
  const local = d.slice(2);
  if (local.length === 9) return [d, ddd + local.slice(1)];
  if (local.length === 8) return [d, ddd + "9" + local];
  return [d];
}

/** Compara dois números tolerando diferença de código de país e do 9º
 * dígito do celular - formatos diferentes entre os dois sistemas. */
function phonesMatch(a: string, b: string): boolean {
  const variantsA = phoneVariants(a);
  const variantsB = phoneVariants(b);
  return variantsA.some((va) => variantsB.includes(va));
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

    const match = (tenants ?? []).find((t: any) => phonesMatch(t.whatsapp_number || "", phoneDigits));
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
