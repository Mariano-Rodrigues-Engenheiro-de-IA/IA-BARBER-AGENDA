import { useState, useMemo } from "react";
import { useCrmBoards, useCreateBoard, useUpdateBoard, useDeleteBoard, type CrmBoard, type KanbanColumn } from "@/hooks/useCrmLeads";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Kanban, Plus, Trash2, Save, Loader2 } from "lucide-react";
import { toast } from "sonner";

export function KanbanBoardsManager({ tenantId }: { tenantId: string }) {
  const { data: boards = [], isLoading } = useCrmBoards(tenantId);
  const createBoard = useCreateBoard();
  const updateBoard = useUpdateBoard();
  const deleteBoard = useDeleteBoard();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftCols, setDraftCols] = useState<KanbanColumn[] | null>(null);

  const selected = useMemo(() => boards.find((b) => b.id === selectedId) ?? boards[0] ?? null, [boards, selectedId]);
  const cols = draftCols ?? selected?.columns ?? [];

  const handleAddBoard = async () => {
    const name = prompt("Nome do novo CRM:");
    if (!name?.trim()) return;
    try {
      const b = await createBoard.mutateAsync({ tenantId, name: name.trim(), order: boards.length });
      setSelectedId(b.id);
      setDraftCols(null);
      toast.success("CRM criado");
    } catch (e: any) { toast.error(e.message); }
  };

  const handleRename = async () => {
    if (!selected) return;
    const name = prompt("Novo nome:", selected.name);
    if (!name?.trim() || name === selected.name) return;
    try {
      await updateBoard.mutateAsync({ id: selected.id, tenantId, patch: { name: name.trim() } });
      toast.success("Renomeado");
    } catch (e: any) { toast.error(e.message); }
  };

  const handleDelete = async () => {
    if (!selected) return;
    if (!confirm(`Excluir CRM "${selected.name}"? Os leads vinculados ficarão sem CRM.`)) return;
    try {
      await deleteBoard.mutateAsync({ id: selected.id, tenantId });
      setSelectedId(null);
      setDraftCols(null);
      toast.success("Excluído");
    } catch (e: any) { toast.error(e.message); }
  };

  const handleSaveCols = async () => {
    if (!selected || !draftCols) return;
    try {
      await updateBoard.mutateAsync({ id: selected.id, tenantId, patch: { columns: draftCols } });
      setDraftCols(null);
      toast.success("Colunas salvas");
    } catch (e: any) { toast.error(e.message); }
  };

  if (isLoading) return <div className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Carregando...</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-end gap-3 flex-wrap">
        <div className="flex-1 min-w-[220px]">
          <label className="text-xs uppercase tracking-wider text-muted-foreground mb-1 block">CRM</label>
          <Select value={selected?.id ?? ""} onValueChange={(v) => { setSelectedId(v); setDraftCols(null); }}>
            <SelectTrigger><SelectValue placeholder="Nenhum CRM" /></SelectTrigger>
            <SelectContent>
              {boards.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <Button type="button" onClick={handleAddBoard}><Plus className="w-4 h-4 mr-2" />Novo CRM</Button>
        {selected && <Button type="button" variant="outline" onClick={handleRename}>Renomear</Button>}
        {selected && <Button type="button" variant="ghost" onClick={handleDelete}><Trash2 className="w-4 h-4 text-destructive" /></Button>}
      </div>

      {!selected && (
        <div className="glass-card p-8 text-center text-muted-foreground">
          Crie um CRM para começar a configurar colunas.
        </div>
      )}

      {selected && (
        <div className="glass-card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-foreground flex items-center gap-2">
                <Kanban className="w-5 h-5 text-primary" />
                Colunas do CRM "{selected.name}"
              </h3>
              <p className="text-sm text-muted-foreground mt-1">
                Cada coluna corresponde a um ID de etiqueta do WhatsApp.
              </p>
            </div>
            {draftCols && (
              <Button type="button" onClick={handleSaveCols} size="sm"><Save className="w-4 h-4 mr-2" />Salvar colunas</Button>
            )}
          </div>

          {cols.map((col, idx) => (
            <div key={idx} className="flex items-center gap-3 p-3 rounded-lg border border-border bg-background/50">
              <div className="w-4 h-4 rounded-full shrink-0 border border-border" style={{ backgroundColor: col.color }} />
              <Input value={col.name} onChange={(e) => { const u = [...cols]; u[idx] = { ...u[idx], name: e.target.value }; setDraftCols(u); }} placeholder="Nome da coluna" className="flex-1" />
              <Input value={col.label_id} onChange={(e) => { const u = [...cols]; u[idx] = { ...u[idx], label_id: e.target.value }; setDraftCols(u); }} placeholder="Label ID" className="w-24" />
              <Select value={col.type || "funnel"} onValueChange={(val) => { const u = [...cols]; u[idx] = { ...u[idx], type: val as "funnel" | "flag" }; setDraftCols(u); }}>
                <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="funnel">Funil</SelectItem>
                  <SelectItem value="flag">Flag</SelectItem>
                </SelectContent>
              </Select>
              <Input type="color" value={col.color} onChange={(e) => { const u = [...cols]; u[idx] = { ...u[idx], color: e.target.value }; setDraftCols(u); }} className="w-12 h-9 p-1 cursor-pointer" />
              <Button type="button" variant="ghost" size="icon" onClick={() => setDraftCols(cols.filter((_, i) => i !== idx))}>
                <Trash2 className="w-4 h-4 text-destructive" />
              </Button>
            </div>
          ))}

          <Button type="button" variant="outline" onClick={() => setDraftCols([...cols, { label_id: "", name: "", color: "#3B82F6", order: cols.length, type: "funnel" }])}>
            <Plus className="w-4 h-4 mr-2" />Adicionar Coluna
          </Button>
          <p className="text-xs text-muted-foreground">
            <strong>Funil:</strong> etapas do CRM. <strong>Flag:</strong> marcações independentes (badges nos cards).
          </p>
        </div>
      )}
    </div>
  );
}
