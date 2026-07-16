import { supabase } from "@/integrations/supabase/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Tables, TablesInsert, TablesUpdate } from "@/integrations/supabase/types";

export type Tenant = Tables<"tenants">;
export type TenantInsert = TablesInsert<"tenants">;
export type TenantUpdate = TablesUpdate<"tenants">;

const TENANT_LIST_COLUMNS = "id,name,slug,phone,email,address,status,api_provider,trinks_api_key,trinks_establishment_id,onebeleza_token,onebeleza_celular,booking_link,uazapi_token,uazapi_url,whatsapp_number,visibility,created_by,created_at,updated_at" as const;

export function useTenants() {
  return useQuery({
    queryKey: ["tenants"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants")
        .select(TENANT_LIST_COLUMNS)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as Tenant[];
    },
  });
}

export function useTenant(id: string | undefined) {
  return useQuery({
    queryKey: ["tenants", id],
    queryFn: async () => {
      if (!id) return null;
      const { data, error } = await supabase
        .from("tenants")
        .select("*")
        .eq("id", id)
        .single();
      if (error) throw error;
      return data as Tenant;
    },
    enabled: !!id,
  });
}

export function useCreateTenant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (tenant: TenantInsert) => {
      const { data, error } = await supabase
        .from("tenants")
        .insert(tenant)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tenants"] }),
  });
}

export function useUpdateTenant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...updates }: TenantUpdate & { id: string }) => {
      const { data, error } = await supabase
        .from("tenants")
        .update(updates)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tenants"] }),
  });
}

export function useDeleteTenant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("tenants").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tenants"] }),
  });
}
