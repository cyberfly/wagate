import type { Database } from "bun:sqlite";
import type { Chat, ChatUpdate } from "../messaging/types";
// A chat's own name is its id until WhatsApp supplies one (a group subject, or
// a name from history sync), so contact names fill in for direct chats.
/** A mute still in force: one with no end, or one that ends later. */
const muted = `(c.muted_until=-1 OR c.muted_until>CAST(strftime('%s','now') AS INTEGER)*1000)`;
/** Blocked under the chat's own id or the person's other id. */
const blocked = `EXISTS(SELECT 1 FROM blocked b WHERE b.id=c.id
 OR b.id IN (SELECT l.lid FROM lid_phones l WHERE l.phone=c.id)
 OR b.id IN (SELECT l.phone FROM lid_phones l WHERE l.lid=c.id))`;
const columns = `c.id,c.provider,COALESCE(k.name,NULLIF(c.name,c.id),k.push_name,c.id) AS name,
 c.type,c.last_message_at AS lastMessageAt,c.ai_mode AS aiMode,
 COALESCE(c.inbox_pinned,c.pinned_at IS NOT NULL) AS pinned,c.archived<>0 AS archived,c.unread_count AS unreadCount,
 COALESCE(${muted},0) AS muted,${blocked} AS blocked,
 (SELECT a.changed_at FROM avatars a WHERE a.id=c.id AND a.data IS NOT NULL) AS avatar,
 (SELECT CASE WHEN m.deleted_at IS NOT NULL THEN '🚫 This message was deleted'
   WHEN m.type='text' THEN m.text
   ELSE CASE m.type WHEN 'image' THEN '📷 ' WHEN 'video' THEN '🎥 ' WHEN 'audio' THEN '🎤 ' WHEN 'document' THEN '📄 '
     WHEN 'sticker' THEN '💟 ' WHEN 'location' THEN '📍 ' WHEN 'contact' THEN '👤 ' WHEN 'poll' THEN '📊 ' ELSE '' END
    || COALESCE(substr(m.text,1,CASE WHEN instr(m.text,char(10))>0 THEN instr(m.text,char(10))-1 ELSE 200 END),
     CASE m.type WHEN 'image' THEN 'Photo' WHEN 'video' THEN 'Video' WHEN 'audio' THEN 'Audio' WHEN 'document' THEN 'Document'
      WHEN 'sticker' THEN 'Sticker' WHEN 'location' THEN 'Location' WHEN 'contact' THEN 'Contact' WHEN 'poll' THEN 'Poll' ELSE 'Message' END)
   END FROM messages m WHERE m.chat_id=c.id AND m.type<>'system'
  ORDER BY m.timestamp DESC,m.id DESC LIMIT 1) AS lastMessage`;
const from = "chats c LEFT JOIN contacts k ON k.id=c.id";
type Row = Omit<Chat, "pinned" | "archived" | "muted" | "blocked"> & {
  pinned: number;
  archived: number;
  muted: number;
  blocked: number;
};
const toChat = (row: Row | null): Chat | null =>
  row && {
    ...row,
    pinned: !!row.pinned,
    archived: !!row.archived,
    muted: !!row.muted,
    blocked: !!row.blocked,
  };
export class ChatRepository {
  constructor(private db: Database) {}
  upsert(chat: Omit<Chat, "aiMode" | "pinned" | "archived" | "muted" | "avatar" | "blocked">) {
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
      if (update.mutedUntil !== undefined)
        this.db
          .query("UPDATE chats SET muted_until=? WHERE id=?")
          .run(update.mutedUntil, update.id);
      if (update.unreadCount !== undefined)
        this.db
          .query(
            `UPDATE chats SET unread_count=CASE WHEN ?1<0 THEN MAX(unread_count,1) ELSE ?1 END WHERE id=?2`,
          )
          .run(update.unreadCount, update.id);
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
  /** Chats with unread messages that are neither archived nor muted. */
  unreadChats() {
    return (
      this.db
        .query(
          `SELECT COUNT(*) AS n FROM chats c WHERE c.unread_count>0 AND c.archived=0
           AND c.last_message_at IS NOT NULL AND NOT COALESCE(${muted},0)`,
        )
        .get() as { n: number }
    ).n;
  }
  /** One more unread message, from a live incoming message. */
  addUnread(id: string) {
    this.db.query("UPDATE chats SET unread_count=unread_count+1 WHERE id=?").run(id);
  }
  /** Marks the chat read; returns how many messages were unread. */
  clearUnread(id: string) {
    const row = this.db
      .query("SELECT unread_count AS n FROM chats WHERE id=?")
      .get(id) as { n: number } | null;
    if (row?.n) this.db.query("UPDATE chats SET unread_count=0 WHERE id=?").run(id);
    return row?.n ?? 0;
  }
  /**
   * Takes a deleted chat out of the list: with no known activity it is left
   * out until a new message arrives. Its settings start afresh.
   */
  forget(id: string) {
    this.db
      .query(
        `UPDATE chats SET last_message_at=NULL,unread_count=0,archived=0,pinned_at=NULL,
         inbox_pinned=NULL,inbox_pinned_at=NULL WHERE id=?`,
      )
      .run(id);
  }
  /** Records who this account blocked, as WhatsApp reports it. */
  setBlocked(ids: string[], kind: "set" | "add" | "remove") {
    this.db.transaction(() => {
      if (kind === "set") this.db.query("DELETE FROM blocked").run();
      const change = this.db.query(
        kind === "remove"
          ? `DELETE FROM blocked WHERE id=?1 OR id IN (SELECT lid FROM lid_phones WHERE phone=?1)
             OR id IN (SELECT phone FROM lid_phones WHERE lid=?1)`
          : "INSERT OR IGNORE INTO blocked(id) VALUES(?1)",
      );
      for (const id of ids) change.run(id);
    })();
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
