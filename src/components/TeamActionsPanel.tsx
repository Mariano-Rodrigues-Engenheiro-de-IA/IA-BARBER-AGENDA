import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
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
  // tenants
  tenant_created: "Criou empresa",
  created: "Criou empresa",
  tenant_updated_multi: "Editou empresa (várias mudanças)",
  prompt_updated: "Editou o prompt da IA",
  edit_ai_prompt: "Editou o prompt da IA",
  restore_ai_prompt: "Restaurou versão anterior do prompt",
  knowledge_updated: "Editou a base de conhecimento",
  edit_custom_tools: "Editou ferramentas customizadas",
  agent_paused: "Pausou o agente",
  pause_agent: "Pausou o agente",
  agent_resumed: "Despausou o agente",
  resume_agent: "Despausou o agente",
  visibility_changed: "Alterou visibilidade da empresa",
  integrations_updated: "Alterou integrações/tokens",
  status_changed: "Alterou status da empresa",
  // staff / access
  staff_access_granted: "Liberou empresa para colaborador",
  staff_access_revoked: "Retirou empresa do colaborador",
  module_access_granted: "Liberou aba do painel para colaborador",
  module_access_revoked: "Retirou aba do painel do colaborador",
  invite_staff: "Cadastrou colaborador",
  delete_staff: "Removeu colaborador",
  create_client_user: "Criou usuário cliente",
  // crm
  lead_moved: "Moveu lead no CRM",
};

// Only human, write-type actions. Excludes service-role/system noise.
const HUMAN_ROLES = new Set(["admin", "staff"]);

function labelAction(a: string) {
  return ACTION_LABELS[a] ?? a;
}

export default function TeamActionsPanel() {
  const [actorFilter, setActorFilter] = useState<string>("all");
  const [tenantFilter, setTenantFilter] = useState<string>("all");
  const [actionFilter, setActionFilter] = useState<string>("all");
  const [days, setDays] = useState<number>(30);
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState<LogRow | null>(null);

  const since = useMemo(() => new Date(Date.now() - days * 86400_000).toISOString(), [days]);

  const { data: logs, isLoading } = useQuery({
    queryKey: ["team-actions-logs", days],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("audit_logs")
        .select("*")
        .gte("created_at", since)
        .in("actor_role", ["admin", "staff"])
        .order("created_at", { ascending: false })
        .limit(1000);
      if (error) throw error;
      return (data ?? []) as LogRow[];
    },
  });

  const { data: tenants } = useQuery({
    queryKey: ["team-actions-tenants"],
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
    queryKey: ["team-actions-actor-emails", actorIds.sort().join(",")],
    enabled: actorIds.length > 0,
    queryFn: async () => {
      const { data } = await supabase.functions.invoke("admin-manage-staff", {
        body: { action: "resolve_users", user_ids: actorIds },
      });
      return ((data as any)?.users ?? {}) as Record<string, string | null>;
    },
  });

  const tenantName = (id: string | null) =>
    tenants?.find((t) => t.id === id)?.name ?? (id ? id.slice(0, 8) : "—");
  const actorName = (id: string | null) =>
    (id && actorEmails?.[id]) || (id ? id.slice(0, 8) : "sistema");

  const actionsInData = useMemo(() => {
    const s = new Set<string>();
    for (const l of logs ?? []) s.add(l.action);
    return Array.from(s).sort();
  }, [logs]);

  const filtered = (logs ?? []).filter((l) => {
    if (!HUMAN_ROLES.has(l.actor_role ?? "")) return false;
    if (actorFilter !== "all" && l.user_id !== actorFilter) return false;
    if (tenantFilter !== "all" && l.tenant_id !== tenantFilter) return false;
    if (actionFilter !== "all" && l.action !== actionFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      const hay = `${labelAction(l.action)} ${actorName(l.user_id)} ${tenantName(l.tenant_id)}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  return (
    <div className="space-y-4">
      <div className="glass-card p-4 grid gap-3 md:grid-cols-5">
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
        <div>
          <Label className="text-xs">Buscar</Label>
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Nome, empresa, ação..." />
        </div>
      </div>

      <div className="glass-card p-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Carregando...</p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nenhuma ação da equipe no período/filtro selecionado. Ações de escrita (criar empresa,
            editar prompt, pausar agente, mover lead, alterar acessos, etc.) aparecem aqui assim que acontecem.
          </p>
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
                    <td className="py-2 pr-4 text-muted-foreground text-xs whitespace-nowrap" title={new Date(l.created_at).toLocaleString("pt-BR")}>
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
