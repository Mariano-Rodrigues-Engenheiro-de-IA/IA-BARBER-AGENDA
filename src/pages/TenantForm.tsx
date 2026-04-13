import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTenant, useCreateTenant, useUpdateTenant, type TenantInsert } from "@/hooks/useTenants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { ArrowLeft, Save, Eye, EyeOff, Plug, Loader2, CheckCircle2, XCircle, MessageSquare, Wrench, Plus, Pencil, Trash2, Upload, X, Clock, Kanban } from "lucide-react";
import { toast } from "sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";

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

// ===================== CUSTOM TOOLS TYPES =====================

interface ComboItem {
  id: string;
  type: "text" | "image" | "audio" | "video" | "document" | "location";
  config: {
    text?: string;
    url?: string;
    caption?: string;
    latitude?: number;
    longitude?: number;
    name?: string;
    address?: string;
  };
}

interface CustomToolConfig {
  text?: string;
  url?: string;
  caption?: string;
  latitude?: number;
  longitude?: number;
  name?: string;
  address?: string;
  combo_items?: ComboItem[];
  human_number?: string;
  label_id?: string;
}

interface CustomTool {
  id: string;
  name: string;
  display_name: string;
  description: string;
  type: "send_text" | "send_image" | "send_audio" | "send_video" | "send_location" | "send_document" | "send_link" | "escalate_human" | "send_combo" | "add_label" | "remove_label";
  config: CustomToolConfig;
  prompt_instruction: string;
  enabled: boolean;
}

const TOOL_TYPE_LABELS: Record<CustomTool["type"], string> = {
  send_text: "Texto",
  send_image: "Imagem",
  send_audio: "Áudio",
  send_video: "Vídeo",
  send_location: "Localização",
  send_document: "Documento",
  send_link: "Link",
  escalate_human: "Escalar Humano",
  send_combo: "Combo (Múltiplas Mídias)",
  add_label: "Adicionar Etiqueta",
  remove_label: "Remover Etiqueta",
};

const TOOL_TEMPLATES: Omit<CustomTool, "id">[] = [
  {
    name: "enviar_pix",
    display_name: "Enviar PIX",
    description: "Envia a chave PIX do estabelecimento",
    type: "send_text",
    config: { text: "Chave PIX: (preencha aqui)" },
    prompt_instruction: "Use quando o cliente perguntar sobre pagamento via PIX ou pedir a chave PIX.",
    enabled: true,
  },
  {
    name: "enviar_localizacao",
    display_name: "Localização",
    description: "Envia a localização do estabelecimento",
    type: "send_location",
    config: { latitude: -15.7942, longitude: -47.8822, name: "(nome do local)", address: "(endereço completo)" },
    prompt_instruction: "Use quando o cliente perguntar onde fica, pedir endereço ou localização.",
    enabled: true,
  },
  {
    name: "enviar_midia",
    display_name: "Enviar Mídia",
    description: "Envia uma mídia para o cliente (imagem, áudio, vídeo ou documento)",
    type: "send_image",
    config: { url: "", caption: "" },
    prompt_instruction: "Use quando precisar enviar uma mídia ao cliente.",
    enabled: true,
  },
  {
    name: "escalar_humano",
    display_name: "Escalar para Humano",
    description: "Transfere o atendimento para um humano",
    type: "escalate_human",
    config: { text: "Vou transferir você para um atendente. Aguarde um momento! 🙋" },
    prompt_instruction: "Use quando o cliente pedir para falar com uma pessoa real, atendente humano, ou quando a situação for complexa demais para resolver automaticamente.",
    enabled: true,
  },
  {
    name: "adicionar_etiqueta",
    display_name: "Adicionar Etiqueta",
    description: "Adiciona uma etiqueta/tag ao contato do cliente no WhatsApp",
    type: "add_label",
    config: { label_id: "" },
    prompt_instruction: "Use quando precisar marcar/etiquetar o contato do cliente. Ex: após agendamento confirmado, após lead qualificado, etc.",
    enabled: true,
  },
  {
    name: "remover_etiqueta",
    display_name: "Remover Etiqueta",
    description: "Remove uma etiqueta/tag do contato do cliente no WhatsApp",
    type: "remove_label",
    config: { label_id: "" },
    prompt_instruction: "Use quando precisar remover uma etiqueta do contato do cliente.",
    enabled: true,
  },
];

