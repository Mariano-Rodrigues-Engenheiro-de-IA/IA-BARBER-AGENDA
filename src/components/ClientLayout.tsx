import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth, useModulePermission, type AppModule } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Switch } from "@/components/ui/switch";
import { LayoutDashboard, MessageCircle, LogOut, Smartphone, Bot, TestTube2, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { postLogoutRedirect, cameFromCrm } from "@/lib/crm-origin";


interface NavItem { to: string; icon: any; label: string; module: AppModule }
const NAV: NavItem[] = [
  { to: "/app", icon: LayoutDashboard, label: "Painel", module: "overview" },
  { to: "/app/conversations", icon: MessageCircle, label: "Conversas", module: "conversations" },
  { to: "/app/ai", icon: Bot, label: "Prompt", module: "ai_prompt" },
  { to: "/app/tools", icon: Wrench, label: "Ferramentas", module: "tools" },
  { to: "/app/simulator", icon: TestTube2, label: "Simulador", module: "simulator" },
  { to: "/app/connection", icon: Smartphone, label: "Conexão", module: "connection" },
];

function SidebarNavItem({ item }: { item: NavItem }) {
  const location = useLocation();
  const { visible } = useModulePermission(item.module);
  if (!visible) return null;
  const isActive = location.pathname === item.to;
  return (
    <Link
      to={item.to}
      aria-label={item.label}
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
        isActive
          ? "bg-sidebar-accent text-sidebar-primary"
          : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
      )}
    >
      <item.icon className={cn("h-5 w-5 shrink-0", isActive && "text-sidebar-primary")} />
      <span className="truncate">{item.label}</span>
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
    <div className={cn("flex min-h-screen bg-background", "theme-frizzar", !isFrizzar && "theme-zaylo", !isFrizzar && "ai-panel-bg")}>
      {!isFrizzar && <div className="ai-topbar-glow" />}

      {/* Sidebar — fixa, sempre aberta (com texto), a pedido do usuário
          (mudou de ideia em relação à versão recolhida-com-tooltip). */}
      <aside className="sticky top-0 flex h-screen w-44 shrink-0 flex-col overflow-y-auto border-r border-sidebar-border bg-sidebar">
        <div className="flex items-center px-4 py-5">
          {isFrizzar ? (
            <img
              src="/frizzar/frizzar-logo-horizontal-white.png"
              alt="Frizzar"
              className="h-6 w-auto object-contain"
            />
          ) : (
            <img
              src="/brand/zaylo-ia-logo-uploaded.png"
              alt="Zaylo IA"
              className="h-8 w-auto max-w-full object-contain"
            />
          )}
        </div>

        <div className="mx-3 mb-2 h-px bg-sidebar-border" />

        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-1">
          {NAV.map((i) => <SidebarNavItem key={i.to} item={i} />)}
        </nav>

        {/* Indicador de status da IA — interruptor discreto, texto completo
            ("IA ativa"/"IA pausada") próximo do switch (gap reduzido). */}
        <div className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-sidebar-foreground/80">
          <span>IA {tenant?.agent_paused ? "pausada" : "ativa"}</span>
          <Switch
            checked={!tenant?.agent_paused}
            onCheckedChange={togglePause}
            className="data-[state=checked]:bg-green-500 data-[state=unchecked]:bg-red-500"
          />
        </div>

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
              <LogOut className="h-5 w-5" />
            </button>
          )}
        </div>
      </aside>

      <main className="min-w-0 flex-1 p-4 sm:p-8 animate-fade-in">{children}</main>
    </div>
  );
}
