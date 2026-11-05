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
  /** The small JPEG preview embedded in an image, video or sticker, if any. */
  thumbnail(target: StoredMessage): Uint8Array | null;
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
}
// Historical reads deliberately live in repositories: SQLite is the source of truth.

/** A stored message, as the provider needs it to quote, react to or download it. */
export type StoredMessage = Pick<
  Message,
  "chatId" | "providerMessageId" | "direction" | "senderId" | "type" | "text"
> & { mediaSource?: Uint8Array | null };
export interface SendOptions {
  /** The message this one replies to. */
  quoted?: StoredMessage;
}
