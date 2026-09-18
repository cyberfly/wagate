import type { Database } from "bun:sqlite";
import type { Chat, ChatUpdate } from "../messaging/types";
// A chat's own name is its id until WhatsApp supplies one (a group subject, or
// a name from history sync), so contact names fill in for direct chats.
const columns = `c.id,c.provider,COALESCE(k.name,NULLIF(c.name,c.id),k.push_name,c.id) AS name,
 c.type,c.last_message_at AS lastMessageAt,c.ai_mode AS aiMode,
 COALESCE(c.inbox_pinned,c.pinned_at IS NOT NULL) AS pinned,c.archived<>0 AS archived,
 (SELECT COALESCE(m.text,'[' || m.type || ']') FROM messages m WHERE m.chat_id=c.id
  ORDER BY m.timestamp DESC,m.id DESC LIMIT 1) AS lastMessage`;
const from = "chats c LEFT JOIN contacts k ON k.id=c.id";
type Row = Omit<Chat, "pinned" | "archived"> & {
  pinned: number;
  archived: number;
};
const toChat = (row: Row | null): Chat | null =>
  row && { ...row, pinned: !!row.pinned, archived: !!row.archived };
export class ChatRepository {
  constructor(private db: Database) {}
  upsert(chat: Omit<Chat, "aiMode" | "pinned" | "archived">) {
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
  /**
   * Applies what WhatsApp reports about a chat. Account sync mentions every
   * chat ever archived, muted, pinned or read, with no activity time; those
   * update known chats but never add one, or the inbox fills with chats it
   * cannot place in WhatsApp's order.
   */
  apply(update: ChatUpdate) {
    return this.db.transaction(() => {
      const known = !!this.db.query("SELECT 1 FROM chats WHERE id=?").get(update.id);
      if (!known && !update.lastMessageAt) return false;
      this.upsert({
        id: update.id,
        provider: "whatsapp",
        name: update.name || update.id,
        type: update.type,
        lastMessageAt: update.lastMessageAt ?? null,
      });
      if (update.pinnedAt !== undefined)
        this.db
          .query("UPDATE chats SET pinned_at=? WHERE id=?")
          .run(update.pinnedAt, update.id);
      if (update.archived !== undefined)
        this.db
          .query("UPDATE chats SET archived=? WHERE id=?")
          .run(update.archived ? 1 : 0, update.id);
      return true;
    })();
  }
  get(id: string) {
    return toChat(
      this.db.query(`SELECT ${columns} FROM ${from} WHERE c.id=?`).get(id) as Row | null,
    );
  }
  /**
   * Local pin choices override synced WhatsApp pins. Most recently pinned
   * first, then by last activity, with archived chats after the rest.
   * Chats with no known activity are left out.
   */
  list() {
    return (
      this.db
        .query(
          `SELECT ${columns} FROM ${from} WHERE c.last_message_at IS NOT NULL
           ORDER BY c.archived,COALESCE(c.inbox_pinned,c.pinned_at IS NOT NULL) DESC,
           CASE WHEN c.inbox_pinned IS NULL THEN c.pinned_at ELSE c.inbox_pinned_at END DESC,
           c.last_message_at DESC,c.id`,
        )
        .all() as Row[]
    ).map((row) => toChat(row)!);
  }
  setMode(id: string, mode: Chat["aiMode"]) {
    this.db.query("UPDATE chats SET ai_mode=? WHERE id=?").run(mode, id);
    return this.get(id);
  }
  /** Local pins have no WhatsApp limit and survive subsequent account sync. */
  setPinned(id: string, pinned: boolean) {
    this.db.query("UPDATE chats SET inbox_pinned=?,inbox_pinned_at=? WHERE id=?")
      .run(pinned ? 1 : 0, pinned ? Date.now() : null, id);
    return this.get(id);
  }
}
