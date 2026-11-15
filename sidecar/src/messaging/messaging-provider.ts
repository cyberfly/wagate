import type {
  ChatUpdate,
  ConnectionState,
  ContactNames,
  Message,
  MessageChange,
  MessageReceipt,
  OutgoingMedia,
  ReactionUpdate,
  ReceivedMessage,
  GroupInfo,
  GroupAddResult,
  PhoneLink,
  PresenceUpdate,
  ChatChange,
  LinkPreview,
} from "./types";
export interface ProviderEvents {
  connection: (state: ConnectionState) => void;
  message: (message: ReceivedMessage, live: boolean) => void;
  receipt: (receipt: MessageReceipt) => void;
  reaction: (reaction: ReactionUpdate) => void;
  change: (change: MessageChange) => void;
  chat: (chat: ChatUpdate) => void;
  contacts: (contacts: ContactNames[]) => void;
  phones: (links: PhoneLink[]) => void;
  presence: (update: PresenceUpdate) => void;
  /** The whole block list ("set"), or people added to or removed from it. */
  blocked: (ids: string[], kind: "set" | "add" | "remove") => void;
  error: (message: string) => void;
}
export interface MessagingProvider {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  logout(): Promise<void>;
  sendText(
    chatId: string,
    text: string,
    options?: SendOptions,
  ): Promise<ReceivedMessage>;
  sendMedia(
    chatId: string,
    media: OutgoingMedia,
    options?: SendOptions,
  ): Promise<ReceivedMessage>;
  /** Reacts to a stored message; an empty emoji removes our reaction. */
  react(target: StoredMessage, emoji: string): Promise<void>;
  /** Downloads and decrypts a stored message's attachment. */
  downloadMedia(target: StoredMessage): Promise<Uint8Array>;
  /** Sends read receipts, so the senders see blue ticks. */
  markRead(targets: StoredMessage[]): Promise<void>;
  /** Replaces the text of one of our own text messages. */
  edit(target: StoredMessage, text: string): Promise<void>;
  /** Deletes one of our own messages for everyone in the chat. */
  revoke(target: StoredMessage): Promise<void>;
  /** Forwards a stored message, marked as forwarded, to another chat. */
  forward(target: StoredMessage, chatId: string): Promise<ReceivedMessage>;
  /** The small JPEG preview embedded in an image, video or sticker, if any. */
  thumbnail(target: StoredMessage): Uint8Array | null;
  /**
   * Shows this account as online or offline, or as typing (or no longer
   * typing) in one chat.
   */
  setPresence(
    state: "available" | "unavailable" | "composing" | "paused",
    chatId?: string,
  ): Promise<void>;
  /** Asks WhatsApp to report who is online or typing in a chat. */
  watchPresence(chatId: string): Promise<void>;
  /** A chat's small profile picture; null when it has none or hides it. */
  profilePicture(chatId: string): Promise<Uint8Array | null>;
  getConnectionState(): ConnectionState;
  listGroups(): Promise<GroupInfo[]>;
  getGroup(id: string): Promise<GroupInfo>;
  /**
   * Asks your phone to send again up to `count` messages older than `before`.
   * They arrive later as history.
   */
  requestHistory(
    before: Pick<Message, "chatId" | "providerMessageId" | "direction" | "senderId" | "timestamp">,
    count: number,
  ): Promise<void>;
  /** Adds international phone numbers (digits only) to a group in one request. */
  addGroupParticipants(
    groupId: string,
    phones: string[],
  ): Promise<GroupAddResult[]>;
  /** Leaves a group. Its chat and history stay on this device. */
  leaveGroup(groupId: string): Promise<void>;
  /** The people in a group, without our own account. */
  groupMembers(groupId: string): Promise<{ id: string; phone?: string | null; admin: boolean }[]>;
  /**
   * Mutes, archives, marks read or unread, or deletes a chat on WhatsApp, so
   * the phone and other linked devices follow. `last` is the chat's newest
   * stored message, which WhatsApp needs for all but muting.
   */
  modifyChat(chatId: string, change: ChatChange, last?: LastMessage | null): Promise<void>;
  /** Blocks or unblocks a person. */
  setBlocked(chatId: string, blocked: boolean): Promise<void>;
}
export type LastMessage = StoredMessage & { timestamp: number };
// Historical reads deliberately live in repositories: SQLite is the source of truth.

/** A stored message, as the provider needs it to quote, react to or download it. */
export type StoredMessage = Pick<
  Message,
  "chatId" | "providerMessageId" | "direction" | "senderId" | "type" | "text"
> & { mediaSource?: Uint8Array | null };
export interface SendOptions {
  /** The message this one replies to. */
  quoted?: StoredMessage;
  /** People the text names as `@` and their id's number. */
  mentions?: string[];
  /** Shown with a text message that contains the link. */
  link?: LinkPreview;
}
