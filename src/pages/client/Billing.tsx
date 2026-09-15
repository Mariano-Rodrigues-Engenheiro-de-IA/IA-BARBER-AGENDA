import { Navigate } from "react-router-dom";
import { useModulePermission } from "@/hooks/useAuth";
import { useClientTenant } from "@/hooks/useClientTenant";
import { CelcashBillingSection } from "@/components/client/CelcashBillingSection";

/** Aba "Cobrança" — só existe de verdade pra tenants com CelCash configurado
 * (celcash_enabled). Página própria, não depende da aba "Integrações" (que
 * não tem item de menu — ninguém conseguia chegar até ela). */
export default function ClientBilling() {
  const perm = useModulePermission("billing");
  const { tenant } = useClientTenant();

  if (!perm.visible) return <Navigate to="/app" replace />;
  if (!tenant) return <p className="text-muted-foreground">Carregando...</p>;
  if (!tenant.celcash_enabled) return <Navigate to="/app" replace />;

  return (
    <div className="space-y-6">
      <CelcashBillingSection tenantId={tenant.id} editable={perm.editable} />
    </div>
  );
}
