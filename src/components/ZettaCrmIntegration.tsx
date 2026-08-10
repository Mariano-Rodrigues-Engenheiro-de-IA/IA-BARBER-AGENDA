import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Eye, EyeOff, Loader2, CheckCircle2, Link2, Unlink } from "lucide-react";
import { toast } from "sonner";

type ZettaFunnel = { id: string; name: string; stages: { id: string; name: string }[] };

/** Integração com o CRM externo — a IA usa isso para mover leads pelo funil
 * de vendas durante a conversa. Não menciona o nome comercial do CRM na
 * tela, só "CRM" genérico, a pedido do Mariano. */
export function ZettaCrmIntegration({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const { data: tenant, isLoading } = useQuery({
    queryKey: ["tenant-crm-zetta", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants" as any)
        .select("crm_zetta_token, crm_zetta_funnel_id, crm_zetta_funnel_name, crm_zetta_stages")
        .eq("id", tenantId)
        .single();
      if (error) throw error;
      return data as unknown as {
        crm_zetta_token: string | null;
        crm_zetta_funnel_id: string | null;
        crm_zetta_funnel_name: string | null;
        crm_zetta_stages: { id: string; name: string }[] | null;
      };
    },
    enabled: !!tenantId,
  });

  const [tokenInput, setTokenInput] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [testing, setTesting] = useState(false);
  const [funnels, setFunnels] = useState<ZettaFunnel[] | null>(null);
  const [selectedFunnelId, setSelectedFunnelId] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (tenant?.crm_zetta_funnel_id) setSelectedFunnelId(tenant.crm_zetta_funnel_id);
  }, [tenant?.crm_zetta_funnel_id]);

  const connected = Boolean(tenant?.crm_zetta_token && tenant?.crm_zetta_funnel_id);

  const handleTestToken = async () => {
    const value = tokenInput.trim();
    if (!value) {
      toast.error("Cola o token do CRM primeiro.");
      return;
    }
    setTesting(true);
    setFunnels(null);
    try {
      const { data, error } = await supabase.functions.invoke("crm-zetta-list-funnels", {
        body: { crm_zetta_token: value },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      const list = (data?.funnels ?? []) as ZettaFunnel[];
      setFunnels(list);
      if (list.length === 0) {
        toast.error("Token válido, mas não achei nenhum funil nesse CRM.");
      } else {
        toast.success(`Conectado — ${list.length} funil(is) encontrado(s).`);
      }
    } catch (e: any) {
      toast.error(e?.message || "Não consegui conectar com esse token.");
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    const value = tokenInput.trim() || tenant?.crm_zetta_token || "";
    if (!value || !selectedFunnelId) {
      toast.error("Testa o token e escolhe um funil antes de salvar.");
      return;
    }
    const funnel = (funnels ?? []).find((f) => f.id === selectedFunnelId);
    setSaving(true);
    try {
      const { error } = await supabase
        .from("tenants" as any)
        .update({
          crm_zetta_token: value,
          crm_zetta_funnel_id: selectedFunnelId,
          crm_zetta_funnel_name: funnel?.name ?? tenant?.crm_zetta_funnel_name ?? null,
          crm_zetta_stages: funnel?.stages ?? tenant?.crm_zetta_stages ?? null,
        })
        .eq("id", tenantId);
      if (error) throw error;
      toast.success("Integração salva. A IA já pode mover leads nesse funil.");
      setTokenInput("");
      qc.invalidateQueries({ queryKey: ["tenant-crm-zetta", tenantId] });
    } catch (e: any) {
      toast.error(e?.message || "Erro ao salvar");
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm("Desconectar o CRM? A IA para de mover leads pelo funil até você reconectar.")) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from("tenants" as any)
        .update({ crm_zetta_token: null, crm_zetta_funnel_id: null, crm_zetta_funnel_name: null, crm_zetta_stages: null })
        .eq("id", tenantId);
      if (error) throw error;
      toast.success("Desconectado");
      setFunnels(null);
      setSelectedFunnelId("");
      qc.invalidateQueries({ queryKey: ["tenant-crm-zetta", tenantId] });
    } catch (e: any) {
      toast.error(e?.message || "Erro ao desconectar");
    } finally {
      setSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="text-sm text-muted-foreground flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />Carregando...
      </div>
    );
  }

  return (
    <div className="glass-card p-6 space-y-5">
      <div>
        <h3 className="font-semibold text-foreground flex items-center gap-2">
          {connected ? <CheckCircle2 className="w-5 h-5 text-green-500" /> : <Link2 className="w-5 h-5 text-primary" />}
          Integração com o CRM
        </h3>
        <p className="text-sm text-muted-foreground mt-1">
          Conecta a IA ao funil de vendas do seu CRM. Depois de conectado, a IA pode mover o lead entre as etapas
          desse funil durante a conversa (ex: quando o cliente demonstra interesse, agenda, ou desiste).
        </p>
      </div>

      {connected && (
        <div className="rounded-lg border border-green-500/30 bg-green-500/5 p-4 flex items-center justify-between flex-wrap gap-3">
          <div>
            <p className="text-sm font-medium text-foreground">Conectado</p>
            <p className="text-xs text-muted-foreground">Funil ativo: {tenant?.crm_zetta_funnel_name}</p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={handleDisconnect} disabled={saving}>
            <Unlink className="w-4 h-4 mr-2" />Desconectar
          </Button>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="crm-zetta-token">{connected ? "Trocar token (opcional)" : "Token de acesso do CRM"}</Label>
        <div className="relative">
          <Input
            id="crm-zetta-token"
            type={showToken ? "text" : "password"}
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder={connected ? "Deixe em branco para manter o token atual" : "Cole aqui o token de acesso"}
            className="pr-10"
          />
          <button
            type="button"
            onClick={() => setShowToken((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
          >
            {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
        <Button type="button" variant="outline" onClick={handleTestToken} disabled={testing || !tokenInput.trim()}>
          {testing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Link2 className="w-4 h-4 mr-2" />}
          {testing ? "Testando..." : "Testar e buscar funis"}
        </Button>
      </div>

      {(funnels || connected) && (
        <div className="space-y-2">
          <Label>Funil de vendas</Label>
          <Select value={selectedFunnelId} onValueChange={setSelectedFunnelId}>
            <SelectTrigger>
              <SelectValue placeholder="Escolha o funil que a IA vai usar" />
            </SelectTrigger>
            <SelectContent>
              {(funnels ?? []).map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.name}
                </SelectItem>
              ))}
              {/* Mantém a opção atual visível mesmo sem re-testar o token */}
              {connected && !funnels?.some((f) => f.id === tenant?.crm_zetta_funnel_id) && (
                <SelectItem value={tenant!.crm_zetta_funnel_id!}>{tenant?.crm_zetta_funnel_name} (atual)</SelectItem>
              )}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            As etapas desse funil viram, automaticamente, as ações que a IA pode usar para mover o lead.
          </p>
        </div>
      )}

      <Button type="button" onClick={handleSave} disabled={saving || !selectedFunnelId}>
        {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
        {saving ? "Salvando..." : "Salvar integração"}
      </Button>
    </div>
  );
}
