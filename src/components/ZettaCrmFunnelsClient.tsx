import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Plus, Trash2, ChevronDown, ChevronUp, ListChecks } from "lucide-react";
import { toast } from "sonner";

type ZettaFunnel = { id: string; name: string; stages: { id: string; name: string }[] };
type ConfiguredFunnel = { id: string; funnel_id: string; funnel_name: string; stages: { id: string; name: string }[] };

/** Aba "CRM" do painel do cliente — gerencia quantos funis o cliente
 * quiser, sem nunca mostrar o token (isso é só do admin). Layout pensado
 * pra ficar simples: lista dos funis já configurados + um botão claro pra
 * adicionar mais um. */
export function ZettaCrmFunnelsClient({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();

  const { data: configured, isLoading } = useQuery({
    queryKey: ["tenant-crm-funnels", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenant_crm_funnels" as any)
        .select("id, funnel_id, funnel_name, stages")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as ConfiguredFunnel[];
    },
    enabled: !!tenantId,
  });

  const [adding, setAdding] = useState(false);
  const [loadingFunnels, setLoadingFunnels] = useState(false);
  const [availableFunnels, setAvailableFunnels] = useState<ZettaFunnel[] | null>(null);
  const [pickedFunnelId, setPickedFunnelId] = useState("");
  const [saving, setSaving] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const startAdding = async () => {
    setAdding(true);
    setPickedFunnelId("");
    setLoadingFunnels(true);
    try {
      // Nunca busca o token diretamente — essa function roda no servidor,
      // pega o token internamente e devolve só a lista de funis.
      const { data, error } = await supabase.functions.invoke("crm-zetta-list-funnels-for-tenant", {
        body: { tenant_id: tenantId },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      const already = new Set((configured ?? []).map((f) => f.funnel_id));
      const list = ((data?.funnels ?? []) as ZettaFunnel[]).filter((f) => !already.has(f.id));
      setAvailableFunnels(list);
      if (list.length === 0) toast.error("Todos os funis desse CRM já estão configurados.");
    } catch (e: any) {
      toast.error(e?.message || "Não consegui buscar os funis.");
      setAdding(false);
    } finally {
      setLoadingFunnels(false);
    }
  };

  const confirmAdd = async () => {
    const funnel = (availableFunnels ?? []).find((f) => f.id === pickedFunnelId);
    if (!funnel) {
      toast.error("Escolhe um funil primeiro.");
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.from("tenant_crm_funnels" as any).insert({
        tenant_id: tenantId,
        funnel_id: funnel.id,
        funnel_name: funnel.name,
        stages: funnel.stages,
      });
      if (error) throw error;
      toast.success(`Funil "${funnel.name}" configurado — a IA já pode usar as etapas dele.`);
      setAdding(false);
      setAvailableFunnels(null);
      setPickedFunnelId("");
      qc.invalidateQueries({ queryKey: ["tenant-crm-funnels", tenantId] });
    } catch (e: any) {
      toast.error(e?.message || "Erro ao salvar");
    } finally {
      setSaving(false);
    }
  };

  const removeFunnel = async (id: string, name: string) => {
    if (!confirm(`Remover o funil "${name}"? A IA para de usar as etapas dele.`)) return;
    const { error } = await supabase.from("tenant_crm_funnels" as any).delete().eq("id", id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Removido");
    qc.invalidateQueries({ queryKey: ["tenant-crm-funnels", tenantId] });
  };

  if (isLoading) {
    return (
      <div className="text-sm text-muted-foreground flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />Carregando...
      </div>
    );
  }

  return (
    <div className="glass-card p-6 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-foreground flex items-center gap-2">
            <ListChecks className="w-5 h-5 text-primary" />
            Funis conectados
          </h3>
          <p className="text-sm text-muted-foreground mt-1">
            Escolha quantos funis quiser — a IA move o lead pelas etapas de cada um automaticamente, durante a
            conversa.
          </p>
        </div>
        {!adding && (
          <Button type="button" size="sm" onClick={startAdding}>
            <Plus className="w-4 h-4 mr-2" />Adicionar funil
          </Button>
        )}
      </div>

      {(configured ?? []).length === 0 && !adding && (
        <p className="text-sm text-muted-foreground py-2">Nenhum funil configurado ainda.</p>
      )}

      <div className="space-y-2">
        {(configured ?? []).map((f) => {
          const isOpen = expandedId === f.id;
          return (
            <div key={f.id} className="rounded-lg border border-border overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3">
                <button
                  type="button"
                  onClick={() => setExpandedId(isOpen ? null : f.id)}
                  className="flex items-center gap-2 text-left flex-1 min-w-0"
                >
                  {isOpen ? <ChevronUp className="w-4 h-4 shrink-0" /> : <ChevronDown className="w-4 h-4 shrink-0" />}
                  <span className="font-medium text-foreground truncate">{f.funnel_name}</span>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {(f.stages ?? []).length} etapa(s)
                  </span>
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => removeFunnel(f.id, f.funnel_name)}
                  className="text-muted-foreground hover:text-destructive shrink-0"
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
              {isOpen && (
                <div className="border-t border-border bg-muted/30 px-4 py-3">
                  <ul className="space-y-1">
                    {(f.stages ?? []).map((s) => (
                      <li key={s.id} className="text-xs text-muted-foreground flex items-center gap-1.5">
                        <span className="w-1 h-1 rounded-full bg-primary shrink-0" />
                        {s.name}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {adding && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-3">
          <p className="text-sm font-medium text-foreground">Escolha um funil pra adicionar</p>
          {loadingFunnels ? (
            <p className="text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />Buscando funis disponíveis...
            </p>
          ) : (
            <>
              <Select value={pickedFunnelId} onValueChange={setPickedFunnelId}>
                <SelectTrigger>
                  <SelectValue placeholder="Escolha o funil" />
                </SelectTrigger>
                <SelectContent>
                  {(availableFunnels ?? []).map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex gap-2">
                <Button type="button" size="sm" onClick={confirmAdd} disabled={saving || !pickedFunnelId}>
                  {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                  Confirmar
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)} disabled={saving}>
                  Cancelar
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
