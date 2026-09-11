import type { MessagingProvider } from "../messaging/messaging-provider";
import type { Broadcast } from "../messaging/types";
import { resolveChatId, MessageService } from "../messages/message-service";
import { EventBus } from "../events/event-bus";
import { BroadcastRepository } from "./broadcast-repository";
import { maxRecipients } from "./csv";
export interface BroadcastInput {
  name: string;
  minDelay: number;
  maxDelay: number;
  recipients: { to: string; label?: string; text: string }[];
}
/** A random gap between sends, so a list does not go out at machine speed. */
export function randomPace(b: Pick<Broadcast, "minDelay" | "maxDelay">) {
  return (b.minDelay + Math.random() * (b.maxDelay - b.minDelay)) * 1000;
}
/**
 * Sends one broadcast at a time, one message at a time, through the same
 * MessageService as the UI and REST API.
 *
 * A send that throws may still have reached WhatsApp, so its recipient is
 * marked uncertain, never retried, and the broadcast pauses for the user.
 */
export class BroadcastService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sending = false;
  private closed = false;
  constructor(
    private repository: BroadcastRepository,
    private sender: MessageService,
    private provider: MessagingProvider,
    private events: EventBus,
    /** Milliseconds to wait before the next send. */
    private pace: (b: Broadcast) => number = randomPace,
  ) {}
  list() {
    return this.repository.list();
  }
  get(id: string) {
    const broadcast = this.repository.get(id);
    if (!broadcast) throw new Error("Broadcast not found");
    return { broadcast, recipients: this.repository.recipients(id) };
  }
  create(input: BroadcastInput) {
    const name = input.name.trim();
    if (!name || name.length > 120)
      throw new Error("Broadcast name must contain 1–120 characters");
    const { minDelay, maxDelay } = input;
    if (
      !Number.isInteger(minDelay) ||
      !Number.isInteger(maxDelay) ||
      minDelay < 5 ||
      maxDelay > 600 ||
      minDelay > maxDelay
    )
      throw new Error("Broadcast delay must be 5–600 seconds, minimum first");
    if (!input.recipients.length || input.recipients.length > maxRecipients)
      throw new Error(
        `Broadcast needs 1–${maxRecipients.toLocaleString("en")} recipients`,
      );
    const seen = new Set<string>();
    const recipients = input.recipients.map((r, i) => {
      const row = `Broadcast recipient ${i + 1}`;
      let chatId: string;
      try {
        chatId = resolveChatId(String(r.to));
      } catch {
        throw new Error(`${row} has an invalid phone number`);
      }
      if (seen.has(chatId)) throw new Error(`${row} repeats an earlier number`);
      seen.add(chatId);
      const text = String(r.text).trim();
      if (!text || text.length > 10000)
        throw new Error(`${row} needs a message of 1–10,000 characters`);
      const label = String(r.label ?? "").trim().slice(0, 200);
      return { chatId, text, label: label || chatId.split("@")[0] };
    });
    this.idle();
    const broadcast = this.repository.create(name, minDelay, maxDelay, recipients);
    this.updated(broadcast.id);
    this.schedule(0);
    return broadcast;
  }
  pause(id: string) {
    if (!this.repository.pause(id))
      throw new Error("Broadcast is not sending");
    this.updated(id);
    return this.repository.get(id);
  }
  resume(id: string) {
    if (this.repository.get(id)?.status !== "paused")
      throw new Error("Broadcast is not paused");
    this.idle();
    this.repository.resume(id);
    this.updated(id);
    this.schedule(0);
    return this.repository.get(id);
  }
  cancel(id: string) {
    if (!this.repository.cancel(id))
      throw new Error("Broadcast is already finished");
    this.updated(id);
    return this.repository.get(id);
  }
  remove(id: string) {
    if (!this.repository.remove(id))
      throw new Error("Broadcast must be finished or cancelled before removal");
    this.updated(id);
  }
  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  /** Refuses a second concurrent broadcast and sending while offline. */
  private idle() {
    if (this.repository.running())
      throw new Error(
        "Broadcast already in progress. Pause or cancel it before starting another.",
      );
    if (this.provider.getConnectionState().status !== "connected")
      throw new Error("WhatsApp is disconnected");
  }
  private updated(id: string) {
    this.events.publish("broadcast.updated", { id });
  }
  private halt(id: string, error: string) {
    if (!this.repository.pause(id, error)) return;
    this.events.publish("broadcast.error", { id, error });
    this.updated(id);
  }
  private schedule(ms: number) {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.step();
    }, ms);
  }
  private async step() {
    // A pause and quick resume during a send can leave a second step waiting;
    // the step that owns the send schedules the next one when it finishes.
    if (this.closed || this.sending) return;
    const broadcast = this.repository.running();
    if (!broadcast) return;
    // Finish before checking the connection: a drop after the last send
    // should not leave a fully sent broadcast paused.
    if (
      broadcast.pending &&
      this.provider.getConnectionState().status !== "connected"
    )
      return this.halt(
        broadcast.id,
        "Broadcast paused: WhatsApp disconnected. Reconnect, then resume.",
      );
    const next = broadcast.pending ? this.repository.claim(broadcast.id) : null;
    if (!next) {
      if (this.repository.complete(broadcast.id)) this.updated(broadcast.id);
      return;
    }
    this.sending = true;
    try {
      const message = await this.sender.send(next.chatId, next.text);
      this.repository.finish(broadcast.id, next.position, {
        messageId: message.id,
      });
      this.updated(broadcast.id);
    } catch (error) {
      const reason =
        error instanceof Error && error.message.startsWith("WhatsApp")
          ? error.message
          : "Send failed";
      this.repository.finish(broadcast.id, next.position, {
        error: `${reason}. Delivery is unknown; check this chat on your phone.`,
      });
      this.halt(
        broadcast.id,
        `Broadcast paused: sending to ${next.label} failed. Check that chat on your phone, then resume to continue with the rest.`,
      );
    } finally {
      this.sending = false;
    }
    const current = this.repository.get(broadcast.id);
    if (current?.status === "running")
      this.schedule(current.pending ? this.pace(current) : 0);
  }
}
