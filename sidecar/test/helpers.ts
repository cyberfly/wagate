import { openDatabase } from "../src/db/database";
import { ChatRepository } from "../src/chats/chat-repository";
import { MessageRepository } from "../src/messages/message-repository";
import { MessageService } from "../src/messages/message-service";
import { EventBus } from "../src/events/event-bus";
import { Settings } from "../src/config/settings";
import { ApiKeys } from "../src/security/api-keys";
import { Vault } from "../src/security/vault";
import { DraftRepository } from "../src/ai/draft-repository";
import { CopilotService } from "../src/ai/copilot-service";
import { createApi } from "../src/api/server";
import { TunnelService } from "../src/tunnel/tunnel-service";
import { BroadcastRepository } from "../src/broadcast/broadcast-repository";
import { BroadcastService } from "../src/broadcast/broadcast-service";
import { ContactRepository } from "../src/contacts/contact-repository";
import type { AIProvider, AIRequest } from "../src/ai/ai-provider";
import type { MessagingProvider } from "../src/messaging/messaging-provider";
import type { Message, ConnectionState } from "../src/messaging/types";
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
  async sendText(chatId: string, text: string) {
    const id = crypto.randomUUID().replace(/-/g, "").toUpperCase();
    // Ids take the Baileys provider's shape, so receipts can find them.
    const m: Message = {
      ...incoming(`whatsapp:${chatId}:${id}`),
      providerMessageId: id,
      chatId,
      text,
      direction: "outgoing",
    };
    this.sent.push(m);
    return m;
  }
}
export function setup(ai?: AIProvider) {
  const db = openDatabase(":memory:");
  const events = new EventBus(),
    chats = new ChatRepository(db),
    messages = new MessageRepository(db, chats),
    settings = new Settings(db),
    keys = new ApiKeys(db),
    drafts = new DraftRepository(db),
    provider = new FakeProvider(),
    vault = new Vault(db, Buffer.alloc(32, 1));
  const sender = new MessageService(provider, messages, events);
  const requests: AIRequest[] = [];
  const copilot = new CopilotService(
    ai || {
      generate: async (request) => {
        requests.push(request);
        return "Yes, tomorrow works.";
      },
    },
    chats,
    messages,
    sender,
    drafts,
    settings,
    events,
  );
  const contacts = new ContactRepository(db);
  // No pacing in tests: the next send is scheduled on the next timer tick.
  const broadcasts = new BroadcastService(
    new BroadcastRepository(db),
    contacts,
    sender,
    provider,
    events,
    () => 0,
  );
  const services = {
    provider,
    keys,
    chats,
    messages,
    sender,
    events,
    settings,
    vault: async () => vault,
    drafts,
    copilot,
    broadcasts,
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
    events,
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
    contacts,
    requests,
    app,
    publicApp,
    tunnel,
    call,
    close: () => {
      copilot.close();
      broadcasts.close();
      tunnel.close();
      db.close();
    },
  };
}
