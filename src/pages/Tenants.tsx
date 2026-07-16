import { useState } from "react";
import { Link } from "react-router-dom";
import { useTenants, useDeleteTenant } from "@/hooks/useTenants";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Search, Trash2, Pencil, Building2, BarChart3, Lock, Globe } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export default function TenantsPage() {
  const { data: tenants, isLoading } = useTenants();
  const deleteTenant = useDeleteTenant();
  const [search, setSearch] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const filtered = tenants?.filter(
    (t) =>
      t.name.toLowerCase().includes(search.toLowerCase()) ||
      t.email?.toLowerCase().includes(search.toLowerCase())
  );

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      await deleteTenant.mutateAsync(deleteId);
      toast.success("Empresa removida com sucesso");
    } catch {
      toast.error("Erro ao remover empresa");
    }
    setDeleteId(null);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Empresas</h2>
          <p className="text-muted-foreground mt-1">
            Gerencie salões e barbearias cadastrados
          </p>
        </div>
        <Button asChild>
          <Link to="/tenants/new">
            <Plus className="w-4 h-4 mr-2" />
            Nova Empresa
          </Link>
        </Button>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Buscar por nome ou e-mail..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      <div className="glass-card overflow-hidden">
        {isLoading ? (
          <div className="p-6 space-y-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center justify-between">
                <div className="space-y-2">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-3 w-32" />
                </div>
                <Skeleton className="h-6 w-16 rounded-full" />
              </div>
            ))}
          </div>
        ) : !filtered?.length ? (
          <div className="p-12 text-center text-muted-foreground">
            <Building2 className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p>{search ? "Nenhum resultado encontrado" : "Nenhuma empresa cadastrada"}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Nome</th>
                  <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider hidden sm:table-cell">Contato</th>
                  <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                  <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider hidden md:table-cell">API</th>
                  <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider text-right">Ações</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((tenant, idx) => (
                  <tr
                    key={tenant.id}
                    className={`hover:bg-muted/30 transition-colors ${idx % 2 === 1 ? "bg-muted/10" : ""}`}
                  >
                    <td className="p-4">
                      <p className="font-medium text-foreground">{tenant.name}</p>
                      <p className="text-xs text-muted-foreground">{tenant.slug}</p>
                    </td>
                    <td className="p-4 text-sm text-muted-foreground hidden sm:table-cell">
                      {tenant.email || tenant.phone || "—"}
                    </td>
                    <td className="p-4">
                      <StatusBadge status={tenant.status} />
                    </td>
                    <td className="p-4 hidden md:table-cell">
                      {tenant.trinks_api_key ? (
                        <span className="text-xs text-accent">Configurado</span>
                      ) : (
                        <span className="text-xs text-muted-foreground">Pendente</span>
                      )}
                    </td>
                    <td className="p-4 text-right space-x-1">
                      <Button variant="ghost" size="icon" asChild title="Dashboard">
                        <Link to={`/tenants/${tenant.id}/dashboard`}>
                          <BarChart3 className="w-4 h-4" />
                        </Link>
                      </Button>
                      <Button variant="ghost" size="icon" asChild title="Editar">
                        <Link to={`/tenants/${tenant.id}`}>
                          <Pencil className="w-4 h-4" />
                        </Link>
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="hover:text-destructive"
                        onClick={() => setDeleteId(tenant.id)}
                        title="Excluir"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <AlertDialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmar exclusão</AlertDialogTitle>
            <AlertDialogDescription>
              Esta ação não pode ser desfeita. A empresa e todas as suas configurações serão removidas permanentemente.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { label: string; className: string }> = {
    active: { label: "Ativa", className: "bg-accent/10 text-accent" },
    inactive: { label: "Inativa", className: "bg-muted text-muted-foreground" },
    suspended: { label: "Suspensa", className: "bg-warning/10 text-warning" },
  };
  const c = config[status] ?? config.inactive;
  return (
    <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${c.className}`}>
      {c.label}
    </span>
  );
}
