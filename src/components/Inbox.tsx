import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AddMember } from "./AddMember";
import { Avatar } from "./Avatar";
import { EmojiPicker } from "./EmojiPicker";
import { ChatMenu } from "./ChatMenu";
import { LinkCard, useLinkPreview } from "./LinkCard";
import {
  applyMentions,
  matchingMembers,
  memberName,
  mentionQuery,
  MentionPicker,
  useGroupMembers,
  type PickedMention,
} from "./MentionPicker";
import { canRecord, MicIcon, useVoiceRecorder } from "./VoiceRecorder";
import {
  AttachIcon,
  DownloadIcon,
  deleteWindow,
  MessageBubble,
  senderLabel,
  summary,
  unknownSender,
  who,
  type BubbleActions,
} from "./MessageBubble";
import { fileSize, readFile, type LoadedMedia } from "../lib/media";
import { formatText } from "../lib/format";
import {
  request,
  chatTitle,
  phoneLabel,
  initials,
  type Chat,
  type Message,
  type Draft,
  type SearchHit,
  type ChatPresence,
  type GroupMember,
} from "../lib/api";
interface Props {
  chats: Chat[];
  messages: Message[];
  drafts: Draft[];
  selected: string | null;
  select: (id: string | null) => void;
  /** Older stored messages exist above the loaded ones. */
  hasMore: boolean;
  loadOlder: () => void;
  /** Who is online or typing in the open chat. */
  presence: ChatPresence | null;
  /** Opens a chat at one of its messages, such as a search result. */
  openMessage: (chatId: string, messageId: string, position: number) => void;
  /** The message to scroll to once it is loaded. */
  target: string | null;
  clearTarget: () => void;
  /** Shows a message in the app's notice bar. */
  notify: (text: string, kind?: "info" | "error") => void;
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
    [filter, setFilter] = useState<"All" | "Unread" | "Pinned" | "Groups" | "Archived">("All");
  const bottom = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const nearBottom = useRef(true);
  const previousChat = useRef<string | null>(null);
  const text = p.selected ? compositions[p.selected] || "" : "";
  const setText = (value: string, id = p.selected) => {
    if (id) setCompositions((current) => ({ ...current, [id]: value }));
  };
  const chat = p.chats.find((c) => c.id === p.selected);
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null),
    [attachment, setAttachment] = useState<{ file: File; url: string } | null>(null),
    [viewer, setViewer] = useState<{ message: Message; media: LoadedMedia } | null>(null),
    [highlight, setHighlight] = useState<string | null>(null),
    [dragging, setDragging] = useState(false),
    [askedPhone, setAskedPhone] = useState(false),
    [editing, setEditing] = useState<{ message: Message; stash: string } | null>(null),
    [forwarding, setForwarding] = useState<Message | null>(null),
    [removing, setRemoving] = useState<Message | null>(null),
    [leaving, setLeaving] = useState(false),
    [sending, setSending] = useState(false),
    [emoji, setEmoji] = useState(false),
    [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null),
    [confirming, setConfirming] = useState<{ kind: "block" | "delete"; chat: Chat } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const menuChat = menu ? p.chats.find((c) => c.id === menu.id) : undefined;
  // Mentions: typing "@" in a group offers its members. The composer shows a
  // name; the number WhatsApp needs is swapped in when the message is sent.
  const [picked, setPicked] = useState<Record<string, PickedMention[]>>({}),
    [caret, setCaret] = useState(0),
    [mentionIndex, setMentionIndex] = useState(0),
    [mentionClosed, setMentionClosed] = useState<number | null>(null);
  const asking = chat?.type === "group" && !editing ? mentionQuery(text, caret) : null;
  const members = useGroupMembers(p.selected, !!asking && p.connected);
  const candidates =
    asking && asking.start !== mentionClosed ? matchingMembers(members, asking.query) : [];
  useEffect(() => setMentionIndex(0), [asking?.query]);
  useEffect(() => {
    if (!asking) setMentionClosed(null);
  }, [!asking]);
  const pickMention = (m: GroupMember) => {
    if (!asking || !p.selected) return;
    const id = p.selected,
      label = "@" + memberName(m);
    const before = text.slice(0, asking.start);
    setText(before + label + " " + text.slice(caret));
    setPicked((all) => ({
      ...all,
      [id]: [...(all[id] ?? []).filter((x) => x.label !== label), { label, id: m.id }],
    }));
    const position = before.length + label.length + 1;
    setCaret(position);
    requestAnimationFrame(() => {
      composer.current?.focus();
      composer.current?.setSelectionRange(position, position);
    });
  };
  const voice = useVoiceRecorder((message) => p.notify(message, "error"));
  const blocked = !!chat?.blocked;
  const linking = useLinkPreview(
    text,
    !!p.selected && p.connected && !attachment && !editing && !blocked,
  );
  /** In a direct chat every incoming message is from the chat's person. */
  const peer = chat?.type === "direct" ? chatTitle(chat) : undefined;
  const pane = useRef<HTMLDivElement>(null);
  /** Distance from the bottom to keep while older messages are added above. */
  const keepFromBottom = useRef<number | null>(null);
  // A reply or attachment belongs to the chat it was started in.
  useEffect(() => {
    setReplyTo(null);
    setAttachment(null);
    setViewer(null);
    setAskedPhone(false);
    setEditing(null);
    setForwarding(null);
    setRemoving(null);
    setLeaving(false);
    setEmoji(false);
    setCaret(0);
    voice.cancel();
  }, [p.selected]);
  // An open chat is read while this window has focus, as on WhatsApp Web:
  // its unread count clears and the senders get read receipts.
  const reading = useRef(false);
  const unread = chat?.unreadCount ?? 0;
  useEffect(() => {
    if (!p.selected || !unread) return;
    const id = p.selected;
    const read = () => {
      if (reading.current || !document.hasFocus()) return;
      reading.current = true;
      void request(`/internal/chats/${encodeURIComponent(id)}/read`, "POST")
        .catch(() => {})
        .finally(() => (reading.current = false));
    };
    read();
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, [p.selected, unread]);
  // While a chat is open in a focused window, WhatsApp shows this account as
  // online and reports who is online or typing in it. The gateway goes
  // offline by itself when these signs stop.
  const presencePath = p.selected
    ? `/internal/chats/${encodeURIComponent(p.selected)}/presence`
    : null;
  useEffect(() => {
    if (!presencePath || !p.connected) return;
    const open = () => {
      if (document.hasFocus()) void request(presencePath, "POST", { state: "open" }).catch(() => {});
    };
    open();
    const timer = setInterval(open, 45_000);
    window.addEventListener("focus", open);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", open);
    };
  }, [presencePath, p.connected]);
  useEffect(() => {
    const away = () => void request("/internal/presence/away", "POST").catch(() => {});
    window.addEventListener("blur", away);
    return () => {
      window.removeEventListener("blur", away);
      away();
    };
  }, []);
  useEffect(() => {
    if (!p.selected) void request("/internal/presence/away", "POST").catch(() => {});
  }, [p.selected]);
  // "Typing…" is sent when typing starts, repeated while it goes on, and
  // withdrawn after a pause or once the message is sent or cleared.
  const typing = useRef<{ path: string; at: number; stop?: ReturnType<typeof setTimeout> } | null>(null);
  const stopTyping = () => {
    const t = typing.current;
    if (!t) return;
    clearTimeout(t.stop);
    typing.current = null;
    void request(t.path, "POST", { state: "paused" }).catch(() => {});
  };
  const typed = (value: string) => {
    if (!presencePath || !p.connected) return;
    if (!value.trim() || typing.current?.path !== presencePath) stopTyping();
    if (!value.trim()) return;
    const t = (typing.current ??= { path: presencePath, at: 0 });
    if (Date.now() - t.at > 8000) {
      t.at = Date.now();
      void request(presencePath, "POST", { state: "composing" }).catch(() => {});
    }
    clearTimeout(t.stop);
    t.stop = setTimeout(stopTyping, 5000);
  };
  useEffect(() => stopTyping, [p.selected]);
  const typers = p.presence?.typing ?? [];
  const activity = typers.length
    ? chat?.type === "group"
      ? typers.map((t) => t.name || phoneLabel(t.id)).slice(0, 3).join(", ") +
        (typers.length > 1 ? " are typing…" : typers[0]!.state === "recording" ? " is recording audio…" : " is typing…")
      : typers[0]!.state === "recording"
        ? "recording audio…"
        : "typing…"
    : p.presence?.online
      ? "online"
      : null;
  const cancelEdit = () => {
    if (editing) setText(editing.stash);
    setEditing(null);
  };
  /** Puts text at the composer's cursor, such as a picked emoji. */
  const insert = (value: string) => {
    const input = composer.current;
    const start = input?.selectionStart ?? text.length,
      end = input?.selectionEnd ?? text.length;
    setText(text.slice(0, start) + value + text.slice(end));
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + value.length, start + value.length);
    });
  };
  useEffect(() => () => {
    if (attachment) URL.revokeObjectURL(attachment.url);
  }, [attachment]);
  useEffect(() => {
    if (!viewer && !replyTo && !attachment && !editing && !forwarding && !removing && !confirming && voice.state === "idle") return;
    const close = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (confirming) setConfirming(null);
      else if (viewer) setViewer(null);
      else if (voice.state !== "idle") voice.cancel();
      else if (forwarding) setForwarding(null);
      else if (removing) setRemoving(null);
      else if (editing) cancelEdit();
      else if (attachment) setAttachment(null);
      else setReplyTo(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  });
  const attach = (file: File | null | undefined) => {
    if (!file) return;
    if (file.size > 16 * 1024 * 1024) {
      p.notify("Files can be up to 16 MB.", "error");
      return;
    }
    setAttachment({ file, url: URL.createObjectURL(file) });
    composer.current?.focus();
  };
  const actions: BubbleActions = {
    reply: (m) => {
      setReplyTo(m);
      composer.current?.focus();
    },
    react: (m, emoji) =>
      void p.act(() =>
        request(`/v1/messages/${encodeURIComponent(m.id)}/react`, "POST", { emoji }),
      ),
    open: (message, media) => setViewer({ message, media }),
    forward: (m) => setForwarding(m),
    remove: (m) => setRemoving(m),
    copy: (m) => {
      void navigator.clipboard
        .writeText(m.text || "")
        .then(() => p.notify("Copied"), () => p.notify("Couldn’t copy the text", "error"));
    },
    edit: (m) => {
      setReplyTo(null);
      setAttachment(null);
      setEditing({ message: m, stash: editing ? editing.stash : text });
      setText(m.text || "");
      requestAnimationFrame(() => composer.current?.focus());
    },
    save: (m) =>
      void p.act(async () => {
        const { path } = await request<{ path: string }>(
          `/internal/messages/${encodeURIComponent(m.id)}/save`,
          "POST",
        );
        p.notify("Saved to " + path);
      }),
    jump: (id) => {
      const el = document.getElementById("msg-" + id);
      if (!el) {
        p.notify("That message is further up. Scroll up to load older messages.");
        return;
      }
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      setHighlight(id);
      setTimeout(() => setHighlight((h) => (h === id ? null : h)), 1600);
    },
  };
  const loadOlder = () => {
    const el = pane.current;
    if (!el || !p.hasMore || keepFromBottom.current !== null) return;
    keepFromBottom.current = el.scrollHeight - el.scrollTop;
    p.loadOlder();
  };
  // Older messages are added above: keep the reader where they were.
  useLayoutEffect(() => {
    const el = pane.current;
    if (el && keepFromBottom.current !== null) {
      el.scrollTop = el.scrollHeight - keepFromBottom.current;
      keepFromBottom.current = null;
    }
  }, [p.messages[0]?.id]);
  useEffect(() => {
    keepFromBottom.current = null;
  }, [p.selected]);
  // Group messages synced without their sender, and attachments stored before
  // they could be downloaded, are asked for again once per visit; the resent
  // copies fill in names and photos as they arrive.
  const repairRequested = useRef(new Set<string>());
  const senderless =
    (chat?.type === "group" && p.messages.some((m) => unknownSender(m))) ||
    p.messages.some((m) => m.mediaAvailable === false && !m.deletedAt);
  useEffect(() => {
    if (!p.selected || !senderless || !p.connected) return;
    if (repairRequested.current.has(p.selected)) return;
    repairRequested.current.add(p.selected);
    void request(
      `/internal/chats/${encodeURIComponent(p.selected)}/repair-senders`,
      "POST",
    ).catch(() => repairRequested.current.delete(p.selected!));
  }, [p.selected, senderless, p.connected]);
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
  // A search result opens its chat at that message once it has loaded.
  useEffect(() => {
    if (!p.target || !p.messages.length) return;
    const id = p.target;
    if (p.messages.some((m) => m.id === id)) {
      p.clearTarget();
      // After the chat's own scroll to its newest message.
      requestAnimationFrame(() => actions.jump(id));
    } else if (!p.hasMore) {
      p.clearTarget();
      p.notify("That message is no longer in this chat.");
    }
  }, [p.target, p.messages, p.hasMore]);
  // The sidecar orders effective inbox pins first, then by activity.
  const query = search.trim().toLowerCase();
  // Message text is searched by the gateway, shortly after typing stops.
  const [hits, setHits] = useState<{ query: string; results: SearchHit[] } | null>(null);
  useEffect(() => {
    if (query.length < 2) return setHits(null);
    let live = true;
    const timer = setTimeout(() => {
      request<{ results: SearchHit[] }>("/internal/search?q=" + encodeURIComponent(query)).then(
        (r) => live && setHits({ query, results: r.results }),
        () => live && setHits({ query, results: [] }),
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);
  const titles = new Map(p.chats.map((c) => [c.id, chatTitle(c)]));
  const pinnedCount = p.chats.filter((c) => c.pinned).length;
  const unreadChats = p.chats.filter((c) => !c.archived && c.unreadCount).length;
  const found = p.chats.filter((c) => {
    if (!(chatTitle(c) + c.id).toLowerCase().includes(query)) return false;
    if (filter === "Pinned") return c.pinned;
    if (filter === "Unread") return !c.archived && !!c.unreadCount;
    if (filter === "Archived") return c.archived;
    if (c.archived) return false;
    return filter !== "Groups" || c.type === "group";
  });
  const pin = (c: Chat) => void p.act(() => request(
    "/internal/chats/" + encodeURIComponent(c.id) + "/pin", "PUT", { pinned: !c.pinned },
  ));
  const item = (c: Chat) => (
    <div key={c.id} className={"chat-row " + (c.id === p.selected ? "selected" : "") + (c.unreadCount ? " unread" : "")}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ id: c.id, x: e.clientX, y: e.clientY });
      }}>
    <button
      className={"chat-item " + (c.id === p.selected ? "selected" : "")}
      aria-pressed={c.id === p.selected}
      onClick={() => p.select(c.id)}
    >
      <Avatar chat={c} />
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
        {c.muted && !c.unreadCount ? (
          <small className="muted-mark" title="Muted" aria-label="Muted">🔕</small>
        ) : c.unreadCount ? (
          <span className={"unread-badge" + (c.muted ? " muted-chat" : "")}
            aria-label={c.unreadCount + " unread" + (c.muted ? ", muted" : "")}>
            {c.unreadCount > 99 ? "99+" : c.unreadCount}
          </span>
        ) : c.pinned ? (
          <small>Pinned</small>
        ) : null}
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
  /** Shows a spinner on the send button when sending takes a moment. */
  const track = (work: Promise<void>) => {
    const slow = setTimeout(() => setSending(true), 300);
    return work.finally(() => {
      clearTimeout(slow);
      setSending(false);
    });
  };
  const send = () => {
    if (!p.selected || p.busy || !p.connected || blocked) return;
    if (voice.state === "recording") {
      const id = p.selected, quoted = replyTo;
      nearBottom.current = true;
      return track(p.act(async () => {
        const recording = await voice.finish();
        if (!recording) return p.notify("That recording was too short to send.");
        await request("/v1/messages/send-media", "POST", {
          chatId: id,
          data: await readFile(recording.blob),
          mimetype: recording.mimetype,
          voice: true,
          seconds: recording.seconds,
          replyTo: quoted?.id,
        });
        setReplyTo((r) => (r === quoted ? null : r));
      }));
    }
    if (!text.trim() && !attachment) return;
    if (editing) {
      const target = editing, newText = text;
      return track(p.act(async () => {
        if (newText.trim() !== (target.message.text || "").trim())
          await request(`/v1/messages/${encodeURIComponent(target.message.id)}`, "PUT", { text: newText });
        setText(target.stash);
        setEditing((e) => (e === target ? null : e));
      }));
    }
    const id = p.selected, sentText = text, quoted = replyTo, file = attachment;
    const wire = applyMentions(sentText, picked[id] ?? []);
    const link = !file && linking.link && wire.text.includes(linking.link.url) ? linking.link : undefined;
    nearBottom.current = true;
    stopTyping();
    return track(p.act(async () => {
      if (file)
        await request("/v1/messages/send-media", "POST", {
          chatId: id,
          data: await readFile(file.file),
          mimetype: file.file.type || "application/octet-stream",
          fileName: file.file.name,
          caption: wire.text.trim() || undefined,
          mentions: wire.mentions,
          replyTo: quoted?.id,
        });
      else
        await request("/v1/messages/send", "POST", {
          chatId: id,
          text: wire.text,
          mentions: wire.mentions,
          linkPreview: link,
          replyTo: quoted?.id,
        });
      setPicked((all) => ({ ...all, [id]: [] }));
      setCompositions((current) => current[id] === sentText ? { ...current, [id]: "" } : current);
      setReplyTo((r) => (r === quoted ? null : r));
      setAttachment((a) => (a === file ? null : a));
    }));
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
            aria-label="Search chats and messages"
            placeholder="Search chats and messages"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="chat-filters" aria-label="Filter chats">
          {(["All", "Unread", "Pinned", "Groups", "Archived"] as const).map((value) => (
            <button key={value} aria-pressed={filter === value}
              className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>
              {value}{value === "Pinned" ? ` (${pinnedCount})` : value === "Unread" && unreadChats ? ` (${unreadChats})` : ""}
            </button>
          ))}
        </div>
        {filter === "Pinned" ? <div className="pin-hint">Pin as many chats as you like. Saved on this device.</div> : null}
        <div className="chat-items">
          {found.map(item)}
          {p.chats.length > 0 && found.length === 0 && !hits?.results.length ? (
            <div className="list-empty">
              {query ? (hits || query.length < 2 ? "No matching chats or messages" : "Searching…") : `No ${filter.toLowerCase()} chats`}
            </div>
          ) : null}
          {hits?.results.length ? (
            <>
              <div className="search-heading">Messages</div>
              {hits.results.map((h) => (
                <button
                  key={h.id}
                  className="chat-item search-hit"
                  onClick={() => p.openMessage(h.chatId, h.id, h.position)}
                >
                  <span className="chat-info">
                    <strong>{titles.get(h.chatId) ?? phoneLabel(h.chatId)}</strong>
                    <small>
                      {h.direction === "outgoing"
                        ? "You: "
                        : h.chatId.endsWith("@g.us") && h.senderName
                          ? h.senderName + ": "
                          : ""}
                      {h.snippet}
                    </small>
                  </span>
                  <span className="chat-meta">
                    <time>{lastActive(h.timestamp)}</time>
                  </span>
                </button>
              ))}
            </>
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
              <Avatar key={p.selected} chat={chat ?? { id: p.selected, name: "" }} />
              <div className="conversation-identity">
                <h3>{chatTitle(chat ?? { id: p.selected, name: "" })}</h3>
                {activity ? (
                  <small className="chat-activity" aria-live="polite">{activity}</small>
                ) : (
                <small>
                  {chat?.type === "group"
                    ? "Group"
                    : chat && chat.name !== chat.id
                      ? phoneLabel(chat.id)
                      : "WhatsApp"}{" "}
                  · {p.connected ? "Ready to send" : "Disconnected"}
                </small>
                )}
              </div>
              {chat?.type === "group" ? (
                <button
                  className={"header-pin header-add icon-button " + (addingTo === chat.id ? "pinned" : "")}
                  title="Add people"
                  aria-label="Add people to this group"
                  aria-expanded={addingTo === chat.id}
                  onClick={() => setAddingTo(addingTo === chat.id ? null : chat.id)}
                >
                  <AddPersonIcon />
                </button>
              ) : null}
              {chat?.type === "group" ? (
                <button
                  className="header-pin icon-button"
                  title="Leave group"
                  aria-label="Leave this group"
                  disabled={p.busy}
                  onClick={() => setLeaving(true)}
                >
                  <LeaveIcon />
                </button>
              ) : null}
              {chat ? <button className={"header-pin icon-button " + (chat.pinned ? "pinned" : "")}
                title={chat.pinned ? "Unpin chat" : "Pin chat"}
                aria-label={chat.pinned ? "Unpin current chat" : "Pin current chat"}
                aria-pressed={chat.pinned} disabled={p.busy} onClick={() => pin(chat)}><PinIcon /></button> : null}
              {chat ? (
                <button
                  className="header-pin icon-button"
                  title="Chat actions"
                  aria-label="Chat actions"
                  aria-haspopup="menu"
                  aria-expanded={menu?.id === chat.id}
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setMenu({ id: chat.id, x: r.right - 190, y: r.bottom + 4 });
                  }}
                >
                  <MoreIcon />
                </button>
              ) : null}
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
            {chat?.type === "group" && addingTo === chat.id ? (
              <AddMember
                key={chat.id}
                groupId={chat.id}
                connected={p.connected}
                close={() => setAddingTo(null)}
              />
            ) : null}
            {chat?.aiMode === "copilot" ? (
              <div className="copilot-notice">
                ✧ Copilot sends recent messages to OpenRouter to draft replies.
                You review every send.
              </div>
            ) : null}
            <div
              ref={pane}
              className={"messages" + (dragging ? " dragging" : "")}
              aria-live="polite"
              onScroll={(e) => {
                const el = e.currentTarget;
                nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
                if (el.scrollTop < 120 && p.hasMore) loadOlder();
              }}
              onDragOver={(e) => {
                if (!p.connected || !e.dataTransfer.types.includes("Files")) return;
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                setDragging(false);
                if (!p.connected || !e.dataTransfer.files.length) return;
                e.preventDefault();
                attach(e.dataTransfer.files[0]);
              }}
            >
              {p.hasMore ? (
                <button className="text-button history-more" onClick={loadOlder}>
                  Load earlier messages
                </button>
              ) : p.messages.length ? (
                <div className="history-note">
                  {p.connected ? (
                    askedPhone ? (
                      "Asked your phone for older messages. They appear here as they arrive."
                    ) : (
                      <button
                        className="text-button"
                        onClick={() => {
                          setAskedPhone(true);
                          void request(`/internal/chats/${encodeURIComponent(p.selected!)}/older`, "POST").catch(
                            (e) => p.notify(String(e), "error"),
                          );
                        }}
                      >
                        Get older messages from your phone
                      </button>
                    )
                  ) : (
                    "Start of messages stored on this device"
                  )}
                </div>
              ) : (
                <div className="list-empty">
                  No stored messages in this conversation.
                </div>
              )}
              {p.messages.map((m, index) => {
                const previous = p.messages[index - 1];
                const newDay = !previous || new Date(previous.timestamp).toDateString() !== new Date(m.timestamp).toDateString();
                return (
                  <Fragment key={m.id}>
                    {newDay ? (
                      <div className="message-day">{new Date(m.timestamp).toDateString() === new Date().toDateString() ? "Today" : new Date(m.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</div>
                    ) : null}
                    {m.type === "system" ? (
                      <div id={"msg-" + m.id} className={"message-day message-system" + (highlight === m.id ? " highlighted" : "")}>
                        {formatText(m.text || "", m.mentions)}
                      </div>
                    ) : (
                    <MessageBubble
                      message={m}
                      group={chat?.type === "group"}
                      continued={!newDay && previous.type !== "system" && previous.direction === m.direction && !unknownSender(m) && who(previous) === who(m)}
                      highlighted={highlight === m.id}
                      canAct={p.connected && !p.busy}
                      actions={actions}
                      peer={peer}
                    />
                    )}
                  </Fragment>
                );
              })}
              {dragging ? <div className="drop-hint">Drop a file to send it</div> : null}
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
            {blocked && chat ? (
              <div className="copilot-notice warning blocked-bar">
                You blocked this contact. Neither of you can message the other.
                <button
                  className="text-button"
                  disabled={!p.connected || p.busy}
                  onClick={() =>
                    void p.act(() =>
                      request(`/internal/chats/${encodeURIComponent(chat.id)}/block`, "PUT", { blocked: false }),
                    )
                  }
                >
                  Unblock
                </button>
              </div>
            ) : null}
            {replyTo || attachment || editing || linking.link ? (
              <div className="compose-context">
                {linking.link ? (
                  <div className="reply-bar">
                    <LinkCard
                      link={linking.link}
                      image={linking.link.thumbnail ? "data:image/jpeg;base64," + linking.link.thumbnail : null}
                      open={false}
                    />
                    <button className="icon-button" aria-label="Send without the link preview" title="Remove preview" onClick={linking.dismiss}>✕</button>
                  </div>
                ) : null}
                {editing ? (
                  <div className="reply-bar">
                    <div className="quote static editing">
                      <strong>Editing message</strong>
                      <span>{editing.message.text}</span>
                    </div>
                    <button className="icon-button" aria-label="Cancel editing" onClick={cancelEdit}>✕</button>
                  </div>
                ) : null}
                {replyTo ? (
                  <div className="reply-bar">
                    <div className="quote static">
                      <strong>{senderLabel(replyTo, peer)}</strong>
                      <span>{summary(replyTo)}</span>
                    </div>
                    <button className="icon-button" aria-label="Cancel reply" onClick={() => setReplyTo(null)}>✕</button>
                  </div>
                ) : null}
                {attachment ? (
                  <div className="attachment-preview">
                    {attachment.file.type.startsWith("image/") ? (
                      <img src={attachment.url} alt="" />
                    ) : (
                      <span className="media-icon" aria-hidden="true">
                        {(attachment.file.name.split(".").pop() || "file").slice(0, 4).toUpperCase()}
                      </span>
                    )}
                    <span className="media-text">
                      <strong>{attachment.file.name || "Pasted image"}</strong>
                      <small>
                        {fileSize(attachment.file.size)} ·{" "}
                        {/^image\/(jpeg|png|webp)$/.test(attachment.file.type)
                          ? "Sends as a photo"
                          : attachment.file.type === "video/mp4"
                            ? "Sends as a video"
                            : attachment.file.type.startsWith("audio/")
                              ? "Sends as audio"
                              : "Sends as a document"}
                        {text.trim() ? " with your message as the caption" : ""}
                      </small>
                    </span>
                    <button className="icon-button" aria-label="Remove attachment" onClick={() => setAttachment(null)}>✕</button>
                  </div>
                ) : null}
              </div>
            ) : null}
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <input
                ref={fileInput}
                type="file"
                className="visually-hidden"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(e) => {
                  attach(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
              {voice.state !== "idle" ? (
                <div className="voice-bar" role="status">
                  <button type="button" className="icon-button attach-button" title="Discard recording" aria-label="Discard recording" onClick={voice.cancel}>✕</button>
                  <span className={"voice-dot" + (voice.state === "recording" ? " live" : "")} aria-hidden="true" />
                  <span>
                    {voice.state === "starting"
                      ? "Waiting for the microphone…"
                      : `Recording ${Math.floor(voice.seconds / 60)}:${String(voice.seconds % 60).padStart(2, "0")}`}
                  </span>
                </div>
              ) : (
              <>
              <button
                type="button"
                className="icon-button attach-button"
                title="Attach a photo, video or file"
                aria-label="Attach a file"
                disabled={!p.connected || p.busy || blocked}
                onClick={() => fileInput.current?.click()}
              >
                <AttachIcon />
              </button>
              <span className="emoji-anchor">
                <button
                  type="button"
                  className="icon-button attach-button"
                  title="Emoji"
                  aria-label="Insert emoji"
                  aria-expanded={emoji}
                  disabled={!p.connected || p.busy || blocked}
                  onClick={() => setEmoji(!emoji)}
                >
                  <span aria-hidden="true">☺</span>
                </button>
                {emoji ? <EmojiPicker className="composer-emoji" pick={insert} close={() => setEmoji(false)} /> : null}
              </span>
              <span className="composer-field">
              {candidates.length ? (
                <MentionPicker members={candidates} active={mentionIndex} pick={pickMention} hover={setMentionIndex} />
              ) : null}
              <textarea
                ref={composer}
                rows={1}
                aria-label="Message"
                placeholder={
                  !p.connected
                    ? "Connect WhatsApp to send a message"
                    : blocked
                    ? "Unblock this contact to send a message"
                    : editing
                      ? "Edit your message…"
                      : attachment
                        ? "Add a caption…"
                        : "Write a message…"
                }
                value={text}
                maxLength={10000}
                disabled={!p.connected || p.busy || blocked}
                onChange={(e) => {
                  setText(e.target.value);
                  setCaret(e.target.selectionStart);
                  typed(e.target.value);
                }}
                onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
                onPaste={(e) => {
                  const file = [...e.clipboardData.files][0];
                  if (file) {
                    e.preventDefault();
                    attach(file);
                  }
                }}
                onKeyDown={(e) => {
                  if (candidates.length && !e.nativeEvent.isComposing) {
                    const n = candidates.length;
                    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                      e.preventDefault();
                      setMentionIndex((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
                      return;
                    }
                    if (e.key === "Enter" || e.key === "Tab") {
                      e.preventDefault();
                      pickMention(candidates[mentionIndex] ?? candidates[0]!);
                      return;
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      setMentionClosed(asking!.start);
                      return;
                    }
                  }
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    if ((text.trim() || attachment) && !p.busy && p.connected) void send();
                  }
                }}
              />
              </span>
              </>
              )}
              {voice.state === "idle" && !text.trim() && !attachment && !editing && canRecord() ? (
                <button
                  type="button"
                  className="icon-button attach-button"
                  title="Record a voice message"
                  aria-label="Record a voice message"
                  disabled={!p.connected || p.busy || blocked}
                  onClick={() => void voice.start()}
                >
                  <MicIcon />
                </button>
              ) : null}
              <button
                type="submit"
                className={sending ? "sending" : undefined}
                disabled={p.busy || !p.connected || blocked || voice.state === "starting" || (voice.state === "idle" && !text.trim() && !attachment)}
              >
                {sending ? <span className="spinner" aria-hidden="true" /> : <span aria-hidden="true">{editing ? "✓" : "➤"}</span>}
                <span className="visually-hidden" aria-live="polite">
                  {sending ? (editing ? "Saving edit…" : "Sending…") : editing ? "Save edit" : voice.state === "recording" ? "Send voice message" : "Send message"}
                </span>
              </button>
            </form>
            {forwarding ? (
              <ForwardDialog
                message={forwarding}
                chats={p.chats}
                busy={p.busy}
                close={() => setForwarding(null)}
                send={(chatIds) =>
                  void p.act(async () => {
                    await request(`/v1/messages/${encodeURIComponent(forwarding.id)}/forward`, "POST", { chatIds });
                    setForwarding(null);
                    p.notify(`Forwarded to ${chatIds.length} chat${chatIds.length > 1 ? "s" : ""}`);
                  })
                }
              />
            ) : null}
            {removing ? (
              <div className="modal-backdrop" onClick={() => setRemoving(null)}>
                <div className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-title" onClick={(e) => e.stopPropagation()}>
                  <h3 id="delete-title">Delete message?</h3>
                  <p className="quote static">
                    <span>{summary(removing) || "Message"}</span>
                  </p>
                  <div className="modal-actions">
                    {removing.direction === "outgoing" &&
                    !removing.deletedAt &&
                    Date.now() - removing.timestamp < deleteWindow ? (
                      <button
                        className="danger"
                        disabled={!p.connected || p.busy}
                        onClick={() =>
                          void p.act(async () => {
                            await request(`/v1/messages/${encodeURIComponent(removing.id)}?for=everyone`, "DELETE");
                            setRemoving(null);
                          })
                        }
                      >
                        Delete for everyone
                      </button>
                    ) : null}
                    <button
                      className="secondary"
                      disabled={p.busy}
                      onClick={() =>
                        void p.act(async () => {
                          await request(`/v1/messages/${encodeURIComponent(removing.id)}?for=me`, "DELETE");
                          setRemoving(null);
                        })
                      }
                    >
                      Delete for me
                    </button>
                    <button className="text-button" onClick={() => setRemoving(null)}>
                      Cancel
                    </button>
                  </div>
                  <small>“Delete for me” removes it from this device only. Your phone keeps its copy.</small>
                </div>
              </div>
            ) : null}
            {leaving && chat ? (
              <div className="modal-backdrop" onClick={() => setLeaving(false)}>
                <div className="modal" role="dialog" aria-modal="true" aria-labelledby="leave-title" onClick={(e) => e.stopPropagation()}>
                  <h3 id="leave-title">Leave {chatTitle(chat)}?</h3>
                  <p>
                    You will stop receiving its messages and can only rejoin if
                    an admin adds you back or you use an invite link.
                  </p>
                  {p.connected ? null : <p className="inline-error">Connect WhatsApp to leave this group.</p>}
                  <div className="modal-actions">
                    <button
                      className="danger"
                      disabled={!p.connected || p.busy}
                      onClick={() =>
                        void p.act(async () => {
                          await request(`/internal/groups/${encodeURIComponent(chat.id)}/leave`, "POST");
                          setLeaving(false);
                          setAddingTo(null);
                          p.notify(`You left ${chatTitle(chat)}`);
                        })
                      }
                    >
                      Leave group
                    </button>
                    <button className="text-button" onClick={() => setLeaving(false)}>
                      Cancel
                    </button>
                  </div>
                  <small>The chat and its history stay on this device. Any automation for this group is paused.</small>
                </div>
              </div>
            ) : null}
            {viewer ? (
              <div className="media-viewer" role="dialog" aria-modal="true" aria-label="Photo" onClick={() => setViewer(null)}>
                <div className="media-viewer-bar" onClick={(e) => e.stopPropagation()}>
                  <span>
                    <strong>{senderLabel(viewer.message, peer)}</strong>
                    <small>{new Date(viewer.message.timestamp).toLocaleString()}</small>
                  </span>
                  <button className="icon-button" title="Save to Downloads" aria-label="Save photo to Downloads" onClick={() => actions.save(viewer.message)}>
                    <DownloadIcon />
                  </button>
                  <button className="icon-button" aria-label="Close photo" onClick={() => setViewer(null)}>✕</button>
                </div>
                <img src={viewer.media.url} alt={viewer.message.text || "Photo"} onClick={(e) => e.stopPropagation()} />
                {viewer.message.text ? <p onClick={(e) => e.stopPropagation()}>{viewer.message.text}</p> : null}
              </div>
            ) : null}
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
      {menu && menuChat ? (
        <ChatMenu
          chat={menuChat}
          at={menu}
          connected={p.connected}
          busy={p.busy}
          close={() => setMenu(null)}
          act={p.act}
          notify={p.notify}
          // An open chat is read as soon as it is seen, so it steps aside.
          beforeUnread={(c) => c.id === p.selected && p.select(null)}
          confirm={(kind, c) => setConfirming({ kind, chat: c })}
        />
      ) : null}
      {confirming ? (
        <div className="modal-backdrop" onClick={() => setConfirming(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onClick={(e) => e.stopPropagation()}>
            <h3 id="confirm-title">
              {confirming.kind === "block" ? "Block " : "Delete chat with "}
              {chatTitle(confirming.chat)}?
            </h3>
            {confirming.kind === "block" ? (
              <p>
                They can no longer message or call you on WhatsApp, and you
                can’t message them. WhatsApp doesn’t tell them.
              </p>
            ) : (
              <p>
                Its messages are removed from this device, and the chat is
                deleted on your phone and other linked devices. This can’t be
                undone.
                {confirming.chat.type === "group"
                  ? " If you are still in the group, the chat returns with its next message."
                  : ""}
              </p>
            )}
            {p.connected ? null : <p className="inline-error">Connect WhatsApp first.</p>}
            <div className="modal-actions">
              <button
                className="danger"
                disabled={!p.connected || p.busy}
                onClick={() => {
                  const { kind, chat: c } = confirming;
                  void p.act(async () => {
                    const path = "/internal/chats/" + encodeURIComponent(c.id);
                    if (kind === "block") await request(path + "/block", "PUT", { blocked: true });
                    else {
                      await request(path, "DELETE");
                      if (c.id === p.selected) p.select(null);
                    }
                    setConfirming(null);
                    p.notify((kind === "block" ? "Blocked " : "Deleted the chat with ") + chatTitle(c));
                  });
                }}
              >
                {confirming.kind === "block" ? "Block" : "Delete chat"}
              </button>
              <button className="text-button" onClick={() => setConfirming(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
function MoreIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>;
}
function AddPersonIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="4" /><path d="M2 21c0-3.9 3.1-7 7-7s7 3.1 7 7M19 8v6M16 11h6" /></svg>;
}
function LeaveIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>;
}
function PinIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m16 3 5 5-4 1-3 5v3l-7-7h3l5-3zM9 15l-6 6" /></svg>;
}
/** Choose up to five chats to forward a message to. */
function ForwardDialog({
  message,
  chats,
  busy,
  send,
  close,
}: {
  message: Message;
  chats: Chat[];
  busy: boolean;
  send: (chatIds: string[]) => void;
  close: () => void;
}) {
  const [query, setQuery] = useState(""),
    [chosen, setChosen] = useState<string[]>([]);
  const q = query.trim().toLowerCase();
  const shown = chats
    .filter((c) => !c.archived && (chatTitle(c) + c.id).toLowerCase().includes(q))
    .slice(0, 60);
  const toggle = (id: string) =>
    setChosen((list) =>
      list.includes(id) ? list.filter((x) => x !== id) : list.length < 5 ? [...list, id] : list,
    );
  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal forward-dialog" role="dialog" aria-modal="true" aria-labelledby="forward-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="forward-title">Forward message</h3>
        <p className="quote static">
          <span>{summary(message)}</span>
        </p>
        <input
          autoFocus
          aria-label="Search chats"
          placeholder="Search chats"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="forward-list" role="group" aria-label="Chats">
          {shown.map((c) => (
            <label key={c.id} className={"forward-option" + (chosen.includes(c.id) ? " chosen" : "")}>
              <input
                type="checkbox"
                checked={chosen.includes(c.id)}
                disabled={!chosen.includes(c.id) && chosen.length >= 5}
                onChange={() => toggle(c.id)}
              />
              <Avatar chat={c} />
              <span>{chatTitle(c)}</span>
            </label>
          ))}
          {!shown.length ? <div className="list-empty">No matching chats</div> : null}
        </div>
        <div className="modal-actions">
          <small>{chosen.length}/5 chats chosen</small>
          <button className="text-button" onClick={close}>Cancel</button>
          <button disabled={busy || !chosen.length} onClick={() => send(chosen)}>
            Forward
          </button>
        </div>
      </div>
    </div>
  );
}
