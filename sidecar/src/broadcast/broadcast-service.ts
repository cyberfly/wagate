import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MessagingProvider } from "../messaging/messaging-provider";
import type { Broadcast, MessageReceipt } from "../messaging/types";
import { resolveChatId, MessageService } from "../messages/message-service";
import { EventBus } from "../events/event-bus";
import { BroadcastRepository } from "./broadcast-repository";
import { localTime, maxRecipients, sendLogCsv } from "./csv";
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
 * Why WhatsApp refused a message. 463 is what an account gets when WhatsApp
 * stops it from starting new chats, typically after it flags bulk messages;
 * every further attempt counts against it.
 */
function rejection(code?: string) {
  return code === "463"
    ? {
        note: "WhatsApp refused to start this chat (error 463). The account may be restricted from messaging new contacts.",
        advice:
          "WhatsApp is refusing new chats from this account. Sending more can extend the restriction: wait several hours, then resume.",
      }
    : {
        note: `WhatsApp rejected this message${code ? ` (error ${code})` : ""}.`,
        advice: "Check that chat on your phone, then resume to continue with the rest.",
      };
}
function downloads() {
  const dir = join(homedir(), "Downloads");
  return existsSync(dir) ? dir : homedir();
}
/**
 * Sends one broadcast at a time, one message at a time, through the same
 * MessageService as the UI and REST API.
 *
 * A send that throws may still have reached WhatsApp, so its recipient is
 * marked uncertain, never retried, and the broadcast pauses for the user.
 * A send that returns has only been written to the socket: receipts later
 * mark it delivered or read, or failed when WhatsApp rejects it, which also
 * pauses the broadcast.
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
    return {
      broadcast,
      recipients: this.repository.recipients(id),
      events: this.repository.events(id),
    };
  }
  /**
   * Writes the send log as CSV to Downloads and returns its path. The webview
   * cannot save files itself. Never overwrites an existing file.
   */
  export(id: string, dir = downloads()) {
    const { broadcast, recipients } = this.get(id);
    // The BOM makes Excel read names and messages as UTF-8.
    const csv = "\uFEFF" + sendLogCsv(recipients);
    const base =
      broadcast.name.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) ||
      "broadcast";
    const stamp = localTime(Date.now()).replace(" ", "-").replace(/:/g, "").slice(0, 15);
    for (let n = 1; n <= 50; n++) {
      const path = join(dir, `${base}-send-log-${stamp}${n > 1 ? `-${n}` : ""}.csv`);
      try {
        writeFileSync(path, csv, { flag: "wx", mode: 0o600 });
        return { path };
      } catch (error) {
        if ((error as { code?: string }).code !== "EEXIST") break;
      }
    }
    throw new Error(
      "Broadcast log could not be saved. Check that your Downloads folder is writable, or use Copy CSV.",
    );
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
  /** WhatsApp's later word on any message we sent; most are not broadcasts'. */
  receipt({ providerMessageId, status, error }: MessageReceipt) {
    const reason = status === "failed" ? rejection(error) : null;
    const hit = this.repository.receipt(
      providerMessageId,
      status,
      reason?.note ?? null,
    );
    if (!hit) return;
    this.updated(hit.broadcastId);
    // The rejection lands a moment after the send, well inside the gap
    // before the next one, so pausing here stops the rest.
    if (reason)
      this.halt(
        hit.broadcastId,
        `WhatsApp rejected the message to ${hit.label}. ${reason.advice}`,
      );
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
  /** Pauses on the service's own initiative; the alert says why. */
  private halt(id: string, reason: string) {
    if (!this.repository.pause(id, reason)) return;
    this.events.publish("broadcast.error", {
      id,
      error: `Broadcast paused: ${reason}`,
    });
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
        "WhatsApp disconnected. Reconnect, then resume.",
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
        `Sending to ${next.label} failed. Check that chat on your phone, then resume to continue with the rest.`,
      );
    } finally {
      this.sending = false;
    }
    const current = this.repository.get(broadcast.id);
    if (current?.status === "running")
      this.schedule(current.pending ? this.pace(current) : 0);
  }
}
