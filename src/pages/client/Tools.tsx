import { Navigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useModulePermission } from "@/hooks/useAuth";
import { useClientTenant } from "@/hooks/useClientTenant";
import { CustomToolsTab, type CustomTool } from "@/components/CustomToolsTab";
import { toast } from "sonner";

/** Aba "Ferramentas da IA" — separada do Prompt. */
export default function ClientTools() {
  const perm = useModulePermission("tools");
  const { tenantId, user, tenant, refetch } = useClientTenant();
  const [customTools, setCustomTools] = useState<CustomTool[]>([]);

  useEffect(() => {
    const s = (tenant as any)?.agent_settings;
    setCustomTools(s && typeof s === "object" && Array.isArray(s.custom_tools) ? s.custom_tools : []);
  }, [tenant]);

  const saveTools = async (next: CustomTool[]) => {
    setCustomTools(next);
    if (!tenantId) return;
    const currentSettings = (tenant as any)?.agent_settings ?? {};
    const agentSettings = { ...currentSettings, custom_tools: next };
    const { error } = await supabase.from("tenants").update({ agent_settings: agentSettings } as any).eq("id", tenantId);
    if (error) return toast.error(error.message);
    await supabase.from("audit_logs").insert({
      tenant_id: tenantId, user_id: user?.id, actor_role: "client",
      action: "edit_custom_tools", entity: "tenants", entity_id: tenantId,
      after: { custom_tools: next } as any,
    } as any);
    refetch();
  };

  if (!perm.visible) return <Navigate to="/app" replace />;
  if (!tenant) return <p className="text-muted-foreground">Carregando...</p>;

  return (
    <div className="space-y-6">
      <CustomToolsTab
        tools={customTools}
        onChange={perm.editable ? saveTools : () => {}}
        tenantId={tenantId ?? undefined}
        readOnly={!perm.editable}
      />
    </div>
  );
}
