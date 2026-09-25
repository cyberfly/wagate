import { CredentialStoreError } from "../../security/vault-loader";
import makeWASocket, {
  DisconnectReason,
  jidNormalizedUser,
  type WASocket,
} from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";
import type { MessagingProvider, ProviderEvents } from "../messaging-provider";
import type { ConnectionState } from "../types";
import { Vault } from "../../security/vault";
import { createAuth } from "./auth";
import { addResults, groupInfo } from "./groups";
import {
  normalizeChat,
  normalizeContacts,
  normalizeMessage,
  normalizeReceipt,
  senderNames,
  keyLinks,
  phoneLinks,
} from "./normalizer";
export class BaileysProvider implements MessagingProvider {
  private socket?: WASocket;
  private state: ConnectionState = { status: "disconnected" };
  private generation = 0;
  private retries = 0;
  private reconnect?: ReturnType<typeof setTimeout>;
  private qrExpiry?: ReturnType<typeof setTimeout>;
  private stopped = true;
  constructor(
    private getVault: () => Promise<Vault>,
    private events: ProviderEvents,
  ) {}
  getConnectionState() {
    return { ...this.state };
  }
  async listGroups() {
    const socket = this.socket;
    if (!socket || this.state.status !== "connected")
      throw new Error("WhatsApp is disconnected");
    const groups = await socket.groupFetchAllParticipating();
    this.receiveLinks(Object.values(groups).flatMap((g) => g.participants));
    return Object.values(groups)
      .map((g) => groupInfo(g, socket.user))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  async getGroup(id: string) {
    const socket = this.socket;
    if (!socket || this.state.status !== "connected")
      throw new Error("WhatsApp is disconnected");
    const group = await socket.groupMetadata(id);
    this.receiveLinks(group.participants);
    return groupInfo(group, socket.user);
  }
  async requestHistory(
    before: Parameters<MessagingProvider["requestHistory"]>[0],
    count: number,
  ) {
    const socket = this.socket;
    if (!socket || this.state.status !== "connected")
      throw new Error("WhatsApp is disconnected");
    const group = before.chatId.endsWith("@g.us");
    await socket.fetchMessageHistory(
      count,
      {
        remoteJid: before.chatId,
        id: before.providerMessageId,
        fromMe: before.direction === "outgoing",
        ...(group && before.senderId !== before.chatId
          ? { participant: before.senderId }
          : {}),
      },
      before.timestamp,
    );
  }
  async addGroupParticipants(groupId: string, phones: string[]) {
    const socket = this.socket;
    if (!socket || this.state.status !== "connected")
      throw new Error("WhatsApp is disconnected");
    const replies = await socket.groupParticipantsUpdate(
      groupId,
      phones.map((p) => p + "@s.whatsapp.net"),
      "add",
    );
    return addResults(phones, replies);
  }
  private update(state: ConnectionState) {
    this.state = state;
    this.events.connection(this.getConnectionState());
  }
  async connect() {
    if (!this.stopped) return;
    clearTimeout(this.reconnect);
    this.retries = 0;
    this.stopped = false;
    await this.start();
  }
  private async start() {
    const generation = ++this.generation;
    this.update({ status: this.retries ? "reconnecting" : "connecting" });
    try {
      const vault = await this.getVault();
      if (this.stopped || generation !== this.generation) return;
      const { state, saveCreds } = createAuth(vault);
      const socket = makeWASocket({
        auth: state,
        logger: pino({ level: "silent" }),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        connectTimeoutMs: 30000,
        defaultQueryTimeoutMs: 30000,
      });
      this.socket = socket;
      const active = () => !this.stopped && generation === this.generation;
      socket.ev.on("creds.update", () => {
        if (active()) {
          try {
            saveCreds();
          } catch {
            this.events.error("Could not persist WhatsApp credentials");
            void this.disconnect();
          }
        }
      });
      socket.ev.on("connection.update", (update) => {
        void (async () => {
          if (!active()) return;
          if (update.qr) {
            const qr = await QRCode.toDataURL(update.qr, {
              width: 280,
              margin: 2,
            });
            if (!active()) return;
            this.update({ status: "qr_required", qr });
            clearTimeout(this.qrExpiry);
            this.qrExpiry = setTimeout(() => {
              if (active() && this.state.status === "qr_required")
                this.update({
                  status: "connecting",
                  error: "QR expired. Waiting for a new code.",
                });
            }, 55000);
          }
          if (update.connection === "open") {
            clearTimeout(this.qrExpiry);
            this.retries = 0;
            this.update({
              status: "connected",
              account: socket.user?.id
                ? jidNormalizedUser(socket.user.id)
                : undefined,
            });
            // Group member lists name each LID's phone number, which labels
            // senders in stored group messages. listGroups records them.
            setTimeout(() => {
              if (active()) void this.listGroups().catch(() => {});
            }, 5000);
          }
          if (update.connection === "close") {
            clearTimeout(this.qrExpiry);
            this.socket = undefined;
            const code = (
              update.lastDisconnect?.error as {
                output?: { statusCode: number };
              }
            )?.output?.statusCode;
            if (
              code === DisconnectReason.loggedOut ||
              code === DisconnectReason.badSession ||
              code === DisconnectReason.multideviceMismatch
            ) {
              this.stopped = true;
              this.update({
                status: "auth_error",
                error:
                  "WhatsApp session is invalid. Reset the session and scan a new QR code.",
              });
              return;
            }
            if (code === DisconnectReason.connectionReplaced) {
              this.stopped = true;
              this.update({
                status: "disconnected",
                error: "Another WhatsApp session replaced this connection.",
              });
              return;
            }
            if (++this.retries > 8) {
              this.stopped = true;
              this.update({
                status: "disconnected",
                error: "Unable to reconnect. Check your network and try again.",
              });
              return;
            }
            this.update({
              status: "reconnecting",
              error: "Connection interrupted. Retrying…",
            });
            this.reconnect = setTimeout(
              () => {
                void this.start();
              },
              code === DisconnectReason.restartRequired
                ? 500
                : Math.min(30000, 1000 * 2 ** (this.retries - 1)),
            );
          }
        })().catch(() => {
          this.events.error("WhatsApp connection update failed");
        });
      });
      socket.ev.on("messages.upsert", ({ messages, type }) => {
        if (!active()) return;
        this.receiveNames(messages);
        for (const raw of messages) {
          try {
            const message = normalizeMessage(raw, socket.user?.id);
            if (message) this.events.message(message, type === "notify");
          } catch {
            this.events.error("Could not store a WhatsApp message");
          }
        }
      });
      // sendMessage resolves once the message is written to the socket. Only
      // these updates say whether WhatsApp took it and whether it arrived.
      socket.ev.on("messages.update", (updates) => {
        if (!active()) return;
        for (const update of updates) {
          try {
            const receipt = normalizeReceipt(update);
            if (receipt) this.events.receipt(receipt);
          } catch {
            this.events.error("Could not record a message receipt");
          }
        }
      });
      socket.ev.on("messaging-history.set", ({ chats, contacts, messages }) => {
        if (!active()) return;
        this.receiveContacts(contacts);
        this.receiveNames(messages);
        for (const chat of chats) this.receiveChat(chat);
        for (const raw of messages) {
          try {
            const message = normalizeMessage(raw, socket.user?.id);
            if (message) this.events.message(message, false);
          } catch {
            this.events.error("Could not store WhatsApp history");
          }
        }
      });
      socket.ev.on("chats.upsert", (chats) => {
        if (active()) for (const chat of chats) this.receiveChat(chat);
      });
      socket.ev.on("chats.update", (chats) => {
        if (active()) for (const chat of chats) this.receiveChat(chat);
      });
      // Saved names arrive from contact sync; Baileys also turns each incoming
      // message's push name into a contacts.update.
      socket.ev.on("contacts.upsert", (contacts) => {
        if (active()) this.receiveContacts(contacts);
      });
      socket.ev.on("contacts.update", (contacts) => {
        if (active()) this.receiveContacts(contacts);
      });
      socket.ev.on("lid-mapping.update", ({ lid, pn }) => {
        if (active()) this.receiveLinks([{ id: lid, phoneNumber: pn }]);
      });
    } catch (error) {
      if (generation === this.generation) {
        this.stopped = true;
        this.socket = undefined;
        this.update({
          status: "disconnected",
          error:
            error instanceof CredentialStoreError
              ? error.message
              : "Cannot start WhatsApp. Check OS credential-store access and local storage, then retry. Your session has not been reset.",
        });
      }
    }
  }
  private receiveChat(chat: Parameters<typeof normalizeChat>[0]) {
    try {
      const update = normalizeChat(chat);
      if (update) this.events.chat(update);
    } catch {
      this.events.error("Could not store chat metadata");
    }
  }
  /**
   * Downloads account-state collections from scratch: saved contacts live in
   * critical_unblock_low, pins and archives in regular_low. That sync only
   * sends changes after the first pairing, so state synced before Wagate
   * stored it never arrives otherwise.
   */
  async resyncAccountState(
    collections: ("critical_unblock_low" | "regular_low")[],
  ) {
    const socket = this.socket;
    if (!socket || this.state.status !== "connected")
      throw new Error("WhatsApp is disconnected");
    // No stored version makes WhatsApp return the whole collection, as it does
    // on first pairing.
    await socket.authState.keys.set({
      "app-state-sync-version": Object.fromEntries(
        collections.map((name) => [name, null]),
      ),
    });
    // Replayed as live changes: during an initial sync Baileys holds a chat's
    // pin or archive back until it sees that chat in the same sync.
    await socket.resyncAppState(collections, false);
  }
  private receiveContacts(contacts: Parameters<typeof normalizeContacts>[0]) {
    this.receiveLinks(contacts ?? []);
    try {
      const names = normalizeContacts(contacts ?? []);
      if (names.length) this.events.contacts(names);
    } catch {
      this.events.error("Could not store contact names");
    }
  }
  private receiveLinks(people: Parameters<typeof phoneLinks>[0]) {
    try {
      const links = phoneLinks(people);
      if (links.length) this.events.phones(links);
    } catch {
      this.events.error("Could not store contact names");
    }
  }
  /** Push names and phone numbers on a batch of messages, so group senders show who they are. */
  private receiveNames(messages: Parameters<typeof senderNames>[0][]) {
    try {
      const links = messages.flatMap(keyLinks);
      if (links.length) this.events.phones(links);
      const names = messages.flatMap(senderNames);
      if (names.length) this.events.contacts(names);
    } catch {
      this.events.error("Could not store contact names");
    }
  }
  async disconnect() {
    this.stopped = true;
    ++this.generation;
    clearTimeout(this.reconnect);
    clearTimeout(this.qrExpiry);
    this.socket?.end(undefined);
    this.socket = undefined;
    this.update({ status: "disconnected" });
  }
  async logout() {
    try {
      await this.socket?.logout();
    } finally {
      await this.disconnect();
      (await this.getVault()).clearPrefix("wa:");
    }
  }
  async sendText(chatId: string, text: string) {
    const socket = this.socket;
    if (!socket || this.state.status !== "connected")
      throw new Error("WhatsApp is disconnected");
    const raw = await socket.sendMessage(chatId, { text });
    if (!raw) throw new Error("WhatsApp did not acknowledge the message");
    const message = normalizeMessage(raw, socket.user?.id);
    if (!message) throw new Error("WhatsApp returned an invalid message");
    return message;
  }
}
