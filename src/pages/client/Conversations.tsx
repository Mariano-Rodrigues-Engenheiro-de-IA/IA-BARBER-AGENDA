import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { useState, useMemo, useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Search, MessageCircle, Trash2, Loader2, Bot, BotOff, NotebookText } from "lucide-react";
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

// Hook: fetch profile image for a single phone via edge function, cached.
// O cache também é persistido em localStorage (24h) para que, ao reabrir o
// painel, as fotos apareçam na hora em vez de disparar uma chamada por
// contato de novo — era a principal causa de lentidão em Conversas.
const PIC_CACHE_KEY = "wa-pic-cache-v1";
const PIC_TTL = 24 * 60 * 60 * 1000;

type PicEntry = { img: string | null; at: number };

function readPicCache(): Record<string, PicEntry> {
  try {
    const raw = localStorage.getItem(PIC_CACHE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, PicEntry>) : {};
  } catch {
    return {};
  }
}

const imageCache = new Map<string, string | null>();
(() => {
  const now = Date.now();
  Object.entries(readPicCache()).forEach(([phone, e]) => {
    if (e && now - e.at < PIC_TTL) imageCache.set(phone, e.img);
  });
})();

function writePicCache(phone: string, img: string | null) {
  try {
    const all = readPicCache();
    all[phone] = { img, at: Date.now() };
    localStorage.setItem(PIC_CACHE_KEY, JSON.stringify(all));
  } catch {
    /* storage cheio/indisponível — cache em memória já basta */
  }
}

function useProfileImage(phone: string | null) {
  const { tenantId } = useAuth();
  const { data } = useQuery({
    queryKey: ["wa-pic", tenantId, phone],
    enabled: !!tenantId && !!phone && !imageCache.has(phone ?? ""),
    staleTime: PIC_TTL,
    gcTime: PIC_TTL,
    initialData: phone && imageCache.has(phone) ? (imageCache.get(phone) ?? null) : undefined,
    queryFn: async () => {
      if (!phone) return null;
      if (imageCache.has(phone)) return imageCache.get(phone) ?? null;
      const { data, error } = await supabase.functions.invoke("whatsapp-instance", {
        body: { action: "profile-image", number: phone },
      });
      if (error) {
        imageCache.set(phone, null);
        writePicCache(phone, null);
        return null;
      }
      const img = (data as any)?.image ?? null;
      imageCache.set(phone, img);
      writePicCache(phone, img);
      return img;
    },
  });
  return data ?? (phone ? imageCache.get(phone) ?? null : null);
}


function ContactAvatar({ phone, size }: { phone: string; size?: number }) {
  const img = useProfileImage(phone);
  return <Avatar phone={phone} size={size} image={img} />;
}



