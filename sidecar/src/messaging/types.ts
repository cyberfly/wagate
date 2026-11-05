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
  pinned: boolean;
  archived: boolean;
  lastMessage?: string | null;
}
export interface GroupInfo {
  id: string;
  name: string;
  memberCount: number;
  isAdmin: boolean;
}
/** What WhatsApp reports about a chat. Missing fields leave stored ones alone. */
export interface ChatUpdate {
  id: string;
  type: Chat["type"];
  name?: string;
  lastMessageAt?: number;
  /** When the chat was pinned, or null once unpinned. */
  pinnedAt?: number | null;
  archived?: boolean;
}
/** A person's LID and phone-number id, as WhatsApp revealed them. */
export interface PhoneLink {
  lid: string;
  phone: string;
}
/** Names WhatsApp knows for one person. Missing fields leave stored ones alone. */
export interface ContactNames {
  id: string;
  /** Saved in your phone's contacts. */
  name?: string;
  /** Set by the contact on their own WhatsApp profile. */
  pushName?: string;
}
export interface Message {
  id: string;
  provider: "whatsapp";
  providerMessageId: string;
  chatId: string;
  senderId: string;
  /** The sender's saved or profile name, when WhatsApp has told us one. */
  senderName?: string | null;
  /** The sender's phone-number id, when known; group senders are often LIDs. */
  senderPhone?: string | null;
  direction: "incoming" | "outgoing";
  type: MessageType;
  /** The text, a media caption, a document's file name, or a summary. */
  text?: string;
  timestamp: number;
  /** What can be shown about an attachment before downloading it. */
  media?: MessageMedia | null;
  /**
   * This device can download the attachment. Messages stored before
   * attachments were kept lack it until WhatsApp sends them again.
   */
  mediaAvailable?: boolean;
  /** The message this one replies to. */
  quoted?: QuotedMessage | null;
  /** How far one of our messages got. Unknown for most synced history. */
  status?: MessageStatus | null;
  /** Emoji people reacted with, most used first. */
  reactions?: Reaction[];
  /** When the sender last edited the text. */
  editedAt?: number | null;
  /** When the sender deleted it for everyone; its content is gone. */
  deletedAt?: number | null;
}
export type MessageType =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "sticker"
  | "location"
  | "contact"
  | "poll"
  | "unknown";
export type MessageStatus = "pending" | "sent" | "delivered" | "read" | "failed";
export interface MessageMedia {
  mimetype?: string;
  fileName?: string;
  /** Bytes. */
  size?: number;
  width?: number;
  height?: number;
  /** Length of a video or audio clip. */
  seconds?: number;
  /** A voice note rather than an audio file. */
  ptt?: boolean;
  /** A shared location. */
  latitude?: number;
  longitude?: number;
}
export interface QuotedMessage {
  /** WhatsApp's id for the quoted message. */
  providerMessageId: string;
  /** Wagate's id, when the quoted message is stored on this device. */
  messageId?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  /** Quoting one of our own messages. */
  fromMe: boolean;
  type: MessageType;
  text?: string;
}
export interface Reaction {
  emoji: string;
  count: number;
  /** Includes our own reaction. */
  mine: boolean;
}
/** A reaction someone added, or removed with an empty emoji. */
export interface ReactionUpdate {
  /** WhatsApp's id for the message reacted to. */
  providerMessageId: string;
  /** "me" for our own reaction. */
  senderId: string;
  emoji: string;
  timestamp: number;
}
/** A sender's change to a message already sent: a new text, or deletion. */
export interface MessageChange {
  providerMessageId: string;
  kind: "edit" | "delete";
  text?: string;
  timestamp: number;
}
/**
 * A message as the provider reports it. `mediaSource` lets the provider
 * download the attachment later; it never leaves the sidecar.
 */
export interface ReceivedMessage extends Message {
  mediaSource?: Uint8Array | null;
}
/** An attachment to send, decoded from base64. */
export interface OutgoingMedia {
  data: Uint8Array;
  mimetype: string;
  fileName?: string;
  caption?: string;
}
/**
 * What WhatsApp said about one of our messages after it left the socket.
 * A send only means the message was written; WhatsApp can still reject it.
 */
export interface MessageReceipt {
  providerMessageId: string;
  status: "failed" | "delivered" | "read";
  /** WhatsApp's error code for a rejection, such as "463". */
  error?: string;
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
  /** Accepted by WhatsApp, including those since delivered or read. */
  sent: number;
  /** Reached the recipient's phone, including those since read. */
  delivered: number;
  /** Rejected by WhatsApp after the send. */
  failed: number;
  pending: number;
  uncertain: number;
  cancelled: number;
}
export interface BroadcastRecipient {
  position: number;
  chatId: string;
  label: string;
  text: string;
  status:
    | "pending"
    | "sending"
    | "sent"
    | "delivered"
    | "read"
    | "failed"
    | "uncertain"
    | "cancelled";
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
    | "failed"
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
/** What WhatsApp did with one number asked to join a group. */
export interface GroupAddResult {
  phone: string;
  /**
   * `invite`: the person's privacy settings only let contacts add them, so
   * they must join through an invite instead.
   */
  status: "added" | "already" | "invite" | "failed";
  error?: string;
}
export interface GroupImportMember {
  phone: string;
  label: string;
  status: "pending" | GroupAddResult["status"] | "cancelled";
  error: string | null;
}
export interface GroupImport {
  id: string;
  groupId: string;
  groupName: string;
  status: "running" | "completed" | "cancelled" | "stopped";
  /** Seconds between requests: a random gap in [minDelay, maxDelay]. */
  minDelay: number;
  maxDelay: number;
  /** Why the import stopped early. */
  error: string | null;
  createdAt: number;
  updatedAt: number;
  members: GroupImportMember[];
}
export interface MessagePage {
  messages: Message[];
  nextCursor: string | null;
}
