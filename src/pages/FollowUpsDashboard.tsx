import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Clock, CheckCircle2, Send, XCircle, Building2 } from "lucide-react";

type FollowUp = {
  id: string;
  tenant_id: string;
  phone_number: string;
  status: string;
  created_at: string;
  follow_up_at: string;
  sent_at: string | null;
  confirmed_at: string | null;
  follow_up_message: string | null;
};

type Tenant = {
  id: string;
  name: string;
};

export default function FollowUpsDashboard() {
  const [period, setPeriod] = useState<"7d" | "30d" | "all">("30d");

  const { data: followUps, isLoading: loadingFU } = useQuery({
    queryKey: ["follow-ups-dashboard", period],
    queryFn: async () => {
      let query = supabase.from("follow_ups").select("*").order("created_at", { ascending: false });
      if (period !== "all") {
        const days = period === "7d" ? 7 : 30;
        const since = new Date(Date.now() - days * 86400000).toISOString();
        query = query.gte("created_at", since);
      }
      const { data, error } = await query;
      if (error) throw error;
      return data as FollowUp[];
    },
  });

  const { data: tenants } = useQuery({
    queryKey: ["tenants-list"],
    queryFn: async () => {
      const { data, error } = await supabase.from("tenants").select("id, name");
      if (error) throw error;
      return data as Tenant[];
    },
  });

  const tenantMap = useMemo(() => {
    const map: Record<string, string> = {};
    tenants?.forEach((t) => (map[t.id] = t.name));
    return map;
  }, [tenants]);

  const stats = useMemo(() => {
    if (!followUps) return { sent: 0, confirmed: 0, pending: 0, expired: 0 };
    return {
      sent: followUps.filter((f) => f.status === "sent").length,
      confirmed: followUps.filter((f) => f.status === "confirmed").length,
      pending: followUps.filter((f) => f.status === "pending").length,
      expired: followUps.filter((f) => f.status === "expired" || (f.status === "pending" && new Date(f.follow_up_at) < new Date())).length,
    };
  }, [followUps]);

  const perTenant = useMemo(() => {
    if (!followUps) return [];
    const map: Record<string, { sent: number; confirmed: number; pending: number; expired: number }> = {};
    followUps.forEach((f) => {
      if (!map[f.tenant_id]) map[f.tenant_id] = { sent: 0, confirmed: 0, pending: 0, expired: 0 };
      const bucket = map[f.tenant_id];
      if (f.status === "sent") bucket.sent++;
      else if (f.status === "confirmed") bucket.confirmed++;
      else if (f.status === "expired" || (f.status === "pending" && new Date(f.follow_up_at) < new Date())) bucket.expired++;
      else if (f.status === "pending") bucket.pending++;
    });
    return Object.entries(map)
      .map(([tid, counts]) => ({
        tenantId: tid,
        tenantName: tenantMap[tid] || tid.slice(0, 8),
        ...counts,
        total: counts.sent + counts.confirmed + counts.pending + counts.expired,
        rate: counts.sent + counts.confirmed > 0 ? Math.round((counts.confirmed / (counts.sent + counts.confirmed)) * 100) : 0,
      }))
      .sort((a, b) => b.total - a.total);
  }, [followUps, tenantMap]);

  const statCards = [
    { label: "Enviados", value: stats.sent, icon: Send, color: "text-primary" },
    { label: "Confirmados", value: stats.confirmed, icon: CheckCircle2, color: "text-accent" },
    { label: "Pendentes", value: stats.pending, icon: Clock, color: "text-yellow-500" },
    { label: "Expirados", value: stats.expired, icon: XCircle, color: "text-destructive" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Follow-ups</h2>
          <p className="text-muted-foreground mt-1">Acompanhe o status dos follow-ups de todos os projetos</p>
        </div>
        <Select value={period} onValueChange={(v) => setPeriod(v as any)}>
          <SelectTrigger className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7d">Últimos 7 dias</SelectItem>
            <SelectItem value="30d">Últimos 30 dias</SelectItem>
            <SelectItem value="all">Todos</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((stat) => (
          <div key={stat.label} className="glass-card p-5 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{stat.label}</span>
              <stat.icon className={`w-5 h-5 ${stat.color}`} />
            </div>
            {loadingFU ? (
              <Skeleton className="h-9 w-16" />
            ) : (
              <p className="text-3xl font-bold text-foreground">{stat.value}</p>
            )}
          </div>
        ))}
      </div>

      {/* Per-tenant table */}
      <div className="glass-card overflow-hidden">
        <div className="p-5 border-b border-border">
          <h3 className="font-semibold text-foreground">Por Projeto</h3>
        </div>
        {loadingFU ? (
          <div className="p-6 space-y-4">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : perTenant.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground">
            <Building2 className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p>Nenhum follow-up registrado no período</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Projeto</th>
                  <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider text-center">Enviados</th>
                  <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider text-center">Confirmados</th>
                  <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider text-center">Pendentes</th>
                  <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider text-center">Expirados</th>
                  <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider text-center">Taxa</th>
                </tr>
              </thead>
              <tbody>
                {perTenant.map((row, idx) => (
                  <tr key={row.tenantId} className={`hover:bg-muted/30 transition-colors ${idx % 2 === 1 ? "bg-muted/10" : ""}`}>
                    <td className="p-4 font-medium text-foreground">{row.tenantName}</td>
                    <td className="p-4 text-center text-sm text-muted-foreground">{row.sent}</td>
                    <td className="p-4 text-center text-sm text-accent">{row.confirmed}</td>
                    <td className="p-4 text-center text-sm text-yellow-500">{row.pending}</td>
                    <td className="p-4 text-center text-sm text-destructive">{row.expired}</td>
                    <td className="p-4 text-center text-sm font-medium text-foreground">{row.rate}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
