import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { request, type Broadcast as Summary } from "../lib/api";
import { BroadcastLog } from "./BroadcastLog";
import {
  maxRecipients,
  nameFor,
  normalizePhone,
  phoneColumn,
  placeholders,
  readCsv,
  render,
  type CsvTable,
} from "../../sidecar/src/broadcast/csv";
interface Props {
  broadcasts: Summary[];
  connected: boolean;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}
interface Row {
  index: number;
  label: string;
  phone: string | null;
  text: string;
  issue: string | null;
  warning: string | null;
}
const statusLabel: Record<Summary["status"], string> = {
  running: "Sending",
  paused: "Paused",
  completed: "Done",
  cancelled: "Cancelled",
};
function duration(seconds: number) {
  if (seconds < 60) return "under a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min`;
  return `about ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
export function Broadcast({ broadcasts, connected, busy, act }: Props) {
  const [csv, setCsv] = useState<{ file: string; table: CsvTable } | null>(
      null,
    ),
    [csvError, setCsvError] = useState(""),
    [phoneCol, setPhoneCol] = useState(""),
    [countryCode, setCountryCode] = useState(""),
    [name, setName] = useState(""),
    [template, setTemplate] = useState(""),
    [minDelay, setMinDelay] = useState(10),
    [maxDelay, setMaxDelay] = useState(20),
    [excluded, setExcluded] = useState<Set<number>>(new Set()),
    [current, setCurrent] = useState(0),
    [confirming, setConfirming] = useState(false),
    [logId, setLogId] = useState<string | null>(null);
  const logged = broadcasts.find((b) => b.id === logId);
  const editor = useRef<HTMLTextAreaElement>(null),
    caret = useRef<number | null>(null);
  const rows = useMemo<Row[]>(() => {
    if (!csv) return [];
    const seen = new Map<string, number>();
    return csv.table.rows.map((row, index) => {
      const phone = phoneCol
        ? normalizePhone(row[phoneCol] ?? "", countryCode)
        : { error: "Choose the phone column" };
      const message = render(template, row);
      let issue = "error" in phone ? phone.error : null;
      if ("phone" in phone && !excluded.has(index)) {
        const first = seen.get(phone.phone);
        if (first !== undefined) issue = `Same number as row ${first + 1}`;
        else seen.set(phone.phone, index);
      }
      if (!issue && template.trim() && !message.text) issue = "Empty message";
      if (!issue && message.text.length > 10000) issue = "Message too long";
      return {
        index,
        label: nameFor(row),
        phone: "phone" in phone ? phone.phone : null,
        text: message.text,
        issue,
        warning: message.empty.length
          ? `Empty: ${message.empty.join(", ")}`
          : null,
      };
    });
  }, [csv, phoneCol, countryCode, template, excluded]);
  const unknown = csv
    ? placeholders(template).filter(
        (p) =>
          !csv.table.headers.some((h) => h.toLowerCase() === p.toLowerCase()),
      )
    : [];
  const ready = rows.filter((r) => !r.issue && !excluded.has(r.index));
  const attention = rows.filter((r) => r.issue).length;
  const running = broadcasts.find((b) => b.status === "running");
  const delaysValid =
    Number.isInteger(minDelay) &&
    Number.isInteger(maxDelay) &&
    minDelay >= 5 &&
    maxDelay <= 600 &&
    minDelay <= maxDelay;
  const blocker = !connected
    ? "Connect WhatsApp before sending."
    : running
      ? "Another broadcast is sending. Pause or cancel it first."
      : !csv
        ? "Choose a CSV file to begin."
        : !template.trim()
          ? "Write the message to send."
          : unknown.length
            ? `The message uses ${unknown.map((u) => `{{${u}}}`).join(", ")}, which ${unknown.length > 1 ? "are not columns" : "is not a column"} in this file.`
            : !ready.length
              ? "No rows are ready to send."
              : !delaysValid
                ? "Set a wait of 5–600 seconds, the smaller number first."
                : !name.trim()
                  ? "Name this broadcast."
                  : "";
  const estimate = duration(
    (Math.max(ready.length - 1, 0) * (minDelay + maxDelay)) / 2,
  );
  const preview = rows[current];
  useEffect(() => {
    setConfirming(false);
  }, [csv, phoneCol, countryCode, template, excluded, minDelay, maxDelay]);
  const load = async (file: File | undefined) => {
    setCsvError("");
    if (!file) return;
    try {
      const table = readCsv(await file.text());
      if (!table.rows.length) throw new Error("This file has no rows below the header.");
      if (table.rows.length > maxRecipients)
        throw new Error(
          `This file has ${table.rows.length.toLocaleString()} rows. Wagate sends up to ${maxRecipients.toLocaleString()} per broadcast; split the file and send it in parts.`,
        );
      setCsv({ file: file.name, table });
      setPhoneCol(phoneColumn(table.headers) ?? "");
      setName(file.name.replace(/\.(csv|tsv|txt)$/i, "").slice(0, 120));
      setExcluded(new Set());
      setCurrent(0);
    } catch (e) {
      setCsv(null);
      setCsvError(e instanceof Error ? e.message : "Could not read this file.");
    }
  };
  const insert = (column: string) => {
    const token = `{{${column}}}`;
    const el = editor.current;
    const start = el?.selectionStart ?? template.length,
      end = el?.selectionEnd ?? template.length;
    caret.current = start + token.length;
    setTemplate(template.slice(0, start) + token + template.slice(end));
  };
  // Puts the caret after an inserted column once React has rendered it.
  useLayoutEffect(() => {
    const el = editor.current;
    if (caret.current === null || !el) return;
    el.focus();
    el.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [template]);
  const toggle = (index: number) => {
    const next = new Set(excluded);
    if (!next.delete(index)) next.add(index);
    setExcluded(next);
  };
  const send = () =>
    act(async () => {
      await request("/internal/broadcasts", "POST", {
        name: name.trim(),
        minDelay,
        maxDelay,
        recipients: ready.map((r) => ({
          to: r.phone,
          label: r.label,
          text: r.text,
        })),
      });
      setCsv(null);
      setConfirming(false);
    });
  return (
    <div className="broadcast-page">
      {broadcasts.length ? (
        <section className="broadcast-history">
          {broadcasts.map((b) => (
            <BroadcastCard
              key={b.id}
              broadcast={b}
              busy={busy}
              act={act}
              logOpen={b.id === logId}
              toggleLog={() => setLogId(b.id === logId ? null : b.id)}
            />
          ))}
        </section>
      ) : null}
      {logged ? (
        <BroadcastLog
          broadcast={logged}
          busy={busy}
          act={act}
          close={() => setLogId(null)}
        />
      ) : null}
      <section className="panel settings-panel">
        <span className="eyebrow">SEND TO A LIST</span>
        <h2>One message, each one personal</h2>
        <p className="muted">
          Upload a CSV, write a message with <code>{"{{Column}}"}</code>{" "}
          placeholders, and Wagate sends each row its own copy from your
          number, one at a time.
        </p>
        <div className="composer-grid">
          <div>
            <label htmlFor="csvFile">Recipients CSV</label>
            <input
              id="csvFile"
              className="visually-hidden"
              type="file"
              accept=".csv,.tsv,.txt,text/csv"
              onChange={(e) => {
                void load(e.target.files?.[0]);
                // Lets the same file be chosen again after editing it.
                e.target.value = "";
              }}
            />
            <label htmlFor="csvFile" className="file-picker">
              <span className="file-button">
                {csv ? "Replace file" : "Choose CSV file"}
              </span>
              <span>
                {csv
                  ? `${csv.file} · ${csv.table.rows.length} rows`
                  : "No file chosen"}
              </span>
            </label>
            <small>
              The first line must name the columns. Comma, semicolon and tab
              separated files work.
            </small>
            {csvError ? <p className="inline-error">{csvError}</p> : null}
            {csv ? (
              <>
                <div className="field-pair">
                  <div>
                    <label htmlFor="phoneCol">Phone number column</label>
                    <select
                      id="phoneCol"
                      value={phoneCol}
                      onChange={(e) => setPhoneCol(e.target.value)}
                    >
                      <option value="">Choose a column</option>
                      {csv.table.headers.map((h) => (
                        <option key={h}>{h}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="countryCode">Country code</label>
                    <input
                      id="countryCode"
                      inputMode="numeric"
                      maxLength={5}
                      placeholder="e.g. 60"
                      value={countryCode}
                      onChange={(e) => setCountryCode(e.target.value)}
                    />
                  </div>
                </div>
                <small>
                  Used only for local numbers that start with 0, such as
                  012-345 6789.
                </small>
                <label htmlFor="broadcastName">Broadcast name</label>
                <input
                  id="broadcastName"
                  maxLength={120}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </>
            ) : null}
            <label htmlFor="template">Message</label>
            <textarea
              id="template"
              ref={editor}
              rows={7}
              maxLength={10000}
              placeholder={"Hi {{First Name}}, see you on Saturday!"}
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
            />
            {csv ? (
              <div className="column-chips" aria-label="Insert a column">
                {csv.table.headers.map((h) => (
                  <button
                    type="button"
                    key={h}
                    className="chip"
                    onClick={() => insert(h)}
                  >
                    {h}
                  </button>
                ))}
              </div>
            ) : null}
            <small>
              Click a column to insert it. Write{" "}
              <code>{"{{First Name|there}}"}</code> to use “there” when a cell
              is empty.
            </small>
            <label htmlFor="minDelay">Wait between messages</label>
            <div className="delay-row">
              <input
                id="minDelay"
                type="number"
                min={5}
                max={600}
                value={minDelay}
                onChange={(e) => setMinDelay(Number(e.target.value))}
              />
              <span>to</span>
              <input
                aria-label="Maximum wait in seconds"
                type="number"
                min={5}
                max={600}
                value={maxDelay}
                onChange={(e) => setMaxDelay(Number(e.target.value))}
              />
              <span>seconds</span>
            </div>
            <small>
              A random gap in this range separates each message. Sending many
              identical messages quickly is the most common reason WhatsApp
              restricts a number.
            </small>
          </div>
          <div className="phone-preview">
            <span className="eyebrow">PREVIEW</span>
            {preview && template.trim() ? (
              <>
                <div className="preview-to">
                  <strong>{preview.label || "Row " + (preview.index + 1)}</strong>
                  <small>
                    {preview.phone ? "+" + preview.phone : preview.issue}
                  </small>
                </div>
                <div className="message outgoing">
                  <p>{preview.text || " "}</p>
                </div>
                {preview.warning ? (
                  <small className="note-warn">{preview.warning}</small>
                ) : null}
                <div className="preview-nav">
                  <button
                    type="button"
                    className="text-button"
                    disabled={current === 0}
                    onClick={() => setCurrent(current - 1)}
                  >
                    ← Previous
                  </button>
                  <small>
                    Row {current + 1} of {rows.length}
                  </small>
                  <button
                    type="button"
                    className="text-button"
                    disabled={current >= rows.length - 1}
                    onClick={() => setCurrent(current + 1)}
                  >
                    Next →
                  </button>
                </div>
              </>
            ) : (
              <p className="muted">
                {csv
                  ? "Write a message to see how it reads for each person."
                  : "Each person’s message appears here once you choose a file."}
              </p>
            )}
          </div>
        </div>
        <div className="send-bar">
          {confirming ? (
            <div className="confirm-box" role="alertdialog">
              <strong>
                Send {ready.length} {ready.length === 1 ? "message" : "messages"}{" "}
                from your WhatsApp number?
              </strong>
              <p>
                They go out one at a time over {estimate}. Keep Wagate open
                until it finishes. You can pause or cancel, but sent messages
                cannot be recalled.
              </p>
              <div className="button-row">
                <button disabled={busy || !!blocker} onClick={() => void send()}>
                  Send {ready.length} now
                </button>
                <button
                  className="secondary"
                  onClick={() => setConfirming(false)}
                >
                  Back
                </button>
              </div>
            </div>
          ) : (
            <div className="button-row">
              <button
                disabled={busy || !!blocker}
                onClick={() => setConfirming(true)}
              >
                Review and send{ready.length ? ` to ${ready.length}` : ""}
              </button>
              <span className="muted">
                {blocker || `Takes ${estimate} at this pace.`}
              </span>
            </div>
          )}
        </div>
      </section>
      {csv ? (
        <section className="panel">
          <div className="table-heading">
            <strong>Recipients</strong>
            <small>
              {ready.length} ready
              {attention ? ` · ${attention} need attention` : ""}
              {excluded.size ? ` · ${excluded.size} left out` : ""}
            </small>
          </div>
          <div className="table-wrap">
            <table className="recipients-table">
              <thead>
                <tr>
                  <th aria-label="Include" />
                  <th>#</th>
                  <th>NAME</th>
                  <th>NUMBER</th>
                  <th>MESSAGE</th>
                  <th>NOTE</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.index}
                    className={
                      (r.index === current ? "current " : "") +
                      (r.issue || excluded.has(r.index) ? "skipped" : "")
                    }
                    onClick={() => setCurrent(r.index)}
                  >
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Include row ${r.index + 1}`}
                        disabled={!!r.issue}
                        checked={!r.issue && !excluded.has(r.index)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggle(r.index)}
                      />
                    </td>
                    <td>{r.index + 1}</td>
                    <td>{r.label || "—"}</td>
                    <td>{r.phone ? "+" + r.phone : "—"}</td>
                    <td className="message-cell">{r.text}</td>
                    <td
                      className={
                        r.issue ? "note-bad" : r.warning ? "note-warn" : ""
                      }
                    >
                      {r.issue || r.warning || (excluded.has(r.index) ? "Left out" : "")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
function BroadcastCard({
  broadcast: b,
  busy,
  act,
  logOpen,
  toggleLog,
}: {
  broadcast: Summary;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  logOpen: boolean;
  toggleLog: () => void;
}) {
  const done = b.total - b.pending;
  const action = (name: string, method = "POST") =>
    void act(() =>
      request(
        `/internal/broadcasts/${b.id}${name ? "/" + name : ""}`,
        method,
      ),
    );
  return (
    <article className={"panel broadcast-card" + (logOpen ? " active" : "")}>
      <div className="broadcast-card-head">
        <strong title={b.name}>{b.name}</strong>
        <span
          className={
            "status " + (b.status === "running" || b.status === "completed" ? "online" : "")
          }
        >
          {statusLabel[b.status]}
        </span>
      </div>
      <div
        className="progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={b.total}
        aria-valuenow={done}
      >
        <span style={{ width: `${(done / b.total) * 100}%` }} />
      </div>
      <small>
        {b.sent} of {b.total} sent
        {b.uncertain ? ` · ${b.uncertain} uncertain` : ""}
        {b.cancelled ? ` · ${b.cancelled} skipped` : ""} ·{" "}
        {new Date(b.createdAt).toLocaleString()}
      </small>
      {b.status === "paused" && b.error ? (
        <p className="inline-error">{b.error}</p>
      ) : null}
      <div className="button-row">
        {b.status === "running" ? (
          <button className="secondary" disabled={busy} onClick={() => action("pause")}>
            Pause
          </button>
        ) : null}
        {b.status === "paused" ? (
          <button className="secondary" disabled={busy} onClick={() => action("resume")}>
            Resume
          </button>
        ) : null}
        {b.status === "running" || b.status === "paused" ? (
          <button
            className="text-button danger"
            disabled={busy}
            onClick={() => action("cancel")}
          >
            Cancel
          </button>
        ) : (
          <button
            className="text-button danger"
            disabled={busy}
            onClick={() => action("", "DELETE")}
          >
            Remove
          </button>
        )}
        <button
          className="text-button"
          aria-expanded={logOpen}
          onClick={toggleLog}
        >
          {logOpen ? "Hide log" : "View log"}
        </button>
      </div>
    </article>
  );
}
