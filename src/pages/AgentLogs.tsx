import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertTriangle, CheckCircle, Clock, ChevronDown, ChevronUp, Search, Phone, Bot, Wrench, Maximize2 } from "lucide-react";
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
  model_used: string | null;
  duration_ms: number | null;
  session_blocked: boolean;
  created_at: string;
}

const getTimingMetrics = (log: AgentLog) => {
  const toolCalls = Array.isArray(log.tool_calls) ? (log.tool_calls as any[]) : [];
  const debounceBatch = toolCalls.find((tc) => tc?.name === "__debounce_batch__");
  const result = debounceBatch?.result || {};
  const num = (v: any) => (typeof v === "number" && Number.isFinite(v) ? v : null);

  // New fields (post-fix)
  const totalResponseMs = num(result.total_response_ms);
  const debounceWaitMs = num(result.debounce_wait_ms);
  const aiProcessingMs = num(result.ai_processing_ms);
  const uazapiSendMs = num(result.uazapi_send_ms);

  const hasExactTiming = totalResponseMs !== null;

  return {
    debounceBatch,
    hasExactTiming,
    totalMs: totalResponseMs ?? 0,
    debounceMs: debounceWaitMs ?? 0,
    aiMs: aiProcessingMs ?? 0,
    uazapiMs: uazapiSendMs,
  };
};

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

      if (selectedTenant !== "all") {
        query = query.eq("tenant_id", selectedTenant);
      }
      if (filterPhone.trim()) {
        query = query.ilike("phone_number", `%${filterPhone.trim()}%`);
      }
      if (filterStatus === "errors") {
        query = query.not("errors", "eq", "[]");
      }
      if (filterStatus === "blocked") {
        query = query.eq("session_blocked", true);
      }

      const { data, error } = await query;
      if (error) throw error;
      return (data || []) as AgentLog[];
    },
    refetchInterval: 15000,
  });

  const tenantMap = new Map(tenants?.map((t) => [t.id, t.name]) || []);

  const toggleExpand = (id: string) => {
    setExpandedId(expandedId === id ? null : id);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Monitor do Agente</h1>
        <p className="text-muted-foreground mt-1">Veja exatamente o que a IA fez em cada interação</p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <Select value={selectedTenant} onValueChange={(v) => { setSelectedTenant(v); setPage(0); }}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Todos os tenants" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os tenants</SelectItem>
            {tenants?.map((t) => (
              <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
            ))}
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
          <SelectTrigger className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas as execuções</SelectItem>
            <SelectItem value="errors">Com erros</SelectItem>
            <SelectItem value="blocked">Bloqueadas (duplicata)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Logs list */}
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
            const hasErrors = Array.isArray(log.errors) && log.errors.length > 0;
            const toolCalls = Array.isArray(log.tool_calls) ? (log.tool_calls as any[]) : [];
            const { debounceBatch, totalMs, debounceMs, aiMs, uazapiMs } = getTimingMetrics(log);
            const batchMessages = Array.isArray(debounceBatch?.args?.messages) ? debounceBatch.args.messages : [];
            const visibleToolCalls = toolCalls.filter((tc) => tc?.name !== "__debounce_batch__");
            const toolCount = visibleToolCalls.length;
            const isExpanded = expandedId === log.id;

            return (
              <Card key={log.id} className={hasErrors ? "border-destructive/50" : ""}>
                <CardHeader
                  className="cursor-pointer pb-3"
                  onClick={() => toggleExpand(log.id)}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 min-w-0">
                      {hasErrors ? (
                        <AlertTriangle className="w-5 h-5 text-destructive shrink-0" />
                      ) : (
                        <CheckCircle className="w-5 h-5 text-accent shrink-0" />
                      )}
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-sm text-muted-foreground flex items-center gap-1">
                            <Phone className="w-3 h-3" />
                            {log.phone_number}
                          </span>
                          <Badge variant="outline" className="text-xs">
                            {tenantMap.get(log.tenant_id) || "—"}
                          </Badge>
                          {log.session_blocked && (
                            <Badge variant="destructive" className="text-xs">Bloqueada</Badge>
                          )}
                          {toolCount > 0 && (
                            <Badge variant="secondary" className="text-xs flex items-center gap-1">
                              <Wrench className="w-3 h-3" />
                              {toolCount} tool{toolCount > 1 ? "s" : ""}
                            </Badge>
                          )}
                          {hasErrors && (
                            <Badge variant="destructive" className="text-xs">
                              {log.errors.length} erro{log.errors.length > 1 ? "s" : ""}
                            </Badge>
                          )}
                        </div>
                        <p className="text-sm text-foreground mt-1 truncate max-w-lg">
                          <span className="text-muted-foreground">Cliente:</span> {log.user_message}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                    <div className="text-right text-xs text-muted-foreground">
                        <div>{format(new Date(log.created_at), "dd/MM HH:mm:ss", { locale: ptBR }) }</div>
                      {totalMs > 0 && (
                        <div className="flex items-center gap-1 justify-end" title="Tempo total que o cliente esperou: da última mensagem dele até a primeira parte enviada pela UAZAPI">
                          <Clock className="w-3 h-3" />
                          {(totalMs / 1000).toFixed(1)}s total
                        </div>
                      )}
                    </div>
                      {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </div>
                  </div>
                </CardHeader>

                {isExpanded && (
                  <CardContent className="space-y-4 pt-0">
                    {/* User message */}
                    <div>
                      <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-1">Mensagem do cliente</h4>
                      <div className="bg-muted rounded-lg p-3 text-sm">{log.user_message}</div>
                      {batchMessages.length > 0 && (
                        <div className="mt-3 space-y-2">
                          <h5 className="text-xs font-semibold text-muted-foreground uppercase">Mensagens recebidas no lote</h5>
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
                    </div>

                    {/* Tool calls */}
                    {toolCount > 0 && (
                      <div>
                        <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-2">
                          Ferramentas chamadas ({toolCount})
                        </h4>
                        <div className="space-y-2">
                          {visibleToolCalls.map((tc, i) => (
                            <div key={i} className={`rounded-lg border p-3 text-sm ${tc.blocked ? "border-destructive/50 bg-destructive/5" : "border-border"}`}>
                              <div className="flex items-center gap-2 mb-2">
                                <Wrench className="w-4 h-4 text-primary" />
                                <span className="font-mono font-medium">{tc.name}</span>
                                {tc.blocked && <Badge variant="destructive" className="text-xs">BLOQUEADA</Badge>}
                              </div>
                              <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                                <div>
                                  <div className="flex items-center justify-between">
                                    <span className="text-xs text-muted-foreground">Argumentos:</span>
                                    <Button variant="ghost" size="icon" className="h-5 w-5" onClick={(e) => { e.stopPropagation(); setJsonDialog({ title: `${tc.name} — Argumentos`, data: tc.args }); }}>
                                      <Maximize2 className="h-3 w-3" />
                                    </Button>
                                  </div>
                                  <ScrollArea className="max-h-40">
                                    <pre className="text-xs bg-muted p-2 rounded mt-1 overflow-x-auto whitespace-pre-wrap">
                                      {JSON.stringify(tc.args, null, 2)}
                                    </pre>
                                  </ScrollArea>
                                </div>
                                <div>
                                  <div className="flex items-center justify-between">
                                    <span className="text-xs text-muted-foreground">Resultado:</span>
                                    <Button variant="ghost" size="icon" className="h-5 w-5" onClick={(e) => { e.stopPropagation(); setJsonDialog({ title: `${tc.name} — Resultado`, data: tc.result }); }}>
                                      <Maximize2 className="h-3 w-3" />
                                    </Button>
                                  </div>
                                  <ScrollArea className="max-h-40">
                                    <pre className="text-xs bg-muted p-2 rounded mt-1 overflow-x-auto whitespace-pre-wrap">
                                      {JSON.stringify(tc.result, null, 2)}
                                    </pre>
                                  </ScrollArea>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Errors */}
                    {hasErrors && (
                      <div>
                        <h4 className="text-xs font-semibold text-destructive uppercase mb-2">Erros</h4>
                        <div className="space-y-1">
                          {(log.errors as string[]).map((err, i) => (
                            <div key={i} className="bg-destructive/10 text-destructive text-sm p-2 rounded">
                              {typeof err === "string" ? err : JSON.stringify(err)}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* AI Response */}
                    <div>
                      <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-1 flex items-center gap-1">
                        <Bot className="w-3 h-3" /> Resposta da IA
                      </h4>
                      <div className="bg-primary/5 border border-primary/20 rounded-lg p-3 text-sm whitespace-pre-wrap">
                        {log.ai_response || "—"}
                      </div>
                    </div>

                    {/* Meta */}
                    <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                      <span>Modelo: {log.model_used || "—"}</span>
                      {totalMs > 0 && <span><strong>Total (cliente esperou):</strong> {(totalMs / 1000).toFixed(1)}s</span>}
                      {debounceMs > 0 && <span>Espera (debounce): {(debounceMs / 1000).toFixed(1)}s</span>}
                      {aiMs > 0 && <span>Processamento IA: {(aiMs / 1000).toFixed(1)}s</span>}
                      {uazapiMs !== null && uazapiMs > 0 && <span>Envio WhatsApp: {(uazapiMs / 1000).toFixed(1)}s</span>}
                    </div>
                  </CardContent>
                )}
              </Card>
            );
          })}

          {/* Pagination */}
          <div className="flex justify-center gap-2 pt-4">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
              Anterior
            </Button>
            <span className="text-sm text-muted-foreground flex items-center px-3">
              Página {page + 1}
            </span>
            <Button variant="outline" size="sm" disabled={(logs?.length || 0) < PAGE_SIZE} onClick={() => setPage(page + 1)}>
              Próxima
            </Button>
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
