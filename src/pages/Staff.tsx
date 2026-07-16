import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { UserPlus, Trash2, Users, Copy, Check, Building2, Activity } from "lucide-react";
import { toast } from "sonner";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import TeamActionsPanel from "@/components/TeamActionsPanel";

type StaffUser = { user_id: string; email: string | null; created_at: string };
type TenantRow = { id: string; name: string; visibility: string; created_by: string | null };
type AccessRow = { user_id: string; tenant_id: string };
type ModuleRow = { user_id: string; module: string };

const MODULES: { key: string; label: string }[] = [
  { key: "follow-ups", label: "Follow-ups" },
  { key: "agent-logs", label: "Monitor IA" },
  { key: "prompts", label: "Prompts" },
  { key: "staff", label: "Colaboradores" },
  { key: "audit", label: "Auditoria" },
  { key: "settings", label: "Configurações" },
];

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

  const { data: tenants, refetch: refetchTenants } = useQuery({
    queryKey: ["all-tenants-for-staff"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants").select("id,name,visibility,created_by").order("name");
      if (error) throw error;
      return data as TenantRow[];
    },
  });

  const { data: allAccess, refetch: refetchAllAccess } = useQuery({
    queryKey: ["staff-all-access"],
    queryFn: async () => {
      const { data, error } = await supabase.from("staff_tenant_access").select("user_id,tenant_id");
      if (error) throw error;
      return (data ?? []) as AccessRow[];
    },
  });

  const { data: allModules, refetch: refetchAllModules } = useQuery({
    queryKey: ["staff-all-modules"],
    queryFn: async () => {
      const { data, error } = await supabase.from("staff_module_access").select("user_id,module");
      if (error) throw error;
      return (data ?? []) as ModuleRow[];
    },
  });

  const grants = useMemo(() => {
    const s = new Set<string>();
    if (selectedUser && allAccess) for (const r of allAccess) if (r.user_id === selectedUser.user_id) s.add(r.tenant_id);
    return s;
  }, [selectedUser, allAccess]);

  const userModules = useMemo(() => {
    const s = new Set<string>();
    if (selectedUser && allModules) for (const r of allModules) if (r.user_id === selectedUser.user_id) s.add(r.module);
    return s;
  }, [selectedUser, allModules]);

  const emailById = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of staffList ?? []) if (u.email) m.set(u.user_id, u.email);
    return m;
  }, [staffList]);

  const accessByTenant = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const r of allAccess ?? []) {
      const arr = m.get(r.tenant_id) ?? [];
      arr.push(r.user_id);
      m.set(r.tenant_id, arr);
    }
    return m;
  }, [allAccess]);

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
      refetchStaff(); refetchAllAccess(); refetchAllModules();
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
      refetchAllAccess();
    } catch (e: any) { toast.error(e.message ?? String(e)); }
  };

  const toggleModule = async (moduleKey: string, has: boolean) => {
    if (!selectedUser) return;
    try {
      if (has) {
        await supabase.from("staff_module_access").delete()
          .eq("user_id", selectedUser.user_id).eq("module", moduleKey);
      } else {
        await supabase.from("staff_module_access").insert({
          user_id: selectedUser.user_id, module: moduleKey,
        });
      }
      refetchAllModules();
    } catch (e: any) { toast.error(e.message ?? String(e)); }
  };

  const setVisibility = async (tenantId: string, visibility: "restricted" | "general") => {
    const { error } = await supabase.from("tenants").update({ visibility }).eq("id", tenantId);
    if (error) return toast.error(error.message);
    toast.success(`Empresa marcada como ${visibility === "general" ? "geral" : "restrita"}`);
    refetchTenants();
  };

  const copyCreds = () => {

      {/* Raio-x de responsabilidades */}
      <div className="glass-card p-6 space-y-4">
        <h3 className="font-semibold text-foreground flex items-center gap-2">
          <Building2 className="w-4 h-4" /> Empresas × responsáveis
        </h3>
        <p className="text-xs text-muted-foreground">Visão geral: quem vê o quê hoje. "Geral" = todos os colaboradores enxergam.</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-muted-foreground border-b border-border">
              <tr>
                <th className="text-left py-2 pr-4">Empresa</th>
                <th className="text-left py-2 pr-4">Visibilidade</th>
                <th className="text-left py-2">Quem tem acesso</th>
              </tr>
            </thead>
            <tbody>
              {(tenants ?? []).map((t) => {
                const isGeneral = t.visibility === "general";
                const grantees = accessByTenant.get(t.id) ?? [];
                return (
                  <tr key={t.id} className="border-b border-border/40">
                    <td className="py-2 pr-4 font-medium text-foreground">{t.name}</td>
                    <td className="py-2 pr-4">
                      <button onClick={() => setVisibility(t.id, isGeneral ? "restricted" : "general")}>
                        <Badge variant={isGeneral ? "default" : "secondary"} className="cursor-pointer">
                          {isGeneral ? "Geral" : "Restrita"}
                        </Badge>
                      </button>
                    </td>
                    <td className="py-2 text-muted-foreground">
                      {isGeneral
                        ? <span className="text-xs">Toda a equipe</span>
                        : grantees.length === 0
                          ? <span className="text-xs italic">Ninguém (só admin)</span>
                          : <span className="text-xs">{grantees.map((id) => emailById.get(id) ?? id.slice(0, 8)).join(", ")}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

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

        <div className="glass-card p-6 space-y-6">
          <h3 className="font-semibold text-foreground">
            {selectedUser ? `Permissões de ${selectedUser.email}` : "Selecione um colaborador"}
          </h3>
          {selectedUser && (
            <>
              <div>
                <h4 className="text-sm font-semibold text-foreground mb-2">Abas do painel</h4>
                <p className="text-xs text-muted-foreground mb-3">"Visão Geral" e "Empresas" ficam sempre visíveis. Marque abaixo o que este colaborador enxerga.</p>
                <div className="grid grid-cols-2 gap-2">
                  {MODULES.map((m) => {
                    const has = userModules.has(m.key);
                    return (
                      <label key={m.key} className="flex items-center gap-2 p-2 rounded hover:bg-muted/30 cursor-pointer">
                        <Checkbox checked={has} onCheckedChange={() => toggleModule(m.key, has)} />
                        <span className="text-sm">{m.label}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div>
                <h4 className="text-sm font-semibold text-foreground mb-2">Empresas</h4>
                <p className="text-xs text-muted-foreground mb-3">
                  Empresas <strong>gerais</strong> são vistas por toda a equipe. Empresas <strong>restritas</strong> só aparecem para quem for liberado abaixo.
                </p>
                <ul className="space-y-1 max-h-[400px] overflow-y-auto">
                  {(tenants ?? []).map((t) => {
                    const isGeneral = t.visibility === "general";
                    const hasAccess = grants.has(t.id);
                    return (
                      <li key={t.id} className="flex items-center justify-between gap-2 p-2 rounded hover:bg-muted/30">
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-foreground truncate">{t.name}</div>
                          <button
                            className="text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
                            onClick={() => setVisibility(t.id, isGeneral ? "restricted" : "general")}
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
              </div>
            </>
          )}
        </div>
      </div>

      <Dialog open={showInvite} onOpenChange={setShowInvite}>
        <DialogContent>
          <DialogHeader><DialogTitle>Adicionar colaborador</DialogTitle></DialogHeader>
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
