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

  const { data: config, isLoading: loadingConfig, error: configError } = useQuery({
    queryKey: ["celcash-billing-config", tenantId],
    enabled: !!tenantId,
    queryFn: async (): Promise<CelcashBillingConfig> => {
      const { data, error } = await supabase
        .from("celcash_billing_config")
        .select("*")
        .eq("tenant_id", tenantId!)
        .maybeSingle();
      // ⚠️ Corrigido (15/09): antes, um erro aqui (ex: tabela ainda não
      // existia no banco) era silenciosamente ignorado — a query "dava
      // certo" com data=undefined, e a seção inteira simplesmente
      // desaparecia do painel, sem nenhuma pista do motivo. Agora o erro é
      // lançado e exposto (configError), pro componente mostrar de verdade.
      if (error) throw error;
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

  const { data: overdueList, isLoading: loadingOverdue, error: overdueError } = useQuery({
    queryKey: ["celcash-overdue-subscribers", tenantId],
    enabled: !!tenantId,
    staleTime: 60 * 1000,
    queryFn: async (): Promise<CelcashOverdueSubscriber[]> => {
      const { data, error } = await supabase
        .from("celcash_overdue_subscribers")
        .select("id, celcash_customer_id, name, phone_e164, plan_name, overdue_amount_cents, next_due_date")
        .eq("tenant_id", tenantId!)
        .order("next_due_date", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: sentLog } = useQuery({
    queryKey: ["celcash-billing-sent-log", tenantId],
    enabled: !!tenantId,
    staleTime: 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("celcash_billing_sent_log")
        .select("celcash_customer_id, sent_at")
        .eq("tenant_id", tenantId!)
        .order("sent_at", { ascending: false })
        .limit(2000);
      if (error) throw error;
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

  const dispatchNow = async (): Promise<{ sent: number; skipped: number; errors: number } | null> => {
    if (!tenantId) return null;
    const { data, error } = await supabase.functions.invoke("evaluate-celcash-billing", {
      body: { tenant_id: tenantId },
    });
    if (error) {
      toast.error(error.message);
      return null;
    }
    if (data?.note === "config_inactive_or_missing") {
      toast.error("Ative a cobrança e salve antes de disparar.");
      return null;
    }
    toast.success(`Disparo concluído: ${data.sent} enviada(s), ${data.skipped} pulada(s), ${data.errors} com erro.`);
    queryClient.invalidateQueries({ queryKey: ["celcash-billing-sent-log", tenantId] });
    return data;
  };

  const syncNow = async (): Promise<boolean> => {
    if (!tenantId) return false;
    const { data, error } = await supabase.functions.invoke("sync-celcash-overdue", {
      body: { tenant_id: tenantId },
    });
    if (error) {
      toast.error(error.message);
      return false;
    }
    const result = data?.results?.[0];
    if (result?.error) {
      toast.error(result.error);
      return false;
    }
    toast.success(`Sincronizado: ${result?.overdue_upserted ?? 0} inadimplente(s) encontrado(s).`);
    queryClient.invalidateQueries({ queryKey: ["celcash-overdue-subscribers", tenantId] });
    return true;
  };

  return {
    config,
    loadingConfig,
    overdueList: overdueList ?? [],
    loadingOverdue,
    dispatchHistory,
    saveConfig,
    dispatchNow,
    syncNow,
    error: (configError || overdueError) as Error | null,
  };
}
