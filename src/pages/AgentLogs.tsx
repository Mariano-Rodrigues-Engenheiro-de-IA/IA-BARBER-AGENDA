import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  AlertTriangle, CheckCircle, Clock, ChevronDown, ChevronUp, Search, Phone, Bot, Wrench,
  Maximize2, Globe, MessageSquare, Brain, Send, Ban,
} from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

interface AgentLog {
  id: string;
  tenant_id: string;
  phone_number: string;
  user_message: string;
  ai_response: string | null;
  tool_calls: any[];
  errors: any[];
  http_trace?: any[] | null;
  model_used: string | null;
  duration_ms: number | null;
  session_blocked: boolean;
  created_at: string;
}

type Trace = {
  seq: number;
  at?: string;
  method: string;
  url: string;
  status: number | null;
  ok: boolean;
  duration_ms: number;
  request_body?: string | null;
  response_body?: string | null;
  error?: string;
};

const getTimingMetrics = (log: AgentLog) => {
  const toolCalls = Array.isArray(log.tool_calls) ? (log.tool_calls as any[]) : [];
  const debounceBatch = toolCalls.find((tc) => tc?.name === "__debounce_batch__");
  const result = debounceBatch?.result || {};
  const num = (v: any) => (typeof v === "number" && Number.isFinite(v) ? v : null);

  const totalResponseMs = num(result.total_response_ms);
  const debounceWaitMs = num(result.debounce_wait_ms);
  const aiProcessingMs = num(result.ai_processing_ms);
  const uazapiSendMs = num(result.uazapi_send_ms);

  return {
    debounceBatch,
    hasExactTiming: totalResponseMs !== null,
    totalMs: totalResponseMs ?? 0,
    debounceMs: debounceWaitMs ?? 0,
    aiMs: aiProcessingMs ?? 0,
    uazapiMs: uazapiSendMs,
  };
};

const prettyToolName = (name: string) =>
  String(name || "")
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());

const classifyTrace = (t: Trace): "llm" | "whatsapp" | "api" => {
  const u = (t.url || "").toLowerCase();
  if (u.includes("/chat/completions") || u.includes("/v1/responses") || u.includes("ai.gateway") || u.includes("api.openai.com")) return "llm";
  if (u.includes("uazapi") || u.includes("/send/")) return "whatsapp";
  return "api";
};

// Resumo curto e legível do resultado de uma ferramenta, para não jogar JSON cru na cara.
const summarizeResult = (result: any): { text: string; tone: "ok" | "warn" | "err" } => {
  if (result == null) return { text: "sem retorno", tone: "warn" };
  if (typeof result !== "object") return { text: String(result).slice(0, 160), tone: "ok" };
  if (result.blocked) return { text: String(result.message || "bloqueada por trava do sistema").slice(0, 200), tone: "warn" };
  if (result.error) return { text: String(typeof result.error === "string" ? result.error : JSON.stringify(result.error)).slice(0, 200), tone: "err" };
  const counts: string[] = [];
  for (const [k, v] of Object.entries(result)) {
    if (Array.isArray(v)) counts.push(`${v.length} ${k}`);
  }
  if (counts.length) return { text: counts.join(" · "), tone: "ok" };
  const keys = Object.keys(result).slice(0, 5);
  return { text: keys.length ? keys.map((k) => `${k}: ${JSON.stringify((result as any)[k])}`.slice(0, 60)).join(" · ") : "ok", tone: "ok" };
};

