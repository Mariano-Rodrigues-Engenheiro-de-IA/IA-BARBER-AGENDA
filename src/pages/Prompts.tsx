import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Loader2, Save } from "lucide-react";

type ProviderPrompt = {
  provider: string;
  label: string;
  default_content: string;
  override_content: string;
  has_override: boolean;
  updated_at: string | null;
};

export default function PromptsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderPrompt[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  async function load() {
    setLoading(true);
    const { data, error } = await supabase.functions.invoke("provider-prompts", { method: "GET" });
    setLoading(false);
    if (error) return toast.error("Falha ao carregar prompts: " + error.message);
    const list: ProviderPrompt[] = data?.providers || [];
    setProviders(list);
    const d: Record<string, string> = {};
    for (const p of list) d[p.provider] = p.override_content || p.default_content;
    setDrafts(d);
  }

  useEffect(() => { load(); }, []);

  async function save(provider: string) {
    setSaving(provider);
    const content = drafts[provider] ?? "";
    const { error } = await supabase.functions.invoke("provider-prompts", {
      method: "POST",
      body: { provider, content },
    });
    setSaving(null);
    if (error) return toast.error("Erro ao salvar: " + error.message);
    toast.success("Prompt salvo. A IA já está usando a nova versão.");
    load();
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" /> Carregando prompts...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-foreground">Prompts dos Provedores</h2>
        <p className="text-muted-foreground mt-1">
          Visualize e edite o prompt técnico que cada provedor envia para a IA. Mudanças passam a valer imediatamente em todas as conversas.
        </p>
      </div>

      <Tabs defaultValue={providers[0]?.provider || "trinks"}>
        <TabsList className="flex flex-wrap h-auto">
          {providers.map((p) => (
            <TabsTrigger key={p.provider} value={p.provider} className="relative">
              {p.label}
              {p.has_override && (
                <span className="ml-2 inline-block w-2 h-2 rounded-full bg-primary" title="Editado" />
              )}
            </TabsTrigger>
          ))}
        </TabsList>

        {providers.map((p) => {
          const draft = drafts[p.provider] ?? "";
          const baseline = p.override_content || p.default_content;
          const dirty = draft !== baseline;
          return (
            <TabsContent key={p.provider} value={p.provider} className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 justify-between">
                <div className="text-sm text-muted-foreground">
                  {p.updated_at ? `Editado em ${new Date(p.updated_at).toLocaleString("pt-BR")}` : "Ainda não editado"}
                </div>
                <Button
                  size="sm"
                  onClick={() => save(p.provider)}
                  disabled={!dirty || saving === p.provider}
                >
                  {saving === p.provider ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
                  Salvar
                </Button>
              </div>

              <Textarea
                value={draft}
                onChange={(e) => setDrafts((d) => ({ ...d, [p.provider]: e.target.value }))}
                className="font-mono text-xs min-h-[600px]"
                spellCheck={false}
              />

              <p className="text-xs text-muted-foreground">
                {draft.length.toLocaleString("pt-BR")} caracteres · {dirty ? "Alterações não salvas" : "Sem alterações"}
              </p>
            </TabsContent>
          );
        })}
      </Tabs>
    </div>
  );
}
