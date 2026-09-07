import type { AIProvider } from "./ai-provider";
import type { Message } from "../messaging/types";
import { ChatRepository } from "../chats/chat-repository";
import { MessageRepository } from "../messages/message-repository";
import { MessageService } from "../messages/message-service";
import { DraftRepository } from "./draft-repository";
import { Settings } from "../config/settings";
import { EventBus } from "../events/event-bus";
export class CopilotService {
  private pending = new Map<string, Promise<void>>();
  private running = new Set<string>();
  private unsubscribe: () => void;
  private closed = false;
  private queued = 0;
  constructor(
    private ai: AIProvider,
    private chats: ChatRepository,
    private messages: MessageRepository,
    private sender: MessageService,
    private drafts: DraftRepository,
    private settings: Settings,
    private events: EventBus,
  ) {
    this.unsubscribe = events.subscribe((event) => {
      if (event.type === "message.received")
        this.enqueue(event.data as Message);
    });
  }
  close() {
    this.closed = true;
    this.unsubscribe();
  }
  private enqueue(message: Message) {
    if (
      this.closed ||
      message.direction !== "incoming" ||
      message.type !== "text" ||
      this.chats.get(message.chatId)?.aiMode !== "copilot"
    )
      return;
    if (this.queued >= 100) {
      this.events.publish("ai.error", {
        chatId: message.chatId,
        error: "Copilot queue is full. Generate a draft manually.",
      });
      return;
    }
    this.queued++;
    const previous = this.pending.get(message.chatId) || Promise.resolve();
    const next = previous
      .then(async () => {
        if (!this.closed) await this.generate(message.chatId, message.id);
      })
      .catch((error) =>
        this.events.publish("ai.error", {
          chatId: message.chatId,
          error: error instanceof Error ? error.message : "Copilot failed",
        }),
      )
      .then(() => {});
    this.pending.set(message.chatId, next);
    void next.finally(() => {
      this.queued--;
      if (this.pending.get(message.chatId) === next)
        this.pending.delete(message.chatId);
    });
  }
  async generate(chatId: string, sourceId?: string) {
    if (this.chats.get(chatId)?.aiMode !== "copilot")
      throw new Error("Enable Copilot for this chat first");
    if (this.running.has(chatId))
      throw new Error("A draft is already being generated for this chat");
    const config = this.settings.getAi();
    const history = this.messages.page(chatId, config.contextSize).messages;
    const source = sourceId
      ? history.find((m) => m.id === sourceId)
      : [...history]
          .reverse()
          .find((m) => m.direction === "incoming" && m.type === "text");
    if (!source) throw new Error("No recent incoming text message to reply to");
    const existing = this.drafts.forSource(source.id);
    if (existing) return existing;
    this.running.add(chatId);
    this.events.publish("ai.processing", { chatId });
    try {
      const relevant = history.slice(
        0,
        history.findIndex((m) => m.id === source.id) + 1,
      );
      const text = await this.ai.generate({
        model: config.model,
        messages: [
          { role: "system", content: config.systemPrompt },
          ...relevant.map((m) => ({
            role:
              m.direction === "incoming"
                ? ("user" as const)
                : ("assistant" as const),
            content: (m.text || `[${m.type}]`).slice(0, 4000),
          })),
        ],
      });
      if (this.closed || this.chats.get(chatId)?.aiMode !== "copilot")
        throw new Error("Copilot was turned off; generated reply discarded");
      const draft = this.drafts.create(chatId, source.id, text);
      this.events.publish("ai.reply.generated", draft);
      return draft;
    } finally {
      this.running.delete(chatId);
      this.events.publish("ai.idle", { chatId });
    }
  }
  status() {
    return [...this.running];
  }
  async approve(id: string, text: string) {
    const draft = this.drafts.get(id);
    if (!draft) throw new Error("Draft not found");
    if (!text.trim() || text.length > 10000)
      throw new Error("Reply must contain 1–10,000 characters");
    if (!this.drafts.claim(id))
      throw new Error(
        "Draft is already sent, dismissed, or awaiting delivery verification",
      );
    try {
      const message = await this.sender.send(draft.chatId, text);
      this.drafts.setStatus(id, "sent");
      this.events.publish("ai.draft.updated", { id, chatId: draft.chatId });
      return message;
    } catch (error) {
      this.drafts.setStatus(id, "uncertain");
      throw error;
    }
  }
}
