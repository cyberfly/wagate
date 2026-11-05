import { useState } from "react";
import {
  initials,
  profileNumber,
  request,
  statusLabel,
  type Profile,
} from "../lib/api";
import { profileTone } from "./ProfileSwitcher";
/** Every WhatsApp number in the app: add, rename, open, or remove one. */
export function Profiles({
  profiles,
  active,
  busy,
  act,
  select,
  created,
}: {
  profiles: Profile[];
  active: string;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  select: (id: string) => void;
  created: (profile: Profile) => void;
}) {
  const [name, setName] = useState(""),
    [editing, setEditing] = useState<string | null>(null),
    [rename, setRename] = useState(""),
    [removing, setRemoving] = useState<string | null>(null),
    [notice, setNotice] = useState("");
  return (
    <section className="panel profiles-panel" aria-labelledby="profilesTitle">
      <div className="profiles-head">
        <div>
          <span className="eyebrow">MULTIPLE NUMBERS</span>
          <h2 id="profilesTitle">Your WhatsApp numbers</h2>
          <p className="muted">
            Each number is a separate profile with its own chats, broadcasts,
            group automations and session. Switch between them from the top of
            the sidebar.
          </p>
        </div>
        <form
          className="profile-create"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const profile = await request<Profile>(
                "/internal/profiles",
                "POST",
                { name },
              );
              setName("");
              created(profile);
            });
          }}
        >
          <label htmlFor="profileName">Add a number</label>
          <div className="profile-create-row">
            <input
              id="profileName"
              required
              maxLength={40}
              placeholder="Name, such as Shop"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button disabled={busy || !name.trim()}>Add</button>
          </div>
        </form>
      </div>
      {notice ? (
        <div className="alert warning" role="status">
          <span>{notice}</span>
          <button className="text-button" onClick={() => setNotice("")}>
            Dismiss
          </button>
        </div>
      ) : null}
      <ul className="profile-list">
        {profiles.map((p) => (
          <li
            key={p.id}
            className={"profile-row" + (p.id === active ? " active" : "")}
          >
            <span className="profile-avatar" aria-hidden="true">
              {initials(p.name)}
              <i className={"dot " + profileTone(p)} />
            </span>
            {editing === p.id ? (
              <form
                className="profile-rename"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(async () => {
                    await request("/internal/profiles/" + p.id, "PUT", {
                      name: rename,
                    });
                    setEditing(null);
                  });
                }}
              >
                <input
                  aria-label={`New name for ${p.name}`}
                  autoFocus
                  required
                  maxLength={40}
                  value={rename}
                  onChange={(e) => setRename(e.target.value)}
                />
                <button disabled={busy || !rename.trim()}>Save</button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setEditing(null)}
                >
                  Cancel
                </button>
              </form>
            ) : (
              <div className="profile-text">
                <strong>
                  {p.name}
                  {p.isDefault ? <span className="chip">Main</span> : null}
                  {p.id === active ? (
                    <span className="chip active">Open</span>
                  ) : null}
                </strong>
                <small>
                  {profileNumber(p)} ·{" "}
                  {p.error ? "Unavailable" : statusLabel[p.status]}
                </small>
                {p.error ? (
                  <small className="inline-error">{p.error}</small>
                ) : null}
              </div>
            )}
            {editing !== p.id ? (
              <div className="profile-actions">
                {p.id !== active ? (
                  <button
                    className="secondary"
                    disabled={!!p.error}
                    onClick={() => select(p.id)}
                  >
                    Open
                  </button>
                ) : null}
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => {
                    setRemoving(null);
                    setRename(p.name);
                    setEditing(p.id);
                  }}
                >
                  Rename
                </button>
                {!p.isDefault ? (
                  <button
                    className="text-button danger"
                    disabled={busy}
                    onClick={() => {
                      setEditing(null);
                      setRemoving(p.id);
                    }}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            ) : null}
            {removing === p.id ? (
              // window.confirm is a no-op in the Tauri webview, so confirm in-app.
              <div className="confirm-box" role="alertdialog">
                <strong>Remove “{p.name}”?</strong>
                <p>
                  Its chats, messages, broadcasts, group automations and
                  WhatsApp session are deleted from this computer. API keys
                  limited to it stop working.{" "}
                  {p.status === "connected"
                    ? "Wagate also unlinks it from the phone."
                    : p.account
                      ? "It is not connected, so also remove it from Linked Devices on the phone."
                      : null}
                </p>
                <div className="button-row">
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        const result = await request<{ unlinked: boolean }>(
                          "/internal/profiles/" + p.id,
                          "DELETE",
                        );
                        setRemoving(null);
                        if (p.id === active) select(profiles[0].id);
                        if (!result.unlinked && p.account)
                          setNotice(
                            `“${p.name}” is removed from Wagate. On the phone for ${profileNumber(p)}, open Linked Devices and log out of this computer.`,
                          );
                      })
                    }
                  >
                    Remove number
                  </button>
                  <button
                    className="secondary"
                    onClick={() => setRemoving(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
