import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Send, CalendarCheck, Bot, UserCheck, DollarSign, Receipt, CalendarIcon } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Button } from "@/components/ui/button";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { getBookingId, getBookingValue, buildServicePriceMap } from "@/lib/booking";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import type { DateRange } from "react-day-picker";
import { cn } from "@/lib/utils";

const fmtBRL = (n: number) =>
  n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
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

type Period = "today" | "7d" | "14d" | "30d" | "custom";

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function endOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

export default function ClientOverview() {
  const { tenantId } = useAuth();
  const [period, setPeriod] = useState<Period>("30d");
  const [customRange, setCustomRange] = useState<DateRange | undefined>();

  const { since, until, bucketDates, periodLabel, days } = useMemo(() => {
    const now = new Date();
    let startD: Date;
    let endD: Date = endOfDay(now);
    if (period === "today") {
      startD = startOfDay(now);
    } else if (period === "custom" && customRange?.from) {
      startD = startOfDay(customRange.from);
      endD = endOfDay(customRange.to ?? customRange.from);
    } else {
      const n = period === "7d" ? 7 : period === "14d" ? 14 : 30;
      startD = startOfDay(new Date(now.getTime() - (n - 1) * 86400000));
    }
    const buckets: string[] = [];
    const cur = new Date(startD);
    while (cur <= endD) {
      buckets.push(cur.toISOString().slice(0, 10));
      cur.setDate(cur.getDate() + 1);
    }
    const dayCount = buckets.length;
    const label =
      period === "today" ? "hoje" :
      period === "custom" && customRange?.from
        ? (customRange.to && customRange.to.toDateString() !== customRange.from.toDateString()
            ? `${format(customRange.from, "dd/MM")} – ${format(customRange.to, "dd/MM")}`
            : format(customRange.from, "dd/MM"))
        : `${dayCount}d`;
    return {
      since: startD.toISOString(),
      until: endD.toISOString(),
      bucketDates: buckets,
      periodLabel: label,
      days: dayCount,
    };
  }, [period, customRange]);

  const queryKeyPart = [tenantId, period, since, until] as const;

  const { data: messages } = useQuery({
    queryKey: ["client-ov-msgs", ...queryKeyPart],
    enabled: !!tenantId && !(period === "custom" && !customRange?.from),
    refetchInterval: 30000,
    queryFn: async () => {
      const all: any[] = [];
      let from = 0;
      const pageSize = 1000;
      while (true) {
        const { data, error } = await supabase.from("chat_messages")
          .select("phone_number, role, created_at, content")
          .eq("tenant_id", tenantId!)
          .gte("created_at", since)
          .lte("created_at", until)
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
    queryKey: ["client-ov-logs", ...queryKeyPart],
    enabled: !!tenantId && !(period === "custom" && !customRange?.from),
    refetchInterval: 30000,
    queryFn: async () => {
      const all: any[] = [];
      let from = 0;
      const pageSize = 1000;
      while (true) {
        const { data, error } = await supabase.from("agent_logs")
          .select("tool_calls, created_at")
          .eq("tenant_id", tenantId!)
          .gte("created_at", since)
          .lte("created_at", until)
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
    queryKey: ["client-ov-fu", ...queryKeyPart],
    enabled: !!tenantId && !(period === "custom" && !customRange?.from),
    refetchInterval: 30000,
    queryFn: async () => {
      const { data } = await supabase.from("follow_ups")
        .select("status, created_at, sent_at, confirmed_at")
        .eq("tenant_id", tenantId!)
        .gte("created_at", since)
        .lte("created_at", until);
      return data ?? [];
    },
  });

  const { data: followUpsSent } = useQuery({
    queryKey: ["client-ov-fu-sent", ...queryKeyPart],
    enabled: !!tenantId && !(period === "custom" && !customRange?.from),
    refetchInterval: 30000,
    queryFn: async () => {
      const { count } = await supabase.from("follow_ups")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId!)
        .not("sent_at", "is", null)
        .gte("sent_at", since)
        .lte("sent_at", until);
      return count ?? 0;
    },
  });

  const isSuccessfulBooking = getBookingId;
  const priceMap = useMemo(() => buildServicePriceMap(agentLogs ?? []), [agentLogs]);

  const aiStats = useMemo(() => {
    const seen = new Map<string, number>();
    (agentLogs ?? []).forEach((l: any) => {
      const tools = Array.isArray(l.tool_calls) ? l.tool_calls : [];
      tools.forEach((tc: any) => {
        const id = isSuccessfulBooking(tc);
        if (!id || seen.has(id)) return;
        seen.set(id, getBookingValue(tc, priceMap));
      });
    });
    let revenue = 0;
    seen.forEach((v) => (revenue += v));
    // "Respostas da IA" = apenas mensagens realmente geradas pela IA.
    // Excluímos as mensagens digitadas manualmente pelo atendente humano
    // (prefixadas com "[ATENDENTE HUMANO]:"), pra bater com a auditoria.
    const HUMAN_PREFIX = "[ATENDENTE HUMANO]:";
    const isRealAi = (m: any) =>
      m.role === "assistant" && !(typeof m.content === "string" && m.content.startsWith(HUMAN_PREFIX));
    const aiMessages = (messages ?? []).filter(isRealAi).length;
    // "Clientes atendidos" = telefones únicos que receberam ao menos uma
    // resposta real da IA no período. Clientes que só falaram com o atendente
    // humano (ou que nem foram respondidos) não entram aqui.
    const uniqueClients = new Set(
      (messages ?? []).filter(isRealAi).map((m: any) => m.phone_number)
    ).size;
    return { bookings: seen.size, revenue, aiMessages, uniqueClients };
  }, [agentLogs, messages, priceMap]);

  const activityData = useMemo(() => {
    const HUMAN_PREFIX = "[ATENDENTE HUMANO]:";
    const map: Record<string, { date: string; cliente: number; ia: number }> = {};
    bucketDates.forEach((d) => {
      map[d] = { date: d.slice(5), cliente: 0, ia: 0 };
    });
    (messages ?? []).forEach((m: any) => {
      const k = m.created_at.slice(0, 10);
      if (!map[k]) return;
      if (m.role === "user") map[k].cliente++;
      else if (m.role === "assistant" && !(typeof m.content === "string" && m.content.startsWith(HUMAN_PREFIX))) map[k].ia++;
    });
    return Object.values(map);
  }, [messages, bucketDates]);

  const toolDaily = useMemo(() => {
    const map: Record<string, { date: string; agendamentos: number; faturamento: number; ids: Set<string> }> = {};
    bucketDates.forEach((d) => {
      map[d] = { date: d.slice(5), agendamentos: 0, faturamento: 0, ids: new Set() };
    });
    (agentLogs ?? []).forEach((l: any) => {
      const k = l.created_at.slice(0, 10);
      if (!map[k]) return;
      const tools = Array.isArray(l.tool_calls) ? l.tool_calls : [];
      tools.forEach((tc: any) => {
        const id = isSuccessfulBooking(tc);
        if (id && !map[k].ids.has(id)) {
          map[k].ids.add(id);
          map[k].agendamentos++;
          map[k].faturamento += getBookingValue(tc, priceMap);
        }
      });
    });
    return Object.values(map).map(({ date, agendamentos, faturamento }) => ({ date, agendamentos, faturamento: Math.round(faturamento) }));
  }, [agentLogs, bucketDates, priceMap]);

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
    faturamento: { label: "Faturamento (R$)", color: "hsl(45 95% 55%)" },
    mensagens: { label: "Mensagens", color: "hsl(var(--primary))" },
    valor: { label: "Total", color: "hsl(var(--primary))" },
  };

  const customLabel = customRange?.from
    ? customRange.to && customRange.to.toDateString() !== customRange.from.toDateString()
      ? `${format(customRange.from, "dd/MM/yy", { locale: ptBR })} – ${format(customRange.to, "dd/MM/yy", { locale: ptBR })}`
      : format(customRange.from, "dd/MM/yy", { locale: ptBR })
    : "Selecionar datas";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Visão Geral</h1>
          <p className="text-muted-foreground">Análises do período selecionado</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Select value={period} onValueChange={(v) => setPeriod(v as Period)}>
            <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="today">Hoje</SelectItem>
              <SelectItem value="7d">Últimos 7 dias</SelectItem>
              <SelectItem value="14d">Últimos 14 dias</SelectItem>
              <SelectItem value="30d">Últimos 30 dias</SelectItem>
              <SelectItem value="custom">Personalizado</SelectItem>
            </SelectContent>
          </Select>
          {period === "custom" && (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn("justify-start text-left font-normal", !customRange?.from && "text-muted-foreground")}
                >
                  <CalendarIcon className="w-4 h-4 mr-2" />
                  {customLabel}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="end">
                <Calendar
                  mode="range"
                  selected={customRange}
                  onSelect={setCustomRange}
                  numberOfMonths={2}
                  locale={ptBR}
                  initialFocus
                  className={cn("p-3 pointer-events-auto")}
                />
              </PopoverContent>
            </Popover>
          )}
        </div>
      </div>

      {period === "custom" && !customRange?.from && (
        <div className="glass-card p-6 text-center text-muted-foreground text-sm">
          Selecione um intervalo de datas para ver as métricas.
        </div>
      )}

      {/* Top cards (período) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <StatCard icon={DollarSign} label={`Faturamento (${periodLabel})`} value={fmtBRL(aiStats.revenue)} color="text-emerald-400" />
        <StatCard icon={CalendarCheck} label={`Agendamentos (${periodLabel})`} value={aiStats.bookings} color="text-accent" />
        <StatCard icon={Receipt} label={`Ticket médio (${periodLabel})`} value={aiStats.bookings > 0 ? fmtBRL(aiStats.revenue / aiStats.bookings) : fmtBRL(0)} color="text-emerald-400" />
        <StatCard icon={Send} label={`Follow-ups enviados (${periodLabel})`} value={followUpsSent ?? "—"} />
        <StatCard icon={Bot} label={`Respostas da IA (${periodLabel})`} value={aiStats.aiMessages} color="text-primary" />
        <StatCard icon={UserCheck} label={`Clientes atendidos (${periodLabel})`} value={aiStats.uniqueClients} color="text-warning" />
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
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-foreground">Faturamento por dia</h3>
            <span className="text-xs text-muted-foreground">Total: {fmtBRL(aiStats.revenue)}</span>
          </div>
          <ChartContainer config={chartConfig} className="h-[260px] w-full">
            <BarChart data={toolDaily}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
              <XAxis dataKey="date" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
              <YAxis tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} tickFormatter={(v) => `R$${v}`} />
              <ChartTooltip content={<ChartTooltipContent formatter={(v: any) => fmtBRL(Number(v))} />} />
              <Bar dataKey="faturamento" fill="hsl(45 95% 55%)" radius={[4, 4, 0, 0]} />
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
