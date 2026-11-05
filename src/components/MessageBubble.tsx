import { useState, type CSSProperties, type ReactNode } from "react";
import { initials, phoneLabel, type Message } from "../lib/api";
import { formatText, openExternal } from "../lib/format";
import { duration, fileSize, useMedia, type LoadedMedia } from "../lib/media";
export const quickReactions = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
/** Stored without its sender, so it reads as sent by the group itself. */
export function unknownSender(m: Message) {
  return m.direction === "incoming" && m.senderId === m.chatId;
}
/** One person, whether a message names them by LID or by phone number. */
export function who(m: Message) {
  return m.senderPhone || m.senderId;
}
/** A stable hue per sender, so each person keeps one colour in a group. */
export function senderHue(id: string) {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(hash) % 360;
}
/** The sender's number; a LID is not a phone number, so it is never shown as one. */
function senderPhone(m: Message) {
  return m.senderPhone ? phoneLabel(m.senderPhone) : null;
}
export function senderLabel(m: Message, peer?: string) {
  return m.direction === "outgoing" ? "You" : m.senderName || peer || senderPhone(m) || "Unknown member";
}
const typeLabels: Record<Message["type"], string> = {
  text: "Message",
  image: "Photo",
  video: "Video",
  audio: "Audio",
  document: "Document",
  sticker: "Sticker",
  location: "Location",
  contact: "Contact",
  poll: "Poll",
  unknown: "Message",
};
const typeIcons: Partial<Record<Message["type"], string>> = {
  image: "📷",
  video: "🎥",
  audio: "🎤",
  document: "📄",
  sticker: "💟",
  location: "📍",
  contact: "👤",
  poll: "📊",
};
/** A one-line summary for quotes and the reply bar, like WhatsApp's. */
export function summary(m: Pick<Message, "type" | "text" | "deletedAt" | "media">) {
  if (m.deletedAt) return "🚫 This message was deleted";
  if (m.type === "text") return m.text || "";
  const label =
    m.type === "audio" && m.media?.ptt ? "Voice message" : typeLabels[m.type];
  const text = m.type === "poll" ? m.text?.split("\n")[0] : m.text;
  return [typeIcons[m.type], text || label].filter(Boolean).join(" ");
}
export interface BubbleActions {
  reply: (m: Message) => void;
  react: (m: Message, emoji: string) => void;
  open: (m: Message, media: LoadedMedia) => void;
  save: (m: Message) => void;
  jump: (messageId: string) => void;
}
export function MessageBubble({
  message: m,
  group,
  continued,
  highlighted,
  canAct,
  actions,
  peer,
}: {
  message: Message;
  /** The other person's name in a direct chat. */
  peer?: string;
  group?: boolean;
  /** Same sender as the message above, so the name and avatar are not repeated. */
  continued?: boolean;
  highlighted?: boolean;
  /** Connected, so replies and reactions can be sent. */
  canAct: boolean;
  actions: BubbleActions;
}) {
  const [picking, setPicking] = useState(false);
  const deleted = !!m.deletedAt;
  const sticker = m.type === "sticker" && !deleted;
  const mine = m.reactions?.find((r) => r.mine)?.emoji;
  const caption = m.type === "document" && m.text === m.media?.fileName ? undefined : m.text;
  const showText = !deleted && !!caption && !["poll", "contact", "location"].includes(m.type);
  const bubble = (
    <article
      id={"msg-" + m.id}
      className={
        "message " +
        m.direction +
        (sticker ? " sticker" : "") +
        (["image", "video"].includes(m.type) && !deleted ? " has-media" : "") +
        (highlighted ? " highlighted" : "") +
        (m.reactions?.length ? " has-reactions" : "")
      }
      onDoubleClick={() => canAct && !deleted && actions.reply(m)}
    >
      {m.direction === "incoming" && group && !continued ? <MessageSender message={m} /> : null}
      {m.quoted ? <Quote quoted={m.quoted} jump={actions.jump} peer={peer} /> : null}
      {deleted ? (
        <p className="deleted">🚫 {m.direction === "outgoing" ? "You deleted this message" : "This message was deleted"}</p>
      ) : (
        <MessageContent message={m} actions={actions} />
      )}
      {showText ? <p>{formatText(caption!)}</p> : null}
      <footer className="message-meta">
        {m.editedAt && !deleted ? <span className="edited">Edited</span> : null}
        <time dateTime={new Date(m.timestamp).toISOString()}>
          {new Date(m.timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
        </time>
        {m.direction === "outgoing" ? <Ticks status={m.status} /> : null}
      </footer>
      {m.reactions?.length ? (
        <div className="reactions" aria-label="Reactions">
          {m.reactions.map((r) => (
            <button
              key={r.emoji}
              className={"reaction" + (r.mine ? " mine" : "")}
              title={r.mine ? "Remove your reaction" : "React with " + r.emoji}
              disabled={!canAct}
              onClick={() => actions.react(m, r.mine ? "" : r.emoji)}
            >
              {r.emoji}
              {r.count > 1 ? <span>{r.count}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      {!deleted ? (
        <div className={"message-actions" + (picking ? " open" : "")}>
          {picking ? (
            <div className="reaction-picker" role="menu" aria-label="Choose a reaction">
              {quickReactions.map((emoji) => (
                <button
                  key={emoji}
                  role="menuitem"
                  className={emoji === mine ? "mine" : ""}
                  aria-label={emoji === mine ? "Remove " + emoji : "React " + emoji}
                  onClick={() => {
                    setPicking(false);
                    actions.react(m, emoji === mine ? "" : emoji);
                  }}
                >
                  {emoji}
                </button>
              ))}
              <button className="picker-close" aria-label="Close reactions" onClick={() => setPicking(false)}>
                ✕
              </button>
            </div>
          ) : (
            <>
              <button title="React" aria-label="React to message" disabled={!canAct} onClick={() => setPicking(true)}>
                <SmileIcon />
              </button>
              <button title="Reply" aria-label="Reply to message" disabled={!canAct} onClick={() => actions.reply(m)}>
                <ReplyIcon />
              </button>
              {["image", "video", "audio", "document", "sticker"].includes(m.type) ? (
                <button title="Save to Downloads" aria-label="Save attachment to Downloads" onClick={() => actions.save(m)}>
                  <DownloadIcon />
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </article>
  );
  if (m.direction !== "incoming" || !group) return bubble;
  const name = senderLabel(m);
  return (
    <div
      className={"message-row" + (continued ? " continued" : "")}
      style={{ "--sender-hue": senderHue(who(m)) } as CSSProperties}
    >
      {continued ? (
        <span className="sender-avatar spacer" aria-hidden="true" />
      ) : (
        <span className="sender-avatar" aria-hidden="true" title={name}>
          {m.senderName ? initials(m.senderName) : "?"}
        </span>
      )}
      {bubble}
    </div>
  );
}
function MessageSender({ message: m }: { message: Message }) {
  const phone = senderPhone(m);
  return (
    <div className="message-sender" title={m.senderId}>
      <strong>{senderLabel(m)}</strong>
      {m.senderName && phone ? <small>{phone}</small> : null}
    </div>
  );
}
function Quote({ quoted: q, jump, peer }: { quoted: NonNullable<Message["quoted"]>; jump: (id: string) => void; peer?: string }) {
  const name = q.fromMe
    ? "You"
    : q.senderName || peer || (q.senderId?.endsWith("@s.whatsapp.net") ? phoneLabel(q.senderId) : "Member");
  const hue = senderHue(q.senderId || name);
  return (
    <button
      type="button"
      className="quote"
      style={{ "--sender-hue": hue } as CSSProperties}
      disabled={!q.messageId}
      title={q.messageId ? "Go to the original message" : "The original message is not stored on this device"}
      onClick={(e) => {
        e.stopPropagation();
        if (q.messageId) jump(q.messageId);
      }}
    >
      <strong>{name}</strong>
      <span>{q.type === "text" ? (q.text ?? "🚫 This message was deleted") : summary(q)}</span>
    </button>
  );
}
function MessageContent({ message: m, actions }: { message: Message; actions: BubbleActions }) {
  if (m.mediaAvailable === false && ["image", "video", "audio", "document", "sticker"].includes(m.type))
    return (
      <div className="media-card pending-media">
        <span className="media-icon" aria-hidden="true">{typeIcons[m.type]}</span>
        <span className="media-text">
          <strong>{m.type === "document" ? m.media?.fileName || "Document" : m.type === "audio" && m.media?.ptt ? "Voice message" : typeLabels[m.type]}</strong>
          <small>Not on this device yet. It loads once WhatsApp sends this chat’s history again.</small>
        </span>
      </div>
    );
  switch (m.type) {
    case "image":
    case "sticker":
      return <ImageMedia message={m} open={actions.open} />;
    case "video":
      return <VideoMedia message={m} />;
    case "audio":
      return <AudioMedia message={m} />;
    case "document":
      return (
        <div className="media-card document">
          <span className="media-icon" aria-hidden="true">{extension(m.media?.fileName, m.media?.mimetype)}</span>
          <span className="media-text">
            <strong>{m.media?.fileName || "Document"}</strong>
            <small>{[fileSize(m.media?.size), m.media?.mimetype?.split("/")[1]?.toUpperCase()].filter(Boolean).join(" · ")}</small>
          </span>
          <button className="media-save" title="Save to Downloads" aria-label="Save document to Downloads" onClick={() => actions.save(m)}>
            <DownloadIcon />
          </button>
        </div>
      );
    case "location": {
      const { latitude, longitude } = m.media ?? {};
      const where = latitude !== undefined && longitude !== undefined ? `${latitude},${longitude}` : null;
      return (
        <div className="media-card">
          <span className="media-icon" aria-hidden="true">📍</span>
          <span className="media-text">
            <strong>{m.text || "Location"}</strong>
            {where ? <small>{latitude!.toFixed(5)}, {longitude!.toFixed(5)}</small> : null}
          </span>
          {where ? (
            <button className="text-button" onClick={() => openExternal("https://www.google.com/maps/search/?api=1&query=" + where)}>
              Open map
            </button>
          ) : null}
        </div>
      );
    }
    case "contact":
      return (
        <div className="media-card">
          <span className="media-icon" aria-hidden="true">👤</span>
          <span className="media-text">
            <strong>{m.text || "Contact"}</strong>
            <small>Contact card</small>
          </span>
        </div>
      );
    case "poll": {
      const [question, ...options] = (m.text || "Poll").split("\n");
      return (
        <div className="poll">
          <small>📊 Poll</small>
          <strong>{question}</strong>
          {options.map((o, i) => (
            <span key={i}>{o.replace(/^○ /, "")}</span>
          ))}
          <small>Vote on your phone</small>
        </div>
      );
    }
    case "unknown":
      return <div className="media-label">This message type isn’t supported yet. Open it on your phone.</div>;
    default:
      return null;
  }
}
function extension(name?: string, mimetype?: string) {
  const ext = name?.includes(".") ? name.split(".").pop() : mimetype?.split("/")[1];
  return (ext || "file").slice(0, 4).toUpperCase();
}
/** Room an image takes before it loads, so the chat does not jump. */
function frame(m: Message, max: number): CSSProperties {
  const w = m.media?.width, h = m.media?.height;
  if (!w || !h) return { width: max, aspectRatio: "4 / 3" };
  const scale = Math.min(1, max / w, (max * 1.2) / h);
  return { width: Math.max(120, Math.round(w * scale)), aspectRatio: `${w} / ${h}` };
}
function Unavailable({ error, retry, children }: { error: string; retry?: () => void; children?: ReactNode }) {
  return (
    <div className="media-missing">
      {children}
      <span>{error}</span>
      {retry ? (
        <button className="text-button" onClick={retry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}
function ImageMedia({ message: m, open }: { message: Message; open: BubbleActions["open"] }) {
  const media = useMedia(m.id, true, { lazy: true });
  const sticker = m.type === "sticker";
  return (
    <div
      ref={media.ref as React.RefObject<HTMLDivElement>}
      className={"media-frame" + (sticker ? " sticker-frame" : "")}
      style={sticker ? undefined : frame(m, 300)}
    >
      {media.status === "ready" ? (
        <button
          type="button"
          className={"media-open" + (media.media.complete ? "" : " partial")}
          aria-label={sticker ? "Sticker" : "Open photo"}
          onClick={() => !sticker && open(m, media.media)}
        >
          <img src={media.media.url} alt={sticker ? "Sticker" : m.text || "Photo"} />
          {!media.media.complete ? (
            <span className="media-overlay" onClick={(e) => (e.stopPropagation(), media.retry())}>
              {media.media.error || "Couldn’t download the full photo"} · Try again
            </span>
          ) : null}
        </button>
      ) : media.status === "error" ? (
        <Unavailable error={media.error} retry={media.retry}>
          <span aria-hidden="true">{sticker ? "💟" : "📷"}</span>
        </Unavailable>
      ) : (
        <div className="media-loading" aria-label="Loading photo" />
      )}
    </div>
  );
}
function VideoMedia({ message: m }: { message: Message }) {
  const [play, setPlay] = useState(false);
  const poster = useMedia(m.id, true, { preview: true, lazy: true });
  const video = useMedia(m.id, play);
  return (
    <div ref={poster.ref as React.RefObject<HTMLDivElement>} className="media-frame" style={frame(m, 300)}>
      {video.status === "ready" && video.media.complete ? (
        <video src={video.media.url} controls autoPlay playsInline />
      ) : (
        <button type="button" className="media-open video-poster" aria-label="Play video" onClick={() => (play ? video.retry() : setPlay(true))}>
          {poster.status === "ready" ? <img src={poster.media.url} alt="" /> : <div className="media-loading still" />}
          <span className="play-button" aria-hidden="true">
            {video.status === "loading" ? <span className="spinner" /> : "▶"}
          </span>
          {m.media?.seconds ? <span className="media-duration">{duration(m.media.seconds)}</span> : null}
          {video.status === "error" || (video.status === "ready" && !video.media.complete) ? (
            <span className="media-overlay">{video.error || video.media?.error || "Couldn’t download the video"} · Try again</span>
          ) : null}
        </button>
      )}
    </div>
  );
}
function AudioMedia({ message: m }: { message: Message }) {
  const [play, setPlay] = useState(false);
  const audio = useMedia(m.id, play);
  const label = m.media?.ptt ? "Voice message" : "Audio";
  if (audio.status === "ready")
    return <audio className="audio-player" src={audio.media.url} controls autoPlay />;
  return (
    <div className="media-card audio">
      <button
        className="audio-play"
        aria-label={"Play " + label.toLowerCase()}
        onClick={() => (play ? audio.retry() : setPlay(true))}
      >
        {audio.status === "loading" ? <span className="spinner" /> : "▶"}
      </button>
      <span className="media-text">
        <strong>{m.media?.ptt ? "🎤 " : "🎵 "}{label}</strong>
        <small>{audio.status === "error" ? audio.error : duration(m.media?.seconds) || "Tap to play"}</small>
      </span>
    </div>
  );
}
function Ticks({ status }: { status?: Message["status"] }) {
  if (!status) return null;
  if (status === "failed")
    return <span className="ticks failed" title="Not delivered">!</span>;
  if (status === "pending")
    return (
      <span className="ticks" title="Sending">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.5 1.5" /></svg>
      </span>
    );
  const double = status !== "sent";
  return (
    <span className={"ticks " + status} title={status === "read" ? "Read" : status === "delivered" ? "Delivered" : "Sent"}>
      <svg width={double ? 17 : 12} height="11" viewBox={double ? "0 0 17 11" : "0 0 12 11"} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {double ? (
          <>
            <path d="M1 6l3 3 6-7" />
            <path d="M7 8.5l.5.5 6-7" />
          </>
        ) : (
          <path d="M1 6l3 3 6-7" />
        )}
      </svg>
    </span>
  );
}
function ReplyIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></svg>;
}
function SmileIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01" /></svg>;
}
export function DownloadIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>;
}
export function AttachIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m21 11-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l9-9a3.7 3.7 0 0 1 5.2 5.2l-9 9a1.8 1.8 0 0 1-2.6-2.6L15.5 6" /></svg>;
}
