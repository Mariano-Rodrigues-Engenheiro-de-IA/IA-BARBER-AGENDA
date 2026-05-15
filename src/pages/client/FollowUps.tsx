import { useAuth, useModulePermission } from "@/hooks/useAuth";
import { Navigate } from "react-router-dom";
import FollowUpsDashboardPage from "@/pages/FollowUpsDashboard";

export default function ClientFollowUps() {
  const { tenantId } = useAuth();
  const { visible } = useModulePermission("followups");
  if (!visible) return <Navigate to="/app" replace />;
  if (!tenantId) return null;
  // Reaproveita o painel existente; ele consulta por tenant_id via RLS
  return <FollowUpsDashboardPage />;
}
