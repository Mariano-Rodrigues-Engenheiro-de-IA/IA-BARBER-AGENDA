import { useAuth, useModulePermission } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { Navigate, useNavigate } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Bot, MessageCircle, Save, Inbox } from "lucide-react";
import { toast } from "sonner";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useCrmBoards, useUpdateLead, useMoveLead } from "@/hooks/useCrmLeads";

const UNASSIGNED = "__unassigned__";

export default function ClientCrm() {
  const { tenantId } = useAuth();
  const navigate = useNavigate();
  const { visible } = useModulePermission("crm");
  if (!visible) return <Navigate to="/app" replace />;

  const { data: boards = [] } = useCrmBoards(tenantId ?? undefined);
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);
  useEffect(() => { if (!selectedBoardId && boards.length) setSelectedBoardId(boards[0].id); }, [boards, selectedBoardId]);

  const selectedBoard = boards.find((b) => b.id === selectedBoardId);
  const isFirstBoard = boards.length > 0 && boards[0].id === selectedBoardId;

  const { data: leads, refetch } = useQuery({
    queryKey: ["client-crm-leads", tenantId, selectedBoardId, isFirstBoard],
    enabled: !!tenantId && !!selectedBoardId,
    refetchInterval: 30000,
    queryFn: async () => {
      let q = supabase.from("crm_leads")
        .select("id,name,phone_number,label_id,label_name,notes,ai_summary,ai_summary_updated_at,updated_at,board_id")
        .eq("tenant_id", tenantId!)
        .order("updated_at", { ascending: false });
      q = isFirstBoard ? q.or(`board_id.eq.${selectedBoardId},board_id.is.null`) : q.eq("board_id", selectedBoardId!);
      const { data } = await q;
      return data ?? [];
    },
  });

  const funnelCols = useMemo(() => {
    const arr = Array.isArray(selectedBoard?.columns) ? selectedBoard!.columns : [];
    return arr.filter((c: any) => (c.type ?? "funnel") === "funnel").sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));
  }, [selectedBoard]);

  // Virtual "Novos / Sem coluna" column: leads whose label_id doesn't match any funnel column.
  const columns = useMemo(() => {
    const known = new Set(funnelCols.map((c: any) => String(c.label_id)));
    const unassigned = {
      label_id: UNASSIGNED,
      name: "Novos / Sem coluna",
      color: "hsl(var(--primary))",
      order: -1,
      type: "funnel" as const,
      _virtual: true,
    };
    const grouped = (leads ?? []).reduce(
      (acc: Record<string, any[]>, l: any) => {
        const key = known.has(String(l.label_id)) ? String(l.label_id) : UNASSIGNED;
        (acc[key] ||= []).push(l);
        return acc;
      },
      {} as Record<string, any[]>,
    );
    const result = [unassigned, ...funnelCols].map((col: any) => ({
      ...col,
      items: grouped[String(col.label_id)] ?? [],
    }));
    // Hide the virtual column if empty AND there are other columns with items
    if (result[0].items.length === 0 && result.length > 1) return result.slice(1);
    return result;
  }, [funnelCols, leads]);

  const [openLead, setOpenLead] = useState<any | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">CRM</h1>
          <p className="text-muted-foreground">Leads atendidos pela IA, com resumo automático</p>
        </div>
        {boards.length > 0 && (
          <div className="flex items-center gap-2">
            <Select value={selectedBoardId ?? ""} onValueChange={setSelectedBoardId}>
              <SelectTrigger className="w-[220px]"><SelectValue placeholder="Selecione um CRM" /></SelectTrigger>
              <SelectContent>
                {boards.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {boards.length === 0 && (
        <div className="glass-card p-8 text-center space-y-3">
          <p className="text-muted-foreground">Nenhum CRM ativo. Peça ao administrador para criar um.</p>
        </div>
      )}

      {selectedBoard && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {columns.map((col: any) => (
            <div key={col.label_id} className="glass-card p-3">
              <div className="flex items-center gap-2 mb-3">
                {col._virtual ? (
                  <Inbox className="w-4 h-4 text-primary" />
                ) : (
                  <span className="w-2 h-2 rounded-full" style={{ background: col.color }} />
                )}
                <h3 className="font-semibold text-sm text-foreground">{col.name}</h3>
                <span className="ml-auto text-xs text-muted-foreground">{col.items.length}</span>
              </div>
              <div className="space-y-2 max-h-[70vh] overflow-auto subtle-scrollbar pr-1">
                {col.items.map((l: any) => (
                  <button
                    key={l.id}
                    onClick={() => setOpenLead(l)}
                    className="w-full text-left bg-muted/40 hover:bg-muted/70 transition-colors rounded-lg p-2.5 border border-transparent hover:border-border"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-foreground truncate">
                          {l.name || l.phone_number}
                        </div>
                        <div className="text-[11px] text-muted-foreground">{l.phone_number}</div>
                      </div>
                      <span className="text-[10px] text-muted-foreground shrink-0">
                        {l.updated_at ? formatDistanceToNow(new Date(l.updated_at), { addSuffix: false, locale: ptBR }) : ""}
                      </span>
                    </div>
                    {l.ai_summary ? (
                      <div className="mt-2 flex gap-1.5 items-start rounded-md border border-border/40 bg-background/40 p-1.5">
                        <Bot className="w-3 h-3 mt-0.5 shrink-0 text-primary" />
                        <div className="text-[11px] text-muted-foreground whitespace-pre-wrap line-clamp-3">
                          {l.ai_summary}
                        </div>
                      </div>
                    ) : l.notes ? (
                      <div className="mt-2 text-[11px] text-muted-foreground line-clamp-2">{l.notes}</div>
                    ) : (
                      <div className="mt-2 text-[11px] text-muted-foreground italic">Sem resumo ainda</div>
                    )}
                  </button>
                ))}
                {col.items.length === 0 && <p className="text-xs text-muted-foreground py-4 text-center">Vazio</p>}
              </div>
            </div>
          ))}
          {funnelCols.length === 0 && columns.length === 0 && (
            <p className="text-sm text-muted-foreground col-span-full">Nenhuma coluna configurada neste CRM.</p>
          )}
        </div>
      )}

      <LeadDetailSheet
        lead={openLead}
        tenantId={tenantId ?? ""}
        funnelCols={funnelCols}
        onClose={() => setOpenLead(null)}
        onSaved={() => refetch()}
        onOpenConversation={(phone) => navigate(`/app/conversas?phone=${encodeURIComponent(phone)}`)}
      />
    </div>
  );
}

