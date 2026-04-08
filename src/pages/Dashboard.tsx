import { useTenants } from "@/hooks/useTenants";
import { Building2, CheckCircle, XCircle, AlertTriangle } from "lucide-react";

export default function DashboardPage() {
  const { data: tenants, isLoading } = useTenants();

  const stats = {
    total: tenants?.length ?? 0,
    active: tenants?.filter((t) => t.status === "active").length ?? 0,
    inactive: tenants?.filter((t) => t.status === "inactive").length ?? 0,
    suspended: tenants?.filter((t) => t.status === "suspended").length ?? 0,
  };

  const statCards = [
    { label: "Total de Tenants", value: stats.total, icon: Building2, color: "text-primary" },
    { label: "Ativos", value: stats.active, icon: CheckCircle, color: "text-accent" },
    { label: "Inativos", value: stats.inactive, icon: XCircle, color: "text-muted-foreground" },
    { label: "Suspensos", value: stats.suspended, icon: AlertTriangle, color: "text-warning" },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold text-foreground">Visão Geral</h2>
        <p className="text-muted-foreground mt-1">
          Resumo do ecossistema de agendamento inteligente
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((stat) => (
          <div key={stat.label} className="glass-card p-5 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{stat.label}</span>
              <stat.icon className={`w-5 h-5 ${stat.color}`} />
            </div>
            <p className="text-3xl font-bold text-foreground">
              {isLoading ? "..." : stat.value}
            </p>
          </div>
        ))}
      </div>

      {/* Recent tenants */}
      <div className="glass-card overflow-hidden">
        <div className="p-5 border-b border-border">
          <h3 className="font-semibold text-foreground">Tenants recentes</h3>
        </div>
        <div className="divide-y divide-border">
          {isLoading ? (
            <div className="p-5 text-center text-muted-foreground">Carregando...</div>
          ) : !tenants?.length ? (
            <div className="p-8 text-center text-muted-foreground">
              <Building2 className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p>Nenhum tenant cadastrado ainda</p>
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
    active: { label: "Ativo", className: "bg-accent/10 text-accent" },
    inactive: { label: "Inativo", className: "bg-muted text-muted-foreground" },
    suspended: { label: "Suspenso", className: "bg-warning/10 text-warning" },
  };
  const c = config[status] ?? config.inactive;
  return (
    <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${c.className}`}>
      {c.label}
    </span>
  );
}
