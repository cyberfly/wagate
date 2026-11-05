import { openDatabase } from "../src/db/database";
import { EventBus } from "../src/events/event-bus";
import { Settings } from "../src/config/settings";
import { ApiKeys } from "../src/security/api-keys";
import { Vault } from "../src/security/vault";
import { createApi } from "../src/api/server";
import { ProfileManager } from "../src/profiles/profile-manager";
import { ProfileRuntime } from "../src/profiles/profile-runtime";
import { TunnelService } from "../src/tunnel/tunnel-service";
import { AutomationRepository } from "../src/automation/automation-repository";
import type { AIProvider, AIRequest } from "../src/ai/ai-provider";
import type {
  MessagingProvider,
  SendOptions,
  StoredMessage,
} from "../src/messaging/messaging-provider";
import type {
  Message,
  ConnectionState,
  GroupInfo,
  GroupAddResult,
  OutgoingMedia,
  ReceivedMessage,
} from "../src/messaging/types";
export const chatId = "60123456789@s.whatsapp.net";
export function incoming(
  id = "one",
  text = "Are you available tomorrow?",
): Message {
  return {
    id,
    provider: "whatsapp",
    providerMessageId: id,
    chatId,
    senderId: chatId,
    direction: "incoming",
    type: "text",
    text,
    timestamp: Date.now(),
  };
}
export class FakeProvider implements MessagingProvider {
  state: ConnectionState = { status: "connected" };
  sent: Message[] = [];
  groups: GroupInfo[] = [
    {
      id: "120363000000000001@g.us",
      name: "AI community",
      memberCount: 20,
      isAdmin: true,
    },
  ];
  async listGroups() {
    if (this.state.status !== "connected")
      throw new Error("WhatsApp is disconnected");
    return this.groups.map((g) => ({ ...g }));
  }
  async getGroup(id: string) {
    const group = (await this.listGroups()).find((g) => g.id === id);
    if (!group) throw new Error("Automation group is unavailable");
    return group;
  }
  historyRequests: { before: Pick<Message, "chatId" | "providerMessageId">; count: number }[] = [];
  async requestHistory(before: Message, count: number) {
    if (this.state.status !== "connected")
      throw new Error("WhatsApp is disconnected");
    this.historyRequests.push({ before, count });
  }
  /** Per-number outcomes to return instead of "added". */
  addOutcomes = new Map<string, GroupAddResult["status"]>();
  addCalls: { groupId: string; phones: string[] }[] = [];
  addError: Error | null = null;
  async addGroupParticipants(groupId: string, phones: string[]) {
    this.addCalls.push({ groupId, phones });
    if (this.addError) throw this.addError;
    return phones.map((phone) => ({
      phone,
      status: this.addOutcomes.get(phone) ?? ("added" as const),
    }));
  }
  async connect() {
    this.state = { status: "connected" };
  }
  async disconnect() {
    this.state = { status: "disconnected" };
  }
  async logout() {
    await this.disconnect();
  }
  getConnectionState() {
    return this.state;
  }
  /** The message each send replied to, in send order. */
  quotes: (StoredMessage | undefined)[] = [];
  async sendText(chatId: string, text: string, options?: SendOptions) {
    const id = crypto.randomUUID().replace(/-/g, "").toUpperCase();
    // Ids take the Baileys provider's shape, so receipts can find them.
    const m: ReceivedMessage = {
      ...incoming(`whatsapp:${chatId}:${id}`),
      providerMessageId: id,
      chatId,
      text,
      direction: "outgoing",
      status: "sent",
      ...(options?.quoted
        ? {
            quoted: {
              providerMessageId: options.quoted.providerMessageId,
              senderId: options.quoted.senderId,
              fromMe: options.quoted.direction === "outgoing",
              type: options.quoted.type,
              text: options.quoted.text,
            },
          }
        : {}),
    };
    this.sent.push(m);
    this.quotes.push(options?.quoted);
    return m;
  }
  media: OutgoingMedia[] = [];
  async sendMedia(chatId: string, media: OutgoingMedia, options?: SendOptions) {
    this.media.push(media);
    const m = await this.sendText(chatId, media.caption ?? "", options);
    m.type = media.mimetype.startsWith("image/") ? "image" : "document";
    m.text = media.caption ?? media.fileName;
    m.media = { mimetype: media.mimetype, size: media.data.length };
    m.mediaSource = new Uint8Array([1]);
    return m;
  }
  reactions: { target: StoredMessage; emoji: string }[] = [];
  async react(target: StoredMessage, emoji: string) {
    if (this.state.status !== "connected") throw new Error("WhatsApp is disconnected");
    this.reactions.push({ target, emoji });
  }
  /** Bytes each attachment downloads as; a missing entry fails the download. */
  downloads = new Map<string, Uint8Array>();
  downloadCalls = 0;
  async downloadMedia(target: StoredMessage) {
    this.downloadCalls++;
    const data = this.downloads.get(target.providerMessageId);
    if (!data) throw new Error("download failed");
    return data;
  }
  read: StoredMessage[][] = [];
  async markRead(targets: StoredMessage[]) {
    if (this.state.status !== "connected") throw new Error("WhatsApp is disconnected");
    this.read.push(targets);
  }
  edits: { target: StoredMessage; text: string }[] = [];
  async edit(target: StoredMessage, text: string) {
    if (this.state.status !== "connected") throw new Error("WhatsApp is disconnected");
    this.edits.push({ target, text });
  }
  revoked: StoredMessage[] = [];
  async revoke(target: StoredMessage) {
    if (this.state.status !== "connected") throw new Error("WhatsApp is disconnected");
    this.revoked.push(target);
  }
  forwarded: { target: StoredMessage; chatId: string }[] = [];
  async forward(target: StoredMessage, chatId: string) {
    this.forwarded.push({ target, chatId });
    const m = await this.sendText(chatId, target.text ?? "");
    m.type = target.type;
    m.forwarded = true;
    return m;
  }
  thumbnails = new Map<string, Uint8Array>();
  thumbnail(target: StoredMessage) {
    return this.thumbnails.get(target.providerMessageId) ?? null;
  }
}
export function setup(ai?: AIProvider) {
  const db = openDatabase(":memory:");
  const settings = new Settings(db),
    keys = new ApiKeys(db),
    vault = new Vault(db, Buffer.alloc(32, 1));
  const requests: AIRequest[] = [];
  const fakeAi: AIProvider = ai || {
    generate: async (request) => {
      requests.push(request);
      return "Yes, tomorrow works.";
    },
  };
  /** Each profile's fake connection, by profile id. */
  const providers = new Map<string, FakeProvider>();
  /** Profiles removed so far; their databases are in-memory and just closed. */
  const destroyed: string[] = [];
  const profiles = new ProfileManager(db, {
    open: () => openDatabase(":memory:"),
    destroy: (id) => destroyed.push(id),
    removed: (id) => keys.forgetProfile(id),
    log: () => {},
    logoutTimeout: 50,
    runtime: (id, profileDb) =>
      new ProfileRuntime({
        id,
        db: profileDb,
        ai: fakeAi,
        aiSettings: settings,
        log: () => {},
        provider: () => {
          const provider = new FakeProvider();
          providers.set(id, provider);
          return provider;
        },
        // No pacing in tests: the next send is scheduled on the next timer tick.
        pace: { broadcast: () => 0, groupImport: () => 0 },
      }),
  });
  profiles.load();
  const main = profiles.main();
  const {
    events,
    chats,
    messages,
    drafts,
    sender,
    copilot,
    broadcasts,
    automations,
    groupImports,
    contacts,
  } = main;
  const provider = main.provider as FakeProvider;
  const automationRepository = new AutomationRepository(db);
  const services = {
    profiles,
    keys,
    settings,
    vault: async () => vault,
    port: 8787,
    databaseHealthy: () => true,
    log: () => {},
  };
  const publicApp = createApi({
    ...services,
    desktopToken: "",
    publicMode: true,
  });
  const tunnel = new TunnelService({
    dataDir: "/nonexistent",
    events: new EventBus(),
    log: () => {},
    fetch: publicApp.fetch,
  });
  const app = createApi({
    ...services,
    desktopToken: "test-desktop-token",
    tunnel,
  });
  const call = (
    path: string,
    method = "GET",
    data?: unknown,
    key = "test-desktop-token",
    headers: Record<string, string> = {},
  ) =>
    app.request(path, {
      method,
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        ...headers,
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
  return {
    db,
    events,
    chats,
    messages,
    settings,
    keys,
    drafts,
    provider,
    vault,
    sender,
    copilot,
    broadcasts,
    automations,
    groupImports,
    automationRepository,
    contacts,
    requests,
    profiles,
    providers,
    destroyed,
    app,
    publicApp,
    tunnel,
    call,
    close: () => {
      tunnel.close();
      void profiles.close();
      db.close();
    },
  };
}