function generateToolId(): string {
  return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2, 10);
}

function slugifyToolName(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/(^_|_$)+/g, "");
}

// ===================== MEDIA UPLOAD COMPONENT =====================

function MediaUploadField({ 
  label, 
  url, 
  accept, 
  tenantId,
  folder,
  onUrlChange 
}: { 
  label: string; 
  url: string; 
  accept: string; 
  tenantId?: string;
  folder: string;
  onUrlChange: (url: string) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [mode, setMode] = useState<"upload" | "url">(url && !url.includes("tenant-media") ? "url" : "upload");

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const id = tenantId || "new";
    const ext = file.name.split(".").pop();
    const path = `${id}/${folder}/${Date.now()}.${ext}`;

    setUploading(true);
    try {
      const { error } = await supabase.storage.from("tenant-media").upload(path, file, { upsert: true });
      if (error) throw error;

      const { data: urlData } = supabase.storage.from("tenant-media").getPublicUrl(path);
      onUrlChange(urlData.publicUrl);
      toast.success("Arquivo enviado com sucesso!");
    } catch (err: any) {
      toast.error("Erro ao enviar arquivo: " + err.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground underline"
          onClick={() => setMode(mode === "upload" ? "url" : "upload")}
        >
          {mode === "upload" ? "Usar URL" : "Fazer upload"}
        </button>
      </div>

      {mode === "upload" ? (
        <div className="space-y-2">
          {url ? (
            <div className="flex items-center gap-2 p-2 rounded-md bg-muted/50 border border-border">
              <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
              <span className="text-sm text-foreground truncate flex-1">{url.split("/").pop()}</span>
              <button type="button" onClick={() => onUrlChange("")} className="text-muted-foreground hover:text-destructive">
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : null}
          <label className="flex items-center justify-center gap-2 p-3 border-2 border-dashed border-border rounded-md cursor-pointer hover:border-primary/50 hover:bg-muted/30 transition-colors">
            {uploading ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : (
              <Upload className="h-4 w-4 text-muted-foreground" />
            )}
            <span className="text-sm text-muted-foreground">
              {uploading ? "Enviando..." : url ? "Trocar arquivo" : "Clique para enviar"}
            </span>
            <input type="file" accept={accept} className="hidden" onChange={handleFileUpload} disabled={uploading} />
          </label>
        </div>
      ) : (
        <Input value={url} onChange={(e) => onUrlChange(e.target.value)} placeholder="https://exemplo.com/arquivo" />
      )}
    </div>
  );
}

// ===================== COMBO CONFIG FIELDS =====================

const COMBO_ITEM_LABELS: Record<ComboItem["type"], string> = {
  text: "Texto",
  image: "Imagem",
  audio: "Áudio",
  video: "Vídeo",
  document: "Documento",
  location: "Localização",
};

function ComboConfigFields({ items, onChange, tenantId }: { items: ComboItem[]; onChange: (items: ComboItem[]) => void; tenantId?: string }) {
  const addItem = (type: ComboItem["type"]) => {
    onChange([...items, { id: generateToolId(), type, config: {} }]);
  };

  const removeItem = (id: string) => {
    onChange(items.filter((i) => i.id !== id));
  };

  const updateItem = (id: string, config: ComboItem["config"]) => {
    onChange(items.map((i) => (i.id === id ? { ...i, config } : i)));
  };

  const moveItem = (index: number, direction: -1 | 1) => {
    const newItems = [...items];
    const target = index + direction;
    if (target < 0 || target >= newItems.length) return;
    [newItems[index], newItems[target]] = [newItems[target], newItems[index]];
    onChange(newItems);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Label>Itens do Combo ({items.length})</Label>
      </div>

      {items.map((item, idx) => (
        <div key={item.id} className="border border-border rounded-lg p-3 space-y-3 bg-background/50">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-foreground">
              {idx + 1}. {COMBO_ITEM_LABELS[item.type]}
            </span>
            <div className="flex items-center gap-1">
              <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => moveItem(idx, -1)} disabled={idx === 0}>
                ↑
              </Button>
              <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => moveItem(idx, 1)} disabled={idx === items.length - 1}>
                ↓
              </Button>
              <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => removeItem(item.id)}>
                <Trash2 className="w-3 h-3 text-destructive" />
              </Button>
            </div>
          </div>
          <ComboItemConfigFields item={item} onChange={(config) => updateItem(item.id, config)} tenantId={tenantId} />
        </div>
      ))}

      <div className="flex flex-wrap gap-2">
        {(Object.keys(COMBO_ITEM_LABELS) as ComboItem["type"][]).map((type) => (
          <Button key={type} type="button" variant="outline" size="sm" onClick={() => addItem(type)}>
            <Plus className="w-3 h-3 mr-1" />
            {COMBO_ITEM_LABELS[type]}
          </Button>
        ))}
      </div>
    </div>
  );
}

