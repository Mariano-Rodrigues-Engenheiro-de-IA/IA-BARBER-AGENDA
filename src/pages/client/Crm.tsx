import { useModulePermission } from "@/hooks/useAuth";
import { Navigate } from "react-router-dom";
import { ExternalLink } from "lucide-react";

/** O kanban interno (crm_boards/crm_leads com colunas de funil) saiu daqui
 * — o funil de vendas agora é gerenciado no CRM externo conectado na
 * configuração do estabelecimento. Esta página só orienta o usuário. As
 * marcações (IA OFF) continuam funcionando por fora, sem depender desta
 * tela. */
export default function ClientCrm() {
  const { visible } = useModulePermission("crm");
  if (!visible) return <Navigate to="/app" replace />;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-foreground">CRM</h1>
        <p className="text-muted-foreground">Funil de vendas gerenciado pela IA</p>
      </div>

      <div className="glass-card p-8 text-center space-y-3">
        <ExternalLink className="w-8 h-8 text-primary mx-auto" />
        <p className="text-foreground font-medium">O funil de vendas agora é gerenciado no seu CRM.</p>
        <p className="text-sm text-muted-foreground max-w-md mx-auto">
          A IA move os leads pelas etapas automaticamente durante a conversa. Acesse o painel do CRM para ver e
          gerenciar os leads.
        </p>
      </div>
    </div>
  );
}
