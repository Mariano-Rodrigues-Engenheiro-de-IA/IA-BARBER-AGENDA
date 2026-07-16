import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import MetaCostPanel from "@/components/MetaCostPanel";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";

type LogRow = {
  id: string;
  created_at: string;
  action: string;
  entity: string | null;
  entity_id: string | null;
  user_id: string | null;
  actor_role: string | null;
  tenant_id: string | null;
  before: any;
  after: any;
};

const ACTION_LABELS: Record<string, string> = {
  tenant_created: "Empresa criada",
  tenant_updated_multi: "Empresa atualizada (várias mudanças)",
  prompt_updated: "Prompt da IA editado",
  knowledge_updated: "Base de conhecimento editada",
  agent_paused: "Agente pausado",
  agent_resumed: "Agente despausado",
  visibility_changed: "Visibilidade alterada",
  integrations_updated: "Integrações/tokens alterados",
  status_changed: "Status da empresa alterado",
  staff_access_granted: "Colaborador ganhou acesso a empresa",
  staff_access_revoked: "Colaborador perdeu acesso a empresa",
  module_access_granted: "Colaborador ganhou aba do painel",
  module_access_revoked: "Colaborador perdeu aba do painel",
  lead_moved: "Lead movido no CRM",
  invite_staff: "Colaborador criado",
  delete_staff: "Colaborador removido",
};

function labelAction(a: string) { return ACTION_LABELS[a] ?? a; }

