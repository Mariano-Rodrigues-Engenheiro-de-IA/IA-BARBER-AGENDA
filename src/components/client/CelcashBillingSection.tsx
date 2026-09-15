import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Save, Send } from "lucide-react";
import { useCelcashBilling } from "@/hooks/useCelcashBilling";

function formatCents(cents: number | null | undefined) {
  if (!cents) return "—";
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return "—";
  const d = new Date(dateStr + "T00:00:00");
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("pt-BR");
}

function daysOverdueLabel(dateStr: string | null) {
  if (!dateStr) return null;
  const d = new Date(dateStr + "T00:00:00");
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - d.getTime()) / 86400000);
  if (days <= 0) return null;
  return days;
}

/** Seção "Cobrança automática" — só aparece se o tenant tiver celcash_enabled.
 * Configuração (mensagem, timing) + lista de quem está inadimplente com o
 * histórico de cobrança já enviada pra cada um. */
export function CelcashBillingSection({ tenantId, editable }: { tenantId: string; editable: boolean }) {
  const { config, overdueList, dispatchHistory, saveConfig, dispatchNow, error } = useCelcashBilling(tenantId);
  const [form, setForm] = useState(config);
  const [dispatching, setDispatching] = useState(false);

  useEffect(() => {
    if (config) setForm(config);
  }, [config]);

  if (error) {
    return (
      <div className="glass-card p-5 space-y-2 border-destructive/40">
        <h3 className="font-semibold text-destructive">Cobrança automática de inadimplentes</h3>
        <p className="text-sm text-muted-foreground">
          Não consegui carregar essa seção: {error.message}
        </p>
      </div>
    );
  }

  if (!form) return null;

  return (
    <div className="glass-card p-5 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-foreground">Cobrança automática de inadimplentes</h3>
          <p className="text-sm text-muted-foreground">
            Manda uma mensagem automática pelo WhatsApp pra quem está com a assinatura em atraso.
          </p>
        </div>
        <Switch
          checked={!!form.active}
          disabled={!editable}
          onCheckedChange={(checked) => setForm({ ...form, active: checked })}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-2 md:col-span-2">
          <Label>Mensagem</Label>
          <Textarea
            disabled={!editable}
            rows={3}
            value={form.message_template}
            onChange={(e) => setForm({ ...form, message_template: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">Use {"{nome}"} para incluir o primeiro nome do cliente.</p>
        </div>
        <div className="space-y-2">
          <Label>Disparar quantos dias depois do vencimento</Label>
          <Input
            type="number"
            min={0}
            disabled={!editable}
            value={form.days_after_due}
            onChange={(e) => setForm({ ...form, days_after_due: Number(e.target.value) || 0 })}
          />
        </div>
        <div className="space-y-2">
          <Label>Repetir a cada quantos dias (deixe em branco pra mandar só 1 vez)</Label>
          <Input
            type="number"
            min={1}
            disabled={!editable}
            value={form.repeat_every_days ?? ""}
            onChange={(e) =>
              setForm({ ...form, repeat_every_days: e.target.value ? Number(e.target.value) : null })
            }
          />
        </div>
      </div>

      {editable && (
        <div className="flex items-center gap-2">
          <Button
            onClick={() =>
              saveConfig({
                active: form.active,
                message_template: form.message_template,
                days_after_due: form.days_after_due,
                repeat_every_days: form.repeat_every_days,
              })
            }
          >
            <Save className="w-4 h-4 mr-2" />
            Salvar
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!form.active || dispatching}
            title={!form.active ? "Ative e salve a cobrança antes de disparar" : undefined}
            onClick={async () => {
              setDispatching(true);
              await dispatchNow();
              setDispatching(false);
            }}
          >
            <Send className="w-4 h-4 mr-2" />
            {dispatching ? "Disparando..." : "Cobrar agora"}
          </Button>
        </div>
      )}

      <div className="space-y-2">
        <h4 className="font-medium text-sm text-foreground">Inadimplentes ({overdueList.length})</h4>
        {overdueList.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum inadimplente encontrado no momento.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>Plano</TableHead>
                  <TableHead>Valor em atraso</TableHead>
                  <TableHead>Vencimento</TableHead>
                  <TableHead>Último disparo</TableHead>
                  <TableHead>Disparos recebidos</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {overdueList.map((sub) => {
                  const history = dispatchHistory.get(sub.celcash_customer_id);
                  const daysOverdue = daysOverdueLabel(sub.next_due_date);
                  return (
                    <TableRow key={sub.id}>
                      <TableCell className="font-medium text-foreground">{sub.name || "—"}</TableCell>
                      <TableCell className="text-foreground">{sub.plan_name || "—"}</TableCell>
                      <TableCell className="text-foreground">{formatCents(sub.overdue_amount_cents)}</TableCell>
                      <TableCell className="text-foreground">
                        {formatDate(sub.next_due_date)}
                        {daysOverdue != null && (
                          <Badge variant="destructive" className="ml-2">
                            {daysOverdue}d
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-foreground">{history ? formatDate(history.lastSentAt.slice(0, 10)) : "—"}</TableCell>
                      <TableCell className="text-foreground">{history?.count ?? 0}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}
