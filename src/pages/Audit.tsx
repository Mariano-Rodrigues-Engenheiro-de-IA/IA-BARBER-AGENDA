import MetaCostPanel from "@/components/MetaCostPanel";

export default function AuditPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Auditoria</h1>
        <p className="text-muted-foreground">Custo estimado da API Oficial Meta</p>
      </div>

      <MetaCostPanel />
    </div>
  );
}
