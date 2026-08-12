import { Navigate } from "react-router-dom";
import { useModulePermission } from "@/hooks/useAuth";
import { useClientTenant } from "@/hooks/useClientTenant";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Save } from "lucide-react";

/** Aba "Base de conhecimento" — separada do Prompt e das Ferramentas. */
export default function ClientKnowledge() {
  const perm = useModulePermission("ai_knowledge");
  const { tenant, form, setForm, save } = useClientTenant();

  if (!perm.visible) return <Navigate to="/app" replace />;
  if (!tenant) return <p className="text-muted-foreground">Carregando...</p>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Base de conhecimento</h1>
        <p className="text-muted-foreground">
          Informações da sua empresa que a IA consulta para responder (serviços, políticas, avisos)
        </p>
      </div>

      <div className="glass-card p-5 flex flex-col gap-3" style={{ minHeight: "calc(100vh - 260px)" }}>
        <Label>Conteúdo da base de conhecimento</Label>
        <Textarea
          disabled={!perm.editable}
          className="ia-prompt-textarea flex-1 min-h-[420px] resize-none font-mono text-sm disabled:opacity-100 disabled:text-foreground/70"
          value={form.agent_knowledge_base ?? ""}
          onChange={(e) => setForm({ ...form, agent_knowledge_base: e.target.value })}
        />
        {perm.editable && (
          <Button
            className="w-fit"
            onClick={() => save({ agent_knowledge_base: form.agent_knowledge_base ?? "" }, "edit_ai_knowledge")}
          >
            <Save className="w-4 h-4 mr-2" />Salvar
          </Button>
        )}
      </div>
    </div>
  );
}
