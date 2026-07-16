import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useTenants } from "@/hooks/useTenants";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { LayoutDashboard, Building2, LogOut, Settings, Activity, Menu, X, Clock, ShieldCheck, FileText, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import logoZaylo from "@/assets/logo-zaylo.png";
import { ThemeToggle } from "@/components/ThemeToggle";

type NavItem = { to: string; icon: any; label: string; countKey?: "tenants"; module?: string };
const navItems: NavItem[] = [
  { to: "/", icon: LayoutDashboard, label: "Visão Geral" },
  { to: "/tenants", icon: Building2, label: "Empresas", countKey: "tenants" },
  { to: "/follow-ups", icon: Clock, label: "Follow-ups", module: "follow-ups" },
  { to: "/agent-logs", icon: Activity, label: "Monitor IA", module: "agent-logs" },
  { to: "/prompts", icon: FileText, label: "Prompts", module: "prompts" },
  { to: "/staff", icon: Users, label: "Colaboradores", module: "staff" },
  { to: "/audit", icon: ShieldCheck, label: "Auditoria", module: "audit" },
  { to: "/settings", icon: Settings, label: "Configurações", module: "settings" },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { signOut, user, isAdmin, isStaff, staffModules } = useAuth();
  const location = useLocation();
  const { data: tenants } = useTenants();
  const [mobileOpen, setMobileOpen] = useState(false);

  const counts = {
    tenants: tenants?.length ?? 0,
  };
  const visibleNav = navItems.filter((i) => {
    if (!i.module) return true;
    if (isAdmin) return true;
    return staffModules.has(i.module as any);
  });
  const roleLabel = isAdmin ? "Painel Admin" : isStaff ? "Painel Colaborador" : "Painel";

  const userInitials = user?.email
    ? user.email.slice(0, 2).toUpperCase()
    : "??";

  const sidebarContent = (
    <>
      <div className="p-6 border-b border-border">
        <div className="flex items-center gap-3">
          <img src={logoZaylo} alt="IA Barber Pro" className="w-12 h-12 rounded-xl object-contain" />
          <div>
            <h1 className="font-bold text-foreground text-lg leading-tight">IA Barber Pro</h1>
            <p className="text-xs text-muted-foreground">{roleLabel}</p>
          </div>
        </div>
      </div>

      <nav className="flex-1 p-4 space-y-1">
        {visibleNav.map((item) => {
          const isActive = location.pathname === item.to ||
            (item.to !== "/" && location.pathname.startsWith(item.to));
          const count = item.countKey ? counts[item.countKey] : undefined;
          return (
            <Link
              key={item.to}
              to={item.to}
              onClick={() => setMobileOpen(false)}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              )}
            >
              <item.icon className="w-4 h-4" />
              <span className="flex-1">{item.label}</span>
              {count !== undefined && count > 0 && (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-5 min-w-[20px] justify-center">
                  {count}
                </Badge>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="p-4 border-t border-border space-y-3">
        <div className="flex items-center gap-3 px-3 py-2">
          <Avatar className="h-8 w-8">
            <AvatarFallback className="text-xs bg-primary/10 text-primary">
              {userInitials}
            </AvatarFallback>
          </Avatar>
          <p className="text-xs text-muted-foreground truncate flex-1">{user?.email}</p>
        </div>
        <ThemeToggle />
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2 text-muted-foreground hover:text-destructive"
          onClick={signOut}
        >
          <LogOut className="w-4 h-4" />
          Sair
        </Button>
      </div>
    </>
  );

  return (
    <div className="min-h-screen flex bg-background">
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar - desktop */}
      <aside className="hidden lg:flex w-64 border-r border-border flex-col bg-sidebar">
        {sidebarContent}
      </aside>

      {/* Sidebar - mobile */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-64 border-r border-border flex flex-col bg-sidebar transition-transform duration-200 lg:hidden",
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        {sidebarContent}
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        {/* Mobile header */}
        <div className="lg:hidden flex items-center gap-3 p-4 border-b border-border">
          <Button variant="ghost" size="icon" onClick={() => setMobileOpen(true)}>
            <Menu className="w-5 h-5" />
          </Button>
          <img src={logoZaylo} alt="IA Barber Pro" className="w-7 h-7 rounded-lg object-contain" />
          <span className="font-semibold text-foreground">IA Barber Pro</span>
        </div>
        <div className="p-4 sm:p-8 max-w-6xl mx-auto animate-fade-in">
          {children}
        </div>
      </main>
    </div>
  );
}
