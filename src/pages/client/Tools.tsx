import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ChevronDown, ChevronUp, Search, Phone, Wrench, Maximize2, Clock } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

interface AgentLog {
  id: string;
  phone_number: string;
  user_message: string;
  ai_response: string | null;
  tool_calls: any[];
  created_at: string;
}

export default function ClientTools() {
  const { tenantId } = useAuth();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filterPhone, setFilterPhone] = useState("");
  const [page, setPage] = useState(0);
  const [jsonDialog, setJsonDialog] = useState<{ title: string; data: any } | null>(null);
  const PAGE_SIZE = 20;

  const { data: logs, isLoading } = useQuery({
    queryKey: ["client-agent-logs", tenantId, filterPhone, page],
    enabled: !!tenantId,
    refetchInterval: 15000,
    queryFn: async () => {
      let q = supabase
        .from("agent_logs")
        .select("id,phone_number,user_message,ai_response,tool_calls,created_at")
        .eq("tenant_id", tenantId!)
        .order("created_at", { ascending: false })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
      if (filterPhone.trim()) q = q.ilike("phone_number", `%${filterPhone.trim()}%`);
      const { data, error } = await q;
      if (error) throw error;
      return (data || []) as AgentLog[];
    },
  });

  // Only logs that actually have tool calls (excluding internal debounce batch)
  const filtered = (logs ?? []).map((l) => {
    const tools = Array.isArray(l.tool_calls) ? l.tool_calls : [];
    return { ...l, visibleTools: tools.filter((tc: any) => tc?.name !== "__debounce_batch__") };
  }).filter((l) => l.visibleTools.length > 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Ferramentas da IA</h1>
        <p className="text-muted-foreground mt-1">
          Veja exatamente quais ações sua IA executou em cada conversa
        </p>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Filtrar por telefone..."
          value={filterPhone}
          onChange={(e) => { setFilterPhone(e.target.value); setPage(0); }}
          className="pl-9"
        />
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">Carregando...</p>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Nenhuma execução de ferramenta encontrada nesta página.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((log) => {
            const isExpanded = expandedId === log.id;
            const toolCount = log.visibleTools.length;

            return (
              <Card key={log.id}>
                <CardHeader
                  className="cursor-pointer pb-3"
                  onClick={() => setExpandedId(isExpanded ? null : log.id)}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <Wrench className="w-5 h-5 text-primary shrink-0" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-sm text-muted-foreground flex items-center gap-1">
                            <Phone className="w-3 h-3" />{log.phone_number}
                          </span>
                          <Badge variant="secondary" className="text-xs">
                            {toolCount} ferramenta{toolCount > 1 ? "s" : ""}
                          </Badge>
                          {log.visibleTools.slice(0, 3).map((tc: any, i: number) => (
                            <Badge key={i} variant="outline" className="text-xs font-mono">
                              {tc.name}
                            </Badge>
                          ))}
                        </div>
                        <p className="text-sm text-foreground mt-1 truncate max-w-lg">
                          <span className="text-muted-foreground">Cliente:</span> {log.user_message}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <div className="text-right text-xs text-muted-foreground flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {format(new Date(log.created_at), "dd/MM HH:mm", { locale: ptBR })}
                      </div>
                      {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </div>
                  </div>
                </CardHeader>

                {isExpanded && (
                  <CardContent className="space-y-3 pt-0">
                    {log.visibleTools.map((tc: any, i: number) => (
                      <div key={i} className="rounded-lg border border-border p-3 text-sm">
                        <div className="flex items-center gap-2 mb-2">
                          <Wrench className="w-4 h-4 text-primary" />
                          <span className="font-mono font-medium">{tc.name}</span>
                          {tc.blocked && <Badge variant="destructive" className="text-xs">BLOQUEADA</Badge>}
                        </div>
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                          <div>
                            <div className="flex items-center justify-between">
                              <span className="text-xs text-muted-foreground">Argumentos:</span>
                              <Button variant="ghost" size="icon" className="h-5 w-5"
                                onClick={(e) => { e.stopPropagation(); setJsonDialog({ title: `${tc.name} — Argumentos`, data: tc.args }); }}>
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
                              <Button variant="ghost" size="icon" className="h-5 w-5"
                                onClick={(e) => { e.stopPropagation(); setJsonDialog({ title: `${tc.name} — Resultado`, data: tc.result }); }}>
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
                    {log.ai_response && (
                      <div>
                        <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-1">Resposta da IA</h4>
                        <div className="bg-primary/5 border border-primary/20 rounded-lg p-3 text-sm whitespace-pre-wrap">
                          {log.ai_response}
                        </div>
                      </div>
                    )}
                  </CardContent>
                )}
              </Card>
            );
          })}

          <div className="flex justify-center gap-2 pt-4">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
              Anterior
            </Button>
            <span className="text-sm text-muted-foreground flex items-center px-3">Página {page + 1}</span>
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
