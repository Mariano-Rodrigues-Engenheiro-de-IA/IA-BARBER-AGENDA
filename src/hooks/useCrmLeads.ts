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
}

export function useCrmLeads(tenantId: string | undefined) {
  return useQuery({
    queryKey: ["crm-leads", tenantId],
    queryFn: async () => {
      if (!tenantId) return [];
      const { data, error } = await supabase
        .from("crm_leads")
        .select("*")
        .eq("tenant_id", tenantId)
        .order("updated_at", { ascending: false });
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
      // Call edge function to move label in UAZAPI + update DB
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
