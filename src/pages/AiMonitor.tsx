import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenants } from "@/hooks/useTenants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AlertTriangle, CheckCircle2, RefreshCw, ShieldCheck, Phone, Wrench, MessageSquare, Bot, Eye, EyeOff } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { toast } from "sonner";

type Finding = {
  id: string;
  tenant_id: string;
  agent_log_id: string;
  phone_number: string | null;
  provider: string | null;
  category: string;
  severity: string;
  summary: string;
  evidence_conversation: string;
  evidence_tool: string;
  review_status: string;
  turn_at: string | null;
  created_at: string;
};

type Run = {
  id: string;
  tenant_id: string;
  agent_log_id: string;
  status: string;
  issues_count: number;
  turn_at: string | null;
  created_at: string;
};

const CATEGORIES = [
  { key: "completude_agendamento", label: "Completude do agendamento" },
  { key: "cancelamento_remarcacao", label: "Cancelamento / remarcação" },
  { key: "comunicacao", label: "Comunicação (disse ≠ fez)" },
  { key: "erro_tecnico_mascarado", label: "Erro técnico mascarado" },
  { key: "disponibilidade_inventada", label: "Horário / profissional inventado" },
  { key: "dados_incorretos_api", label: "Dado divergente da API" },
  { key: "uso_indevido_ferramenta", label: "Uso indevido da ferramenta" },
] as const;

const PERIODS = [
  { key: "1", label: "Hoje" },
  { key: "7", label: "7 dias" },
  { key: "30", label: "30 dias" },
  { key: "90", label: "90 dias" },
];

const SEVERITY_VARIANT: Record<string, "destructive" | "secondary" | "outline"> = {
  alta: "destructive",
  media: "secondary",
  baixa: "outline",
};

function healthColor(rate: number | null) {
  if (rate === null) return "bg-muted";
  if (rate >= 0.98) return "bg-emerald-500";
  if (rate >= 0.9) return "bg-amber-500";
  return "bg-destructive";
}