export default function AuditPage() {
  const [tab, setTab] = useState("logs");
  const [actorFilter, setActorFilter] = useState<string>("all");
  const [tenantFilter, setTenantFilter] = useState<string>("all");
  const [actionFilter, setActionFilter] = useState<string>("all");
  const [days, setDays] = useState<number>(30);
  const [detail, setDetail] = useState<LogRow | null>(null);

  const since = useMemo(() => new Date(Date.now() - days * 86400_000).toISOString(), [days]);

  const { data: logs, isLoading } = useQuery({
    queryKey: ["audit-logs", days],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("audit_logs")
        .select("*")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(1000);
      if (error) throw error;
      return (data ?? []) as LogRow[];
    },
  });

  const { data: tenants } = useQuery({
    queryKey: ["audit-tenants"],
    queryFn: async () => {
      const { data } = await supabase.from("tenants").select("id,name").order("name");
      return (data ?? []) as { id: string; name: string }[];
    },
  });

  const actorIds = useMemo(() => {
    const s = new Set<string>();
    for (const l of logs ?? []) if (l.user_id) s.add(l.user_id);
    return Array.from(s);
  }, [logs]);

  const { data: actorEmails } = useQuery({
    queryKey: ["audit-actor-emails", actorIds.sort().join(",")],
    enabled: actorIds.length > 0,
    queryFn: async () => {
      const { data } = await supabase.functions.invoke("admin-manage-staff", {
        body: { action: "resolve_users", user_ids: actorIds },
      });
      return ((data as any)?.users ?? {}) as Record<string, string | null>;
    },
  });

  const tenantName = (id: string | null) => tenants?.find((t) => t.id === id)?.name ?? (id ? id.slice(0, 8) : "—");
  const actorName = (id: string | null) => (id && actorEmails?.[id]) || (id ? id.slice(0, 8) : "sistema");

  const actionsInData = useMemo(() => {
    const s = new Set<string>();
    for (const l of logs ?? []) s.add(l.action);
    return Array.from(s).sort();
  }, [logs]);

  const filtered = (logs ?? []).filter((l) => {
    if (actorFilter !== "all" && l.user_id !== actorFilter) return false;
    if (tenantFilter !== "all" && l.tenant_id !== tenantFilter) return false;
    if (actionFilter !== "all" && l.action !== actionFilter) return false;
    return true;
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Auditoria</h1>
        <p className="text-muted-foreground">Trilha de ações da equipe e custo estimado da API Meta</p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="logs">Ações da equipe</TabsTrigger>
          <TabsTrigger value="meta">Custo Meta</TabsTrigger>
        </TabsList>

        <TabsContent value="logs" className="space-y-4">
          <div className="glass-card p-4 grid gap-3 md:grid-cols-4">
            <div>
              <Label className="text-xs">Período</Label>
              <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="7">Últimos 7 dias</SelectItem>
                  <SelectItem value="30">Últimos 30 dias</SelectItem>
                  <SelectItem value="90">Últimos 90 dias</SelectItem>
                  <SelectItem value="365">Último ano</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Colaborador</Label>
              <Select value={actorFilter} onValueChange={setActorFilter}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  {actorIds.map((id) => (
                    <SelectItem key={id} value={id}>{actorName(id)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Empresa</Label>
              <Select value={tenantFilter} onValueChange={setTenantFilter}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas</SelectItem>
                  {(tenants ?? []).map((t) => (
                    <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Tipo de ação</Label>
              <Select value={actionFilter} onValueChange={setActionFilter}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas</SelectItem>
                  {actionsInData.map((a) => (
                    <SelectItem key={a} value={a}>{labelAction(a)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="glass-card p-4">
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Carregando...</p>
            ) : filtered.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhum registro no período/filtro selecionado.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs uppercase text-muted-foreground border-b border-border">
                    <tr>
                      <th className="text-left py-2 pr-4">Quando</th>
                      <th className="text-left py-2 pr-4">Quem</th>
                      <th className="text-left py-2 pr-4">Ação</th>
                      <th className="text-left py-2 pr-4">Empresa</th>
                      <th className="text-right py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((l) => (
                      <tr key={l.id} className="border-b border-border/40">
                        <td className="py-2 pr-4 text-muted-foreground text-xs whitespace-nowrap">
                          {formatDistanceToNow(new Date(l.created_at), { addSuffix: true, locale: ptBR })}
                        </td>
                        <td className="py-2 pr-4">
                          <div className="flex items-center gap-2">
                            <span>{actorName(l.user_id)}</span>
                            {l.actor_role && <Badge variant="outline" className="text-[10px]">{l.actor_role}</Badge>}
                          </div>
                        </td>
                        <td className="py-2 pr-4 font-medium text-foreground">{labelAction(l.action)}</td>
                        <td className="py-2 pr-4 text-muted-foreground">{tenantName(l.tenant_id)}</td>
                        <td className="py-2 text-right">
                          <Button variant="ghost" size="sm" onClick={() => setDetail(l)}>Detalhes</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="meta">
          <MetaCostPanel />
        </TabsContent>
      </Tabs>

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{detail ? labelAction(detail.action) : ""}</DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div><span className="text-muted-foreground">Quando:</span> {new Date(detail.created_at).toLocaleString("pt-BR")}</div>
                <div><span className="text-muted-foreground">Quem:</span> {actorName(detail.user_id)}</div>
                <div><span className="text-muted-foreground">Empresa:</span> {tenantName(detail.tenant_id)}</div>
                <div><span className="text-muted-foreground">Entidade:</span> {detail.entity ?? "—"}</div>
              </div>
              <div className="grid md:grid-cols-2 gap-3">
                <div>
                  <div className="text-xs font-semibold text-muted-foreground mb-1">Antes</div>
                  <pre className="bg-muted/40 rounded p-3 text-xs overflow-auto max-h-96 whitespace-pre-wrap">
                    {detail.before ? JSON.stringify(detail.before, null, 2) : "—"}
                  </pre>
                </div>
                <div>
                  <div className="text-xs font-semibold text-muted-foreground mb-1">Depois</div>
                  <pre className="bg-muted/40 rounded p-3 text-xs overflow-auto max-h-96 whitespace-pre-wrap">
                    {detail.after ? JSON.stringify(detail.after, null, 2) : "—"}
                  </pre>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
