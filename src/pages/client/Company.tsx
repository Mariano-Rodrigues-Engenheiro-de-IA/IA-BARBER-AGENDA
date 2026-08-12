import { Navigate } from "react-router-dom";
import { useModulePermission } from "@/hooks/useAuth";
import { useClientTenant } from "@/hooks/useClientTenant";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Save } from "lucide-react";

/** Aba "Dados da empresa". */
export default function ClientCompany() {
  const perm = useModulePermission("company_data");
  const { tenant, form, setForm, save } = useClientTenant();

  if (!perm.visible) return <Navigate to="/app" replace />;
  if (!tenant) return <p className="text-muted-foreground">Carregando...</p>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Dados da empresa</h1>
        <p className="text-muted-foreground">Informações do seu negócio usadas no atendimento</p>
      </div>

      <div className="glass-card p-5 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Nome</Label>
          <Input disabled={!perm.editable} value={form.name ?? ""}
            onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="space-y-2">
          <Label>Telefone</Label>
          <Input disabled={!perm.editable} value={form.phone ?? ""}
            onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label>Endereço</Label>
          <Input disabled={!perm.editable} value={form.address ?? ""}
            onChange={(e) => setForm({ ...form, address: e.target.value })} />
        </div>
        {perm.editable && (
          <Button className="md:col-span-2 w-fit"
            onClick={() => save({ name: form.name, phone: form.phone, address: form.address }, "edit_company_data")}>
            <Save className="w-4 h-4 mr-2" />Salvar
          </Button>
        )}
      </div>
    </div>
  );
}
