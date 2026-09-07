export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "qr_required"
  | "connected"
  | "reconnecting"
  | "auth_error";
export interface ConnectionState {
  status: ConnectionStatus;
  qr?: string;
  account?: string;
  error?: string;
}
export interface Chat {
  id: string;
  provider: "whatsapp";
  name: string;
  type: "direct" | "group";
  lastMessageAt: number | null;
  aiMode: "off" | "copilot";
}
export interface Message {
  id: string;
  provider: "whatsapp";
  providerMessageId: string;
  chatId: string;
  senderId: string;
  direction: "incoming" | "outgoing";
  type: "text" | "image" | "video" | "audio" | "document" | "unknown";
  text?: string;
  timestamp: number;
}
export interface Draft {
  id: string;
  chatId: string;
  sourceMessageId: string;
  text: string;
  status: "pending" | "sending" | "sent" | "dismissed" | "uncertain";
  createdAt: number;
}
export interface MessagePage {
  messages: Message[];
  nextCursor: string | null;
}
