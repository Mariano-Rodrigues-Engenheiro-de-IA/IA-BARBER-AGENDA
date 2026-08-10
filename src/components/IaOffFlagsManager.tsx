import { useState, useMemo, useEffect } from "react";
import { useCrmBoards, useCreateBoard, useUpdateBoard, type KanbanColumn } from "@/hooks/useCrmLeads";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Trash2, Save, Loader2, Flag } from "lucide-react";
import { toast } from "sonner";

/** Gerencia só as marcações (flags) usadas para acionar comportamentos
 * independentes do funil de vendas — hoje, só "IA OFF". O funil em si
 * (etapas do kanban) saiu daqui: agora vive no CRM externo, configurado na
 * aba "CRM". Reaproveita a mesma estrutura de dados (crm_boards.columns
 * com type="flag") para não quebrar a sincronização já existente com o
 * WhatsApp — só esconde o conceito de "boards" da tela, usando sempre o
 * primeiro board do tenant como board de configuração. */
export function IaOffFlagsManager({ tenantId }: { tenantId: string }) {
  const { data: boards = [], isLoading } = useCrmBoards(tenantId);
  const createBoard = useCreateBoard();
  const updateBoard = useUpdateBoard();
  const [draftCols, setDraftCols] = useState<KanbanColumn[] | null>(null);
  const [ensuring, setEnsuring] = useState(false);

  const board = boards[0] ?? null;
  const allCols = draftCols ?? board?.columns ?? [];
  const flagCols = allCols.filter((c) => (c.type ?? "funnel") === "flag");
  // Preserva as colunas de funil (se ainda existirem de antes da migração)
  // ao salvar, para não apagar dados de configuração antiga sem querer.
  const otherCols = allCols.filter((c) => (c.type ?? "funnel") !== "flag");

  // Cria um board "oculto" automaticamente na primeira vez, se o tenant
  // ainda não tiver nenhum — sem pedir nome nem mostrar isso ao usuário.
  useEffect(() => {
    if (isLoading || board || ensuring) return;
    setEnsuring(true);
    createBoard
      .mutateAsync({ tenantId, name: "Configurações", order: 0 })
      .catch((e: any) => toast.error(e?.message || "Erro ao preparar configuração"))
      .finally(() => setEnsuring(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, board]);

  const handleSave = async () => {
    if (!board || !draftCols) return;
    try {
      await updateBoard.mutateAsync({ id: board.id, tenantId, patch: { columns: draftCols } });
      setDraftCols(null);
      toast.success("Salvo");
    } catch (e: any) {
      toast.error(e?.message || "Erro ao salvar");
    }
  };

  const updateFlag = (idx: number, patch: Partial<KanbanColumn>) => {
    const target = flagCols[idx];
    const next = allCols.map((c) => (c === target ? { ...c, ...patch } : c));
    setDraftCols(next);
  };

  const removeFlag = (idx: number) => {
    const target = flagCols[idx];
    setDraftCols(allCols.filter((c) => c !== target));
  };

  const addFlag = () => {
    setDraftCols([...otherCols, ...flagCols, { label_id: "", name: "IA OFF", color: "#EF4444", order: flagCols.length, type: "flag" }]);
  };

  if (isLoading || ensuring) {
    return (
      <div className="text-sm text-muted-foreground flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />Carregando...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="glass-card p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-foreground flex items-center gap-2">
              <Flag className="w-5 h-5 text-primary" />
              Marcações (IA OFF)
            </h3>
            <p className="text-sm text-muted-foreground mt-1">
              Etiquetas do WhatsApp que, quando aplicadas a um contato, pausam as respostas automáticas da IA para
              ele. O ID da etiqueta precisa bater com o ID real dela no WhatsApp.
            </p>
          </div>
          {draftCols && (
            <Button type="button" onClick={handleSave} size="sm">
              <Save className="w-4 h-4 mr-2" />Salvar
            </Button>
          )}
        </div>

        {flagCols.map((col, idx) => (
          <div key={idx} className="flex items-center gap-3 p-3 rounded-lg border border-border bg-background/50">
            <div className="w-4 h-4 rounded-full shrink-0 border border-border" style={{ backgroundColor: col.color }} />
            <Input
              value={col.name}
              onChange={(e) => updateFlag(idx, { name: e.target.value })}
              placeholder="Nome da marcação"
              className="flex-1"
            />
            <Input
              value={col.label_id}
              onChange={(e) => updateFlag(idx, { label_id: e.target.value })}
              placeholder="Label ID"
              className="w-32"
            />
            <Input
              type="color"
              value={col.color}
              onChange={(e) => updateFlag(idx, { color: e.target.value })}
              className="w-12 h-9 p-1 cursor-pointer"
            />
            <Button type="button" variant="ghost" size="icon" onClick={() => removeFlag(idx)}>
              <Trash2 className="w-4 h-4 text-destructive" />
            </Button>
          </div>
        ))}

        {flagCols.length === 0 && (
          <p className="text-sm text-muted-foreground py-2">Nenhuma marcação configurada ainda.</p>
        )}

        <Button type="button" variant="outline" onClick={addFlag}>
          <Plus className="w-4 h-4 mr-2" />Adicionar marcação
        </Button>
      </div>
    </div>
  );
}
