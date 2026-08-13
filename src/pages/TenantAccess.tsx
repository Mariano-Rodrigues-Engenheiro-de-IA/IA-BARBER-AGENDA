import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Plus, Copy, Check, Trash2, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { AppModule, ModuleVisibility } from "@/hooks/useAuth";

// Mesma ordem da navegação do painel do cliente.
const MODULES: { key: AppModule; label: string }[] = [
  { key: "overview", label: "Visão Geral" },
  { key: "conversations", label: "Conversas" },
  { key: "ai_prompt", label: "Prompt" },
  { key: "tools", label: "Ferramentas da IA" },
  { key: "ai_knowledge", label: "Base de conhecimento" },
  { key: "integrations", label: "Integrações" },
  { key: "company_data", label: "Dados da empresa" },
  { key: "simulator", label: "Simulador" },
  { key: "connection", label: "Conexão WhatsApp" },
];

const VISIBILITIES: { v: ModuleVisibility; label: string; color: string }[] = [
  { v: "hidden", label: "Oculto", color: "bg-destructive/10 text-destructive" },
  { v: "read_only", label: "Somente leitura", color: "bg-yellow-500/10 text-yellow-600" },
  { v: "editable", label: "Editável", color: "bg-emerald-500/10 text-emerald-600" },
];

type TenantUserRow = { user_id: string; created_at: string; email: string | null };

