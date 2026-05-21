import { useAuth, useModulePermission } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { Save, History, Wrench } from "lucide-react";
import { CustomToolsTab, type CustomTool } from "@/components/CustomToolsTab";

export default function ClientAi() {
  const { tenantId, user } = useAuth();
  const ai = useModulePermission("ai_prompt");
  const integ = useModulePermission("integrations");
  const company = useModulePermission("company_data");
  const toolsPerm = useModulePermission("tools");

  const { data: tenant, refetch } = useQuery({
    queryKey: ["client-ai-tenant", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data } = await supabase.from("tenants").select("*").eq("id", tenantId!).single();
      return data;
    },
  });

  const { data: versions, refetch: refetchVersions } = useQuery({
    queryKey: ["ai-prompt-versions", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data } = await supabase
        .from("ai_prompt_versions")
        .select("id,version,prompt,created_at,created_by_role")
        .eq("tenant_id", tenantId!)
        .order("version", { ascending: false });
      return data ?? [];
    },
  });

  const [form, setForm] = useState<any>({});
  const [customTools, setCustomTools] = useState<CustomTool[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [viewVersion, setViewVersion] = useState<any>(null);
  useEffect(() => {
    if (tenant) {
      setForm(tenant);
      const s = (tenant as any).agent_settings;
      if (s && typeof s === "object" && Array.isArray(s.custom_tools)) {
        setCustomTools(s.custom_tools);
      } else {
        setCustomTools([]);
      }
    }
  }, [tenant]);

  // Realtime: refresh when tenant row changes (admin edits propagate live)
  useEffect(() => {
    if (!tenantId) return;
    const channel = supabase
      .channel(`tenant-${tenantId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "tenants", filter: `id=eq.${tenantId}` },
        () => { refetch(); },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [tenantId, refetch]);


  const saveTools = async (next: CustomTool[]) => {
    setCustomTools(next);
    if (!tenantId) return;
    const currentSettings = (tenant as any)?.agent_settings ?? {};
    const agentSettings = { ...currentSettings, custom_tools: next };
    const { error } = await supabase.from("tenants").update({ agent_settings: agentSettings } as any).eq("id", tenantId);
    if (error) return toast.error(error.message);
    await supabase.from("audit_logs").insert({
      tenant_id: tenantId, user_id: user?.id, actor_role: "client",
      action: "edit_custom_tools", entity: "tenants", entity_id: tenantId,
      after: { custom_tools: next } as any,
    } as any);
    refetch();
  };

  const save = async (fields: Record<string, any>, action: string) => {
    if (!tenantId) return;
    const { error } = await supabase.from("tenants").update(fields as any).eq("id", tenantId);
    if (error) return toast.error(error.message);
    await supabase.from("audit_logs").insert({
      tenant_id: tenantId, user_id: user?.id, actor_role: "client",
      action, entity: "tenants", entity_id: tenantId, after: fields,
    });
    toast.success("Salvo");
    refetch();
  };

  const handleSavePrompt = async () => {
    if (!tenantId) return;
    const prompt = form.agent_system_prompt ?? "";
    const nextVersion = (versions?.[0]?.version ?? 0) + 1;

    const { error: upErr } = await supabase
      .from("tenants")
      .update({ agent_system_prompt: prompt })
      .eq("id", tenantId);
    if (upErr) return toast.error(upErr.message);

    const { error: vErr } = await supabase.from("ai_prompt_versions").insert({
      tenant_id: tenantId,
      version: nextVersion,
      prompt,
      created_by: user?.id,
      created_by_role: "client",
    });
    if (vErr) toast.error("Salvo, mas não foi possível registrar a versão: " + vErr.message);

    await supabase.from("audit_logs").insert({
      tenant_id: tenantId, user_id: user?.id, actor_role: "client",
      action: "edit_ai_prompt", entity: "tenants", entity_id: tenantId,
      after: { agent_system_prompt: prompt, version: nextVersion },
    });

    toast.success(`Prompt salvo — versão ${nextVersion}`);
    setConfirmOpen(false);
    refetch();
    refetchVersions();
  };

  if (!tenant) return <p className="text-muted-foreground">Carregando...</p>;

  const tabs = [
    { v: "ai", label: "IA", show: ai.visible },
    { v: "tools", label: "Ferramentas", show: toolsPerm.visible },
    { v: "company", label: "Sua empresa", show: company.visible },
    { v: "integ", label: "Integrações", show: integ.visible },
  ].filter((t) => t.show);

  const currentVersion = versions?.[0]?.version ?? 0;

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

        {ai.visible && (
          <TabsContent value="ai" className="space-y-4">
            <div className="glass-card p-5 flex flex-col gap-3" style={{ minHeight: "calc(100vh - 240px)" }}>
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <Label>Personalidade e instruções da IA</Label>
                <div className="flex items-center gap-2">
                  {currentVersion > 0 && (
                    <span className="text-xs px-2 py-1 rounded-md bg-muted text-muted-foreground">
                      Versão atual: v{currentVersion}
                    </span>
                  )}
                  <Dialog>
                    <DialogTrigger asChild>
                      <Button variant="outline" size="sm">
                        <History className="w-4 h-4 mr-2" />Versões
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="max-w-2xl">
                      <DialogHeader>
                        <DialogTitle>Histórico de versões do prompt</DialogTitle>
                      </DialogHeader>
                      <ScrollArea className="h-[60vh] pr-3">
                        <div className="space-y-2">
                          {(versions ?? []).length === 0 && (
                            <p className="text-sm text-muted-foreground">Nenhuma versão salva ainda.</p>
                          )}
                          {(versions ?? []).map((v: any) => (
                            <button
                              key={v.id}
                              onClick={() => setViewVersion(v)}
                              className="w-full text-left p-3 rounded-lg border border-border hover:bg-muted transition-colors"
                            >
                              <div className="flex justify-between items-center mb-1">
                                <span className="font-semibold text-sm">v{v.version}</span>
                                <span className="text-xs text-muted-foreground">
                                  {new Date(v.created_at).toLocaleString("pt-BR")}
                                </span>
                              </div>
                              <p className="text-xs text-muted-foreground line-clamp-2">{v.prompt}</p>
                            </button>
                          ))}
                        </div>
                      </ScrollArea>
                    </DialogContent>
                  </Dialog>
                </div>
              </div>

              <Textarea
                disabled={!ai.editable}
                className="flex-1 min-h-[500px] resize-none font-mono text-sm"
                value={form.agent_system_prompt ?? ""}
                onChange={(e) => setForm({ ...form, agent_system_prompt: e.target.value })}
              />
              {ai.editable && (
                <Button className="w-fit" onClick={() => setConfirmOpen(true)}>
                  <Save className="w-4 h-4 mr-2" />Salvar
                </Button>
              )}
            </div>
          </TabsContent>
        )}

        {toolsPerm.visible && (
          <TabsContent value="tools" className="space-y-4">
            <CustomToolsTab
              tools={customTools}
              onChange={toolsPerm.editable ? saveTools : () => {}}
              tenantId={tenantId ?? undefined}
              readOnly={!toolsPerm.editable}
            />
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

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmar salvamento do prompt</AlertDialogTitle>
            <AlertDialogDescription>
              Tem certeza que deseja salvar este prompt? Uma nova versão (v{currentVersion + 1}) será
              criada e a IA passará a responder com essas instruções imediatamente. Você poderá consultar
              versões anteriores em "Versões", mas a versão ativa será essa nova.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleSavePrompt}>Confirmar e salvar v{currentVersion + 1}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!viewVersion} onOpenChange={(o) => !o && setViewVersion(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              Versão v{viewVersion?.version} —{" "}
              {viewVersion && new Date(viewVersion.created_at).toLocaleString("pt-BR")}
            </DialogTitle>
          </DialogHeader>
          <ScrollArea className="h-[60vh]">
            <pre className="text-xs whitespace-pre-wrap font-mono p-3 bg-muted rounded-lg">
              {viewVersion?.prompt}
            </pre>
          </ScrollArea>
          {ai.editable && viewVersion && viewVersion.version !== currentVersion && (
            <Button
              onClick={() => {
                setForm({ ...form, agent_system_prompt: viewVersion.prompt });
                setViewVersion(null);
                toast.info("Conteúdo carregado no editor. Clique em Salvar para criar uma nova versão.");
              }}
            >
              Carregar esta versão no editor
            </Button>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