function ComboItemConfigFields({ item, onChange, tenantId }: { item: ComboItem; onChange: (config: ComboItem["config"]) => void; tenantId?: string }) {
  const config = item.config;
  switch (item.type) {
    case "text":
      return (
        <Textarea rows={2} value={config.text || ""} onChange={(e) => onChange({ ...config, text: e.target.value })} placeholder="Texto a enviar" />
      );
    case "image":
      return (
        <div className="space-y-2">
          <MediaUploadField label="Imagem" url={config.url || ""} accept="image/*" tenantId={tenantId} folder="images" onUrlChange={(url) => onChange({ ...config, url })} />
          <Input value={config.caption || ""} onChange={(e) => onChange({ ...config, caption: e.target.value })} placeholder="Legenda (opcional)" />
        </div>
      );
    case "audio":
      return <MediaUploadField label="Áudio" url={config.url || ""} accept="audio/*" tenantId={tenantId} folder="audio" onUrlChange={(url) => onChange({ ...config, url })} />;
    case "video":
      return (
        <div className="space-y-2">
          <MediaUploadField label="Vídeo" url={config.url || ""} accept="video/*" tenantId={tenantId} folder="videos" onUrlChange={(url) => onChange({ ...config, url })} />
          <Input value={config.caption || ""} onChange={(e) => onChange({ ...config, caption: e.target.value })} placeholder="Legenda (opcional)" />
        </div>
      );
    case "document":
      return (
        <div className="space-y-2">
          <MediaUploadField label="Documento" url={config.url || ""} accept=".pdf,.doc,.docx" tenantId={tenantId} folder="documents" onUrlChange={(url) => onChange({ ...config, url })} />
          <Input value={config.caption || ""} onChange={(e) => onChange({ ...config, caption: e.target.value })} placeholder="Legenda (opcional)" />
        </div>
      );
    case "location":
      return (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Input type="number" step="any" value={config.latitude ?? ""} onChange={(e) => onChange({ ...config, latitude: parseFloat(e.target.value) || 0 })} placeholder="Latitude" />
            <Input type="number" step="any" value={config.longitude ?? ""} onChange={(e) => onChange({ ...config, longitude: parseFloat(e.target.value) || 0 })} placeholder="Longitude" />
          </div>
          <Input value={config.name || ""} onChange={(e) => onChange({ ...config, name: e.target.value })} placeholder="Nome do Local" />
          <Input value={config.address || ""} onChange={(e) => onChange({ ...config, address: e.target.value })} placeholder="Endereço" />
        </div>
      );
    default:
      return null;
  }
}

// ===================== TOOL CONFIG FIELDS =====================

