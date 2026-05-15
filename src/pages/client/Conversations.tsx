import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import { Input } from "@/components/ui/input";

export default function ClientConversations() {
  const { tenantId } = useAuth();
  const [selected, setSelected] = useState<string | null>(null);

  const { data: msgs } = useQuery({
    queryKey: ["client-msgs", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data } = await supabase.from("chat_messages")
        .select("id,phone_number,role,content,created_at")
        .eq("tenant_id", tenantId!).order("created_at", { ascending: false }).limit(500);
      return data ?? [];
    },
  });

  const phones = useMemo(() => {
    const m = new Map<string, { phone: string; last: string; preview: string }>();
    (msgs ?? []).forEach((x: any) => {
      if (!m.has(x.phone_number)) m.set(x.phone_number, { phone: x.phone_number, last: x.created_at, preview: x.content?.slice(0, 60) ?? "" });
    });
    return Array.from(m.values());
  }, [msgs]);

  const conv = useMemo(() => (msgs ?? []).filter((m: any) => m.phone_number === selected).reverse(), [msgs, selected]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Conversas</h1>
        <p className="text-muted-foreground">Histórico de mensagens trocadas com seus clientes</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 h-[70vh]">
        <div className="glass-card p-3 overflow-auto md:col-span-1">
          {phones.map((p) => (
            <button key={p.phone}
              onClick={() => setSelected(p.phone)}
              className={`w-full text-left p-3 rounded-lg mb-1 hover:bg-muted ${selected === p.phone ? "bg-muted" : ""}`}>
              <div className="font-medium text-sm text-foreground">{p.phone}</div>
              <div className="text-xs text-muted-foreground truncate">{p.preview}</div>
            </button>
          ))}
          {phones.length === 0 && <p className="text-sm text-muted-foreground p-3">Nenhuma conversa ainda.</p>}
        </div>
        <div className="glass-card p-4 overflow-auto md:col-span-2">
          {!selected && <p className="text-sm text-muted-foreground">Selecione uma conversa.</p>}
          {selected && conv.map((m: any) => (
            <div key={m.id} className={`mb-2 flex ${m.role === "assistant" ? "justify-start" : "justify-end"}`}>
              <div className={`max-w-[80%] rounded-lg p-2 text-sm ${m.role === "assistant" ? "bg-primary/10 text-foreground" : "bg-muted text-foreground"}`}>
                {m.content}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
