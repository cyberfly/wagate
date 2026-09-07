import { useEffect, useRef, useState } from "react";
import {
  request,
  displayName,
  type Chat,
  type Message,
  type Draft,
} from "../lib/api";
interface Props {
  chats: Chat[];
  messages: Message[];
  drafts: Draft[];
  selected: string | null;
  select: (id: string) => void;
  connected: boolean;
  processing: boolean;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}
export function Inbox(p: Props) {
  const [search, setSearch] = useState(""),
    [text, setText] = useState(""),
    [recipient, setRecipient] = useState(""),
    [newChat, setNewChat] = useState(false),
    [draftText, setDraftText] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const chat = p.chats.find((c) => c.id === p.selected);
  const draft = p.drafts.find((d) => d.status === "pending");
  useEffect(() => {
    setText("");
  }, [p.selected]);
  useEffect(() => {
    setDraftText(draft?.text || "");
  }, [draft?.id, draft?.text]);
  useEffect(() => {
    const pane = bottom.current?.parentElement;
    pane?.scrollTo({ top: pane.scrollHeight, behavior: "smooth" });
  }, [p.messages.at(-1)?.id, p.selected]);
  const send = () =>
    p.act(async () => {
      await request("/v1/messages/send", "POST", { chatId: p.selected, text });
      setText("");
    });
  return (
    <section className="inbox panel">
      <aside className="chat-list">
        <div className="chat-list-title">
          <strong>
            Conversations <span className="count">{p.chats.length}</span>
          </strong>
          <button
            className="icon-button"
            aria-label="New conversation"
            onClick={() => setNewChat(!newChat)}
          >
            ＋
          </button>
        </div>
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
            placeholder="Search conversations…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="chat-items">
          {p.chats
            .filter((c) =>
              (c.name + c.id).toLowerCase().includes(search.toLowerCase()),
            )
            .map((c) => (
              <button
                key={c.id}
                className={
                  "chat-item " + (c.id === p.selected ? "selected" : "")
                }
                onClick={() => p.select(c.id)}
              >
                <span className="avatar">
                  {(c.name === c.id ? displayName(c.id) : c.name)
                    .slice(0, 2)
                    .toUpperCase()}
                </span>
                <span className="chat-info">
                  <strong>
                    {c.name === c.id ? displayName(c.id) : c.name}
                  </strong>
                  <small>
                    {c.aiMode === "copilot"
                      ? "✧ Copilot enabled"
                      : c.type === "group"
                        ? "Group conversation"
                        : displayName(c.id)}
                  </small>
                </span>
                {c.lastMessageAt ? (
                  <time>
                    {new Date(c.lastMessageAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                  </time>
                ) : null}
              </button>
            ))}
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
              <div>
                <h3>
                  {chat?.name && chat.name !== chat.id
                    ? chat.name
                    : displayName(p.selected)}
                </h3>
                <small>
                  {chat?.type === "group" ? "Group" : "WhatsApp"} ·{" "}
                  {p.connected ? "Ready to send" : "Disconnected"}
                </small>
              </div>
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
            <div className="messages" aria-live="polite">
              {p.messages.length ? (
                <div className="history-note">
                  Recent 50 messages · Full stored history is available through
                  the API
                </div>
              ) : (
                <div className="list-empty">
                  No stored messages in this conversation.
                </div>
              )}
              {p.messages.map((m) => (
                <MessageBubble key={m.id} message={m} />
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
                aria-label="Message"
                placeholder={
                  p.connected
                    ? "Write a message…"
                    : "Connect WhatsApp to send a message"
                }
                value={text}
                maxLength={10000}
                disabled={!p.connected}
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
                Send ↗
              </button>
            </form>
          </>
        ) : (
          <div className="conversation-empty">
            <div className="empty-icon">↗</div>
            <h2>Your conversations, closer.</h2>
            <p>
              Choose a chat to read messages and reply.
              <br />
              Everything is stored on this device.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
function MessageBubble({ message: m }: { message: Message }) {
  return (
    <article className={"message " + m.direction}>
      {m.direction === "incoming" ? (
        <small>{displayName(m.senderId)}</small>
      ) : null}
      {m.type !== "text" ? (
        <div className="media-label">
          [{m.type} · attachment preview unavailable]
        </div>
      ) : null}
      <p>{m.text}</p>
      <time>
        {new Date(m.timestamp).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })}
        {m.direction === "outgoing" ? " · You" : ""}
      </time>
    </article>
  );
}
