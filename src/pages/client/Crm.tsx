import { useAuth, useModulePermission } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { Navigate } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCrmBoards, useCreateBoard } from "@/hooks/useCrmLeads";
import { Plus } from "lucide-react";
import { toast } from "sonner";

export default function ClientCrm() {
  const { tenantId } = useAuth();
  const { visible, editable } = useModulePermission("crm");
  if (!visible) return <Navigate to="/app" replace />;

  const { data: boards = [] } = useCrmBoards(tenantId ?? undefined);
  const createBoard = useCreateBoard();
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);
  useEffect(() => { if (!selectedBoardId && boards.length) setSelectedBoardId(boards[0].id); }, [boards, selectedBoardId]);

  const selectedBoard = boards.find((b) => b.id === selectedBoardId);
  const isFirstBoard = boards.length > 0 && boards[0].id === selectedBoardId;

  const { data: leads } = useQuery({
    queryKey: ["client-crm-leads", tenantId, selectedBoardId, isFirstBoard],
    enabled: !!tenantId && !!selectedBoardId,
    queryFn: async () => {
      let q = supabase.from("crm_leads")
        .select("id,name,phone_number,label_id,label_name,notes,updated_at,board_id")
        .eq("tenant_id", tenantId!)
        .order("updated_at", { ascending: false });
      q = isFirstBoard ? q.or(`board_id.eq.${selectedBoardId},board_id.is.null`) : q.eq("board_id", selectedBoardId!);
      const { data } = await q;
      return data ?? [];
    },
  });

  const cols = useMemo(() => {
    const arr = Array.isArray(selectedBoard?.columns) ? selectedBoard!.columns : [];
    return arr.filter((c: any) => (c.type ?? "funnel") === "funnel").sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));
  }, [selectedBoard]);

  const handleAddBoard = async () => {
    if (!tenantId) return;
    const name = prompt("Nome do novo CRM:");
    if (!name?.trim()) return;
    try {
      const b = await createBoard.mutateAsync({ tenantId, name: name.trim(), order: boards.length });
      setSelectedBoardId(b.id);
      toast.success("CRM criado");
    } catch (e: any) { toast.error(e.message); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">CRM</h1>
          <p className="text-muted-foreground">Leads organizados pelos seus funis</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={selectedBoardId ?? ""} onValueChange={setSelectedBoardId}>
            <SelectTrigger className="w-[220px]"><SelectValue placeholder="Selecione um CRM" /></SelectTrigger>
            <SelectContent>
              {boards.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
            </SelectContent>
          </Select>
          {editable && <Button onClick={handleAddBoard}><Plus className="w-4 h-4 mr-2" />Novo CRM</Button>}
        </div>
      </div>

      {boards.length === 0 && (
        <div className="glass-card p-8 text-center space-y-3">
          <p className="text-muted-foreground">Nenhum CRM criado ainda.</p>
          {editable && <Button onClick={handleAddBoard}><Plus className="w-4 h-4 mr-2" />Criar primeiro CRM</Button>}
        </div>
      )}

      {selectedBoard && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {cols.map((col: any) => {
            const items = (leads ?? []).filter((l: any) => l.label_id === col.label_id);
            return (
              <div key={col.label_id} className="glass-card p-3">
                <div className="flex items-center gap-2 mb-3">
                  <span className="w-2 h-2 rounded-full" style={{ background: col.color }} />
                  <h3 className="font-semibold text-sm text-foreground">{col.name}</h3>
                  <span className="ml-auto text-xs text-muted-foreground">{items.length}</span>
                </div>
                <div className="space-y-2 max-h-[60vh] overflow-auto">
                  {items.map((l: any) => (
                    <div key={l.id} className="bg-muted/50 rounded-lg p-2">
                      <div className="text-sm font-medium text-foreground">{l.name || l.phone_number}</div>
                      <div className="text-xs text-muted-foreground">{l.phone_number}</div>
                      {l.notes && <div className="text-xs text-muted-foreground mt-1 line-clamp-2">{l.notes}</div>}
                    </div>
                  ))}
                  {items.length === 0 && <p className="text-xs text-muted-foreground">Vazio</p>}
                </div>
              </div>
            );
          })}
          {cols.length === 0 && <p className="text-sm text-muted-foreground col-span-full">Nenhuma coluna configurada neste CRM.</p>}
        </div>
      )}
    </div>
  );
}
