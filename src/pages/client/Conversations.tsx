import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useMemo, useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Search, MessageCircle, Trash2, Loader2 } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";

// Strip internal tags that should never be shown to end-user
function cleanContent(raw: string): string {
  if (!raw) return "";
  return raw
    .replace(/^\s*\[ATENDENTE HUMANO\]:\s*/i, "")
    .replace(/\[ATENDENTE HUMANO\]:\s*/gi, "")
    .trim();
}

function avatarInitials(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.slice(-2) || "??";
}

function Avatar({ phone, size = 48, image }: { phone: string; size?: number; image?: string | null }) {
  const [errored, setErrored] = useState(false);
  const showImg = image && !errored;
  return (
    <div
      className="rounded-full overflow-hidden flex items-center justify-center font-semibold shrink-0 select-none bg-primary text-primary-foreground"
      style={{ width: size, height: size, fontSize: size * 0.36 }}
    >
      {showImg ? (
        <img
          src={image!}
          alt=""
          className="w-full h-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setErrored(true)}
        />
      ) : (
        avatarInitials(phone)
      )}
    </div>
  );
}

// Hook: fetch profile image for a single phone via edge function, cached
const imageCache = new Map<string, string | null>();
function useProfileImage(phone: string | null) {
  const { tenantId } = useAuth();
  const { data } = useQuery({
    queryKey: ["wa-pic", tenantId, phone],
    enabled: !!tenantId && !!phone,
    staleTime: 30 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    queryFn: async () => {
      if (!phone) return null;
      if (imageCache.has(phone)) return imageCache.get(phone) ?? null;
      const { data, error } = await supabase.functions.invoke("whatsapp-instance", {
        body: { action: "profile-image", number: phone },
      });
      if (error) {
        imageCache.set(phone, null);
        return null;
      }
      const img = (data as any)?.image ?? null;
      imageCache.set(phone, img);
      return img;
    },
  });
  return data ?? null;
}

function ContactAvatar({ phone, size }: { phone: string; size?: number }) {
  const img = useProfileImage(phone);
  return <Avatar phone={phone} size={size} image={img} />;
}



export default function ClientConversations() {
  const { tenantId } = useAuth();
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const messagesViewportRef = useRef<HTMLDivElement>(null);

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
          preview: cleanContent(x.content ?? "").slice(0, 60),
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
    const viewport = messagesViewportRef.current;
    if (!viewport) return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
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

  const grouped = useMemo(() => {
    const all = (conv ?? []) as any[];
    // ---- Defensive dedup: hide [ATENDENTE HUMANO] messages that are just an
    // echo of an AI reply sent moments earlier (the webhook used to store both
    // the original AI message and the fromMe echo as separate rows).
    const ECHO_WINDOW_MS = 90_000;
    const normalize = (s: string) =>
      (s || "")
        .replace(/^\s*\[atendente humano\]:\s*/i, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    const recentAi: { t: number; text: string }[] = [];
    const visible = all.filter((m: any) => {
      const t = +new Date(m.created_at);
      const raw = m.content || "";
      const isHumanTagged = /^\s*\[ATENDENTE HUMANO\]:/i.test(raw);
      const norm = normalize(raw);
      if (m.role === "assistant" && isHumanTagged && norm) {
        const isEcho = recentAi.some(
          (r) =>
            Math.abs(t - r.t) <= ECHO_WINDOW_MS &&
            (r.text === norm || r.text.includes(norm) || norm.includes(r.text)),
        );
        if (isEcho) return false;
      }
      if (m.role === "assistant" && !isHumanTagged && norm) {
        recentAi.push({ t, text: norm });
        // keep list small
        if (recentAi.length > 20) recentAi.shift();
      }
      return true;
    });

    const out: { day: string; items: any[] }[] = [];
    visible.forEach((m: any) => {
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
        <p className="text-muted-foreground">Histórico completo de mensagens</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[360px_minmax(0,1fr)] gap-0 h-[78vh] min-h-0 rounded-xl overflow-hidden border border-border shadow-lg bg-card">
        {/* Sidebar — contact list (WhatsApp-style panel) */}
        <div className="flex min-h-0 flex-col border-r border-border bg-[hsl(var(--wa-panel))]">
          <div className="p-3 border-b border-border">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Pesquisar ou começar nova conversa"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 rounded-full bg-muted/40 border-transparent focus-visible:ring-1"
              />
            </div>
          </div>
          <div className="subtle-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {contacts.map((c) => (
              <button
                key={c.phone}
                onClick={() => setSelected(c.phone)}
                className={`flex w-full cursor-pointer items-center gap-3 border-b border-border/30 px-3 py-3 text-left transition-colors hover:bg-muted/50 ${
                  selected === c.phone ? "bg-muted" : ""
                }`}
              >
                <ContactAvatar phone={c.phone} size={48} />

                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-baseline gap-2">
                    <span className="font-medium text-[15px] text-foreground truncate">{c.phone}</span>
                    <span className="text-[11px] text-muted-foreground shrink-0">{fmtTime(c.last)}</span>
                  </div>
                  <div className="text-[13px] text-muted-foreground truncate">
                    {c.preview || "—"}
                  </div>
                </div>
              </button>
            ))}
            {contacts.length === 0 && (
              <div className="p-6 text-center text-sm text-muted-foreground">Nenhuma conversa.</div>
            )}
          </div>
        </div>

        {/* Chat panel */}
        <div className="relative flex min-h-0 flex-col overflow-hidden bg-[hsl(var(--wa-chat-bg))]">
          {!selected && (
            <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-3">
              <MessageCircle className="w-16 h-16 opacity-30" />
              <p className="text-sm">Selecione uma conversa para ver as mensagens</p>
            </div>
          )}
          {selected && (
            <>
              <div className="px-4 py-3 border-b border-border bg-[hsl(var(--wa-panel))] flex items-center gap-3">
                <ContactAvatar phone={selected} size={40} />

                <div>
                  <div className="font-semibold text-[15px] text-foreground">{selected}</div>
                  <div className="text-xs text-muted-foreground">{conv?.length ?? 0} mensagens</div>
                </div>
              </div>
              <div ref={messagesViewportRef} className="subtle-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
                <div className="space-y-2 max-w-3xl mx-auto">
                  {grouped.map((g, gi) => (
                    <div key={gi} className="space-y-1.5">
                      <div className="flex justify-center my-3">
                        <span className="text-[11px] px-3 py-1 rounded-md bg-[hsl(var(--wa-panel))] text-muted-foreground shadow-sm">
                          {g.day}
                        </span>
                      </div>
                      {g.items.map((m: any) => {
                        const isOut = m.role === "assistant";
                        const text = cleanContent(m.content);
                        return (
                          <div key={m.id} className={`flex ${isOut ? "justify-end" : "justify-start"}`}>
                            <div
                              className={`max-w-[70%] rounded-lg px-2.5 py-1.5 text-sm shadow-sm relative ${
                                isOut
                                  ? "bg-[hsl(var(--wa-bubble-out))] text-[hsl(var(--wa-bubble-out-fg))] rounded-tr-none"
                                  : "bg-[hsl(var(--wa-bubble-in))] text-[hsl(var(--wa-bubble-in-fg))] rounded-tl-none"
                              }`}
                            >
                              <div className="whitespace-pre-wrap break-words pr-12">{text}</div>
                              <div
                                className={`text-[10px] absolute bottom-1 right-2 ${
                                  isOut ? "text-[hsl(var(--wa-bubble-out-fg))]/70" : "text-muted-foreground"
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
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
