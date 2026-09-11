// Pure helpers for bulk sends from a CSV. The desktop UI bundles this file to
// build its preview, so it must not use Bun or Node APIs.
export const maxRecipients = 1000;
export interface CsvTable {
  headers: string[];
  rows: Record<string, string>[];
}
/** Picks the delimiter that splits the header line most: comma, semicolon or tab. */
function delimiter(text: string) {
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && ch in counts) counts[ch]++;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}
/** RFC 4180: quoted fields may contain delimiters, doubled quotes and newlines. */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, "");
  const sep = delimiter(text);
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"' && !field) quoted = true;
    else if (ch === sep) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((value) => value.trim()));
}
/** The first line names the columns; cells are trimmed. */
export function readCsv(input: string): CsvTable {
  const [head = [], ...body] = parseCsv(input);
  const headers: string[] = [];
  for (const [i, raw] of head.entries()) {
    const base = raw.trim() || `Column ${i + 1}`;
    let name = base;
    for (let n = 2; headers.includes(name); n++) name = `${base} (${n})`;
    headers.push(name);
  }
  return {
    headers,
    rows: body.map((cells) =>
      Object.fromEntries(headers.map((h, i) => [h, (cells[i] ?? "").trim()])),
    ),
  };
}
const placeholder = /\{\{\s*([^{}|]*?)\s*(?:\|([^{}]*))?\}\}/g;
/** Column names a template refers to, as written. */
export function placeholders(template: string) {
  return [...new Set([...template.matchAll(placeholder)].map((m) => m[1]))];
}
export interface Rendered {
  text: string;
  /** Placeholders that match no column. */
  unknown: string[];
  /** Columns that were empty for this row and had no fallback. */
  empty: string[];
}
/**
 * Fills `{{Column}}` from the row, matching column names case-insensitively.
 * `{{Column|fallback}}` uses the fallback when the cell is empty.
 */
export function render(
  template: string,
  row: Record<string, string>,
): Rendered {
  const lookup = new Map(
    Object.entries(row).map(([k, v]) => [k.trim().toLowerCase(), v]),
  );
  const unknown = new Set<string>(),
    empty = new Set<string>();
  const text = template.replace(
    placeholder,
    (_, name: string, fallback?: string) => {
      const value = lookup.get(name.toLowerCase());
      if (value === undefined) {
        unknown.add(name);
        return "";
      }
      if (value) return value;
      if (fallback === undefined) empty.add(name);
      return fallback?.trim() ?? "";
    },
  );
  return { text: text.trim(), unknown: [...unknown], empty: [...empty] };
}
export type PhoneResult = { phone: string } | { error: string };
/**
 * Reduces a phone cell to international digits. Numbers written with a
 * leading 0 are local and need `countryCode` (for example 60 for Malaysia).
 */
export function normalizePhone(value: string, countryCode = ""): PhoneResult {
  let digits = value.trim().replace(/[\s\-().]/g, "");
  if (!digits) return { error: "No number" };
  if (digits.startsWith("+")) digits = digits.slice(1);
  else if (digits.startsWith("00")) digits = digits.slice(2);
  else if (digits.startsWith("0")) {
    const code = countryCode.replace(/^\+/, "");
    if (!/^\d{1,4}$/.test(code))
      return { error: "Local number: set a country code" };
    digits = code + digits.slice(1);
  }
  return /^[1-9]\d{6,14}$/.test(digits)
    ? { phone: digits }
    : { error: "Invalid number" };
}
/** Best guess at the column holding phone numbers. */
export function phoneColumn(headers: string[]) {
  return (
    headers.find((h) => /phone|mobile|whats\s*app|^tel|^hp$|no\.?\s*hp/i.test(h)) ??
    null
  );
}
/** A readable label for a row: first + last name, a name column, or nothing. */
export function nameFor(row: Record<string, string>) {
  const get = (pattern: RegExp) =>
    Object.entries(row).find(([k]) => pattern.test(k.trim()))?.[1] ?? "";
  const first = get(/^(first\s*name|given\s*name)$/i),
    last = get(/^(last\s*name|surname|family\s*name)$/i);
  return (
    [first, last].filter(Boolean).join(" ") ||
    get(/^(full\s*name|name|contact\s*name)$/i)
  );
}
