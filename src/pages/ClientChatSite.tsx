import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import { Send, Loader2, MessageCircle } from "lucide-react";

type Branding = {
  id: string;
  name: string;
  logo_url: string | null;
  banner_url: string | null;
  brand_color: string | null;
  theme: "light" | "dark";
  welcome_message: string | null;
  whatsapp_number: string | null;
};

type Msg = { role: string; content: string; created_at?: string };

const ENDPOINT = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/whatsapp-webhook`;

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!m) return null;
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

function timeLabel(iso?: string) {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

async function callWebChat(body: Record<string, unknown>) {
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-mode": "webchat",
        apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
      },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, data: await res.json().catch(() => ({} as any)) };
  } catch {
    return { ok: false, data: { error: "network_error" } as any };
  }
}

export default function ClientChatSite() {
  const { token } = useParams<{ token: string }>();
  const [branding, setBranding] = useState<Branding | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [escalated, setEscalated] = useState(false);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Trava o scroll do documento: a página inteira é o app, como no WhatsApp.
  useEffect(() => {
    const prevHtml = document.documentElement.style.overflow;
    const prevBody = document.body.style.overflow;
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    let meta = document.querySelector('meta[name="viewport"]') as HTMLMetaElement | null;
    const prevContent = meta?.content;
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "viewport";
      document.head.appendChild(meta);
    }
    meta.content = "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover";
    return () => {
      document.documentElement.style.overflow = prevHtml;
      document.body.style.overflow = prevBody;
      if (meta && prevContent) meta.content = prevContent;
    };
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!token) return;
      const { ok, data } = await callWebChat({ token, action: "init" });
      if (!active) return;
      if (!ok) {
        setLoadError(
          data?.error === "session_not_found"
            ? "Este link não é mais válido. Envie uma nova mensagem no WhatsApp para receber um link atualizado."
            : "Não conseguimos abrir o atendimento agora. Tente novamente em instantes.",
        );
      } else {
        setBranding(data.tenant);
        setMessages(Array.isArray(data.messages) ? data.messages : []);
        document.title = `${data.tenant?.name ?? "Atendimento"} — Atendimento online`;
      }
      setLoading(false);
    })();
    return () => { active = false; };
  }, [token]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    else bottomRef.current?.scrollIntoView();
  }, [messages, sending]);

  const rgb = useMemo(() => hexToRgb(branding?.brand_color || "") ?? [37, 211, 102], [branding]);
  const isLight = branding?.theme === "light";

  const styleVars = {
    ["--brand" as string]: `${rgb[0]} ${rgb[1]} ${rgb[2]}`,
  } as React.CSSProperties;

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending || !token) return;
    setInput("");
    if (taRef.current) taRef.current.style.height = "auto";
    setMessages((m) => [...m, { role: "user", content: text, created_at: new Date().toISOString() }]);
    setSending(true);
    const { ok, data } = await callWebChat({ token, action: "send", message: text });
    setSending(false);
    if (!ok) {
      setMessages((m) => [...m, { role: "assistant", content: "Tive um problema para responder agora. Pode tentar de novo?" }]);
      return;
    }
    if (data?.response) setMessages((m) => [...m, { role: "assistant", content: data.response, created_at: new Date().toISOString() }]);
    if (data?.escalated) setEscalated(true);
  }, [input, sending, token]);

  // Paleta estilo WhatsApp
  const pageBg = isLight ? "bg-[#e5ddd5]" : "bg-[#0b141a]";
  const headerBg = isLight ? "bg-[#f0f2f5] text-slate-900" : "bg-[#202c33] text-slate-100";
  const composerBg = isLight ? "bg-[#f0f2f5]" : "bg-[#202c33]";
  const inBubble = isLight ? "bg-white text-slate-800" : "bg-[#202c33] text-slate-100";
  const outBubble = isLight ? "bg-[#d9fdd3] text-slate-900" : "bg-[#005c4b] text-white";
  const inputBg = isLight
    ? "bg-white text-slate-900 placeholder:text-slate-400"
    : "bg-[#2a3942] text-slate-100 placeholder:text-slate-500";

  if (loading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-[#0b141a]">
        <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-[#0b141a] p-6 text-slate-200">
        <div className="max-w-sm space-y-3 text-center">
          <MessageCircle className="mx-auto h-8 w-8 text-slate-500" />
          <h1 className="text-lg font-semibold">Atendimento indisponível</h1>
          <p className="text-sm text-slate-400">{loadError}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`fixed inset-0 flex flex-col overflow-hidden ${pageBg}`} style={styleVars}>
      {/* Cabeçalho fixo estilo WhatsApp */}
      <header className={`flex shrink-0 items-center gap-3 px-3 py-2.5 shadow-sm ${headerBg}`} style={{ paddingTop: "max(0.625rem, env(safe-area-inset-top))" }}>
        <div className="h-10 w-10 shrink-0 overflow-hidden rounded-full bg-black/10">
          {branding?.logo_url ? (
            <img src={branding.logo_url} alt={`Logo ${branding?.name}`} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-sm font-bold text-white" style={{ background: `rgb(var(--brand))` }}>
              {branding?.name?.slice(0, 1) ?? "?"}
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[15px] font-semibold leading-tight">{branding?.name}</h1>
          <p className={`truncate text-[12px] ${isLight ? "text-slate-500" : "text-slate-400"}`}>
            {sending ? "digitando..." : "online"}
          </p>
        </div>
      </header>

      {/* Área de mensagens (único elemento com rolagem) */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-3 py-3 [touch-action:pan-y]"
        style={{
          backgroundImage: isLight
            ? "radial-gradient(rgba(0,0,0,0.045) 1px, transparent 1px)"
            : "radial-gradient(rgba(255,255,255,0.035) 1px, transparent 1px)",
          backgroundSize: "18px 18px",
        }}
      >
        <div className="mx-auto flex w-full min-w-0 max-w-2xl flex-col gap-1.5">
          {messages.length === 0 && (
            <div className={`self-start max-w-[85%] break-words rounded-lg rounded-tl-none px-3 py-2 text-[14.5px] leading-relaxed shadow-sm [overflow-wrap:anywhere] ${inBubble}`}>
              {branding?.welcome_message ||
                `Olá! 👋 Sou o atendimento digital da ${branding?.name ?? "empresa"}. Me diga o que você precisa que eu já te ajudo.`}
            </div>
          )}

          {messages.map((m, i) => {
            const isUser = m.role === "user";
            return (
              <div key={i} className={`flex min-w-0 ${isUser ? "justify-end" : "justify-start"}`}>
                <div
                  className={`relative max-w-[85%] min-w-0 break-words rounded-lg px-3 py-2 text-[14.5px] leading-relaxed shadow-sm [overflow-wrap:anywhere] ${
                    isUser ? `${outBubble} rounded-tr-none` : `${inBubble} rounded-tl-none`
                  }`}
                >
                  {isUser ? (
                    <span className="whitespace-pre-wrap">{m.content}</span>
                  ) : (
                    <div className="[&_a]:break-all [&_a]:underline [&_li]:ml-4 [&_li]:list-disc [&_p]:mb-2 [&_p:last-child]:mb-0 [&_pre]:overflow-x-auto [&_strong]:font-semibold">

                      <ReactMarkdown>{m.content}</ReactMarkdown>
                    </div>
                  )}
                  <span className={`mt-0.5 block text-right text-[10.5px] ${isUser ? "opacity-70" : "opacity-50"}`}>
                    {timeLabel(m.created_at)}
                  </span>
                </div>
              </div>
            );
          })}

          {sending && (
            <div className="flex justify-start">
              <div className={`flex items-center gap-1.5 rounded-lg rounded-tl-none px-3 py-3 shadow-sm ${inBubble}`}>
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current opacity-50 [animation-delay:-0.2s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current opacity-50 [animation-delay:-0.1s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current opacity-50" />
              </div>
            </div>
          )}

          {escalated && (
            <div className="my-2 self-center rounded-md bg-black/20 px-3 py-1.5 text-center text-[12px] text-slate-200">
              Um atendente vai continuar com você pelo WhatsApp em instantes 💬
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Composer fixo */}
      <div className={`shrink-0 px-2 py-2 ${composerBg}`} style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}>
        <form
          className="mx-auto flex w-full max-w-2xl items-end gap-2"
          onSubmit={(e) => { e.preventDefault(); void send(); }}
        >
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
            }}
            rows={1}
            placeholder="Mensagem"
            aria-label="Mensagem"
            className={`max-h-[120px] min-h-[42px] flex-1 resize-none rounded-3xl px-4 py-2.5 text-[15px] outline-none ${inputBg}`}
          />
          <button
            type="submit"
            disabled={sending || !input.trim()}
            aria-label="Enviar mensagem"
            className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-full text-white transition disabled:opacity-40"
            style={{ background: `rgb(var(--brand))` }}
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-[18px] w-[18px]" />}
          </button>
        </form>
      </div>
    </div>
  );
}
