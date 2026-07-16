import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { UserPlus, Trash2, ShieldAlert, Users, Copy, Check } from "lucide-react";
import { toast } from "sonner";

type StaffUser = { user_id: string; email: string | null; created_at: string };
type TenantRow = { id: string; name: string; visibility: string; created_by: string | null };

async function invoke(action: string, body: Record<string, unknown> = {}) {
  const { data, error } = await supabase.functions.invoke("admin-manage-staff", { body: { action, ...body } });
  if (error) throw error;
  if ((data as any)?.error) throw new Error((data as any).error);
  return data as any;
}

export default function StaffPage() {
  const [selectedUser, setSelectedUser] = useState<StaffUser | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [invitePassword, setInvitePassword] = useState("");
  const [creating, setCreating] = useState(false);
  const [credentials, setCredentials] = useState<{ email: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [deleteUser, setDeleteUser] = useState<StaffUser | null>(null);
  const [deleting, setDeleting] = useState(false);

  const { data: staffList, refetch: refetchStaff } = useQuery({
    queryKey: ["staff-users"],
    queryFn: async () => (await invoke("list_staff")).users as StaffUser[],
  });

  const { data: tenants } = useQuery({
    queryKey: ["all-tenants-for-staff"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants")
        .select("id,name,visibility,created_by")
        .order("name");
      if (error) throw error;
      return data as TenantRow[];
    },
  });

  const { data: grants, refetch: refetchGrants } = useQuery({
    queryKey: ["staff-grants", selectedUser?.user_id],
    enabled: !!selectedUser,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("staff_tenant_access")
        .select("tenant_id")
        .eq("user_id", selectedUser!.user_id);
      if (error) throw error;
      return new Set((data ?? []).map((r) => r.tenant_id));
    },
  });

  const handleInvite = async () => {
    if (!inviteEmail) return toast.error("Informe um email");
    if (invitePassword && invitePassword.length < 6) return toast.error("Senha deve ter pelo menos 6 caracteres");
    setCreating(true);
    try {
      const res = await invoke("invite", { email: inviteEmail, password: invitePassword || undefined });
      setCredentials({ email: res.email, password: res.password });
      setShowInvite(false);
      setInviteEmail(""); setInvitePassword("");
      refetchStaff();
    } catch (e: any) { toast.error(e.message ?? String(e)); }
    finally { setCreating(false); }
  };

  const handleDelete = async () => {
    if (!deleteUser) return;
    setDeleting(true);
    try {
      await invoke("delete", { user_id: deleteUser.user_id });
      toast.success("Colaborador removido");
      if (selectedUser?.user_id === deleteUser.user_id) setSelectedUser(null);
      setDeleteUser(null);
      refetchStaff();
    } catch (e: any) { toast.error(e.message ?? String(e)); }
    finally { setDeleting(false); }
  };

  const toggleAccess = async (tenantId: string, hasAccess: boolean) => {
    if (!selectedUser) return;
    try {
      if (hasAccess) {
        await supabase.from("staff_tenant_access").delete()
          .eq("user_id", selectedUser.user_id).eq("tenant_id", tenantId);
      } else {
        await supabase.from("staff_tenant_access").insert({
          user_id: selectedUser.user_id, tenant_id: tenantId,
        });
      }
      refetchGrants();
    } catch (e: any) { toast.error(e.message ?? String(e)); }
  };

  const setVisibility = async (tenantId: string, visibility: "restricted" | "general") => {
    const { error } = await supabase.from("tenants").update({ visibility }).eq("id", tenantId);
    if (error) return toast.error(error.message);
    toast.success(`Empresa marcada como ${visibility === "general" ? "geral" : "restrita"}`);
    // refetch happens via query cache but simplest: reload
    window.location.reload();
  };

  // Orphaned: restricted tenants whose created_by is null, or whose creator is not admin/staff anymore
  const staffIds = new Set((staffList ?? []).map((s) => s.user_id));
  const orphans = (tenants ?? []).filter(
    (t) => t.visibility === "restricted" && (!t.created_by || !staffIds.has(t.created_by))
  );

  const copyCreds = () => {
    if (!credentials) return;
    navigator.clipboard.writeText(`Email: ${credentials.email}\nSenha: ${credentials.password}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Colaboradores</h2>
          <p className="text-muted-foreground mt-1">Convide sua equipe e libere acesso por empresa</p>
        </div>
        <Button onClick={() => setShowInvite(true)}>
          <UserPlus className="w-4 h-4 mr-2" />Convidar colaborador
        </Button>
      </div>

      {orphans.length > 0 && (
        <div className="glass-card p-6 border-warning/40 bg-warning/5">
          <div className="flex items-start gap-3">
            <ShieldAlert className="w-5 h-5 text-warning shrink-0 mt-0.5" />
            <div className="flex-1 space-y-2">
              <h3 className="font-semibold text-foreground">Empresas restritas sem responsável ativo ({orphans.length})</h3>
              <p className="text-sm text-muted-foreground">
                Estas empresas são restritas mas quem as cadastrou não é mais colaborador. Só você (admin) enxerga elas.
                Libere para um colaborador ou marque como geral.
              </p>
              <ul className="mt-2 space-y-1 text-sm">
                {orphans.slice(0, 20).map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-2 p-2 rounded bg-background/40">
                    <span className="font-medium text-foreground">{t.name}</span>
                    <span className="text-xs text-muted-foreground">criador removido / ausente</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-6">
        <div className="glass-card p-6 space-y-4">
          <h3 className="font-semibold text-foreground flex items-center gap-2">
            <Users className="w-4 h-4" /> Equipe ({staffList?.length ?? 0})
          </h3>
          {staffList && staffList.length > 0 ? (
            <ul className="space-y-2">
              {staffList.map((u) => (
                <li key={u.user_id}
                  className={`flex items-center justify-between gap-2 rounded p-3 cursor-pointer transition ${selectedUser?.user_id === u.user_id ? "bg-primary/10 border border-primary/30" : "bg-muted/30 hover:bg-muted/50"}`}
                  onClick={() => setSelectedUser(u)}>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground truncate">{u.email ?? "(sem email)"}</div>
                    <div className="text-xs text-muted-foreground">desde {new Date(u.created_at).toLocaleDateString()}</div>
                  </div>
                  <Button variant="ghost" size="icon" className="hover:text-destructive"
                    onClick={(e) => { e.stopPropagation(); setDeleteUser(u); }}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Nenhum colaborador ainda.</p>
          )}
        </div>

        <div className="glass-card p-6 space-y-4">
          <h3 className="font-semibold text-foreground">
            {selectedUser ? `Acessos de ${selectedUser.email}` : "Selecione um colaborador"}
          </h3>
          {selectedUser && (
            <>
              <p className="text-xs text-muted-foreground">
                Empresas <strong>gerais</strong> são vistas por toda a equipe. Empresas <strong>restritas</strong> só aparecem para quem foi liberado abaixo.
              </p>
              <ul className="space-y-1 max-h-[500px] overflow-y-auto">
                {(tenants ?? []).map((t) => {
                  const isGeneral = t.visibility === "general";
                  const hasAccess = grants?.has(t.id) ?? false;
                  return (
                    <li key={t.id} className="flex items-center justify-between gap-2 p-2 rounded hover:bg-muted/30">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-foreground truncate">{t.name}</div>
                        <button
                          className="text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
                          onClick={() => setVisibility(t.id, isGeneral ? "restricted" : "general")}
                          title="Alternar visibilidade"
                        >
                          {isGeneral ? "geral — clique p/ restringir" : "restrita — clique p/ tornar geral"}
                        </button>
                      </div>
                      <Checkbox
                        checked={isGeneral || hasAccess}
                        disabled={isGeneral}
                        onCheckedChange={() => toggleAccess(t.id, hasAccess)}
                      />
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      </div>

      <Dialog open={showInvite} onOpenChange={setShowInvite}>
        <DialogContent>
          <DialogHeader><DialogTitle>Convidar colaborador</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Label>Email</Label>
            <Input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="colaborador@equipe.com" />
            <Label>Senha (opcional)</Label>
            <Input type="text" value={invitePassword} onChange={(e) => setInvitePassword(e.target.value)} placeholder="Deixe em branco para gerar" />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowInvite(false)}>Cancelar</Button>
            <Button onClick={handleInvite} disabled={creating}>{creating ? "Criando..." : "Criar acesso"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!credentials} onOpenChange={() => setCredentials(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Colaborador criado</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Compartilhe estas credenciais. Esta é a única vez que a senha aparece.</p>
            <div className="bg-muted rounded-lg p-3 font-mono text-sm space-y-1">
              <div><strong>Email:</strong> {credentials?.email}</div>
              <div><strong>Senha:</strong> {credentials?.password}</div>
            </div>
            <Button variant="outline" onClick={copyCreds} className="w-full">
              {copied ? <><Check className="w-4 h-4 mr-2" />Copiado</> : <><Copy className="w-4 h-4 mr-2" />Copiar</>}
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setCredentials(null)}>Fechar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteUser} onOpenChange={(o) => !o && setDeleteUser(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover colaborador?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{deleteUser?.email}</strong> perderá acesso ao painel imediatamente. As empresas restritas que ele criou continuarão existindo, mas ficarão sem responsável (você verá na lista de "sem responsável ativo" acima).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {deleting ? "Removendo..." : "Remover"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
