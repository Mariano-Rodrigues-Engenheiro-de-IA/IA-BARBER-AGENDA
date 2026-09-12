import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth, useModulePermission, type AppModule } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { LayoutDashboard, MessageCircle, LogOut, Power, PowerOff, Smartphone, Bot, TestTube2, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { postLogoutRedirect, cameFromCrm } from "@/lib/crm-origin";


interface NavItem { to: string; icon: any; label: string; module: AppModule }
const NAV: NavItem[] = [
  { to: "/app", icon: LayoutDashboard, label: "Visão Geral", module: "overview" },
  { to: "/app/conversations", icon: MessageCircle, label: "Conversas", module: "conversations" },
  { to: "/app/ai", icon: Bot, label: "Prompt", module: "ai_prompt" },
  { to: "/app/tools", icon: Wrench, label: "Ferramentas da IA", module: "tools" },
  { to: "/app/simulator", icon: TestTube2, label: "Simulador", module: "simulator" },
  { to: "/app/connection", icon: Smartphone, label: "Conexão WhatsApp", module: "connection" },
];

// Tooltip padrão (ícone -> nome ao passar o mouse) — reaproveitado pelos
// itens de navegação e pelos botões de Ativar IA / Sair.
function IconTooltip({ label }: { label: string }) {
  return (
    <span className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded-lg bg-sidebar-primary px-2.5 py-1.5 text-xs font-semibold text-sidebar-primary-foreground opacity-0 shadow-lg transition-opacity duration-75 group-hover:opacity-100">
      {label}
    </span>
  );
}

function SidebarNavItem({ item }: { item: NavItem }) {
  const location = useLocation();
  const { visible } = useModulePermission(item.module);
  if (!visible) return null;
  const isActive = location.pathname === item.to;
  return (
    <div className="group relative">
      <Link
        to={item.to}
        aria-label={item.label}
        className={cn(
          "flex items-center justify-center rounded-lg px-0 py-2.5 transition-colors",
          isActive
            ? "bg-sidebar-accent text-sidebar-primary"
            : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
        )}
      >
        <item.icon className="h-5 w-5 shrink-0" />
      </Link>
      <IconTooltip label={item.label} />
    </div>
  );
}

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  const { signOut, user, tenantId } = useAuth();

  const { data: tenant, refetch } = useQuery({
    queryKey: ["client-tenant", tenantId],
    enabled: !!tenantId,
    // Dado quase estático — evita refetch a cada navegação (a logo/tema
    // já vêm do cache, sem "piscar").
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data } = await supabase.from("tenants")
        .select("id,name,agent_paused,logo_url,api_provider")
        .eq("id", tenantId!).single();
      return data as { id: string; name: string; agent_paused: boolean; logo_url: string | null; api_provider: string | null } | null;
    },
  });

  // White-label para clientes da parceria Frizzar — o painel deve parecer
  // parte do produto deles, não um "parceiro usando a marca deles".
  const isFrizzar = tenant?.api_provider === "frizzar";

  useEffect(() => {
    const title = isFrizzar ? "Frizzar" : "Zaylo IA";
    const iconHref = isFrizzar ? "/frizzar/frizzar-favicon.png" : "/brand/zaylo-favicon.png";
    const prevTitle = document.title;
    document.title = title;
    const existing = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    const prevHref = existing?.href;
    const weCreatedIt = !existing;
    const link = existing ?? document.createElement("link");
    link.rel = "icon";
    if (weCreatedIt) document.head.appendChild(link);
    link.href = iconHref;
    return () => {
      document.title = prevTitle;
      // Se não existia nenhum favicon antes de nós criarmos, remove o
      // elemento inteiro na limpeza — tentar "restaurar" um href que
      // nunca existiu deixava o ícone preso na aba mesmo depois de trocar
      // pra outra conta.
      if (weCreatedIt) {
        link.remove();
      } else if (prevHref) {
        link.href = prevHref;
      }
    };
  }, [isFrizzar]);

  const togglePause = async () => {
    if (!tenant) return;
    const newVal = !tenant.agent_paused;
    const { error } = await supabase.from("tenants")
      .update({ agent_paused: newVal }).eq("id", tenant.id);
    if (error) return toast.error(error.message);
    await supabase.from("audit_logs").insert({
      tenant_id: tenant.id, user_id: user?.id, actor_role: "client",
      action: newVal ? "pause_agent" : "resume_agent",
      entity: "tenants", entity_id: tenant.id,
    });
    toast.success(newVal ? "IA pausada" : "IA ativada");
    refetch();
  };

  async function handleSignOut() {
    // Se o cliente chegou aqui pelo link mágico do CRM, ele nunca teve
    // senha nessa conta — mandar pra tela de login própria confundiria.
    // Nesse caso, volta pro CRM em vez disso.
    const redirect = postLogoutRedirect();
    await signOut();
    if (redirect) window.location.href = redirect;
  }

  const initials = user?.email?.slice(0, 2).toUpperCase() ?? "??";

  return (
    // Nota: a classe CSS "theme-frizzar" virou o tema PADRÃO de todo o
    // painel do cliente (fundo cinza-chumbo/azulado) — não é mais
    // exclusiva de clientes Frizzar. "theme-zaylo" é aplicada JUNTO pra
    // clientes que não são da parceria — sobrescreve só a cor de destaque,
    // com o tom próprio da marca Zaylo, já que clientes Frizzar mantêm a
    // cor original.
    <div className={cn("flex min-h-screen bg-background", "theme-frizzar", !isFrizzar && "theme-zaylo", !isFrizzar && "ai-panel-bg")}>
      {!isFrizzar && <div className="ai-topbar-glow" />}

      {/* Sidebar — sempre recolhida (só ícones), a pedido do usuário.
          Fina o suficiente (68px) para ficar visível em qualquer
          tamanho de tela, sem precisar de versão separada para mobile. */}
      <aside className="sticky top-0 flex h-screen w-[68px] shrink-0 flex-col overflow-y-auto border-r border-sidebar-border bg-sidebar">
        {/* Logo — recortada para mostrar só o símbolo (a barra sempre
            recolhida não tem espaço para o nome por extenso). */}
        <div className="flex items-center justify-center py-5">
          {isFrizzar ? (
            <img
              src="/frizzar/frizzar-logo-circle-white.png"
              alt="Frizzar"
              className="h-8 w-8 object-contain"
            />
          ) : (
            <div className="h-8 w-8 overflow-hidden">
              <img
                src="/brand/zaylo-ia-logo-uploaded.png"
                alt="Zaylo IA"
                // Mesma logo da tela de login, recortada para mostrar só o
                // símbolo (canto esquerdo da imagem) — a imagem completa
                // tem o símbolo + "ZAYLO AI" por extenso.
                className="h-8 w-auto max-w-none object-cover object-left"
                style={{ width: "32px", objectPosition: "0% center" }}
              />
            </div>
          )}
        </div>

        <div className="mx-3 mb-2 h-px bg-sidebar-border" />

        <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-1">
          {NAV.map((i) => <SidebarNavItem key={i.to} item={i} />)}
        </nav>

        {/* Botão de Pausar/Ativar IA — embaixo, longe da navegação, para
            não competir visualmente com as abas (pedido do usuário). */}
        <div className="px-2 pb-2">
          <div className="group relative">
            <button
              onClick={togglePause}
              className={cn(
                "flex w-full items-center justify-center rounded-lg border border-sidebar-primary/60 py-2.5 shadow-sm transition-colors",
                tenant?.agent_paused
                  ? "bg-sidebar-primary text-sidebar-primary-foreground hover:bg-sidebar-primary/90"
                  : "bg-sidebar-primary/15 text-sidebar-primary hover:bg-sidebar-primary/25",
              )}
            >
              {tenant?.agent_paused ? <Power className="h-5 w-5" /> : <PowerOff className="h-5 w-5" />}
            </button>
            <IconTooltip label={tenant?.agent_paused ? "Ativar IA" : "Pausar IA"} />
          </div>
        </div>

        <div className="flex flex-col items-center gap-2 border-t border-sidebar-border py-4">
          <Avatar className="h-8 w-8 shrink-0">
            {tenant?.logo_url && <AvatarImage src={tenant.logo_url} alt={tenant?.name ?? "Logo"} className="object-contain bg-background" />}
            <AvatarFallback className="text-xs bg-primary/10 text-primary">{initials}</AvatarFallback>
          </Avatar>
          {!cameFromCrm() && (
            <div className="group relative">
              <button
                onClick={handleSignOut}
                className="rounded-lg p-1.5 text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground"
              >
                <LogOut className="h-5 w-5" />
              </button>
              <IconTooltip label="Sair" />
            </div>
          )}
        </div>
      </aside>

      <main className="min-w-0 flex-1 p-4 sm:p-8 animate-fade-in">{children}</main>
    </div>
  );
}
