import { createClient } from "npm:@supabase/supabase-js@2.49.1";

const ALLOWED_ORIGINS = ["https://zayloia.com", "https://www.zayloia.com"];

async function mutateUazChatLabel(
  uazapiUrl: string,
  uazapiToken: string,
  phoneNumber: string,
  labelId: string,
  action: "add" | "remove",
): Promise<Response> {
  const number = phoneNumber.replace(/\D/g, "");
  const body = action === "add"
    ? { number, add_labelid: String(labelId) }
    : { number, remove_labelid: String(labelId) };
  return fetch(`${uazapiUrl}/chat/labels`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "token": uazapiToken },
    body: JSON.stringify(body),
  });
}

async function requireSuccessfulLabelMutation(response: Response, operation: string): Promise<void> {
  if (response.ok) return;
  const details = await response.text();
  throw new Error(`UAZAPI recusou ${operation} (${response.status}): ${details.slice(0, 300)}`);
}

function buildCorsHeaders(origin: string | null) {
  const allowOrigin = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
}

Deno.serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // ===== AUTHENTICATION =====
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const authClient = createClient(
    supabaseUrl,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );

  const token = authHeader.replace("Bearer ", "");
  const { data: userData, error: userErr } = await authClient.auth.getUser(token);
  if (userErr || !userData?.user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const userId = userData.user.id;

  const supabase = createClient(
    supabaseUrl,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Resolve caller role + tenant
  const [{ data: isAdminData }, { data: tenantRow }] = await Promise.all([
    supabase.rpc("has_role", { _user_id: userId, _role: "admin" }),
    supabase.from("tenant_users").select("tenant_id").eq("user_id", userId).maybeSingle(),
  ]);
  const isAdmin = !!isAdminData;
  const callerTenantId = tenantRow?.tenant_id ?? null;

  try {
    const { leadId, tenantId, phoneNumber, toLabelId, toLabelName, toggleFlag } = await req.json();

    if (!tenantId || !phoneNumber) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ===== AUTHORIZATION: caller must be admin OR belong to the target tenant =====
    if (!isAdmin && callerTenantId !== tenantId) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
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

    // ===== FLAG TOGGLE MODE =====
    if (toggleFlag) {
      const flagLabelId = String(toggleFlag);

      const { data: lead } = await supabase
        .from("crm_leads")
        .select("id, flag_labels")
        .eq("tenant_id", tenantId)
        .eq("phone_number", phoneNumber)
        .maybeSingle();

      const currentFlags: string[] = lead?.flag_labels || [];
      const hasFlag = currentFlags.includes(flagLabelId);
      const newFlags = hasFlag
        ? currentFlags.filter((f: string) => f !== flagLabelId)
        : [...currentFlags, flagLabelId];

      const uazRes = await mutateUazChatLabel(uazapiUrl, uazapiToken, phoneNumber, flagLabelId, hasFlag ? "remove" : "add");
      await requireSuccessfulLabelMutation(uazRes, `${hasFlag ? "remover" : "adicionar"} etiqueta ${flagLabelId}`);

      if (lead) {
        await supabase.from("crm_leads")
          .update({ flag_labels: newFlags, updated_at: new Date().toISOString() })
          .eq("id", lead.id);
      } else {
        await supabase.from("crm_leads").insert({
          tenant_id: tenantId,
          phone_number: phoneNumber,
          label_id: "__none__",
          flag_labels: newFlags,
        });
      }

      console.log(`Flag toggle ${hasFlag ? "REMOVE" : "ADD"} ${flagLabelId} for ${phoneNumber}: ${uazRes.status}`);

      return new Response(JSON.stringify({ success: true, action: hasFlag ? "removed" : "added", flagLabelId }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ===== FUNNEL MOVE MODE =====
    if (!leadId || !toLabelId) {
      return new Response(JSON.stringify({ error: "Missing leadId or toLabelId for funnel move" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: lead } = await supabase
      .from("crm_leads")
      .select("id, label_id, tenant_id")
      .eq("id", leadId)
      .single();

    // Extra guard: lead must belong to the asserted tenant
    if (!lead || lead.tenant_id !== tenantId) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const fromLabel = lead?.label_id || null;

    if (fromLabel && fromLabel !== toLabelId) {
      const removeRes = await mutateUazChatLabel(uazapiUrl, uazapiToken, phoneNumber, String(fromLabel), "remove");
      await requireSuccessfulLabelMutation(removeRes, `remover etiqueta ${fromLabel}`);
      console.log(`Removed label ${fromLabel} from ${phoneNumber}`);
    }

    const addRes = await mutateUazChatLabel(uazapiUrl, uazapiToken, phoneNumber, String(toLabelId), "add");
    await requireSuccessfulLabelMutation(addRes, `adicionar etiqueta ${toLabelId}`);
    console.log(`Added label ${toLabelId} to ${phoneNumber}, status: ${addRes.status}`);

    await supabase
      .from("crm_leads")
      .update({ label_id: toLabelId, label_name: toLabelName || null, updated_at: new Date().toISOString() })
      .eq("id", leadId);

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
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
