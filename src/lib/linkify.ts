export type LinkPart = { type: "text" | "link"; value: string };

const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const TRAILING_PUNCT_RE = /[.,;:!?)\]}]+$/;

/**
 * Divide um texto em pedaços de texto puro e links http(s).
 * Pontuação colada ao final do link (ponto, vírgula, parêntese...) fica no texto.
 * Só reconhece http:// e https://; nada é interpretado como HTML.
 */
export function splitTextWithLinks(text: string): LinkPart[] {
  if (!text) return [];
  const parts: LinkPart[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    let url = match[0];
    const trailing = url.match(TRAILING_PUNCT_RE)?.[0] ?? "";
    if (trailing) url = url.slice(0, url.length - trailing.length);
    if (!/^https?:\/\/[^\s]+/i.test(url)) continue; // sobrou só o protocolo
    if (start > last) parts.push({ type: "text", value: text.slice(last, start) });
    parts.push({ type: "link", value: url });
    last = start + url.length;
  }
  if (last < text.length) parts.push({ type: "text", value: text.slice(last) });
  return parts;
}
