import type { Database } from "bun:sqlite";
import type { Draft } from "../messaging/types";
const columns =
  "id,chat_id AS chatId,source_message_id AS sourceMessageId,text,status,created_at AS createdAt";
export class DraftRepository {
  constructor(private db: Database) {
    db.query(
      "UPDATE drafts SET status='uncertain' WHERE status='sending'",
    ).run();
  }
  list(chatId: string) {
    return this.db
      .query(
        `SELECT ${columns} FROM drafts WHERE chat_id=? AND status IN ('pending','uncertain') ORDER BY created_at DESC LIMIT 10`,
      )
      .all(chatId) as Draft[];
  }
  get(id: string) {
    return this.db
      .query(`SELECT ${columns} FROM drafts WHERE id=?`)
      .get(id) as Draft | null;
  }
  forSource(id: string) {
    return this.db
      .query(`SELECT ${columns} FROM drafts WHERE source_message_id=?`)
      .get(id) as Draft | null;
  }
  create(chatId: string, sourceMessageId: string, text: string) {
    const id = crypto.randomUUID();
    this.db
      .query(
        "INSERT OR IGNORE INTO drafts(id,chat_id,source_message_id,text,created_at) VALUES(?,?,?,?,?)",
      )
      .run(id, chatId, sourceMessageId, text, Date.now());
    return this.forSource(sourceMessageId)!;
  }
  claim(id: string) {
    return (
      this.db
        .query(
          "UPDATE drafts SET status='sending' WHERE id=? AND status='pending'",
        )
        .run(id).changes === 1
    );
  }
  setStatus(id: string, status: Draft["status"]) {
    this.db.query("UPDATE drafts SET status=? WHERE id=?").run(status, id);
  }
  dismiss(id: string) {
    return (
      this.db
        .query(
          "UPDATE drafts SET status='dismissed' WHERE id=? AND status IN ('pending','uncertain')",
        )
        .run(id).changes === 1
    );
  }
}
