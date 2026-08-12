import { Navigate } from "react-router-dom";
import { useModulePermission } from "@/hooks/useAuth";
import { useClientTenant } from "@/hooks/useClientTenant";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Save } from "lucide-react";

/** Aba "Integrações" — tokens e credenciais usados pelo sistema e pela IA. */
export default function ClientIntegrations() {
  const perm = useModulePermission("integrations");
  const { tenant, form, setForm, save } = useClientTenant();

  if (!perm.visible) return <Navigate to="/app" replace />;
  if (!tenant) return <p className="text-muted-foreground">Carregando...</p>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Integrações</h1>
        <p className="text-muted-foreground">Credenciais das integrações utilizadas pelo atendimento</p>
      </div>

      <div className="glass-card p-5 space-y-3">
        <p className="text-sm text-muted-foreground">
          {!perm.editable && "Somente leitura — peça ao administrador para alterar."}
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>WhatsApp (UAZAPI URL)</Label>
            <Input disabled={!perm.editable} value={form.uazapi_url ?? ""}
              onChange={(e) => setForm({ ...form, uazapi_url: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label>WhatsApp (token)</Label>
            <Input type="password" disabled={!perm.editable} value={form.uazapi_token ?? ""}
              onChange={(e) => setForm({ ...form, uazapi_token: e.target.value })} />
          </div>
        </div>
        {perm.editable && (
          <Button onClick={() => save({ uazapi_url: form.uazapi_url, uazapi_token: form.uazapi_token }, "edit_integrations")}>
            <Save className="w-4 h-4 mr-2" />Salvar
          </Button>
        )}
      </div>
    </div>
  );
}
