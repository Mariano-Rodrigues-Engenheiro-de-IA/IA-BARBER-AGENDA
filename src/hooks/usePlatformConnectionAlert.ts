import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export type PlatformConnectionAlertConfig = {
  active: boolean;
  owner_phone_e164: string | null;
  connected_message_template: string;
  disconnected_message_template: string;
};

const DEFAULT_CONNECTED_MESSAGE =
  "✅ {empresa} reconectou e está funcionando normalmente novamente.";
const DEFAULT_DISCONNECTED_MESSAGE =
  "⚠️ Atenção: {empresa} desconectou. A IA de atendimento não está recebendo mensagens novas até reconectar.";

/** Configuração global (linha única) do aviso ao dono da PLATAFORMA
 * (Mariano) quando a conexão do WhatsApp de qualquer cliente cai ou
 * volta — diferente do resto do sistema, não é por tenant. */
export function usePlatformConnectionAlert() {
  const queryClient = useQueryClient();

  const { data: config, isLoading: loadingConfig } = useQuery({
    queryKey: ["platform-connection-alert-config"],
    queryFn: async (): Promise<PlatformConnectionAlertConfig> => {
      const { data, error } = await supabase
        .from("platform_connection_alert_config")
        .select(
          "active, owner_phone_e164, connected_message_template, disconnected_message_template",
        )
        .eq("id", true)
        .maybeSingle();
      if (error) throw error;
      return (
        data ?? {
          active: false,
          owner_phone_e164: null,
          connected_message_template: DEFAULT_CONNECTED_MESSAGE,
          disconnected_message_template: DEFAULT_DISCONNECTED_MESSAGE,
        }
      );
    },
  });

  const saveConfig = async (
    patch: Partial<PlatformConnectionAlertConfig>,
  ): Promise<boolean> => {
    const next = { ...config, ...patch, id: true };
    const { error } = await supabase
      .from("platform_connection_alert_config")
      .upsert(next, { onConflict: "id" });
    if (error) {
      toast.error(error.message);
      return false;
    }
    toast.success("Salvo");
    queryClient.invalidateQueries({
      queryKey: ["platform-connection-alert-config"],
    });
    return true;
  };

  return { config, loadingConfig, saveConfig };
}
