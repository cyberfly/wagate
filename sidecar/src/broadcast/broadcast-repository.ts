import type { Database } from "bun:sqlite";
import type { Broadcast, BroadcastRecipient } from "../messaging/types";
const summary = `SELECT b.id,b.name,b.status,b.min_delay AS minDelay,b.max_delay AS maxDelay,b.error,b.created_at AS createdAt,b.updated_at AS updatedAt,
 COUNT(*) AS total,SUM(r.status='sent') AS sent,SUM(r.status IN ('pending','sending')) AS pending,
 SUM(r.status='uncertain') AS uncertain,SUM(r.status='cancelled') AS cancelled
 FROM broadcasts b JOIN broadcast_recipients r ON r.broadcast_id=b.id`;
const recipientColumns =
  "position,chat_id AS chatId,label,text,status,message_id AS messageId,error,sent_at AS sentAt";
export interface NewRecipient {
  chatId: string;
  label: string;
  text: string;
}
export class BroadcastRepository {
  constructor(private db: Database) {
    // After a crash or quit: an in-flight send may have reached WhatsApp, and
    // nothing resumes sending until the user says so.
    db.transaction(() => {
      db.query(
        "UPDATE broadcast_recipients SET status='uncertain',error='Wagate stopped while sending' WHERE status='sending'",
      ).run();
      db.query(
        "UPDATE broadcasts SET status='paused',error='Wagate restarted. Resume to continue.',updated_at=? WHERE status='running'",
      ).run(Date.now());
    })();
  }
  create(
    name: string,
    minDelay: number,
    maxDelay: number,
    recipients: NewRecipient[],
  ) {
    const id = crypto.randomUUID(),
      now = Date.now();
    this.db.transaction(() => {
      this.db
        .query(
          "INSERT INTO broadcasts(id,name,status,min_delay,max_delay,created_at,updated_at) VALUES(?,?,'running',?,?,?,?)",
        )
        .run(id, name, minDelay, maxDelay, now, now);
      const insert = this.db.query(
        "INSERT INTO broadcast_recipients(broadcast_id,position,chat_id,label,text) VALUES(?,?,?,?,?)",
      );
      recipients.forEach((r, i) => insert.run(id, i + 1, r.chatId, r.label, r.text));
    })();
    return this.get(id)!;
  }
  list(limit = 20) {
    return this.db
      .query(`${summary} GROUP BY b.id ORDER BY b.created_at DESC LIMIT ?`)
      .all(limit) as Broadcast[];
  }
  get(id: string) {
    return this.db
      .query(`${summary} WHERE b.id=? GROUP BY b.id`)
      .get(id) as Broadcast | null;
  }
  recipients(id: string) {
    return this.db
      .query(
        `SELECT ${recipientColumns} FROM broadcast_recipients WHERE broadcast_id=? ORDER BY position`,
      )
      .all(id) as BroadcastRecipient[];
  }
  /** The broadcast currently allowed to send. At most one runs at a time. */
  running() {
    return this.db
      .query(`${summary} WHERE b.status='running' GROUP BY b.id ORDER BY b.created_at LIMIT 1`)
      .get() as Broadcast | null;
  }
  private transition(id: string, from: string, to: string, error: string | null = null) {
    return (
      this.db
        .query(
          `UPDATE broadcasts SET status=?,error=?,updated_at=? WHERE id=? AND status IN (${from})`,
        )
        .run(to, error, Date.now(), id).changes === 1
    );
  }
  pause(id: string, error: string | null = null) {
    return this.transition(id, "'running'", "paused", error);
  }
  resume(id: string) {
    return this.transition(id, "'paused'", "running");
  }
  complete(id: string) {
    return this.transition(id, "'running'", "completed");
  }
  cancel(id: string) {
    return this.db.transaction(() => {
      if (!this.transition(id, "'running','paused'", "cancelled")) return false;
      this.db
        .query(
          "UPDATE broadcast_recipients SET status='cancelled' WHERE broadcast_id=? AND status='pending'",
        )
        .run(id);
      return true;
    })();
  }
  remove(id: string) {
    // Bun counts the cascaded recipient rows in `changes` too.
    return (
      this.db
        .query(
          "DELETE FROM broadcasts WHERE id=? AND status IN ('completed','cancelled')",
        )
        .run(id).changes > 0
    );
  }
  /** Marks the next pending recipient as sending and returns it. */
  claim(id: string) {
    return this.db.transaction(() => {
      const next = this.db
        .query(
          `SELECT ${recipientColumns} FROM broadcast_recipients WHERE broadcast_id=? AND status='pending' ORDER BY position LIMIT 1`,
        )
        .get(id) as BroadcastRecipient | null;
      if (next)
        this.db
          .query(
            "UPDATE broadcast_recipients SET status='sending' WHERE broadcast_id=? AND position=?",
          )
          .run(id, next.position);
      return next;
    })();
  }
  finish(
    id: string,
    position: number,
    outcome: { messageId: string } | { error: string },
  ) {
    const sent = "messageId" in outcome;
    this.db
      .query(
        "UPDATE broadcast_recipients SET status=?,message_id=?,error=?,sent_at=? WHERE broadcast_id=? AND position=?",
      )
      .run(
        sent ? "sent" : "uncertain",
        sent ? outcome.messageId : null,
        sent ? null : outcome.error,
        sent ? Date.now() : null,
        id,
        position,
      );
    this.db
      .query("UPDATE broadcasts SET updated_at=? WHERE id=?")
      .run(Date.now(), id);
  }
}
