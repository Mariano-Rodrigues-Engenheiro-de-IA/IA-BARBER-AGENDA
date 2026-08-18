import { useState, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth, useModulePermission, type AppModule } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { LayoutDashboard, MessageCircle, LogOut, Power, PowerOff, Smartphone, Bot, TestTube2, Wrench, BookOpen, Plug, Building2, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { postLogoutRedirect } from "@/lib/crm-origin";


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

function TopNavItem({ item }: { item: NavItem }) {
  const location = useLocation();
  const { visible } = useModulePermission(item.module);
  if (!visible) return null;
  const isActive = location.pathname === item.to;
  return (
    <Link
      to={item.to}
      className={cn(
        "flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3 py-3 text-sm font-medium transition-colors",
        isActive
          ? "border-primary text-primary"
          : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
      )}
    >
      <item.icon className="h-4 w-4" />
      {item.label}
    </Link>
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
    <div className={cn("min-h-screen bg-background", "theme-frizzar", !isFrizzar && "theme-zaylo")}>
      <header className="sticky top-0 z-40 border-b border-border bg-sidebar">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3 sm:px-8">
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
              src="/brand/zaylo-ia-logo-white.png"
              alt="Zaylo IA"
              width={942}
              height={130}
              fetchPriority="high"
              decoding="sync"
              loading="eager"
              className="h-5 w-auto shrink-0 object-contain select-none"
              draggable={false}
            />
          )}

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button
              variant={tenant?.agent_paused ? "default" : "outline"}
              size="sm"
              className={cn(
                "hidden gap-2 sm:flex",
                !tenant?.agent_paused && "border-sidebar-border bg-transparent text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground",
              )}
              onClick={togglePause}
            >
              {tenant?.agent_paused ? <Power className="h-4 w-4" /> : <PowerOff className="h-4 w-4" />}
              {tenant?.agent_paused ? "Ativar IA" : "Pausar IA"}
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-sidebar-accent">
                  <Avatar className="h-7 w-7">
                    {tenant?.logo_url && <AvatarImage src={tenant.logo_url} alt={tenant?.name ?? "Logo"} className="object-contain bg-background" />}
                    <AvatarFallback className="text-xs bg-primary/10 text-primary">{initials}</AvatarFallback>
                  </Avatar>
                  <ChevronDown className="hidden h-3.5 w-3.5 text-sidebar-foreground/60 sm:block" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <div className="px-2 py-1.5 text-xs text-muted-foreground truncate">{user?.email}</div>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="sm:hidden" onClick={togglePause}>
                  {tenant?.agent_paused ? <Power className="mr-2 h-4 w-4" /> : <PowerOff className="mr-2 h-4 w-4" />}
                  {tenant?.agent_paused ? "Ativar IA" : "Pausar IA"}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleSignOut} className="text-destructive focus:text-destructive">
                  <LogOut className="mr-2 h-4 w-4" /> Sair
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4 sm:px-8">
          {NAV.map((i) => <TopNavItem key={i.to} item={i} />)}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl p-4 sm:p-8 animate-fade-in">{children}</main>
    </div>
  );
}
