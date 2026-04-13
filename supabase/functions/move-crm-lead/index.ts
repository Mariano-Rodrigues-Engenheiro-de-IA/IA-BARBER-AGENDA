import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const { leadId, tenantId, phoneNumber, toLabelId, toLabelName } = await req.json();

    if (!leadId || !tenantId || !phoneNumber || !toLabelId) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get tenant for UAZAPI credentials
    const { data: tenant, error: tenantErr } = await supabase
      .from("tenants")
      .select("id, uazapi_url, uazapi_token, kanban_columns")
      .eq("id", tenantId)
      .single();

    if (tenantErr || !tenant) {
      return new Response(JSON.stringify({ error: "Tenant not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const uazapiUrl = tenant.uazapi_url || Deno.env.get("UAZAPI_URL");
    const uazapiToken = tenant.uazapi_token || Deno.env.get("UAZAPI_TOKEN");

    if (!uazapiUrl || !uazapiToken) {
      return new Response(JSON.stringify({ error: "UAZAPI not configured" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get current lead to know old label
    const { data: lead } = await supabase
      .from("crm_leads")
      .select("id, label_id")
      .eq("id", leadId)
      .single();

    const fromLabel = lead?.label_id || null;

    // Remove old label if different
    if (fromLabel && fromLabel !== toLabelId) {
      await fetch(`${uazapiUrl}/chat/labels`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json", "token": uazapiToken },
        body: JSON.stringify({ number: phoneNumber, remove_labelid: String(fromLabel) }),
      });
      console.log(`Removed label ${fromLabel} from ${phoneNumber}`);
    }

    // Add new label
    const addRes = await fetch(`${uazapiUrl}/chat/labels`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json", "token": uazapiToken },
      body: JSON.stringify({ number: phoneNumber, add_labelid: String(toLabelId) }),
    });
    console.log(`Added label ${toLabelId} to ${phoneNumber}, status: ${addRes.status}`);

    // Update DB
    await supabase
      .from("crm_leads")
      .update({ label_id: toLabelId, label_name: toLabelName || null, updated_at: new Date().toISOString() })
      .eq("id", leadId);

    // Insert history
    await supabase.from("crm_lead_history").insert({
      lead_id: leadId,
      from_label: fromLabel,
      to_label: toLabelId,
      changed_by: "manual",
    });

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("move-crm-lead error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
