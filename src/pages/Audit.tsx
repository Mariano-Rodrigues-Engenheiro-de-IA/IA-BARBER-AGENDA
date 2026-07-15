import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { useTenants } from "@/hooks/useTenants";
import MetaCostPanel from "@/components/MetaCostPanel";

export default function AuditPage() {
  const { data: tenants } = useTenants();
  const tenantMap = new Map((tenants ?? []).map((t) => [t.id, t.name]));

  const { data } = useQuery({
    queryKey: ["audit-logs"],
    queryFn: async () => {
      const { data } = await supabase.from("audit_logs")
        .select("id,tenant_id,actor_role,action,entity,entity_id,after,created_at")
        .order("created_at", { ascending: false }).limit(300);
      return data ?? [];
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Auditoria</h1>
        <p className="text-muted-foreground">Histórico de alterações nos painéis</p>
      </div>
      <div className="glass-card p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="p-3">Quando</th>
              <th className="p-3">Empresa</th>
              <th className="p-3">Quem</th>
              <th className="p-3">Ação</th>
              <th className="p-3">Entidade</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((l: any) => (
              <tr key={l.id} className="border-t border-border">
                <td className="p-3 text-muted-foreground whitespace-nowrap">{new Date(l.created_at).toLocaleString()}</td>
                <td className="p-3">{tenantMap.get(l.tenant_id) ?? "—"}</td>
                <td className="p-3"><span className="text-xs px-2 py-0.5 rounded bg-muted">{l.actor_role}</span></td>
                <td className="p-3 font-mono text-xs">{l.action}</td>
                <td className="p-3 text-muted-foreground text-xs">{l.entity}</td>
              </tr>
            ))}
            {(!data || data.length === 0) && (
              <tr><td className="p-6 text-center text-muted-foreground" colSpan={5}>Nenhum registro</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
