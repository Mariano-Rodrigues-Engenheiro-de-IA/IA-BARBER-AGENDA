import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Trash2, ChevronUp, ChevronDown, Save, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";

interface Step {
  id?: string;
  step_order: number;
  delay_minutes: number;
  message: string;
}

interface Sequence {
  id?: string;
  tenant_id: string;
  name: string;
  trigger_type: string;
  trigger_config: { keywords: string[]; match_mode: "any" | "all" | "regex"; catch_all: boolean };
  business_hours: { enabled: boolean; start: string; end: string; timezone: string };
  enabled: boolean;
  follow_up_steps?: Step[];
}

const DEFAULT_STEPS: Step[] = [
  { step_order: 1, delay_minutes: 30, message: "Oi! Vi que você entrou em contato. Posso te ajudar com algo?" },
  { step_order: 2, delay_minutes: 60, message: "Tudo certo por aí? Se precisar de qualquer informação, é só me chamar 😊" },
  { step_order: 3, delay_minutes: 240, message: "Ainda tô por aqui caso queira agendar. Tem alguma dúvida?" },
  { step_order: 4, delay_minutes: 1440, message: "Última mensagem por aqui — qualquer coisa, é só responder! 👋" },
];

export function SequencesEditor({ tenantId }: { tenantId: string }) {
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("follow_up_sequences")
      .select("*, follow_up_steps(*)")
      .eq("tenant_id", tenantId)
      .order("created_at");
    if (error) toast.error("Erro ao carregar follow-ups");
    setSequences((data || []).map((s: any) => ({
      ...s,
      follow_up_steps: (s.follow_up_steps || []).sort((a: Step, b: Step) => a.step_order - b.step_order),
    })));
    setLoading(false);
  };


  useEffect(() => { if (tenantId) load(); }, [tenantId]);

  const addSequence = () => {
    setSequences((prev) => [...prev, {
      tenant_id: tenantId,
      name: "Tráfego pago — Primeiro contato",
      trigger_type: "first_contact_traffic",
      trigger_config: { keywords: [], match_mode: "any", catch_all: false },
      business_hours: { enabled: false, start: "08:00", end: "21:00", timezone: "America/Sao_Paulo" },
      enabled: true,
      follow_up_steps: DEFAULT_STEPS.map((s) => ({ ...s })),
    }]);
  };

  const updateSeq = (i: number, patch: Partial<Sequence>) => {
    setSequences((prev) => prev.map((s, idx) => idx === i ? { ...s, ...patch } : s));
  };

  const updateStep = (i: number, si: number, patch: Partial<Step>) => {
    setSequences((prev) => prev.map((s, idx) => {
      if (idx !== i) return s;
      const steps = [...(s.follow_up_steps || [])];
      steps[si] = { ...steps[si], ...patch };
      return { ...s, follow_up_steps: steps };
    }));
  };

  const moveStep = (i: number, si: number, dir: -1 | 1) => {
    setSequences((prev) => prev.map((s, idx) => {
      if (idx !== i) return s;
      const steps = [...(s.follow_up_steps || [])];
      const newIdx = si + dir;
      if (newIdx < 0 || newIdx >= steps.length) return s;
      [steps[si], steps[newIdx]] = [steps[newIdx], steps[si]];
      return { ...s, follow_up_steps: steps.map((st, k) => ({ ...st, step_order: k + 1 })) };
    }));
  };

  const addStep = (i: number) => {
    setSequences((prev) => prev.map((s, idx) => {
      if (idx !== i) return s;
      const steps = [...(s.follow_up_steps || [])];
      steps.push({ step_order: steps.length + 1, delay_minutes: 60, message: "" });
      return { ...s, follow_up_steps: steps };
    }));
  };

  const removeStep = (i: number, si: number) => {
    setSequences((prev) => prev.map((s, idx) => {
      if (idx !== i) return s;
      const steps = (s.follow_up_steps || []).filter((_, k) => k !== si).map((st, k) => ({ ...st, step_order: k + 1 }));
      return { ...s, follow_up_steps: steps };
    }));
  };

  const save = async (i: number) => {
    const seq = sequences[i];
    if (!seq.name.trim()) { toast.error("Dê um nome ao follow-up"); return; }
    if (!seq.follow_up_steps?.length) { toast.error("Adicione pelo menos uma etapa"); return; }
    if (seq.follow_up_steps.some((s) => !s.message.trim())) { toast.error("Preencha todas as mensagens"); return; }

    setSavingId(seq.id || `new-${i}`);
    try {
      let seqId = seq.id;
      const payload = {
        tenant_id: seq.tenant_id,
        name: seq.name,
        trigger_type: seq.trigger_type,
        trigger_config: seq.trigger_config,
        business_hours: seq.business_hours,
        enabled: seq.enabled,
      };
      if (seqId) {
        const { error } = await supabase.from("follow_up_sequences").update(payload).eq("id", seqId);
        if (error) throw error;
      } else {
        const { data, error } = await supabase.from("follow_up_sequences").insert(payload).select().single();
        if (error) throw error;
        seqId = data.id;
      }
      // Replace steps: delete all, reinsert
      await supabase.from("follow_up_steps").delete().eq("sequence_id", seqId);
      const { error: stepsErr } = await supabase.from("follow_up_steps").insert(
        seq.follow_up_steps.map((s) => ({
          sequence_id: seqId,
          step_order: s.step_order,
          delay_minutes: s.delay_minutes,
          message: s.message,
        }))
      );
      if (stepsErr) throw stepsErr;
      toast.success("Follow-up salvo!");
      await load();
    } catch (e: any) {
      toast.error(e.message || "Erro ao salvar");
    } finally {
      setSavingId(null);
    }
  };

  const remove = async (i: number) => {
    const seq = sequences[i];
    if (!confirm(`Excluir follow-up "${seq.name}"?`)) return;
    if (seq.id) {
      const { error } = await supabase.from("follow_up_sequences").delete().eq("id", seq.id);
      if (error) { toast.error("Erro ao excluir"); return; }
    }
    setSequences((prev) => prev.filter((_, idx) => idx !== i));
    toast.success("Excluído");
  };


  const remove = async (i: number) => {
    const seq = sequences[i];
    if (!confirm(`Excluir cadência "${seq.name}"?`)) return;
    if (seq.id) {
      const { error } = await supabase.from("follow_up_sequences").delete().eq("id", seq.id);
      if (error) { toast.error("Erro ao excluir"); return; }
    }
    setSequences((prev) => prev.filter((_, idx) => idx !== i));
    toast.success("Excluída");
  };

  if (loading) return <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" />Carregando...</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold flex items-center gap-2"><Sparkles className="w-5 h-5 text-primary" />Follow-ups personalizados</h3>
          <p className="text-sm text-muted-foreground">Sequências de mensagens automáticas para leads.</p>
        </div>
        <Button type="button" onClick={addSequence}><Plus className="w-4 h-4 mr-2" />Novo follow-up</Button>
      </div>

      {sequences.length === 0 && (
        <div className="glass-card p-8 text-center text-muted-foreground">
          Nenhum follow-up criado. Clique em "Novo follow-up" para começar.
        </div>
      )}


      {sequences.map((seq, i) => (
        <div key={seq.id || i} className="glass-card p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <Input value={seq.name} onChange={(e) => updateSeq(i, { name: e.target.value })} className="text-base font-semibold max-w-md" />
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2"><Switch checked={seq.enabled} onCheckedChange={(v) => updateSeq(i, { enabled: v })} /><span className="text-sm">Ativa</span></div>
              <Button type="button" variant="ghost" size="sm" onClick={() => remove(i)}><Trash2 className="w-4 h-4 text-destructive" /></Button>
            </div>
          </div>

          {/* Trigger */}
          <div className="space-y-3 p-4 rounded-md bg-muted/30">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Gatilho</Label>
            <div className="flex items-center gap-2">
              <Switch checked={seq.trigger_config.catch_all} onCheckedChange={(v) => updateSeq(i, { trigger_config: { ...seq.trigger_config, catch_all: v } })} />
              <span className="text-sm">Disparar em qualquer primeira mensagem (catch-all)</span>
            </div>
            {!seq.trigger_config.catch_all && (
              <div className="grid grid-cols-[1fr_140px] gap-2">
                <div>
                  <Label className="text-xs">Palavras-chave (separadas por vírgula)</Label>
                  <Input
                    placeholder="ex: vi o anúncio, instagram, quero saber mais"
                    value={seq.trigger_config.keywords.join(", ")}
                    onChange={(e) => updateSeq(i, { trigger_config: { ...seq.trigger_config, keywords: e.target.value.split(",").map((k) => k.trim()).filter(Boolean) } })}
                  />
                </div>
                <div>
                  <Label className="text-xs">Modo</Label>
                  <Select value={seq.trigger_config.match_mode} onValueChange={(v: any) => updateSeq(i, { trigger_config: { ...seq.trigger_config, match_mode: v } })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="any">Qualquer</SelectItem>
                      <SelectItem value="all">Todas</SelectItem>
                      <SelectItem value="regex">Regex</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
          </div>

          {/* Business hours */}
          <div className="space-y-2 p-4 rounded-md bg-muted/30">
            <div className="flex items-center gap-2">
              <Switch checked={seq.business_hours.enabled} onCheckedChange={(v) => updateSeq(i, { business_hours: { ...seq.business_hours, enabled: v } })} />
              <span className="text-sm font-medium">Respeitar horário comercial</span>
            </div>
            {seq.business_hours.enabled && (
              <div className="grid grid-cols-2 gap-2 max-w-sm">
                <div><Label className="text-xs">Início</Label><Input type="time" value={seq.business_hours.start} onChange={(e) => updateSeq(i, { business_hours: { ...seq.business_hours, start: e.target.value } })} /></div>
                <div><Label className="text-xs">Fim</Label><Input type="time" value={seq.business_hours.end} onChange={(e) => updateSeq(i, { business_hours: { ...seq.business_hours, end: e.target.value } })} /></div>
              </div>
            )}
          </div>

          {/* Steps */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Etapas ({seq.follow_up_steps?.length || 0})</Label>
              <Button type="button" size="sm" variant="outline" onClick={() => addStep(i)}><Plus className="w-3.5 h-3.5 mr-1" />Etapa</Button>
            </div>
            {seq.follow_up_steps?.map((step, si) => (
              <div key={si} className="border border-border rounded-md p-3 space-y-2 bg-background">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">Etapa {step.step_order}</span>
                  <div className="flex items-center gap-1">
                    <Button type="button" size="sm" variant="ghost" onClick={() => moveStep(i, si, -1)} disabled={si === 0}><ChevronUp className="w-3.5 h-3.5" /></Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => moveStep(i, si, 1)} disabled={si === (seq.follow_up_steps?.length || 0) - 1}><ChevronDown className="w-3.5 h-3.5" /></Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => removeStep(i, si)}><Trash2 className="w-3.5 h-3.5 text-destructive" /></Button>
                  </div>
                </div>
                <div className="grid grid-cols-[140px_1fr] gap-2 items-start">
                  <div>
                    <Label className="text-xs">Esperar (min)</Label>
                    <Input type="number" min={1} value={step.delay_minutes} onChange={(e) => updateStep(i, si, { delay_minutes: Number(e.target.value) || 1 })} />
                    <p className="text-[10px] text-muted-foreground mt-1">{step.delay_minutes >= 60 ? `≈ ${(step.delay_minutes / 60).toFixed(1)}h` : `${step.delay_minutes}min`} {si === 0 ? "após contato" : "após etapa anterior"}</p>
                  </div>
                  <div>
                    <Label className="text-xs">Mensagem</Label>
                    <Textarea rows={3} value={step.message} onChange={(e) => updateStep(i, si, { message: e.target.value })} placeholder="Texto da mensagem..." />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="flex justify-end">
            <Button type="button" onClick={() => save(i)} disabled={savingId !== null}>
              {savingId === (seq.id || `new-${i}`) ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
              Salvar follow-up
            </Button>
          </div>

        </div>
      ))}
    </div>
  );
}