function ToolConfigFields({ tool, onChange, tenantId }: { tool: CustomTool; onChange: (config: CustomToolConfig) => void; tenantId?: string }) {
  const config = tool.config;

  switch (tool.type) {
    case "send_text":
      return (
        <div className="space-y-2">
          <Label>Texto a enviar</Label>
          <Textarea
            rows={3}
            value={config.text || ""}
            onChange={(e) => onChange({ ...config, text: e.target.value })}
            placeholder="Ex: Chave PIX: 11999998888 (Nome)"
          />
        </div>
      );
    case "escalate_human":
      return (
        <div className="space-y-3">
          <div className="space-y-2">
            <Label>Mensagem para o cliente</Label>
            <Textarea
              rows={2}
              value={config.text || ""}
              onChange={(e) => onChange({ ...config, text: e.target.value })}
              placeholder="Vou transferir você para um atendente. Aguarde um momento! 🙋"
            />
          </div>
          <div className="space-y-2">
            <Label>Número do atendente humano</Label>
            <Input
              value={config.human_number || ""}
              onChange={(e) => onChange({ ...config, human_number: e.target.value })}
              placeholder="5511999998888"
            />
            <p className="text-xs text-muted-foreground">A IA enviará um resumo da conversa + nome e número do cliente para este número</p>
          </div>
          <div className="space-y-2">
            <Label>ID da etiqueta WhatsApp (opcional)</Label>
            <Input
              value={config.label_id || ""}
              onChange={(e) => onChange({ ...config, label_id: e.target.value })}
              placeholder="Ex: 5, 12..."
            />
            <p className="text-xs text-muted-foreground">ID da etiqueta/tag que será adicionada ao contato quando escalado</p>
          </div>
        </div>
      );
    case "add_label":
      return (
        <div className="space-y-2">
          <Label>ID da etiqueta WhatsApp</Label>
          <Input
            value={config.label_id || ""}
            onChange={(e) => onChange({ ...config, label_id: e.target.value })}
            placeholder="Ex: 5, 12..."
          />
          <p className="text-xs text-muted-foreground">ID numérico da etiqueta/tag do WhatsApp Business que será adicionada ao contato</p>
        </div>
      );
    case "remove_label":
      return (
        <div className="space-y-2">
          <Label>ID da etiqueta WhatsApp</Label>
          <Input
            value={config.label_id || ""}
            onChange={(e) => onChange({ ...config, label_id: e.target.value })}
            placeholder="Ex: 5, 12..."
          />
          <p className="text-xs text-muted-foreground">ID numérico da etiqueta/tag do WhatsApp Business que será removida do contato</p>
        </div>
      );
    case "send_image":
      return (
        <div className="space-y-3">
          <MediaUploadField
            label="Imagem"
            url={config.url || ""}
            accept="image/*"
            tenantId={tenantId}
            folder="images"
            onUrlChange={(url) => onChange({ ...config, url })}
          />
          <div className="space-y-2">
            <Label>Legenda (opcional)</Label>
            <Input value={config.caption || ""} onChange={(e) => onChange({ ...config, caption: e.target.value })} placeholder="Descrição da imagem" />
          </div>
        </div>
      );
    case "send_audio":
      return (
        <MediaUploadField
          label="Áudio"
          url={config.url || ""}
          accept="audio/*"
          tenantId={tenantId}
          folder="audio"
          onUrlChange={(url) => onChange({ ...config, url })}
        />
      );
    case "send_video":
      return (
        <div className="space-y-3">
          <MediaUploadField
            label="Vídeo"
            url={config.url || ""}
            accept="video/*"
            tenantId={tenantId}
            folder="videos"
            onUrlChange={(url) => onChange({ ...config, url })}
          />
          <div className="space-y-2">
            <Label>Legenda (opcional)</Label>
            <Input value={config.caption || ""} onChange={(e) => onChange({ ...config, caption: e.target.value })} placeholder="Descrição do vídeo" />
          </div>
        </div>
      );
    case "send_location":
      return (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Latitude</Label>
              <Input type="number" step="any" value={config.latitude ?? ""} onChange={(e) => onChange({ ...config, latitude: parseFloat(e.target.value) || 0 })} placeholder="-15.7942" />
            </div>
            <div className="space-y-2">
              <Label>Longitude</Label>
              <Input type="number" step="any" value={config.longitude ?? ""} onChange={(e) => onChange({ ...config, longitude: parseFloat(e.target.value) || 0 })} placeholder="-47.8822" />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Nome do Local</Label>
            <Input value={config.name || ""} onChange={(e) => onChange({ ...config, name: e.target.value })} placeholder="Barbearia Exemplo" />
          </div>
          <div className="space-y-2">
            <Label>Endereço</Label>
            <Input value={config.address || ""} onChange={(e) => onChange({ ...config, address: e.target.value })} placeholder="Rua Exemplo, 123 - Bairro, Cidade - UF" />
          </div>
        </div>
      );
    case "send_document":
      return (
        <div className="space-y-3">
          <MediaUploadField
            label="Documento"
            url={config.url || ""}
            accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt"
            tenantId={tenantId}
            folder="documents"
            onUrlChange={(url) => onChange({ ...config, url })}
          />
          <div className="space-y-2">
            <Label>Legenda (opcional)</Label>
            <Input value={config.caption || ""} onChange={(e) => onChange({ ...config, caption: e.target.value })} placeholder="Tabela de preços atualizada" />
          </div>
        </div>
      );
    case "send_link":
      return (
        <div className="space-y-2">
          <Label>URL</Label>
          <Input value={config.url || ""} onChange={(e) => onChange({ ...config, url: e.target.value })} placeholder="https://exemplo.com" />
        </div>
      );
    case "send_combo":
      return <ComboConfigFields items={config.combo_items || []} onChange={(items) => onChange({ ...config, combo_items: items })} tenantId={tenantId} />;
    default:
      return null;
  }
}

