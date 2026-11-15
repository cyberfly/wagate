import type { MessagingProvider } from "../messaging/messaging-provider";
import type { ChatChange } from "../messaging/types";
import type { EventBus } from "../events/event-bus";
import type { MessageRepository } from "../messages/message-repository";
import type { ChatRepository } from "./chat-repository";
export const muteDurations = { "8h": 8 * 3600_000, "1w": 7 * 24 * 3600_000 } as const;
export type MuteChoice = keyof typeof muteDurations | "always" | "off";
/**
 * What a person does to a whole chat. Each change is made on WhatsApp first,
 * so the phone and other linked devices follow, and stored here only once
 * WhatsApp took it.
 */
export class ChatActions {
  constructor(
    private chats: ChatRepository,
    private messages: MessageRepository,
    private provider: MessagingProvider,
    private events: EventBus,
  ) {}
  private chat(chatId: string) {
    const chat = this.chats.get(chatId);
    if (!chat) throw new Error("Chat not found");
    if (this.provider.getConnectionState().status !== "connected")
      throw new Error("WhatsApp is disconnected");
    return chat;
  }
  private async change(chatId: string, change: ChatChange) {
    await this.provider.modifyChat(chatId, change, this.messages.last(chatId));
  }
  private changed(chatId: string) {
    this.events.publish("chat.updated", { id: chatId });
    return this.chats.get(chatId);
  }
  async mute(chatId: string, choice: MuteChoice) {
    const chat = this.chat(chatId);
    const until =
      choice === "off" ? null : choice === "always" ? -1 : Date.now() + muteDurations[choice];
    await this.change(chatId, { mute: until });
    this.chats.apply({ id: chatId, type: chat.type, mutedUntil: until });
    return this.changed(chatId);
  }
  async archive(chatId: string, archived: boolean) {
    const chat = this.chat(chatId);
    await this.change(chatId, { archive: archived });
    this.chats.apply({ id: chatId, type: chat.type, archived });
    return this.changed(chatId);
  }
  /** Marks a chat unread, as a reminder to come back to it. */
  async markUnread(chatId: string) {
    const chat = this.chat(chatId);
    await this.change(chatId, { read: false });
    this.chats.apply({ id: chatId, type: chat.type, unreadCount: -1 });
    return this.changed(chatId);
  }
  /**
   * Deletes a chat here and on WhatsApp. A chat with nothing stored has
   * nothing WhatsApp could be told about, so it is only removed here.
   */
  async remove(chatId: string) {
    this.chat(chatId);
    if (this.messages.last(chatId)) await this.change(chatId, { delete: true });
    this.messages.clearChat(chatId);
    this.chats.forget(chatId);
    this.events.publish("chat.updated", { id: chatId });
    return { success: true };
  }
  async block(chatId: string, blocked: boolean) {
    const chat = this.chat(chatId);
    if (chat.type !== "direct") throw new Error("Invalid chat: only a person can be blocked");
    await this.provider.setBlocked(chatId, blocked);
    this.chats.setBlocked([chatId], blocked ? "add" : "remove");
    return this.changed(chatId);
  }
  /** WhatsApp's own report of the block list. */
  blocked(ids: string[], kind: "set" | "add" | "remove") {
    this.chats.setBlocked(ids, kind);
    this.events.publish("chats.blocked", {});
  }
}
