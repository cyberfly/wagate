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
function markup(text: string, key = { n: 0 }): ReactNode[] {
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
      if (plain) out.push(plain), (plain = "");
      out.push(rule.tag(rule.inline ? inner : markup(inner, key), key.n++));
      i = end + m.length;
      continue outer;
    }
    plain += text[i++];
  }
  if (plain) out.push(plain);
  return out;
}
/** Opens a link in the system browser; the webview has no browser of its own. */
export function openExternal(url: string) {
  void request("/internal/open", "POST", { url }).catch(() => {});
}
export function formatText(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  const key = { n: 0 };
  for (const match of text.matchAll(link)) {
    const url = match[0];
    out.push(...markup(text.slice(last, match.index), key));
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
  out.push(...markup(text.slice(last), key));
  return out;
}
