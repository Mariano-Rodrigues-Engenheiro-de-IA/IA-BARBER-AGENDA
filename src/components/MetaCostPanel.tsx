import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenants } from "@/hooks/useTenants";
import { AlertTriangle } from "lucide-react";

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
  // Paginação simples até esgotar
  // (chat_messages pode crescer; ok para volumes atuais)
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
      if (content.startsWith(HUMAN_ATTENDANT_PREFIX)) continue; // digitada pelo dono, não é IA
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

export default function MetaCostPanel() {
  const { data: tenants } = useTenants();
  const { data: rows, isLoading } = useQuery({
    queryKey: ["meta-cost-messages"],
    queryFn: fetchAllAssistantMessages,
    staleTime: 60_000,
  });

  const stats = useMemo(() => {
    const tenantMap = new Map((tenants ?? []).map((t) => [t.id, t]));
    const counts = new Map<string, number>();
    for (const r of rows ?? []) {
      counts.set(r.tenant_id, (counts.get(r.tenant_id) ?? 0) + 1);
    }
    const now = Date.now();
    const startMs = new Date(COUNTER_START_AT).getTime();
    const daysElapsed = Math.max(1, (now - startMs) / (1000 * 60 * 60 * 24));

    // Incluir TODAS as empresas cadastradas, mesmo sem mensagens,
    // para permitir auditoria completa do tenant base.
    const list = Array.from(tenantMap.entries()).map(([tenantId, t]) => {
      const total = counts.get(tenantId) ?? 0;
      const costAccum = total * COST_PER_MESSAGE_BRL;
      const projMonthly = (total / daysElapsed) * 30 * COST_PER_MESSAGE_BRL;
      return {
        tenantId,
        name: t.name ?? "(empresa sem nome)",
        status: t.status ?? null,
        total,
        costAccum,
        projMonthly,
      };
    });

    // Adicionar mensagens órfãs de tenants removidos, se houver.
    for (const [tenantId, total] of counts.entries()) {
      if (!tenantMap.has(tenantId)) {
        list.push({
          tenantId,
          name: "(empresa removida)",
          status: null,
          total,
          costAccum: total * COST_PER_MESSAGE_BRL,
          projMonthly: (total / daysElapsed) * 30 * COST_PER_MESSAGE_BRL,
        });
      }
    }

    list.sort((a, b) => b.total - a.total);
    const grandTotalMsgs = list.reduce((s, r) => s + r.total, 0);
    const grandTotalCost = grandTotalMsgs * COST_PER_MESSAGE_BRL;
    const grandProjMonthly = (grandTotalMsgs / daysElapsed) * 30 * COST_PER_MESSAGE_BRL;
    return { list, grandTotalMsgs, grandTotalCost, grandProjMonthly, daysElapsed };
  }, [rows, tenants]);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-bold text-foreground">API Oficial Meta</h2>
          <p className="text-muted-foreground text-sm">
            Acompanhamento cumulativo de mensagens de saída da IA por empresa e custo estimado sob a cobrança da Meta. Lista todas as empresas cadastradas.
          </p>
        </div>
        <div className="text-xs text-muted-foreground">
          Contando desde{" "}
          <span className="font-mono text-foreground">
            {new Date(COUNTER_START_AT).toLocaleDateString("pt-BR")}
          </span>{" "}
          · {stats.daysElapsed.toFixed(1)} dias
        </div>
      </div>

      <div className="flex items-start gap-3 p-3 rounded-lg border border-warning/40 bg-warning/10 text-sm">
        <AlertTriangle className="w-4 h-4 mt-0.5 text-warning shrink-0" />
        <p className="text-foreground/90">
          <strong>Estimativa</strong> baseada no modelo de cobrança da Meta que entra em vigor em{" "}
          <strong>01/10/2026</strong> (R$ {COST_PER_MESSAGE_BRL.toFixed(3).replace(".", ",")} por mensagem de serviço).{" "}
          <span className="text-muted-foreground">
            Não é uma cobrança real hoje — a operação usa API não oficial.
          </span>
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="glass-card p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Mensagens totais</p>
          <p className="text-2xl font-bold text-foreground mt-1">{stats.grandTotalMsgs.toLocaleString("pt-BR")}</p>
        </div>
        <div className="glass-card p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Custo acumulado (estimado)</p>
          <p className="text-2xl font-bold text-foreground mt-1">{formatBRL(stats.grandTotalCost)}</p>
        </div>
        <div className="glass-card p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Projeção mensal (estimada)</p>
          <p className="text-2xl font-bold text-foreground mt-1">{formatBRL(stats.grandProjMonthly)}</p>
        </div>
      </div>

      <div className="glass-card p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="p-3">#</th>
              <th className="p-3">Empresa</th>
              <th className="p-3 text-right">Mensagens</th>
              <th className="p-3 text-right">Custo acumulado</th>
              <th className="p-3 text-right">Projeção mensal</th>
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
                  Nenhuma mensagem contabilizada ainda.
                </td>
              </tr>
            )}
            {stats.list.map((r, i) => (
              <tr key={r.tenantId} className="border-t border-border">
                <td className="p-3 text-muted-foreground font-mono text-xs">{i + 1}</td>
                <td className="p-3 font-medium text-foreground">{r.name}</td>
                <td className="p-3 text-right font-mono">{r.total.toLocaleString("pt-BR")}</td>
                <td className="p-3 text-right font-mono">{formatBRL(r.costAccum)}</td>
                <td className="p-3 text-right font-mono text-muted-foreground">{formatBRL(r.projMonthly)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
