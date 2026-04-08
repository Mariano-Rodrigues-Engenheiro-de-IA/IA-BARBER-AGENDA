import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Validate auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Verify user
    const anonClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await anonClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = user.id;

    // Check admin role
    const { data: isAdmin } = await supabase.rpc("has_role", {
      _user_id: userId,
      _role: "admin",
    });

    if (!isAdmin) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get tenant_id from request
    const { tenant_id } = await req.json();
    if (!tenant_id) {
      return new Response(JSON.stringify({ error: "tenant_id is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch tenant credentials
    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("trinks_api_key, trinks_establishment_id, name")
      .eq("id", tenant_id)
      .single();

    if (tenantError || !tenant) {
      return new Response(JSON.stringify({ error: "Tenant not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!tenant.trinks_api_key || !tenant.trinks_establishment_id) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Credenciais da API Trinks não configuradas para este tenant.",
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Test Trinks API by listing services
    const trinksUrl = `https://api.trinks.com/v1/servicos?estabelecimentoId=${tenant.trinks_establishment_id}&somenteVisiveisCliente=false`;
    const trinksResponse = await fetch(trinksUrl, {
      method: "GET",
      headers: {
        "X-Api-Key": tenant.trinks_api_key,
        "Accept": "application/json",
        "estabelecimentoId": tenant.trinks_establishment_id,
      },
    });

    const trinksStatus = trinksResponse.status;
    let trinksData = null;
    let serviceCount = 0;

    try {
      trinksData = await trinksResponse.json();
      if (Array.isArray(trinksData)) {
        serviceCount = trinksData.length;
      } else if (trinksData?.data && Array.isArray(trinksData.data)) {
        serviceCount = trinksData.data.length;
      }
    } catch {
      trinksData = await trinksResponse.text();
    }

    if (trinksStatus >= 200 && trinksStatus < 300) {
      return new Response(
        JSON.stringify({
          success: true,
          message: `Conexão com a API Trinks bem-sucedida! ${serviceCount} serviço(s) encontrado(s).`,
          service_count: serviceCount,
          tenant_name: tenant.name,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    } else {
      return new Response(
        JSON.stringify({
          success: false,
          message: `Erro ao conectar à API Trinks (HTTP ${trinksStatus}). Verifique as credenciais.`,
          trinks_status: trinksStatus,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message || "Internal server error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
