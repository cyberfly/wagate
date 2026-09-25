import type { Database } from "bun:sqlite";
import type { Message, MessagePage } from "../messaging/types";
import { ChatRepository } from "../chats/chat-repository";
// A LID sender is looked up through its phone number too: names saved in your
// phone are stored under the number.
const columns = `m.id,m.provider,m.provider_message_id AS providerMessageId,m.chat_id AS chatId,m.sender_id AS senderId,
 COALESCE(p.name,k.name,k.push_name,p.push_name) AS senderName,
 CASE WHEN m.sender_id LIKE '%@s.whatsapp.net' THEN m.sender_id ELSE l.phone END AS senderPhone,
 m.direction,m.type,m.text,m.timestamp`;
const from = `messages m LEFT JOIN contacts k ON k.id=m.sender_id
 LEFT JOIN lid_phones l ON l.lid=m.sender_id LEFT JOIN contacts p ON p.id=l.phone`;
export class MessageRepository {
  constructor(
    private db: Database,
    private chats: ChatRepository,
  ) {}
  save(message: Message) {
    return this.db.transaction(() => {
      this.chats.upsert({
        id: message.chatId,
        provider: "whatsapp",
        name: message.chatId,
        type: message.chatId.endsWith("@g.us") ? "group" : "direct",
        lastMessageAt: message.timestamp,
      });
      const inserted = this.db
          .query(
            `INSERT OR IGNORE INTO messages(id,provider,provider_message_id,chat_id,sender_id,direction,type,text,timestamp,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
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
          ).changes > 0;
      // Group history was once stored without its sender, which then read as
      // the group itself. A later copy of the same message can fill it in.
      if (!inserted && message.senderId !== message.chatId)
        this.db
          .query(
            `UPDATE messages SET sender_id=? WHERE id=? AND sender_id=chat_id AND chat_id LIKE '%@g.us'`,
          )
          .run(message.senderId, message.id);
      return inserted;
    })();
  }
  /**
   * The newest message of a group whose stored page has messages without a
   * sender, or null when every sender is known.
   */
  senderRepairAnchor(chatId: string) {
    const unknown = this.db
      .query(
        `SELECT 1 FROM (SELECT sender_id,chat_id,direction FROM messages WHERE chat_id=? ORDER BY timestamp DESC,id DESC LIMIT 50)
         WHERE sender_id=chat_id AND direction='incoming' LIMIT 1`,
      )
      .get(chatId);
    if (!unknown || !chatId.endsWith("@g.us")) return null;
    return this.db
      .query(
        `SELECT ${columns} FROM ${from} WHERE m.chat_id=? ORDER BY m.timestamp DESC,m.id DESC LIMIT 1`,
      )
      .get(chatId) as Message | null;
  }
  get(id: string) {
    return this.db
      .query(`SELECT ${columns} FROM ${from} WHERE m.id=?`)
      .get(id) as Message | null;
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
    ) as Message[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
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
