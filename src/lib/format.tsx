import type { ReactNode } from "react";
import { request } from "./api";
// WhatsApp's markup: ```code```, `inline`, *bold*, _italic_, ~strike~. A
// marker only counts next to a word boundary, so "2*3*4" or snake_case stay
// as typed. Links are found first, so markup characters in a URL stay put.
const link = /\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]'’]/gi;
const rules: { open: string; tag: (inner: ReactNode, key: number) => ReactNode; inline?: boolean }[] = [
  { open: "```", tag: (c, k) => <code key={k} className="md-block">{c}</code>, inline: true },
  { open: "`", tag: (c, k) => <code key={k}>{c}</code>, inline: true },
  { open: "*", tag: (c, k) => <strong key={k}>{c}</strong> },
  { open: "_", tag: (c, k) => <em key={k}>{c}</em> },
  { open: "~", tag: (c, k) => <s key={k}>{c}</s> },
];
const boundary = (ch: string | undefined) => !ch || /[\s\p{P}\p{S}]/u.test(ch);
/** Mentioned people by the number the text names them with, as `@<number>`. */
type Mentions = Map<string, string>;
/** Plain text with `@<number>` mentions shown as the person's name. */
function plainText(text: string, mentions: Mentions, key: { n: number }): ReactNode[] {
  if (!mentions.size) return [text];
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(/@(\d{5,20})/g)) {
    const name = mentions.get(match[1]!);
    if (!name) continue;
    if (match.index! > last) out.push(text.slice(last, match.index));
    out.push(<span key={"m" + key.n++} className="mention">@{name}</span>);
    last = match.index! + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
function markup(text: string, key = { n: 0 }, mentions: Mentions = new Map()): ReactNode[] {
  const out: ReactNode[] = [];
  let plain = "";
  let i = 0;
  outer: while (i < text.length) {
    for (const rule of rules) {
      const m = rule.open;
      if (!text.startsWith(m, i) || !boundary(text[i - 1])) continue;
      // Inline code and code blocks may span lines; the others stay on one.
      const end = text.indexOf(m, i + m.length + 1);
      if (end < 0) continue;
      const inner = text.slice(i + m.length, end);
      if (!inner.trim() || /^\s|\s$/.test(inner) || (!rule.inline && inner.includes("\n"))) continue;
      if (!boundary(text[end + m.length]) || text[end + m.length] === m[0]) continue;
      if (plain) out.push(...plainText(plain, mentions, key)), (plain = "");
      out.push(rule.tag(rule.inline ? inner : markup(inner, key, mentions), key.n++));
      i = end + m.length;
      continue outer;
    }
    plain += text[i++];
  }
  if (plain) out.push(...plainText(plain, mentions, key));
  return out;
}
/** Opens a link in the system browser; the webview has no browser of its own. */
export function openExternal(url: string) {
  void request("/internal/open", "POST", { url }).catch(() => {});
}
export function formatText(
  text: string,
  mentioned: { id: string; name?: string | null }[] = [],
): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  const key = { n: 0 };
  const mentions: Mentions = new Map(
    mentioned.map((m) => {
      const number = m.id.split("@")[0]!;
      return [number, m.name || (m.id.endsWith("@s.whatsapp.net") ? "+" + number : number)];
    }),
  );
  for (const match of text.matchAll(link)) {
    const url = match[0];
    out.push(...markup(text.slice(last, match.index), key, mentions));
    out.push(
      <a
        key={"l" + key.n++}
        href={url}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          openExternal(url);
        }}
      >
        {url}
      </a>,
    );
    last = match.index! + url.length;
  }
  out.push(...markup(text.slice(last), key, mentions));
  return out;
}
