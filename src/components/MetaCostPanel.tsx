import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenants } from "@/hooks/useTenants";
import { AlertTriangle, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Data em que o contador começou a rodar (deploy do painel).
// Não alterar: mudar essa data reseta o histórico exibido.
const COUNTER_START_AT = "2026-07-15T00:00:00Z";
const COST_PER_MESSAGE_BRL = 0.035;
const HUMAN_ATTENDANT_PREFIX = "[ATENDENTE HUMANO]:";

type Row = { tenant_id: string; created_at: string };

async function fetchAllAssistantMessages(): Promise<Row[]> {
  const pageSize = 1000;
  let from = 0;
  const all: Row[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await supabase
      .from("chat_messages")
      .select("tenant_id, created_at, content")
      .eq("role", "assistant")
      .gte("created_at", COUNTER_START_AT)
      .order("created_at", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const r of data as any[]) {
      const content = typeof r.content === "string" ? r.content : "";
      if (content.startsWith(HUMAN_ATTENDANT_PREFIX)) continue;
      all.push({ tenant_id: r.tenant_id, created_at: r.created_at });
    }
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

function formatBRL(v: number) {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function toLocalDayKey(iso: string): string {
  // yyyy-mm-dd no fuso local (para agrupamento por dia da operação)
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function todayKey(): string {
  return toLocalDayKey(new Date().toISOString());
}

function daysAgoKey(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toLocalDayKey(d.toISOString());
}

function counterStartKey(): string {
  return toLocalDayKey(COUNTER_START_AT);
}

type Preset = "all" | "today" | "7d" | "30d" | "custom";

export default function MetaCostPanel() {
  const { data: tenants } = useTenants();
  const { data: rows, isLoading } = useQuery({
    queryKey: ["meta-cost-messages"],
    queryFn: fetchAllAssistantMessages,
    staleTime: 60_000,
  });

  const [preset, setPreset] = useState<Preset>("all");
  const [fromDate, setFromDate] = useState<string>(counterStartKey());
  const [toDate, setToDate] = useState<string>(todayKey());
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  function applyPreset(p: Preset) {
    setPreset(p);
    setSelectedDay(null);
    if (p === "all") {
      setFromDate(counterStartKey());
      setToDate(todayKey());
    } else if (p === "today") {
      setFromDate(todayKey());
      setToDate(todayKey());
    } else if (p === "7d") {
      setFromDate(daysAgoKey(6));
      setToDate(todayKey());
    } else if (p === "30d") {
      setFromDate(daysAgoKey(29));
      setToDate(todayKey());
    }
  }

  const stats = useMemo(() => {
    const tenantMap = new Map((tenants ?? []).map((t) => [t.id, t]));

    // Efetivo: se um dia estiver selecionado, ele filtra tudo.
    const effFrom = selectedDay ?? fromDate;
    const effTo = selectedDay ?? toDate;

    // 1) Todos os dias do intervalo do filtro (para o gráfico de barras)
    const dayCounts = new Map<string, number>();
    // Inicializa todos os dias no intervalo (mesmo com 0)
    {
      const start = new Date(effFrom + "T00:00:00");
      const end = new Date(effTo + "T00:00:00");
      const d = new Date(start);
      while (d <= end) {
        dayCounts.set(toLocalDayKey(d.toISOString()), 0);
        d.setDate(d.getDate() + 1);
      }
    }

    // 2) Percorre as mensagens uma única vez
    const perTenant = new Map<string, number>();
    // per (day, tenant) para inspecionar picos
    const perDayTenant = new Map<string, Map<string, number>>();

    for (const r of rows ?? []) {
      const dayKey = toLocalDayKey(r.created_at);
      if (dayKey < effFrom || dayKey > effTo) continue;
      dayCounts.set(dayKey, (dayCounts.get(dayKey) ?? 0) + 1);
      perTenant.set(r.tenant_id, (perTenant.get(r.tenant_id) ?? 0) + 1);
      let m = perDayTenant.get(dayKey);
      if (!m) {
        m = new Map();
        perDayTenant.set(dayKey, m);
      }
      m.set(r.tenant_id, (m.get(r.tenant_id) ?? 0) + 1);
    }

    // Ranking de tenants no período
    const list = Array.from(tenantMap.entries()).map(([tenantId, t]) => {
      const total = perTenant.get(tenantId) ?? 0;
      return {
        tenantId,
        name: t.name ?? "(empresa sem nome)",
        status: t.status ?? null,
        total,
        cost: total * COST_PER_MESSAGE_BRL,
      };
    });
    // Tenants removidos com mensagens no período
    for (const [tenantId, total] of perTenant.entries()) {
      if (!tenantMap.has(tenantId)) {
        list.push({
          tenantId,
          name: "(empresa removida)",
          status: null,
          total,
          cost: total * COST_PER_MESSAGE_BRL,
        });
      }
    }
    list.sort((a, b) => b.total - a.total);

    const grandTotalMsgs = list.reduce((s, r) => s + r.total, 0);
    const grandTotalCost = grandTotalMsgs * COST_PER_MESSAGE_BRL;

    // Série diária ordenada
    const daySeries = Array.from(dayCounts.entries())
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([day, count]) => ({ day, count, cost: count * COST_PER_MESSAGE_BRL }));

    const maxDay = daySeries.reduce((m, d) => (d.count > m ? d.count : m), 0);
    const avgDay = daySeries.length > 0 ? grandTotalMsgs / daySeries.length : 0;

    // Detecção de picos: dias com > 2x a média (e mínimo relevante)
    const spikeThreshold = Math.max(avgDay * 2, 50);
    const spikes = daySeries
      .filter((d) => d.count >= spikeThreshold && d.count > 0)
      .map((d) => {
        const perT = perDayTenant.get(d.day);
        const topTenants = perT
          ? Array.from(perT.entries())
              .sort((a, b) => b[1] - a[1])
              .slice(0, 3)
              .map(([tid, count]) => ({
                tenantId: tid,
                name: tenantMap.get(tid)?.name ?? "(empresa removida)",
                count,
              }))
          : [];
        return { ...d, topTenants };
      });

    // Ranking do dia selecionado (para painel de detalhe)
    let selectedDayBreakdown: Array<{ tenantId: string; name: string; count: number; cost: number }> = [];
    if (selectedDay) {
      const perT = perDayTenant.get(selectedDay);
      if (perT) {
        selectedDayBreakdown = Array.from(perT.entries())
          .map(([tid, count]) => ({
            tenantId: tid,
            name: tenantMap.get(tid)?.name ?? "(empresa removida)",
            count,
            cost: count * COST_PER_MESSAGE_BRL,
          }))
          .sort((a, b) => b.count - a.count);
      }
    }

    return {
      list,
      grandTotalMsgs,
      grandTotalCost,
      daySeries,
      maxDay,
      avgDay,
      spikes,
      selectedDayBreakdown,
      effFrom,
      effTo,
    };
  }, [rows, tenants, fromDate, toDate, selectedDay]);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-bold text-foreground">API Oficial Meta</h2>
          <p className="text-muted-foreground text-sm">
            Volume de mensagens da IA e custo estimado sob a cobrança da Meta. Filtre por período ou clique num dia para investigar picos.
          </p>
        </div>
        <div className="text-xs text-muted-foreground">
          Contando desde{" "}
          <span className="font-mono text-foreground">
            {new Date(COUNTER_START_AT).toLocaleDateString("pt-BR")}
          </span>
        </div>
      </div>

      <div className="flex items-start gap-3 p-3 rounded-lg border border-warning/40 bg-warning/10 text-sm">
        <AlertTriangle className="w-4 h-4 mt-0.5 text-warning shrink-0" />
        <p className="text-foreground/90">
          <strong>Estimativa</strong> baseada no modelo Meta a partir de{" "}
          <strong>01/10/2026</strong> (R$ {COST_PER_MESSAGE_BRL.toFixed(3).replace(".", ",")} por mensagem).{" "}
          <span className="text-muted-foreground">Não é cobrança real hoje — a operação usa API não oficial.</span>
        </p>
      </div>

      {/* Filtros */}
      <div className="glass-card p-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          {([
            ["all", "Tudo"],
            ["today", "Hoje"],
            ["7d", "Últimos 7 dias"],
            ["30d", "Últimos 30 dias"],
            ["custom", "Personalizado"],
          ] as [Preset, string][]).map(([p, label]) => (
            <Button
              key={p}
              size="sm"
              variant={preset === p ? "default" : "outline"}
              onClick={() => (p === "custom" ? setPreset("custom") : applyPreset(p))}
            >
              {label}
            </Button>
          ))}
          {selectedDay && (
            <Button size="sm" variant="secondary" onClick={() => setSelectedDay(null)}>
              Limpar dia selecionado ({new Date(selectedDay + "T00:00:00").toLocaleDateString("pt-BR")})
            </Button>
          )}
        </div>
        {preset === "custom" && (
          <div className="flex items-center gap-2 flex-wrap">
            <label className="text-xs text-muted-foreground">De</label>
            <Input
              type="date"
              value={fromDate}
              min={counterStartKey()}
              max={toDate}
              onChange={(e) => {
                setSelectedDay(null);
                setFromDate(e.target.value || counterStartKey());
              }}
              className="w-auto"
            />
            <label className="text-xs text-muted-foreground">Até</label>
            <Input
              type="date"
              value={toDate}
              min={fromDate}
              max={todayKey()}
              onChange={(e) => {
                setSelectedDay(null);
                setToDate(e.target.value || todayKey());
              }}
              className="w-auto"
            />
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Período efetivo:{" "}
          <span className="font-mono text-foreground">
            {new Date(stats.effFrom + "T00:00:00").toLocaleDateString("pt-BR")}
          </span>{" "}
          →{" "}
          <span className="font-mono text-foreground">
            {new Date(stats.effTo + "T00:00:00").toLocaleDateString("pt-BR")}
          </span>{" "}
          · {stats.daySeries.length} dia(s)
        </p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <div className="glass-card p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Mensagens no período</p>
          <p className="text-2xl font-bold text-foreground mt-1">{stats.grandTotalMsgs.toLocaleString("pt-BR")}</p>
        </div>
        <div className="glass-card p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Custo estimado</p>
          <p className="text-2xl font-bold text-foreground mt-1">{formatBRL(stats.grandTotalCost)}</p>
        </div>
        <div className="glass-card p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Média por dia</p>
          <p className="text-2xl font-bold text-foreground mt-1">
            {Math.round(stats.avgDay).toLocaleString("pt-BR")}
          </p>
        </div>
        <div className="glass-card p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Pico do período</p>
          <p className="text-2xl font-bold text-foreground mt-1">{stats.maxDay.toLocaleString("pt-BR")}</p>
        </div>
      </div>

      {/* Alerta de picos */}
      {stats.spikes.length > 0 && !selectedDay && (
        <div className="glass-card p-4 border border-destructive/40 bg-destructive/5">
          <div className="flex items-center gap-2 mb-2">
            <TrendingUp className="w-4 h-4 text-destructive" />
            <p className="text-sm font-semibold text-foreground">
              {stats.spikes.length} dia(s) com volume anômalo (&gt;2x a média)
            </p>
          </div>
          <div className="space-y-1 text-xs">
            {stats.spikes.slice(0, 5).map((s) => (
              <button
                key={s.day}
                onClick={() => setSelectedDay(s.day)}
                className="w-full text-left flex items-center justify-between gap-3 p-2 rounded hover:bg-muted/40 transition"
              >
                <span className="font-mono text-foreground">
                  {new Date(s.day + "T00:00:00").toLocaleDateString("pt-BR")}
                </span>
                <span className="text-muted-foreground truncate">
                  Top: {s.topTenants.map((t) => `${t.name} (${t.count})`).join(" · ") || "—"}
                </span>
                <span className="font-mono text-foreground shrink-0">
                  {s.count.toLocaleString("pt-BR")} msgs · {formatBRL(s.cost)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Gráfico de barras por dia */}
      <div className="glass-card p-4">
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-semibold text-foreground">Volume por dia</p>
          <p className="text-xs text-muted-foreground">Clique numa barra para investigar</p>
        </div>
        {isLoading ? (
          <p className="text-sm text-muted-foreground text-center py-8">Carregando...</p>
        ) : stats.daySeries.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">Nenhum dia no intervalo.</p>
        ) : (
          <div className="flex items-end gap-1 h-40 overflow-x-auto">
            {stats.daySeries.map((d) => {
              const hPct = stats.maxDay > 0 ? (d.count / stats.maxDay) * 100 : 0;
              const isSelected = selectedDay === d.day;
              const isSpike = d.count >= Math.max(stats.avgDay * 2, 50) && d.count > 0;
              return (
                <button
                  key={d.day}
                  onClick={() => setSelectedDay(isSelected ? null : d.day)}
                  className="flex-1 min-w-[16px] flex flex-col items-center justify-end h-full group"
                  title={`${new Date(d.day + "T00:00:00").toLocaleDateString("pt-BR")} · ${d.count} msgs · ${formatBRL(d.cost)}`}
                >
                  <div
                    className={`w-full rounded-t transition-all ${
                      isSelected
                        ? "bg-primary"
                        : isSpike
                        ? "bg-destructive/70 group-hover:bg-destructive"
                        : "bg-primary/40 group-hover:bg-primary/70"
                    }`}
                    style={{ height: `${Math.max(hPct, d.count > 0 ? 2 : 0)}%` }}
                  />
                </button>
              );
            })}
          </div>
        )}
        {stats.daySeries.length > 0 && (
          <div className="flex justify-between text-[10px] text-muted-foreground mt-2 font-mono">
            <span>{new Date(stats.daySeries[0].day + "T00:00:00").toLocaleDateString("pt-BR")}</span>
            <span>
              {new Date(stats.daySeries[stats.daySeries.length - 1].day + "T00:00:00").toLocaleDateString("pt-BR")}
            </span>
          </div>
        )}
      </div>

      {/* Detalhe do dia selecionado */}
      {selectedDay && (
        <div className="glass-card p-4 border border-primary/40">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-sm font-semibold text-foreground">
                Detalhe do dia {new Date(selectedDay + "T00:00:00").toLocaleDateString("pt-BR")}
              </p>
              <p className="text-xs text-muted-foreground">Empresas que enviaram mensagens neste dia</p>
            </div>
            <Button size="sm" variant="outline" onClick={() => setSelectedDay(null)}>
              Fechar
            </Button>
          </div>
          {stats.selectedDayBreakdown.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">Sem mensagens neste dia.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-2">#</th>
                  <th className="p-2">Empresa</th>
                  <th className="p-2 text-right">Mensagens</th>
                  <th className="p-2 text-right">Custo estimado</th>
                </tr>
              </thead>
              <tbody>
                {stats.selectedDayBreakdown.map((r, i) => (
                  <tr key={r.tenantId} className="border-t border-border">
                    <td className="p-2 text-muted-foreground font-mono text-xs">{i + 1}</td>
                    <td className="p-2 font-medium text-foreground">{r.name}</td>
                    <td className="p-2 text-right font-mono">{r.count.toLocaleString("pt-BR")}</td>
                    <td className="p-2 text-right font-mono">{formatBRL(r.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Ranking de empresas no período */}
      <div className="glass-card p-0 overflow-hidden">
        <div className="p-3 border-b border-border">
          <p className="text-sm font-semibold text-foreground">
            Ranking de empresas {selectedDay ? "no dia selecionado" : "no período"}
          </p>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="p-3">#</th>
              <th className="p-3">Empresa</th>
              <th className="p-3">Status</th>
              <th className="p-3 text-right">Mensagens</th>
              <th className="p-3 text-right">Custo estimado</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td className="p-6 text-center text-muted-foreground" colSpan={5}>
                  Carregando...
                </td>
              </tr>
            )}
            {!isLoading && stats.list.length === 0 && (
              <tr>
                <td className="p-6 text-center text-muted-foreground" colSpan={5}>
                  Nenhuma empresa cadastrada.
                </td>
              </tr>
            )}
            {stats.list.map((r, i) => (
              <tr key={r.tenantId} className="border-t border-border">
                <td className="p-3 text-muted-foreground font-mono text-xs">{i + 1}</td>
                <td className="p-3 font-medium text-foreground">{r.name}</td>
                <td className="p-3">
                  {r.status ? (
                    <span className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground capitalize">
                      {r.status}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
                <td className="p-3 text-right font-mono">{r.total.toLocaleString("pt-BR")}</td>
                <td className="p-3 text-right font-mono">{formatBRL(r.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
