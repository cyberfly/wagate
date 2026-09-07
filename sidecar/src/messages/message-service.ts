import type { MessagingProvider } from "../messaging/messaging-provider";
import type { Message } from "../messaging/types";
import { MessageRepository } from "./message-repository";
import { EventBus } from "../events/event-bus";
export function resolveChatId(value: string) {
  const clean = value.trim();
  if (/^\+?\d{7,15}$/.test(clean))
    return clean.replace(/^\+/, "") + "@s.whatsapp.net";
  if (
    /^(\d{7,20}@s\.whatsapp\.net|\d{7,20}@lid|\d{5,20}(?:-\d{5,20})?@g\.us)$/.test(
      clean,
    )
  )
    return clean;
  throw new Error(
    "Use an international phone number or valid WhatsApp chat ID",
  );
}
export class MessageService {
  constructor(
    private provider: MessagingProvider,
    private repository: MessageRepository,
    private events: EventBus,
  ) {}
  receive(message: Message, live: boolean) {
    const inserted = this.repository.save(message);
    if (inserted) {
      this.events.publish(
        live && message.direction === "incoming"
          ? "message.received"
          : "message.synced",
        message,
      );
      this.events.publish("chat.updated", { id: message.chatId });
    }
    return inserted;
  }
  async send(chatId: string, text: string) {
    chatId = resolveChatId(chatId);
    text = text.trim();
    if (!text || text.length > 10000)
      throw new Error("Text must contain 1–10,000 characters");
    if (this.provider.getConnectionState().status !== "connected")
      throw new Error("WhatsApp is disconnected");
    const message = await this.provider.sendText(chatId, text);
    this.repository.save(message);
    this.events.publish("message.sent", message);
    this.events.publish("chat.updated", { id: chatId });
    return message;
  }
}
