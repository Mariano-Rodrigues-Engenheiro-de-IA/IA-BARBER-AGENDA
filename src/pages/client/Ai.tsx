import { useAuth, useModulePermission } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { Navigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { Save } from "lucide-react";
import { PromptVersionsDialog, type PromptVersion } from "@/components/PromptVersionsDialog";

/** Aba "Prompt" — dedicada só ao comportamento/instruções da IA.
 * Ferramentas, base de conhecimento, integrações e dados da empresa
 * viraram abas próprias da navegação. */
export default function ClientAi() {
  const { tenantId, user } = useAuth();
  const ai = useModulePermission("ai_prompt");

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
        .select("id,version,prompt,created_at,created_by_role,change_summary")
        .eq("tenant_id", tenantId!)
        .order("version", { ascending: false });
      return (data ?? []) as PromptVersion[];
    },
  });

  const [form, setForm] = useState<any>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [changeSummary, setChangeSummary] = useState("");

  useEffect(() => {
    if (tenant) setForm(tenant);
  }, [tenant]);

  // Realtime: refresh tenant + versions (admin/cliente edits propagate live)
  useEffect(() => {
    if (!tenantId) return;
    const channel = supabase
      .channel(`tenant-${tenantId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "tenants", filter: `id=eq.${tenantId}` },
        () => { refetch(); },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "ai_prompt_versions", filter: `tenant_id=eq.${tenantId}` },
        () => { refetchVersions(); },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [tenantId, refetch, refetchVersions]);

  const handleSavePrompt = async () => {
    if (!tenantId) return;
    if (changeSummary.trim().length < 150) {
      toast.error("O resumo precisa ter no mínimo 150 caracteres");
      return;
    }
    const prompt = form.agent_system_prompt ?? "";
    const nextVersion = (versions?.[0]?.version ?? 0) + 1;
    const summary = changeSummary.trim();

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
      change_summary: summary,
    } as any);
    if (vErr) toast.error("Salvo, mas não foi possível registrar a versão: " + vErr.message);

    await supabase.from("audit_logs").insert({
      tenant_id: tenantId, user_id: user?.id, actor_role: "client",
      action: "edit_ai_prompt", entity: "tenants", entity_id: tenantId,
      after: { agent_system_prompt: prompt, version: nextVersion, change_summary: summary },
    });

    toast.success(`Prompt salvo — versão ${nextVersion}`);
    setConfirmOpen(false);
    setChangeSummary("");
    refetch();
    refetchVersions();
  };

  if (!ai.visible) return <Navigate to="/app" replace />;
  if (!tenant) return <p className="text-muted-foreground">Carregando...</p>;

  const currentVersion = versions?.[0]?.version ?? 0;

  return (
    <div className="space-y-6">
      <div className="glass-card p-5 flex flex-col gap-3" style={{ minHeight: "calc(100vh - 260px)" }}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <Label>Personalidade e instruções da IA</Label>
          <div className="flex items-center gap-2">
            {currentVersion > 0 && (
              <span className="text-xs px-2 py-1 rounded-md bg-muted text-muted-foreground">
                Versão atual: v{currentVersion}
              </span>
            )}
            <PromptVersionsDialog
              tenantId={tenantId!}
              versions={versions ?? []}
              currentVersion={currentVersion}
              canRestore={ai.editable}
              actorRole="client"
              userId={user?.id}
              onRestored={() => { refetch(); refetchVersions(); }}
            />
          </div>
        </div>

        <Textarea
          disabled={!ai.editable}
          className="ia-prompt-textarea flex-1 min-h-[500px] resize-none font-mono text-sm disabled:opacity-100 disabled:text-foreground/70"
          value={form.agent_system_prompt ?? ""}
          onChange={(e) => setForm({ ...form, agent_system_prompt: e.target.value })}
        />
        {ai.editable && (
          <Button className="w-fit" onClick={() => setConfirmOpen(true)}>
            <Save className="w-4 h-4 mr-2" />Salvar
          </Button>
        )}
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={(o) => { setConfirmOpen(o); if (!o) setChangeSummary(""); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Salvar nova versão do prompt</AlertDialogTitle>
            <AlertDialogDescription>
              Uma nova versão (v{currentVersion + 1}) será criada e a IA passará a responder
              com essas instruções imediatamente. Descreva o que mudou nesta versão
              (mínimo de 150 caracteres) — esse resumo aparece em "Ações da equipe".
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="change-summary">Resumo das alterações (obrigatório)</Label>
            <Textarea
              id="change-summary"
              placeholder="Descreva de forma clara o que mudou, por quê, e o efeito esperado no atendimento (mínimo 150 caracteres)."
              value={changeSummary}
              onChange={(e) => setChangeSummary(e.target.value)}
              rows={5}
            />
            <p className={`text-xs ${changeSummary.trim().length < 150 ? "text-destructive" : "text-muted-foreground"}`}>
              {changeSummary.trim().length}/150 caracteres mínimos
            </p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <Button disabled={changeSummary.trim().length < 150} onClick={handleSavePrompt}>
              Confirmar e salvar v{currentVersion + 1}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
