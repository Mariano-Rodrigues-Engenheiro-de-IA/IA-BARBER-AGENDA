import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTenant, useCreateTenant, useUpdateTenant, type TenantInsert } from "@/hooks/useTenants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ArrowLeft, Save, Eye, EyeOff, Plug, Loader2, CheckCircle2, XCircle, MessageSquare, Wrench, Plus, Pencil, Trash2, Upload, X, Clock, Kanban, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { SequencesEditor } from "@/components/SequencesEditor";
import { KanbanBoardsManager } from "@/components/KanbanBoardsManager";
import { PromptVersionsDialog, type PromptVersion } from "@/components/PromptVersionsDialog";
import { useAuth } from "@/hooks/useAuth";


function slugify(text: string) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}

// ===================== FOLLOW-UP TYPES =====================

interface FollowUpConfig {
  id: string;
  name: string;
  type: "after_link_sent" | "after_no_reply";
  delay_minutes: number;
  message: string;
  enabled: boolean;
}

const FIXED_FOLLOWUPS: { type: FollowUpConfig["type"]; name: string; description: string; defaultMessage: string; defaultDelay: number }[] = [
  {
    type: "after_link_sent",
    name: "Após envio de link",
    description: "Envia mensagem de acompanhamento quando a IA envia o link de agendamento e o cliente não confirma.",
    defaultMessage: "Oi! Vi que te mandei o link pra agendar, conseguiu marcar certinho? Se tiver qualquer dúvida, tô aqui! 😊",
    defaultDelay: 30,
  },
  {
    type: "after_no_reply",
    name: "Sem resposta do cliente",
    description: "Quando o cliente manda a primeira mensagem, a IA responde e ele não continua a conversa.",
    defaultMessage: "Oi! Podemos prosseguir? 😊",
    defaultDelay: 15,
  },
];

// Custom tools are managed via shared component
import { CustomToolsTab, type CustomTool } from "@/components/CustomToolsTab";


// ===================== FOLLOW-UPS TAB =====================

