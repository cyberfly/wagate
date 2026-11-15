import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
/** What a web page says about itself, for the preview shown under a link. */
export interface PagePreview {
  url: string;
  title: string;
  description?: string;
  /** The page's picture, as the site serves it. */
  image?: { mimetype: string; data: Uint8Array };
}
export interface PreviewOptions {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** The addresses a host name leads to. */
  resolve?: (host: string) => Promise<string[]>;
}
const maxPage = 512 * 1024,
  maxImage = 3 * 1024 * 1024;
/** Loopback, private and link-local addresses: never fetched for a preview. */
export function privateAddress(ip: string) {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const v6 = ip.toLowerCase();
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}
/** An http(s) address on the public internet, or an error. */
async function publicUrl(value: string, resolve: NonNullable<PreviewOptions["resolve"]>) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid link");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Invalid link");
  if (url.username || url.password) throw new Error("Invalid link");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || /\.(localhost|local|internal|lan|home|test)$/.test(host))
    throw new Error("Invalid link");
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => [] as string[]);
  if (!addresses.length || addresses.some(privateAddress)) throw new Error("Invalid link");
  return url;
}
/** Follows redirects by hand, so each hop is checked like the first address. */
async function get(start: string, accept: string, o: Required<PreviewOptions>) {
  let url = await publicUrl(start, o.resolve);
  for (let hop = 0; hop < 5; hop++) {
    const response = await o.fetch(url.href, {
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
      headers: {
        Accept: accept,
        "Accept-Language": "en",
        // Many sites only describe themselves to a client that says it previews links.
        "User-Agent": "Mozilla/5.0 (compatible; LinkPreview/1.0)",
      },
    });
    const next = response.status >= 300 && response.status < 400 && response.headers.get("location");
    if (!next) return { response, url };
    await response.body?.cancel().catch(() => {});
    url = await publicUrl(new URL(next, url).href, o.resolve);
  }
  throw new Error("Too many redirects");
}
/** The start of a response body, up to `max` bytes. */
async function read(response: Response, max: number, strict = false) {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  if (size >= max) {
    await reader.cancel().catch(() => {});
    if (strict) return null;
  }
  return new Uint8Array(Buffer.concat(chunks).subarray(0, max));
}
const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decode(text: string) {
  return text
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
      if (code[0] !== "#") return entities[code.toLowerCase()] ?? whole;
      const point = code[1]!.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      try {
        return String.fromCodePoint(point);
      } catch {
        return whole;
      }
    })
    .replace(/\s+/g, " ")
    .trim();
}
/** `<meta>` values by their `property` or `name`, first one wins. */
function metaTags(html: string) {
  const found = new Map<string, string>();
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attr = (name: string) =>
      tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
    const key = attr("property") ?? attr("name"),
      content = attr("content");
    if (!key || !content) continue;
    const name = (key[2] ?? key[3] ?? key[4] ?? "").toLowerCase();
    if (!found.has(name)) found.set(name, decode(content[2] ?? content[3] ?? content[4] ?? ""));
  }
  return found;
}
/**
 * Reads a public web page's title, description and picture. Null when the
 * address is not a page, says nothing useful, or cannot be reached.
 */
export async function pagePreview(link: string, options: PreviewOptions = {}): Promise<PagePreview | null> {
  const o: Required<PreviewOptions> = {
    fetch: options.fetch ?? ((url, init) => fetch(url, init)),
    resolve:
      options.resolve ??
      (async (host) => (await lookup(host, { all: true })).map((a) => a.address)),
  };
  try {
    const { response, url } = await get(link, "text/html,application/xhtml+xml", o);
    if (!response.ok || !/html/i.test(response.headers.get("content-type") ?? "")) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    const html = new TextDecoder().decode((await read(response, maxPage))!);
    const meta = metaTags(html);
    const title = (
      meta.get("og:title") ||
      meta.get("twitter:title") ||
      decode(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "")
    ).slice(0, 300);
    if (!title) return null;
    const description = (
      meta.get("og:description") || meta.get("twitter:description") || meta.get("description") || ""
    ).slice(0, 600);
    const preview: PagePreview = { url: link, title, ...(description ? { description } : {}) };
    const picture = meta.get("og:image") || meta.get("og:image:url") || meta.get("twitter:image");
    if (picture)
      try {
        const got = await get(new URL(picture, url).href, "image/*", o);
        const mimetype = (got.response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
        const data =
          got.response.ok && /^image\/(jpeg|png|webp|gif)$/.test(mimetype)
            ? await read(got.response, maxImage, true)
            : (await got.response.body?.cancel().catch(() => {}), null);
        if (data?.length) preview.image = { mimetype, data };
      } catch {
        /* a preview without its picture is still worth showing */
      }
    return preview;
  } catch {
    return null;
  }
}
/** Remembers recent lookups, so retyping around a link does not fetch it again. */
export class LinkPreviews {
  private cache = new Map<string, Promise<PagePreview | null>>();
  constructor(private options: PreviewOptions = {}) {}
  get(url: string) {
    let known = this.cache.get(url);
    if (known) this.cache.delete(url);
    else known = pagePreview(url, this.options);
    this.cache.set(url, known);
    if (this.cache.size > 50) this.cache.delete(this.cache.keys().next().value!);
    return known;
  }
}
