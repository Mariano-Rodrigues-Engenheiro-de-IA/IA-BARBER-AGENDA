import { useState, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenant } from "@/hooks/useTenants";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Users, MessageSquare, CalendarCheck, Link2, Send, CheckCircle2, Kanban, DollarSign, Receipt } from "lucide-react";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid } from "recharts";
import { getBookingId, getBookingValue, buildServicePriceMap } from "@/lib/booking";

const fmtBRL = (n: number) =>
  n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });

export default function TenantDashboardPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [period, setPeriod] = useState<"7d" | "30d">("30d");
  const { data: tenant, isLoading: loadingTenant } = useTenant(id);

  const days = period === "7d" ? 7 : 30;
  const since = new Date(Date.now() - days * 86400000).toISOString();

  // Chat messages for this tenant
  const { data: messages, isLoading: loadingMsgs } = useQuery({
    queryKey: ["tenant-dashboard-messages", id, period],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("chat_messages")
        .select("id, phone_number, role, created_at")
        .eq("tenant_id", id!)
        .gte("created_at", since)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data;
    },
    enabled: !!id,
  });

  // Agent logs for tool_calls analysis
  const { data: agentLogs, isLoading: loadingLogs } = useQuery({
    queryKey: ["tenant-dashboard-logs", id, period],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("agent_logs")
        .select("id, tool_calls, created_at")
        .eq("tenant_id", id!)
        .gte("created_at", since);
      if (error) throw error;
      return data;
    },
    enabled: !!id,
  });

  // Follow-ups
  const { data: followUps, isLoading: loadingFU } = useQuery({
    queryKey: ["tenant-dashboard-followups", id, period],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("follow_ups")
        .select("id, status")
        .eq("tenant_id", id!)
        .gte("created_at", since);
      if (error) throw error;
      return data;
    },
    enabled: !!id,
  });

  // All-time logs para ticket médio fixo
  const { data: allTimeLogs } = useQuery({
    queryKey: ["tenant-dashboard-logs-alltime", id],
    enabled: !!id,
    queryFn: async () => {
      const all: any[] = [];
      let from = 0;
      const pageSize = 1000;
      while (true) {
        const { data, error } = await supabase.from("agent_logs")
          .select("tool_calls")
          .eq("tenant_id", id!)
          .range(from, from + pageSize - 1);
        if (error) break;
        all.push(...(data ?? []));
        if (!data || data.length < pageSize) break;
        from += pageSize;
      }
      return all;
    },
  });

  const isLoading = loadingTenant || loadingMsgs || loadingLogs || loadingFU;

  const stats = useMemo(() => {
    const uniqueClients = new Set(messages?.filter((m) => m.role === "user").map((m) => m.phone_number)).size;
    const totalMessages = messages?.length ?? 0;

    const priceMap = buildServicePriceMap(agentLogs ?? []);
    let linksSent = 0;
    const bookingValues = new Map<string, number>();
    agentLogs?.forEach((log) => {
      const tools = log.tool_calls as any[];
      if (!Array.isArray(tools)) return;
      tools.forEach((tc: any) => {
        const bid = getBookingId(tc);
        if (bid && !bookingValues.has(bid)) bookingValues.set(bid, getBookingValue(tc, priceMap));
        if (tc.name === "enviar_link_agendamento") linksSent++;
      });
    });
    const bookings = bookingValues.size;
    let revenue = 0;
    bookingValues.forEach((v) => (revenue += v));

    const fuSent = followUps?.filter((f) => f.status === "sent").length ?? 0;
    const fuConfirmed = followUps?.filter((f) => f.status === "confirmed").length ?? 0;

    return { uniqueClients, totalMessages, bookings, revenue, linksSent, fuSent, fuConfirmed };
  }, [messages, agentLogs, followUps]);

  // Chart: messages per day
  const chartData = useMemo(() => {
    if (!messages?.length) return [];
    const map: Record<string, number> = {};
    // Initialize all days
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const key = d.toISOString().slice(0, 10);
      map[key] = 0;
    }
    messages.forEach((m) => {
      const key = m.created_at.slice(0, 10);
      if (map[key] !== undefined) map[key]++;
    });
    return Object.entries(map).map(([date, count]) => ({
      date: date.slice(5), // MM-DD
      mensagens: count,
    }));
  }, [messages, days]);

  // Ticket médio fixo — todo o histórico, não depende do filtro de período
  const ticketMedio = useMemo(() => {
    const logs = allTimeLogs ?? [];
    const pm = buildServicePriceMap(logs);
    const seen = new Map<string, number>();
    logs.forEach((l: any) => {
      const tools = Array.isArray(l.tool_calls) ? l.tool_calls : [];
      tools.forEach((tc: any) => {
        const id = getBookingId(tc);
        if (!id || seen.has(id)) return;
        seen.set(id, getBookingValue(tc, pm));
      });
    });
    let revenue = 0;
    seen.forEach((v) => (revenue += v));
    return seen.size > 0 ? revenue / seen.size : 0;
  }, [allTimeLogs]);

  const chartConfig: ChartConfig = {
    mensagens: { label: "Mensagens", color: "hsl(var(--primary))" },
  };

  const statCards = [
    { label: "Faturamento", value: fmtBRL(stats.revenue), icon: DollarSign, color: "text-emerald-400" },
    { label: "Agendamentos", value: stats.bookings, icon: CalendarCheck, color: "text-emerald-400" },
    { label: "Ticket Médio", value: fmtBRL(ticketMedio), icon: Receipt, color: "text-emerald-400" },
    { label: "Clientes Atendidos", value: stats.uniqueClients, icon: Users, color: "text-primary" },
    { label: "Mensagens Trocadas", value: stats.totalMessages, icon: MessageSquare, color: "text-accent" },
    { label: "Links Enviados", value: stats.linksSent, icon: Link2, color: "text-yellow-500" },
    { label: "Follow-ups Enviados", value: stats.fuSent, icon: Send, color: "text-primary" },
    { label: "Follow-ups Confirmados", value: stats.fuConfirmed, icon: CheckCircle2, color: "text-accent" },
  ];

  if (loadingTenant) {
    return <div className="text-muted-foreground">Carregando...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate(`/tenants/${id}`)}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div>
            <h2 className="text-2xl font-bold text-foreground">{tenant?.name}</h2>
            <p className="text-muted-foreground mt-1">Dashboard de métricas</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => navigate(`/tenants/${id}/kanban`)}>
            <Kanban className="w-4 h-4 mr-2" />
            CRM Kanban
          </Button>
          <Select value={period} onValueChange={(v) => setPeriod(v as any)}>
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7d">Últimos 7 dias</SelectItem>
              <SelectItem value="30d">Últimos 30 dias</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
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

      {/* Activity chart */}
      <div className="glass-card p-6 space-y-4">
        <h3 className="font-semibold text-foreground">Atividade de Mensagens</h3>
        {isLoading ? (
          <Skeleton className="h-[300px] w-full" />
        ) : chartData.length > 0 ? (
          <ChartContainer config={chartConfig} className="h-[300px] w-full">
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
              <XAxis dataKey="date" className="text-xs" tick={{ fill: "hsl(var(--muted-foreground))" }} />
              <YAxis className="text-xs" tick={{ fill: "hsl(var(--muted-foreground))" }} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="mensagens" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ChartContainer>
        ) : (
          <div className="h-[300px] flex items-center justify-center text-muted-foreground">
            Sem dados no período
          </div>
        )}
      </div>
    </div>
  );
}
