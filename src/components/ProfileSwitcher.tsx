import { useEffect, useRef, useState } from "react";
import {
  initials,
  profileNumber,
  request,
  statusLabel,
  type Profile,
} from "../lib/api";
/** A status dot: green when connected, amber while it needs you, red on errors. */
export function profileTone(profile: Pick<Profile, "status" | "error">) {
  if (profile.error || profile.status === "auth_error") return "bad";
  if (profile.status === "connected") return "";
  if (profile.status === "qr_required") return "attention";
  return "idle";
}
/**
 * The sidebar control for choosing which WhatsApp number the app works with,
 * and for adding another one.
 */
export function ProfileSwitcher({
  profiles,
  active,
  busy,
  select,
  created,
  manage,
}: {
  profiles: Profile[];
  active: Profile | undefined;
  busy: boolean;
  select: (id: string) => void;
  /** Called with a new profile, which still needs its QR code scanned. */
  created: (profile: Profile) => void;
  manage: () => void;
}) {
  const [open, setOpen] = useState(false),
    [adding, setAdding] = useState(false),
    [name, setName] = useState(""),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  useEffect(() => {
    if (!open) {
      setAdding(false);
      setName("");
      setError("");
    }
  }, [open]);
  const title = active?.name || "Main";
  return (
    <div className="profile-switcher" ref={root}>
      <button
        type="button"
        className="profile-current"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`WhatsApp number: ${title}. Switch number`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="profile-avatar" aria-hidden="true">
          {initials(title)}
          <i className={"dot " + (active ? profileTone(active) : "idle")} />
        </span>
        <span className="profile-text">
          <strong>{title}</strong>
          <small>{active ? profileNumber(active) : "Starting…"}</small>
        </span>
        <span className="profile-caret" aria-hidden="true">
          ▾
        </span>
        <span className="sidebar-tooltip" role="tooltip">
          {title}
        </span>
      </button>
      {open ? (
        <div className="profile-menu" role="menu">
          <span className="profile-menu-label">WHATSAPP NUMBERS</span>
          {profiles.map((p) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={p.id === active?.id}
              key={p.id}
              className={
                "profile-option" + (p.id === active?.id ? " active" : "")
              }
              onClick={() => {
                select(p.id);
                setOpen(false);
              }}
            >
              <span className="profile-avatar small" aria-hidden="true">
                {initials(p.name)}
                <i className={"dot " + profileTone(p)} />
              </span>
              <span className="profile-text">
                <strong>{p.name}</strong>
                <small>
                  {p.error ? "Unavailable" : statusLabel[p.status]} ·{" "}
                  {profileNumber(p)}
                </small>
              </span>
              {p.id === active?.id ? (
                <span className="profile-check" aria-hidden="true">
                  ✓
                </span>
              ) : null}
            </button>
          ))}
          {adding ? (
            <form
              className="profile-add"
              onSubmit={(e) => {
                e.preventDefault();
                setSaving(true);
                setError("");
                request<Profile>("/internal/profiles", "POST", { name })
                  .then((profile) => {
                    setOpen(false);
                    created(profile);
                  })
                  .catch((e) => setError(String(e).replace(/^Error: /, "")))
                  .finally(() => setSaving(false));
              }}
            >
              <label htmlFor="newProfileName">Name this number</label>
              <input
                id="newProfileName"
                autoFocus
                required
                maxLength={40}
                placeholder="Shop, Support, Personal…"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              {error ? (
                <p className="inline-error" role="alert">
                  {error}
                </p>
              ) : null}
              <div className="button-row">
                <button disabled={saving || busy || !name.trim()}>
                  Add and link
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setAdding(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <div className="profile-menu-actions">
              <button
                type="button"
                className="text-button"
                role="menuitem"
                onClick={() => setAdding(true)}
              >
                ＋ Add WhatsApp number
              </button>
              <button
                type="button"
                className="text-button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  manage();
                }}
              >
                Manage numbers
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
