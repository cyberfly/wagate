import { useCallback, useEffect, useMemo, useState } from "react";
import {
  request,
  type GroupImport,
  type GroupImportMember,
  type GroupInfo,
} from "../lib/api";
import {
  maxRecipients,
  nameFor,
  normalizePhone,
  phoneColumn,
  readCsv,
  type CsvTable,
} from "../../sidecar/src/broadcast/csv";
import { batchSize } from "../../sidecar/src/groups/group-import-service";
import { PaceChooser, paceValid } from "./PaceChooser";
interface Props {
  imports: GroupImport[];
  connected: boolean;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}
interface Row {
  index: number;
  label: string;
  phone: string | null;
  issue: string | null;
}
const importStatus: Record<GroupImport["status"], string> = {
  running: "Adding",
  completed: "Done",
  cancelled: "Cancelled",
  stopped: "Stopped",
};
const memberStatus: Record<GroupImportMember["status"], string> = {
  pending: "Waiting",
  added: "Added",
  already: "Already a member",
  invite: "Needs invite",
  failed: "Not added",
  cancelled: "Skipped",
};
const memberClass: Partial<Record<GroupImportMember["status"], string>> = {
  added: "state-delivered",
  already: "state-sent",
  invite: "state-uncertain",
  failed: "state-failed",
};
function duration(people: number, minDelay: number, maxDelay: number) {
  const seconds =
    (Math.max(Math.ceil(people / batchSize) - 1, 0) * (minDelay + maxDelay)) / 2;
  if (seconds < 60) return "under a minute";
  const minutes = Math.round(seconds / 60);
  return minutes < 60
    ? `about ${minutes} min`
    : `about ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
export function GroupMembers({ imports, connected, busy, act }: Props) {
  const [groups, setGroups] = useState<GroupInfo[]>([]),
    [loadingGroups, setLoadingGroups] = useState(false),
    [groupError, setGroupError] = useState(""),
    [groupId, setGroupId] = useState(""),
    [csv, setCsv] = useState<{ file: string; table: CsvTable } | null>(null),
    [csvError, setCsvError] = useState(""),
    [phoneCol, setPhoneCol] = useState(""),
    [countryCode, setCountryCode] = useState("60"),
    [minDelay, setMinDelay] = useState(10),
    [maxDelay, setMaxDelay] = useState(20),
    [excluded, setExcluded] = useState<Set<number>>(new Set()),
    [confirming, setConfirming] = useState(false),
    [openId, setOpenId] = useState<string | null>(null);
  const loadGroups = useCallback(async () => {
    setLoadingGroups(true);
    setGroupError("");
    try {
      const data = await request<{ groups: GroupInfo[] }>("/internal/groups");
      setGroups(data.groups);
    } catch (e) {
      setGroupError(String(e));
    } finally {
      setLoadingGroups(false);
    }
  }, []);
  useEffect(() => {
    if (connected) void loadGroups();
  }, [connected, loadGroups]);
  const adminGroups = groups.filter((g) => g.isAdmin);
  const group = adminGroups.find((g) => g.id === groupId);
  const rows = useMemo<Row[]>(() => {
    if (!csv) return [];
    const seen = new Map<string, number>();
    return csv.table.rows.map((row, index) => {
      const phone = phoneCol
        ? normalizePhone(row[phoneCol] ?? "", countryCode)
        : { error: "Choose the phone column" };
      let issue = "error" in phone ? phone.error : null;
      if ("phone" in phone && !excluded.has(index)) {
        const first = seen.get(phone.phone);
        if (first !== undefined) issue = `Same number as row ${first + 1}`;
        else seen.set(phone.phone, index);
      }
      return {
        index,
        label: nameFor(row),
        phone: "phone" in phone ? phone.phone : null,
        issue,
      };
    });
  }, [csv, phoneCol, countryCode, excluded]);
  const ready = rows.filter((r) => !r.issue && !excluded.has(r.index));
  const attention = rows.filter((r) => r.issue).length;
  const running = imports.find((i) => i.status === "running");
  const blocker = !connected
    ? "Connect WhatsApp before adding people."
    : running
      ? "Another import is running. Wait for it or cancel it first."
      : !group
        ? "Choose a group you administer."
        : !csv
          ? "Choose a CSV file to begin."
          : !ready.length
            ? "No rows are ready to add."
            : !paceValid(minDelay, maxDelay)
              ? "Set a wait of 5–600 seconds, the smaller number first."
              : "";
  const estimate = duration(ready.length, minDelay, maxDelay);
  useEffect(() => {
    setConfirming(false);
  }, [csv, phoneCol, countryCode, excluded, groupId, minDelay, maxDelay]);
  const load = async (file: File | undefined) => {
    setCsvError("");
    if (!file) return;
    try {
      const table = readCsv(await file.text());
      if (!table.rows.length)
        throw new Error("This file has no rows below the header.");
      if (table.rows.length > maxRecipients)
        throw new Error(
          `This file has ${table.rows.length.toLocaleString()} rows. Wagate adds up to ${maxRecipients.toLocaleString()} at a time; split the file and import it in parts.`,
        );
      setCsv({ file: file.name, table });
      setPhoneCol(phoneColumn(table.headers) ?? "");
      setExcluded(new Set());
    } catch (e) {
      setCsv(null);
      setCsvError(e instanceof Error ? e.message : "Could not read this file.");
    }
  };
  const toggle = (index: number) => {
    const next = new Set(excluded);
    if (!next.delete(index)) next.add(index);
    setExcluded(next);
  };
  const start = () =>
    act(async () => {
      const job = await request<GroupImport>("/internal/group-imports", "POST", {
        groupId,
        minDelay,
        maxDelay,
        members: ready.map((r) => ({ phone: r.phone, label: r.label })),
      });
      setCsv(null);
      setConfirming(false);
      setOpenId(job.id);
    });
  const opened = imports.find((i) => i.id === openId);
  return (
    <div className="broadcast-page">
      {imports.length ? (
        <section className="broadcast-history">
          {imports.map((job) => (
            <ImportCard
              key={job.id}
              job={job}
              busy={busy}
              act={act}
              open={job.id === openId}
              toggle={() => setOpenId(job.id === openId ? null : job.id)}
            />
          ))}
        </section>
      ) : null}
      {opened ? <ImportResults job={opened} /> : null}
      <section className="panel settings-panel">
        <span className="eyebrow">ADD PEOPLE FROM A LIST</span>
        <h2>Bulk add to a group</h2>
        <p className="muted">
          Choose a group where you are an admin, upload a CSV with phone
          numbers, and Wagate adds everyone a few at a time. People whose
          privacy settings block being added are marked so you can send them
          an invite link.
        </p>
        <div className="composer-grid">
          <div>
            <label htmlFor="importGroup">Group</label>
            <div className="field-pair">
              <select
                id="importGroup"
                value={groupId}
                disabled={!connected}
                onChange={(e) => setGroupId(e.target.value)}
              >
                <option value="">
                  {loadingGroups
                    ? "Loading groups…"
                    : adminGroups.length
                      ? "Choose a group"
                      : "No groups where you are admin"}
                </option>
                {adminGroups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} · {g.memberCount} members
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="text-button"
                disabled={!connected || loadingGroups}
                onClick={() => void loadGroups()}
              >
                ↻ Refresh
              </button>
            </div>
            {groupError ? <p className="inline-error">{groupError}</p> : null}
            <label htmlFor="membersCsv">Members CSV</label>
            <input
              id="membersCsv"
              className="visually-hidden"
              type="file"
              accept=".csv,.tsv,.txt,text/csv"
              onChange={(e) => {
                void load(e.target.files?.[0]);
                // Lets the same file be chosen again after editing it.
                e.target.value = "";
              }}
            />
            <label htmlFor="membersCsv" className="file-picker">
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
                    <label htmlFor="memberPhoneCol">Phone number column</label>
                    <select
                      id="memberPhoneCol"
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
                    <label htmlFor="memberCountryCode">Country code</label>
                    <input
                      id="memberCountryCode"
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
              </>
            ) : null}
            <PaceChooser
              id="importPace"
              label={`Wait between each batch of ${batchSize}`}
              minDelay={minDelay}
              maxDelay={maxDelay}
              onChange={(min, max) => {
                setMinDelay(min);
                setMaxDelay(max);
              }}
            />
          </div>
          <div className="phone-preview">
            <span className="eyebrow">SUMMARY</span>
            {csv ? (
              <p className="muted">
                <strong>{ready.length}</strong> ready to add
                {group ? ` to ${group.name}` : ""}
                {attention ? ` · ${attention} need attention` : ""}
                {excluded.size ? ` · ${excluded.size} left out` : ""}. Takes{" "}
                {estimate}, {batchSize} people per request.
              </p>
            ) : (
              <p className="muted">
                Each person in your file appears below once you choose it.
              </p>
            )}
            <small>
              Adding many strangers quickly can get a number restricted. Import
              lists of people who expect to join, such as registered attendees.
            </small>
          </div>
        </div>
        <div className="send-bar">
          {confirming ? (
            <div className="confirm-box" role="alertdialog">
              <strong>
                Add {ready.length} {ready.length === 1 ? "person" : "people"} to{" "}
                {group?.name}?
              </strong>
              <p>
                They are added {batchSize} at a time over {estimate}. Keep Wagate open until it finishes.
                Each person sees that you added them.
              </p>
              <div className="button-row">
                <button
                  disabled={busy || !!blocker}
                  onClick={() => void start()}
                >
                  Add {ready.length} now
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
                Review and add{ready.length ? ` ${ready.length}` : ""}
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
            <strong>People</strong>
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
                  <th>NOTE</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.index}
                    className={r.issue || excluded.has(r.index) ? "skipped" : ""}
                  >
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Include row ${r.index + 1}`}
                        disabled={!!r.issue}
                        checked={!r.issue && !excluded.has(r.index)}
                        onChange={() => toggle(r.index)}
                      />
                    </td>
                    <td>{r.index + 1}</td>
                    <td>{r.label || "—"}</td>
                    <td>{r.phone ? "+" + r.phone : "—"}</td>
                    <td className={r.issue ? "note-bad" : ""}>
                      {r.issue || (excluded.has(r.index) ? "Left out" : "")}
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
function count(job: GroupImport, status: GroupImportMember["status"]) {
  return job.members.filter((m) => m.status === status).length;
}
function ImportCard({
  job,
  busy,
  act,
  open,
  toggle,
}: {
  job: GroupImport;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  open: boolean;
  toggle: () => void;
}) {
  const total = job.members.length;
  const done = total - count(job, "pending");
  const action = (path: string, method = "POST") =>
    void act(() => request(`/internal/group-imports/${job.id}${path}`, method));
  return (
    <article className={"panel broadcast-card" + (open ? " active" : "")}>
      <div className="broadcast-card-head">
        <strong title={job.groupName}>{job.groupName}</strong>
        <span
          className={
            "status " +
            (job.status === "running" || job.status === "completed"
              ? "online"
              : "")
          }
        >
          {importStatus[job.status]}
        </span>
      </div>
      <div
        className="progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
      >
        <span style={{ width: `${(done / total) * 100}%` }} />
      </div>
      <small>
        {count(job, "added")} of {total} added
        {count(job, "already") ? ` · ${count(job, "already")} already in` : ""}
        {count(job, "invite") ? ` · ${count(job, "invite")} need invite` : ""}
        {count(job, "failed") ? ` · ${count(job, "failed")} not added` : ""}
        {count(job, "cancelled") ? ` · ${count(job, "cancelled")} skipped` : ""}{" "}
        · {job.minDelay}–{job.maxDelay} s apart · {new Date(job.createdAt).toLocaleString()}
      </small>
      {job.error ? <p className="inline-error">{job.error}</p> : null}
      <div className="button-row">
        {job.status === "running" ? (
          <button
            className="text-button danger"
            disabled={busy}
            onClick={() => action("/cancel")}
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
        <button className="text-button" aria-expanded={open} onClick={toggle}>
          {open ? "Hide results" : "View results"}
        </button>
      </div>
    </article>
  );
}
function ImportResults({ job }: { job: GroupImport }) {
  const [copied, setCopied] = useState(false),
    [error, setError] = useState("");
  const invites = job.members.filter((m) => m.status === "invite");
  return (
    <section className="panel">
      <div className="table-heading">
        <strong>{job.groupName}: results</strong>
        {invites.length ? (
          <button
            className="text-button"
            onClick={() =>
              void navigator.clipboard
                .writeText(invites.map((m) => "+" + m.phone).join("\n"))
                .then(() => setCopied(true))
                .catch(() => setError("Copying failed."))
            }
          >
            {copied
              ? "Copied"
              : `Copy ${invites.length} ${invites.length === 1 ? "number" : "numbers"} that need an invite`}
          </button>
        ) : null}
      </div>
      {error ? <p className="inline-error">{error}</p> : null}
      <div className="table-wrap">
        <table className="recipients-table">
          <thead>
            <tr>
              <th>#</th>
              <th>NAME</th>
              <th>NUMBER</th>
              <th>STATUS</th>
              <th>NOTE</th>
            </tr>
          </thead>
          <tbody>
            {job.members.map((m, i) => (
              <tr key={m.phone}>
                <td>{i + 1}</td>
                <td>{m.label}</td>
                <td>+{m.phone}</td>
                <td className={memberClass[m.status] ?? ""}>
                  {memberStatus[m.status]}
                </td>
                <td>{m.error ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
