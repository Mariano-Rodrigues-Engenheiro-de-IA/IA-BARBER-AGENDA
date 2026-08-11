import { useAuth, useModulePermission } from "@/hooks/useAuth";
import { Navigate, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { ZettaCrmIntegration } from "@/components/ZettaCrmIntegration";
import { ExternalLink, Sparkles } from "lucide-react";

/** Aba "CRM" do painel do cliente. O kanban interno saiu daqui — o funil de
 * vendas agora é gerenciado no CRM externo. Reaproveita o mesmo componente
 * de integração já usado no painel admin (ZettaCrmIntegration) — assim o
 * PRÓPRIO cliente consegue colar o token, escolher o funil e ver as etapas,
 * sem depender de pedir pra equipe fazer isso por ele. Sem token ainda,
 * mostra um link pra página de vendas do CRM. */
export default function ClientCrm() {
  const { tenantId } = useAuth();
  const { visible } = useModulePermission("crm");

  const { data: tenant, isLoading } = useQuery({
    queryKey: ["client-crm-status", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants" as any)
        .select("crm_zetta_token")
        .eq("id", tenantId!)
        .single();
      if (error) throw error;
      return data as unknown as { crm_zetta_token: string | null };
    },
  });

  if (!visible) return <Navigate to="/app" replace />;

  const hasToken = Boolean(tenant?.crm_zetta_token);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-foreground">CRM</h1>
        <p className="text-muted-foreground">Funil de vendas gerenciado pela IA</p>
      </div>

      {isLoading ? (
        <div className="glass-card p-8 text-center text-muted-foreground">Carregando...</div>
      ) : !hasToken ? (
        <div className="glass-card p-8 text-center space-y-4">
          <ExternalLink className="w-8 h-8 text-primary mx-auto" />
          <div>
            <p className="text-foreground font-medium">Você ainda não tem um CRM conectado.</p>
            <p className="text-sm text-muted-foreground max-w-md mx-auto mt-1">
              Conecte um CRM pra deixar a IA mover seus leads pelo funil de vendas automaticamente, durante a
              própria conversa no WhatsApp.
            </p>
          </div>
          <a
            href="https://crm.zayloia.com"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
          >
            Conhecer o CRM
          </a>
        </div>
      ) : tenantId ? (
        <div className="space-y-4">
          <ZettaCrmIntegration tenantId={tenantId} />

          <div className="glass-card p-5 flex gap-3 items-start">
            <Sparkles className="w-5 h-5 text-primary shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-foreground">Falta só uma coisa</p>
              <p className="text-sm text-muted-foreground mt-1">
                Agora é só instruir a IA, na aba{" "}
                <Link to="/app/ai" className="text-primary underline underline-offset-2">
                  Sua IA
                </Link>
                , sobre quando mover o lead para cada etapa — por exemplo: "quando o cliente perguntar o preço,
                mova para a etapa Respondeu". Use sempre o nome da etapa (como aparece acima), a IA já sabe
                reconhecer.
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
