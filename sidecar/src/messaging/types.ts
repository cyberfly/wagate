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
export interface Broadcast {
  id: string;
  name: string;
  status: "running" | "paused" | "completed" | "cancelled";
  /** Seconds between sends: a random gap in [minDelay, maxDelay]. */
  minDelay: number;
  maxDelay: number;
  /** Why the broadcast paused, when it paused on its own. */
  error: string | null;
  createdAt: number;
  updatedAt: number;
  total: number;
  sent: number;
  pending: number;
  uncertain: number;
  cancelled: number;
}
export interface BroadcastRecipient {
  position: number;
  chatId: string;
  label: string;
  text: string;
  status: "pending" | "sending" | "sent" | "uncertain" | "cancelled";
  messageId: string | null;
  error: string | null;
  sentAt: number | null;
}
export interface MessagePage {
  messages: Message[];
  nextCursor: string | null;
}
