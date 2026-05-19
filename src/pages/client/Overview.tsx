import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Users, MessageSquare, Send, TrendingUp, CalendarCheck, Link2, Bot, UserCheck } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
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

export default function ClientOverview() {
  const { tenantId } = useAuth();
  const [period, setPeriod] = useState<"7d" | "30d">("30d");
  const days = period === "7d" ? 7 : 30;
  const since = useMemo(() => new Date(Date.now() - days * 86400000).toISOString(), [days]);

  // Top 4 cards (last 24h, kept as-is)
  const sinceDay = new Date(Date.now() - 86400000).toISOString();
  const { data: topData } = useQuery({
    queryKey: ["client-overview-top", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const [leads, msgs, sent, all] = await Promise.all([
        supabase.from("crm_leads").select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId!).gte("created_at", sinceDay),
        supabase.from("chat_messages").select("phone_number")
          .eq("tenant_id", tenantId!).gte("created_at", sinceDay),
        supabase.from("follow_ups").select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId!).eq("status", "sent").gte("sent_at", sinceDay),
        supabase.from("follow_ups").select("status")
          .eq("tenant_id", tenantId!).gte("created_at", sinceDay),
      ]);
      const activePhones = new Set((msgs.data ?? []).map((m: any) => m.phone_number)).size;
      const total = (all.data ?? []).length;
      const responded = (all.data ?? []).filter((f: any) => f.status === "confirmed").length;
      const rate = total ? Math.round((responded / total) * 100) : 0;
      return { newLeads: leads.count ?? 0, activePhones, sent: sent.count ?? 0, rate };
    },
  });

  // Period-based data for charts
  const { data: messages, isLoading: loadingMsgs } = useQuery({
    queryKey: ["client-ov-msgs", tenantId, period],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data } = await supabase.from("chat_messages")
        .select("phone_number, role, created_at")
        .eq("tenant_id", tenantId!).gte("created_at", since)
        .order("created_at");
      return data ?? [];
    },
  });

  const { data: agentLogs } = useQuery({
    queryKey: ["client-ov-logs", tenantId, period],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data } = await supabase.from("agent_logs")
        .select("tool_calls, created_at")
        .eq("tenant_id", tenantId!).gte("created_at", since);
      return data ?? [];
    },
  });

  const { data: followUps } = useQuery({
    queryKey: ["client-ov-fu", tenantId, period],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data } = await supabase.from("follow_ups")
        .select("status, created_at, sent_at, confirmed_at")
        .eq("tenant_id", tenantId!).gte("created_at", since);
      return data ?? [];
    },
  });

  // Tangible AI cards
  const aiStats = useMemo(() => {
    let bookings = 0, links = 0;
    (agentLogs ?? []).forEach((l: any) => {
      const tools = Array.isArray(l.tool_calls) ? l.tool_calls : [];
      tools.forEach((tc: any) => {
        if (["criar_agendamento", "agendar"].includes(tc?.name) && !tc?.blocked) bookings++;
        if (tc?.name === "enviar_link_agendamento") links++;
      });
    });
    const aiMessages = (messages ?? []).filter((m: any) => m.role === "assistant").length;
    const uniqueClients = new Set((messages ?? []).filter((m: any) => m.role === "user").map((m: any) => m.phone_number)).size;
    return { bookings, links, aiMessages, uniqueClients };
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

  // Bookings & links per day
  const toolDaily = useMemo(() => {
    const map: Record<string, { date: string; agendamentos: number; links: number }> = {};
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      map[d] = { date: d.slice(5), agendamentos: 0, links: 0 };
    }
    (agentLogs ?? []).forEach((l: any) => {
      const k = l.created_at.slice(0, 10);
      if (!map[k]) return;
      const tools = Array.isArray(l.tool_calls) ? l.tool_calls : [];
      tools.forEach((tc: any) => {
        if (["criar_agendamento", "agendar"].includes(tc?.name) && !tc?.blocked) map[k].agendamentos++;
        if (tc?.name === "enviar_link_agendamento") map[k].links++;
      });
    });
    return Object.values(map);
  }, [agentLogs, days]);

  // Hour distribution
  const hourData = useMemo(() => {
    const arr = Array.from({ length: 24 }, (_, h) => ({ hora: `${h}h`, mensagens: 0 }));
    (messages ?? []).forEach((m: any) => {
      const h = new Date(m.created_at).getHours();
      arr[h].mensagens++;
    });
    return arr;
  }, [messages]);

  // Top 5 clients
  const topClients = useMemo(() => {
    const counts: Record<string, number> = {};
    (messages ?? []).forEach((m: any) => { counts[m.phone_number] = (counts[m.phone_number] || 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([phone, count]) => ({ phone: phone.slice(-6), mensagens: count }));
  }, [messages]);

  // Funnel
  const funnel = useMemo(() => {
    const conversas = new Set((messages ?? []).filter((m: any) => m.role === "user").map((m: any) => m.phone_number)).size;
    const confirmedFU = (followUps ?? []).filter((f: any) => f.status === "confirmed").length;
    return [
      { etapa: "Conversas", valor: conversas },
      { etapa: "Links", valor: aiStats.links },
      { etapa: "Agendamentos", valor: aiStats.bookings },
      { etapa: "Follow-ups OK", valor: confirmedFU },
    ];
  }, [messages, aiStats, followUps]);

  // Follow-up status pie
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
    links: { label: "Links", color: "hsl(45 95% 55%)" },
    mensagens: { label: "Mensagens", color: "hsl(var(--primary))" },
    valor: { label: "Total", color: "hsl(var(--primary))" },
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Visão Geral</h1>
          <p className="text-muted-foreground">Resumo das últimas 24 horas + análises do período</p>
        </div>
        <Select value={period} onValueChange={(v) => setPeriod(v as any)}>
          <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="7d">Últimos 7 dias</SelectItem>
            <SelectItem value="30d">Últimos 30 dias</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Top 4 cards (24h) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={Users} label="Novos leads (24h)" value={topData?.newLeads ?? "—"} />
        <StatCard icon={MessageSquare} label="Conversas ativas (24h)" value={topData?.activePhones ?? "—"} />
        <StatCard icon={Send} label="Follow-ups enviados (24h)" value={topData?.sent ?? "—"} />
        <StatCard icon={TrendingUp} label="Taxa de resposta (24h)" value={`${topData?.rate ?? 0}%`} />
      </div>

      {/* AI tangible cards (period) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={CalendarCheck} label={`Agendamentos (${days}d)`} value={aiStats.bookings} color="text-emerald-400" />
        <StatCard icon={Link2} label={`Links enviados (${days}d)`} value={aiStats.links} color="text-yellow-500" />
        <StatCard icon={Bot} label={`Respostas da IA (${days}d)`} value={aiStats.aiMessages} color="text-accent" />
        <StatCard icon={UserCheck} label={`Clientes atendidos (${days}d)`} value={aiStats.uniqueClients} color="text-primary" />
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
          <h3 className="font-semibold text-foreground">Agendamentos e links por dia</h3>
          <ChartContainer config={chartConfig} className="h-[260px] w-full">
            <BarChart data={toolDaily}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
              <XAxis dataKey="date" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
              <YAxis tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="agendamentos" fill="hsl(160 70% 45%)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="links" fill="hsl(45 95% 55%)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ChartContainer>
        </div>

        <div className="glass-card p-5 space-y-3">
          <h3 className="font-semibold text-foreground">Funil de conversão</h3>
          <ChartContainer config={chartConfig} className="h-[260px] w-full">
            <BarChart data={funnel} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
              <XAxis type="number" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
              <YAxis type="category" dataKey="etapa" width={110} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="valor" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ChartContainer>
        </div>

        <div className="glass-card p-5 space-y-3">
          <h3 className="font-semibold text-foreground">Mensagens por hora</h3>
          <ChartContainer config={chartConfig} className="h-[260px] w-full">
            <BarChart data={hourData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
              <XAxis dataKey="hora" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} interval={2} />
              <YAxis tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="mensagens" fill="hsl(280 70% 60%)" radius={[4, 4, 0, 0]} />
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
                <YAxis type="category" dataKey="phone" width={70} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
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
