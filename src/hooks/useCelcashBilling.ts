import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export type CelcashOverdueSubscriber = {
  id: string;
  celcash_customer_id: string;
  name: string | null;
  phone_e164: string | null;
  plan_name: string | null;
  overdue_amount_cents: number;
  next_due_date: string | null;
};

export type CelcashBillingConfig = {
  id?: string;
  tenant_id: string;
  active: boolean;
  message_template: string;
  days_after_due: number;
  repeat_every_days: number | null;
};

const DEFAULT_MESSAGE =
  "Oi {nome}! Vimos que sua assinatura está em atraso. Pode regularizar quando puder? Qualquer dúvida, estamos por aqui 😊";

/** Configuração + lista de inadimplentes + histórico de disparo, para a
 * seção "Cobrança automática" (Integrações, só quando celcash_enabled). */
export function useCelcashBilling(tenantId: string | undefined) {
  const queryClient = useQueryClient();

  const { data: config, isLoading: loadingConfig } = useQuery({
    queryKey: ["celcash-billing-config", tenantId],
    enabled: !!tenantId,
    queryFn: async (): Promise<CelcashBillingConfig> => {
      const { data } = await supabase
        .from("celcash_billing_config")
        .select("*")
        .eq("tenant_id", tenantId!)
        .maybeSingle();
      return (
        data ?? {
          tenant_id: tenantId!,
          active: false,
          message_template: DEFAULT_MESSAGE,
          days_after_due: 1,
          repeat_every_days: null,
        }
      );
    },
  });

  const { data: overdueList, isLoading: loadingOverdue } = useQuery({
    queryKey: ["celcash-overdue-subscribers", tenantId],
    enabled: !!tenantId,
    staleTime: 60 * 1000,
    queryFn: async (): Promise<CelcashOverdueSubscriber[]> => {
      const { data } = await supabase
        .from("celcash_overdue_subscribers")
        .select("id, celcash_customer_id, name, phone_e164, plan_name, overdue_amount_cents, next_due_date")
        .eq("tenant_id", tenantId!)
        .order("next_due_date", { ascending: true });
      return data ?? [];
    },
  });

  const { data: sentLog } = useQuery({
    queryKey: ["celcash-billing-sent-log", tenantId],
    enabled: !!tenantId,
    staleTime: 60 * 1000,
    queryFn: async () => {
      const { data } = await supabase
        .from("celcash_billing_sent_log")
        .select("celcash_customer_id, sent_at")
        .eq("tenant_id", tenantId!)
        .order("sent_at", { ascending: false })
        .limit(2000);
      return data ?? [];
    },
  });

  /** Por cliente: data do último disparo e quantos já recebeu no total. */
  const dispatchHistory = new Map<string, { lastSentAt: string; count: number }>();
  for (const row of sentLog ?? []) {
    const existing = dispatchHistory.get(row.celcash_customer_id);
    if (existing) {
      existing.count += 1;
    } else {
      dispatchHistory.set(row.celcash_customer_id, { lastSentAt: row.sent_at, count: 1 });
    }
  }

  const saveConfig = async (patch: Partial<CelcashBillingConfig>) => {
    if (!tenantId) return false;
    const next = { ...config, ...patch, tenant_id: tenantId } as CelcashBillingConfig;
    const { error } = await supabase
      .from("celcash_billing_config")
      .upsert(next, { onConflict: "tenant_id" });
    if (error) {
      toast.error(error.message);
      return false;
    }
    toast.success("Salvo");
    queryClient.invalidateQueries({ queryKey: ["celcash-billing-config", tenantId] });
    return true;
  };

  return {
    config,
    loadingConfig,
    overdueList: overdueList ?? [],
    loadingOverdue,
    dispatchHistory,
    saveConfig,
  };
}
