import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Eye, EyeOff, Loader2, CheckCircle2, Link2, Unlink } from "lucide-react";
import { toast } from "sonner";

/** Painel ADMIN — só cuida do token de acesso ao CRM externo. A escolha de
 * qual(is) funil(is) usar fica por conta do próprio cliente, na aba "CRM"
 * do painel dele — o token nunca fica visível/editável por lá, só o admin
 * mexe aqui. */
export function ZettaCrmTokenAdmin({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const { data: tenant, isLoading } = useQuery({
    queryKey: ["tenant-crm-token", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants" as any)
        .select("crm_zetta_token")
        .eq("id", tenantId)
        .single();
      if (error) throw error;
      return data as unknown as { crm_zetta_token: string | null };
    },
    enabled: !!tenantId,
  });

  const [tokenInput, setTokenInput] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [funnelsFound, setFunnelsFound] = useState<number | null>(null);

  const connected = Boolean(tenant?.crm_zetta_token);

  const handleTest = async () => {
    const value = tokenInput.trim();
    if (!value) {
      toast.error("Cola o token do CRM primeiro.");
      return;
    }
    setTesting(true);
    setFunnelsFound(null);
    try {
      const { data, error } = await supabase.functions.invoke("crm-zetta-list-funnels", {
        body: { crm_zetta_token: value },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      const count = (data?.funnels ?? []).length;
      setFunnelsFound(count);
      toast.success(`Token válido — ${count} funil(is) disponível(is) para o cliente escolher.`);
    } catch (e: any) {
      toast.error(e?.message || "Não consegui conectar com esse token.");
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    const value = tokenInput.trim();
    if (!value) {
      toast.error("Cola e testa o token antes de salvar.");
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.from("tenants" as any).update({ crm_zetta_token: value }).eq("id", tenantId);
      if (error) throw error;
      toast.success("Token salvo — o cliente já pode escolher os funis no painel dele.");
      setTokenInput("");
      setFunnelsFound(null);
      qc.invalidateQueries({ queryKey: ["tenant-crm-token", tenantId] });
    } catch (e: any) {
      toast.error(e?.message || "Erro ao salvar");
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm("Remover o token do CRM? A IA para de mover leads e o cliente perde acesso à aba de CRM até você reconectar.")) return;
    setSaving(true);
    try {
      const { error } = await supabase.from("tenants" as any).update({ crm_zetta_token: null }).eq("id", tenantId);
      if (error) throw error;
      toast.success("Token removido");
      qc.invalidateQueries({ queryKey: ["tenant-crm-token", tenantId] });
    } catch (e: any) {
      toast.error(e?.message || "Erro ao remover");
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
          Token de acesso ao CRM
        </h3>
        <p className="text-sm text-muted-foreground mt-1">
          Só o admin configura o token. Depois de salvo, o cliente ganha acesso à aba "CRM" no painel dele, onde
          escolhe sozinho quais funis a IA deve usar — sem nunca ver esse token.
        </p>
      </div>

      {connected && (
        <div className="rounded-lg border border-green-500/30 bg-green-500/5 p-4 flex items-center justify-between flex-wrap gap-3">
          <p className="text-sm font-medium text-foreground">Token configurado</p>
          <Button type="button" variant="outline" size="sm" onClick={handleDisconnect} disabled={saving}>
            <Unlink className="w-4 h-4 mr-2" />Remover
          </Button>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="crm-zetta-token">{connected ? "Trocar token" : "Token de acesso do CRM"}</Label>
        <div className="relative">
          <Input
            id="crm-zetta-token"
            type={showToken ? "text" : "password"}
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="Cole aqui o token de acesso"
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
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={handleTest} disabled={testing || !tokenInput.trim()}>
            {testing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Link2 className="w-4 h-4 mr-2" />}
            {testing ? "Testando..." : "Testar token"}
          </Button>
          <Button type="button" onClick={handleSave} disabled={saving || !tokenInput.trim()}>
            {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            {saving ? "Salvando..." : "Salvar"}
          </Button>
        </div>
        {funnelsFound !== null && (
          <p className="text-xs text-muted-foreground">{funnelsFound} funil(is) encontrado(s) nesse CRM.</p>
        )}
      </div>
    </div>
  );
}
