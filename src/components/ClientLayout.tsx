import { useState, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth, useModulePermission, type AppModule } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { LayoutDashboard, MessageCircle, LogOut, Power, PowerOff, Smartphone, Bot, TestTube2, Wrench, BookOpen, Plug, Building2, Menu } from "lucide-react";
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

function SidebarNavItem({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  const location = useLocation();
  const { visible } = useModulePermission(item.module);
  if (!visible) return null;
  const isActive = location.pathname === item.to;
  return (
    <Link
      to={item.to}
      onClick={onNavigate}
      aria-label={item.label}
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
        isActive
          ? "bg-sidebar-accent text-sidebar-primary"
          : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
      )}
    >
      <item.icon className={cn("h-4 w-4 shrink-0", isActive && "text-sidebar-primary")} />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  const { signOut, user, tenantId } = useAuth();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

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
  // (telas grandes) e o drawer (mobile) — evita duplicar a lista de nav.
  const sidebarContent = (onNavigate?: () => void) => (
    <div className="flex h-full flex-col">
      <div className="flex items-center px-4 py-5">
        {isFrizzar ? (
          <img
            src="/frizzar/frizzar-logo-horizontal-white.png"
            alt="Frizzar"
            width={867}
            height={178}
            fetchPriority="high"
            decoding="sync"
            loading="eager"
            className="h-6 w-auto shrink-0 object-contain select-none"
            draggable={false}
          />
        ) : (
          <img
            src="/brand/zaylo-icon.png"
            alt="Zaylo IA"
            width={95}
            height={61}
            fetchPriority="high"
            decoding="sync"
            loading="eager"
            className="h-8 w-auto shrink-0 object-contain select-none"
            draggable={false}
          />
        )}
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-2">
        {NAV.map((i) => <SidebarNavItem key={i.to} item={i} onNavigate={onNavigate} />)}
      </nav>

      <div className="flex items-center gap-3 border-t border-sidebar-border px-4 py-4">
        <Avatar className="h-8 w-8 shrink-0">
          {tenant?.logo_url && <AvatarImage src={tenant.logo_url} alt={tenant?.name ?? "Logo"} className="object-contain bg-background" />}
          <AvatarFallback className="text-xs bg-primary/10 text-primary">{initials}</AvatarFallback>
        </Avatar>
        <span className="min-w-0 flex-1 truncate text-sm text-sidebar-foreground/80">{tenant?.name ?? ""}</span>
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
    <div className={cn("min-h-screen bg-background", "theme-frizzar", !isFrizzar && "theme-zaylo", !isFrizzar && "ai-panel-bg")}>
      {!isFrizzar && <div className="ai-topbar-glow" />}

      {/* Sidebar fixa — telas grandes (lg+) */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 border-r border-sidebar-border bg-sidebar lg:block">
        {sidebarContent()}
      </aside>

      {/* Sidebar em drawer — telas pequenas */}
      <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
        <SheetContent side="left" className="w-64 bg-sidebar p-0 border-sidebar-border">
          {sidebarContent(() => setMobileMenuOpen(false))}
        </SheetContent>
      </Sheet>

      <div className="lg:pl-64">
        {/* Faixa fixa no topo do conteúdo — botão de pausar/ativar sempre
            visível, e o botão de menu em telas pequenas. */}
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-sidebar px-4 py-3 sm:px-8">
          <button
            onClick={() => setMobileMenuOpen(true)}
            aria-label="Abrir menu"
            className="rounded-lg p-1.5 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground lg:hidden"
          >
            <Menu className="h-5 w-5" />
          </button>

          <Button
            size="sm"
            className={cn(
              "ml-auto gap-2 border border-sidebar-primary/60 shadow-sm",
              tenant?.agent_paused
                ? "bg-sidebar-primary text-sidebar-primary-foreground hover:bg-sidebar-primary/90"
                : "bg-sidebar-primary/15 text-sidebar-primary hover:bg-sidebar-primary/25",
            )}
            onClick={togglePause}
          >
            {tenant?.agent_paused ? <Power className="h-4 w-4" /> : <PowerOff className="h-4 w-4" />}
            <span>{tenant?.agent_paused ? "Ativar IA" : "Pausar IA"}</span>
          </Button>
        </header>

        <main className="mx-auto max-w-[1560px] p-4 sm:p-8 animate-fade-in">{children}</main>
      </div>
    </div>
  );
}
