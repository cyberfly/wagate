import { Fragment, useEffect, useState } from "react";
import {
  request,
  type Broadcast,
  type BroadcastEvent,
  type BroadcastRecipient,
} from "../lib/api";
import { recipientStatus, sendLogCsv } from "../../sidecar/src/broadcast/csv";
type Filter =
  | "all"
  | "sent"
  | "delivered"
  | "read"
  | "failed"
  | "uncertain"
  | "pending"
  | "cancelled";
const filters: [Filter, string][] = [
  ["all", "All"],
  ["sent", "Sent"],
  ["delivered", "Delivered"],
  ["read", "Read"],
  ["failed", "Failed"],
  ["uncertain", "Uncertain"],
  ["pending", "Waiting"],
  ["cancelled", "Skipped"],
];
// Like WhatsApp's ticks, each step includes the later ones: a read message
// was also delivered and sent. The counts then match the summary line.
const includes: Partial<Record<Filter, BroadcastRecipient["status"][]>> = {
  sent: ["sent", "delivered", "read"],
  delivered: ["delivered", "read"],
  pending: ["pending", "sending"],
};
const matches = (filter: Filter, r: BroadcastRecipient) =>
  filter === "all" || (includes[filter] ?? [filter]).includes(r.status);
/** Time of day, with the date when it is not today. */
function when(ms: number | null) {
  if (!ms) return "";
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return d.toDateString() === new Date().toDateString()
    ? time
    : d.toLocaleDateString([], { day: "numeric", month: "short" }) + " " + time;
}
const number = (chatId: string | null) =>
  chatId ? "+" + chatId.split("@")[0] : "";
function describe(e: BroadcastEvent) {
  switch (e.type) {
    case "created":
      return `Started · ${e.detail}`;
    case "sent":
      return `Sent to ${e.label} · ${number(e.chatId)}`;
    case "failed":
      return `Rejected for ${e.label} · ${e.detail}`;
    case "uncertain":
      return `Delivery unknown for ${e.label} · ${e.detail}`;
    case "paused":
      return e.detail ? `Paused · ${e.detail}` : "Paused by you";
    case "resumed":
      return "Resumed";
    case "cancelled":
      return `Cancelled · ${e.detail}`;
    case "completed":
      return `Finished · ${e.detail}`;
  }
}
export function BroadcastLog({
  broadcast: b,
  busy,
  act,
  close,
}: {
  broadcast: Broadcast;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  close: () => void;
}) {
  const [log, setLog] = useState<{
      recipients: BroadcastRecipient[];
      events: BroadcastEvent[];
    } | null>(null),
    [error, setError] = useState(""),
    [tab, setTab] = useState<"recipients" | "timeline">("recipients"),
    [filter, setFilter] = useState<Filter>("all"),
    [expanded, setExpanded] = useState<number | null>(null),
    [saved, setSaved] = useState(""),
    [copied, setCopied] = useState(false);
  useEffect(() => {
    setLog(null);
    setSaved("");
    setCopied(false);
    setFilter("all");
    setExpanded(null);
  }, [b.id]);
  // Summaries in the snapshot change on every send, which refreshes the log.
  useEffect(() => {
    request<{ recipients: BroadcastRecipient[]; events: BroadcastEvent[] }>(
      "/internal/broadcasts/" + b.id,
    )
      .then((result) => {
        setLog(result);
        setError("");
      })
      .catch((e) => setError(String(e)));
  }, [b.id, b.updatedAt]);
  const recipients = log?.recipients ?? [];
  const shown = recipients.filter((r) => matches(filter, r));
  return (
    <section className="panel send-log" aria-label={`Send log for ${b.name}`}>
      <div className="send-log-head">
        <div>
          <span className="eyebrow">SEND LOG</span>
          <h3>{b.name}</h3>
          <small>
            Started {when(b.createdAt)} · {b.sent} sent · {b.delivered}{" "}
            delivered · {b.failed} failed · {b.uncertain} uncertain ·{" "}
            {b.pending} waiting · {b.cancelled} skipped
          </small>
        </div>
        <div className="button-row">
          <button
            className="secondary"
            disabled={busy || !log}
            onClick={() =>
              void act(async () => {
                const result = await request<{ path: string }>(
                  `/internal/broadcasts/${b.id}/export`,
                  "POST",
                );
                setSaved(result.path);
              })
            }
          >
            Save CSV
          </button>
          <button
            className="secondary"
            disabled={!log}
            onClick={() =>
              void navigator.clipboard
                .writeText(sendLogCsv(recipients))
                .then(() => setCopied(true))
                .catch(() => setError("Copying failed. Use Save CSV instead."))
            }
          >
            {copied ? "Copied" : "Copy CSV"}
          </button>
          <button className="text-button" onClick={close}>
            Close
          </button>
        </div>
      </div>
      {saved ? (
        <p className="saved-path" role="status">
          ✓ Saved to <code>{saved}</code>
        </p>
      ) : null}
      {error ? <p className="inline-error">{error}</p> : null}
      <div className="log-tabs" role="tablist">
        {(["recipients", "timeline"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? "active" : ""}
            onClick={() => setTab(t)}
          >
            {t === "recipients" ? "Recipients" : "Timeline"}
          </button>
        ))}
      </div>
      {!log ? (
        <p className="muted log-empty">Loading the log…</p>
      ) : tab === "recipients" ? (
        <>
          <div className="column-chips log-filters">
            {filters.map(([f, label]) => (
              <button
                key={f}
                className={"chip" + (filter === f ? " active" : "")}
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
              >
                {label} {recipients.filter((r) => matches(f, r)).length}
              </button>
            ))}
          </div>
          <div className="table-wrap">
            <table className="recipients-table log-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>NAME</th>
                  <th>NUMBER</th>
                  <th>STATUS</th>
                  <th>TIME</th>
                  <th>NOTE</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <Fragment key={r.position}>
                    <tr
                      className={expanded === r.position ? "current" : ""}
                      aria-expanded={expanded === r.position}
                      onClick={() =>
                        setExpanded(expanded === r.position ? null : r.position)
                      }
                    >
                      <td>{r.position}</td>
                      <td>{r.label}</td>
                      <td>{number(r.chatId)}</td>
                      <td className={"state-" + r.status}>
                        {recipientStatus[r.status]}
                      </td>
                      <td>{when(r.sentAt ?? r.attemptedAt)}</td>
                      <td className="note">{r.error}</td>
                    </tr>
                    {expanded === r.position ? (
                      <tr className="log-detail">
                        <td />
                        <td colSpan={5}>
                          <p>{r.text}</p>
                          <small>
                            {r.attemptedAt
                              ? `Attempted ${when(r.attemptedAt)}`
                              : "Not attempted"}
                            {r.sentAt ? ` · Sent ${when(r.sentAt)}` : ""}
                            {r.messageId ? ` · Message ID ${r.messageId}` : ""}
                          </small>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
            {!shown.length ? (
              <p className="muted log-empty">No recipients with this status.</p>
            ) : null}
          </div>
        </>
      ) : log.events.length ? (
        <ol className="timeline">
          {[...log.events].reverse().map((e) => (
            <li key={e.id} className={"event-" + e.type}>
              <time>{when(e.at)}</time>
              <span>{describe(e)}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted log-empty">
          No timeline for this broadcast: it was sent before Wagate kept send
          logs. The recipients tab still shows each result.
        </p>
      )}
    </section>
  );
}
