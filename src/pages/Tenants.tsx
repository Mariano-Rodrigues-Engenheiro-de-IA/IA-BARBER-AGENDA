import { useState } from "react";
import { Link } from "react-router-dom";
import { useTenants, useDeleteTenant, useArchiveTenant } from "@/hooks/useTenants";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Search, Trash2, Pencil, Building2, BarChart3, Lock, Globe, Archive } from "lucide-react";
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
  const archiveTenant = useArchiveTenant();
  const { isAdmin } = useAuth();
  const [search, setSearch] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [archiveId, setArchiveId] = useState<string | null>(null);

  const archivedCount = tenants?.filter((t) => (t as any).archived).length ?? 0;

  const filtered = tenants
    ?.filter((t) => !(t as any).archived)
    .filter(
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

  const handleArchive = async () => {
    if (!archiveId) return;
    try {
      await archiveTenant.mutateAsync({ id: archiveId, archived: true });
      toast.success("Empresa arquivada. Você pode restaurá-la em Configurações.");
    } catch {
      toast.error("Erro ao arquivar empresa");
    }
    setArchiveId(null);
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

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative max-w-sm flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por nome ou e-mail..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        {isAdmin && archivedCount > 0 && (
          <Button variant="outline" asChild>
            <Link to="/settings">
              <Archive className="w-4 h-4 mr-2" />
              {archivedCount} arquivada{archivedCount > 1 ? "s" : ""}
            </Link>
          </Button>
        )}
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
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-foreground">{tenant.name}</p>
                        {(tenant as any).visibility === "general" ? (
                          <span title="Visível para todos os colaboradores" className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-accent/10 text-accent">
                            <Globe className="w-3 h-3" />geral
                          </span>
                        ) : (
                          <span title="Restrita: só admin e liberados enxergam" className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-muted text-muted-foreground">
                            <Lock className="w-3 h-3" />restrita
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="p-4">
                      <StatusBadge status={tenant.status} />
                    </td>
                    <td className="p-4 hidden md:table-cell">
                      <ApiBadge provider={(tenant as any).api_provider} />
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
                      {isAdmin && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setArchiveId(tenant.id)}
                          title="Arquivar"
                        >
                          <Archive className="w-4 h-4" />
                        </Button>
                      )}
                      {isAdmin && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="hover:text-destructive"
                          onClick={() => setDeleteId(tenant.id)}
                          title="Excluir"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      )}

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

function ApiBadge({ provider }: { provider?: string | null }) {
  const map: Record<string, { label: string; className: string }> = {
    trinks: { label: "Trinks", className: "bg-primary/10 text-primary" },
    onebeleza: { label: "OneBeleza", className: "bg-primary/10 text-primary" },
    bemp: { label: "Bemp", className: "bg-primary/10 text-primary" },
    appbarber: { label: "AppBarber", className: "bg-primary/10 text-primary" },
    frizzar: { label: "Frizzar", className: "bg-primary/10 text-primary" },
  };
  const c = provider ? map[provider] : null;
  if (!c) return <span className="text-xs text-muted-foreground">Nenhum</span>;
  return <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${c.className}`}>{c.label}</span>;
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
