import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { History, RotateCcw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export type PromptVersion = {
  id: string;
  version: number;
  prompt: string;
  created_at: string;
  created_by_role?: string | null;
  change_summary?: string | null;
};

export function PromptVersionsDialog({
  tenantId,
  versions,
  currentVersion,
  canRestore,
  actorRole,
  userId,
  onRestored,
}: {
  tenantId: string;
  versions: PromptVersion[];
  currentVersion: number;
  canRestore: boolean;
  actorRole: "admin" | "client";
  userId?: string;
  onRestored?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [viewVersion, setViewVersion] = useState<PromptVersion | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<PromptVersion | null>(null);
  const [restoring, setRestoring] = useState(false);

  const handleRestore = async () => {
    if (!confirmRestore || !tenantId) return;
    setRestoring(true);
    try {
      const nextVersion = (versions[0]?.version ?? 0) + 1;
      const { error: upErr } = await supabase
        .from("tenants")
        .update({ agent_system_prompt: confirmRestore.prompt })
        .eq("id", tenantId);
      if (upErr) throw upErr;

      const { error: vErr } = await supabase.from("ai_prompt_versions").insert({
        tenant_id: tenantId,
        version: nextVersion,
        prompt: confirmRestore.prompt,
        created_by: userId,
        created_by_role: actorRole,
        change_summary: `Restaurado da versão v${confirmRestore.version}`,
      } as any);
      if (vErr) throw vErr;

      await supabase.from("audit_logs").insert({
        tenant_id: tenantId, user_id: userId, actor_role: actorRole,
        action: "restore_ai_prompt", entity: "tenants", entity_id: tenantId,
        after: { restored_from: confirmRestore.version, new_version: nextVersion },
      });

      toast.success(`Versão v${confirmRestore.version} restaurada (nova v${nextVersion})`);
      setConfirmRestore(null);
      setViewVersion(null);
      setOpen(false);
      onRestored?.();
    } catch (e: any) {
      toast.error(e.message ?? "Falha ao restaurar");
    } finally {
      setRestoring(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
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
              {versions.length === 0 && (
                <p className="text-sm text-muted-foreground">Nenhuma versão salva ainda.</p>
              )}
              {versions.map((v) => {
                const isCurrent = v.version === currentVersion;
                const author = v.created_by_role === "admin" ? "ADM" : "Cliente";
                return (
                  <button
                    key={v.id}
                    onClick={() => setViewVersion(v)}
                    className="w-full text-left p-3 rounded-lg border border-border hover:bg-muted transition-colors"
                  >
                    <div className="flex justify-between items-center mb-1 gap-2">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm">v{v.version}</span>
                        {isCurrent && (
                          <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-primary/15 text-primary font-medium">
                            atual
                          </span>
                        )}
                        <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                          {author}
                        </span>
                      </div>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {new Date(v.created_at).toLocaleString("pt-BR")}
                      </span>
                    </div>
                    {v.change_summary ? (
                      <p className="text-xs text-foreground line-clamp-2">{v.change_summary}</p>
                    ) : (
                      <p className="text-xs text-muted-foreground italic line-clamp-2">
                        (sem resumo) — {v.prompt?.slice(0, 120)}
                      </p>
                    )}
                  </button>
                );
              })}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      <Dialog open={!!viewVersion} onOpenChange={(o) => !o && setViewVersion(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              Versão v{viewVersion?.version} —{" "}
              {viewVersion && new Date(viewVersion.created_at).toLocaleString("pt-BR")}
            </DialogTitle>
          </DialogHeader>
          {viewVersion?.change_summary && (
            <div className="text-sm rounded-md border border-border bg-muted/40 p-3">
              <span className="text-muted-foreground text-xs uppercase font-medium">Resumo</span>
              <p className="mt-1">{viewVersion.change_summary}</p>
            </div>
          )}
          <ScrollArea className="h-[55vh]">
            <pre className="text-xs whitespace-pre-wrap font-mono p-3 bg-muted rounded-lg">
              {viewVersion?.prompt}
            </pre>
          </ScrollArea>
          {canRestore && viewVersion && viewVersion.version !== currentVersion && (
            <Button onClick={() => setConfirmRestore(viewVersion)}>
              <RotateCcw className="w-4 h-4 mr-2" />Restaurar esta versão
            </Button>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!confirmRestore} onOpenChange={(o) => !o && setConfirmRestore(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restaurar versão v{confirmRestore?.version}?</AlertDialogTitle>
            <AlertDialogDescription>
              Tem certeza que quer restaurar? A partir de agora, a IA passará a usar as
              instruções desta versão (v{confirmRestore?.version}) e não as do prompt atual.
              Uma nova versão será criada como cópia desta.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restoring}>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleRestore} disabled={restoring}>
              {restoring ? "Restaurando..." : "Sim, restaurar"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
