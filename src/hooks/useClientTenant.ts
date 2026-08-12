import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";

/**
 * Fonte única do registro do tenant nas abas do painel do cliente
 * (Prompt, Ferramentas da IA, Base de conhecimento, Integrações e
 * Dados da empresa). Evita duplicar a query + o registro de auditoria
 * em cada página nova.
 */
export function useClientTenant() {
  const { tenantId, user } = useAuth();

  const { data: tenant, refetch } = useQuery({
    queryKey: ["client-tenant-record", tenantId],
    enabled: !!tenantId,
    staleTime: 60 * 1000,
    queryFn: async () => {
      const { data } = await supabase.from("tenants").select("*").eq("id", tenantId!).single();
      return data;
    },
  });

  const [form, setForm] = useState<any>({});
  useEffect(() => {
    if (tenant) setForm(tenant);
  }, [tenant]);

  const save = async (fields: Record<string, any>, action: string) => {
    if (!tenantId) return false;
    const { error } = await supabase.from("tenants").update(fields as any).eq("id", tenantId);
    if (error) {
      toast.error(error.message);
      return false;
    }
    await supabase.from("audit_logs").insert({
      tenant_id: tenantId, user_id: user?.id, actor_role: "client",
      action, entity: "tenants", entity_id: tenantId, after: fields,
    });
    toast.success("Salvo");
    refetch();
    return true;
  };

  return { tenantId, user, tenant, refetch, form, setForm, save };
}
