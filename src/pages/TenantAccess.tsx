import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Plus, Copy, Check } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import type { AppModule, ModuleVisibility } from "@/hooks/useAuth";

const MODULES: { key: AppModule; label: string }[] = [
  { key: "overview", label: "Visão Geral" },
  { key: "conversations", label: "Conversas" },
  { key: "followups", label: "Follow-ups" },
  { key: "crm", label: "CRM" },
  { key: "ai_prompt", label: "Prompt da IA" },
  { key: "ai_knowledge", label: "Base de conhecimento" },
  { key: "integrations", label: "Integrações (tokens)" },
  { key: "company_data", label: "Dados da empresa" },
];

const VISIBILITIES: { v: ModuleVisibility; label: string; color: string }[] = [
  { v: "hidden", label: "Oculto", color: "bg-destructive/10 text-destructive" },
  { v: "read_only", label: "Somente leitura", color: "bg-yellow-500/10 text-yellow-600" },
  { v: "editable", label: "Editável", color: "bg-emerald-500/10 text-emerald-600" },
];

export default function TenantAccessPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);
  const [email, setEmail] = useState("");
  const [creating, setCreating] = useState(false);
  const [credentials, setCredentials] = useState<{ email: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const { data: tenant } = useQuery({
    queryKey: ["tenant-access", id],
    enabled: !!id,
    queryFn: async () => (await supabase.from("tenants").select("name").eq("id", id!).single()).data,
  });

  const { data: users, refetch: refetchUsers } = useQuery({
    queryKey: ["tenant-users", id],
    enabled: !!id,
    queryFn: async () => (await supabase.from("tenant_users").select("user_id,created_at").eq("tenant_id", id!)).data ?? [],
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
    setCreating(true);
    try {
      const { data, error } = await supabase.functions.invoke("admin-create-client-user", {
        body: { tenant_id: id, email },
      });
      if (error) throw error;
      if ((data as any).error) throw new Error((data as any).error);
      setCredentials({ email: (data as any).email, password: (data as any).password });
      setShowCreate(false);
      setEmail("");
      refetchUsers();
    } catch (e: any) {
      toast.error(e.message ?? String(e));
    } finally {
      setCreating(false);
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
            {users.map((u: any) => (
              <li key={u.user_id} className="text-sm text-muted-foreground bg-muted/30 rounded p-3">
                <span className="font-mono">{u.user_id}</span>
                <span className="ml-2">— vinculado em {new Date(u.created_at).toLocaleDateString()}</span>
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
            <p className="text-xs text-muted-foreground">Uma senha temporária será gerada e exibida em seguida.</p>
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
    </div>
  );
}