export default function TenantAccessPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);
  const [email, setEmail] = useState("");
  const [createPassword, setCreatePassword] = useState("");
  const [creating, setCreating] = useState(false);
  const [credentials, setCredentials] = useState<{ email: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [pwUser, setPwUser] = useState<TenantUserRow | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [savingPw, setSavingPw] = useState(false);
  const [deleteUser, setDeleteUser] = useState<TenantUserRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const { data: tenant } = useQuery({
    queryKey: ["tenant-access", id],
    enabled: !!id,
    queryFn: async () => (await supabase.from("tenants").select("name").eq("id", id!).single()).data,
  });

  const { data: users, refetch: refetchUsers } = useQuery({
    queryKey: ["tenant-users", id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("admin-manage-client-user", {
        body: { action: "list", tenant_id: id },
      });
      if (error) throw error;
      return ((data as any)?.users ?? []) as TenantUserRow[];
    },
  });

  const { data: perms, refetch: refetchPerms } = useQuery({
    queryKey: ["tenant-perms", id],
    enabled: !!id,
    queryFn: async () => (await supabase.from("tenant_permissions").select("module,visibility").eq("tenant_id", id!)).data ?? [],
  });

  const getVis = (m: AppModule): ModuleVisibility =>
    (perms?.find((p: any) => p.module === m)?.visibility as ModuleVisibility) ?? "editable";

  const setVis = async (m: AppModule, v: ModuleVisibility) => {
    const { error } = await supabase.from("tenant_permissions")
      .upsert({ tenant_id: id!, module: m, visibility: v }, { onConflict: "tenant_id,module" });
    if (error) return toast.error(error.message);
    refetchPerms();
  };

  const handleCreate = async () => {
    if (!email) return toast.error("Informe um email");
    if (createPassword && createPassword.length < 6) return toast.error("Senha deve ter pelo menos 6 caracteres");
    setCreating(true);
    try {
      const { data, error } = await supabase.functions.invoke("admin-create-client-user", {
        body: { tenant_id: id, email, password: createPassword || undefined },
      });
      if (error) throw error;
      if ((data as any).error) throw new Error((data as any).error);
      setCredentials({ email: (data as any).email, password: (data as any).password });
      setShowCreate(false);
      setEmail("");
      setCreatePassword("");
      refetchUsers();
    } catch (e: any) {
      toast.error(e.message ?? String(e));
    } finally {
      setCreating(false);
    }
  };

  const handleSetPassword = async () => {
    if (!pwUser) return;
    setPasswordError("");
    if (!newPassword || newPassword.length < 12) {
      setPasswordError("Use pelo menos 12 caracteres, combinando letras, números e símbolos.");
      return;
    }
    setSavingPw(true);
    try {
      const { data, error } = await supabase.functions.invoke("admin-manage-client-user", {
        body: { action: "set_password", tenant_id: id, user_id: pwUser.user_id, password: newPassword },
      });
      if (error) {
        let message = "Não foi possível atualizar a senha.";
        const context = "context" in error ? error.context : null;
        if (context instanceof Response) {
          const payload: unknown = await context.clone().json().catch(() => null);
          if (
            typeof payload === "object" && payload !== null &&
            "error" in payload && typeof payload.error === "string"
          ) {
            message = payload.error;
          }
        }
        setPasswordError(message);
        return;
      }
      if (
        typeof data === "object" && data !== null &&
        "error" in data && typeof data.error === "string"
      ) {
        setPasswordError(data.error);
        return;
      }
      toast.success("Senha atualizada");
      setPwUser(null);
      setNewPassword("");
    } catch {
      setPasswordError("Não foi possível atualizar a senha. Tente novamente.");
    } finally {
      setSavingPw(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteUser) return;
    setDeleting(true);
    try {
      const { data, error } = await supabase.functions.invoke("admin-manage-client-user", {
        body: { action: "delete", tenant_id: id, user_id: deleteUser.user_id },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      toast.success("Acesso excluído");
      setDeleteUser(null);
      refetchUsers();
    } catch (e: any) {
      toast.error(e.message ?? String(e));
    } finally {
      setDeleting(false);
    }
  };

  const copyCreds = () => {
    if (!credentials) return;
    navigator.clipboard.writeText(`Email: ${credentials.email}\nSenha: ${credentials.password}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate(`/tenants/${id}`)}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h2 className="text-2xl font-bold text-foreground">Acessos &amp; Permissões</h2>
          <p className="text-muted-foreground">{tenant?.name}</p>
        </div>
      </div>

      <div className="glass-card p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-foreground">Acessos do cliente</h3>
          <Button onClick={() => setShowCreate(true)}><Plus className="w-4 h-4 mr-1" />Criar acesso</Button>
        </div>
        {users && users.length > 0 ? (
          <ul className="space-y-2">
            {users.map((u) => (
              <li key={u.user_id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 bg-muted/30 rounded p-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground truncate">{u.email ?? "(email não encontrado)"}</div>
                  <div className="text-xs text-muted-foreground">Vinculado em {new Date(u.created_at).toLocaleDateString()}</div>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => { setPwUser(u); setNewPassword(""); setPasswordError(""); }}>
                    <KeyRound className="w-3.5 h-3.5 mr-1" />Definir senha
                  </Button>
                  <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => setDeleteUser(u)}>
                    <Trash2 className="w-3.5 h-3.5 mr-1" />Excluir
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Nenhum acesso criado ainda.</p>
        )}
      </div>

      <div className="glass-card p-6 space-y-4">
        <h3 className="font-semibold text-foreground">Permissões por módulo</h3>
        <p className="text-sm text-muted-foreground">Controle o que o cliente vê e pode editar no painel dele.</p>
        <div className="space-y-2">
          {MODULES.map((m) => {
            const cur = getVis(m.key);
            return (
              <div key={m.key} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-3 rounded-lg bg-muted/30">
                <div className="font-medium text-sm text-foreground">{m.label}</div>
                <div className="flex gap-1">
                  {VISIBILITIES.map((v) => (
                    <button key={v.v} onClick={() => setVis(m.key, v.v)}
                      className={`px-3 py-1 rounded-md text-xs font-medium transition ${cur === v.v ? v.color : "bg-background text-muted-foreground hover:bg-muted"}`}>
                      {v.label}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader><DialogTitle>Criar acesso do cliente</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Label>Email do cliente</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="cliente@exemplo.com" />
            <Label>Senha (opcional)</Label>
            <Input type="text" value={createPassword} onChange={(e) => setCreatePassword(e.target.value)} placeholder="Deixe em branco para gerar automaticamente" />
            <p className="text-xs text-muted-foreground">Se deixar em branco, uma senha temporária será gerada.</p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowCreate(false)}>Cancelar</Button>
            <Button onClick={handleCreate} disabled={creating}>{creating ? "Criando..." : "Criar"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!credentials} onOpenChange={() => setCredentials(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Acesso criado</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Compartilhe estas credenciais com o cliente. Esta é a única vez que a senha será exibida.</p>
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

      <Dialog open={!!pwUser} onOpenChange={(o) => { if (!o) { setPwUser(null); setPasswordError(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Definir nova senha</DialogTitle>
            <DialogDescription>{pwUser?.email}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Label>Nova senha</Label>
            <Input
              type="password"
              value={newPassword}
              onChange={(e) => { setNewPassword(e.target.value); setPasswordError(""); }}
              placeholder="Mínimo 12 caracteres"
              aria-invalid={!!passwordError}
              aria-describedby="password-guidance"
            />
            <p id="password-guidance" className={`text-xs ${passwordError ? "text-destructive" : "text-muted-foreground"}`}>
              {passwordError || "Use uma senha única com letras, números e símbolos."}
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPwUser(null)}>Cancelar</Button>
            <Button onClick={handleSetPassword} disabled={savingPw}>{savingPw ? "Salvando..." : "Salvar senha"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteUser} onOpenChange={(o) => !o && setDeleteUser(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir acesso?</AlertDialogTitle>
            <AlertDialogDescription>
              O usuário <strong>{deleteUser?.email}</strong> será removido permanentemente e não conseguirá mais entrar no painel.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={deleting} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {deleting ? "Excluindo..." : "Excluir"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
