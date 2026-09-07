import type { Chat, ConnectionState, Message } from "./types";
export interface ProviderEvents {
  connection: (state: ConnectionState) => void;
  message: (message: Message, live: boolean) => void;
  chat: (chat: Omit<Chat, "aiMode">) => void;
  error: (message: string) => void;
}
export interface MessagingProvider {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  logout(): Promise<void>;
  sendText(chatId: string, text: string): Promise<Message>;
  getConnectionState(): ConnectionState;
}
// Historical reads deliberately live in repositories: SQLite is the source of truth.
