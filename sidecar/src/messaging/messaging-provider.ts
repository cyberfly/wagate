import type {
  ChatUpdate,
  ConnectionState,
  ContactNames,
  Message,
  MessageReceipt,
  GroupInfo,
  GroupAddResult,
  PhoneLink,
} from "./types";
export interface ProviderEvents {
  connection: (state: ConnectionState) => void;
  message: (message: Message, live: boolean) => void;
  receipt: (receipt: MessageReceipt) => void;
  chat: (chat: ChatUpdate) => void;
  contacts: (contacts: ContactNames[]) => void;
  phones: (links: PhoneLink[]) => void;
  error: (message: string) => void;
}
export interface MessagingProvider {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  logout(): Promise<void>;
  sendText(chatId: string, text: string): Promise<Message>;
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