function LeadDetailSheet({
  lead,
  tenantId,
  funnelCols,
  onClose,
  onSaved,
  onOpenConversation,
}: {
  lead: any | null;
  tenantId: string;
  funnelCols: any[];
  onClose: () => void;
  onSaved: () => void;
  onOpenConversation: (phone: string) => void;
}) {
  const updateLead = useUpdateLead();
  const moveLead = useMoveLead();

  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const [notes, setNotes] = useState("");
  const [labelId, setLabelId] = useState<string>("");

  useEffect(() => {
    if (!lead) return;
    setName(lead.name ?? "");
    setSummary(lead.ai_summary ?? "");
    setNotes(lead.notes ?? "");
    setLabelId(String(lead.label_id ?? ""));
  }, [lead?.id]);

  if (!lead) return null;

  const dirty =
    name !== (lead.name ?? "") ||
    summary !== (lead.ai_summary ?? "") ||
    notes !== (lead.notes ?? "");

  const handleSave = async () => {
    try {
      await updateLead.mutateAsync({
        leadId: lead.id,
        tenantId,
        patch: {
          name: name.trim() || null,
          ai_summary: summary,
          notes: notes.trim() ? notes : null,
        } as any,
      });
      toast.success("Lead atualizado");
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || "Erro ao salvar");
    }
  };

  const handleMove = async (newLabelId: string) => {
    const col = funnelCols.find((c) => String(c.label_id) === newLabelId);
    try {
      await moveLead.mutateAsync({
        leadId: lead.id,
        tenantId,
        phoneNumber: lead.phone_number,
        toLabelId: newLabelId,
        toLabelName: col?.name,
      });
      setLabelId(newLabelId);
      toast.success(`Movido para ${col?.name ?? newLabelId}`);
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || "Erro ao mover");
    }
  };

  return (
    <Sheet open={!!lead} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{lead.name || lead.phone_number}</SheetTitle>
          <SheetDescription>{lead.phone_number}</SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-5">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => onOpenConversation(lead.phone_number)}>
              <MessageCircle className="w-4 h-4 mr-2" />
              Abrir conversa
            </Button>
            {lead.ai_summary_updated_at && (
              <Badge variant="secondary" className="text-[10px]">
                Resumo atualizado {formatDistanceToNow(new Date(lead.ai_summary_updated_at), { addSuffix: true, locale: ptBR })}
              </Badge>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="lead-name">Nome</Label>
            <Input id="lead-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome do cliente" />
          </div>

          <div className="space-y-2">
            <Label htmlFor="lead-summary" className="flex items-center gap-2">
              <Bot className="w-3.5 h-3.5 text-primary" /> Resumo da IA
            </Label>
            <Textarea
              id="lead-summary"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Resumo gerado pela IA a partir das conversas. Você pode editar."
              rows={6}
              maxLength={1200}
            />
            <p className="text-[11px] text-muted-foreground">{summary.length}/1200 caracteres</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="lead-notes">Notas internas</Label>
            <Textarea
              id="lead-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Observações que ficam só para a equipe."
              rows={3}
            />
          </div>

          {funnelCols.length > 0 && (
            <div className="space-y-2">
              <Label>Coluna do funil</Label>
              <Select value={labelId} onValueChange={handleMove}>
                <SelectTrigger><SelectValue placeholder="Mover para…" /></SelectTrigger>
                <SelectContent>
                  {funnelCols.map((c) => (
                    <SelectItem key={c.label_id} value={String(c.label_id)}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2 sticky bottom-0 bg-background pb-2">
            <Button variant="ghost" onClick={onClose}>Fechar</Button>
            <Button onClick={handleSave} disabled={!dirty || updateLead.isPending}>
              <Save className="w-4 h-4 mr-2" />
              {updateLead.isPending ? "Salvando…" : "Salvar"}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
