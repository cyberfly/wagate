import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { chatTitle, request, type Chat } from "../lib/api";
interface Props {
  chat: Chat;
  /** Where the menu opens: the pointer, or a corner of the button that opened it. */
  at: { x: number; y: number };
  connected: boolean;
  busy: boolean;
  close: () => void;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  notify: (text: string, kind?: "info" | "error") => void;
  /** Called before a chat is marked unread, so an open chat can step aside. */
  beforeUnread: (chat: Chat) => void;
  /** Blocking and deleting ask first. */
  confirm: (kind: "block" | "delete", chat: Chat) => void;
}
/** What can be done to a whole chat: read state, mute, archive, pin, block, delete. */
export function ChatMenu({ chat, at, connected, busy, close, act, notify, beforeUnread, confirm }: Props) {
  const menu = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState(at);
  // Kept inside the window, whichever corner it opened from.
  useLayoutEffect(() => {
    const el = menu.current;
    if (!el) return;
    setPlace({
      x: Math.max(8, Math.min(at.x, window.innerWidth - el.offsetWidth - 8)),
      y: Math.max(8, Math.min(at.y, window.innerHeight - el.offsetHeight - 8)),
    });
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [at.x, at.y]);
  useEffect(() => {
    const outside = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node)) close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
      const now = items.indexOf(document.activeElement as HTMLButtonElement);
      items[(now + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    };
    window.addEventListener("mousedown", outside);
    window.addEventListener("keydown", key);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", outside);
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", close);
    };
  }, [close]);
  const path = "/internal/chats/" + encodeURIComponent(chat.id);
  const run = (work: () => Promise<unknown>, done?: string) => {
    close();
    void act(async () => {
      await work();
      if (done) notify(done);
    });
  };
  const off = !connected || busy;
  const title = chatTitle(chat);
  return (
    <div
      ref={menu}
      className="chat-menu"
      role="menu"
      aria-label={"Actions for " + title}
      style={{ left: place.x, top: place.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {chat.unreadCount ? (
        <button role="menuitem" disabled={busy} onClick={() => run(() => request(path + "/read", "POST"))}>
          Mark as read
        </button>
      ) : (
        <button
          role="menuitem"
          disabled={off}
          onClick={() => {
            beforeUnread(chat);
            run(() => request(path + "/unread", "POST"));
          }}
        >
          Mark as unread
        </button>
      )}
      <button role="menuitem" disabled={busy} onClick={() => run(() => request(path + "/pin", "PUT", { pinned: !chat.pinned }))}>
        {chat.pinned ? "Unpin" : "Pin"}
      </button>
      {chat.muted ? (
        <button role="menuitem" disabled={off} onClick={() => run(() => request(path + "/mute", "PUT", { mute: "off" }), "Unmuted " + title)}>
          Unmute
        </button>
      ) : (
        (
          [
            ["8h", "Mute for 8 hours"],
            ["1w", "Mute for 1 week"],
            ["always", "Mute always"],
          ] as const
        ).map(([mute, label]) => (
          <button key={mute} role="menuitem" disabled={off} onClick={() => run(() => request(path + "/mute", "PUT", { mute }), "Muted " + title)}>
            {label}
          </button>
        ))
      )}
      <button
        role="menuitem"
        disabled={off}
        onClick={() =>
          run(
            () => request(path + "/archive", "PUT", { archived: !chat.archived }),
            chat.archived ? "Unarchived " + title : "Archived " + title,
          )
        }
      >
        {chat.archived ? "Unarchive" : "Archive"}
      </button>
      {chat.type === "direct" ? (
        chat.blocked ? (
          <button role="menuitem" disabled={off} onClick={() => run(() => request(path + "/block", "PUT", { blocked: false }), "Unblocked " + title)}>
            Unblock
          </button>
        ) : (
          <button role="menuitem" className="danger" disabled={off} onClick={() => (close(), confirm("block", chat))}>
            Block…
          </button>
        )
      ) : null}
      <button role="menuitem" className="danger" disabled={off} onClick={() => (close(), confirm("delete", chat))}>
        Delete chat…
      </button>
      {connected ? null : <small>Connect WhatsApp to change chats.</small>}
    </div>
  );
}
