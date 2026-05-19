import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth, useModulePermission, type AppModule } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { LayoutDashboard, MessageCircle, Clock, Settings, LogOut, Menu, Kanban, Power, PowerOff, Smartphone } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import logoZaylo from "@/assets/logo-zaylo.png";
import { ThemeToggle } from "@/components/ThemeToggle";

interface NavItem { to: string; icon: any; label: string; module: AppModule }
const NAV: NavItem[] = [
  { to: "/app", icon: LayoutDashboard, label: "Visão Geral", module: "overview" },
  { to: "/app/conversations", icon: MessageCircle, label: "Conversas", module: "conversations" },
  { to: "/app/followups", icon: Clock, label: "Follow-ups", module: "followups" },
  { to: "/app/crm", icon: Kanban, label: "CRM", module: "crm" },
  { to: "/app/ai", icon: Settings, label: "Sua IA", module: "ai_prompt" },
  { to: "/app/connection", icon: Smartphone, label: "Conexão", module: "connection" },
];

function NavRow({ item, onClick }: { item: NavItem; onClick: () => void }) {
  const location = useLocation();
  const { visible } = useModulePermission(item.module);
  if (!visible) return null;
  const isActive = location.pathname === item.to;
  return (
    <Link to={item.to} onClick={onClick}
      className={cn(
        "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
        isActive ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground hover:bg-muted",
      )}>
      <item.icon className="w-4 h-4" />
      <span className="flex-1">{item.label}</span>
    </Link>
  );
}

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  const { signOut, user, tenantId } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);

  const { data: tenant, refetch } = useQuery({
    queryKey: ["client-tenant", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data } = await supabase.from("tenants")
        .select("id,name,agent_paused,logo_url")
        .eq("id", tenantId!).single();
      return data as { id: string; name: string; agent_paused: boolean; logo_url: string | null } | null;
    },
  });


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

  const initials = user?.email?.slice(0, 2).toUpperCase() ?? "??";

  const sidebar = (
    <>
      <div className="p-6 border-b border-border">
        <div className="flex items-center gap-3">
          <img
            src={tenant?.logo_url || logoZaylo}
            alt="Logo"
            className="w-10 h-10 rounded-xl object-contain bg-background"
            onError={(e) => { (e.currentTarget as HTMLImageElement).src = logoZaylo; }}
          />
          <div className="min-w-0">
            <h1 className="font-bold text-foreground text-base leading-tight truncate">{tenant?.name ?? "Sua empresa"}</h1>
            <p className="text-xs text-muted-foreground">Painel do cliente</p>
          </div>
        </div>
      </div>

      <nav className="flex-1 p-4 space-y-1">
        {NAV.map((i) => <NavRow key={i.to} item={i} onClick={() => setMobileOpen(false)} />)}
      </nav>
      <div className="p-4 border-t border-border space-y-3">
        <Button
          variant={tenant?.agent_paused ? "default" : "outline"}
          size="sm" className="w-full justify-start gap-2" onClick={togglePause}>
          {tenant?.agent_paused ? <Power className="w-4 h-4" /> : <PowerOff className="w-4 h-4" />}
          {tenant?.agent_paused ? "Ativar IA" : "Pausar IA"}
        </Button>
        <div className="flex items-center gap-3 px-1 py-1">
          <Avatar className="h-8 w-8">
            <AvatarFallback className="text-xs bg-primary/10 text-primary">{initials}</AvatarFallback>
          </Avatar>
          <p className="text-xs text-muted-foreground truncate flex-1">{user?.email}</p>
        </div>
        <ThemeToggle />
        <Button variant="ghost" size="sm" className="w-full justify-start gap-2 text-muted-foreground hover:text-destructive" onClick={signOut}>
          <LogOut className="w-4 h-4" />Sair
        </Button>
      </div>
    </>
  );

  return (
    <div className="min-h-screen flex bg-background">
      {mobileOpen && <div className="fixed inset-0 bg-black/50 z-40 lg:hidden" onClick={() => setMobileOpen(false)} />}
      <aside className="hidden lg:flex w-64 border-r border-border flex-col bg-sidebar">{sidebar}</aside>
      <aside className={cn("fixed inset-y-0 left-0 z-50 w-64 border-r border-border flex flex-col bg-sidebar transition-transform duration-200 lg:hidden",
        mobileOpen ? "translate-x-0" : "-translate-x-full")}>{sidebar}</aside>
      <main className="flex-1 overflow-auto">
        <div className="lg:hidden flex items-center gap-3 p-4 border-b border-border">
          <Button variant="ghost" size="icon" onClick={() => setMobileOpen(true)}><Menu className="w-5 h-5" /></Button>
          <span className="font-semibold text-foreground truncate">{tenant?.name}</span>
        </div>
        <div className="p-4 sm:p-8 max-w-6xl mx-auto animate-fade-in">{children}</div>
      </main>
    </div>
  );
}
