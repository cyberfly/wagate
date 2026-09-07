import type { Database } from "bun:sqlite";
import type { Chat } from "../messaging/types";
const columns = `id,provider,name,type,last_message_at AS lastMessageAt,ai_mode AS aiMode`;
export class ChatRepository {
  constructor(private db: Database) {}
  upsert(chat: Omit<Chat, "aiMode">) {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO chats(id,provider,provider_chat_id,name,type,last_message_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=CASE WHEN excluded.name=excluded.id THEN chats.name ELSE excluded.name END,last_message_at=CASE WHEN excluded.last_message_at IS NULL THEN chats.last_message_at WHEN chats.last_message_at IS NULL THEN excluded.last_message_at ELSE MAX(chats.last_message_at,excluded.last_message_at) END,updated_at=excluded.updated_at`,
      )
      .run(
        chat.id,
        chat.provider,
        chat.id,
        chat.name,
        chat.type,
        chat.lastMessageAt,
        now,
        now,
      );
    return this.get(chat.id)!;
  }
  get(id: string) {
    return this.db
      .query(`SELECT ${columns} FROM chats WHERE id=?`)
      .get(id) as Chat | null;
  }
  list() {
    return this.db
      .query(
        `SELECT ${columns} FROM chats ORDER BY last_message_at DESC,id LIMIT 1000`,
      )
      .all() as Chat[];
  }
  setMode(id: string, mode: Chat["aiMode"]) {
    this.db.query("UPDATE chats SET ai_mode=? WHERE id=?").run(mode, id);
    return this.get(id);
  }
}
