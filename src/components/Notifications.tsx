import { useEffect, useState } from "react";
import { request } from "../lib/api";
interface Preferences {
  notifications: boolean;
  preview: boolean;
  presence: boolean;
}
/** App-wide choices for new-message notifications, saved as they change. */
export function Notifications() {
  const [prefs, setPrefs] = useState<Preferences | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    request<Preferences>("/internal/preferences")
      .then(setPrefs)
      .catch((e) => setError(String(e)));
  }, []);
  const change = (patch: Partial<Preferences>) => {
    if (!prefs) return;
    const before = prefs;
    setPrefs({ ...prefs, ...patch });
    setError("");
    request<Preferences>("/internal/preferences", "PUT", patch)
      .then(setPrefs)
      .catch((e) => {
        setPrefs(before);
        setError(String(e));
      });
  };
  return (
    <section className="panel notification-settings">
      <h3>Notifications</h3>
      <p className="muted">
        Wagate keeps receiving messages after you close its window. New
        messages for every number notify you unless the chat is muted or
        archived on WhatsApp. Use Quit to stop Wagate completely.
      </p>
      <label className="checkbox">
        <input
          type="checkbox"
          disabled={!prefs}
          checked={prefs?.notifications ?? true}
          onChange={(e) => change({ notifications: e.target.checked })}
        />
        Notify me about new messages
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          disabled={!prefs || !prefs.notifications}
          checked={prefs?.preview ?? true}
          onChange={(e) => change({ preview: e.target.checked })}
        />
        Show the sender and message text
      </label>
      <h3>Online and typing</h3>
      <p className="muted">
        While a chat is open in front of you, WhatsApp shows you as online and
        as typing, and tells you the same about the other person. Your phone
        may stay quiet for new messages meanwhile. Turn this off to stay
        offline; you will then not see when others are online or typing.
      </p>
      <label className="checkbox">
        <input
          type="checkbox"
          disabled={!prefs}
          checked={prefs?.presence ?? true}
          onChange={(e) => change({ presence: e.target.checked })}
        />
        Show when I am online and typing
      </label>
      {error ? (
        <p role="alert" className="inline-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
