import { useState, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTenant } from "@/hooks/useTenants";
import { useCrmLeads, useMoveLead, type KanbanColumn, type CrmLead } from "@/hooks/useCrmLeads";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Phone, Clock, MessageSquare, GripVertical } from "lucide-react";
import {
  DndContext,
  DragOverlay,
  closestCorners,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useDroppable, useDraggable } from "@dnd-kit/core";
import { toast } from "sonner";

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

// ===================== DROPPABLE COLUMN =====================

function KanbanColumnComponent({
  column,
  leads,
  lastMessages,
}: {
  column: KanbanColumn;
  leads: CrmLead[];
  lastMessages: Record<string, string>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.label_id });

  return (
    <div
      ref={setNodeRef}
      className={`flex flex-col min-w-[280px] max-w-[320px] w-full rounded-xl border transition-colors ${
        isOver ? "border-primary bg-primary/5" : "border-border bg-muted/30"
      }`}
    >
      {/* Column header */}
      <div className="flex items-center gap-2 p-3 border-b border-border">
        <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: column.color }} />
        <h3 className="font-semibold text-sm text-foreground flex-1 truncate">{column.name}</h3>
        <Badge variant="secondary" className="text-[10px] px-1.5 h-5">
          {leads.length}
        </Badge>
      </div>

      {/* Cards */}
      <div className="flex-1 p-2 space-y-2 min-h-[100px] overflow-y-auto max-h-[calc(100vh-280px)]">
        {leads.map((lead) => (
          <LeadCard key={lead.id} lead={lead} lastMessage={lastMessages[lead.phone_number]} />
        ))}
        {leads.length === 0 && (
          <div className="text-center text-xs text-muted-foreground py-8">
            Nenhum lead
          </div>
        )}
      </div>
    </div>
  );
}

// ===================== LEAD CARD (DRAGGABLE) =====================

function LeadCard({ lead, lastMessage, overlay, flagColumns }: { lead: CrmLead; lastMessage?: string; overlay?: boolean; flagColumns?: KanbanColumn[] }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: lead.id,
    data: lead,
  });

  const activeFlags = (flagColumns || []).filter((fc) =>
    lead.flag_labels?.includes(fc.label_id)
  );

  return (
    <div
      ref={overlay ? undefined : setNodeRef}
      {...(overlay ? {} : listeners)}
      {...(overlay ? {} : attributes)}
      className={`glass-card p-3 space-y-2 cursor-grab active:cursor-grabbing transition-shadow ${
        isDragging && !overlay ? "opacity-30" : ""
      } ${overlay ? "shadow-xl ring-2 ring-primary/30 rotate-2" : "hover:shadow-md"}`}
    >
      <div className="flex items-center gap-2">
        <GripVertical className="w-3 h-3 text-muted-foreground shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate">
            {lead.name || lead.phone_number}
          </p>
          {lead.name && (
            <p className="text-[11px] text-muted-foreground flex items-center gap-1">
              <Phone className="w-3 h-3" />
              {lead.phone_number}
            </p>
          )}
        </div>
        <span className="text-[10px] text-muted-foreground flex items-center gap-0.5 shrink-0">
          <Clock className="w-3 h-3" />
          {timeAgo(lead.updated_at)}
        </span>
      </div>
      {activeFlags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {activeFlags.map((flag) => (
            <Badge
              key={flag.label_id}
              variant="outline"
              className="text-[9px] px-1.5 h-4 border-opacity-60"
              style={{ borderColor: flag.color, color: flag.color }}
            >
              {flag.name}
            </Badge>
          ))}
        </div>
      )}
      {lastMessage && (
        <p className="text-[11px] text-muted-foreground truncate flex items-center gap-1">
          <MessageSquare className="w-3 h-3 shrink-0" />
          {lastMessage}
        </p>
      )}
      {lead.notes && (
        <p className="text-[11px] text-muted-foreground/70 italic truncate">📝 {lead.notes}</p>
      )}
    </div>
  );
}

// ===================== MAIN PAGE =====================

