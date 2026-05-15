import { useAuth, useModulePermission } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { Navigate } from "react-router-dom";
import { useMemo } from "react";

export default function ClientCrm() {
  const { tenantId } = useAuth();
  const { visible } = useModulePermission("crm");
  if (!visible) return <Navigate to="/app" replace />;

  const { data: tenant } = useQuery({
    queryKey: ["client-crm-tenant", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data } = await supabase.from("tenants").select("kanban_columns").eq("id", tenantId!).single();
      return data;
    },
  });

  const { data: leads } = useQuery({
    queryKey: ["client-crm-leads", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data } = await supabase.from("crm_leads")
        .select("id,name,phone_number,label_id,label_name,notes,updated_at")
        .eq("tenant_id", tenantId!)
        .order("updated_at", { ascending: false });
      return data ?? [];
    },
  });

  const cols = useMemo(() => {
    const arr = Array.isArray(tenant?.kanban_columns) ? (tenant!.kanban_columns as any[]) : [];
    return arr.filter((c) => (c.type ?? "funnel") === "funnel").sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }, [tenant]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-foreground">CRM</h1>
        <p className="text-muted-foreground">Leads organizados pelo seu funil</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {cols.map((col) => {
          const items = (leads ?? []).filter((l: any) => l.label_id === col.label_id);
          return (
            <div key={col.label_id} className="glass-card p-3">
              <div className="flex items-center gap-2 mb-3">
                <span className="w-2 h-2 rounded-full" style={{ background: col.color }} />
                <h3 className="font-semibold text-sm text-foreground">{col.name}</h3>
                <span className="ml-auto text-xs text-muted-foreground">{items.length}</span>
              </div>
              <div className="space-y-2 max-h-[60vh] overflow-auto">
                {items.map((l: any) => (
                  <div key={l.id} className="bg-muted/50 rounded-lg p-2">
                    <div className="text-sm font-medium text-foreground">{l.name || l.phone_number}</div>
                    <div className="text-xs text-muted-foreground">{l.phone_number}</div>
                    {l.notes && <div className="text-xs text-muted-foreground mt-1 line-clamp-2">{l.notes}</div>}
                  </div>
                ))}
                {items.length === 0 && <p className="text-xs text-muted-foreground">Vazio</p>}
              </div>
            </div>
          );
        })}
        {cols.length === 0 && <p className="text-sm text-muted-foreground col-span-full">Nenhuma coluna do CRM configurada ainda.</p>}
      </div>
    </div>
  );
}
