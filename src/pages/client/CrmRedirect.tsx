import { Navigate } from "react-router-dom";
import { useAuth, useModulePermission } from "@/hooks/useAuth";

export default function ClientCrmRedirect() {
  const { tenantId } = useAuth();
  const { visible } = useModulePermission("crm");
  if (!visible) return <Navigate to="/app" replace />;
  if (!tenantId) return null;
  return <Navigate to={`/tenants/${tenantId}/kanban`} replace />;
}
