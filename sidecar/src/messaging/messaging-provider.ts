import type {
  ChatUpdate,
  ConnectionState,
  ContactNames,
  Message,
  MessageReceipt,
  GroupInfo,
  GroupAddResult,
} from "./types";
export interface ProviderEvents {
  connection: (state: ConnectionState) => void;
  message: (message: Message, live: boolean) => void;
  receipt: (receipt: MessageReceipt) => void;
  chat: (chat: ChatUpdate) => void;
  contacts: (contacts: ContactNames[]) => void;
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
  /** Adds international phone numbers (digits only) to a group in one request. */
  addGroupParticipants(
    groupId: string,
    phones: string[],
  ): Promise<GroupAddResult[]>;
}
// Historical reads deliberately live in repositories: SQLite is the source of truth.
