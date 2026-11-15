import type { Database } from "bun:sqlite";
import type { MessagingProvider } from "../messaging/messaging-provider";
import type { EventBus } from "../events/event-bus";
/** A stored picture is looked up again after this long. */
const fresh = 7 * 24 * 3600_000;
/** After a failed lookup, the same chat waits this long. */
const retryAfter = 10 * 60_000;
/**
 * Profile pictures of chats, fetched from WhatsApp only for chats the app
 * actually shows, one at a time with a pause between, and kept in SQLite so
 * they appear at once on the next launch.
 */
export class AvatarService {
  private queue: string[] = [];
  private queued = new Set<string>();
  private failed = new Map<string, number>();
  private timer?: ReturnType<typeof setTimeout>;
  private working = false;
  private closed = false;
  constructor(
    private db: Database,
    private provider: MessagingProvider,
    private events: EventBus,
    /** Milliseconds between lookups; tests pass zero. */
    private gap = 1200,
  ) {}
  /** The stored picture, if any. A missing or old one is looked up in the background. */
  get(chatId: string): Uint8Array | null {
    const row = this.db
      .query("SELECT data,checked_at AS checkedAt FROM avatars WHERE id=?")
      .get(chatId) as { data: Uint8Array | null; checkedAt: number } | null;
    if (!row || Date.now() - row.checkedAt > fresh) this.request(chatId);
    return row?.data ? new Uint8Array(row.data) : null;
  }
  private request(chatId: string) {
    if (this.closed || this.queued.has(chatId)) return;
    if (Date.now() - (this.failed.get(chatId) ?? 0) < retryAfter) return;
    if (this.provider.getConnectionState().status !== "connected") return;
    this.queued.add(chatId);
    this.queue.push(chatId);
    this.schedule(0);
  }
  private schedule(wait: number) {
    if (this.closed || this.working || this.timer || !this.queue.length) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.next();
    }, wait);
  }
  private async next() {
    const chatId = this.queue.shift();
    if (!chatId) return;
    this.working = true;
    try {
      const data = await this.provider.profilePicture(chatId);
      if (!this.closed) this.store(chatId, data);
    } catch {
      this.failed.set(chatId, Date.now());
    } finally {
      this.queued.delete(chatId);
      this.working = false;
      this.schedule(this.gap);
    }
  }
  private store(chatId: string, data: Uint8Array | null) {
    const now = Date.now();
    const before = this.db.query("SELECT data FROM avatars WHERE id=?").get(chatId) as {
      data: Uint8Array | null;
    } | null;
    const old = before?.data ? Buffer.from(before.data) : null;
    const same = !!before && (old && data ? old.equals(Buffer.from(data)) : !old && !data);
    if (same)
      this.db.query("UPDATE avatars SET checked_at=? WHERE id=?").run(now, chatId);
    else {
      this.db
        .query("INSERT OR REPLACE INTO avatars(id,data,checked_at,changed_at) VALUES(?,?,?,?)")
        .run(chatId, data, now, now);
      // The chat list learns that the picture changed, or that there is one now.
      if (before || data) this.events.publish("chat.updated", { id: chatId });
    }
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.queue = [];
  }
}
