import type { Database } from "bun:sqlite";
import type {
  AutomationPost,
  GroupAutomation,
  GroupAutomationInput,
} from "./types";
import { nextRun } from "./schedule";

const configColumns = `chat_id AS chatId,group_name AS groupName,topics,instructions,source,delivery,time_zone AS timeZone,schedule,enabled,next_run_at AS nextRunAt,updated_at AS updatedAt,revision`;
const postColumns = `id,chat_id AS chatId,group_name AS groupName,status,text,error,scheduled_for AS scheduledFor,created_at AS createdAt,sent_at AS sentAt,message_id AS messageId,provider_message_id AS providerMessageId`;
type ConfigRow = Omit<GroupAutomation, "schedule" | "enabled"> & {
  schedule: string;
  enabled: number;
};
const config = (r: ConfigRow | null): GroupAutomation | null =>
  r && { ...r, schedule: JSON.parse(r.schedule), enabled: !!r.enabled };

export class AutomationRepository {
  constructor(private db: Database) {}
  get(chatId: string) {
    return config(
      this.db
        .query(`SELECT ${configColumns} FROM group_automations WHERE chat_id=?`)
        .get(chatId) as ConfigRow | null,
    );
  }
  list() {
    return (
      this.db
        .query(
          `SELECT ${configColumns} FROM group_automations ORDER BY group_name,chat_id`,
        )
        .all() as ConfigRow[]
    ).map((r) => config(r)!);
  }
  save(
    chatId: string,
    groupName: string,
    input: GroupAutomationInput,
    now: number,
  ) {
    const old = this.get(chatId);
    const unchangedSchedule =
      old?.enabled &&
      input.enabled &&
      old.timeZone === input.timeZone &&
      JSON.stringify(old.schedule) === JSON.stringify(input.schedule);
    const next = input.enabled
      ? unchangedSchedule
        ? old!.nextRunAt
        : nextRun(input, now)
      : null;
    this.db
      .query(
        `INSERT INTO group_automations(chat_id,group_name,topics,instructions,source,delivery,time_zone,schedule,enabled,next_run_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET group_name=excluded.group_name,topics=excluded.topics,instructions=excluded.instructions,
      source=excluded.source,delivery=excluded.delivery,time_zone=excluded.time_zone,schedule=excluded.schedule,enabled=excluded.enabled,
      next_run_at=excluded.next_run_at,updated_at=excluded.updated_at,revision=group_automations.revision+1`,
      )
      .run(
        chatId,
        groupName,
        input.topics,
        input.instructions,
        input.source,
        input.delivery,
        input.timeZone,
        JSON.stringify(input.schedule),
        input.enabled ? 1 : 0,
        next,
        now,
      );
    return this.get(chatId)!;
  }
  pause(chatId: string, now: number) {
    this.db
      .query(
        "UPDATE group_automations SET enabled=0,next_run_at=NULL,updated_at=?,revision=revision+1 WHERE chat_id=?",
      )
      .run(now, chatId);
    return this.get(chatId);
  }
  due(now: number) {
    return this.list().filter(
      (c) => c.enabled && c.nextRunAt !== null && c.nextRunAt <= now,
    );
  }
  posts(chatId?: string) {
    return (
      chatId
        ? this.db
            .query(
              `SELECT ${postColumns} FROM automation_posts WHERE chat_id=? ORDER BY status IN ('pending','generating','sending') DESC,created_at DESC,id DESC LIMIT 100`,
            )
            .all(chatId)
        : this.db
            .query(
              `SELECT ${postColumns} FROM automation_posts ORDER BY status IN ('pending','generating','sending') DESC,created_at DESC,id DESC LIMIT 100`,
            )
            .all()
    ) as AutomationPost[];
  }
  post(id: string) {
    return this.db
      .query(`SELECT ${postColumns} FROM automation_posts WHERE id=?`)
      .get(id) as AutomationPost | null;
  }
  forReceipt(id: string) {
    return this.db
      .query(
        `SELECT ${postColumns} FROM automation_posts WHERE provider_message_id=?`,
      )
      .get(id) as AutomationPost | null;
  }
  hasPending(chatId: string) {
    return !!this.db
      .query(
        "SELECT 1 FROM automation_posts WHERE chat_id=? AND status IN ('pending','generating','sending') LIMIT 1",
      )
      .get(chatId);
  }
  /** Claim and advance a schedule in the same transaction as its unique run. */
  begin(c: GroupAutomation, now: number, scheduled: boolean) {
    return this.db.transaction(() => {
      if (scheduled) {
        const changes = this.db
          .query(
            "UPDATE group_automations SET next_run_at=? WHERE chat_id=? AND enabled=1 AND revision=? AND next_run_at=?",
          )
          .run(nextRun(c, now), c.chatId, c.revision, c.nextRunAt).changes;
        if (!changes)
          throw new Error("Automation schedule changed before this run");
      }
      const id = crypto.randomUUID();
      this.db
        .query(
          "INSERT INTO automation_posts(id,chat_id,group_name,status,scheduled_for,created_at) VALUES(?,?,?,'generating',?,?)",
        )
        .run(id, c.chatId, c.groupName, scheduled ? c.nextRunAt : null, now);
      return this.post(id)!;
    })();
  }
  finish(
    id: string,
    status: AutomationPost["status"],
    text: string,
    error: string | null = null,
  ) {
    this.db
      .query("UPDATE automation_posts SET status=?,text=?,error=? WHERE id=?")
      .run(status, text, error, id);
    return this.post(id)!;
  }
  claimSend(id: string, text: string) {
    return (
      this.db
        .query(
          "UPDATE automation_posts SET status='sending',text=?,error=NULL WHERE id=? AND status='pending'",
        )
        .run(text, id).changes > 0
    );
  }
  sent(id: string, messageId: string, providerMessageId: string, now: number) {
    this.db
      .query(
        "UPDATE automation_posts SET status='sent',message_id=?,provider_message_id=?,sent_at=? WHERE id=?",
      )
      .run(messageId, providerMessageId, now, id);
    return this.post(id)!;
  }
  dismiss(id: string) {
    return (
      this.db
        .query(
          "UPDATE automation_posts SET status='dismissed' WHERE id=? AND status='pending'",
        )
        .run(id).changes > 0
    );
  }
  recover(now: number) {
    this.db.transaction(() => {
      this.db
        .query(
          "UPDATE group_automations SET enabled=0,next_run_at=NULL,updated_at=?,revision=revision+1 WHERE chat_id IN (SELECT chat_id FROM automation_posts WHERE status='sending')",
        )
        .run(now);
      this.db.exec(
        "UPDATE automation_posts SET status='uncertain',error='Wagate stopped during sending. Check the group before posting again.' WHERE status='sending'",
      );
      this.db.exec(
        "UPDATE automation_posts SET status='failed',error='Wagate stopped during generation. Nothing was sent.' WHERE status='generating'",
      );
    })();
  }
}
