import type { Database } from "bun:sqlite";
import type {
  Broadcast,
  BroadcastEvent,
  BroadcastRecipient,
} from "../messaging/types";
const summary = `SELECT b.id,b.name,b.status,b.min_delay AS minDelay,b.max_delay AS maxDelay,b.error,b.created_at AS createdAt,b.updated_at AS updatedAt,
 COUNT(*) AS total,SUM(r.status IN ('sent','delivered','read')) AS sent,SUM(r.status IN ('delivered','read')) AS delivered,
 SUM(r.status='failed') AS failed,SUM(r.status IN ('pending','sending')) AS pending,
 SUM(r.status='uncertain') AS uncertain,SUM(r.status='cancelled') AS cancelled
 FROM broadcasts b JOIN broadcast_recipients r ON r.broadcast_id=b.id`;
const recipientColumns =
  "position,chat_id AS chatId,label,text,status,message_id AS messageId,error,attempted_at AS attemptedAt,sent_at AS sentAt";
export interface NewRecipient {
  chatId: string;
  label: string;
  text: string;
}
/**
 * Every state change writes its log event in the same transaction, so the
 * send log always matches what actually happened.
 */
export class BroadcastRepository {
  constructor(private db: Database) {
    // After a crash or quit: an in-flight send may have reached WhatsApp, and
    // nothing resumes sending until the user says so.
    db.transaction(() => {
      const now = Date.now();
      const inflight = db
        .query(
          "SELECT broadcast_id AS id,position FROM broadcast_recipients WHERE status='sending'",
        )
        .all() as { id: string; position: number }[];
      for (const r of inflight)
        this.finish(r.id, r.position, { error: "Wagate stopped while sending" });
      const running = db
        .query("SELECT id FROM broadcasts WHERE status='running'")
        .all() as { id: string }[];
      for (const b of running)
        this.pause(b.id, "Wagate restarted. Resume to continue.", now);
    })();
  }
  private record(
    id: string,
    type: BroadcastEvent["type"],
    detail: string | null = null,
    position: number | null = null,
    at = Date.now(),
  ) {
    this.db
      .query(
        "INSERT INTO broadcast_events(broadcast_id,at,type,position,detail) VALUES(?,?,?,?,?)",
      )
      .run(id, at, type, position, detail);
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
      recipients.forEach((r, i) =>
        insert.run(id, i + 1, r.chatId, r.label, r.text),
      );
      this.record(id, "created", plural(recipients.length, "recipient"), null, now);
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
  /** Oldest first. */
  events(id: string) {
    return this.db
      .query(
        `SELECT e.id,e.at,e.type,e.position,e.detail,r.label,r.chat_id AS chatId FROM broadcast_events e
         LEFT JOIN broadcast_recipients r ON r.broadcast_id=e.broadcast_id AND r.position=e.position
         WHERE e.broadcast_id=? ORDER BY e.id`,
      )
      .all(id) as BroadcastEvent[];
  }
  /** The broadcast currently allowed to send. At most one runs at a time. */
  running() {
    return this.db
      .query(
        `${summary} WHERE b.status='running' GROUP BY b.id ORDER BY b.created_at LIMIT 1`,
      )
      .get() as Broadcast | null;
  }
  private transition(
    id: string,
    from: string,
    to: Broadcast["status"],
    error: string | null,
    at: number,
  ) {
    return (
      this.db
        .query(
          `UPDATE broadcasts SET status=?,error=?,updated_at=? WHERE id=? AND status IN (${from})`,
        )
        .run(to, error, at, id).changes === 1
    );
  }
  /** `reason` is null when the user paused it. */
  pause(id: string, reason: string | null = null, at = Date.now()) {
    return this.db.transaction(() => {
      if (!this.transition(id, "'running'", "paused", reason, at)) return false;
      this.record(id, "paused", reason, null, at);
      return true;
    })();
  }
  resume(id: string) {
    return this.db.transaction(() => {
      const at = Date.now();
      if (!this.transition(id, "'paused'", "running", null, at)) return false;
      this.record(id, "resumed", null, null, at);
      return true;
    })();
  }
  complete(id: string) {
    return this.db.transaction(() => {
      const at = Date.now();
      if (!this.transition(id, "'running'", "completed", null, at)) return false;
      const b = this.get(id)!;
      this.record(
        id,
        "completed",
        `${b.sent} sent` +
          (b.failed ? `, ${b.failed} failed` : "") +
          (b.uncertain ? `, ${b.uncertain} uncertain` : ""),
        null,
        at,
      );
      return true;
    })();
  }
  cancel(id: string) {
    return this.db.transaction(() => {
      const at = Date.now();
      if (!this.transition(id, "'running','paused'", "cancelled", null, at))
        return false;
      const skipped = this.db
        .query(
          "UPDATE broadcast_recipients SET status='cancelled' WHERE broadcast_id=? AND status='pending'",
        )
        .run(id).changes;
      this.record(id, "cancelled", `${skipped} not sent`, null, at);
      return true;
    })();
  }
  remove(id: string) {
    // Bun counts the cascaded recipient and event rows in `changes` too.
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
      if (!next) return null;
      const at = Date.now();
      this.db
        .query(
          "UPDATE broadcast_recipients SET status='sending',attempted_at=? WHERE broadcast_id=? AND position=?",
        )
        .run(at, id, next.position);
      this.db
        .query("UPDATE broadcasts SET updated_at=? WHERE id=?")
        .run(at, id);
      return { ...next, status: "sending" as const, attemptedAt: at };
    })();
  }
  finish(
    id: string,
    position: number,
    outcome: { messageId: string } | { error: string },
  ) {
    this.db.transaction(() => {
      const at = Date.now(),
        sent = "messageId" in outcome;
      this.db
        .query(
          "UPDATE broadcast_recipients SET status=?,message_id=?,error=?,sent_at=? WHERE broadcast_id=? AND position=?",
        )
        .run(
          sent ? "sent" : "uncertain",
          sent ? outcome.messageId : null,
          sent ? null : outcome.error,
          sent ? at : null,
          id,
          position,
        );
      this.db
        .query("UPDATE broadcasts SET updated_at=? WHERE id=?")
        .run(at, id);
      this.record(
        id,
        sent ? "sent" : "uncertain",
        sent ? null : outcome.error,
        position,
        at,
      );
    })();
  }
  /**
   * Applies WhatsApp's later word on a sent message and returns the recipient
   * it belonged to, or null when it was no broadcast's. Statuses only move
   * forward; a delivery receipt overrules an earlier rejection.
   */
  receipt(
    providerMessageId: string,
    status: "failed" | "delivered" | "read",
    error: string | null = null,
  ) {
    const from = {
      failed: "'sent'",
      delivered: "'sent','failed'",
      read: "'sent','delivered','failed'",
    }[status];
    // Stored message ids are `whatsapp:<chat id>:<provider id>`, and a
    // receipt may name the recipient's LID rather than the chat we sent to.
    const suffix = ":" + providerMessageId;
    return this.db.transaction(() => {
      const hit = this.db
        .query(
          `SELECT broadcast_id AS broadcastId,position,label FROM broadcast_recipients
           WHERE status IN (${from}) AND substr(message_id,-length(?))=? LIMIT 1`,
        )
        .get(suffix, suffix) as {
        broadcastId: string;
        position: number;
        label: string;
      } | null;
      if (!hit) return null;
      const at = Date.now();
      this.db
        .query(
          "UPDATE broadcast_recipients SET status=?,error=? WHERE broadcast_id=? AND position=?",
        )
        .run(status, error, hit.broadcastId, hit.position);
      this.db
        .query("UPDATE broadcasts SET updated_at=? WHERE id=?")
        .run(at, hit.broadcastId);
      // Deliveries and reads would drown the timeline; the table shows them.
      if (status === "failed")
        this.record(hit.broadcastId, "failed", error, hit.position, at);
      return hit;
    })();
  }
}
function plural(n: number, word: string) {
  return `${n.toLocaleString("en")} ${word}${n === 1 ? "" : "s"}`;
}
