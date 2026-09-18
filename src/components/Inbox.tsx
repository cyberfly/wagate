import { Fragment, useEffect, useRef, useState } from "react";
import {
  request,
  displayName,
  chatTitle,
  phoneLabel,
  initials,
  type Chat,
  type Message,
  type Draft,
} from "../lib/api";
interface Props {
  chats: Chat[];
  messages: Message[];
  drafts: Draft[];
  selected: string | null;
  select: (id: string | null) => void;
  connect: () => void;
  connected: boolean;
  processing: boolean;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}
/** Time today, otherwise the date, like WhatsApp's chat list. */
function lastActive(ms: number) {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
export function Inbox(p: Props) {
  const [search, setSearch] = useState(""),
    [compositions, setCompositions] = useState<Record<string, string>>({}),
    [recipient, setRecipient] = useState(""),
    [newChat, setNewChat] = useState(false),
    [draftText, setDraftText] = useState(""),
    [filter, setFilter] = useState<"All" | "Pinned" | "Groups" | "Archived">("All");
  const bottom = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const nearBottom = useRef(true);
  const previousChat = useRef<string | null>(null);
  const text = p.selected ? compositions[p.selected] || "" : "";
  const setText = (value: string, id = p.selected) => {
    if (id) setCompositions((current) => ({ ...current, [id]: value }));
  };
  const chat = p.chats.find((c) => c.id === p.selected);
  const draft = p.drafts.find((d) => d.status === "pending");
  useEffect(() => {
    const input = composer.current;
    if (input) {
      input.style.height = "0px";
      input.style.height = Math.min(140, Math.max(42, input.scrollHeight)) + "px";
    }
  }, [text, p.selected]);
  useEffect(() => {
    setDraftText(draft?.text || "");
  }, [draft?.id, draft?.text]);
  useEffect(() => {
    const pane = bottom.current?.parentElement;
    const switched = previousChat.current !== p.selected;
    if (switched || nearBottom.current) {
      pane?.scrollTo({ top: pane.scrollHeight, behavior: "instant" });
      nearBottom.current = true;
    }
    previousChat.current = p.selected;
  }, [p.messages.at(-1)?.id, p.selected]);
  // The sidecar orders effective inbox pins first, then by activity.
  const query = search.trim().toLowerCase();
  const pinnedCount = p.chats.filter((c) => c.pinned).length;
  const found = p.chats.filter((c) => {
    if (!(chatTitle(c) + c.id).toLowerCase().includes(query)) return false;
    if (filter === "Pinned") return c.pinned;
    if (filter === "Archived") return c.archived;
    if (c.archived) return false;
    return filter !== "Groups" || c.type === "group";
  });
  const pin = (c: Chat) => void p.act(() => request(
    "/internal/chats/" + encodeURIComponent(c.id) + "/pin", "PUT", { pinned: !c.pinned },
  ));
  const item = (c: Chat) => (
    <div key={c.id} className={"chat-row " + (c.id === p.selected ? "selected" : "")}>
    <button
      className={"chat-item " + (c.id === p.selected ? "selected" : "")}
      aria-pressed={c.id === p.selected}
      onClick={() => p.select(c.id)}
    >
      <span className="avatar">{initials(chatTitle(c))}</span>
      <span className="chat-info">
        <strong>{chatTitle(c)}</strong>
        <small>
          {c.lastMessage || (c.aiMode === "copilot"
            ? "✧ Copilot enabled"
            : c.type === "group"
              ? "Group conversation"
              : phoneLabel(c.id))}
        </small>
      </span>
      <span className="chat-meta">
        {c.lastMessageAt ? <time>{lastActive(c.lastMessageAt)}</time> : null}
        {c.pinned ? <small>Pinned</small> : null}
      </span>
    </button>
    <button className={"pin-button " + (c.pinned ? "pinned" : "")}
      title={c.pinned ? "Unpin chat" : "Pin chat"}
      aria-label={(c.pinned ? "Unpin " : "Pin ") + chatTitle(c)}
      aria-pressed={c.pinned} disabled={p.busy} onClick={() => pin(c)}>
      <PinIcon />
    </button>
    </div>
  );
  const send = () => {
    if (!p.selected || !text.trim() || p.busy || !p.connected) return;
    const id = p.selected, sentText = text;
    nearBottom.current = true;
    return p.act(async () => {
      await request("/v1/messages/send", "POST", { chatId: id, text: sentText });
      setCompositions((current) => current[id] === sentText ? { ...current, [id]: "" } : current);
    });
  };
  return (
    <section className={"inbox panel " + (p.selected ? "has-selection" : "")}>
      <aside className="chat-list">
        <div className="chat-list-title">
          <strong>
            Chats <span className="count">{p.chats.length}</span>
          </strong>
          <button
            className="icon-button"
            aria-label="New conversation"
            aria-expanded={newChat}
            onClick={() => setNewChat(!newChat)}
          >
            ＋
          </button>
        </div>
        <button className={"inbox-connection " + (p.connected ? "online" : "")}
          onClick={p.connect}>
          <span className={"dot " + (p.connected ? "" : "bad")} />
          {p.connected ? "WhatsApp connected" : "Connect WhatsApp"}
          <span>↗</span>
        </button>
        {newChat ? (
          <form
            className="new-chat"
            onSubmit={(e) => {
              e.preventDefault();
              const id = recipient.trim().replace(/^\+/, "");
              if (/^\d{7,15}$/.test(id)) {
                p.select(id + "@s.whatsapp.net");
                setNewChat(false);
                setRecipient("");
              }
            }}
          >
            <label htmlFor="recipient">International phone number</label>
            <input
              id="recipient"
              placeholder="60123456789"
              required
              pattern="\+?[0-9]{7,15}"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
            />
            <button className="secondary" type="submit">
              Open conversation
            </button>
          </form>
        ) : null}
        <div className="search">
          <input
            aria-label="Search chats"
            placeholder="Search or start a new chat"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="chat-filters" aria-label="Filter chats">
          {(["All", "Pinned", "Groups", "Archived"] as const).map((value) => (
            <button key={value} aria-pressed={filter === value}
              className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>
              {value}{value === "Pinned" ? ` (${pinnedCount})` : ""}
            </button>
          ))}
        </div>
        {filter === "Pinned" ? <div className="pin-hint">Pin as many chats as you like. Saved on this device.</div> : null}
        <div className="chat-items">
          {found.map(item)}
          {p.chats.length > 0 && found.length === 0 ? (
            <div className="list-empty">{query ? "No matching chats" : `No ${filter.toLowerCase()} chats`}</div>
          ) : null}
          {p.chats.length === 0 ? (
            <div className="list-empty">
              <p>No conversations yet</p>
              <small>
                Connect WhatsApp to sync chats, or start a conversation with ＋.
              </small>
            </div>
          ) : null}
        </div>
      </aside>
      <div className="conversation">
        {p.selected ? (
          <>
            <header className="conversation-header">
              <button className="icon-button back-to-chats" aria-label="Back to chats" onClick={() => p.select(null)}>←</button>
              <span className="avatar">{initials(chatTitle(chat ?? { id: p.selected, name: "" }))}</span>
              <div className="conversation-identity">
                <h3>{chatTitle(chat ?? { id: p.selected, name: "" })}</h3>
                <small>
                  {chat?.type === "group"
                    ? "Group"
                    : chat && chat.name !== chat.id
                      ? phoneLabel(chat.id)
                      : "WhatsApp"}{" "}
                  · {p.connected ? "Ready to send" : "Disconnected"}
                </small>
              </div>
              {chat ? <button className={"header-pin icon-button " + (chat.pinned ? "pinned" : "")}
                title={chat.pinned ? "Unpin chat" : "Pin chat"}
                aria-label={chat.pinned ? "Unpin current chat" : "Pin current chat"}
                aria-pressed={chat.pinned} disabled={p.busy} onClick={() => pin(chat)}><PinIcon /></button> : null}
              <label className="mode-picker">
                AI mode
                <select
                  aria-label="AI mode"
                  disabled={p.busy || !chat}
                  value={chat?.aiMode || "off"}
                  onChange={(e) =>
                    void p.act(() =>
                      request(
                        "/internal/chats/" +
                          encodeURIComponent(p.selected!) +
                          "/mode",
                        "PUT",
                        { mode: e.target.value },
                      ),
                    )
                  }
                >
                  <option value="off">Off</option>
                  <option value="copilot">Copilot</option>
                </select>
              </label>
            </header>
            {chat?.aiMode === "copilot" ? (
              <div className="copilot-notice">
                ✧ Copilot sends recent messages to OpenRouter to draft replies.
                You review every send.
              </div>
            ) : null}
            <div className="messages" aria-live="polite" onScroll={(e) => {
              const pane = e.currentTarget;
              nearBottom.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80;
            }}>
              {p.messages.length ? (
                <div className="history-note">
                  Recent messages stored on this device
                </div>
              ) : (
                <div className="list-empty">
                  No stored messages in this conversation.
                </div>
              )}
              {p.messages.map((m, index) => (
                <Fragment key={m.id}>
                  {index === 0 || new Date(p.messages[index - 1].timestamp).toDateString() !== new Date(m.timestamp).toDateString() ? (
                    <div className="message-day">{new Date(m.timestamp).toDateString() === new Date().toDateString() ? "Today" : new Date(m.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</div>
                  ) : null}
                  <MessageBubble message={m} group={chat?.type === "group"} />
                </Fragment>
              ))}
              <div ref={bottom} />
            </div>
            {p.drafts.some((d) => d.status === "uncertain") ? (
              <div className="copilot-notice warning">
                A previous draft’s delivery is uncertain. Check the conversation
                on your phone before sending it again.
              </div>
            ) : null}
            {draft ? (
              <div className="draft-box">
                <div className="draft-label">
                  <strong>✧ Copilot draft</strong>
                  <span>Review before sending</span>
                </div>
                <textarea
                  aria-label="Copilot draft"
                  value={draftText}
                  maxLength={10000}
                  onChange={(e) => setDraftText(e.target.value)}
                />
                <div className="button-row">
                  <button
                    className="secondary"
                    disabled={p.busy}
                    onClick={() =>
                      void p.act(() =>
                        request("/internal/drafts/" + draft.id, "DELETE"),
                      )
                    }
                  >
                    Dismiss
                  </button>
                  <button
                    disabled={p.busy || !p.connected || !draftText.trim()}
                    onClick={() =>
                      void p.act(() =>
                        request(
                          "/internal/drafts/" + draft.id + "/send",
                          "POST",
                          { text: draftText },
                        ),
                      )
                    }
                  >
                    Approve & send
                  </button>
                </div>
              </div>
            ) : chat?.aiMode === "copilot" ? (
              <div className="draft-idle">
                <span>
                  {p.processing
                    ? "✧ Generating a reply…"
                    : "✧ Copilot is ready for the next message"}
                </span>
                <button
                  className="text-button"
                  disabled={p.busy || p.processing}
                  onClick={() =>
                    void p.act(() =>
                      request(
                        "/internal/chats/" +
                          encodeURIComponent(p.selected!) +
                          "/draft",
                        "POST",
                      ),
                    )
                  }
                >
                  Generate draft
                </button>
              </div>
            ) : null}
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <textarea
                ref={composer}
                rows={1}
                aria-label="Message"
                placeholder={
                  p.connected
                    ? "Write a message…"
                    : "Connect WhatsApp to send a message"
                }
                value={text}
                maxLength={10000}
                disabled={!p.connected || p.busy}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    if (text.trim() && !p.busy && p.connected) void send();
                  }
                }}
              />
              <button
                type="submit"
                disabled={p.busy || !p.connected || !text.trim()}
              >
                <span aria-hidden="true">➤</span><span className="visually-hidden">Send message</span>
              </button>
            </form>
          </>
        ) : (
          <div className="conversation-empty">
            <div className="empty-icon">▤</div>
            <h2>Wagate Inbox</h2>
            <p>
              Choose a chat to read messages and reply.
              <br />
              Everything is stored on this device.
            </p>
            <small>Unlimited pinned chats · Enter to send · Shift + Enter for a new line</small>
          </div>
        )}
      </div>
    </section>
  );
}
function PinIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m16 3 5 5-4 1-3 5v3l-7-7h3l5-3zM9 15l-6 6" /></svg>;
}
function MessageBubble({ message: m, group }: { message: Message; group?: boolean }) {
  return (
    <article className={"message " + m.direction}>
      {m.direction === "incoming" && group ? (
        <small>{displayName(m.senderId)}</small>
      ) : null}
      {m.type !== "text" ? (
        <div className="media-label">
          [{m.type} · attachment preview unavailable]
        </div>
      ) : null}
      <p>{m.text}</p>
      <time>
        {new Date(m.timestamp).toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
        })}
        {m.direction === "outgoing" ? " · You" : ""}
      </time>
    </article>
  );
}
