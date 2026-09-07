import type { Database } from "bun:sqlite";
import type { Message, MessagePage } from "../messaging/types";
import { ChatRepository } from "../chats/chat-repository";
const columns = `id,provider,provider_message_id AS providerMessageId,chat_id AS chatId,sender_id AS senderId,direction,type,text,timestamp`;
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
      return (
        this.db
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
          ).changes > 0
      );
    })();
  }
  get(id: string) {
    return this.db
      .query(`SELECT ${columns} FROM messages WHERE id=?`)
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
              `SELECT ${columns} FROM messages WHERE chat_id=? AND (timestamp < ? OR (timestamp=? AND id<?)) ORDER BY timestamp DESC,id DESC LIMIT ?`,
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
              `SELECT ${columns} FROM messages WHERE chat_id=? ORDER BY timestamp DESC,id DESC LIMIT ?`,
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
