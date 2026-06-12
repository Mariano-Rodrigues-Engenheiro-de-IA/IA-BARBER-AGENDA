// Consulta local: dado tenant_id + phone, retorna status do assinante na CelCash.
// Pode ser chamada por: admin/usuário do tenant (JWT) OU por outras edge functions com service role.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function normalizePhone(raw?: string | null): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10 || digits.length === 11) return `+55${digits}`;
  if (digits.startsWith("55") && digits.length >= 12) return `+${digits}`;
  return `+${digits}`;
}

function phoneVariants(raw: string): string[] {
  const digits = raw.replace(/\D/g, "");
  const set = new Set<string>();
  if (!digits) return [];
  let national = digits;
  if (!national.startsWith("55") && (national.length === 10 || national.length === 11)) {
    national = `55${national}`;
  }
  set.add(`+${digits}`);
  set.add(`+${national}`);
  if (national.startsWith("55") && national.length >= 12) {
    const ddd = national.slice(2, 4);
    const rest = national.slice(4);
    if (rest.length === 9 && rest.startsWith("9")) set.add(`+55${ddd}${rest.slice(1)}`);
    if (rest.length === 8) set.add(`+55${ddd}9${rest}`);
    set.add(`+${national.slice(2)}`);
  }
  return Array.from(set);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const body = await req.json().catch(() => ({}));
    const { tenant_id, phone } = body;
    if (!tenant_id || !phone) {
      return new Response(JSON.stringify({ error: "tenant_id and phone are required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const variants = phoneVariants(String(phone));
    const { data, error } = await supabase
      .from("celcash_subscribers")
      .select("*")
      .eq("tenant_id", tenant_id)
      .in("phone_e164", variants)
      .order("synced_at", { ascending: false })
      .limit(1);

    if (error) throw error;
    const sub = data?.[0];
    if (!sub) {
      return new Response(JSON.stringify({ is_subscriber: false, found: false }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      // Tabela local só contém ativos (+ trial). Achou = é assinante.
      is_subscriber: true,
      found: true,
      status: sub.status,
      plan_id: sub.plan_id,
      plan_name: sub.plan_name,
      customer_name: sub.name,
      customer_email: sub.email,
      next_due_date: sub.next_due_date,
      last_payment_date: sub.last_payment_date,
      celcash_customer_id: sub.celcash_customer_id,
      celcash_subscription_id: sub.celcash_subscription_id,
      synced_at: sub.synced_at,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message || "Internal error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