export default function TenantKanbanPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data: tenant, isLoading: loadingTenant } = useTenant(id);
  const { data: leads, isLoading: loadingLeads } = useCrmLeads(id);
  const moveLead = useMoveLead();
  const [activeLead, setActiveLead] = useState<CrmLead | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  // Get kanban columns from tenant config
  const allColumns: KanbanColumn[] = useMemo(() => {
    const raw = (tenant as any)?.kanban_columns;
    if (!Array.isArray(raw) || raw.length === 0) return [];
    return [...raw].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }, [tenant]);

  // Separate funnel columns from flag columns
  const columns = useMemo(() => allColumns.filter((c) => c.type !== "flag"), [allColumns]);
  const flagColumns = useMemo(() => allColumns.filter((c) => c.type === "flag"), [allColumns]);

  // Fetch last messages for all leads
  const phoneNumbers = useMemo(() => leads?.map((l) => l.phone_number) || [], [leads]);
  const { data: lastMessagesRaw } = useQuery({
    queryKey: ["kanban-last-messages", id, phoneNumbers],
    queryFn: async () => {
      if (!id || phoneNumbers.length === 0) return [];
      // Get last user message per phone
      const { data, error } = await supabase
        .from("chat_messages")
        .select("phone_number, content, created_at")
        .eq("tenant_id", id)
        .eq("role", "user")
        .in("phone_number", phoneNumbers)
        .order("created_at", { ascending: false })
        .limit(phoneNumbers.length * 2);
      if (error) throw error;
      return data;
    },
    enabled: !!id && phoneNumbers.length > 0,
  });

  const lastMessages = useMemo(() => {
    const map: Record<string, string> = {};
    lastMessagesRaw?.forEach((m) => {
      if (!map[m.phone_number]) {
        map[m.phone_number] = m.content.slice(0, 80);
      }
    });
    return map;
  }, [lastMessagesRaw]);

  // Group leads by label_id
  const leadsByLabel = useMemo(() => {
    const map: Record<string, CrmLead[]> = {};
    columns.forEach((c) => (map[c.label_id] = []));
    leads?.forEach((lead) => {
      if (map[lead.label_id]) {
        map[lead.label_id].push(lead);
      }
    });
    return map;
  }, [leads, columns]);

  // Leads not in any configured column
  const uncategorizedLeads = useMemo(() => {
    const columnIds = new Set(columns.map((c) => c.label_id));
    return leads?.filter((l) => !columnIds.has(l.label_id)) || [];
  }, [leads, columns]);

  function handleDragStart(event: DragStartEvent) {
    const lead = event.active.data.current as CrmLead;
    setActiveLead(lead);
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveLead(null);
    const { active, over } = event;
    if (!over) return;

    const lead = active.data.current as CrmLead;
    const targetLabelId = over.id as string;

    if (lead.label_id === targetLabelId) return;

    const targetColumn = columns.find((c) => c.label_id === targetLabelId);
    if (!targetColumn) return;

    try {
      await moveLead.mutateAsync({
        leadId: lead.id,
        tenantId: id!,
        phoneNumber: lead.phone_number,
        toLabelId: targetLabelId,
        toLabelName: targetColumn.name,
      });
      toast.success(`Lead movido para ${targetColumn.name}`);
    } catch (err: any) {
      toast.error(`Erro ao mover lead: ${err.message}`);
    }
  }

  if (loadingTenant) {
    return <div className="text-muted-foreground">Carregando...</div>;
  }

  if (columns.length === 0) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate(`/tenants/${id}`)}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div>
            <h2 className="text-2xl font-bold text-foreground">{tenant?.name}</h2>
            <p className="text-muted-foreground mt-1">CRM Kanban</p>
          </div>
        </div>
        <div className="glass-card p-8 text-center space-y-4">
          <h3 className="text-lg font-semibold text-foreground">Kanban não configurado</h3>
          <p className="text-muted-foreground">
            Configure as colunas do Kanban nas configurações do tenant para começar a usar o CRM.
          </p>
          <Button onClick={() => navigate(`/tenants/${id}`)}>
            Configurar Colunas
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate(`/tenants/${id}/dashboard`)}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h2 className="text-2xl font-bold text-foreground">{tenant?.name}</h2>
          <p className="text-muted-foreground mt-1">CRM Kanban</p>
        </div>
        {uncategorizedLeads.length > 0 && (
          <Badge variant="outline" className="ml-auto">
            {uncategorizedLeads.length} leads sem coluna
          </Badge>
        )}
      </div>

      {loadingLeads ? (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {columns.map((c) => (
            <Skeleton key={c.label_id} className="min-w-[280px] h-[400px] rounded-xl" />
          ))}
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div className="flex gap-4 overflow-x-auto pb-4">
            {columns.map((column) => (
              <KanbanColumnComponent
                key={column.label_id}
                column={column}
                leads={leadsByLabel[column.label_id] || []}
                lastMessages={lastMessages}
              />
            ))}
          </div>

          <DragOverlay>
            {activeLead ? (
              <div className="w-[280px]">
                <LeadCard lead={activeLead} lastMessage={lastMessages[activeLead.phone_number]} overlay />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
}
