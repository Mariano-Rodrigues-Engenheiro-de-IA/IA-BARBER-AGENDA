import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { Users, MessageSquare, Send, TrendingUp } from "lucide-react";

function StatCard({ icon: Icon, label, value, hint }: any) {
  return (
    <div className="glass-card p-5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-muted-foreground">{label}</span>
        <Icon className="w-4 h-4 text-primary" />
      </div>
      <div className="text-2xl font-bold text-foreground">{value}</div>
      {hint && <div className="text-xs text-muted-foreground mt-1">{hint}</div>}
    </div>
  );
}

export default function ClientOverview() {
  const { tenantId } = useAuth();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data } = useQuery({
    queryKey: ["client-overview", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const [leads, msgs, sent, all] = await Promise.all([
        supabase.from("crm_leads").select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId!).gte("created_at", since),
        supabase.from("chat_messages").select("phone_number")
          .eq("tenant_id", tenantId!).gte("created_at", since),
        supabase.from("follow_ups").select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId!).eq("status", "sent").gte("sent_at", since),
        supabase.from("follow_ups").select("status")
          .eq("tenant_id", tenantId!).gte("created_at", since),
      ]);
      const activePhones = new Set((msgs.data ?? []).map((m: any) => m.phone_number)).size;
      const total = (all.data ?? []).length;
      const responded = (all.data ?? []).filter((f: any) => f.status === "confirmed").length;
      const rate = total ? Math.round((responded / total) * 100) : 0;
      return { newLeads: leads.count ?? 0, activePhones, sent: sent.count ?? 0, rate };
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Visão Geral</h1>
        <p className="text-muted-foreground">Resumo das últimas 24 horas</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={Users} label="Novos leads" value={data?.newLeads ?? "—"} />
        <StatCard icon={MessageSquare} label="Conversas ativas" value={data?.activePhones ?? "—"} />
        <StatCard icon={Send} label="Follow-ups enviados" value={data?.sent ?? "—"} />
        <StatCard icon={TrendingUp} label="Taxa de resposta" value={`${data?.rate ?? 0}%`} />
      </div>
    </div>
  );
}
