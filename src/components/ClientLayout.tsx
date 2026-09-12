import { useState, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth, useModulePermission, type AppModule } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { LayoutDashboard, MessageCircle, LogOut, Power, PowerOff, Smartphone, Bot, TestTube2, Wrench, BookOpen, Plug, Building2, Menu, ChevronLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { postLogoutRedirect, cameFromCrm } from "@/lib/crm-origin";


interface NavItem { to: string; icon: any; label: string; module: AppModule }
const NAV: NavItem[] = [
  { to: "/app", icon: LayoutDashboard, label: "Visão Geral", module: "overview" },
  { to: "/app/conversations", icon: MessageCircle, label: "Conversas", module: "conversations" },
  { to: "/app/ai", icon: Bot, label: "Prompt", module: "ai_prompt" },
  { to: "/app/tools", icon: Wrench, label: "Ferramentas da IA", module: "tools" },
  { to: "/app/knowledge", icon: BookOpen, label: "Base de conhecimento", module: "ai_knowledge" },
  { to: "/app/integrations", icon: Plug, label: "Integrações", module: "integrations" },
  { to: "/app/company", icon: Building2, label: "Dados da empresa", module: "company_data" },
  { to: "/app/simulator", icon: TestTube2, label: "Simulador", module: "simulator" },
  { to: "/app/connection", icon: Smartphone, label: "Conexão WhatsApp", module: "connection" },
];

function SidebarNavItem({ item, collapsed, onNavigate }: { item: NavItem; collapsed: boolean; onNavigate?: () => void }) {
  const location = useLocation();
  const { visible } = useModulePermission(item.module);
  if (!visible) return null;
  const isActive = location.pathname === item.to;
  return (
    <div className="group relative">
      <Link
        to={item.to}
        onClick={onNavigate}
        aria-label={item.label}
        className={cn(
          "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
          collapsed && "justify-center px-0",
          isActive
            ? "bg-sidebar-accent text-sidebar-primary"
            : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
        )}
      >
        <item.icon className={cn("h-4 w-4 shrink-0", isActive && "text-sidebar-primary")} />
        {!collapsed && <span className="truncate">{item.label}</span>}
      </Link>
      {/* Tooltip só quando recolhido — mesmo padrão do menu do CRM. */}
      {collapsed && (
        <span className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded-lg bg-sidebar-primary px-2.5 py-1.5 text-xs font-semibold text-sidebar-primary-foreground opacity-0 shadow-lg transition-opacity duration-75 group-hover:opacity-100">
          {item.label}
        </span>
      )}
    </div>
  );
}

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  const { signOut, user, tenantId } = useAuth();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  // Colapso da sidebar, persistido — mesmo padrão do menu do CRM
  // (localStorage key própria, para não colidir com a do CRM).
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("ia_barber_sidebar_collapsed") === "1",
  );
  useEffect(() => {
    localStorage.setItem("ia_barber_sidebar_collapsed", sidebarCollapsed ? "1" : "0");
  }, [sidebarCollapsed]);

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

  // Conteúdo da sidebar extraído para reaproveitar entre a versão fixa
  // (telas grandes, com colapso) e o drawer (mobile, sempre expandido).
  const sidebarContent = (collapsed: boolean, showCollapseToggle: boolean, onNavigate?: () => void) => (
    <div className="flex h-full flex-col">
      {/* Topo: logo + botão de colapsar (só na versão fixa/desktop) */}
      <div className={cn("flex pt-5 pb-4", collapsed ? "flex-col items-center gap-2 px-2" : "items-center justify-between pl-8 pr-3")}>
        <div className={cn("relative flex h-9 shrink-0 items-center transition-[width] duration-200", collapsed ? "w-9 justify-center" : "w-36 justify-start")}>
          {isFrizzar ? (
            <img
              src="/frizzar/frizzar-logo-horizontal-white.png"
              alt="Frizzar"
              className={cn("absolute left-0 h-6 w-auto object-contain object-left transition-opacity duration-200", collapsed ? "opacity-0" : "opacity-100")}
            />
          ) : (
            <>
              {/* Ambas as imagens ficam sempre montadas (pré-carregadas) e
                  alternam via opacidade, em sincronia com a transição de
                  largura da sidebar — mesmo truque do menu do CRM, evita
                  "salto" ao trocar de <img> condicionalmente. */}
              <img
                src="/brand/zaylo-ia-logo-white.png"
                alt="Zaylo IA"
                className={cn("absolute left-0 h-8 w-auto object-contain object-left transition-opacity duration-200", collapsed ? "opacity-0" : "opacity-100")}
              />
              <img
                src="/brand/zaylo-icon.png"
                alt="Zaylo IA"
                className={cn("absolute h-8 w-auto object-contain transition-opacity duration-200", collapsed ? "opacity-100" : "opacity-0")}
              />
            </>
          )}
        </div>
        {showCollapseToggle && (
          <button
            onClick={() => setSidebarCollapsed((v) => !v)}
            title={collapsed ? "Expandir menu" : "Recolher menu"}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground/50 transition hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <ChevronLeft className={cn("h-4 w-4 transition-transform", collapsed && "rotate-180")} />
          </button>
        )}
      </div>

      <div className="mx-3 mb-2 h-px bg-sidebar-border" />

      {/* Botão de Pausar/Ativar IA — dentro da sidebar, acima do bloco da
          empresa (pedido do usuário), sem faixa separada no topo do
          conteúdo. */}
      <div className={cn("mb-2", collapsed ? "px-2" : "px-3")}>
        <button
          onClick={togglePause}
          title={tenant?.agent_paused ? "Ativar IA" : "Pausar IA"}
          className={cn(
            "flex w-full items-center gap-2 rounded-lg border border-sidebar-primary/60 py-2 text-sm font-medium shadow-sm transition-colors",
            collapsed ? "justify-center px-0" : "px-3",
            tenant?.agent_paused
              ? "bg-sidebar-primary text-sidebar-primary-foreground hover:bg-sidebar-primary/90"
              : "bg-sidebar-primary/15 text-sidebar-primary hover:bg-sidebar-primary/25",
          )}
        >
          {tenant?.agent_paused ? <Power className="h-4 w-4 shrink-0" /> : <PowerOff className="h-4 w-4 shrink-0" />}
          {!collapsed && <span>{tenant?.agent_paused ? "Ativar IA" : "Pausar IA"}</span>}
        </button>
      </div>

      <nav className={cn("flex-1 space-y-1 overflow-y-auto", collapsed ? "px-2" : "px-3")}>
        {NAV.map((i) => <SidebarNavItem key={i.to} item={i} collapsed={collapsed} onNavigate={onNavigate} />)}
      </nav>

      <div className={cn("flex items-center gap-3 border-t border-sidebar-border py-4", collapsed ? "flex-col px-2" : "px-4")}>
        <Avatar className="h-8 w-8 shrink-0">
          {tenant?.logo_url && <AvatarImage src={tenant.logo_url} alt={tenant?.name ?? "Logo"} className="object-contain bg-background" />}
          <AvatarFallback className="text-xs bg-primary/10 text-primary">{initials}</AvatarFallback>
        </Avatar>
        {!collapsed && <span className="min-w-0 flex-1 truncate text-sm text-sidebar-foreground/80">{tenant?.name ?? ""}</span>}
        {!cameFromCrm() && (
          <button
            onClick={handleSignOut}
            title="Sair"
            className="shrink-0 rounded-lg p-1.5 text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <LogOut className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );

  return (
    // Nota: a classe CSS "theme-frizzar" virou o tema PADRÃO de todo o
    // painel do cliente (fundo cinza-chumbo/azulado) — não é mais
    // exclusiva de clientes Frizzar. "theme-zaylo" é aplicada JUNTO pra
    // clientes que não são da parceria — sobrescreve só a cor de destaque,
    // com o tom próprio da marca Zaylo, já que clientes Frizzar mantêm a
    // cor original.
    <div className={cn("flex min-h-screen bg-background", "theme-frizzar", !isFrizzar && "theme-zaylo", !isFrizzar && "ai-panel-bg")}>
      {!isFrizzar && <div className="ai-topbar-glow" />}

      {/* Sidebar fixa — telas grandes (md+), com colapso */}
      <aside
        className={cn(
          "sticky top-0 hidden h-screen shrink-0 flex-col overflow-y-auto border-r border-sidebar-border bg-sidebar transition-all duration-200 md:flex",
          sidebarCollapsed ? "w-[68px]" : "w-64",
        )}
      >
        {sidebarContent(sidebarCollapsed, true)}
      </aside>

      {/* Menu em drawer — telas pequenas, sempre expandido dentro do drawer */}
      <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
        <SheetContent side="left" className="w-64 bg-sidebar p-0 border-sidebar-border">
          {sidebarContent(false, false, () => setMobileMenuOpen(false))}
        </SheetContent>
      </Sheet>

      {/* Botão de abrir o menu em telas pequenas — flutuante, já que não há
          mais faixa superior fixa. */}
      <button
        onClick={() => setMobileMenuOpen(true)}
        aria-label="Abrir menu"
        className="fixed left-3 top-3 z-30 flex h-9 w-9 items-center justify-center rounded-lg border border-sidebar-border bg-sidebar text-sidebar-foreground/80 shadow-sm md:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>

      <main className="min-w-0 flex-1 p-4 pt-16 sm:p-8 md:pt-8 animate-fade-in">
        <div className="mx-auto max-w-[1560px]">{children}</div>
      </main>
    </div>
  );
}
