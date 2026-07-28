import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import { Send, Loader2, MessageCircle, ShieldCheck } from "lucide-react";

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
  const bottomRef = useRef<HTMLDivElement>(null);

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
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  const rgb = useMemo(() => hexToRgb(branding?.brand_color || "") ?? [59, 130, 246], [branding]);
  const isLight = branding?.theme === "light";

  const styleVars = {
    ["--brand" as string]: `${rgb[0]} ${rgb[1]} ${rgb[2]}`,
  } as React.CSSProperties;

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending || !token) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", content: text }]);
    setSending(true);
    const { ok, data } = await callWebChat({ token, action: "send", message: text });
    setSending(false);
    if (!ok) {
      setMessages((m) => [...m, { role: "assistant", content: "Tive um problema para responder agora. Pode tentar de novo?" }]);
      return;
    }
    if (data?.response) setMessages((m) => [...m, { role: "assistant", content: data.response }]);
    if (data?.escalated) setEscalated(true);
  }, [input, sending, token]);

  const shellClass = isLight
    ? "min-h-screen bg-[#f6f7f9] text-slate-900"
    : "min-h-screen bg-[#0b0f16] text-slate-100";
  const cardClass = isLight ? "bg-white border-slate-200" : "bg-white/5 border-white/10";
  const bubbleAssistant = isLight ? "bg-white border border-slate-200 text-slate-800" : "bg-white/[0.06] border border-white/10 text-slate-100";
  const inputClass = isLight
    ? "bg-white border-slate-200 text-slate-900 placeholder:text-slate-400"
    : "bg-white/[0.04] border-white/10 text-slate-100 placeholder:text-slate-500";

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0b0f16] flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="min-h-screen bg-[#0b0f16] text-slate-200 flex items-center justify-center p-6">
        <div className="max-w-sm text-center space-y-3">
          <MessageCircle className="w-8 h-8 mx-auto text-slate-500" />
          <h1 className="text-lg font-semibold">Atendimento indisponível</h1>
          <p className="text-sm text-slate-400">{loadError}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={shellClass} style={styleVars}>
      <div className="mx-auto flex min-h-screen w-full max-w-2xl flex-col">
        {/* Banner + cabeçalho da marca */}
        <header className="relative">
          {branding?.banner_url ? (
            <img src={branding.banner_url} alt={`Capa de ${branding?.name}`} className="h-32 w-full object-cover sm:h-40" />
          ) : (
            <div className="h-24 w-full sm:h-28" style={{ background: `linear-gradient(135deg, rgb(var(--brand)), rgb(var(--brand) / 0.45))` }} />
          )}
          <div className="flex items-center gap-3 px-4 pb-4 pt-3 sm:px-6">
            <div className="-mt-10 h-16 w-16 shrink-0 overflow-hidden rounded-2xl border-4 shadow-lg"
              style={{ borderColor: isLight ? "#fff" : "#0b0f16", background: isLight ? "#fff" : "#111827" }}>
              {branding?.logo_url ? (
                <img src={branding.logo_url} alt={`Logo ${branding?.name}`} className="h-full w-full object-contain" />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-xl font-bold" style={{ color: `rgb(var(--brand))` }}>
                  {branding?.name?.slice(0, 1) ?? "?"}
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-base font-semibold sm:text-lg">{branding?.name}</h1>
              <p className={`flex items-center gap-1.5 text-xs ${isLight ? "text-slate-500" : "text-slate-400"}`}>
                <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
                Atendimento online • responde na hora
              </p>
            </div>
          </div>
        </header>

        {/* Conversa */}
        <main className="flex-1 space-y-3 px-4 pb-4 sm:px-6">
          {messages.length === 0 && (
            <div className={`rounded-2xl border p-5 ${cardClass}`}>
              <p className="text-sm leading-relaxed">
                {branding?.welcome_message ||
                  `Olá! 👋 Sou o atendimento digital da ${branding?.name ?? "empresa"}. Me diga o serviço e o melhor dia que eu já verifico os horários disponíveis.`}
              </p>
            </div>
          )}

          {messages.map((m, i) => {
            const isUser = m.role === "user";
            return (
              <div key={i} className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${isUser ? "text-white" : bubbleAssistant}`}
                  style={isUser ? { background: `rgb(var(--brand))` } : undefined}
                >
                  {isUser ? (
                    <span className="whitespace-pre-wrap">{m.content}</span>
                  ) : (
                    <div className="[&_a]:underline [&_li]:ml-4 [&_li]:list-disc [&_p]:mb-2 [&_p:last-child]:mb-0 [&_strong]:font-semibold">
                      <ReactMarkdown>{m.content}</ReactMarkdown>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {sending && (
            <div className="flex justify-start">
              <div className={`flex items-center gap-2 rounded-2xl px-4 py-3 ${bubbleAssistant}`}>
                <span className="h-2 w-2 animate-bounce rounded-full bg-current [animation-delay:-0.2s] opacity-60" />
                <span className="h-2 w-2 animate-bounce rounded-full bg-current [animation-delay:-0.1s] opacity-60" />
                <span className="h-2 w-2 animate-bounce rounded-full bg-current opacity-60" />
              </div>
            </div>
          )}

          {escalated && (
            <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-600 dark:text-emerald-300">
              Vou te chamar pelo WhatsApp em instantes — pode fechar esta página, um atendente continua o
              atendimento por lá. 💬
            </div>
          )}
          <div ref={bottomRef} />
        </main>

        {/* Composer */}
        <footer className={`sticky bottom-0 border-t px-4 py-3 backdrop-blur sm:px-6 ${isLight ? "border-slate-200 bg-white/80" : "border-white/10 bg-[#0b0f16]/85"}`}>
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => { e.preventDefault(); void send(); }}
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
              }}
              rows={1}
              placeholder="Escreva sua mensagem..."
              aria-label="Mensagem"
              className={`max-h-32 min-h-[44px] flex-1 resize-none rounded-2xl border px-4 py-3 text-sm outline-none transition focus:ring-2 ${inputClass}`}
              style={{ ["--tw-ring-color" as string]: `rgb(var(--brand) / 0.5)` }}
            />
            <button
              type="submit"
              disabled={sending || !input.trim()}
              aria-label="Enviar mensagem"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-white transition disabled:opacity-40"
              style={{ background: `rgb(var(--brand))` }}
            >
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </button>
          </form>
          <p className={`mt-2 flex items-center justify-center gap-1.5 text-[11px] ${isLight ? "text-slate-400" : "text-slate-500"}`}>
            <ShieldCheck className="h-3 w-3" /> Conversa privada com {branding?.name}
          </p>
        </footer>
      </div>
    </div>
  );
}
