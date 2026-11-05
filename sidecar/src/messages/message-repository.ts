import type { Database } from "bun:sqlite";
import type {
  Message,
  MessageChange,
  MessagePage,
  MessageReceipt,
  MessageStatus,
  QuotedMessage,
  Reaction,
  ReactionUpdate,
  ReceivedMessage,
} from "../messaging/types";
import type { StoredMessage } from "../messaging/messaging-provider";
import { ChatRepository } from "../chats/chat-repository";
// A LID sender is looked up through its phone number too: names saved in your
// phone are stored under the number.
const columns = `m.id,m.provider,m.provider_message_id AS providerMessageId,m.chat_id AS chatId,m.sender_id AS senderId,
 COALESCE(p.name,k.name,k.push_name,p.push_name) AS senderName,
 CASE WHEN m.sender_id LIKE '%@s.whatsapp.net' THEN m.sender_id ELSE l.phone END AS senderPhone,
 m.direction,m.type,m.text,m.timestamp,m.media,m.quoted,m.status,m.edited_at AS editedAt,m.deleted_at AS deletedAt,m.forwarded,m.mentions,
 m.media_source IS NOT NULL AS mediaAvailable`;
const from = `messages m LEFT JOIN contacts k ON k.id=m.sender_id
 LEFT JOIN lid_phones l ON l.lid=m.sender_id LEFT JOIN contacts p ON p.id=l.phone`;
