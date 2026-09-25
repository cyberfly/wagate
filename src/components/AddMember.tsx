import { useState } from "react";
import { request, type GroupAddResult } from "../lib/api";
import { normalizePhone } from "../../sidecar/src/broadcast/csv";
import { batchSize } from "../../sidecar/src/groups/group-import-service";
const outcome: Record<GroupAddResult["status"], string> = {
  added: "Added",
  already: "Already a member",
  invite: "Needs an invite link",
  failed: "Not added",
};
const outcomeClass: Record<GroupAddResult["status"], string> = {
  added: "state-delivered",
  already: "state-sent",
  invite: "state-uncertain",
  failed: "state-failed",
};
/** Adds a few people to a group from its chat. */
export function AddMember({
  groupId,
  connected,
  close,
}: {
  groupId: string;
  connected: boolean;
  close: () => void;
}) {
  const [numbers, setNumbers] = useState(""),
    [countryCode, setCountryCode] = useState("60"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [results, setResults] = useState<GroupAddResult[]>([]);
  const entries = numbers
    .split(/[\n,;]+/)
    .map((n) => n.trim())
    .filter(Boolean);
  const parsed = entries.map((value) => ({
    value,
    ...normalizePhone(value, countryCode),
  }));
  const invalid = parsed.filter((p) => "error" in p);
  const phones = [
    ...new Set(parsed.flatMap((p) => ("phone" in p ? [p.phone] : []))),
  ];
  const blocker = !connected
    ? "Connect WhatsApp to add people."
    : !entries.length
      ? ""
      : invalid.length
        ? `Check ${invalid.map((p) => p.value).join(", ")}: ${"error" in invalid[0] ? invalid[0].error.toLowerCase() : ""}.`
        : phones.length > batchSize
          ? `Add up to ${batchSize} at a time here. For a longer list, use Add to group with a CSV.`
          : "";
  const add = async () => {
    setBusy(true);
    setError("");
    try {
      const data = await request<{ results: GroupAddResult[] }>(
        `/internal/groups/${encodeURIComponent(groupId)}/participants`,
        "POST",
        { phones },
      );
      setResults(data.results);
      // Keeps only the numbers that still need attention.
      setNumbers(
        data.results
          .filter((r) => r.status === "failed")
          .map((r) => "+" + r.phone)
          .join("\n"),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="add-member" aria-label="Add people to this group">
      <div className="add-member-head">
        <strong>Add people</strong>
        <button className="text-button" onClick={close}>
          Close
        </button>
      </div>
      <div className="add-member-fields">
        <label>
          Phone numbers
          <textarea
            rows={2}
            placeholder={"+60 12-345 6789\n012-345 6789"}
            value={numbers}
            onChange={(e) => {
              setNumbers(e.target.value);
              setResults([]);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && phones.length && !blocker && !busy)
                void add();
            }}
          />
        </label>
        <label className="add-member-code">
          Country code
          <input
            inputMode="numeric"
            maxLength={5}
            value={countryCode}
            onChange={(e) => setCountryCode(e.target.value)}
          />
        </label>
      </div>
      <small>
        One per line or separated by commas. Numbers starting with 0 use the
        country code. You must be a group admin.
      </small>
      {blocker ? <p className="inline-error">{blocker}</p> : null}
      {error ? <p className="inline-error">{error}</p> : null}
      {results.length ? (
        <ul className="add-member-results">
          {results.map((r) => (
            <li key={r.phone}>
              <span>+{r.phone}</span>
              <span className={outcomeClass[r.status]}>
                {outcome[r.status]}
                {r.error && r.status !== "invite" ? ` · ${r.error}` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="button-row">
        <button
          disabled={busy || !phones.length || !!blocker}
          onClick={() => void add()}
        >
          {busy
            ? "Adding…"
            : `Add ${phones.length || ""} ${phones.length === 1 ? "person" : "people"}`.replace("  ", " ")}
        </button>
      </div>
    </section>
  );
}
