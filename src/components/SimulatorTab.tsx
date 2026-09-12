import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Send, Trash2, Wrench } from "lucide-react";
import { toast } from "sonner";

type Msg = { role: "user" | "assistant"; content: string; toolCalls?: any[] };

export function SimulatorTab({ tenantId }: { tenantId: string }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    const next: Msg[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("whatsapp-webhook", {
        body: { tenantId, message: text, history },
        headers: { "x-mode": "simulator" },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      const response = (data as any)?.response || "(sem resposta)";
      const toolCalls = (data as any)?.toolCalls || [];
      setMessages([...next, { role: "assistant", content: response, toolCalls }]);
    } catch (e: any) {
      toast.error("Erro no simulador: " + (e?.message || e));
      setMessages(next);
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  };

  const clear = () => { setMessages([]); inputRef.current?.focus(); };

  return (
    <div className="conversas-panel p-5 flex flex-col gap-3 rounded-xl border border-border shadow-lg bg-card" style={{ height: "calc(100vh - 100px)" }}>
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Simulador da IA</h3>
        <Button variant="outline" size="sm" onClick={clear} disabled={loading || messages.length === 0}>
          <Trash2 className="w-4 h-4 mr-2" />Limpar
        </Button>
      </div>

      <div ref={scrollRef} className="wa-chat-area flex-1 overflow-y-auto rounded-md border border-border/40 p-3 bg-[hsl(var(--wa-chat-bg))] flex flex-col">
        <div className="flex-1 space-y-3">
          {messages.length === 0 && !loading && (
            <p className="text-sm text-muted-foreground text-center mt-8">
              Mande uma mensagem para começar a testar a IA.
            </p>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap shadow-sm ${
                m.role === "user"
                  ? "bg-[hsl(var(--wa-bubble-out))] text-[hsl(var(--wa-bubble-out-fg))]"
                  : "bg-[hsl(var(--wa-bubble-in))] text-[hsl(var(--wa-bubble-in-fg))]"
              }`}>
                {m.content}
                {m.toolCalls && m.toolCalls.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-border/30 space-y-1">
                    {m.toolCalls.map((tc: any, j: number) => (
                      <div key={j} className="text-[11px] flex items-center gap-1 opacity-80">
                        <Wrench className="w-3 h-3" />
                        <span className="font-mono">{tc.name || tc.tool || "tool"}</span>
                        {tc.simulated && <span className="text-amber-500">(simulada)</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex justify-start">
              <div className="bg-[hsl(var(--wa-bubble-in))] text-[hsl(var(--wa-bubble-in-fg))] rounded-lg px-3 py-2 text-sm flex items-center gap-2 shadow-sm">
                <Loader2 className="w-3 h-3 animate-spin" /> pensando...
              </div>
            </div>
          )}
        </div>

        {/* Campo de digitação flutuando por cima do papel de parede, como
            no WhatsApp real — não fica numa faixa separada fora dele. */}
        <div className="sticky bottom-0 pt-3 flex gap-2 items-center">
          <div className="flex-1 flex items-center rounded-full bg-white shadow-sm px-4 py-2">
            <Textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
              }}
              placeholder="Digite uma mensagem"
              rows={1}
              className="min-h-0 max-h-32 h-auto resize-none border-none bg-transparent shadow-none px-0 py-1.5 text-[13px] leading-tight focus-visible:ring-0 focus-visible:ring-offset-0"
              disabled={loading}
            />
          </div>
          <Button size="icon" className="rounded-full shrink-0" onClick={send} disabled={loading || !input.trim()}>
            <Send className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
