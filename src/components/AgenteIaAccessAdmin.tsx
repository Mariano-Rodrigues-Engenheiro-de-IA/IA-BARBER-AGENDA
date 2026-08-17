import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Link2, Unlink, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

/** Painel ADMIN — vincula esse tenant a uma barbearia do CRM Zaylo, pra
 * liberar o acesso sem login (link mágico) a partir de lá. Configurar
 * aqui só depois de confirmar que o cliente comprou o Agente de IA. */
export function AgenteIaAccessAdmin({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const { data: tenant, isLoading } = useQuery({
    queryKey: ["tenant-crm-barbershop-link", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants" as any)
        .select("crm_barbershop_id")
        .eq("id", tenantId)
        .single();
      if (error) throw error;
      return data as unknown as { crm_barbershop_id: string | null };
    },
    enabled: !!tenantId,
  });

  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);

  const linked = tenant?.crm_barbershop_id ?? null;

  async function handleLink() {
    const value = input.trim();
    if (!/^[0-9a-fA-F-]{36}$/.test(value)) {
      toast.error("Cola o ID da barbearia (UUID) do CRM Zaylo — encontra ele no painel /admin do CRM.");
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.from("tenants" as any).update({ crm_barbershop_id: value }).eq("id", tenantId);
      if (error) throw error;

      const { data: sessionData } = await supabase.auth.getSession();
      const { data, error: fnError } = await supabase.functions.invoke("notify-crm-ai-access", {
        body: { barbershop_id: value, enabled: true },
        headers: sessionData.session ? { Authorization: `Bearer ${sessionData.session.access_token}` } : undefined,
      });
      if (fnError || (data as any)?.error) {
        toast.error(`Vinculado aqui, mas o CRM não foi avisado: ${(data as any)?.error || fnError?.message}`);
      } else {
        toast.success("Vinculado! O cliente já pode acessar a IA direto do CRM.");
      }
      setInput("");
      await qc.invalidateQueries({ queryKey: ["tenant-crm-barbershop-link", tenantId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao vincular");
    } finally {
      setSaving(false);
    }
  }

  async function handleUnlink() {
    setSaving(true);
    try {
      const { error } = await supabase.from("tenants" as any).update({ crm_barbershop_id: null }).eq("id", tenantId);
      if (error) throw error;

      if (linked) {
        const { data: sessionData } = await supabase.auth.getSession();
        await supabase.functions.invoke("notify-crm-ai-access", {
          body: { barbershop_id: linked, enabled: false },
          headers: sessionData.session ? { Authorization: `Bearer ${sessionData.session.access_token}` } : undefined,
        });
      }
      toast.success("Vínculo removido.");
      await qc.invalidateQueries({ queryKey: ["tenant-crm-barbershop-link", tenantId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao desvincular");
    } finally {
      setSaving(false);
    }
  }

  if (isLoading) return null;

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Link2 className="h-4 w-4 text-muted-foreground" />
        <p className="text-sm font-medium">Acesso direto pelo CRM Zaylo (sem login)</p>
      </div>
      <p className="text-xs text-muted-foreground">
        Vincula esse tenant à barbearia correspondente no CRM Zaylo — depois disso, o cliente clica em "Acessar minha
        IA" lá dentro e cai direto aqui, já logado.
      </p>

      {linked ? (
        <div className="flex items-center justify-between rounded-md bg-emerald-50 px-3 py-2">
          <div className="flex items-center gap-2 text-sm text-emerald-700">
            <CheckCircle2 className="h-4 w-4" />
            Vinculado (barbershop_id: <code className="text-xs">{linked}</code>)
          </div>
          <Button variant="ghost" size="sm" onClick={handleUnlink} disabled={saving}>
            <Unlink className="mr-1 h-3.5 w-3.5" /> Desvincular
          </Button>
        </div>
      ) : (
        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1">
            <Label className="text-xs">ID da barbearia (UUID) no CRM Zaylo</Label>
            <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="ex: 3d9dc380-9341-4d4d-8874-e32e2643ae36" />
          </div>
          <Button onClick={handleLink} disabled={saving || !input.trim()}>
            {saving ? "Vinculando..." : "Vincular"}
          </Button>
        </div>
      )}
    </div>
  );
}
