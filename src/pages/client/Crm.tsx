import { useAuth, useModulePermission } from "@/hooks/useAuth";
import { Navigate, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { ZettaCrmFunnelsClient } from "@/components/ZettaCrmFunnelsClient";
import { Sparkles } from "lucide-react";

/** Aba "CRM" do painel do cliente. O kanban interno saiu daqui — o funil de
 * vendas agora é gerenciado no CRM externo. O cliente escolhe quantos
 * funis quiser (ZettaCrmFunnelsClient) — o token de acesso é configurado
 * só pelo admin, o cliente nunca vê nem tem acesso a ele (nem essa
 * checagem abaixo traz o valor, só confirma se existe ou não). */
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
          {/* TODO: trocar por <img src="..." /> assim que o Mariano mandar a
              arte — usar o prompt de geração de imagem combinado
              separadamente. Enquanto isso, mantém um espaço reservado
              proporcional (16:9), sem nenhum texto de venda aqui: a frase
              de efeito já vai estar dentro da própria imagem. */}
          <div className="w-full aspect-video bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center">
            <span className="text-xs text-muted-foreground">[ imagem entra aqui ]</span>
          </div>
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
        <div className="space-y-4">
          <ZettaCrmFunnelsClient tenantId={tenantId} />

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
                mova para a etapa Respondeu". Use sempre o nome da etapa (como aparece nos funis acima), a IA já
                sabe reconhecer.
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
