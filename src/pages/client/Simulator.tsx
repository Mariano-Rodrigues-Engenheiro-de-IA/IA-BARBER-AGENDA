import { useAuth, useModulePermission } from "@/hooks/useAuth";
import { Navigate } from "react-router-dom";
import { SimulatorTab } from "@/components/SimulatorTab";

/** Simulador, separado da aba "Sua IA" a pedido do Mariano — vira item
 * próprio de navegação, com o mesmo visual "clean" da tela de Conversas
 * (painel branco com borda definida, papel de parede do WhatsApp na área
 * de mensagens — aplicado dentro do próprio SimulatorTab). */
export default function ClientSimulator() {
  const { tenantId } = useAuth();
  const { visible } = useModulePermission("simulator");
  if (!visible) return <Navigate to="/app" replace />;

  return (
    <div className="space-y-4">
      {tenantId && <SimulatorTab tenantId={tenantId} />}
    </div>
  );
}
