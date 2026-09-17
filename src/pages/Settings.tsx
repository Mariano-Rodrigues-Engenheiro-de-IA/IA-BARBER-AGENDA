import { useTenants, useArchiveTenant } from "@/hooks/useTenants";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Archive, ArchiveRestore } from "lucide-react";
import { toast } from "sonner";

export default function SettingsPage() {
  const { data: tenants, isLoading } = useTenants();
  const archiveTenant = useArchiveTenant();
  const { can } = useAuth();

  const archived = tenants?.filter((t) => (t as any).archived) ?? [];

  const handleRestore = async (id: string) => {
    try {
      await archiveTenant.mutateAsync({ id, archived: false });
      toast.success("Empresa restaurada para a lista");
    } catch {
      toast.error("Erro ao desarquivar empresa");
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-foreground">Configurações</h2>
        <p className="text-muted-foreground mt-1">
          Configurações gerais da plataforma
        </p>
      </div>

      <div className="glass-card overflow-hidden">
        <div className="p-5 border-b border-border flex items-center gap-2">
          <Archive className="w-4 h-4 text-muted-foreground" />
          <div>
            <h3 className="font-semibold text-foreground">Empresas arquivadas</h3>
            <p className="text-sm text-muted-foreground">
              Empresas arquivadas ficam fora da lista principal. Desarquive para voltar a vê-las.
            </p>
          </div>
        </div>

        {isLoading ? (
          <div className="p-5 space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex items-center justify-between">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-8 w-28" />
              </div>
            ))}
          </div>
        ) : !archived.length ? (
          <div className="p-8 text-center text-muted-foreground">
            <Archive className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p>Nenhuma empresa arquivada</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {archived.map((tenant) => (
              <div key={tenant.id} className="p-4 flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <p className="font-medium text-foreground">{tenant.name}</p>
                  {(tenant as any).archived_at && (
                    <p className="text-xs text-muted-foreground">
                      Arquivada em {new Date((tenant as any).archived_at).toLocaleDateString("pt-BR")}
                    </p>
                  )}
                </div>
                {can("tenant-manage") && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleRestore(tenant.id)}
                    disabled={archiveTenant.isPending}
                  >
                    <ArchiveRestore className="w-4 h-4 mr-2" />
                    Desarquivar
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="glass-card p-8 text-center text-muted-foreground">
        <p>Em breve: configurações de integração WhatsApp, gestão de administradores e mais.</p>
      </div>
    </div>
  );
}
