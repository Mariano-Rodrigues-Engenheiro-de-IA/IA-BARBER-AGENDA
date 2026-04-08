import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTenant, useCreateTenant, useUpdateTenant, type TenantInsert } from "@/hooks/useTenants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, Save, Eye, EyeOff, Plug, Loader2, CheckCircle2, XCircle } from "lucide-react";
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

export default function TenantFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isEditing = !!id;
  const { data: existing, isLoading: loadingTenant } = useTenant(id);
  const createTenant = useCreateTenant();
  const updateTenant = useUpdateTenant();

  const [showApiKey, setShowApiKey] = useState(false);
  const [form, setForm] = useState<TenantInsert>({
    name: "",
    slug: "",
    phone: "",
    email: "",
    address: "",
    status: "active",
    trinks_api_key: "",
    trinks_establishment_id: "",
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
        status: existing.status,
        trinks_api_key: existing.trinks_api_key ?? "",
        trinks_establishment_id: existing.trinks_establishment_id ?? "",
        agent_system_prompt: existing.agent_system_prompt ?? "",
        agent_knowledge_base: existing.agent_knowledge_base ?? "",
      });
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
      if (isEditing && id) {
        await updateTenant.mutateAsync({ id, ...form });
        toast.success("Tenant atualizado!");
      } else {
        await createTenant.mutateAsync(form);
        toast.success("Tenant criado!");
      }
      navigate("/tenants");
    } catch (error: any) {
      toast.error(error.message || "Erro ao salvar tenant");
    }
  };

  const isSaving = createTenant.isPending || updateTenant.isPending;

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
            {isEditing ? "Editar Tenant" : "Novo Tenant"}
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
            <TabsTrigger value="api">Integração API</TabsTrigger>
            <TabsTrigger value="agent">Agente IA</TabsTrigger>
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

          <TabsContent value="api" className="space-y-4">
            <div className="glass-card p-6 space-y-4">
              <h3 className="font-semibold text-foreground">Credenciais API Trinks</h3>
              <p className="text-sm text-muted-foreground">
                Insira as credenciais de acesso à API Trinks deste estabelecimento.
              </p>
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
            </div>
          </TabsContent>

          <TabsContent value="agent" className="space-y-4">
            <div className="glass-card p-6 space-y-4">
              <h3 className="font-semibold text-foreground">Configuração do Agente IA</h3>
              <p className="text-sm text-muted-foreground">
                Personalize o comportamento do agente de IA para este estabelecimento.
              </p>
              <div className="space-y-2">
                <Label htmlFor="prompt">Prompt do Sistema</Label>
                <Textarea
                  id="prompt"
                  rows={8}
                  value={form.agent_system_prompt as string}
                  onChange={(e) => handleChange("agent_system_prompt", e.target.value)}
                  placeholder="Você é um assistente de IA para agendamento e atendimento do [Nome do Estabelecimento]..."
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="knowledge">Base de Conhecimento</Label>
                <Textarea
                  id="knowledge"
                  rows={6}
                  value={form.agent_knowledge_base as string}
                  onChange={(e) => handleChange("agent_knowledge_base", e.target.value)}
                  placeholder="Informações sobre serviços, preços, horários de funcionamento, políticas do estabelecimento..."
                />
              </div>
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
