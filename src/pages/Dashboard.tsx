import { Link } from "react-router-dom";
import { useTenants } from "@/hooks/useTenants";
import { Building2, CheckCircle, XCircle, AlertTriangle, Plus, Activity, Settings } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";

export default function DashboardPage() {
  const { data: tenants, isLoading } = useTenants();

  const stats = {
    total: tenants?.length ?? 0,
    active: tenants?.filter((t) => t.status === "active").length ?? 0,
    inactive: tenants?.filter((t) => t.status === "inactive").length ?? 0,
    suspended: tenants?.filter((t) => t.status === "suspended").length ?? 0,
  };

  const statCards = [
    { label: "Total de Empresas", value: stats.total, icon: Building2, color: "text-primary" },
    { label: "Ativas", value: stats.active, icon: CheckCircle, color: "text-accent" },
    { label: "Inativas", value: stats.inactive, icon: XCircle, color: "text-muted-foreground" },
    { label: "Suspensas", value: stats.suspended, icon: AlertTriangle, color: "text-warning" },
  ];

  const quickActions = [
    { label: "Nova Empresa", icon: Plus, to: "/tenants/new", color: "bg-primary/10 text-primary" },
    { label: "Monitor IA", icon: Activity, to: "/agent-logs", color: "bg-accent/10 text-accent" },
    { label: "Configurações", icon: Settings, to: "/settings", color: "bg-warning/10 text-warning" },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold text-foreground">Visão Geral</h2>
        <p className="text-muted-foreground mt-1">
          Resumo do ecossistema de agendamento inteligente
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((stat) => (
          <div key={stat.label} className="glass-card p-5 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{stat.label}</span>
              <stat.icon className={`w-5 h-5 ${stat.color}`} />
            </div>
            {isLoading ? (
              <Skeleton className="h-9 w-16" />
            ) : (
              <p className="text-3xl font-bold text-foreground">{stat.value}</p>
            )}
          </div>
        ))}
      </div>

      {/* Quick actions */}
      <div>
        <h3 className="font-semibold text-foreground mb-3">Ações rápidas</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {quickActions.map((action) => (
            <Button
              key={action.label}
              variant="outline"
              className="h-auto p-4 flex flex-col items-center gap-2 border-border hover:bg-muted/50"
              asChild
            >
              <Link to={action.to}>
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${action.color}`}>
                  <action.icon className="w-5 h-5" />
                </div>
                <span className="text-sm font-medium text-foreground">{action.label}</span>
              </Link>
            </Button>
          ))}
        </div>
      </div>

      {/* Recent tenants */}
      <div className="glass-card overflow-hidden">
        <div className="p-5 border-b border-border">
          <h3 className="font-semibold text-foreground">Empresas recentes</h3>
        </div>
        <div className="divide-y divide-border">
          {isLoading ? (
            <div className="p-5 space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex items-center justify-between">
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-3 w-28" />
                  </div>
                  <Skeleton className="h-6 w-16 rounded-full" />
                </div>
              ))}
            </div>
          ) : !tenants?.length ? (
            <div className="p-8 text-center text-muted-foreground">
              <Building2 className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p>Nenhuma empresa cadastrada ainda</p>
            </div>
          ) : (
            tenants.slice(0, 5).map((tenant) => (
              <div key={tenant.id} className="p-4 flex items-center justify-between">
                <div>
                  <p className="font-medium text-foreground">{tenant.name}</p>
                  <p className="text-sm text-muted-foreground">{tenant.email || tenant.phone || "—"}</p>
                </div>
                <StatusBadge status={tenant.status} />
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { label: string; className: string }> = {
    active: { label: "Ativa", className: "bg-accent/10 text-accent" },
    inactive: { label: "Inativa", className: "bg-muted text-muted-foreground" },
    suspended: { label: "Suspensa", className: "bg-warning/10 text-warning" },
  };
  const c = config[status] ?? config.inactive;
  return (
    <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${c.className}`}>
      {c.label}
    </span>
  );
}
