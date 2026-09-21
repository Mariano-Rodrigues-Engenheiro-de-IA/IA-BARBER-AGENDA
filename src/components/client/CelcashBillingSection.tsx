import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Save, Send, RefreshCw } from "lucide-react";
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

function isDueToday(dateStr: string | null) {
  if (!dateStr) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().slice(0, 10);
  return dateStr === todayStr;
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
 * 2 disparos independentes (vence hoje / atrasados), cada um com seu
 * próprio liga/desliga e mensagem, + lista de inadimplentes com histórico. */
export function CelcashBillingSection({ tenantId, editable }: { tenantId: string; editable: boolean }) {
  const { config, overdueList, dispatchHistory, saveConfig, dispatchNow, syncNow, error } = useCelcashBilling(tenantId);
  const [form, setForm] = useState(config);
  const [dispatching, setDispatching] = useState(false);
  const [syncing, setSyncing] = useState(false);

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
    <div className="space-y-4">
      {/* ===== Lembrete de vencimento no dia ===== */}
      <div className="glass-card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-foreground">Lembrete de vencimento no dia</h3>
            <p className="text-sm text-muted-foreground">
              Manda uma mensagem só pra quem vence exatamente hoje, antes de virar atraso.
            </p>
          </div>
          <Switch
            checked={!!form.due_today_active}
            disabled={!editable}
            onCheckedChange={(checked) => setForm({ ...form, due_today_active: checked })}
          />
        </div>
        <div className="space-y-2">
          <Label>Mensagem (com cartão cadastrado)</Label>
          <Textarea
            disabled={!editable}
            rows={3}
            value={form.due_today_message_template}
            onChange={(e) => setForm({ ...form, due_today_message_template: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">Use {"{nome}"}, {"{vencimento}"} e {"{valor}"} para incluir o primeiro nome, a data de vencimento e o valor em atraso.</p>
        </div>
        <div className="space-y-2">
          <Label>Mensagem (sem cartão cadastrado)</Label>
          <Textarea
            disabled={!editable}
            rows={3}
            value={form.due_today_no_card_message_template}
            onChange={(e) => setForm({ ...form, due_today_no_card_message_template: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">Usada no lugar da mensagem acima quando o cliente não tem cartão cadastrado.</p>
        </div>
      </div>

      {/* ===== Cobrança de atrasados ===== */}
      <div className="glass-card p-5 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-foreground">Cobrança de atrasados</h3>
            <p className="text-sm text-muted-foreground">
              Manda uma mensagem automática pra quem já está com a assinatura em atraso (exceto quem vence hoje, esses recebem só o lembrete acima).
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
            <Label>Mensagem (com cartão cadastrado)</Label>
            <Textarea
              disabled={!editable}
              rows={3}
              value={form.message_template}
              onChange={(e) => setForm({ ...form, message_template: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">Use {"{nome}"}, {"{vencimento}"} e {"{valor}"} para incluir o primeiro nome, a data de vencimento e o valor em atraso.</p>
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label>Mensagem (sem cartão cadastrado)</Label>
            <Textarea
              disabled={!editable}
              rows={3}
              value={form.no_card_message_template}
              onChange={(e) => setForm({ ...form, no_card_message_template: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">Usada no lugar da mensagem acima quando o cliente não tem cartão cadastrado.</p>
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
          <div className="space-y-2 md:col-span-2">
            <Label>Cobrar inadimplentes dos últimos quantos dias (deixe em branco pra não ter limite)</Label>
            <Input
              type="number"
              min={1}
              disabled={!editable}
              value={form.overdue_max_days ?? ""}
              onChange={(e) =>
                setForm({ ...form, overdue_max_days: e.target.value ? Number(e.target.value) : null })
              }
            />
          </div>
          <div className="space-y-2">
            <Label>Máximo de cobranças por dívida</Label>
            <Input
              type="number"
              min={1}
              disabled={!editable}
              value={form.max_overdue_messages}
              onChange={(e) => setForm({ ...form, max_overdue_messages: Number(e.target.value) || 1 })}
            />
            <p className="text-xs text-muted-foreground">Depois desse número de mensagens pra mesma dívida, para de insistir automaticamente.</p>
          </div>
        </div>
      </div>

      {/* ===== Aviso ao dono (cliente bateu X dias de atraso) ===== */}
      <div className="glass-card p-5 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-foreground">Aviso ao dono</h3>
            <p className="text-sm text-muted-foreground">
              Manda uma mensagem pra você (não pro cliente) quando um assinante bate o limite de dias em atraso configurado abaixo. Manda só 1 vez por dívida.
            </p>
          </div>
          <Switch
            checked={!!form.owner_alert_active}
            disabled={!editable}
            onCheckedChange={(checked) => setForm({ ...form, owner_alert_active: checked })}
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2 md:col-span-2">
            <Label>Mensagem</Label>
            <Textarea
              disabled={!editable}
              rows={3}
              value={form.owner_alert_message_template}
              onChange={(e) => setForm({ ...form, owner_alert_message_template: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">Use {"{nome}"}, {"{dias_atraso}"} e {"{valor}"} para incluir o primeiro nome do cliente, os dias em atraso e o valor devido.</p>
          </div>
          <div className="space-y-2">
            <Label>Avisar a partir de quantos dias em atraso</Label>
            <Input
              type="number"
              min={1}
              disabled={!editable}
              value={form.owner_alert_days}
              onChange={(e) => setForm({ ...form, owner_alert_days: Number(e.target.value) || 0 })}
            />
          </div>
          <div className="space-y-2">
            <Label>Seu número de WhatsApp (com DDI, ex: 5511999999999)</Label>
            <Input
              type="text"
              disabled={!editable}
              value={form.owner_alert_phone_e164 ?? ""}
              onChange={(e) => setForm({ ...form, owner_alert_phone_e164: e.target.value || null })}
            />
          </div>
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
                due_today_active: form.due_today_active,
                due_today_message_template: form.due_today_message_template,
                due_today_no_card_message_template: form.due_today_no_card_message_template,
                overdue_max_days: form.overdue_max_days,
                owner_alert_active: form.owner_alert_active,
                owner_alert_days: form.owner_alert_days,
                owner_alert_phone_e164: form.owner_alert_phone_e164,
                owner_alert_message_template: form.owner_alert_message_template,
                max_overdue_messages: form.max_overdue_messages,
                no_card_message_template: form.no_card_message_template,
              })
            }
          >
            <Save className="w-4 h-4 mr-2" />
            Salvar
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={(!form.active && !form.due_today_active && !form.owner_alert_active) || dispatching}
            title={!form.active && !form.due_today_active && !form.owner_alert_active ? "Ative pelo menos um dos disparos e salve antes" : undefined}
            onClick={async () => {
              setDispatching(true);
              await dispatchNow();
              setDispatching(false);
            }}
          >
            <Send className="w-4 h-4 mr-2" />
            {dispatching ? "Disparando..." : "Disparar agora"}
          </Button>
        </div>
      )}

      <div className="glass-card p-5 space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="font-medium text-sm text-foreground">Inadimplentes ({overdueList.length})</h4>
          {editable && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={syncing}
              onClick={async () => {
                setSyncing(true);
                await syncNow();
                setSyncing(false);
              }}
            >
              <RefreshCw className={`w-4 h-4 mr-2 ${syncing ? "animate-spin" : ""}`} />
              {syncing ? "Sincronizando..." : "Sincronizar agora"}
            </Button>
          )}
        </div>
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
                  const dueToday = isDueToday(sub.next_due_date);
                  return (
                    <TableRow key={sub.id}>
                      <TableCell className="font-medium text-foreground">
                        {sub.name || "—"}
                        {sub.no_card_on_file && (
                          <Badge variant="outline" className="ml-2 border-blue-300 bg-blue-50 text-blue-700">Sem cartão</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-foreground">{sub.plan_name || "—"}</TableCell>
                      <TableCell className="text-foreground">{formatCents(sub.overdue_amount_cents)}</TableCell>
                      <TableCell className="text-foreground">
                        {dueToday ? (
                          <Badge variant="default">Hoje</Badge>
                        ) : (
                          <>
                            {formatDate(sub.next_due_date)}
                            {daysOverdue != null && (
                              <Badge variant="destructive" className="ml-2">
                                {daysOverdue}d
                              </Badge>
                            )}
                          </>
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
