import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { useState, useMemo, useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Search, MessageCircle } from "lucide-react";

export default function ClientConversations() {
  const { tenantId } = useAuth();
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  // Fetch a wide window for contact list (latest activity per phone)
  const { data: contactsRaw } = useQuery({
    queryKey: ["client-contacts", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data } = await supabase
        .from("chat_messages")
        .select("phone_number,content,created_at,role")
        .eq("tenant_id", tenantId!)
        .order("created_at", { ascending: false })
        .limit(1000);
      return data ?? [];
    },
    refetchInterval: 15000,
  });

  // Fetch ALL messages for the selected conversation (no 1000 cap)
  const { data: conv } = useQuery({
    queryKey: ["client-conv", tenantId, selected],
    enabled: !!tenantId && !!selected,
    queryFn: async () => {
      const all: any[] = [];
      let from = 0;
      const pageSize = 1000;
      while (true) {
        const { data, error } = await supabase
          .from("chat_messages")
          .select("id,role,content,created_at")
          .eq("tenant_id", tenantId!)
          .eq("phone_number", selected!)
          .order("created_at", { ascending: true })
          .range(from, from + pageSize - 1);
        if (error) break;
        all.push(...(data ?? []));
        if (!data || data.length < pageSize) break;
        from += pageSize;
      }
      return all;
    },
    refetchInterval: 10000,
  });

  const contacts = useMemo(() => {
    const m = new Map<string, { phone: string; last: string; preview: string; lastRole: string }>();
    (contactsRaw ?? []).forEach((x: any) => {
      if (!m.has(x.phone_number)) {
        m.set(x.phone_number, {
          phone: x.phone_number,
          last: x.created_at,
          preview: (x.content ?? "").slice(0, 60),
          lastRole: x.role,
        });
      }
    });
    const list = Array.from(m.values()).sort((a, b) => +new Date(b.last) - +new Date(a.last));
    if (!search.trim()) return list;
    const s = search.toLowerCase();
    return list.filter((c) => c.phone.toLowerCase().includes(s) || c.preview.toLowerCase().includes(s));
  }, [contactsRaw, search]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conv?.length, selected]);

  const fmtTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  };
  const fmtDay = (iso: string) => {
    const d = new Date(iso);
    const today = new Date();
    const yest = new Date(); yest.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return "Hoje";
    if (d.toDateString() === yest.toDateString()) return "Ontem";
    return d.toLocaleDateString("pt-BR");
  };

  // Group messages by day for separators
  const grouped = useMemo(() => {
    const out: { day: string; items: any[] }[] = [];
    (conv ?? []).forEach((m: any) => {
      const day = fmtDay(m.created_at);
      if (!out.length || out[out.length - 1].day !== day) out.push({ day, items: [] });
      out[out.length - 1].items.push(m);
    });
    return out;
  }, [conv]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Conversas</h1>
        <p className="text-muted-foreground">Histórico completo de mensagens — IA, você e seu time</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[340px_1fr] gap-0 h-[78vh] rounded-xl overflow-hidden border border-border bg-card">
        {/* Sidebar — contact list */}
        <div className="flex flex-col border-r border-border bg-muted/20">
          <div className="p-3 border-b border-border bg-muted/30">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Buscar conversa..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 bg-background"
              />
            </div>
          </div>
          <ScrollArea className="flex-1">
            {contacts.map((c) => (
              <button
                key={c.phone}
                onClick={() => setSelected(c.phone)}
                className={`w-full text-left px-4 py-3 border-b border-border/50 hover:bg-muted/50 transition-colors flex gap-3 items-center ${
                  selected === c.phone ? "bg-muted" : ""
                }`}
              >
                <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center text-primary font-semibold shrink-0">
                  {c.phone.slice(-2)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-baseline gap-2">
                    <span className="font-medium text-sm text-foreground truncate">{c.phone}</span>
                    <span className="text-[10px] text-muted-foreground shrink-0">{fmtTime(c.last)}</span>
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {c.lastRole === "assistant" ? "✓ " : ""}
                    {c.preview}
                  </div>
                </div>
              </button>
            ))}
            {contacts.length === 0 && (
              <div className="p-6 text-center text-sm text-muted-foreground">Nenhuma conversa.</div>
            )}
          </ScrollArea>
        </div>

        {/* Chat panel */}
        <div className="flex flex-col bg-[hsl(var(--background))] relative overflow-hidden">
          {!selected && (
            <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-3">
              <MessageCircle className="w-16 h-16 opacity-30" />
              <p className="text-sm">Selecione uma conversa para ver as mensagens</p>
            </div>
          )}
          {selected && (
            <>
              <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center text-primary font-semibold">
                  {selected.slice(-2)}
                </div>
                <div>
                  <div className="font-semibold text-sm text-foreground">{selected}</div>
                  <div className="text-xs text-muted-foreground">{conv?.length ?? 0} mensagens</div>
                </div>
              </div>
              <ScrollArea className="flex-1 px-4 py-4">
                <div className="space-y-3 max-w-3xl mx-auto">
                  {grouped.map((g, gi) => (
                    <div key={gi} className="space-y-2">
                      <div className="flex justify-center">
                        <span className="text-[11px] px-3 py-1 rounded-full bg-muted text-muted-foreground">
                          {g.day}
                        </span>
                      </div>
                      {g.items.map((m: any) => {
                        const isOut = m.role === "assistant";
                        return (
                          <div key={m.id} className={`flex ${isOut ? "justify-end" : "justify-start"}`}>
                            <div
                              className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm shadow-sm ${
                                isOut
                                  ? "bg-primary text-primary-foreground rounded-tr-sm"
                                  : "bg-card border border-border text-foreground rounded-tl-sm"
                              }`}
                            >
                              <div className="whitespace-pre-wrap break-words">{m.content}</div>
                              <div
                                className={`text-[10px] mt-1 text-right ${
                                  isOut ? "text-primary-foreground/70" : "text-muted-foreground"
                                }`}
                              >
                                {fmtTime(m.created_at)}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                  <div ref={bottomRef} />
                </div>
              </ScrollArea>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
