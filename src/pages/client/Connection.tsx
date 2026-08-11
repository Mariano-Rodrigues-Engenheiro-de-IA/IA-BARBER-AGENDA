import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useMutation, keepPreviousData } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, Power, RefreshCw, Smartphone, CheckCircle2, XCircle, QrCode } from "lucide-react";
import { toast } from "sonner";

type StatusResp = {
  instance?: { status?: string; name?: string; phoneConnected?: string; profileName?: string };
  status?: { connected?: boolean; loggedIn?: boolean; jid?: any };
};

type ConnectResp = {
  instance?: any;
  qrcode?: string;       // base64 image or string
  paircode?: string;
};

async function call(action: string, body: Record<string, any> = {}) {
  const { data, error } = await supabase.functions.invoke("whatsapp-instance", {
    body: { action, ...body },
  });
  if (error) throw error;
  return data;
}

export default function ClientConnection() {
  const { tenantId } = useAuth();
  const [qr, setQr] = useState<string | null>(null);
  const [pairCode, setPairCode] = useState<string | null>(null);

  const statusQ = useQuery<StatusResp>({
    queryKey: ["wa-status", tenantId],
    enabled: !!tenantId,
    queryFn: () => call("status"),
    refetchInterval: 5000,
    // Sem isso, toda vez que o usuário troca de aba e volta (React Query
    // refaz a consulta automaticamente no foco), os dados somem por um
    // instante enquanto a nova resposta não chega — e o status cai no
    // fallback "disconnected" (?? "disconnected" abaixo), fazendo a tela
    // piscar "reconectando" mesmo com a conexão real estável.
    placeholderData: keepPreviousData,
  });

  const instStatus = statusQ.data?.instance?.status ?? "disconnected";
  const connected = instStatus === "connected" || statusQ.data?.status?.connected === true;
  const connecting = instStatus === "connecting";

  // when connected, clear QR
  useEffect(() => {
    if (connected) {
      setQr(null);
      setPairCode(null);
    }
  }, [connected]);

  const connectMut = useMutation({
    mutationFn: (phone?: string) => call("connect", phone ? { phone } : {}) as Promise<ConnectResp>,
    onSuccess: (data) => {
      setQr(data?.qrcode ?? null);
      setPairCode(data?.paircode ?? null);
      toast.success("Aguardando leitura do QR code...");
      statusQ.refetch();
    },
    onError: (e: any) => toast.error(e.message ?? "Erro ao conectar"),
  });

  const disconnectMut = useMutation({
    mutationFn: () => call("disconnect"),
    onSuccess: () => {
      setQr(null);
      setPairCode(null);
      toast.success("WhatsApp desconectado");
      statusQ.refetch();
    },
    onError: (e: any) => toast.error(e.message ?? "Erro ao desconectar"),
  });

  // While connecting, poll status to pick up fresh QR if not received
  useEffect(() => {
    if (!connecting || qr) return;
    const t = setInterval(() => statusQ.refetch(), 3000);
    return () => clearInterval(t);
  }, [connecting, qr]);

  // pull QR out of status payload too
  useEffect(() => {
    const anyData: any = statusQ.data;
    const code = anyData?.instance?.qrcode || anyData?.qrcode;
    if (code && !connected) setQr(code);
  }, [statusQ.data, connected]);

  const qrSrc = qr
    ? qr.startsWith("data:") ? qr : `data:image/png;base64,${qr}`
    : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Conexão</h1>
        <p className="text-muted-foreground">Conecte ou desconecte o WhatsApp da sua IA</p>
      </div>

      <div className="glass-card p-6 space-y-4">
        <div className="flex items-center gap-3">
          <Smartphone className="w-5 h-5 text-muted-foreground" />
          <div className="flex-1">
            <p className="text-sm text-muted-foreground">Status atual</p>
            <div className="flex items-center gap-2 mt-0.5">
              {connected ? (
                <>
                  <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                  <span className="font-semibold text-foreground">Conectado</span>
                </>
              ) : connecting ? (
                <>
                  <Loader2 className="w-4 h-4 text-amber-500 animate-spin" />
                  <span className="font-semibold text-foreground">Conectando...</span>
                </>
              ) : (
                <>
                  <XCircle className="w-4 h-4 text-red-500" />
                  <span className="font-semibold text-foreground">Desconectado</span>
                </>
              )}
            </div>
            {statusQ.data?.instance?.profileName && (
              <p className="text-xs text-muted-foreground mt-1">
                Perfil: {statusQ.data.instance.profileName}
                {statusQ.data?.instance?.phoneConnected && ` · ${statusQ.data.instance.phoneConnected}`}
              </p>
            )}
          </div>
          <Button variant="outline" size="icon" onClick={() => statusQ.refetch()} disabled={statusQ.isFetching}>
            <RefreshCw className={`w-4 h-4 ${statusQ.isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>

        <div className="flex flex-wrap gap-2">
          {!connected && (
            <Button onClick={() => connectMut.mutate(undefined)} disabled={connectMut.isPending}>
              {connectMut.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <QrCode className="w-4 h-4 mr-2" />}
              Gerar QR code
            </Button>
          )}
          {(connected || connecting) && (
            <Button variant="destructive" onClick={() => disconnectMut.mutate()} disabled={disconnectMut.isPending}>
              {disconnectMut.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Power className="w-4 h-4 mr-2" />}
              Desconectar
            </Button>
          )}
        </div>
      </div>

      {!connected && qrSrc && (
        <div className="glass-card p-6 flex flex-col items-center gap-4">
          <h2 className="text-lg font-semibold text-foreground">Escaneie o QR code</h2>
          <p className="text-sm text-muted-foreground text-center max-w-md">
            Abra o WhatsApp no seu celular → Configurações → Aparelhos conectados →
            Conectar um aparelho. Aponte a câmera para o código abaixo.
          </p>
          <div className="bg-white p-4 rounded-xl">
            <img src={qrSrc} alt="QR code WhatsApp" className="w-64 h-64" />
          </div>
          {pairCode && (
            <p className="text-sm text-muted-foreground">
              Ou use o código de pareamento: <span className="font-mono font-bold text-foreground">{pairCode}</span>
            </p>
          )}
          <p className="text-xs text-muted-foreground">O QR expira em 2 minutos. Clique em "Gerar QR code" para um novo.</p>
        </div>
      )}

      {!connected && !qrSrc && !connecting && (
        <div className="glass-card p-6 text-sm text-muted-foreground">
          Clique em "Gerar QR code" para iniciar a conexão do WhatsApp à sua IA.
        </div>
      )}
    </div>
  );
}