function FollowUpsSection({
  followUps,
  onChange,
}: {
  followUps: FollowUpConfig[];
  onChange: (followUps: FollowUpConfig[]) => void;
}) {

  // Initialize with defaults for both fixed types
  useEffect(() => {
    if (followUps.length === 0) return;
    // No init needed, handled by parent
  }, []);

  const getConfig = (type: FollowUpConfig["type"]) => followUps.find((f) => f.type === type);

  const handleToggle = (type: FollowUpConfig["type"]) => {
    const existing = getConfig(type);
    if (existing) {
      onChange(followUps.map((f) => (f.type === type ? { ...f, enabled: !f.enabled } : f)));
    } else {
      const def = FIXED_FOLLOWUPS.find((d) => d.type === type)!;
      onChange([...followUps, {
        id: (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2,10)),
        name: def.name,
        type: def.type,
        delay_minutes: def.defaultDelay,
        message: def.defaultMessage,
        enabled: true,
      }]);
    }
  };

  const updateField = (type: FollowUpConfig["type"], field: string, value: any) => {
    const existing = getConfig(type);
    if (existing) {
      onChange(followUps.map((f) => (f.type === type ? { ...f, [field]: value } : f)));
    }
  };

  return (
    <div className="glass-card p-6 space-y-6">
      <div>
        <h3 className="font-semibold text-foreground flex items-center gap-2">
          <Clock className="w-5 h-5 text-primary" />
          Follow-ups Automáticos
        </h3>
        <p className="text-sm text-muted-foreground mt-1">
          Ative e configure mensagens automáticas de acompanhamento.
        </p>
      </div>

      <div className="space-y-4">
        {FIXED_FOLLOWUPS.map((def) => {
          const config = getConfig(def.type);
          const isEnabled = config?.enabled ?? false;

          return (
            <div key={def.type} className="rounded-lg border border-border bg-background/50 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium text-sm text-foreground">{def.name}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{def.description}</div>
                </div>
                <Switch checked={isEnabled} onCheckedChange={() => handleToggle(def.type)} />
              </div>

              {isEnabled && config && (
                <div className="space-y-3 pt-2 border-t border-border">
                  <div className="space-y-2 max-w-xs">
                    <Label>Tempo para envio (minutos)</Label>
                    <Input
                      type="number"
                      min={1}
                      max={1440}
                      value={config.delay_minutes}
                      onChange={(e) => updateField(def.type, "delay_minutes", parseInt(e.target.value) || def.defaultDelay)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Mensagem</Label>
                    <Textarea
                      rows={3}
                      value={config.message}
                      onChange={(e) => updateField(def.type, "message", e.target.value)}
                      placeholder={def.defaultMessage}
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ===================== TEST BUTTONS =====================

function TrinksTestButton({ tenantId }: { tenantId: string }) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

  const handleTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("test-trinks-connection", {
        body: { tenant_id: tenantId },
      });
      if (error) throw error;
      setResult(data);
      if (data?.success) {
        toast.success(data.message);
      } else {
        toast.error(data?.message || "Falha na conexão");
      }
    } catch (err: any) {
      setResult({ success: false, message: err.message || "Erro ao testar conexão" });
      toast.error(err.message || "Erro ao testar conexão");
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="pt-4 border-t border-border space-y-3">
      <Button type="button" variant="outline" onClick={handleTest} disabled={testing}>
        {testing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plug className="w-4 h-4 mr-2" />}
        {testing ? "Testando..." : "Testar Conexão"}
      </Button>
      {result && (
        <div className={`flex items-center gap-2 text-sm ${result.success ? "text-emerald-400" : "text-red-400"}`}>
          {result.success ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
          {result.message}
        </div>
      )}
    </div>
  );
}

function CelCashTestButton({ tenantId }: { tenantId: string }) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

  const handleTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("test-celcash-connection", {
        body: { tenant_id: tenantId },
      });
      if (error) throw error;
      setResult(data);
      if (data?.success) toast.success(data.message);
      else toast.error(data?.message || "Falha na conexão");
    } catch (err: any) {
      setResult({ success: false, message: err.message || "Erro ao testar conexão" });
      toast.error(err.message || "Erro ao testar conexão");
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="pt-2 space-y-3">
      <Button type="button" variant="outline" onClick={handleTest} disabled={testing}>
        {testing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plug className="w-4 h-4 mr-2" />}
        {testing ? "Testando..." : "Testar Conexão CelCash"}
      </Button>
      {result && (
        <div className={`flex items-center gap-2 text-sm ${result.success ? "text-emerald-400" : "text-red-400"}`}>
          {result.success ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
          {result.message}
        </div>
      )}
    </div>
  );
}

function UazapiTestButton({ url, token }: { url: string; token: string }) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

  const handleTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      const res = await fetch(`${url}/status`, {
        headers: { "Authorization": `Bearer ${token}` },
      });
      const data = await res.json();
      if (res.ok && data) {
        const inst = data?.status?.checked_instance;
        const connected = inst?.connection_status === "connected" || inst?.is_healthy === true || data.connected || data.status === "CONNECTED" || data.state === "open";
        setResult({
          success: connected,
          message: connected ? "WhatsApp conectado!" : "Instância encontrada, mas WhatsApp não conectado",
        });
        toast[connected ? "success" : "warning"](connected ? "WhatsApp conectado!" : "WhatsApp não conectado");
      } else {
        setResult({ success: false, message: "Falha ao conectar na instância" });
        toast.error("Falha ao conectar na instância");
      }
    } catch (err: any) {
      setResult({ success: false, message: err.message || "Erro ao testar conexão" });
      toast.error(err.message || "Erro ao testar conexão");
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="pt-4 border-t border-border space-y-3">
      <Button type="button" variant="outline" onClick={handleTest} disabled={testing}>
        {testing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plug className="w-4 h-4 mr-2" />}
        {testing ? "Testando..." : "Testar Conexão WhatsApp"}
      </Button>
      {result && (
        <div className={`flex items-center gap-2 text-sm ${result.success ? "text-emerald-400" : "text-red-400"}`}>
          {result.success ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
          {result.message}
        </div>
      )}
    </div>
  );
}

// ===================== MAIN FORM =====================

export default function TenantFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isEditing = !!id;
  const { data: existing, isLoading: loadingTenant } = useTenant(id);
  const createTenant = useCreateTenant();
  const updateTenant = useUpdateTenant();

  const { user } = useAuth();
  const [showApiKey, setShowApiKey] = useState(false);
  const [customTools, setCustomTools] = useState<CustomTool[]>([]);
  const [followUps, setFollowUps] = useState<FollowUpConfig[]>([]);
  const [responseDelay, setResponseDelay] = useState(10);
  const [kanbanColumns, setKanbanColumns] = useState<{ label_id: string; name: string; color: string; order: number; type?: "funnel" | "flag" }[]>([]);
  const [logoUrl, setLogoUrl] = useState<string>("");
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [promptSummaryOpen, setPromptSummaryOpen] = useState(false);
  const [promptSummary, setPromptSummary] = useState("");

  const { data: versions, refetch: refetchVersions } = useQuery({
    queryKey: ["admin-ai-prompt-versions", id],
    enabled: !!id && id !== "new",
    queryFn: async () => {
      const { data } = await supabase
        .from("ai_prompt_versions")
        .select("id,version,prompt,created_at,created_by_role,change_summary")
        .eq("tenant_id", id!)
        .order("version", { ascending: false });
      return (data ?? []) as PromptVersion[];
    },
  });

  useEffect(() => {
    if (!id || id === "new") return;
    const channel = supabase
      .channel(`admin-tenant-${id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "ai_prompt_versions", filter: `tenant_id=eq.${id}` },
        () => { refetchVersions(); },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [id, refetchVersions]);

  const [form, setForm] = useState<TenantInsert>({
    name: "",
    slug: "",
    whatsapp_number: "",
    status: "active",
    api_provider: "trinks",
    trinks_api_key: "",
    trinks_establishment_id: "",
    onebeleza_token: "",
    onebeleza_celular: "",
    frizzar_token: "",
    frizzar_base_url: "",
    bemp_domain: "",
    bemp_token: "",
    zaylo_barbershop_id: "",
    zaylo_base_url: "",
    zaylo_publishable_key: "",
    booking_link: "",
    uazapi_url: "",
    uazapi_token: "",
    agent_system_prompt: "",
    agent_knowledge_base: "",
    celcash_enabled: false,
    celcash_env: "sandbox",
    celcash_galax_id: "",
    celcash_galax_hash: "",
  } as TenantInsert);

  useEffect(() => {
    if (existing) {
      setForm({
        name: existing.name,
        slug: existing.slug,
        whatsapp_number: existing.whatsapp_number ?? "",
        status: existing.status,
        api_provider: (existing as any).api_provider ?? "trinks",
        trinks_api_key: existing.trinks_api_key ?? "",
        trinks_establishment_id: existing.trinks_establishment_id ?? "",
        onebeleza_token: (existing as any).onebeleza_token ?? "",
        onebeleza_celular: (existing as any).onebeleza_celular ?? "",
        frizzar_token: (existing as any).frizzar_token ?? "",
        frizzar_base_url: (existing as any).frizzar_base_url ?? "",
        bemp_domain: (existing as any).bemp_domain ?? "",
        bemp_token: (existing as any).bemp_token ?? "",
        zaylo_barbershop_id: (existing as any).zaylo_barbershop_id ?? "",
        zaylo_base_url: (existing as any).zaylo_base_url ?? "",
        zaylo_publishable_key: (existing as any).zaylo_publishable_key ?? "",
        booking_link: (existing as any).booking_link ?? "",
        uazapi_url: existing.uazapi_url ?? "",
        uazapi_token: existing.uazapi_token ?? "",
        agent_system_prompt: existing.agent_system_prompt ?? "",
        agent_knowledge_base: existing.agent_knowledge_base ?? "",
        celcash_enabled: (existing as any).celcash_enabled ?? false,
        celcash_env: (existing as any).celcash_env ?? "sandbox",
        celcash_galax_id: (existing as any).celcash_galax_id ?? "",
        celcash_galax_hash: (existing as any).celcash_galax_hash ?? "",
      } as TenantInsert);
      setLogoUrl((existing as any).logo_url ?? "");

      // Load custom tools from agent_settings
      const settings = (existing as any).agent_settings;
      if (settings && typeof settings === "object" && Array.isArray(settings.custom_tools)) {
        setCustomTools(settings.custom_tools);
      } else {
        setCustomTools([]);
      }
      // Load response delay
      if (settings && typeof settings === "object" && typeof settings.response_delay === "number") {
        setResponseDelay(settings.response_delay);
      }
      // Load follow-ups (new array format)
      if (settings && typeof settings === "object") {
        if (Array.isArray(settings.follow_ups)) {
          setFollowUps(settings.follow_ups);
        } else if (settings.follow_up && typeof settings.follow_up === "object") {
          // Migrate legacy single follow_up to array
          const legacy = settings.follow_up;
          if (legacy.enabled !== false || legacy.message) {
            setFollowUps([{
              id: (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2,10)),
              name: "Após envio de link",
              type: "after_link_sent" as const,
              delay_minutes: legacy.delay_minutes || 30,
              message: legacy.message || "Oi! Vi que te mandei o link pra agendar, conseguiu marcar certinho? Se tiver qualquer dúvida, tô aqui! 😊",
              enabled: legacy.enabled !== false,
            }]);
          }
        }
      }
      // Load kanban columns
      const kc = (existing as any).kanban_columns;
      if (Array.isArray(kc)) {
        setKanbanColumns(kc);
      } else {
        setKanbanColumns([]);
      }
    }
  }, [existing]);

  const handleChange = (field: keyof TenantInsert, value: string) => {
    setForm((prev) => {
      const updated = { ...prev, [field]: value };
      if (field === "name" && !isEditing) {
        updated.slug = slugify(value);
      }
      return updated;
    });
  };

  const doSave = async (changeSummary?: string) => {
    try {
      const currentSettings = (existing as any)?.agent_settings ?? {};
      const agentSettings = {
        ...(typeof currentSettings === "object" ? currentSettings : {}),
        custom_tools: customTools,
        follow_ups: followUps,
        response_delay: responseDelay,
      };
      delete (agentSettings as any).follow_up;

      const payload = { ...form, agent_settings: agentSettings, kanban_columns: kanbanColumns, logo_url: logoUrl || null } as any;

      let savedId = id;
      if (isEditing && id) {
        await updateTenant.mutateAsync({ id, ...payload } as any);
        toast.success("Empresa atualizada!");
      } else {
        const created: any = await createTenant.mutateAsync(payload as any);
        savedId = created?.id ?? savedId;
        toast.success("Empresa criada!");
      }

      // Register a new prompt version when prompt changed (mirrors client panel)
      const promptChanged = (form.agent_system_prompt ?? "") !== (existing?.agent_system_prompt ?? "");
      if (savedId && promptChanged && (form.agent_system_prompt ?? "").length > 0) {
        const nextVersion = (versions?.[0]?.version ?? 0) + 1;
        const { error: vErr } = await supabase.from("ai_prompt_versions").insert({
          tenant_id: savedId,
          version: nextVersion,
          prompt: form.agent_system_prompt ?? "",
          created_by: user?.id,
          created_by_role: "admin",
          change_summary: changeSummary?.trim() || null,
        } as any);
        if (vErr) toast.error("Empresa salva, mas não foi possível registrar a versão: " + vErr.message);
      }

      navigate("/tenants");
    } catch (error: any) {
      toast.error(error.message || "Erro ao salvar empresa");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.slug.trim()) {
      toast.error("Nome e slug são obrigatórios");
      return;
    }
    const enabledTools = customTools.filter((t) => t.enabled !== false);
    const nameCounts = new Map<string, string[]>();
    for (const t of enabledTools) {
      const key = (t.name || "").trim().toLowerCase();
      if (!key) continue;
      const arr = nameCounts.get(key) || [];
      arr.push(t.display_name || t.name);
      nameCounts.set(key, arr);
    }
    const duplicates = Array.from(nameCounts.entries()).filter(([, arr]) => arr.length > 1);
    if (duplicates.length > 0) {
      const msg = duplicates
        .map(([name, arr]) => `"${name}" usado por: ${arr.join(", ")}`)
        .join(" | ");
      toast.error(`Nomes internos de ferramentas duplicados — cada ferramenta precisa de um nome único. ${msg}`);
      return;
    }

    const promptChanged = isEditing && (form.agent_system_prompt ?? "") !== (existing?.agent_system_prompt ?? "");
    if (promptChanged) {
      setPromptSummary("");
      setPromptSummaryOpen(true);
      return;
    }
    await doSave();
  };

  const isSaving = createTenant.isPending || updateTenant.isPending;
  const provider = (form as any).api_provider || "trinks";

  if (isEditing && loadingTenant) {
    return <div className="text-muted-foreground">Carregando...</div>;
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate("/tenants")}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1">
          <h2 className="text-2xl font-bold text-foreground">
            {isEditing ? "Editar Empresa" : "Nova Empresa"}
          </h2>
          <p className="text-muted-foreground mt-1">
            {isEditing ? "Atualize as informações do estabelecimento" : "Cadastre um novo salão ou barbearia"}
          </p>
        </div>
        {isEditing && id && (
          <Button variant="outline" onClick={() => navigate(`/tenants/${id}/access`)}>
            Acessos &amp; Permissões
          </Button>
        )}
      </div>

      <form onSubmit={handleSubmit}>
        <Tabs defaultValue="general" className="space-y-6">
          <TabsList className="bg-muted">
            <TabsTrigger value="general">Geral</TabsTrigger>
            <TabsTrigger value="whatsapp">WhatsApp</TabsTrigger>
            <TabsTrigger value="api">Integração API</TabsTrigger>
            <TabsTrigger value="agent">Agente IA</TabsTrigger>
            <TabsTrigger value="tools" className="flex items-center gap-1">
              <Wrench className="w-3.5 h-3.5" />
              Ferramentas
            </TabsTrigger>
            <TabsTrigger value="kanban" className="flex items-center gap-1">
              <Kanban className="w-3.5 h-3.5" />
              Kanban
            </TabsTrigger>
            <TabsTrigger value="sequences" className="flex items-center gap-1">
              <Sparkles className="w-3.5 h-3.5" />
              Follow-ups
            </TabsTrigger>
          </TabsList>

          <TabsContent value="general" className="space-y-4">
            <div className="glass-card p-6 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Nome do Estabelecimento</Label>
                <Input
                  id="name"
                  value={form.name}
                  onChange={(e) => handleChange("name", e.target.value)}
                  placeholder="Salão Exemplo"
                  required
                />
              </div>

              <div className="space-y-2">
                <Label>Logo da empresa</Label>
                <div className="flex items-center gap-4">
                  <div className="w-20 h-20 rounded-xl border border-border bg-muted/30 flex items-center justify-center overflow-hidden shrink-0">
                    {logoUrl ? (
                      <img src={logoUrl} alt="Logo" className="w-full h-full object-contain" />
                    ) : (
                      <span className="text-xs text-muted-foreground">Sem logo</span>
                    )}
                  </div>
                  <div className="flex-1 space-y-2">
                    <label className="flex items-center justify-center gap-2 p-3 border-2 border-dashed border-border rounded-md cursor-pointer hover:border-primary/50 hover:bg-muted/30 transition-colors">
                      {uploadingLogo ? (
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      ) : (
                        <Upload className="h-4 w-4 text-muted-foreground" />
                      )}
                      <span className="text-sm text-muted-foreground">
                        {uploadingLogo ? "Enviando..." : logoUrl ? "Trocar logo" : "Enviar arquivo (PNG, JPG, SVG)"}
                      </span>
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        disabled={uploadingLogo}
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          setUploadingLogo(true);
                          try {
                            const ext = file.name.split(".").pop();
                            const path = `${id || "new"}/logo/${Date.now()}.${ext}`;
                            const { error } = await supabase.storage.from("tenant-media").upload(path, file, { upsert: true });
                            if (error) throw error;
                            const { data: urlData } = supabase.storage.from("tenant-media").getPublicUrl(path);
                            setLogoUrl(urlData.publicUrl);
                            toast.success("Logo enviado!");
                          } catch (err: any) {
                            toast.error("Erro ao enviar logo: " + err.message);
                          } finally {
                            setUploadingLogo(false);
                          }
                        }}
                      />
                    </label>
                    {logoUrl && (
                      <button type="button" onClick={() => setLogoUrl("")} className="text-xs text-muted-foreground hover:text-destructive">
                        Remover logo
                      </button>
                    )}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">Aparece no topo do painel do cliente.</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="whatsapp_number">Número WhatsApp (do estabelecimento)</Label>
                <Input
                  id="whatsapp_number"
                  value={form.whatsapp_number as string}
                  onChange={(e) => handleChange("whatsapp_number", e.target.value)}
                  placeholder="5511999999999 (com código do país)"
                />
                <p className="text-xs text-muted-foreground">
                  Número que recebe mensagens dos clientes. Usado para identificar o tenant.
                </p>
              </div>

              <div className="space-y-2 max-w-xs">
                <Label>Status</Label>
                <Select
                  value={form.status}
                  onValueChange={(v) => handleChange("status", v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Ativo</SelectItem>
                    <SelectItem value="inactive">Inativo</SelectItem>
                    <SelectItem value="suspended">Suspenso</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </TabsContent>


          <TabsContent value="whatsapp" className="space-y-4">
            <div className="glass-card p-6 space-y-4">
              <div className="flex items-center gap-2">
                <MessageSquare className="w-5 h-5 text-emerald-400" />
                <h3 className="font-semibold text-foreground">Conexão Uazapi (WhatsApp)</h3>
              </div>
              <p className="text-sm text-muted-foreground">
                Configure a conexão com a instância Uazapi deste estabelecimento para enviar e receber mensagens via WhatsApp.
              </p>
              <div className="space-y-2">
                <Label htmlFor="uazapi_url">URL da Instância</Label>
                <Input
                  id="uazapi_url"
                  value={form.uazapi_url as string}
                  onChange={(e) => handleChange("uazapi_url", e.target.value)}
                  placeholder="https://sua-instancia.uazapi.com"
                />
                <p className="text-xs text-muted-foreground">
                  URL base da sua instância Uazapi (ex: https://zyloia.uazapi.com)
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="uazapi_token">Token da Instância</Label>
                <div className="relative">
                  <Input
                    id="uazapi_token"
                    type={showApiKey ? "text" : "password"}
                    value={form.uazapi_token as string}
                    onChange={(e) => handleChange("uazapi_token", e.target.value)}
                    placeholder="Token de autenticação Uazapi"
                    className="pr-10"
                  />
                  <button
                    type="button"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    onClick={() => setShowApiKey(!showApiKey)}
                  >
                    {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              {isEditing && id && form.uazapi_url && form.uazapi_token && (
                <UazapiTestButton url={form.uazapi_url as string} token={form.uazapi_token as string} />
              )}
            </div>
          </TabsContent>

          <TabsContent value="api" className="space-y-4">
            <div className="glass-card p-6 space-y-4">
              <h3 className="font-semibold text-foreground">Provedor de Agendamento</h3>
              <p className="text-sm text-muted-foreground">
                Escolha o sistema de agendamento usado por este estabelecimento.
              </p>
              <div className="space-y-2 max-w-xs">
                <Label>Provedor</Label>
                <Select
                  value={provider}
                  onValueChange={(v) => handleChange("api_provider" as any, v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="trinks">Trinks</SelectItem>
                    <SelectItem value="onebeleza">One Beleza</SelectItem>
                    <SelectItem value="frizzar">Frizzar</SelectItem>
                    <SelectItem value="bemp">Bemp</SelectItem>
                    <SelectItem value="zaylo">Zaylo</SelectItem>
                    <SelectItem value="none">Nenhum (link direto)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {provider === "trinks" && (
                <div className="space-y-4 pt-4 border-t border-border">
                  <h4 className="text-sm font-medium text-foreground">Credenciais Trinks</h4>
                  <div className="space-y-2">
                    <Label htmlFor="trinks_api_key">X-Api-Key</Label>
                    <div className="relative">
                      <Input
                        id="trinks_api_key"
                        type={showApiKey ? "text" : "password"}
                        value={form.trinks_api_key as string}
                        onChange={(e) => handleChange("trinks_api_key", e.target.value)}
                        placeholder="Chave de API do Trinks"
                        className="pr-10"
                      />
                      <button
                        type="button"
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        onClick={() => setShowApiKey(!showApiKey)}
                      >
                        {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="trinks_id">ID do Estabelecimento (Trinks)</Label>
                    <Input
                      id="trinks_id"
                      value={form.trinks_establishment_id as string}
                      onChange={(e) => handleChange("trinks_establishment_id", e.target.value)}
                      placeholder="Ex: 12345"
                    />
                  </div>
                  {isEditing && id && <TrinksTestButton tenantId={id} />}
                </div>
              )}

              {provider === "onebeleza" && (
                <div className="space-y-4 pt-4 border-t border-border">
                  <h4 className="text-sm font-medium text-foreground">Credenciais One Beleza</h4>
                  <div className="space-y-2">
                    <Label htmlFor="onebeleza_token">Bearer Token</Label>
                    <div className="relative">
                      <Input
                        id="onebeleza_token"
                        type={showApiKey ? "text" : "password"}
                        value={(form as any).onebeleza_token || ""}
                        onChange={(e) => handleChange("onebeleza_token" as any, e.target.value)}
                        placeholder="Token de autenticação One Beleza"
                        className="pr-10"
                      />
                      <button
                        type="button"
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        onClick={() => setShowApiKey(!showApiKey)}
                      >
                        {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="onebeleza_celular">Celular da Conta (One Beleza)</Label>
                    <Input
                      id="onebeleza_celular"
                      value={(form as any).onebeleza_celular || ""}
                      onChange={(e) => handleChange("onebeleza_celular" as any, e.target.value)}
                      placeholder="Ex: 31999762442"
                    />
                    <p className="text-xs text-muted-foreground">
                      Número usado nas chamadas à API One Beleza (sem código do país)
                    </p>
                  </div>
                </div>
              )}

              {provider === "frizzar" && (
                <div className="space-y-4 pt-4 border-t border-border">
                  <h4 className="text-sm font-medium text-foreground">Credenciais Frizzar</h4>
                  <div className="space-y-2">
                    <Label htmlFor="frizzar_token">Token (Basic Auth)</Label>
                    <div className="relative">
                      <Input
                        id="frizzar_token"
                        type={showApiKey ? "text" : "password"}
                        value={(form as any).frizzar_token || ""}
                        onChange={(e) => handleChange("frizzar_token" as any, e.target.value)}
                        placeholder="Token Basic da API Frizzar"
                        className="pr-10"
                      />
                      <button
                        type="button"
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        onClick={() => setShowApiKey(!showApiKey)}
                      >
                        {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Cole o token fornecido pela Frizzar. Pode ser apenas o token (vamos prefixar com "Basic ") ou já com o prefixo. A empresa é identificada automaticamente pelo token.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="frizzar_base_url">URL base da API (opcional)</Label>
                    <Input
                      id="frizzar_base_url"
                      type="text"
                      value={(form as any).frizzar_base_url || ""}
                      onChange={(e) => handleChange("frizzar_base_url" as any, e.target.value)}
                      placeholder="Deixe em branco para usar o padrão"
                    />
                    <p className="text-xs text-muted-foreground">
                      Em branco usa o padrão atual: <code>https://homologacao.frizzar.com.br:8446/api/bot</code> (endpoint oficial em uso pela própria Frizzar). Preencha apenas se a Frizzar publicar uma nova URL.
                    </p>
                  </div>
                </div>
              )}

              {provider === "bemp" && (
                <div className="space-y-4 pt-4 border-t border-border">
                  <h4 className="text-sm font-medium text-foreground">Credenciais Bemp</h4>
                  <div className="space-y-2">
                    <Label htmlFor="bemp_domain">Domínio Bemp</Label>
                    <Input
                      id="bemp_domain"
                      value={(form as any).bemp_domain || ""}
                      onChange={(e) => handleChange("bemp_domain" as any, e.target.value)}
                      placeholder="ex: doncastrobarbearia"
                    />
                    <p className="text-xs text-muted-foreground">
                      Apenas o subdomínio (sem <code>.bemp.app</code>). Ex: <code>doncastrobarbearia</code> → vira <code>https://doncastrobarbearia.bemp.app</code>.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="bemp_token">Token de API</Label>
                    <div className="relative">
                      <Input
                        id="bemp_token"
                        type={showApiKey ? "text" : "password"}
                        value={(form as any).bemp_token || ""}
                        onChange={(e) => handleChange("bemp_token" as any, e.target.value)}
                        placeholder="Token fornecido pelo suporte Bemp"
                        className="pr-10"
                      />
                      <button
                        type="button"
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        onClick={() => setShowApiKey(!showApiKey)}
                      >
                        {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Solicitado dentro da plataforma Bemp (menu AJUDA). Será enviado como <code>Authorization: Token …</code>.
                    </p>
                  </div>
                </div>
              )}

              {provider === "zaylo" && (
                <div className="space-y-4 pt-4 border-t border-border">
                  <h4 className="text-sm font-medium text-foreground">Credenciais Zaylo</h4>
                  <div className="space-y-2">
                    <Label htmlFor="zaylo_barbershop_id">ID da Barbearia (barbershop_id)</Label>
                    <Input
                      id="zaylo_barbershop_id"
                      value={(form as any).zaylo_barbershop_id || ""}
                      onChange={(e) => handleChange("zaylo_barbershop_id" as any, e.target.value)}
                      placeholder="UUID da clínica/barbearia no Zaylo"
                    />
                    <p className="text-xs text-muted-foreground">
                      Encontrado no painel Zaylo → Configurações → Link público (UUID na URL).
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="zaylo_base_url">URL base da API (opcional)</Label>
                    <Input
                      id="zaylo_base_url"
                      value={(form as any).zaylo_base_url || ""}
                      onChange={(e) => handleChange("zaylo_base_url" as any, e.target.value)}
                      placeholder="Deixe em branco para usar o padrão"
                    />
                    <p className="text-xs text-muted-foreground">
                      Padrão: <code>https://fimdhqjzdyktzdijfoub.supabase.co/functions/v1/n8n-appointments</code>
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="zaylo_publishable_key">API Key <span className="text-destructive">*</span></Label>
                    <div className="relative">
                      <Input
                        id="zaylo_publishable_key"
                        type={showApiKey ? "text" : "password"}
                        value={(form as any).zaylo_publishable_key || ""}
                        onChange={(e) => handleChange("zaylo_publishable_key" as any, e.target.value)}
                        placeholder="AGENDAMENTOS_API_KEY da clínica (ex: sk_live_...)"
                        className="pr-10"
                      />
                      <button
                        type="button"
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        onClick={() => setShowApiKey(!showApiKey)}
                      >
                        {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Obrigatória. Enviada no header <code>x-api-key</code>. Solicite ao painel Zaylo da clínica.
                    </p>
                  </div>
                </div>
              )}


              {provider === "none" && (
                <div className="space-y-2 pt-4 border-t border-border">
                  <p className="text-xs text-muted-foreground">
                    Sem integração de agendamento. Se você quiser que a IA envie um link de agendamento, coloque o link diretamente no <strong>Prompt do Sistema</strong> (aba Agente) — não há mais campo separado para isso, evitando link duplicado.
                  </p>
                </div>
              )}

              {/* CelCash — opcional, disponível para todos os providers */}
              <div className="space-y-4 pt-4 border-t border-border">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="text-sm font-medium text-foreground">Integração CelCash / GalaxPay</h4>
                    <p className="text-xs text-muted-foreground mt-1">
                      Consulta assinatura e inadimplência do cliente antes do agendamento. Opcional.
                    </p>
                  </div>
                  <Switch
                    checked={!!(form as any).celcash_enabled}
                    onCheckedChange={(v) => handleChange("celcash_enabled" as any, v)}
                  />
                </div>

                {(form as any).celcash_enabled && (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="celcash_env">Ambiente</Label>
                      <Select
                        value={(form as any).celcash_env || "sandbox"}
                        onValueChange={(v) => handleChange("celcash_env" as any, v)}
                      >
                        <SelectTrigger id="celcash_env">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="sandbox">Sandbox (testes)</SelectItem>
                          <SelectItem value="production">Produção</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="celcash_galax_id">Galax ID</Label>
                      <Input
                        id="celcash_galax_id"
                        value={(form as any).celcash_galax_id || ""}
                        onChange={(e) => handleChange("celcash_galax_id" as any, e.target.value)}
                        placeholder="ex: 33399"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="celcash_galax_hash">Galax Hash</Label>
                      <div className="relative">
                        <Input
                          id="celcash_galax_hash"
                          type={showApiKey ? "text" : "password"}
                          value={(form as any).celcash_galax_hash || ""}
                          onChange={(e) => handleChange("celcash_galax_hash" as any, e.target.value)}
                          placeholder="Hash de autenticação CelCash"
                          className="pr-10"
                        />
                        <button
                          type="button"
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                          onClick={() => setShowApiKey(!showApiKey)}
                        >
                          {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Credenciais obtidas no painel CelCash → API. Usadas para OAuth2 (Basic auth → Bearer token).
                      </p>
                    </div>
                    {isEditing && id && <CelCashTestButton tenantId={id} />}
                  </>
                )}
              </div>
            </div>


            {/* Follow-ups section - visible for ALL providers */}
            <FollowUpsSection followUps={followUps} onChange={setFollowUps} />
          </TabsContent>

          <TabsContent value="agent" className="space-y-4">
            <div className="glass-card p-6 space-y-4">
              <h3 className="font-semibold text-foreground">Configuração do Agente IA</h3>
              <p className="text-sm text-muted-foreground">
                Personalize o comportamento do agente de IA para este estabelecimento. O prompt abaixo é anexado às instruções base do agente.
              </p>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <Label htmlFor="prompt">Prompt do Sistema</Label>
                  <div className="flex items-center gap-2">
                    {isEditing && id && (versions?.[0]?.version ?? 0) > 0 && (
                      <span className="text-xs px-2 py-1 rounded-md bg-muted text-muted-foreground">
                        Versão atual: v{versions?.[0]?.version}
                      </span>
                    )}
                    {isEditing && id && (
                      <PromptVersionsDialog
                        tenantId={id}
                        versions={versions ?? []}
                        currentVersion={versions?.[0]?.version ?? 0}
                        canRestore={true}
                        actorRole="admin"
                        userId={user?.id}
                        onRestored={() => { refetchVersions(); }}
                      />
                    )}
                    <span className="text-xs text-muted-foreground">
                      {(form.agent_system_prompt as string)?.length || 0} caracteres
                    </span>
                  </div>
                </div>
                <Textarea
                  id="prompt"
                  rows={20}
                  className="font-mono text-sm min-h-[300px]"
                  value={form.agent_system_prompt as string}
                  onChange={(e) => handleChange("agent_system_prompt", e.target.value)}
                  placeholder="Instruções adicionais para o agente: tom de voz, regras do estabelecimento, horários, profissionais, serviços especiais, etc."
                />
              </div>
              <div className="space-y-3 pt-4 border-t border-border">
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="flex items-center gap-2"><Clock className="h-4 w-4" /> Tempo de Resposta</Label>
                    <p className="text-xs text-muted-foreground mt-1">
                      Tempo que a IA aguarda antes de responder (acumula mensagens enviadas em sequência)
                    </p>
                  </div>
                  <span className="text-sm font-medium text-primary">{responseDelay}s</span>
                </div>
                <Slider
                  value={[responseDelay]}
                  onValueChange={([v]) => setResponseDelay(v)}
                  min={3}
                  max={30}
                  step={1}
                  className="w-full"
                />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>3s (rápido)</span>
                  <span>30s (aguarda mais)</span>
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="tools" className="space-y-4">
            <CustomToolsTab tools={customTools} onChange={setCustomTools} tenantId={id} />
          </TabsContent>

          <TabsContent value="kanban" className="space-y-4">
            {id && id !== "new" ? (
              <KanbanBoardsManager tenantId={id} />
            ) : (
              <div className="glass-card p-6 text-center text-muted-foreground">
                Salve o estabelecimento primeiro para configurar os CRMs.
              </div>
            )}
          </TabsContent>


          <TabsContent value="sequences" className="space-y-4">
            {id && id !== "new" ? (
              <SequencesEditor tenantId={id} />
            ) : (
              <div className="glass-card p-6 text-center text-muted-foreground">
                Salve o estabelecimento primeiro para configurar follow-ups.
              </div>
            )}
          </TabsContent>
        </Tabs>

        <div className="flex justify-end gap-3 mt-6">
          <Button type="button" variant="outline" onClick={() => navigate("/tenants")}>
            Cancelar
          </Button>
          <Button type="submit" disabled={isSaving}>
            <Save className="w-4 h-4 mr-2" />
            {isSaving ? "Salvando..." : "Salvar"}
          </Button>
        </div>
      </form>

      <AlertDialog open={promptSummaryOpen} onOpenChange={(o) => { setPromptSummaryOpen(o); if (!o) setPromptSummary(""); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Salvar nova versão do prompt</AlertDialogTitle>
            <AlertDialogDescription>
              Você alterou o prompt do sistema. Uma nova versão (v{(versions?.[0]?.version ?? 0) + 1}) será
              criada e o cliente verá a alteração imediatamente. Descreva o que mudou nesta versão.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="admin-change-summary">Resumo das alterações</Label>
            <Textarea
              id="admin-change-summary"
              placeholder="Ex.: Ajustei a saudação e adicionei instruções para perguntar nome antes de agendar."
              value={promptSummary}
              onChange={(e) => setPromptSummary(e.target.value)}
              rows={3}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (!promptSummary.trim()) { toast.error("Descreva um resumo das alterações"); return; }
                const s = promptSummary.trim();
                setPromptSummaryOpen(false);
                setPromptSummary("");
                await doSave(s);
              }}
            >
              Confirmar e salvar v{(versions?.[0]?.version ?? 0) + 1}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