function pct(rate: number | null) {
  if (rate === null) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

export default function AiMonitorPage() {
  const queryClient = useQueryClient();
  const { data: tenants } = useTenants();
  const [period, setPeriod] = useState("7");
  const [tenantFilter, setTenantFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("open");
  const [selected, setSelected] = useState<Finding | null>(null);
  const [running, setRunning] = useState(false);
  const [viewed, setViewed] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("ai-monitor-viewed") ?? "[]");
    } catch {
      return [];
    }
  });

  const markViewed = (id: string, isViewed: boolean) => {
    setViewed((prev) => {
      const next = isViewed ? Array.from(new Set([...prev, id])) : prev.filter((x) => x !== id);
      localStorage.setItem("ai-monitor-viewed", JSON.stringify(next.slice(-5000)));
      return next;
    });
  };

  // Abrir o detalhe já marca o caso como visualizado.
  useEffect(() => {
    if (selected) markViewed(selected.id, true);
  }, [selected?.id]);

  const since = useMemo(
    () => new Date(Date.now() - Number(period) * 86400000).toISOString(),
    [period],
  );

  const { data: runs } = useQuery({
    queryKey: ["ai-audit-runs", since],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ai_audit_runs")
        .select("id, tenant_id, agent_log_id, status, issues_count, turn_at, created_at")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(5000);
      if (error) throw error;
      return (data ?? []) as Run[];
    },
  });

  const { data: findings } = useQuery({
    queryKey: ["ai-audit-findings", since],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ai_audit_findings")
        .select("*")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(2000);
      if (error) throw error;
      return (data ?? []) as Finding[];
    },
  });

  const tenantName = (id: string) => tenants?.find((t: any) => t.id === id)?.name ?? "Empresa";

  const perTenant = useMemo(() => {
    const auditedByTenant = new Map<string, number>();
    (runs ?? []).forEach((r) => {
      if (r.status !== "audited") return;
      auditedByTenant.set(r.tenant_id, (auditedByTenant.get(r.tenant_id) ?? 0) + 1);
    });
    const valid = (findings ?? []).filter((f) => f.review_status !== "false_alarm");
    const rows = Array.from(auditedByTenant.entries()).map(([tenant_id, audited]) => {
      const mine = valid.filter((f) => f.tenant_id === tenant_id);
      const byCategory: Record<string, number> = {};
      CATEGORIES.forEach((c) => {
        byCategory[c.key] = mine.filter((f) => f.category === c.key).length;
      });
      return {
        tenant_id,
        audited,
        total: mine.length,
        byCategory,
        rate: (key: string) => (audited ? Math.max(0, 1 - byCategory[key] / audited) : null),
      };
    });
    return rows.sort((a, b) => b.total - a.total);
  }, [runs, findings]);

  const visibleFindings = useMemo(() => {
    return (findings ?? []).filter((f) => {
      if (tenantFilter !== "all" && f.tenant_id !== tenantFilter) return false;
      if (categoryFilter !== "all" && f.category !== categoryFilter) return false;
      if (statusFilter !== "all" && f.review_status !== statusFilter) return false;
      return true;
    });
  }, [findings, tenantFilter, categoryFilter, statusFilter]);

  const totals = useMemo(() => {
    const audited = (runs ?? []).filter((r) => r.status === "audited").length;
    const skipped = (runs ?? []).filter((r) => r.status === "skipped_no_tools").length;
    const valid = (findings ?? []).filter((f) => f.review_status !== "false_alarm").length;
    const falseAlarm = (findings ?? []).filter((f) => f.review_status === "false_alarm").length;
    return { audited, skipped, valid, falseAlarm };
  }, [runs, findings]);

  const review = async (finding: Finding, review_status: string) => {
    const { data: { user } } = await supabase.auth.getUser();
    const { data: updated, error } = await supabase
      .from("ai_audit_findings")
      .update({ review_status, reviewed_at: new Date().toISOString(), reviewed_by: user?.id ?? null })
      .eq("id", finding.id)
      .select("id");
    if (error) {
      toast.error(error.message);
      return;
    }
    if (!updated?.length) {
      toast.error("Não consegui gravar a revisão — tente novamente.");
      return;
    }
    toast.success("Achado atualizado");
    queryClient.invalidateQueries({ queryKey: ["ai-audit-findings", since] });
    setSelected(null);
  };

  const runNow = async () => {
    setRunning(true);
    try {
      const { data, error } = await supabase.functions.invoke("audit-monitor", {
        body: { limit: 15, lookback_minutes: 720 },
      });
      if (error) throw error;
      toast.success(`Auditados ${data?.audited ?? 0} atendimentos, ${data?.issues ?? 0} problema(s) apontado(s)`);
      queryClient.invalidateQueries({ queryKey: ["ai-audit-findings", since] });
      queryClient.invalidateQueries({ queryKey: ["ai-audit-runs", since] });
    } catch (e: any) {
      toast.error(e?.message ?? "Falha ao rodar a auditoria");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShieldCheck className="w-6 h-6 text-primary" />
            Monitor da IA
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Auditoria contínua: compara o que o cliente pediu, o que a IA disse que fez e o que a ferramenta realmente retornou.
            Todo apontamento cita a prova.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Tabs value={period} onValueChange={setPeriod}>
            <TabsList>
              {PERIODS.map((p) => (
                <TabsTrigger key={p.key} value={p.key}>{p.label}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Button variant="outline" size="sm" onClick={runNow} disabled={running} className="gap-2">
            <RefreshCw className={`w-4 h-4 ${running ? "animate-spin" : ""}`} />
            Auditar agora
          </Button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Atendimentos auditados</p>
          <p className="text-2xl font-bold">{totals.audited}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Ignorados (sem ferramenta)</p>
          <p className="text-2xl font-bold">{totals.skipped}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Problemas apontados</p>
          <p className="text-2xl font-bold text-destructive">{totals.valid}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Marcados falso alarme</p>
          <p className="text-2xl font-bold">{totals.falseAlarm}</p>
        </CardContent></Card>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Saúde por empresa</h2>
        {!perTenant.length && (
          <Card><CardContent className="p-6 text-sm text-muted-foreground">
            Nenhum atendimento auditado neste período. Ative o monitor na empresa ou use "Auditar agora".
          </CardContent></Card>
        )}
        <div className="grid gap-4 lg:grid-cols-2">
          {perTenant.map((row) => (
            <Card key={row.tenant_id}>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center justify-between gap-2">
                  <span className="truncate">{tenantName(row.tenant_id)}</span>
                  <Badge variant="outline">{row.audited} auditados</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {CATEGORIES.map((c) => {
                  const rate = row.rate(c.key);
                  return (
                    <div key={c.key} className="flex items-center gap-3 text-sm">
                      <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${healthColor(rate)}`} />
                      <span className="flex-1 truncate text-muted-foreground">{c.label}</span>
                      <span className="font-medium tabular-nums">{pct(rate)}</span>
                      <span className="text-xs text-muted-foreground w-16 text-right">
                        {row.byCategory[c.key]} erro(s)
                      </span>
                    </div>
                  );
                })}
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full mt-1"
                  onClick={() => { setTenantFilter(row.tenant_id); setStatusFilter("all"); }}
                >
                  Ver conversas com problema
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Conversas com problema apontado</h2>
          <div className="flex flex-wrap gap-2">
            <Select value={tenantFilter} onValueChange={setTenantFilter}>
              <SelectTrigger className="w-[190px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas as empresas</SelectItem>
                {(tenants ?? []).map((t: any) => (
                  <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className="w-[210px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas as categorias</SelectItem>
                {CATEGORIES.map((c) => (
                  <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="open">Em aberto</SelectItem>
                <SelectItem value="valid">Procede</SelectItem>
                <SelectItem value="false_alarm">Falso alarme</SelectItem>
                <SelectItem value="resolved">Resolvido</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {!visibleFindings.length && (
          <Card><CardContent className="p-6 text-sm text-muted-foreground flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
            Nenhum problema apontado com esses filtros.
          </CardContent></Card>
        )}

        <div className="space-y-2">
          {visibleFindings.map((f) => (
            <Card key={f.id} className="cursor-pointer hover:border-primary/50 transition-colors" onClick={() => setSelected(f)}>
              <CardContent className="p-4 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={SEVERITY_VARIANT[f.severity] ?? "secondary"}>{f.severity}</Badge>
                  <Badge variant="outline">
                    {CATEGORIES.find((c) => c.key === f.category)?.label ?? f.category}
                  </Badge>
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <Phone className="w-3 h-3" />{f.phone_number}
                  </span>
                  <span className="text-xs text-muted-foreground truncate">{tenantName(f.tenant_id)}</span>
                  <span className="text-xs text-muted-foreground ml-auto">
                    {f.turn_at ? format(new Date(f.turn_at), "dd/MM HH:mm", { locale: ptBR }) : ""}
                  </span>
                  {f.review_status !== "open" && <Badge variant="secondary">{f.review_status}</Badge>}
                </div>
                <p className="text-sm">{f.summary}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent className="max-w-3xl sm:max-w-4xl lg:max-w-5xl w-[95vw] max-h-[90vh] flex flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-destructive" />
              {selected ? CATEGORIES.find((c) => c.key === selected.category)?.label ?? selected.category : ""}
            </DialogTitle>
          </DialogHeader>
          {selected && (
            <ScrollArea className="flex-1 max-h-[calc(90vh-6rem)] w-full overflow-x-hidden pr-4">
              <div className="space-y-4 w-full max-w-full min-w-0 overflow-x-hidden">
                <div className="text-sm text-muted-foreground">
                  {tenantName(selected.tenant_id)} · {selected.phone_number} ·{" "}
                  {selected.turn_at ? format(new Date(selected.turn_at), "dd/MM/yyyy HH:mm", { locale: ptBR }) : ""}
                </div>
                <p className="text-sm">{selected.summary}</p>

                <div className="space-y-2 w-full max-w-full">
                  <p className="text-xs font-semibold uppercase text-muted-foreground flex items-center gap-1">
                    <MessageSquare className="w-3 h-3" /> Prova na conversa
                  </p>
                  <pre className="text-xs whitespace-pre-wrap break-all w-full max-w-full min-w-0 overflow-x-hidden bg-muted/50 rounded-lg p-3">{selected.evidence_conversation}</pre>
                </div>

                <div className="space-y-2 w-full max-w-full">
                  <p className="text-xs font-semibold uppercase text-muted-foreground flex items-center gap-1">
                    <Wrench className="w-3 h-3" /> Prova no retorno da ferramenta
                  </p>
                  <pre className="text-xs whitespace-pre-wrap break-all w-full max-w-full min-w-0 overflow-x-hidden bg-muted/50 rounded-lg p-3">{selected.evidence_tool}</pre>
                </div>

                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Bot className="w-3 h-3" /> Atendimento: {selected.agent_log_id}
                </p>

                <div className="flex flex-wrap gap-2 pt-2">
                  <Button size="sm" onClick={() => review(selected, "valid")}>Procede</Button>
                  <Button size="sm" variant="outline" onClick={() => review(selected, "false_alarm")}>Falso alarme</Button>
                  <Button size="sm" variant="secondary" onClick={() => review(selected, "resolved")}>Resolvido</Button>
                </div>
              </div>
            </ScrollArea>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
