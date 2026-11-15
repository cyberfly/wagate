import type { Database } from "bun:sqlite";
import type { MessagingProvider } from "../messaging/messaging-provider";
import type { ChatPresence, PresenceUpdate } from "../messaging/types";
import type { EventBus } from "../events/event-bus";
/** WhatsApp repeats "typing" while it lasts; without a repeat it has stopped. */
const typingFor = 25_000;
/** Without a sign that a chat is still being looked at, we stop showing as online. */
const idleAfter = 90_000;
/**
 * Who is online or typing in the chats being looked at, and our own online
 * and typing state. WhatsApp only tells an account about others while that
 * account shows as online itself, so both go together: nothing is sent or
 * received until the app says a chat is open in front of the person.
 */
export class PresenceService {
  private seen = new Map<string, Map<string, { state: PresenceUpdate["state"]; at: number }>>();
  private watched = new Map<string, number>();
  private online = false;
  private idle?: ReturnType<typeof setTimeout>;
  private expiry = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;
  constructor(
    private db: Database,
    private provider: MessagingProvider,
    private events: EventBus,
  ) {}
  private connected() {
    return !this.closed && this.provider.getConnectionState().status === "connected";
  }
  /** Every id the person behind `id` is known by: a phone number and a LID. */
  private aliases(id: string) {
    const row = this.db
      .query("SELECT lid,phone FROM lid_phones WHERE lid=?1 OR phone=?1 LIMIT 1")
      .get(id) as { lid: string; phone: string } | null;
    return row ? [...new Set([id, row.lid, row.phone])] : [id];
  }
  /** A chat is open in front of the person: show as online and follow the chat. */
  async open(chatId: string) {
    if (!this.connected()) return;
    clearTimeout(this.idle);
    this.idle = setTimeout(() => void this.away(), idleAfter);
    try {
      if (!this.online) {
        this.online = true;
        await this.provider.setPresence("available");
      }
      // WhatsApp forgets a subscription after a while; renew it now and then.
      if (Date.now() - (this.watched.get(chatId) ?? 0) > 5 * 60_000) {
        this.watched.set(chatId, Date.now());
        await this.provider.watchPresence(chatId);
      }
    } catch {
      /* presence is a courtesy; the chat works without it */
    }
  }
  /** We started or stopped typing in a chat. Only sent while showing as online. */
  async typing(chatId: string, on: boolean) {
    if (!this.connected() || !this.online) return;
    await this.provider.setPresence(on ? "composing" : "paused", chatId).catch(() => {});
  }
  /** Nobody is looking any more: go offline and forget what was seen. */
  async away() {
    clearTimeout(this.idle);
    this.idle = undefined;
    const known = [...this.seen.keys()];
    this.seen.clear();
    this.watched.clear();
    for (const timer of this.expiry.values()) clearTimeout(timer);
    this.expiry.clear();
    for (const id of known) this.events.publish("chat.presence", { id });
    if (!this.online) return;
    this.online = false;
    if (this.connected()) await this.provider.setPresence("unavailable").catch(() => {});
  }
  /** The connection dropped: WhatsApp no longer counts us as online. */
  reset() {
    this.online = false;
    void this.away();
  }
  apply(update: PresenceUpdate) {
    if (this.closed) return;
    for (const chatId of this.aliases(update.chatId)) {
      const people = this.seen.get(chatId) ?? new Map();
      people.set(update.participant, { state: update.state, at: Date.now() });
      this.seen.set(chatId, people);
      this.events.publish("chat.presence", { id: chatId });
      // Tell the app again once a "typing" has run out.
      if (update.state === "composing" || update.state === "recording") {
        clearTimeout(this.expiry.get(chatId));
        this.expiry.set(
          chatId,
          setTimeout(() => {
            this.expiry.delete(chatId);
            this.events.publish("chat.presence", { id: chatId });
          }, typingFor + 500),
        );
      }
    }
  }
  describe(chatId: string): ChatPresence {
    const people = this.seen.get(chatId);
    const result: ChatPresence = { online: false, typing: [] };
    if (!people) return result;
    const name = this.db.query(
      `SELECT COALESCE(p.name,k.name,k.push_name,p.push_name) AS name FROM (SELECT ? AS id) s
       LEFT JOIN contacts k ON k.id=s.id LEFT JOIN lid_phones l ON l.lid=s.id LEFT JOIN contacts p ON p.id=l.phone`,
    );
    const group = chatId.endsWith("@g.us");
    for (const [id, { state, at }] of people) {
      const active = (state === "composing" || state === "recording") && Date.now() - at < typingFor;
      if (active)
        result.typing.push({
          id,
          name: (name.get(id) as { name: string | null } | null)?.name ?? null,
          state: state as "composing" | "recording",
        });
      if (!group && (active || state === "available" || state === "paused")) result.online = true;
    }
    return result;
  }
  close() {
    this.closed = true;
    clearTimeout(this.idle);
    for (const timer of this.expiry.values()) clearTimeout(timer);
  }
}
