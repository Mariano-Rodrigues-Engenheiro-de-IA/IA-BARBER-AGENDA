import { useAuth, useModulePermission } from "@/hooks/useAuth";
import { Navigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { ZettaCrmFunnelsClient } from "@/components/ZettaCrmFunnelsClient";

/** Aba "CRM" do painel do cliente. O cliente escolhe quantos funis quiser
 * (ZettaCrmFunnelsClient) — o token de acesso é configurado só pelo admin,
 * o cliente nunca vê nem tem acesso a ele. Tela mantida bem enxuta, a
 * pedido do Mariano: sem texto explicativo extra, só a configuração dos
 * funis. */
export default function ClientCrm() {
  const { tenantId } = useAuth();
  const { visible } = useModulePermission("crm");

  const { data: hasToken, isLoading } = useQuery({
    queryKey: ["client-crm-has-token", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      // Só confirma SE existe token, sem nunca trazer o valor de volta.
      const { count, error } = await supabase
        .from("tenants" as any)
        .select("id", { count: "exact", head: true })
        .eq("id", tenantId!)
        .not("crm_zetta_token", "is", null);
      if (error) throw error;
      return (count ?? 0) > 0;
    },
  });

  if (!visible) return <Navigate to="/app" replace />;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-foreground">CRM</h1>
        <p className="text-muted-foreground">Funil de vendas gerenciado pela IA</p>
      </div>

      {isLoading ? (
        <div className="glass-card p-8 text-center text-muted-foreground">Carregando...</div>
      ) : !hasToken ? (
        <div className="glass-card overflow-hidden">
          <img src="/crm/banner-conectar-crm.png" alt="Transforme conversas em vendas" className="w-full h-auto block" />
          <div className="p-6 text-center">
            <a
              href="https://crm.zayloia.com"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90"
            >
              Conhecer o CRM
            </a>
          </div>
        </div>
      ) : tenantId ? (
        <ZettaCrmFunnelsClient tenantId={tenantId} />
      ) : null}
    </div>
  );
}
