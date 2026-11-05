import type { MessagingProvider } from "../messaging/messaging-provider";
import type {
  Message,
  MessageChange,
  MessageReceipt,
  OutgoingMedia,
  ReactionUpdate,
  ReceivedMessage,
} from "../messaging/types";
import { MessageRepository } from "./message-repository";
import { EventBus } from "../events/event-bus";
import { downloads, saveNew } from "../config/downloads";
const extensions: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "application/pdf": ".pdf",
};
/** A safe file name for a downloaded attachment. */
export function mediaFileName(
  message: { type: string; timestamp: number; media?: { fileName?: string } | null },
  mimetype: string,
) {
  const given = message.media?.fileName
    ?.replace(/[\/\\:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/^[.\s-]+/, "")
    .slice(0, 120);
  if (given) return given;
  const d = new Date(message.timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} at ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
  const kind = message.type[0]!.toUpperCase() + message.type.slice(1);
  return `WhatsApp ${kind} ${stamp}${extensions[mimetype.split(";")[0]!.trim()] ?? ""}`;
}
export function resolveChatId(value: string) {
  const clean = value.trim();
  if (/^\+?\d{7,15}$/.test(clean))
    return clean.replace(/^\+/, "") + "@s.whatsapp.net";
  if (
    /^(\d{7,20}@s\.whatsapp\.net|\d{7,20}@lid|\d{5,20}(?:-\d{5,20})?@g\.us)$/.test(
      clean,
    )
  )
    return clean;
  throw new Error(
    "Use an international phone number or valid WhatsApp chat ID",
  );
}
/** What leaves the sidecar: the media download reference stays inside. */
function visible({ mediaSource: _, ...message }: ReceivedMessage): Message {
  return message;
}
/** Largest attachment sent or fetched through the desktop app. */
export const maxMediaBytes = 16 * 1024 * 1024;
export class MessageService {
  constructor(
    private provider: MessagingProvider,
    private repository: MessageRepository,
    private events: EventBus,
  ) {}
  receive(message: ReceivedMessage, live: boolean) {
    const inserted = this.repository.save(message);
    if (inserted) {
      this.events.publish(
        live && message.direction === "incoming"
          ? "message.received"
          : "message.synced",
        visible(message),
      );
      this.events.publish("chat.updated", { id: message.chatId });
    }
    return inserted;
  }
  receipt(receipt: MessageReceipt) {
    if (this.repository.receipt(receipt))
      this.events.publish("message.status", receipt);
  }
  reaction(reaction: ReactionUpdate) {
    const chatId = this.repository.react(reaction);
    if (chatId) this.events.publish("message.reaction", { chatId, ...reaction });
  }
  change(change: MessageChange) {
    const chatId = this.repository.change(change);
    if (chatId)
      this.events.publish(
        change.kind === "delete" ? "message.deleted" : "message.edited",
        { chatId, ...change },
      );
  }
  /** A stored message in this chat to reply to; replies stay in their chat. */
  private replyTarget(chatId: string, replyTo?: string) {
    if (!replyTo) return undefined;
    const target = this.repository.source(replyTo);
    if (!target || target.chatId !== chatId)
      throw new Error("Invalid reply: that message is not in this chat");
    if (target.deletedAt) throw new Error("Invalid reply: that message was deleted");
    return target;
  }
  private ready(chatId: string) {
    chatId = resolveChatId(chatId);
    if (this.provider.getConnectionState().status !== "connected")
      throw new Error("WhatsApp is disconnected");
    return chatId;
  }
  private sent(message: ReceivedMessage) {
    this.repository.save(message);
    const shown = this.repository.get(message.id) ?? visible(message);
    this.events.publish("message.sent", shown);
    this.events.publish("chat.updated", { id: message.chatId });
    return shown;
  }
  async send(chatId: string, text: string, options: { replyTo?: string } = {}) {
    text = text.trim();
    if (!text || text.length > 10000)
      throw new Error("Text must contain 1–10,000 characters");
    chatId = this.ready(chatId);
    const quoted = this.replyTarget(chatId, options.replyTo);
    const message = await this.provider.sendText(chatId, text, quoted ? { quoted } : {});
    return this.sent(message);
  }
  async sendMedia(
    chatId: string,
    media: OutgoingMedia,
    options: { replyTo?: string } = {},
  ) {
    if (!media.data.length) throw new Error("Invalid attachment: the file is empty");
    if (media.data.length > maxMediaBytes)
      throw new Error("Invalid attachment: files can be up to 16 MB");
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(media.mimetype))
      throw new Error("Invalid attachment type");
    const caption = media.caption?.trim();
    if (caption && caption.length > 4000)
      throw new Error("Invalid caption: use up to 4,000 characters");
    chatId = this.ready(chatId);
    const quoted = this.replyTarget(chatId, options.replyTo);
    const message = await this.provider.sendMedia(
      chatId,
      { ...media, caption: caption || undefined, fileName: media.fileName?.slice(0, 200) },
      quoted ? { quoted } : {},
    );
    return this.sent(message);
  }
  /** Reacts to a message; an empty emoji removes our reaction. */
  async react(messageId: string, emoji: string) {
    if (emoji.length > 16 || /[\s]/.test(emoji)) throw new Error("Invalid reaction");
    const target = this.repository.source(messageId);
    if (!target) throw new Error("Invalid message");
    if (target.deletedAt) throw new Error("Invalid reaction: that message was deleted");
    this.ready(target.chatId);
    await this.provider.react(target, emoji);
    this.reaction({
      providerMessageId: target.providerMessageId,
      senderId: "me",
      emoji,
      timestamp: Date.now(),
    });
    return this.repository.get(messageId);
  }
  /** Only the embedded preview, without downloading: for videos before they play. */
  preview(messageId: string) {
    const target = this.repository.source(messageId);
    if (!target || target.deletedAt) throw new Error("Invalid message");
    const data = this.provider.thumbnail(target);
    if (!data) throw new Error("Media preview is unavailable");
    return { mimetype: "image/jpeg", data, complete: false };
  }
  /**
   * A message's attachment: from the local cache, else downloaded once and
   * cached. When the download fails, the embedded preview stands in.
   */
  async media(messageId: string) {
    const target = this.repository.source(messageId);
    if (!target || target.deletedAt) throw new Error("Invalid message");
    const cached = this.repository.cachedMedia(messageId);
    if (cached) return { ...cached, complete: true };
    if (!target.mediaSource) throw new Error("Media is unavailable for this message");
    try {
      const data = await this.provider.downloadMedia(target);
      if (data.length > maxMediaBytes)
        throw new Error("Media is too large to open here. Open it on your phone.");
      const mimetype = target.mimetype || "application/octet-stream";
      this.repository.cacheMedia(messageId, mimetype, data);
      return { mimetype, data, complete: true };
    } catch (error) {
      const preview = this.provider.thumbnail(target);
      if (preview)
        return {
          mimetype: "image/jpeg",
          data: preview,
          complete: false,
          error: error instanceof Error ? error.message : undefined,
        };
      throw error instanceof Error && /^Media /.test(error.message)
        ? error
        : new Error("Media could not be downloaded. Try again later.");
    }
  }
  /** Saves an attachment to Downloads, never overwriting, and returns its path. */
  async saveMedia(messageId: string, dir = downloads()) {
    const media = await this.media(messageId);
    if (!media.complete) throw new Error(media.error || "Media could not be downloaded. Try again later.");
    const message = this.repository.get(messageId)!;
    const path = saveNew(dir, mediaFileName(message, media.mimetype), media.data);
    if (!path)
      throw new Error("Media could not be saved. Check that your Downloads folder is writable.");
    return { path };
  }
}