export default function ClientConversations() {
  const { tenantId } = useAuth();
  const queryClient = useQueryClient();
  const initialPhone = typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("phone")
    : null;
  const [selected, setSelected] = useState<string | null>(initialPhone);
  const [showSummary, setShowSummary] = useState(false);
  const [search, setSearch] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const messagesViewportRef = useRef<HTMLDivElement>(null);

  const handleDeleteConversation = async (phone: string) => {
    if (!tenantId || !phone) return;
    setDeleting(true);
    try {
      const { error: msgErr } = await supabase
        .from("chat_messages")
        .delete()
        .eq("tenant_id", tenantId)
        .eq("phone_number", phone);
      if (msgErr) throw msgErr;
      await supabase
        .from("conversation_state")
        .delete()
        .eq("tenant_id", tenantId)
        .eq("phone_number", phone);
      toast({ title: "Conversa excluída", description: phone });
      if (selected === phone) setSelected(null);
      setConfirmDelete(null);
      queryClient.invalidateQueries({ queryKey: ["client-contacts", tenantId] });
      queryClient.invalidateQueries({ queryKey: ["client-conv", tenantId, phone] });
    } catch (e: any) {
      toast({ title: "Erro ao excluir", description: e?.message ?? "Tente novamente", variant: "destructive" });
    } finally {
      setDeleting(false);
    }
  };

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
    // Volta instantâneo ao navegar entre abas em vez de recarregar do zero.
    staleTime: 10000,
    placeholderData: keepPreviousData,
  });

  const { data: conv } = useQuery({
    queryKey: ["client-conv", tenantId, selected],
    enabled: !!tenantId && !!selected,
    queryFn: async () => {
      // Antes buscávamos o histórico TODO em páginas de 1000 (várias
      // requisições sequenciais por conversa). Agora trazemos apenas as
      // últimas mensagens numa única requisição — é o que a tela exibe.
      const { data, error } = await supabase
        .from("chat_messages")
        .select("id,role,content,created_at")
        .eq("tenant_id", tenantId!)
        .eq("phone_number", selected!)
        .order("created_at", { ascending: false })
        .limit(400);
      if (error) return [];
      return (data ?? []).slice().reverse();
    },
    refetchInterval: 10000,
    staleTime: 5000,
    placeholderData: keepPreviousData,
  });


  const { data: leadSummary } = useQuery({
    queryKey: ["client-conv-summary", tenantId, selected],
    enabled: !!tenantId && !!selected,
    refetchInterval: 30000,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data } = await supabase
        .from("crm_leads")
        .select("ai_summary,ai_summary_updated_at,name")
        .eq("tenant_id", tenantId!)
        .eq("phone_number", selected!)
        .maybeSingle();
      return data as { ai_summary: string; ai_summary_updated_at: string | null; name: string | null } | null;
    },
  });

  // WhatsApp group IDs come with non-digit chars (@g.us) or length >= 14.
  // The AI doesn't reply to groups, so hide them from the panel.
  const isGroupPhone = (phone: string) => {
    if (!phone) return true;
    if (/[^0-9]/.test(phone)) return true;
    return phone.length >= 14;
  };

  const contacts = useMemo(() => {
    const m = new Map<string, { phone: string; last: string; preview: string; lastRole: string }>();
    (contactsRaw ?? []).forEach((x: any) => {
      if (isGroupPhone(x.phone_number)) return;
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

  // Per-conversation pause state
  const { data: pausesRaw } = useQuery({
    queryKey: ["client-conv-pauses", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data } = await supabase
        .from("conversation_pauses")
        .select("phone_number,paused")
        .eq("tenant_id", tenantId!);
      return data ?? [];
    },
    refetchInterval: 20000,
    placeholderData: keepPreviousData,
  });
  const pausedSet = useMemo(() => {
    const s = new Set<string>();
    (pausesRaw ?? []).forEach((p: any) => { if (p.paused) s.add(p.phone_number); });
    return s;
  }, [pausesRaw]);

  const toggleConvPause = async (phone: string) => {
    if (!tenantId || !phone) return;
    const isPaused = pausedSet.has(phone);
    const next = !isPaused;
    const { error } = await supabase
      .from("conversation_pauses")
      .upsert(
        { tenant_id: tenantId, phone_number: phone, paused: next, updated_at: new Date().toISOString() },
        { onConflict: "tenant_id,phone_number" },
      );
    if (error) {
      toast({ title: "Erro ao atualizar pausa", description: error.message, variant: "destructive" });
      return;
    }
    toast({ title: next ? "IA pausada nesta conversa" : "IA reativada nesta conversa", description: phone });
    queryClient.invalidateQueries({ queryKey: ["client-conv-pauses", tenantId] });
  };

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
      <div className="conversas-panel grid grid-cols-1 md:grid-cols-[360px_minmax(0,1fr)] gap-0 h-[calc(100vh-64px)] min-h-0 rounded-xl overflow-hidden border border-border shadow-lg bg-card">
        {/* Sidebar — contact list (WhatsApp-style panel) */}
        <div className="flex min-h-0 flex-col border-r border-border bg-[hsl(var(--wa-panel))]">
          <div className="p-3 border-b border-border">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Pesquisar ou começar nova conversa"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 rounded-full bg-background border-transparent focus-visible:ring-1"
              />
            </div>
          </div>
          <div className="subtle-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {contacts.map((c) => (
              <div
                key={c.phone}
                onClick={() => { setSelected(c.phone); setShowSummary(false); }}
                className={`group flex w-full cursor-pointer items-center gap-3 border-b border-border/30 px-3 py-3 text-left transition-colors hover:bg-muted/50 ${
                  selected === c.phone ? "bg-muted" : ""
                }`}
              >
                <ContactAvatar phone={c.phone} size={48} />

                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-baseline gap-2">
                    <span className="font-medium text-[15px] text-foreground truncate">{c.phone}</span>
                    <span className="text-[11px] text-muted-foreground shrink-0">{fmtTime(c.last)}</span>
                  </div>
                  <div className="flex items-center gap-1.5 min-w-0">
                    <div className="text-[13px] text-muted-foreground truncate flex-1">
                      {c.preview || "—"}
                    </div>
                    {pausedSet.has(c.phone) && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 shrink-0">
                        IA pausada
                      </span>
                    )}
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleConvPause(c.phone);
                  }}
                  className={`opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-md hover:bg-muted ${
                    pausedSet.has(c.phone) ? "text-amber-500" : "text-muted-foreground hover:text-foreground"
                  }`}
                  title={pausedSet.has(c.phone) ? "Reativar IA nesta conversa" : "Pausar IA nesta conversa"}
                  aria-label="Pausar IA"
                >
                  {pausedSet.has(c.phone) ? <BotOff className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmDelete(c.phone);
                  }}
                  className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                  title="Excluir conversa"
                  aria-label="Excluir conversa"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
            {contacts.length === 0 && (
              <div className="p-6 text-center text-sm text-muted-foreground">Nenhuma conversa.</div>
            )}
          </div>
        </div>

        {/* Chat panel */}
        <div className="wa-chat-area relative flex min-h-0 flex-col overflow-hidden bg-[hsl(var(--wa-chat-bg))]">
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

                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-[15px] text-foreground truncate flex items-center gap-2">
                    {selected}
                    {pausedSet.has(selected) && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400">
                        IA pausada
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">{conv?.length ?? 0} mensagens</div>
                </div>
                <Button
                  variant={pausedSet.has(selected) ? "default" : "ghost"}
                  size="sm"
                  onClick={() => toggleConvPause(selected)}
                  className={pausedSet.has(selected) ? "" : "text-muted-foreground"}
                  title={pausedSet.has(selected) ? "Reativar IA nesta conversa" : "Pausar IA nesta conversa"}
                >
                  {pausedSet.has(selected) ? (
                    <><BotOff className="w-4 h-4 mr-2" />Reativar IA</>
                  ) : (
                    <><Bot className="w-4 h-4 mr-2" />Pausar IA</>
                  )}
                </Button>
                <Button
                  variant={showSummary ? "default" : "ghost"}
                  size="sm"
                  onClick={() => setShowSummary((v) => !v)}
                  className={showSummary ? "" : "text-muted-foreground"}
                  title="Ver resumo da IA sobre este contato"
                >
                  <NotebookText className="w-4 h-4 mr-2" />Resumo
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmDelete(selected)}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="w-4 h-4 mr-2" />
                  Excluir
                </Button>
              </div>
              {showSummary && (
                <div className="px-4 py-2.5 border-b border-border bg-background/40">
                  <div className="max-w-3xl mx-auto flex gap-2 items-start">
                    <Bot className="w-3.5 h-3.5 mt-0.5 shrink-0 text-primary" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] font-medium text-foreground/80 mb-0.5">
                        Resumo da IA{leadSummary?.name ? ` — ${leadSummary.name}` : ""}
                      </div>
                      <div className="text-xs text-muted-foreground whitespace-pre-wrap line-clamp-3">
                        {leadSummary?.ai_summary || "Ainda não há resumo desta conversa."}
                      </div>
                    </div>
                  </div>
                </div>
              )}
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

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && !deleting && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir conversa?</AlertDialogTitle>
            <AlertDialogDescription>
              Todas as mensagens com <span className="font-medium text-foreground">{confirmDelete}</span> serão removidas permanentemente, junto com o estado da sessão da IA. Esta ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (confirmDelete) handleDeleteConversation(confirmDelete);
              }}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Trash2 className="w-4 h-4 mr-2" />}
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
