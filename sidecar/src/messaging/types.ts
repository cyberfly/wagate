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
  /** When the send began; the only time known for an uncertain send. */
  attemptedAt: number | null;
  sentAt: number | null;
}
export interface BroadcastEvent {
  id: number;
  at: number;
  type:
    | "created"
    | "sent"
    | "uncertain"
    | "paused"
    | "resumed"
    | "cancelled"
    | "completed";
  /** The recipient a send outcome refers to. */
  position: number | null;
  label: string | null;
  chatId: string | null;
  /** Counts, a pause reason, or a failure reason, ready to show. */
  detail: string | null;
}
export interface MessagePage {
  messages: Message[];
  nextCursor: string | null;
}
