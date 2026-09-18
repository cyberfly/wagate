import { useCallback, useEffect, useState } from "react";
import {
  request,
  initials,
  type GroupInfo,
  type GroupAutomation as Config,
  type GroupAutomationInput,
  type AutomationPost,
} from "../lib/api";

interface Props {
  configurations: Config[];
  posts: AutomationPost[];
  connected: boolean;
  aiReady: boolean;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  openSettings: () => void;
}
const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const automationDefaults: GroupAutomationInput = {
  topics: "",
  instructions: "",
  source: "mixed",
  delivery: "approval",
  timeZone: "Asia/Kuala_Lumpur",
  schedule: { kind: "weekly", weekdays: [1, 3, 5], times: ["09:00"] },
  enabled: false,
};
function scheduledTime(c: Config) {
  return c.nextRunAt
    ? new Date(c.nextRunAt).toLocaleString(undefined, {
        timeZone: c.timeZone,
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Paused";
}
export function GroupAutomation(p: Props) {
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState<GroupAutomationInput>(automationDefaults);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState(false);
  const loadGroups = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await request<{ groups: GroupInfo[] }>("/internal/groups");
      setGroups(data.groups);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (p.connected) void loadGroups();
  }, [p.connected, loadGroups]);
  const current = p.configurations.find((c) => c.chatId === selected);
  useEffect(() => {
    setForm(
      current
        ? {
            topics: current.topics,
            instructions: current.instructions,
            source: current.source,
            delivery: current.delivery,
            timeZone: current.timeZone,
            schedule: current.schedule,
            enabled: current.enabled,
          }
        : {
            ...automationDefaults,
            schedule: { ...automationDefaults.schedule },
          },
    );
  }, [selected, current?.updatedAt]);
  useEffect(() => {
    setSaved(false);
  }, [selected]);
  const group = groups.find((g) => g.id === selected);
  const adminGroups = groups.filter((g) => g.isAdmin);
  const eligible = !!group?.isAdmin;
  const update = (patch: Partial<GroupAutomationInput>) => {
    setForm((f) => ({ ...f, ...patch }));
    setSaved(false);
  };
  const groupPosts = p.posts.filter((post) => post.chatId === selected);
  const pending = groupPosts.filter((post) => post.status === "pending");
  const working = groupPosts.some(
    (post) => post.status === "generating" || post.status === "sending",
  );
  const addable = adminGroups.filter(
    (g) => !p.configurations.some((c) => c.chatId === g.id),
  );
  return (
    <div className="automation-page">
      <div className="automation-intro">
        <div>
          <h2>A posting plan for every group</h2>
          <p>
            Choose your groups. Set their topics, rhythm, and how much you want
            to review.
          </p>
        </div>
        <button
          className="secondary"
          disabled={!p.connected || loading || p.busy}
          onClick={() => {
            setChosen(new Set());
            setAdding(!adding);
          }}
        >
          ＋ Select groups
        </button>
      </div>
      <div className="automation-runtime">
        ◷ Keep Wagate open and WhatsApp connected for scheduled posts. Missed
        times are skipped; they won’t all post when you reconnect.
      </div>
      {!p.aiReady ? (
        <div className="automation-callout">
          <span>
            Add your OpenRouter key to generate posts and enable schedules.
          </span>
          <button className="secondary" onClick={p.openSettings}>
            AI settings ↗
          </button>
        </div>
      ) : null}
      {!p.connected ? (
        <p className="inline-error">
          Connect WhatsApp to choose admin groups, edit settings, and send
          posts. You can still pause schedules.
        </p>
      ) : null}
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
      {adding ? (
        <section className="panel group-picker">
          <div className="automation-section-title">
            <h3>Select groups you administer</h3>
            <button
              className="text-button"
              disabled={loading}
              onClick={() => void loadGroups()}
            >
              ↻ Refresh groups
            </button>
          </div>
          {addable.length ? (
            addable.map((g) => (
              <label key={g.id} className="group-choice">
                <input
                  type="checkbox"
                  checked={chosen.has(g.id)}
                  onChange={(e) =>
                    setChosen((old) => {
                      const next = new Set(old);
                      if (e.target.checked) next.add(g.id);
                      else next.delete(g.id);
                      return next;
                    })
                  }
                />
                <span>
                  <strong>{g.name}</strong>
                  <small>{g.memberCount} members</small>
                </span>
              </label>
            ))
          ) : (
            <p className="muted">
              {loading
                ? "Loading groups…"
                : "No new admin groups to add. Existing groups are listed below."}
            </p>
          )}
          <div className="button-row">
            <button
              disabled={p.busy || !p.connected || !chosen.size}
              onClick={() =>
                void p.act(async () => {
                  for (const id of chosen)
                    await request(
                      "/internal/automations/" + encodeURIComponent(id),
                      "PUT",
                      {
                        ...automationDefaults,
                        topics:
                          "Helpful tips and recent updates for this community",
                        enabled: false,
                      },
                    );
                  setSelected([...chosen][0]);
                  setAdding(false);
                  setChosen(new Set());
                })
              }
            >
              Add {chosen.size || "selected"} groups
            </button>
            <button className="text-button" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <small>
              New groups start paused. Set their topics before enabling.
            </small>
          </div>
        </section>
      ) : null}
      <div className="automation-layout">
        <aside className="panel automation-groups">
          <div className="automation-section-title">
            <strong>
              Your groups{" "}
              <span className="count">{p.configurations.length}</span>
            </strong>
          </div>
          {p.configurations.map((c) => {
            const reviews = p.posts.filter(
              (post) => post.chatId === c.chatId && post.status === "pending",
            ).length;
            return (
              <button
                className={
                  "automation-group " +
                  (selected === c.chatId ? "selected" : "")
                }
                aria-pressed={selected === c.chatId}
                key={c.chatId}
                onClick={() => setSelected(c.chatId)}
              >
                <span className="avatar">{initials(c.groupName)}</span>
                <span>
                  <strong>{c.groupName}</strong>
                  <small>
                    {c.enabled
                      ? c.delivery === "automatic"
                        ? "Automatic posting"
                        : "Review before posting"
                      : "Paused"}
                    {reviews ? ` · ${reviews} to review` : ""}
                  </small>
                  <small>Next: {scheduledTime(c)}</small>
                </span>
                <span className={"dot " + (c.enabled ? "" : "bad")} />
              </button>
            );
          })}
          {!p.configurations.length ? (
            <div className="list-empty">
              <p>No groups selected yet</p>
              <small>
                Use “Select groups” to choose the groups where you’re an admin.
              </small>
            </div>
          ) : null}
        </aside>
        <div className="automation-detail">
          {selected ? (
            <>
              <form
                className="panel automation-editor"
                onSubmit={(e) => {
                  e.preventDefault();
                  void p.act(async () => {
                    await request(
                      "/internal/automations/" + encodeURIComponent(selected),
                      "PUT",
                      form,
                    );
                    setSaved(true);
                  });
                }}
              >
                <div className="automation-section-title">
                  <div>
                    <span className="eyebrow">GROUP SETTINGS</span>
                    <h2>{current?.groupName || group?.name}</h2>
                  </div>
                  {current ? (
                    <button
                      type="button"
                      className="secondary"
                      disabled={
                        p.busy ||
                        (!current.enabled &&
                          (!p.connected || !p.aiReady || !eligible))
                      }
                      onClick={() =>
                        void p.act(() =>
                          request(
                            "/internal/automations/" +
                              encodeURIComponent(selected) +
                              (current.enabled ? "/pause" : "/resume"),
                            "POST",
                          ),
                        )
                      }
                    >
                      {current.enabled ? "Pause schedule" : "Resume schedule"}
                    </button>
                  ) : null}
                </div>
                {p.connected && !loading && !eligible ? (
                  <p className="inline-error">
                    You no longer have admin access to this group. Its settings
                    are kept, but posting is blocked.
                  </p>
                ) : null}
                <label htmlFor="automation-topics">
                  What should this group receive?
                </label>
                <textarea
                  id="automation-topics"
                  rows={3}
                  required
                  maxLength={4000}
                  value={form.topics}
                  onChange={(e) => update({ topics: e.target.value })}
                  placeholder="AI tools for small businesses, practical marketing tips, and relevant Malaysian tech news"
                />
                <label htmlFor="automation-instructions">
                  Style, language, and audience
                </label>
                <textarea
                  id="automation-instructions"
                  rows={2}
                  maxLength={4000}
                  value={form.instructions}
                  onChange={(e) => update({ instructions: e.target.value })}
                  placeholder="Write in Bahasa Melayu. Keep it under 150 words. Friendly and practical. End with one question. Avoid sales pitches."
                />
                <div className="automation-fields">
                  <div>
                    <label htmlFor="automation-source">Content</label>
                    <select
                      id="automation-source"
                      value={form.source}
                      onChange={(e) =>
                        update({
                          source: e.target
                            .value as GroupAutomationInput["source"],
                        })
                      }
                    >
                      <option value="original">
                        Original tips and discussion posts
                      </option>
                      <option value="news">
                        Current news with source links
                      </option>
                      <option value="mixed">
                        News + original practical takeaways
                      </option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="automation-delivery">Posting mode</label>
                    <select
                      id="automation-delivery"
                      value={form.delivery}
                      onChange={(e) =>
                        update({
                          delivery: e.target
                            .value as GroupAutomationInput["delivery"],
                        })
                      }
                    >
                      <option value="approval">Require my approval</option>
                      <option value="automatic">Post automatically</option>
                    </select>
                  </div>
                </div>
                <small>
                  {form.source !== "original"
                    ? "News uses live web search through OpenRouter, includes source links, and may use additional credits."
                    : "AI creates an original post using your topics and instructions."}
                </small>
                <div className="automation-fields">
                  <div>
                    <label htmlFor="automation-schedule">Schedule</label>
                    <select
                      id="automation-schedule"
                      value={form.schedule.kind}
                      onChange={(e) =>
                        update({
                          schedule:
                            e.target.value === "weekly"
                              ? {
                                  kind: "weekly",
                                  weekdays: [1, 3, 5],
                                  times: ["09:00"],
                                }
                              : {
                                  kind: "interval",
                                  everyHours: 4,
                                  startTime: "09:00",
                                  endTime: "21:00",
                                },
                        })
                      }
                    >
                      <option value="weekly">Chosen weekdays and times</option>
                      <option value="interval">Every few hours</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="automation-timezone">Time zone</label>
                    <input
                      id="automation-timezone"
                      list="automation-timezones"
                      required
                      value={form.timeZone}
                      onChange={(e) => update({ timeZone: e.target.value })}
                    />
                    <datalist id="automation-timezones">
                      <option value="Asia/Kuala_Lumpur" />
                      <option value="Asia/Singapore" />
                      <option value="Asia/Jakarta" />
                      <option value="Europe/London" />
                      <option value="America/New_York" />
                      <option value="UTC" />
                    </datalist>
                  </div>
                </div>
                {form.schedule.kind === "weekly" ? (
                  <>
                    <label>Posting days</label>
                    <div
                      className="weekday-picker"
                      aria-label="Posting weekdays"
                    >
                      {days.map((day, index) => {
                        const s = form.schedule;
                        if (s.kind !== "weekly") return null;
                        return (
                          <button
                            type="button"
                            key={day}
                            className={
                              s.weekdays.includes(index) ? "active" : ""
                            }
                            aria-pressed={s.weekdays.includes(index)}
                            onClick={() =>
                              update({
                                schedule: {
                                  ...s,
                                  weekdays: s.weekdays.includes(index)
                                    ? s.weekdays.filter((d) => d !== index)
                                    : [...s.weekdays, index].sort(),
                                },
                              })
                            }
                          >
                            {day}
                          </button>
                        );
                      })}
                    </div>
                    <label>Posting times</label>
                    <div className="posting-times">
                      {form.schedule.times.map((time, i) => (
                        <div key={i}>
                          <input
                            type="time"
                            aria-label={`Posting time ${i + 1}`}
                            required
                            value={time}
                            onChange={(e) => {
                              const s = form.schedule;
                              if (s.kind === "weekly")
                                update({
                                  schedule: {
                                    ...s,
                                    times: s.times.map((t, n) =>
                                      n === i ? e.target.value : t,
                                    ),
                                  },
                                });
                            }}
                          />
                          <button
                            type="button"
                            className="text-button"
                            aria-label={`Remove posting time ${i + 1}`}
                            disabled={
                              form.schedule.kind !== "weekly" ||
                              form.schedule.times.length === 1
                            }
                            onClick={() => {
                              const s = form.schedule;
                              if (s.kind === "weekly")
                                update({
                                  schedule: {
                                    ...s,
                                    times: s.times.filter((_, n) => n !== i),
                                  },
                                });
                            }}
                          >
                            ×
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        className="secondary"
                        disabled={form.schedule.times.length >= 12}
                        onClick={() => {
                          const s = form.schedule;
                          if (s.kind === "weekly")
                            update({
                              schedule: { ...s, times: [...s.times, "18:00"] },
                            });
                        }}
                      >
                        ＋ Add time
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="automation-fields interval-fields">
                    <div>
                      <label htmlFor="automation-hours">Every (hours)</label>
                      <input
                        id="automation-hours"
                        type="number"
                        min={1}
                        max={168}
                        required
                        value={form.schedule.everyHours}
                        onChange={(e) => {
                          const s = form.schedule;
                          if (s.kind === "interval")
                            update({
                              schedule: {
                                ...s,
                                everyHours: Number(e.target.value),
                              },
                            });
                        }}
                      />
                    </div>
                    <div>
                      <label htmlFor="automation-start">
                        Posting starts at
                      </label>
                      <input
                        id="automation-start"
                        type="time"
                        required
                        value={form.schedule.startTime}
                        onChange={(e) => {
                          const s = form.schedule;
                          if (s.kind === "interval")
                            update({
                              schedule: { ...s, startTime: e.target.value },
                            });
                        }}
                      />
                    </div>
                    <div>
                      <label htmlFor="automation-end">Posting stops at</label>
                      <input
                        id="automation-end"
                        type="time"
                        required
                        value={form.schedule.endTime}
                        onChange={(e) => {
                          const s = form.schedule;
                          if (s.kind === "interval")
                            update({
                              schedule: { ...s, endTime: e.target.value },
                            });
                        }}
                      />
                    </div>
                  </div>
                )}
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(e) => update({ enabled: e.target.checked })}
                  />
                  Enable schedule for this group
                </label>
                <p className="automation-mode-note">
                  {form.delivery === "automatic"
                    ? "At each scheduled time, AI generates a post and sends it straight to this group. You can pause at any time."
                    : "At each scheduled time, AI prepares a draft. Edit it and approve before anything is sent. New slots are skipped while a draft is waiting."}
                </p>
                <div className="button-row">
                  <button
                    type="submit"
                    disabled={
                      p.busy ||
                      !p.connected ||
                      !eligible ||
                      (form.enabled && !p.aiReady)
                    }
                  >
                    {form.enabled
                      ? "Save and enable schedule"
                      : "Save settings"}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={
                      p.busy ||
                      !current ||
                      !p.connected ||
                      !eligible ||
                      !p.aiReady ||
                      pending.length > 0 ||
                      working
                    }
                    onClick={() =>
                      void p.act(() =>
                        request(
                          "/internal/automations/" +
                            encodeURIComponent(selected) +
                            "/preview",
                          "POST",
                        ),
                      )
                    }
                  >
                    {working ? "Working…" : "Generate preview"}
                  </button>
                  {saved ? (
                    <span className="saved" role="status">
                      ✓ Saved
                    </span>
                  ) : null}
                </div>
                <small>
                  Preview uses your saved settings and always waits for
                  approval, even in automatic mode.
                </small>
              </form>
              {pending.map((post) => (
                <ReviewPost
                  key={post.id}
                  post={post}
                  busy={p.busy}
                  canSend={p.connected && eligible}
                  act={p.act}
                />
              ))}
              <section className="panel automation-history">
                <div className="automation-section-title">
                  <h3>Posting history</h3>
                  <small>
                    {current?.enabled
                      ? `Next: ${scheduledTime(current)} · ${current.timeZone}`
                      : "Schedule paused"}
                  </small>
                </div>
                {groupPosts.filter((post) => post.status !== "pending")
                  .length ? (
                  groupPosts
                    .filter((post) => post.status !== "pending")
                    .map((post) => (
                      <details
                        key={post.id}
                        className="automation-history-item"
                      >
                        <summary>
                          <span className={"post-status post-" + post.status}>
                            {post.status}
                          </span>
                          <time>
                            {new Date(post.createdAt).toLocaleString()}
                          </time>
                          <span>
                            {post.text.slice(0, 90) ||
                              post.error ||
                              "Generating a post…"}
                          </span>
                        </summary>
                        {post.text ? <p>{post.text}</p> : null}
                        {post.error ? (
                          <p className="inline-error">{post.error}</p>
                        ) : null}
                      </details>
                    ))
                ) : (
                  <p className="muted">
                    No posts yet. Generate a preview to try this group’s
                    instructions.
                  </p>
                )}
              </section>
            </>
          ) : (
            <div className="panel automation-empty">
              <span className="empty-icon">◷</span>
              <h2>Your groups, on a rhythm</h2>
              <p>
                Select groups above, then choose a group to set its topics and
                schedule.
              </p>
              <small>
                Each group has its own settings. Nothing is posted until you
                enable a schedule or approve a draft.
              </small>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
function ReviewPost({
  post,
  busy,
  canSend,
  act,
}: {
  post: AutomationPost;
  busy: boolean;
  canSend: boolean;
  act: Props["act"];
}) {
  const [text, setText] = useState(post.text);
  return (
    <section className="panel automation-review">
      <div className="automation-section-title">
        <h3>Review for {post.groupName}</h3>
        <span className="post-status post-pending">Awaiting approval</span>
      </div>
      <textarea
        aria-label={"Post draft for " + post.groupName}
        rows={6}
        maxLength={10000}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="button-row">
        <button
          disabled={busy || !canSend || !text.trim()}
          onClick={() =>
            void act(() =>
              request(
                "/internal/automation-posts/" + post.id + "/approve",
                "POST",
                { text },
              ),
            )
          }
        >
          Approve & post to group
        </button>
        <button
          className="secondary"
          disabled={busy}
          onClick={() =>
            void act(() =>
              request("/internal/automation-posts/" + post.id, "DELETE"),
            )
          }
        >
          Dismiss
        </button>
        <small>This sends to {post.groupName} immediately.</small>
      </div>
    </section>
  );
}