// ===================== CUSTOM TOOLS TAB =====================

function CustomToolsTab({
  tools,
  onChange,
  tenantId,
}: {
  tools: CustomTool[];
  onChange: (tools: CustomTool[]) => void;
  tenantId?: string;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTool, setEditingTool] = useState<CustomTool | null>(null);

  const openNew = () => {
    setEditingTool({
      id: generateToolId(),
      name: "",
      display_name: "",
      description: "",
      type: "send_text",
      config: {},
      prompt_instruction: "",
      enabled: true,
    });
    setDialogOpen(true);
  };

  const openEdit = (tool: CustomTool) => {
    setEditingTool({ ...tool, config: { ...tool.config } });
    setDialogOpen(true);
  };

  const handleSave = () => {
    if (!editingTool?.display_name.trim()) {
      toast.error("Nome de exibição é obrigatório");
      return;
    }
    if (!editingTool?.prompt_instruction.trim()) {
      toast.error("Instrução para o prompt é obrigatória");
      return;
    }

    const toolToSave = {
      ...editingTool,
      name: editingTool.name || slugifyToolName(editingTool.display_name),
    };

    const existingIndex = tools.findIndex((t) => t.id === toolToSave.id);
    if (existingIndex >= 0) {
      const updated = [...tools];
      updated[existingIndex] = toolToSave;
      onChange(updated);
    } else {
      onChange([...tools, toolToSave]);
    }
    setDialogOpen(false);
    setEditingTool(null);
  };

  const handleDelete = (id: string) => {
    onChange(tools.filter((t) => t.id !== id));
  };

  const handleToggle = (id: string) => {
    onChange(tools.map((t) => (t.id === id ? { ...t, enabled: !t.enabled } : t)));
  };

  const addFromTemplate = (template: Omit<CustomTool, "id">) => {
    const newTool: CustomTool = { ...template, id: generateToolId() };
    setEditingTool(newTool);
    setDialogOpen(true);
  };

  return (
    <div className="glass-card p-6 space-y-6">
      <div>
        <h3 className="font-semibold text-foreground flex items-center gap-2">
          <Wrench className="w-5 h-5 text-primary" />
          Ferramentas Customizadas
        </h3>
        <p className="text-sm text-muted-foreground mt-1">
          Cadastre ferramentas que a IA pode acionar durante a conversa (PIX, localização, imagens, etc.)
        </p>
      </div>

      {/* Templates */}
      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground uppercase tracking-wider">Templates rápidos</Label>
        <div className="flex flex-wrap gap-2">
          {TOOL_TEMPLATES.map((tpl) => (
            <Button
              key={tpl.name}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => addFromTemplate(tpl)}
            >
              <Plus className="w-3 h-3 mr-1" />
              {tpl.display_name}
            </Button>
          ))}
        </div>
      </div>

      {/* Tool list */}
      {tools.length > 0 && (
        <div className="space-y-2">
          {tools.map((tool) => (
            <div
              key={tool.id}
              className="flex items-center justify-between p-3 rounded-lg border border-border bg-background/50"
            >
              <div className="flex items-center gap-3 min-w-0">
                <Switch
                  checked={tool.enabled}
                  onCheckedChange={() => handleToggle(tool.id)}
                />
                <div className="min-w-0">
                  <div className="font-medium text-sm text-foreground truncate">{tool.display_name}</div>
                  <div className="text-xs text-muted-foreground">
                    {TOOL_TYPE_LABELS[tool.type]} · {tool.enabled ? "Ativo" : "Inativo"}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button type="button" variant="ghost" size="icon" onClick={() => openEdit(tool)}>
                  <Pencil className="w-4 h-4" />
                </Button>
                <Button type="button" variant="ghost" size="icon" onClick={() => handleDelete(tool.id)}>
                  <Trash2 className="w-4 h-4 text-destructive" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {tools.length === 0 && (
        <div className="text-center py-8 text-muted-foreground text-sm">
          Nenhuma ferramenta cadastrada. Use os templates acima ou crie uma nova.
        </div>
      )}

      <Button type="button" variant="outline" onClick={openNew}>
        <Plus className="w-4 h-4 mr-2" />
        Adicionar Ferramenta
      </Button>

      {/* Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingTool && tools.some((t) => t.id === editingTool.id) ? "Editar" : "Nova"} Ferramenta</DialogTitle>
          </DialogHeader>
          {editingTool && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Nome de Exibição</Label>
                <Input
                  value={editingTool.display_name}
                  onChange={(e) => setEditingTool({ ...editingTool, display_name: e.target.value })}
                  placeholder="Ex: Enviar PIX"
                />
              </div>
              <div className="space-y-2">
                <Label>Descrição curta</Label>
                <Input
                  value={editingTool.description}
                  onChange={(e) => setEditingTool({ ...editingTool, description: e.target.value })}
                  placeholder="O que esta ferramenta faz"
                />
              </div>
              <div className="space-y-2">
                <Label>Tipo</Label>
                <Select
                  value={editingTool.type}
                  onValueChange={(v) => setEditingTool({ ...editingTool, type: v as CustomTool["type"], config: {} })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(TOOL_TYPE_LABELS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <ToolConfigFields tool={editingTool} onChange={(config) => setEditingTool({ ...editingTool, config })} tenantId={tenantId} />
              <div className="space-y-2">
                <Label>Instrução para o Prompt</Label>
                <Textarea
                  rows={3}
                  value={editingTool.prompt_instruction}
                  onChange={(e) => setEditingTool({ ...editingTool, prompt_instruction: e.target.value })}
                  placeholder="Descreva QUANDO a IA deve usar esta ferramenta. Ex: Use quando o cliente perguntar sobre pagamento via PIX."
                />
                <p className="text-xs text-muted-foreground">
                  Essa instrução é adicionada ao prompt do sistema para guiar a IA.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={editingTool.enabled}
                  onCheckedChange={(checked) => setEditingTool({ ...editingTool, enabled: checked })}
                />
                <Label>Ativa</Label>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancelar</Button>
            <Button type="button" onClick={handleSave}>Salvar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

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
        id: generateToolId(),
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

  const [showApiKey, setShowApiKey] = useState(false);
  const [customTools, setCustomTools] = useState<CustomTool[]>([]);
  const [followUps, setFollowUps] = useState<FollowUpConfig[]>([]);
  const [kanbanColumns, setKanbanColumns] = useState<{ label_id: string; name: string; color: string; order: number }[]>([]);
  const [form, setForm] = useState<TenantInsert>({
    name: "",
    slug: "",
    phone: "",
    email: "",
    address: "",
    whatsapp_number: "",
    status: "active",
    api_provider: "trinks",
    trinks_api_key: "",
    trinks_establishment_id: "",
    onebeleza_token: "",
    onebeleza_celular: "",
    booking_link: "",
    uazapi_url: "",
    uazapi_token: "",
    agent_system_prompt: "",
    agent_knowledge_base: "",
  });

  useEffect(() => {
    if (existing) {
      setForm({
        name: existing.name,
        slug: existing.slug,
        phone: existing.phone ?? "",
        email: existing.email ?? "",
        address: existing.address ?? "",
        whatsapp_number: existing.whatsapp_number ?? "",
        status: existing.status,
        api_provider: (existing as any).api_provider ?? "trinks",
        trinks_api_key: existing.trinks_api_key ?? "",
        trinks_establishment_id: existing.trinks_establishment_id ?? "",
        onebeleza_token: (existing as any).onebeleza_token ?? "",
        onebeleza_celular: (existing as any).onebeleza_celular ?? "",
        booking_link: (existing as any).booking_link ?? "",
        uazapi_url: existing.uazapi_url ?? "",
        uazapi_token: existing.uazapi_token ?? "",
        agent_system_prompt: existing.agent_system_prompt ?? "",
        agent_knowledge_base: existing.agent_knowledge_base ?? "",
      });
      // Load custom tools from agent_settings
      const settings = (existing as any).agent_settings;
      if (settings && typeof settings === "object" && Array.isArray(settings.custom_tools)) {
        setCustomTools(settings.custom_tools);
      } else {
        setCustomTools([]);
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
              id: generateToolId(),
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.slug.trim()) {
      toast.error("Nome e slug são obrigatórios");
      return;
    }
    try {
      // Merge custom_tools into agent_settings
      const currentSettings = (existing as any)?.agent_settings ?? {};
      const agentSettings = {
        ...(typeof currentSettings === "object" ? currentSettings : {}),
        custom_tools: customTools,
        follow_ups: followUps,
      };
      // Remove legacy follow_up key if present
      delete (agentSettings as any).follow_up;

      const payload = { ...form, agent_settings: agentSettings, kanban_columns: kanbanColumns };

      if (isEditing && id) {
        await updateTenant.mutateAsync({ id, ...payload } as any);
        toast.success("Empresa atualizada!");
      } else {
        await createTenant.mutateAsync(payload as any);
        toast.success("Empresa criada!");
      }
      navigate("/tenants");
    } catch (error: any) {
      toast.error(error.message || "Erro ao salvar empresa");
    }
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
        <div>
          <h2 className="text-2xl font-bold text-foreground">
            {isEditing ? "Editar Empresa" : "Nova Empresa"}
          </h2>
          <p className="text-muted-foreground mt-1">
            {isEditing ? "Atualize as informações do estabelecimento" : "Cadastre um novo salão ou barbearia"}
          </p>
        </div>
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
          </TabsList>

          <TabsContent value="general" className="space-y-4">
            <div className="glass-card p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
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
                  <Label htmlFor="slug">Slug</Label>
                  <Input
                    id="slug"
                    value={form.slug}
                    onChange={(e) => handleChange("slug", e.target.value)}
                    placeholder="salao-exemplo"
                    required
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="email">E-mail</Label>
                  <Input
                    id="email"
                    type="email"
                    value={form.email as string}
                    onChange={(e) => handleChange("email", e.target.value)}
                    placeholder="contato@salao.com"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="phone">Telefone</Label>
                  <Input
                    id="phone"
                    value={form.phone as string}
                    onChange={(e) => handleChange("phone", e.target.value)}
                    placeholder="(11) 99999-9999"
                  />
                </div>
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
              <div className="space-y-2">
                <Label htmlFor="address">Endereço</Label>
                <Input
                  id="address"
                  value={form.address as string}
                  onChange={(e) => handleChange("address", e.target.value)}
                  placeholder="Rua Exemplo, 123 - São Paulo, SP"
                />
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

              {provider === "none" && (
                <div className="space-y-4 pt-4 border-t border-border">
                  <h4 className="text-sm font-medium text-foreground">Link de Agendamento</h4>
                  <div className="space-y-2">
                    <Label htmlFor="booking_link">URL de Agendamento</Label>
                    <Input
                      id="booking_link"
                      value={(form as any).booking_link || ""}
                      onChange={(e) => handleChange("booking_link" as any, e.target.value)}
                      placeholder="https://link-de-agendamento.com"
                    />
                    <p className="text-xs text-muted-foreground">
                      O agente enviará este link quando o cliente quiser agendar
                    </p>
                  </div>
                </div>
              )}
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
                <div className="flex items-center justify-between">
                  <Label htmlFor="prompt">Prompt do Sistema</Label>
                  <span className="text-xs text-muted-foreground">
                    {(form.agent_system_prompt as string)?.length || 0} caracteres
                  </span>
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
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="knowledge">Base de Conhecimento</Label>
                  <span className="text-xs text-muted-foreground">
                    {(form.agent_knowledge_base as string)?.length || 0} caracteres
                  </span>
                </div>
                <Textarea
                  id="knowledge"
                  rows={12}
                  className="font-mono text-sm min-h-[200px]"
                  value={form.agent_knowledge_base as string}
                  onChange={(e) => handleChange("agent_knowledge_base", e.target.value)}
                  placeholder="Informações sobre serviços, preços, horários de funcionamento, políticas do estabelecimento..."
                />
              </div>
            </div>
          </TabsContent>

          <TabsContent value="tools" className="space-y-4">
            <CustomToolsTab tools={customTools} onChange={setCustomTools} tenantId={id} />
          </TabsContent>

          <TabsContent value="kanban" className="space-y-4">
            <div className="glass-card p-6 space-y-6">
              <div>
                <h3 className="font-semibold text-foreground flex items-center gap-2">
                  <Kanban className="w-5 h-5 text-primary" />
                  Colunas do Kanban CRM
                </h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Configure as colunas (etiquetas) do quadro Kanban. Cada coluna corresponde a um ID de etiqueta do WhatsApp.
                </p>
              </div>

              {kanbanColumns.map((col, idx) => (
                <div key={idx} className="flex items-center gap-3 p-3 rounded-lg border border-border bg-background/50">
                  <div className="w-4 h-4 rounded-full shrink-0 border border-border" style={{ backgroundColor: col.color }} />
                  <Input
                    value={col.name}
                    onChange={(e) => {
                      const updated = [...kanbanColumns];
                      updated[idx] = { ...updated[idx], name: e.target.value };
                      setKanbanColumns(updated);
                    }}
                    placeholder="Nome da coluna"
                    className="flex-1"
                  />
                  <Input
                    value={col.label_id}
                    onChange={(e) => {
                      const updated = [...kanbanColumns];
                      updated[idx] = { ...updated[idx], label_id: e.target.value };
                      setKanbanColumns(updated);
                    }}
                    placeholder="Label ID"
                    className="w-24"
                  />
                  <Select
                    value={col.type || "funnel"}
                    onValueChange={(val) => {
                      const updated = [...kanbanColumns];
                      updated[idx] = { ...updated[idx], type: val as "funnel" | "flag" };
                      setKanbanColumns(updated);
                    }}
                  >
                    <SelectTrigger className="w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="funnel">Funil</SelectItem>
                      <SelectItem value="flag">Flag</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    type="color"
                    value={col.color}
                    onChange={(e) => {
                      const updated = [...kanbanColumns];
                      updated[idx] = { ...updated[idx], color: e.target.value };
                      setKanbanColumns(updated);
                    }}
                    className="w-12 h-9 p-1 cursor-pointer"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => setKanbanColumns(kanbanColumns.filter((_, i) => i !== idx))}
                  >
                    <Trash2 className="w-4 h-4 text-destructive" />
                  </Button>
                </div>
              ))}

              <Button
                type="button"
                variant="outline"
                onClick={() => setKanbanColumns([...kanbanColumns, { label_id: "", name: "", color: "#3B82F6", order: kanbanColumns.length, type: "funnel" }])}
              >
                <Plus className="w-4 h-4 mr-2" />
                Adicionar Coluna
              </Button>
              <p className="text-xs text-muted-foreground">
                <strong>Funil:</strong> etapas do CRM (colunas no Kanban). <strong>Flag:</strong> marcações independentes que aparecem como badges nos cards (ex: IA OFF).
              </p>
            </div>
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
    </div>
  );
}
