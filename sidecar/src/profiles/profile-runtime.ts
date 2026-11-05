import type { Database } from "bun:sqlite";
import type { AIProvider } from "../ai/ai-provider";
import { CopilotService } from "../ai/copilot-service";
import { DraftRepository } from "../ai/draft-repository";
import { AutomationRepository } from "../automation/automation-repository";
import { AutomationService } from "../automation/automation-service";
import { BroadcastRepository } from "../broadcast/broadcast-repository";
import { BroadcastService } from "../broadcast/broadcast-service";
import { ChatRepository } from "../chats/chat-repository";
import { Settings } from "../config/settings";
import { ContactRepository } from "../contacts/contact-repository";
import { EventBus } from "../events/event-bus";
import { GroupImportService } from "../groups/group-import-service";
import { MessageRepository } from "../messages/message-repository";
import { MessageService } from "../messages/message-service";
import type {
  MessagingProvider,
  ProviderEvents,
} from "../messaging/messaging-provider";
import type { Broadcast, GroupImport } from "../messaging/types";
export type Logger = (
  level: "info" | "error",
  event: string,
  details?: Record<string, string | number>,
) => void;
export interface RuntimeOptions {
  id: string;
  /** This profile's own database: chats, messages, session, broadcasts. */
  db: Database;
  ai: AIProvider;
  /** App-wide settings: the AI model and prompt, and whether a key is saved. */
  aiSettings: Settings;
  provider: (events: ProviderEvents) => MessagingProvider;
  log: Logger;
  /** Milliseconds between sends; tests pass zero. */
  pace?: {
    broadcast?: (b: Broadcast) => number;
    groupImport?: (job: GroupImport) => number;
  };
  /** Wait before fetching account state that predates Wagate. */
  resyncDelay?: number;
}
// Account state synced before Wagate stored it (saved contact names; pins and
// archives, which order the inbox) needs one fresh copy from WhatsApp. Fetch
// what is missing once, after the connection settles; a failure leaves the
// flags unset so the next connection tries again.
const accountState = [
  { flag: "contacts.resynced", collection: "critical_unblock_low" },
  { flag: "chats.resynced", collection: "regular_low" },
] as const;
/**
 * One WhatsApp number with everything that belongs to it: a connection, its
 * chats and messages, Copilot drafts, broadcasts, group imports and group
 * automations. Profiles share nothing at this level; the API keys, AI
 * settings and tunnel above them are app-wide.
 */
export class ProfileRuntime {
  readonly id: string;
  readonly db: Database;
  readonly events = new EventBus();
  readonly chats: ChatRepository;
  readonly messages: MessageRepository;
  /** This profile's own settings, such as whether to reconnect on launch. */
  readonly settings: Settings;
  readonly drafts: DraftRepository;
  readonly contacts: ContactRepository;
  readonly provider: MessagingProvider;
  readonly sender: MessageService;
  readonly copilot: CopilotService;
  readonly broadcasts: BroadcastService;
  readonly groupImports: GroupImportService;
  readonly automations: AutomationService;
  /** The latest errors, newest last, for the desktop app to show. */
  readonly alerts: { id: number; error: string }[] = [];
  private accountResync?: ReturnType<typeof setTimeout>;
  private closed = false;
  private log: Logger;
  constructor(private o: RuntimeOptions) {
    this.id = o.id;
    this.db = o.db;
    this.log = (level, event, details = {}) =>
      o.log(level, event, { profile: o.id, ...details });
    const db = o.db;
    this.chats = new ChatRepository(db);
    this.messages = new MessageRepository(db, this.chats);
    this.settings = new Settings(db);
    this.drafts = new DraftRepository(db);
    this.contacts = new ContactRepository(db);
    this.provider = o.provider({
      connection: (state) => {
        this.events.publish("messaging.connection", state);
        this.log("info", "whatsapp.state", { state: state.status });
        if (state.status === "connected") this.resyncAccountStateOnce();
      },
      message: (message, live) => this.sender.receive(message, live),
      receipt: (receipt) => {
        if (receipt.status === "failed")
          this.log("error", "whatsapp.message.rejected", {
            code: receipt.error ?? "none",
          });
        this.sender.receipt(receipt);
        this.broadcasts.receipt(receipt);
        this.automations.receipt(receipt);
      },
      reaction: (reaction) => this.sender.reaction(reaction),
      change: (change) => this.sender.change(change),
      chat: (chat) => {
        if (this.chats.apply(chat))
          this.events.publish("chat.updated", { id: chat.id });
      },
      contacts: (names) => this.contacts.save(names),
      phones: (links) => this.contacts.linkPhones(links),
      error: () => {
        this.log("error", "whatsapp.operation.failed");
        this.events.publish("messaging.error", {
          error:
            "WhatsApp operation failed. Check local storage and reconnect.",
        });
      },
    });
    this.sender = new MessageService(this.provider, this.messages, this.events);
    this.copilot = new CopilotService(
      o.ai,
      this.chats,
      this.messages,
      this.sender,
      this.drafts,
      o.aiSettings,
      this.events,
    );
    this.broadcasts = new BroadcastService(
      new BroadcastRepository(db),
      this.sender,
      this.provider,
      this.events,
      o.pace?.broadcast,
    );
    this.groupImports = new GroupImportService(
      this.provider,
      this.events,
      o.pace?.groupImport,
    );
    this.automations = new AutomationService(
      new AutomationRepository(db),
      o.ai,
      this.provider,
      this.sender,
      this.chats,
      o.aiSettings,
      this.events,
    );
    this.events.subscribe((event) => {
      if (event.type.endsWith(".error")) {
        this.alerts.push({
          id: event.id,
          error: (event.data as { error: string }).error,
        });
        if (this.alerts.length > 5) this.alerts.shift();
      }
    });
  }
  /** Starts the scheduler, and reconnects WhatsApp if it was left connected. */
  start() {
    this.automations.start();
    if (this.settings.get("whatsapp.autoConnect") === "true")
      void this.provider.connect();
  }
  databaseHealthy() {
    try {
      this.db.query("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }
  private resyncAccountStateOnce() {
    const missing = accountState.filter(
      (s) => this.settings.get(s.flag) !== "true",
    );
    if (this.accountResync || this.closed || !missing.length) return;
    this.accountResync = setTimeout(() => {
      // Only the Baileys provider can fetch account state.
      const provider = this.provider as MessagingProvider & {
        resyncAccountState?: (c: string[]) => Promise<void>;
      };
      if (!provider.resyncAccountState) return;
      provider
        .resyncAccountState(missing.map((s) => s.collection))
        .then(() => {
          if (this.closed) return;
          for (const s of missing) this.settings.set(s.flag, "true");
          this.log("info", "whatsapp.account_state.resynced", {
            collections: missing.map((s) => s.collection).join(","),
          });
        })
        .catch(() => this.log("error", "whatsapp.account_state.resync_failed"))
        .finally(() => (this.accountResync = undefined));
    }, this.o.resyncDelay ?? 10000);
  }
  /** Stops every job and the WhatsApp connection; the database stays open. */
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.accountResync);
    this.copilot.close();
    this.broadcasts.close();
    this.groupImports.close();
    this.automations.close();
    await this.provider.disconnect();
  }
}
