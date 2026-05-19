import { supabase } from "@/integrations/supabase/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export interface CrmLead {
  id: string;
  tenant_id: string;
  phone_number: string;
  name: string | null;
  label_id: string;
  label_name: string | null;
  notes: string | null;
  flag_labels: string[];
  board_id: string | null;
  created_at: string;
  updated_at: string;
  last_message?: string;
}

export interface CrmLeadHistory {
  id: string;
  lead_id: string;
  from_label: string | null;
  to_label: string;
  changed_by: string | null;
  changed_at: string;
}

export interface KanbanColumn {
  label_id: string;
  name: string;
  color: string;
  order: number;
  type?: "funnel" | "flag";
}

export interface CrmBoard {
  id: string;
  tenant_id: string;
  name: string;
  order: number;
  columns: KanbanColumn[];
  created_at: string;
  updated_at: string;
}

export function useCrmBoards(tenantId: string | undefined) {
  return useQuery({
    queryKey: ["crm-boards", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("crm_boards" as any)
        .select("*")
        .eq("tenant_id", tenantId!)
        .order("order", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as CrmBoard[];
    },
  });
}

export function useCreateBoard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ tenantId, name, order }: { tenantId: string; name: string; order: number }) => {
      const { data, error } = await supabase
        .from("crm_boards" as any)
        .insert({ tenant_id: tenantId, name, order, columns: [] })
        .select()
        .single();
      if (error) throw error;
      return data as unknown as CrmBoard;
    },
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: ["crm-boards", v.tenantId] }),
  });
}

export function useUpdateBoard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, tenantId, patch }: { id: string; tenantId: string; patch: Partial<Pick<CrmBoard, "name" | "order" | "columns">> }) => {
      const { error } = await supabase.from("crm_boards" as any).update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: ["crm-boards", v.tenantId] }),
  });
}

export function useDeleteBoard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, tenantId }: { id: string; tenantId: string }) => {
      const { error } = await supabase.from("crm_boards" as any).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: ["crm-boards", v.tenantId] }),
  });
}

export function useCrmLeads(tenantId: string | undefined, boardId?: string | null, includeUnassigned = false) {
  return useQuery({
    queryKey: ["crm-leads", tenantId, boardId ?? null, includeUnassigned],
    queryFn: async () => {
      if (!tenantId) return [];
      let q = supabase
        .from("crm_leads")
        .select("*")
        .eq("tenant_id", tenantId)
        .order("updated_at", { ascending: false });
      if (boardId) {
        q = includeUnassigned ? q.or(`board_id.eq.${boardId},board_id.is.null`) : q.eq("board_id", boardId);
      }
      const { data, error } = await q;
      if (error) throw error;
      return data as CrmLead[];
    },
    enabled: !!tenantId,
  });
}

export function useCrmLeadHistory(leadId: string | undefined) {
  return useQuery({
    queryKey: ["crm-lead-history", leadId],
    queryFn: async () => {
      if (!leadId) return [];
      const { data, error } = await supabase
        .from("crm_lead_history")
        .select("*")
        .eq("lead_id", leadId)
        .order("changed_at", { ascending: false });
      if (error) throw error;
      return data as CrmLeadHistory[];
    },
    enabled: !!leadId,
  });
}

export function useMoveLead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      leadId,
      tenantId,
      phoneNumber,
      toLabelId,
      toLabelName,
    }: {
      leadId: string;
      tenantId: string;
      phoneNumber: string;
      toLabelId: string;
      toLabelName?: string;
    }) => {
      const { data, error } = await supabase.functions.invoke("move-crm-lead", {
        body: { leadId, tenantId, phoneNumber, toLabelId, toLabelName },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["crm-leads", variables.tenantId] });
    },
  });
}

export function useToggleFlag() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      tenantId,
      phoneNumber,
      flagLabelId,
    }: {
      tenantId: string;
      phoneNumber: string;
      flagLabelId: string;
    }) => {
      const { data, error } = await supabase.functions.invoke("move-crm-lead", {
        body: { tenantId, phoneNumber, toggleFlag: flagLabelId },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["crm-leads", variables.tenantId] });
    },
  });
}

export function useUpdateLeadNotes() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ leadId, notes, tenantId }: { leadId: string; notes: string; tenantId: string }) => {
      const { error } = await supabase
        .from("crm_leads")
        .update({ notes })
        .eq("id", leadId);
      if (error) throw error;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["crm-leads", variables.tenantId] });
    },
  });
}

export function useAssignLeadBoard() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ leadId, boardId, tenantId }: { leadId: string; boardId: string; tenantId: string }) => {
      const { error } = await supabase.from("crm_leads").update({ board_id: boardId }).eq("id", leadId);
      if (error) throw error;
    },
    onSuccess: (_, v) => queryClient.invalidateQueries({ queryKey: ["crm-leads", v.tenantId] }),
  });
}
