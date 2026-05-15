import { useAuth, useModulePermission } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Save } from "lucide-react";

export default function ClientAi() {
  const { tenantId, user } = useAuth();
  const ai = useModulePermission("ai_prompt");
  const kb = useModulePermission("ai_knowledge");
  const integ = useModulePermission("integrations");
  const company = useModulePermission("company_data");

  const { data: tenant, refetch } = useQuery({
    queryKey: ["client-ai-tenant", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data } = await supabase.from("tenants").select("*").eq("id", tenantId!).single();
      return data;
    },
  });

  const [form, setForm] = useState<any>({});
  useEffect(() => { if (tenant) setForm(tenant); }, [tenant]);

  const save = async (fields: Record<string, any>, action: string) => {
    if (!tenantId) return;
    const { error } = await supabase.from("tenants").update(fields).eq("id", tenantId);
    if (error) return toast.error(error.message);
    await supabase.from("audit_logs").insert({
      tenant_id: tenantId, user_id: user?.id, actor_role: "client",
      action, entity: "tenants", entity_id: tenantId, after: fields,
    });
    toast.success("Salvo");
    refetch();
  };

  if (!tenant) return <p className="text-muted-foreground">Carregando...</p>;

  const tabs = [
    { v: "ai", label: "IA", show: ai.visible || kb.visible },
    { v: "company", label: "Sua empresa", show: company.visible },
    { v: "integ", label: "Integrações", show: integ.visible },
  ].filter((t) => t.show);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Sua IA</h1>
        <p className="text-muted-foreground">Configure o atendente virtual e os dados da sua empresa</p>
      </div>

      <Tabs defaultValue={tabs[0]?.v ?? "ai"}>
        <TabsList>
          {tabs.map((t) => <TabsTrigger key={t.v} value={t.v}>{t.label}</TabsTrigger>)}
        </TabsList>

        {(ai.visible || kb.visible) && (
          <TabsContent value="ai" className="space-y-4">
            {ai.visible && (
              <div className="glass-card p-5 space-y-3">
                <Label>Personalidade e instruções da IA</Label>
                <Textarea rows={10} disabled={!ai.editable}
                  value={form.agent_system_prompt ?? ""}
                  onChange={(e) => setForm({ ...form, agent_system_prompt: e.target.value })} />
                {ai.editable && (
                  <Button onClick={() => save({ agent_system_prompt: form.agent_system_prompt }, "edit_ai_prompt")}>
                    <Save className="w-4 h-4 mr-2" />Salvar
                  </Button>
                )}
              </div>
            )}
            {kb.visible && (
              <div className="glass-card p-5 space-y-3">
                <Label>Base de conhecimento (informações que a IA usa para responder)</Label>
                <Textarea rows={10} disabled={!kb.editable}
                  value={form.agent_knowledge_base ?? ""}
                  onChange={(e) => setForm({ ...form, agent_knowledge_base: e.target.value })} />
                {kb.editable && (
                  <Button onClick={() => save({ agent_knowledge_base: form.agent_knowledge_base }, "edit_ai_knowledge")}>
                    <Save className="w-4 h-4 mr-2" />Salvar
                  </Button>
                )}
              </div>
            )}
          </TabsContent>
        )}

        {company.visible && (
          <TabsContent value="company" className="space-y-4">
            <div className="glass-card p-5 grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Nome</Label>
                <Input disabled={!company.editable} value={form.name ?? ""}
                  onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>Telefone</Label>
                <Input disabled={!company.editable} value={form.phone ?? ""}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label>Endereço</Label>
                <Input disabled={!company.editable} value={form.address ?? ""}
                  onChange={(e) => setForm({ ...form, address: e.target.value })} />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label>Link de agendamento</Label>
                <Input disabled={!company.editable} value={form.booking_link ?? ""}
                  onChange={(e) => setForm({ ...form, booking_link: e.target.value })} />
              </div>
              {company.editable && (
                <Button className="md:col-span-2 w-fit"
                  onClick={() => save({ name: form.name, phone: form.phone, address: form.address, booking_link: form.booking_link }, "edit_company_data")}>
                  <Save className="w-4 h-4 mr-2" />Salvar
                </Button>
              )}
            </div>
          </TabsContent>
        )}

        {integ.visible && (
          <TabsContent value="integ" className="space-y-4">
            <div className="glass-card p-5 space-y-3">
              <p className="text-sm text-muted-foreground">
                Tokens e credenciais das integrações. {!integ.editable && "Somente leitura — peça ao administrador para alterar."}
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2"><Label>WhatsApp (UAZAPI URL)</Label>
                  <Input disabled={!integ.editable} value={form.uazapi_url ?? ""}
                    onChange={(e) => setForm({ ...form, uazapi_url: e.target.value })} /></div>
                <div className="space-y-2"><Label>WhatsApp (token)</Label>
                  <Input type="password" disabled={!integ.editable} value={form.uazapi_token ?? ""}
                    onChange={(e) => setForm({ ...form, uazapi_token: e.target.value })} /></div>
              </div>
              {integ.editable && (
                <Button onClick={() => save({ uazapi_url: form.uazapi_url, uazapi_token: form.uazapi_token }, "edit_integrations")}>
                  <Save className="w-4 h-4 mr-2" />Salvar
                </Button>
              )}
            </div>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
