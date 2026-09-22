import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Save, Wifi } from "lucide-react";
import { usePlatformConnectionAlert } from "@/hooks/usePlatformConnectionAlert";

/** Aviso ao dono da PLATAFORMA (Mariano) quando a conexão do WhatsApp
 * de QUALQUER cliente cai ou volta — configuração global, única, no
 * painel admin (não é por cliente). Verificação automática roda a
 * cada 5 minutos (monitor-whatsapp-connection), dispara só quando o
 * status realmente muda. */
export function PlatformConnectionAlertSection() {
  const { config, saveConfig } = usePlatformConnectionAlert();
  const [form, setForm] = useState(config);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (config) setForm(config);
  }, [config]);

  if (!form) return null;

  return (
    <div className="glass-card overflow-hidden">
      <div className="p-5 border-b border-border flex items-center gap-2">
        <Wifi className="w-4 h-4 text-muted-foreground" />
        <div className="flex-1">
          <h3 className="font-semibold text-foreground">Lembrete de conexão</h3>
          <p className="text-sm text-muted-foreground">
            Avisa você quando o WhatsApp de qualquer cliente conectar ou
            desconectar — verificado a cada 5 minutos.
          </p>
        </div>
        <Switch
          checked={form.active}
          onCheckedChange={(v) => setForm({ ...form, active: v })}
        />
      </div>

      <div className="p-5 space-y-4">
        <div className="space-y-2">
          <Label>Seu número (com DDI, ex: 5521999999999)</Label>
          <Input
            type="text"
            value={form.owner_phone_e164 ?? ""}
            onChange={(e) =>
              setForm({ ...form, owner_phone_e164: e.target.value || null })
            }
          />
        </div>
        <div className="space-y-2">
          <Label>Mensagem quando um cliente reconectar</Label>
          <Textarea
            rows={2}
            value={form.connected_message_template}
            onChange={(e) =>
              setForm({ ...form, connected_message_template: e.target.value })
            }
          />
          <p className="text-xs text-muted-foreground">
            Use {"{empresa}"} pra incluir o nome do cliente.
          </p>
        </div>
        <div className="space-y-2">
          <Label>Mensagem quando um cliente desconectar</Label>
          <Textarea
            rows={2}
            value={form.disconnected_message_template}
            onChange={(e) =>
              setForm({
                ...form,
                disconnected_message_template: e.target.value,
              })
            }
          />
          <p className="text-xs text-muted-foreground">
            Use {"{empresa}"} pra incluir o nome do cliente.
          </p>
        </div>
        <Button
          type="button"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            await saveConfig({
              active: form.active,
              owner_phone_e164: form.owner_phone_e164,
              connected_message_template: form.connected_message_template,
              disconnected_message_template: form.disconnected_message_template,
            });
            setSaving(false);
          }}
        >
          <Save className="w-4 h-4 mr-2" />
          Salvar
        </Button>
      </div>
    </div>
  );
}