const argsPreview = (args: any) => {
  if (!args || typeof args !== "object") return "—";
  const entries = Object.entries(args).slice(0, 6);
  if (!entries.length) return "sem parâmetros";
  return entries.map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v).slice(0, 40) : String(v).slice(0, 40)}`).join(" · ");
};

function TraceList({ traces, onJson }: { traces: Trace[]; onJson: (d: { title: string; data: any }) => void }) {
  if (!traces.length) return <p className="text-xs text-muted-foreground italic">Nenhuma requisição HTTP registrada nesta etapa.</p>;
  return (
    <div className="space-y-2">
      {traces.map((h, i) => (
        <div key={i} className="border border-border/50 rounded-md p-2 bg-background">
          <div className="flex items-center gap-2 flex-wrap text-xs">
            <Badge variant={h.ok ? "outline" : "destructive"} className="font-mono">{h.method} {h.status ?? "ERR"}</Badge>
            <span className="font-mono break-all text-muted-foreground">{h.url}</span>
            <span className="text-muted-foreground">{h.duration_ms}ms</span>
            <Button variant="ghost" size="icon" className="h-5 w-5 ml-auto" onClick={() => onJson({ title: `${h.method} ${h.url}`, data: h })}>
              <Maximize2 className="h-3 w-3" />
            </Button>
          </div>
          {h.error && <div className="text-xs text-destructive mt-1">{h.error}</div>}
          {h.request_body && (
            <pre className="text-[11px] bg-muted p-2 rounded mt-1 whitespace-pre-wrap break-all max-h-24 overflow-auto">➜ {h.request_body}</pre>
          )}
          {h.response_body && (
            <pre className="text-[11px] bg-muted p-2 rounded mt-1 whitespace-pre-wrap break-all max-h-32 overflow-auto">⬅ {h.response_body}</pre>
          )}
        </div>
      ))}
    </div>
  );
}

function StepShell({
  icon, title, subtitle, tone = "default", children,
}: {
  icon: React.ReactNode; title: React.ReactNode; subtitle?: React.ReactNode;
  tone?: "default" | "warn" | "err"; children?: React.ReactNode;
}) {
  const ring =
    tone === "err" ? "border-destructive/50" : tone === "warn" ? "border-warning/50" : "border-border";
  return (
    <div className="relative pl-8">
      <div className={`absolute left-0 top-1.5 w-6 h-6 rounded-full border ${ring} bg-background flex items-center justify-center`}>
        {icon}
      </div>
      <div className={`rounded-lg border ${ring} p-3`}>
        <div className="flex items-center gap-2 flex-wrap">{title}</div>
        {subtitle && <div className="text-xs text-muted-foreground mt-1 break-words">{subtitle}</div>}
        {children}
      </div>
    </div>
  );
}

function ToolStep({ tc, traces, onJson }: { tc: any; traces: Trace[]; onJson: (d: { title: string; data: any }) => void }) {
  const [open, setOpen] = useState(false);
  const summary = summarizeResult(tc.result);
  const tone = tc.blocked ? "warn" : summary.tone === "err" ? "err" : "default";

  return (
    <StepShell
      tone={tone as any}
      icon={tc.blocked ? <Ban className="w-3 h-3 text-warning" /> : <Wrench className="w-3 h-3 text-primary" />}
      title={
        <>
          <span className="font-medium text-sm">{prettyToolName(tc.name)}</span>
          <span className="font-mono text-[11px] text-muted-foreground">{tc.name}</span>
          {tc.blocked && <Badge variant="outline" className="text-[10px] bg-warning/10 text-warning border-warning/50">BLOQUEADA</Badge>}
          {typeof tc.duration_ms === "number" && <span className="text-[11px] text-muted-foreground">{tc.duration_ms}ms</span>}
        </>
      }
    >
      <div className="mt-2 space-y-1 text-xs">
        <div><span className="text-muted-foreground">Consultou com:</span> <span className="font-mono">{argsPreview(tc.resolvedArgs ?? tc.args)}</span></div>
        <div>
          <span className="text-muted-foreground">Retorno:</span>{" "}
          <span className={summary.tone === "err" ? "text-destructive" : summary.tone === "warn" ? "text-warning" : "text-foreground"}>{summary.text}</span>
        </div>
        {tc.correctionReason && (
          <div className="text-warning">Correção aplicada: {tc.correctionReason}</div>
        )}
      </div>

      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="mt-2 h-7 px-2 text-xs">
            {open ? <ChevronUp className="w-3 h-3 mr-1" /> : <ChevronDown className="w-3 h-3 mr-1" />}
            {open ? "Ocultar logs" : `Mostrar logs${traces.length ? ` (${traces.length} req.)` : ""}`}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 space-y-3">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Entrada (argumentos)</span>
                <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => onJson({ title: `${tc.name} — Argumentos`, data: tc.args })}>
                  <Maximize2 className="h-3 w-3" />
                </Button>
              </div>
              <ScrollArea className="max-h-40">
                <pre className="text-xs bg-muted p-2 rounded mt-1 whitespace-pre-wrap break-all">{JSON.stringify(tc.args, null, 2)}</pre>
              </ScrollArea>
            </div>
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Saída (resultado)</span>
                <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => onJson({ title: `${tc.name} — Resultado`, data: tc.result })}>
                  <Maximize2 className="h-3 w-3" />
                </Button>
              </div>
              <ScrollArea className="max-h-40">
                <pre className="text-xs bg-muted p-2 rounded mt-1 whitespace-pre-wrap break-all">{JSON.stringify(tc.result, null, 2)}</pre>
              </ScrollArea>
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1"><Globe className="w-3 h-3" /> Requisições HTTP desta ferramenta</div>
            <TraceList traces={traces} onJson={onJson} />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </StepShell>
  );
}

function OtherTracesStep({ traces, onJson }: { traces: Trace[]; onJson: (d: { title: string; data: any }) => void }) {
  const [open, setOpen] = useState(false);
  if (!traces.length) return null;
  return (
    <StepShell
      icon={<Globe className="w-3 h-3 text-muted-foreground" />}
      title={<span className="font-medium text-sm">Outras requisições ({traces.length})</span>}
      subtitle="Chamadas HTTP que não pertencem a nenhuma ferramenta específica."
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="mt-2 h-7 px-2 text-xs">
            {open ? "Ocultar logs" : "Mostrar logs"}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2"><TraceList traces={traces} onJson={onJson} /></CollapsibleContent>
      </Collapsible>
    </StepShell>
  );
}

function LogTimeline({ log, onJson }: { log: AgentLog; onJson: (d: { title: string; data: any }) => void }) {
  const traces: Trace[] = Array.isArray(log.http_trace) ? (log.http_trace as Trace[]) : [];
  const toolCalls = (Array.isArray(log.tool_calls) ? log.tool_calls : []).filter((tc: any) => tc?.name !== "__debounce_batch__");

  const { rounds, usedSeq } = useMemo(() => {
    const used = new Set<number>();
    const llmCalls = traces.filter((t) => classifyTrace(t) === "llm");
    const byRound = new Map<number, { llm: Trace | null; tools: { tc: any; traces: Trace[] }[] }>();

    const orderedTools = toolCalls.map((tc: any, i: number) => ({ tc, i }));
    for (const { tc } of orderedTools) {
      const r = typeof tc.round === "number" ? tc.round : 1;
      if (!byRound.has(r)) byRound.set(r, { llm: null, tools: [] });
      const from = typeof tc.trace_from === "number" ? tc.trace_from : null;
      const to = typeof tc.trace_to === "number" ? tc.trace_to : null;
      const own = from !== null && to !== null
        ? traces.filter((t) => t.seq >= from && t.seq <= to && classifyTrace(t) !== "llm")
        : [];
      own.forEach((t) => used.add(t.seq));
      byRound.get(r)!.tools.push({ tc, traces: own });
    }

    // Cada rodada r consome a r-ésima chamada ao modelo.
    const roundKeys = Array.from(byRound.keys()).sort((a, b) => a - b);
    roundKeys.forEach((r, idx) => {
      const llm = llmCalls[idx] ?? null;
      if (llm) used.add(llm.seq);
      byRound.get(r)!.llm = llm;
    });
    // Última chamada ao modelo (a que gerou a resposta final) fica fora das rodadas.
    return { rounds: roundKeys.map((r) => ({ round: r, ...byRound.get(r)! })), usedSeq: used };
  }, [log.id]);

  const finalLlm = traces.filter((t) => classifyTrace(t) === "llm" && !usedSeq.has(t.seq));
  const sendTraces = traces.filter((t) => classifyTrace(t) === "whatsapp" && !usedSeq.has(t.seq));
  const leftovers = traces.filter(
    (t) => !usedSeq.has(t.seq) && !finalLlm.includes(t) && !sendTraces.includes(t),
  );

  return (
    <div className="space-y-3 border-l border-border/60 ml-3 pl-0">
      <StepShell
        icon={<MessageSquare className="w-3 h-3 text-muted-foreground" />}
        title={<span className="font-medium text-sm">1. Cliente enviou</span>}
      >
        <div className="mt-2 bg-muted rounded p-2 text-sm whitespace-pre-wrap">{log.user_message}</div>
      </StepShell>

      {rounds.map((r, idx) => (
        <div key={r.round} className="space-y-3">
          <StepShell
            icon={<Brain className="w-3 h-3 text-primary" />}
            title={
              <>
                <span className="font-medium text-sm">{idx + 2}. IA decidiu (rodada {r.round})</span>
                {r.llm && <span className="text-[11px] text-muted-foreground">{r.llm.duration_ms}ms · {r.llm.status}</span>}
              </>
            }
            subtitle={`Escolheu ${r.tools.length} ferramenta${r.tools.length > 1 ? "s" : ""}: ${r.tools.map((t) => t.tc.name).join(", ") || "—"}`}
          >
            {r.llm && (
              <Button variant="ghost" size="sm" className="mt-2 h-7 px-2 text-xs" onClick={() => onJson({ title: `Chamada ao modelo (rodada ${r.round})`, data: r.llm })}>
                <Maximize2 className="h-3 w-3 mr-1" /> Ver chamada ao modelo
              </Button>
            )}
          </StepShell>
          <div className="space-y-3 pl-4">
            {r.tools.map((t, i) => (
              <ToolStep key={i} tc={t.tc} traces={t.traces} onJson={onJson} />
            ))}
          </div>
        </div>
      ))}

      {finalLlm.length > 0 && (
        <StepShell
          icon={<Brain className="w-3 h-3 text-primary" />}
          title={<span className="font-medium text-sm">{rounds.length + 2}. IA escreveu a resposta</span>}
          subtitle={`${finalLlm.length} chamada(s) ao modelo`}
        >
          <Button variant="ghost" size="sm" className="mt-2 h-7 px-2 text-xs" onClick={() => onJson({ title: "Chamadas finais ao modelo", data: finalLlm })}>
            <Maximize2 className="h-3 w-3 mr-1" /> Ver chamadas
          </Button>
        </StepShell>
      )}

      <StepShell
        icon={<Send className="w-3 h-3 text-accent" />}
        title={
          <>
            <span className="font-medium text-sm">Resposta enviada ao cliente</span>
            {sendTraces.length > 0 && (
              <Badge variant={sendTraces.every((t) => t.ok) ? "outline" : "destructive"} className="text-[10px]">
                WhatsApp {sendTraces.map((t) => t.status ?? "ERR").join(", ")}
              </Badge>
            )}
          </>
        }
      >
        <div className="mt-2 bg-primary/5 border border-primary/20 rounded p-2 text-sm whitespace-pre-wrap">{log.ai_response || "—"}</div>
        {sendTraces.length > 0 && (
          <div className="mt-2"><TraceList traces={sendTraces} onJson={onJson} /></div>
        )}
      </StepShell>

      <OtherTracesStep traces={leftovers} onJson={onJson} />
    </div>
  );
}

/** Monitor simples: só o essencial — mensagem, ferramentas (args/resultado) e resposta. */
function LogSimple({ log, onJson }: { log: AgentLog; onJson: (d: { title: string; data: any }) => void }) {
  const toolCalls = (Array.isArray(log.tool_calls) ? log.tool_calls : []).filter((tc: any) => tc?.name !== "__debounce_batch__");
  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-2">Mensagem do cliente</h4>
        <div className="bg-muted rounded p-3 text-sm whitespace-pre-wrap">{log.user_message}</div>
      </div>

      {toolCalls.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-2">Ferramentas usadas</h4>
          <div className="space-y-2">
            {toolCalls.map((tc: any, i: number) => {
              const summary = summarizeResult(tc.result);
              return (
                <div key={i} className="rounded-lg border border-border p-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Wrench className="w-3 h-3 text-primary" />
                    <span className="font-medium text-sm">{prettyToolName(tc.name)}</span>
                    {tc.blocked && <Badge variant="outline" className="text-[10px] bg-warning/10 text-warning border-warning/50">BLOQUEADA</Badge>}
                    <Button variant="ghost" size="icon" className="h-5 w-5 ml-auto" onClick={() => onJson({ title: tc.name, data: tc })}>
                      <Maximize2 className="h-3 w-3" />
                    </Button>
                  </div>
                  <div className="mt-1 text-xs space-y-1">
                    <div><span className="text-muted-foreground">Consultou com:</span> <span className="font-mono">{argsPreview(tc.resolvedArgs ?? tc.args)}</span></div>
                    <div>
                      <span className="text-muted-foreground">Retorno:</span>{" "}
                      <span className={summary.tone === "err" ? "text-destructive" : summary.tone === "warn" ? "text-warning" : "text-foreground"}>{summary.text}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div>
        <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-2">Resposta da IA</h4>
        <div className="bg-primary/5 border border-primary/20 rounded p-3 text-sm whitespace-pre-wrap">{log.ai_response || "—"}</div>
      </div>
    </div>
  );
}

export default function AgentLogsPage() {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filterPhone, setFilterPhone] = useState("");
  const [filterStatus, setFilterStatus] = useState<"all" | "errors" | "blocked">("all");
  const [page, setPage] = useState(0);
  const [jsonDialog, setJsonDialog] = useState<{ title: string; data: any } | null>(null);
  const PAGE_SIZE = 20;

  const { data: tenants } = useQuery({
    queryKey: ["tenants-for-logs"],
    queryFn: async () => {
      const { data } = await supabase.from("tenants").select("id, name");
      return data || [];
    },
  });

  const [selectedTenant, setSelectedTenant] = useState<string>("all");

  const { data: logs, isLoading } = useQuery({
    queryKey: ["agent-logs", selectedTenant, filterPhone, filterStatus, page],
    queryFn: async () => {
      let query = supabase
        .from("agent_logs")
        .select("*")
        .order("created_at", { ascending: false })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

      if (selectedTenant !== "all") query = query.eq("tenant_id", selectedTenant);
      if (filterPhone.trim()) query = query.ilike("phone_number", `%${filterPhone.trim()}%`);
      if (filterStatus === "errors") query = query.not("errors", "eq", "[]");
      if (filterStatus === "blocked") query = query.eq("session_blocked", true);

      const { data, error } = await query;
      if (error) throw error;
      return (data || []) as unknown as AgentLog[];
    },
    refetchInterval: 15000,
  });

  const tenantMap = new Map(tenants?.map((t) => [t.id, t.name]) || []);
  const toggleExpand = (id: string) => setExpandedId(expandedId === id ? null : id);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Monitor do Agente</h1>
        <p className="text-muted-foreground mt-1">Passo a passo do que a IA fez em cada interação</p>
      </div>

      <div className="flex flex-wrap gap-3">
        <Select value={selectedTenant} onValueChange={(v) => { setSelectedTenant(v); setPage(0); }}>
          <SelectTrigger className="w-[200px]"><SelectValue placeholder="Todos os tenants" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os tenants</SelectItem>
            {tenants?.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
          </SelectContent>
        </Select>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Filtrar por telefone..."
            value={filterPhone}
            onChange={(e) => { setFilterPhone(e.target.value); setPage(0); }}
            className="pl-9 w-[200px]"
          />
        </div>

        <Select value={filterStatus} onValueChange={(v: any) => { setFilterStatus(v); setPage(0); }}>
          <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas as execuções</SelectItem>
            <SelectItem value="errors">Com erros</SelectItem>
            <SelectItem value="blocked">Bloqueadas (duplicata)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">Carregando logs...</p>
      ) : !logs?.length ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Nenhum log encontrado. Os logs aparecerão aqui quando clientes interagirem com a IA.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {logs.map((log) => {
            const normalizedErrors = (Array.isArray(log.errors) ? log.errors : []).map((e: any) =>
              typeof e === "string"
                ? { message: e, level: "error" as const }
                : { message: e?.message ?? JSON.stringify(e), level: (e?.level === "warning" ? "warning" : "error") as "error" | "warning" }
            );
            const realErrors = normalizedErrors.filter((e) => e.level === "error");
            const warnings = normalizedErrors.filter((e) => e.level === "warning");
            const hasErrors = realErrors.length > 0;
            const hasWarnings = warnings.length > 0;
            const toolCalls = Array.isArray(log.tool_calls) ? (log.tool_calls as any[]) : [];
            const { debounceBatch, hasExactTiming, totalMs, debounceMs, aiMs, uazapiMs } = getTimingMetrics(log);
            const batchMessages = Array.isArray(debounceBatch?.args?.messages) ? debounceBatch.args.messages : [];
            const toolCount = toolCalls.filter((tc) => tc?.name !== "__debounce_batch__").length;
            const isExpanded = expandedId === log.id;

            return (
              <Card key={log.id} className={hasErrors ? "border-destructive/50" : hasWarnings ? "border-warning/50" : ""}>
                <CardHeader className="cursor-pointer pb-3" onClick={() => toggleExpand(log.id)}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 min-w-0">
                      {hasErrors ? <AlertTriangle className="w-5 h-5 text-destructive shrink-0" />
                        : hasWarnings ? <AlertTriangle className="w-5 h-5 text-warning shrink-0" />
                        : <CheckCircle className="w-5 h-5 text-accent shrink-0" />}
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-sm text-muted-foreground flex items-center gap-1">
                            <Phone className="w-3 h-3" />{log.phone_number}
                          </span>
                          <Badge variant="outline" className="text-xs">{tenantMap.get(log.tenant_id) || "—"}</Badge>
                          {log.session_blocked && <Badge variant="destructive" className="text-xs">Bloqueada</Badge>}
                          {toolCount > 0 && (
                            <Badge variant="secondary" className="text-xs flex items-center gap-1">
                              <Wrench className="w-3 h-3" />{toolCount} tool{toolCount > 1 ? "s" : ""}
                            </Badge>
                          )}
                          {hasErrors && <Badge variant="destructive" className="text-xs">{realErrors.length} erro{realErrors.length > 1 ? "s" : ""}</Badge>}
                          {hasWarnings && <Badge variant="outline" className="text-xs bg-warning/10 text-warning border-warning/50">{warnings.length} aviso{warnings.length > 1 ? "s" : ""}</Badge>}
                        </div>
                        <p className="text-sm text-foreground mt-1 truncate max-w-lg">
                          <span className="text-muted-foreground">Cliente:</span> {log.user_message}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <div className="text-right text-xs text-muted-foreground">
                        <div>{format(new Date(log.created_at), "dd/MM HH:mm:ss", { locale: ptBR })}</div>
                        {hasExactTiming && totalMs > 0 && (
                          <div className="flex items-center gap-1 justify-end">
                            <Clock className="w-3 h-3" />{(totalMs / 1000).toFixed(1)}s total
                          </div>
                        )}
                      </div>
                      {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </div>
                  </div>
                </CardHeader>

                {isExpanded && (
                  <CardContent className="space-y-4 pt-0">
                    {batchMessages.length > 0 && (
                      <div>
                        <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-2">Mensagens recebidas no lote</h4>
                        <div className="space-y-2">
                          {batchMessages.map((message: any, index: number) => (
                            <div key={`${message.created_at}-${index}`} className="rounded-lg border border-border bg-background p-3 text-sm">
                              <div className="text-xs text-muted-foreground mb-1">
                                {message.created_at ? format(new Date(message.created_at), "dd/MM HH:mm:ss", { locale: ptBR }) : "Sem horário"}
                              </div>
                              <div className="whitespace-pre-wrap">{message.content || "—"}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <LogTimeline log={log} onJson={setJsonDialog} />

                    {hasErrors && (
                      <div>
                        <h4 className="text-xs font-semibold text-destructive uppercase mb-2">Erros</h4>
                        <div className="space-y-1">
                          {realErrors.map((err, i) => (
                            <div key={i} className="bg-destructive/10 text-destructive text-sm p-2 rounded">{err.message}</div>
                          ))}
                        </div>
                      </div>
                    )}

                    {hasWarnings && (
                      <div>
                        <h4 className="text-xs font-semibold text-warning uppercase mb-2">Avisos (sem ação necessária)</h4>
                        <div className="space-y-1">
                          {warnings.map((err, i) => (
                            <div key={i} className="bg-warning/10 text-warning text-sm p-2 rounded">{err.message}</div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1"><Bot className="w-3 h-3" /> Modelo: {log.model_used || "—"}</span>
                      {hasExactTiming ? (
                        <>
                          {totalMs > 0 && <span><strong>Total (cliente esperou):</strong> {(totalMs / 1000).toFixed(1)}s</span>}
                          {debounceMs > 0 && <span>Espera (debounce): {(debounceMs / 1000).toFixed(1)}s</span>}
                          {aiMs > 0 && <span>Processamento IA: {(aiMs / 1000).toFixed(1)}s</span>}
                          {uazapiMs !== null && uazapiMs > 0 && <span>Envio WhatsApp: {(uazapiMs / 1000).toFixed(1)}s</span>}
                        </>
                      ) : (
                        <span>Esse log foi salvo antes da correção de tempo exato.</span>
                      )}
                    </div>
                  </CardContent>
                )}
              </Card>
            );
          })}

          <div className="flex justify-center gap-2 pt-4">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Anterior</Button>
            <span className="text-sm text-muted-foreground flex items-center px-3">Página {page + 1}</span>
            <Button variant="outline" size="sm" disabled={(logs?.length || 0) < PAGE_SIZE} onClick={() => setPage(page + 1)}>Próxima</Button>
          </div>
        </div>
      )}

      <Dialog open={!!jsonDialog} onOpenChange={() => setJsonDialog(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">{jsonDialog?.title}</DialogTitle>
          </DialogHeader>
          <ScrollArea className="max-h-[65vh]">
            <pre className="text-xs bg-muted p-4 rounded whitespace-pre-wrap break-words">
              {jsonDialog ? JSON.stringify(jsonDialog.data, null, 2) : ""}
            </pre>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  );
}
