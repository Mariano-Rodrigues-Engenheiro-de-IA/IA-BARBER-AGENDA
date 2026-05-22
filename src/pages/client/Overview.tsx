import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Send, CalendarCheck, Bot, UserCheck } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  PieChart, Pie, Cell, Legend,
} from "recharts";

function StatCard({ icon: Icon, label, value, color = "text-primary" }: any) {
  return (
    <div className="glass-card p-5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-muted-foreground">{label}</span>
        <Icon className={`w-4 h-4 ${color}`} />
      </div>
      <div className="text-2xl font-bold text-foreground">{value}</div>
    </div>
  );
}

type Period = "7d" | "14d" | "30d";

export default function ClientOverview() {
  const { tenantId } = useAuth();
  const [period, setPeriod] = useState<Period>("30d");
  const days = period === "7d" ? 7 : period === "14d" ? 14 : 30;

  // Period-based data for charts
  const { data: messages } = useQuery({
    queryKey: ["client-ov-msgs", tenantId, period],
    enabled: !!tenantId,
    refetchInterval: 30000,
    queryFn: async () => {
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const all: any[] = [];
      let from = 0;
      const pageSize = 1000;
      while (true) {
        const { data, error } = await supabase.from("chat_messages")
          .select("phone_number, role, created_at")
          .eq("tenant_id", tenantId!).gte("created_at", since)
          .order("created_at", { ascending: true })
          .range(from, from + pageSize - 1);
        if (error) break;
        all.push(...(data ?? []));
        if (!data || data.length < pageSize) break;
        from += pageSize;
      }
      return all;
    },
  });

  const { data: agentLogs } = useQuery({
    queryKey: ["client-ov-logs", tenantId, period],
    enabled: !!tenantId,
    refetchInterval: 30000,
    queryFn: async () => {
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const all: any[] = [];
      let from = 0;
      const pageSize = 1000;
      while (true) {
        const { data, error } = await supabase.from("agent_logs")
          .select("tool_calls, created_at")
          .eq("tenant_id", tenantId!).gte("created_at", since)
          .range(from, from + pageSize - 1);
        if (error) break;
        all.push(...(data ?? []));
        if (!data || data.length < pageSize) break;
        from += pageSize;
      }
      return all;
    },
  });

  const { data: followUps } = useQuery({
    queryKey: ["client-ov-fu", tenantId, period],
    enabled: !!tenantId,
    refetchInterval: 30000,
    queryFn: async () => {
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const { data } = await supabase.from("follow_ups")
        .select("status, created_at, sent_at, confirmed_at")
        .eq("tenant_id", tenantId!).gte("created_at", since);
      return data ?? [];
    },
  });

  // Follow-ups effectively sent (sent_at present) — includes converted ones too
  const { data: followUpsSent } = useQuery({
    queryKey: ["client-ov-fu-sent", tenantId, period],
    enabled: !!tenantId,
    refetchInterval: 30000,
    queryFn: async () => {
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const { count } = await supabase.from("follow_ups")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId!)
        .not("sent_at", "is", null)
        .gte("sent_at", since);
      return count ?? 0;
    },
  });

  // Helper: is this tool_call a successful appointment creation?
  const isSuccessfulBooking = (tc: any): string | null => {
    if (!tc || tc.blocked) return null;
    if (!["criar_agendamento", "agendar"].includes(tc.name)) return null;
    const r = tc.result;
    if (!r || typeof r !== "object") return null;
    if (Array.isArray(r.Errors) && r.Errors.length > 0) return null;
    if (r.deduplicated) return null;
    if (r.error) return null;
    const id = r.id ?? r.agendamento_id ?? r.appointment_id;
    return id != null ? String(id) : null;
  };

  // Tangible AI cards
  const aiStats = useMemo(() => {
    const bookingIds = new Set<string>();
    (agentLogs ?? []).forEach((l: any) => {
      const tools = Array.isArray(l.tool_calls) ? l.tool_calls : [];
      tools.forEach((tc: any) => {
        const id = isSuccessfulBooking(tc);
        if (id) bookingIds.add(id);
      });
    });
    const aiMessages = (messages ?? []).filter((m: any) => m.role === "assistant").length;
    const uniqueClients = new Set((messages ?? []).filter((m: any) => m.role === "user").map((m: any) => m.phone_number)).size;
    return { bookings: bookingIds.size, aiMessages, uniqueClients };
  }, [agentLogs, messages]);

  // Activity chart
  const activityData = useMemo(() => {
    const map: Record<string, { date: string; cliente: number; ia: number }> = {};
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      map[d] = { date: d.slice(5), cliente: 0, ia: 0 };
    }
    (messages ?? []).forEach((m: any) => {
      const k = m.created_at.slice(0, 10);
      if (!map[k]) return;
      if (m.role === "user") map[k].cliente++;
      else if (m.role === "assistant") map[k].ia++;
    });
    return Object.values(map);
  }, [messages, days]);

  const toolDaily = useMemo(() => {
    const map: Record<string, { date: string; agendamentos: number; ids: Set<string> }> = {};
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      map[d] = { date: d.slice(5), agendamentos: 0, ids: new Set() };
    }
    (agentLogs ?? []).forEach((l: any) => {
      const k = l.created_at.slice(0, 10);
      if (!map[k]) return;
      const tools = Array.isArray(l.tool_calls) ? l.tool_calls : [];
      tools.forEach((tc: any) => {
        const id = isSuccessfulBooking(tc);
        if (id && !map[k].ids.has(id)) {
          map[k].ids.add(id);
          map[k].agendamentos++;
        }
      });
    });
    return Object.values(map).map(({ date, agendamentos }) => ({ date, agendamentos }));
  }, [agentLogs, days]);

  const topClients = useMemo(() => {
    const counts: Record<string, number> = {};
    (messages ?? []).forEach((m: any) => { counts[m.phone_number] = (counts[m.phone_number] || 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([phone, count]) => ({ phone, mensagens: count }));
  }, [messages]);

  const fuStatus = useMemo(() => {
    const counts: Record<string, number> = {};
    (followUps ?? []).forEach((f: any) => { counts[f.status] = (counts[f.status] || 0) + 1; });
    const colors: Record<string, string> = {
      pending: "hsl(var(--primary))",
      sent: "hsl(45 95% 55%)",
      confirmed: "hsl(160 70% 45%)",
      cancelled: "hsl(0 70% 55%)",
      expired: "hsl(0 0% 50%)",
    };
    const labels: Record<string, string> = {
      pending: "Pendente", sent: "Enviado", confirmed: "Confirmado",
      cancelled: "Cancelado", expired: "Expirado",
    };
    return Object.entries(counts).map(([k, v]) => ({ name: labels[k] || k, value: v, fill: colors[k] || "hsl(var(--muted-foreground))" }));
  }, [followUps]);

  const chartConfig: ChartConfig = {
    cliente: { label: "Cliente", color: "hsl(var(--primary))" },
    ia: { label: "IA", color: "hsl(160 70% 45%)" },
    agendamentos: { label: "Agendamentos", color: "hsl(160 70% 45%)" },
    mensagens: { label: "Mensagens", color: "hsl(var(--primary))" },
    valor: { label: "Total", color: "hsl(var(--primary))" },
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Visão Geral</h1>
          <p className="text-muted-foreground">Análises do período selecionado</p>
        </div>
        <Select value={period} onValueChange={(v) => setPeriod(v as Period)}>
          <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="7d">Últimos 7 dias</SelectItem>
            <SelectItem value="14d">Últimos 14 dias</SelectItem>
            <SelectItem value="30d">Últimos 30 dias</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Top 4 cards (período) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={Send} label={`Follow-ups enviados (${days}d)`} value={followUpsSent ?? "—"} />
        <StatCard icon={CalendarCheck} label={`Agendamentos (${days}d)`} value={aiStats.bookings} color="text-accent" />
        <StatCard icon={Bot} label={`Respostas da IA (${days}d)`} value={aiStats.aiMessages} color="text-primary" />
        <StatCard icon={UserCheck} label={`Clientes atendidos (${days}d)`} value={aiStats.uniqueClients} color="text-warning" />
      </div>

      {/* Charts grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="glass-card p-5 space-y-3">
          <h3 className="font-semibold text-foreground">Atividade diária</h3>
          <ChartContainer config={chartConfig} className="h-[260px] w-full">
            <AreaChart data={activityData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
              <XAxis dataKey="date" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
              <YAxis tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Area type="monotone" dataKey="cliente" stackId="1" stroke="hsl(var(--primary))" fill="hsl(var(--primary) / 0.35)" />
              <Area type="monotone" dataKey="ia" stackId="1" stroke="hsl(160 70% 45%)" fill="hsl(160 70% 45% / 0.35)" />
            </AreaChart>
          </ChartContainer>
        </div>

        <div className="glass-card p-5 space-y-3">
          <h3 className="font-semibold text-foreground">Agendamentos por dia</h3>
          <ChartContainer config={chartConfig} className="h-[260px] w-full">
            <BarChart data={toolDaily}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
              <XAxis dataKey="date" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
              <YAxis tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="agendamentos" fill="hsl(160 70% 45%)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ChartContainer>
        </div>

        <div className="glass-card p-5 space-y-3">
          <h3 className="font-semibold text-foreground">Top 5 clientes mais ativos</h3>
          {topClients.length === 0 ? (
            <div className="h-[260px] flex items-center justify-center text-muted-foreground text-sm">Sem dados</div>
          ) : (
            <ChartContainer config={chartConfig} className="h-[260px] w-full">
              <BarChart data={topClients} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
                <XAxis type="number" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
                <YAxis type="category" dataKey="phone" width={120} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="mensagens" fill="hsl(200 80% 55%)" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ChartContainer>
          )}
        </div>

        <div className="glass-card p-5 space-y-3">
          <h3 className="font-semibold text-foreground">Status dos follow-ups</h3>
          {fuStatus.length === 0 ? (
            <div className="h-[260px] flex items-center justify-center text-muted-foreground text-sm">Sem dados</div>
          ) : (
            <ChartContainer config={chartConfig} className="h-[260px] w-full">
              <PieChart>
                <Pie data={fuStatus} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={50} outerRadius={90} paddingAngle={2}>
                  {fuStatus.map((s, i) => <Cell key={i} fill={s.fill} />)}
                </Pie>
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <ChartTooltip content={<ChartTooltipContent />} />
              </PieChart>
            </ChartContainer>
          )}
        </div>
      </div>
    </div>
  );
}