/** Later statuses only: a late delivery receipt never undoes a read. */
const rank: Record<MessageStatus, number> = {
  pending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 4,
};
type Row = Omit<Message, "media" | "quoted" | "mediaAvailable" | "forwarded" | "mentions"> & {
  forwarded: number;
  mentions: string | null;
  media: string | null;
  quoted: string | null;
  mediaAvailable: number;
};
function parse<T>(json: string | null): T | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}
export class MessageRepository {
  constructor(
    private db: Database,
    readonly chats: ChatRepository,
  ) {}
  save(message: ReceivedMessage) {
    return this.db.transaction(() => {
      this.chats.upsert({
        id: message.chatId,
        provider: "whatsapp",
        name: message.chatId,
        type: message.chatId.endsWith("@g.us") ? "group" : "direct",
        lastMessageAt: message.timestamp,
      });
      const media = message.media ? JSON.stringify(message.media) : null,
        source = message.mediaSource ?? null,
        quoted = message.quoted ? JSON.stringify(message.quoted) : null,
        mentions = message.mentions?.length
          ? JSON.stringify(message.mentions.map((m) => m.id))
          : null;
      const inserted =
        this.db
          .query(
            `INSERT OR IGNORE INTO messages(id,provider,provider_message_id,chat_id,sender_id,direction,type,text,timestamp,created_at,media,media_source,quoted,status,deleted_at,forwarded,mentions)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            message.id,
            message.provider,
            message.providerMessageId,
            message.chatId,
            message.senderId,
            message.direction,
            message.type,
            message.text ?? null,
            message.timestamp,
            Date.now(),
            media,
            source,
            quoted,
            message.status ?? null,
            message.deletedAt ?? null,
            message.forwarded ? 1 : 0,
            mentions,
          ).changes > 0;
      if (!inserted) {
        // Group history was once stored without its sender, which then read as
        // the group itself. A later copy of the same message can fill it in.
        if (message.senderId !== message.chatId)
          this.db
            .query(
              `UPDATE messages SET sender_id=? WHERE id=? AND sender_id=chat_id AND chat_id LIKE '%@g.us'`,
            )
            .run(message.senderId, message.id);
        // Messages stored before attachments and replies were kept gain them
        // from any later copy.
        this.db
          .query(
            `UPDATE messages SET media=COALESCE(media,?),media_source=COALESCE(media_source,?),quoted=COALESCE(quoted,?),
             mentions=COALESCE(mentions,?),forwarded=MAX(forwarded,?),
             type=CASE WHEN type='unknown' THEN ? ELSE type END,text=COALESCE(text,?) WHERE id=? AND deleted_at IS NULL`,
          )
          .run(media, source, quoted, mentions, message.forwarded ? 1 : 0, message.type, message.text ?? null, message.id);
        if (message.status) this.setStatus(message.providerMessageId, message.status);
      }
      return inserted;
    })();
  }
  /** Moves our message's status forward; returns whether it changed. */
  setStatus(providerMessageId: string, status: MessageStatus) {
    const rows = this.db
      .query(
        `SELECT id,status FROM messages WHERE provider_message_id=? AND direction='outgoing'`,
      )
      .all(providerMessageId) as { id: string; status: MessageStatus | null }[];
    let changed = false;
    for (const row of rows)
      if (!row.status || rank[status] > rank[row.status]) {
        this.db.query(`UPDATE messages SET status=? WHERE id=?`).run(status, row.id);
        changed = true;
      }
    return changed;
  }
  receipt(receipt: MessageReceipt) {
    return this.setStatus(receipt.providerMessageId, receipt.status);
  }
  /** Records a reaction, or removes one for an empty emoji; returns the chat it is in. */
  react(reaction: ReactionUpdate) {
    if (reaction.emoji)
      this.db
        .query(
          `INSERT INTO reactions(provider_message_id,sender_id,emoji,timestamp) VALUES(?,?,?,?)
           ON CONFLICT(provider_message_id,sender_id) DO UPDATE SET emoji=excluded.emoji,timestamp=excluded.timestamp
           WHERE excluded.timestamp>=reactions.timestamp`,
        )
        .run(reaction.providerMessageId, reaction.senderId, reaction.emoji, reaction.timestamp);
    else
      this.db
        .query(`DELETE FROM reactions WHERE provider_message_id=? AND sender_id=? AND timestamp<=?`)
        .run(reaction.providerMessageId, reaction.senderId, reaction.timestamp);
    return this.chatOf(reaction.providerMessageId);
  }
  /** Applies an edit or a delete for everyone; returns the chat it is in. */
  change(change: MessageChange) {
    if (change.kind === "delete") {
      this.db
        .query(
          `UPDATE messages SET deleted_at=?,text=NULL,media=NULL,media_source=NULL WHERE provider_message_id=?`,
        )
        .run(change.timestamp, change.providerMessageId);
      this.db
        .query(
          `DELETE FROM media_cache WHERE message_id IN (SELECT id FROM messages WHERE provider_message_id=?)`,
        )
        .run(change.providerMessageId);
    } else
      this.db
        .query(
          `UPDATE messages SET text=?,edited_at=? WHERE provider_message_id=? AND deleted_at IS NULL`,
        )
        .run(change.text ?? null, change.timestamp, change.providerMessageId);
    return this.chatOf(change.providerMessageId);
  }
  private chatOf(providerMessageId: string) {
    return (
      (
        this.db
          .query(`SELECT chat_id AS chatId FROM messages WHERE provider_message_id=? LIMIT 1`)
          .get(providerMessageId) as { chatId: string } | null
      )?.chatId ?? null
    );
  }
  /** What the provider needs to quote, react to or download a message. */
  source(id: string): (StoredMessage & { id: string; deletedAt: number | null; mimetype?: string }) | null {
    const row = this.db
      .query(
        `SELECT id,chat_id AS chatId,provider_message_id AS providerMessageId,direction,sender_id AS senderId,type,text,
         media_source AS mediaSource,media,deleted_at AS deletedAt FROM messages WHERE id=?`,
      )
      .get(id) as
      | (StoredMessage & { id: string; media: string | null; deletedAt: number | null })
      | null;
    if (!row) return null;
    const { media, ...rest } = row;
    return {
      ...rest,
      text: rest.text ?? undefined,
      mediaSource: rest.mediaSource ? new Uint8Array(rest.mediaSource) : null,
      mimetype: parse<{ mimetype?: string }>(media)?.mimetype,
    };
  }
  /** A cached attachment; reading it keeps it from being evicted soon. */
  cachedMedia(id: string) {
    const row = this.db
      .query(`SELECT mimetype,data FROM media_cache WHERE message_id=?`)
      .get(id) as { mimetype: string; data: Uint8Array } | null;
    if (!row) return null;
    this.db.query(`UPDATE media_cache SET created_at=? WHERE message_id=?`).run(Date.now(), id);
    return { mimetype: row.mimetype, data: new Uint8Array(row.data) };
  }
  /**
   * Caches a downloaded attachment, then drops the least recently used ones
   * beyond `limit` bytes. They can be downloaded again while WhatsApp keeps them.
   */
  cacheMedia(id: string, mimetype: string, data: Uint8Array, limit = 512 * 1024 * 1024) {
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT OR REPLACE INTO media_cache(message_id,mimetype,data,created_at,size) VALUES(?,?,?,?,?)`,
        )
        .run(id, mimetype, data, Date.now(), data.length);
      this.db
        .query(
          `DELETE FROM media_cache WHERE message_id IN (
             SELECT message_id FROM (SELECT message_id,SUM(size) OVER (ORDER BY created_at DESC,message_id DESC) AS used FROM media_cache)
             WHERE used>?)`,
        )
        .run(limit);
    })();
  }
  /** Deletes a message from this device only ("delete for me"). */
  remove(id: string) {
    return this.db.transaction(() => {
      this.db.query(`DELETE FROM media_cache WHERE message_id=?`).run(id);
      return this.db.query(`DELETE FROM messages WHERE id=?`).run(id).changes > 0;
    })();
  }
  /** The latest incoming messages of a chat, to send read receipts for. */
  latestIncoming(chatId: string, count: number) {
    return (
      this.db
        .query(
          `SELECT id FROM messages WHERE chat_id=? AND direction='incoming' AND deleted_at IS NULL
           ORDER BY timestamp DESC,id DESC LIMIT ?`,
        )
        .all(chatId, count) as { id: string }[]
    ).map((r) => this.source(r.id)!);
  }
  /**
   * The chat's newest message when its latest page needs a fresh copy from
   * WhatsApp: group messages stored without a sender, or attachments stored
   * before they could be downloaded. Null when nothing needs repair.
   */
  senderRepairAnchor(chatId: string) {
    const group = chatId.endsWith("@g.us");
    const broken = this.db
      .query(
        `SELECT 1 FROM (SELECT sender_id,chat_id,direction,type,media_source,deleted_at FROM messages WHERE chat_id=?1 ORDER BY timestamp DESC,id DESC LIMIT 50)
         WHERE (?2 AND sender_id=chat_id AND direction='incoming')
            OR (type IN ('image','video','audio','document','sticker') AND media_source IS NULL AND deleted_at IS NULL) LIMIT 1`,
      )
      .get(chatId, group ? 1 : 0);
    if (!broken) return null;
    const row = this.db
      .query(
        `SELECT ${columns} FROM ${from} WHERE m.chat_id=? ORDER BY m.timestamp DESC,m.id DESC LIMIT 1`,
      )
      .get(chatId) as Row | null;
    return row ? this.hydrate([row])[0]! : null;
  }
  /** The chat's earliest stored message, to ask the phone for what came before. */
  oldest(chatId: string) {
    const row = this.db
      .query(
        `SELECT ${columns} FROM ${from} WHERE m.chat_id=? ORDER BY m.timestamp,m.id LIMIT 1`,
      )
      .get(chatId) as Row | null;
    return row ? this.hydrate([row])[0]! : null;
  }
  get(id: string) {
    const row = this.db
      .query(`SELECT ${columns} FROM ${from} WHERE m.id=?`)
      .get(id) as Row | null;
    return row ? this.hydrate([row])[0]! : null;
  }
  /** Parses stored JSON and adds reactions and the quoted message's details. */
  private hydrate(rows: Row[]): Message[] {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.providerMessageId);
    const marks = ids.map(() => "?").join(",");
    const reactions = new Map<string, Reaction[]>();
    for (const r of this.db
      .query(
        `SELECT provider_message_id AS id,emoji,COUNT(*) AS count,MAX(sender_id='me') AS mine,MIN(timestamp) AS first
         FROM reactions WHERE provider_message_id IN (${marks}) GROUP BY provider_message_id,emoji ORDER BY count DESC,first`,
      )
      .all(...ids) as { id: string; emoji: string; count: number; mine: number }[]) {
      const list = reactions.get(r.id) ?? [];
      list.push({ emoji: r.emoji, count: r.count, mine: !!r.mine });
      reactions.set(r.id, list);
    }
    const quotedLookup = this.db.query(
      `SELECT m.id,m.direction,m.type,m.text,m.deleted_at AS deletedAt,COALESCE(p.name,k.name,k.push_name,p.push_name) AS senderName
       FROM ${from} WHERE m.chat_id=? AND m.provider_message_id=?`,
    );
    const nameLookup = this.db.query(
      `SELECT COALESCE(p.name,k.name,k.push_name,p.push_name) AS name FROM (SELECT ? AS id) s
       LEFT JOIN contacts k ON k.id=s.id LEFT JOIN lid_phones l ON l.lid=s.id LEFT JOIN contacts p ON p.id=l.phone`,
    );
    return rows.map((row) => {
      const ids = parse<string[]>(row.mentions);
      const message: Message = {
        ...row,
        forwarded: !!row.forwarded,
        mentions: ids?.map((id) => ({
          id,
          name: (nameLookup.get(id) as { name: string | null } | null)?.name ?? null,
        })),
        media: parse(row.media),
        mediaAvailable: !!row.mediaAvailable,
        quoted: null,
        reactions: reactions.get(row.providerMessageId) ?? [],
      };
      const quoted = parse<QuotedMessage>(row.quoted);
      if (quoted) {
        // The stored copy is current: it reflects edits, deletion and names.
        const stored = quotedLookup.get(row.chatId, quoted.providerMessageId) as {
          id: string;
          direction: Message["direction"];
          type: Message["type"];
          text: string | null;
          deletedAt: number | null;
          senderName: string | null;
        } | null;
        message.quoted = stored
          ? {
              ...quoted,
              messageId: stored.id,
              fromMe: stored.direction === "outgoing",
              type: stored.type,
              text: stored.deletedAt ? undefined : (stored.text ?? quoted.text)?.slice(0, 500),
              senderName: stored.senderName,
            }
          : {
              ...quoted,
              messageId: null,
              senderName: quoted.senderId
                ? ((nameLookup.get(quoted.senderId) as { name: string | null } | null)?.name ?? null)
                : null,
            };
      }
      return message;
    });
  }
  page(chatId: string, limit = 50, cursor?: string): MessagePage {
    let before: { timestamp: number; id: string } | undefined;
    if (cursor) {
      try {
        before = JSON.parse(Buffer.from(cursor, "base64url").toString());
      } catch {
        throw new Error("Invalid cursor");
      }
      if (
        !before ||
        !Number.isFinite(before.timestamp) ||
        typeof before.id !== "string"
      )
        throw new Error("Invalid cursor");
    }
    const rows = (
      before
        ? this.db
            .query(
              `SELECT ${columns} FROM ${from} WHERE m.chat_id=? AND (m.timestamp < ? OR (m.timestamp=? AND m.id<?)) ORDER BY m.timestamp DESC,m.id DESC LIMIT ?`,
            )
            .all(
              chatId,
              before.timestamp,
              before.timestamp,
              before.id,
              limit + 1,
            )
        : this.db
            .query(
              `SELECT ${columns} FROM ${from} WHERE m.chat_id=? ORDER BY m.timestamp DESC,m.id DESC LIMIT ?`,
            )
            .all(chatId, limit + 1)
    ) as Row[];
    const hasMore = rows.length > limit;
    const page = this.hydrate(rows.slice(0, limit));
    const last = page.at(-1);
    return {
      messages: page.reverse(),
      nextCursor:
        hasMore && last
          ? Buffer.from(
              JSON.stringify({ timestamp: last.timestamp, id: last.id }),
            ).toString("base64url")
          : null,
    };
  }
}
