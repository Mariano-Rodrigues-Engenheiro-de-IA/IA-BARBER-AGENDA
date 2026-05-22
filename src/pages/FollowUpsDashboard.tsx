import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Clock, CheckCircle2, XCircle, Sparkles, TrendingUp, Users, MessageCircle, Filter } from "lucide-react";

type FollowUp = {
  id: string;
  tenant_id: string;
  phone_number: string;
  status: string;
  created_at: string;
  follow_up_at: string;
  sent_at: string | null;
  confirmed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  follow_up_message: string | null;
  sequence_id: string | null;
  step_order: number | null;
  matched_keyword: string | null;
};

type Tenant = { id: string; name: string };
type Sequence = { id: string; tenant_id: string; name: string; trigger_type: string };

const STATUS_LABEL: Record<string, string> = {
  pending: "Pendente",
  sent: "Enviado",
  confirmed: "Confirmado",
  cancelled: "Cancelado",
  expired: "Expirado",
};

const CANCEL_REASON_LABEL: Record<string, string> = {
  lead_replied: "lead respondeu",
  manual: "manual",
  expired: "expirado",
};

const formatKeyword = (k?: string | null) =>
  !k ? "—" : k === "__catch_all__" ? "(qualquer mensagem)" : k;

export default function FollowUpsDashboard() {
  const [period, setPeriod] = useState<"7d" | "14d" | "30d" | "all">("30d");
  const [sequenceFilter, setSequenceFilter] = useState<string>("all");
  const [timelinePhone, setTimelinePhone] = useState<{ tenantId: string; phone: string } | null>(null);

  const { data: followUps, isLoading: loadingFU } = useQuery({
    queryKey: ["follow-ups-dashboard", period],
    queryFn: async () => {
      let query = supabase.from("follow_ups").select("*").order("created_at", { ascending: false }).limit(1000);
      if (period !== "all") {
        const days = period === "7d" ? 7 : period === "14d" ? 14 : 30;
        const since = new Date(Date.now() - days * 86400000).toISOString();
        query = query.or([
          `created_at.gte.${since}`,
          `follow_up_at.gte.${since}`,
          `sent_at.gte.${since}`,
          `confirmed_at.gte.${since}`,
          `cancelled_at.gte.${since}`,
        ].join(","));
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

  const { data: sequences } = useQuery({
    queryKey: ["sequences-list"],
    queryFn: async () => {
      const { data, error } = await supabase.from("follow_up_sequences").select("id, tenant_id, name, trigger_type");
      if (error) throw error;
      return data as Sequence[];
    },
  });

  const tenantMap = useMemo(() => Object.fromEntries((tenants || []).map((t) => [t.id, t.name])), [tenants]);
  const seqMap = useMemo(() => Object.fromEntries((sequences || []).map((s) => [s.id, s])), [sequences]);

  const filtered = useMemo(() => {
    if (!followUps) return [];
    return followUps.filter((f) => {
      if (sequenceFilter !== "all" && f.sequence_id !== sequenceFilter) return false;
      return true;
    });
  }, [followUps, sequenceFilter]);

  const seqRows = useMemo(() => filtered.filter((f) => f.sequence_id), [filtered]);

  const seqMetrics = useMemo(() => {
    const journeys = new Map<string, FollowUp[]>();
    seqRows.forEach((f) => {
      const k = `${f.tenant_id}|${f.phone_number}|${f.sequence_id}`;
      if (!journeys.has(k)) journeys.set(k, []);
      journeys.get(k)!.push(f);
    });

    const totalLeads = journeys.size;
    let active = 0, completed = 0, replied = 0, converted = 0;
    let messagesSent = 0, convertedMessages = 0, unansweredMessages = 0;
    const byKeyword: Record<string, number> = {};
    const stepReached: Record<number, number> = {};
    const stepResponded: Record<number, number> = {};

    for (const [, items] of journeys) {
      const sorted = items.sort((a, b) => (a.step_order || 0) - (b.step_order || 0));
      const maxStep = Math.max(...sorted.map((s) => s.step_order || 0));
      stepReached[maxStep] = (stepReached[maxStep] || 0) + 1;

      const sentRows = sorted.filter((s) => s.sent_at);
      messagesSent += sentRows.length;
      convertedMessages += sentRows.filter((s) => s.status === "confirmed").length;
      unansweredMessages += sentRows.filter((s) => s.status === "sent").length;

      const hasPending = sorted.some((s) => s.status === "pending");
      const hasReplied = sorted.some((s) => s.cancel_reason === "lead_replied");
      const hasConfirmed = sorted.some((s) => s.status === "confirmed");
      const allSent = sorted.every((s) => s.status === "sent" || s.status === "confirmed");

      if (hasConfirmed) converted++;
      if (hasReplied) {
        replied++;
        const lastSentStep = sorted.filter((s) => s.status === "sent").pop()?.step_order;
        if (lastSentStep) stepResponded[lastSentStep] = (stepResponded[lastSentStep] || 0) + 1;
      }
      if (hasPending) active++;
      else if (allSent && !hasReplied && !hasConfirmed) completed++;

      const kw = sorted[0]?.matched_keyword || "(sem palavra)";
      byKeyword[kw] = (byKeyword[kw] || 0) + 1;
    }

    return {
      totalLeads,
      active,
      completed,
      replied,
      converted,
      messagesSent,
      convertedMessages,
      unansweredMessages,
      byKeyword,
      stepReached,
      stepResponded,
      journeys,
    };
  }, [seqRows]);

  const leadsTable = useMemo(() => {
    const rows: { tenantId: string; phone: string; sequenceId: string; sequenceName: string; tenantName: string; keyword: string; currentStep: number; totalSteps: number; status: string; lastUpdate: string }[] = [];
    for (const [key, items] of seqMetrics.journeys) {
      const [tenantId, phone, sequenceId] = key.split("|");
      const sorted = items.sort((a, b) => (a.step_order || 0) - (b.step_order || 0));
      const last = sorted[sorted.length - 1];
      const hasConfirmed = sorted.some((s) => s.status === "confirmed");
      const hasReplied = sorted.some((s) => s.cancel_reason === "lead_replied");
      const hasPending = sorted.some((s) => s.status === "pending");
      let status = "Em andamento";
      if (hasConfirmed) status = "Convertido";
      else if (hasReplied) status = "Respondeu antes";
      else if (!hasPending) status = "Concluiu sem resposta";

      rows.push({
        tenantId, phone, sequenceId,
        sequenceName: seqMap[sequenceId]?.name || "—",
        tenantName: tenantMap[tenantId] || tenantId.slice(0, 8),
        keyword: sorted[0]?.matched_keyword || "—",
        currentStep: last?.step_order || 0,
        totalSteps: sorted.length,
        status,
        lastUpdate: last?.sent_at || last?.cancelled_at || last?.confirmed_at || last?.created_at,
      });
    }
    return rows.sort((a, b) => (b.lastUpdate || "").localeCompare(a.lastUpdate || ""));
  }, [seqMetrics, seqMap, tenantMap]);

  const statusBadge = (status: string) => {
    const map: Record<string, string> = {
      "Convertido": "bg-accent/20 text-accent",
      "Respondeu antes": "bg-primary/20 text-primary",
      "Em andamento": "bg-yellow-500/20 text-yellow-500",
      "Concluiu sem resposta": "bg-destructive/20 text-destructive",
    };
    return <span className={`px-2 py-1 rounded text-xs font-medium ${map[status] || "bg-muted text-muted-foreground"}`}>{status}</span>;
  };

  const maxStep = Math.max(0, ...Object.keys(seqMetrics.stepReached).map(Number));
  const funnelData = Array.from({ length: maxStep }, (_, i) => {
    const step = i + 1;
    let reached = 0;
    for (let j = step; j <= maxStep; j++) reached += (seqMetrics.stepReached[j] || 0);
    return { step, reached, responded: seqMetrics.stepResponded[step] || 0 };
  });
  const maxReached = Math.max(1, ...funnelData.map((f) => f.reached));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Follow-ups</h2>
          <p className="text-muted-foreground mt-1">Métricas dos seus follow-ups personalizados</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Select value={period} onValueChange={(v) => setPeriod(v as any)}>
            <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="7d">Últimos 7 dias</SelectItem>
              <SelectItem value="14d">Últimos 14 dias</SelectItem>
              <SelectItem value="30d">Últimos 30 dias</SelectItem>
              <SelectItem value="all">Todos os follow-ups</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sequenceFilter} onValueChange={setSequenceFilter}>
            <SelectTrigger className="w-[200px]"><SelectValue placeholder="Follow-up" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os follow-ups</SelectItem>
              {sequences?.map((s) => (
                <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-6">
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
          {[
            { label: "Leads captados", value: seqMetrics.totalLeads, icon: Users, color: "text-primary" },
            { label: "Mensagens enviadas", value: seqMetrics.messagesSent, icon: MessageCircle, color: "text-primary" },
            { label: "Em andamento", value: seqMetrics.active, icon: Clock, color: "text-yellow-500" },
            { label: "Responderam", value: seqMetrics.replied, icon: MessageCircle, color: "text-primary" },
            { label: "Convertidos", value: seqMetrics.convertedMessages, icon: CheckCircle2, color: "text-accent" },
            { label: "Sem resposta", value: seqMetrics.unansweredMessages, icon: XCircle, color: "text-destructive" },
          ].map((s) => (
            <div key={s.label} className="glass-card p-5 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">{s.label}</span>
                <s.icon className={`w-5 h-5 ${s.color}`} />
              </div>
              {loadingFU ? <Skeleton className="h-9 w-16" /> : <p className="text-3xl font-bold text-foreground">{s.value}</p>}
            </div>
          ))}
        </div>

        {funnelData.length > 0 && (
          <div className="glass-card p-5">
            <h3 className="font-semibold mb-4 flex items-center gap-2"><TrendingUp className="w-4 h-4" />Funil por etapa</h3>
            <div className="space-y-2">
              {funnelData.map((f) => (
                <div key={f.step} className="flex items-center gap-3">
                  <span className="text-sm w-16 text-muted-foreground">Etapa {f.step}</span>
                  <div className="flex-1 bg-muted/30 rounded h-8 relative overflow-hidden">
                    <div className="h-full bg-primary/30" style={{ width: `${(f.reached / maxReached) * 100}%` }} />
                    <div className="absolute inset-0 flex items-center px-3 text-xs">
                      <span className="font-medium">{f.reached} alcançaram</span>
                      {f.responded > 0 && <span className="ml-3 text-accent">{f.responded} responderam após</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {Object.keys(seqMetrics.byKeyword).length > 0 && (
          <div className="glass-card p-5">
            <h3 className="font-semibold mb-4 flex items-center gap-2"><Filter className="w-4 h-4" />Por palavra-chave</h3>
            <div className="flex flex-wrap gap-2">
              {Object.entries(seqMetrics.byKeyword).sort((a, b) => b[1] - a[1]).map(([kw, count]) => (
                <Badge key={kw} variant="outline" className="text-sm">{formatKeyword(kw)}: <strong className="ml-1">{count}</strong></Badge>
              ))}
            </div>
          </div>
        )}

        <div className="glass-card overflow-hidden">
          <div className="p-5 border-b border-border"><h3 className="font-semibold">Leads</h3></div>
          {leadsTable.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground">
              <Sparkles className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p>Nenhum lead em follow-up no período</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="p-4 text-xs font-medium text-muted-foreground uppercase">Telefone</th>
                    <th className="p-4 text-xs font-medium text-muted-foreground uppercase">Follow-up</th>
                    <th className="p-4 text-xs font-medium text-muted-foreground uppercase">Palavra-chave</th>
                    <th className="p-4 text-xs font-medium text-muted-foreground uppercase text-center">Etapa</th>
                    <th className="p-4 text-xs font-medium text-muted-foreground uppercase">Status</th>
                    <th className="p-4 text-xs font-medium text-muted-foreground uppercase">Última ação</th>
                  </tr>
                </thead>
                <tbody>
                  {leadsTable.slice(0, 100).map((row, idx) => (
                    <tr key={idx} className="border-b border-border/50 hover:bg-muted/30 cursor-pointer" onClick={() => setTimelinePhone({ tenantId: row.tenantId, phone: row.phone })}>
                      <td className="p-4 text-sm font-mono">{row.phone}</td>
                      <td className="p-4 text-sm">{row.sequenceName}</td>
                      <td className="p-4 text-sm text-muted-foreground">{formatKeyword(row.keyword)}</td>
                      <td className="p-4 text-sm text-center">{row.currentStep}/{row.totalSteps}</td>
                      <td className="p-4">{statusBadge(row.status)}</td>
                      <td className="p-4 text-xs text-muted-foreground">{row.lastUpdate ? new Date(row.lastUpdate).toLocaleString("pt-BR") : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <TimelineDialog
        info={timelinePhone}
        onClose={() => setTimelinePhone(null)}
        followUps={filtered}
        seqMap={seqMap}
      />
    </div>
  );
}

function TimelineDialog({ info, onClose, followUps, seqMap }: {
  info: { tenantId: string; phone: string } | null;
  onClose: () => void;
  followUps: FollowUp[];
  seqMap: Record<string, Sequence>;
}) {
  const items = useMemo(() => {
    if (!info) return [];
    return followUps
      .filter((f) => f.tenant_id === info.tenantId && f.phone_number === info.phone)
      .sort((a, b) => (a.step_order || 0) - (b.step_order || 0));
  }, [info, followUps]);

  return (
    <Dialog open={!!info} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Linha do tempo — {info?.phone}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 max-h-[60vh] overflow-y-auto">
          {items.map((f) => {
            const seq = f.sequence_id ? seqMap[f.sequence_id] : null;
            const statusColor = f.status === "sent" ? "text-primary" : f.status === "confirmed" ? "text-accent" : f.status === "pending" ? "text-yellow-500" : "text-destructive";
            const reasonLabel = f.cancel_reason ? (CANCEL_REASON_LABEL[f.cancel_reason] ?? f.cancel_reason) : null;
            return (
              <div key={f.id} className="border border-border rounded-md p-3 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{seq?.name || "Follow-up"} — Etapa {f.step_order || "?"}</span>
                  <span className={`text-xs uppercase font-bold ${statusColor}`}>{STATUS_LABEL[f.status] ?? f.status}</span>
                </div>
                <p className="text-sm text-muted-foreground">{f.follow_up_message?.slice(0, 200)}</p>
                <div className="text-xs text-muted-foreground flex flex-wrap gap-3">
                  <span>Criado: {new Date(f.created_at).toLocaleString("pt-BR")}</span>
                  {f.sent_at && <span>Enviado: {new Date(f.sent_at).toLocaleString("pt-BR")}</span>}
                  {f.cancelled_at && <span>Cancelado: {new Date(f.cancelled_at).toLocaleString("pt-BR")}{reasonLabel ? ` (${reasonLabel})` : ""}</span>}
                  {f.confirmed_at && <span>Confirmado: {new Date(f.confirmed_at).toLocaleString("pt-BR")}</span>}
                </div>
              </div>
            );
          })}
          {items.length === 0 && <p className="text-center text-muted-foreground p-8">Nenhum evento</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
