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
import { normalizeMessage } from "./normalizer";
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
        for (const raw of messages) {
          try {
            const message = normalizeMessage(raw, socket.user?.id);
            if (message) this.events.message(message, type === "notify");
          } catch {
            this.events.error("Could not store a WhatsApp message");
          }
        }
      });
      socket.ev.on("messaging-history.set", ({ chats, messages }) => {
        if (!active()) return;
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
  private receiveChat(chat: {
    id?: string | null;
    name?: string | null;
    conversationTimestamp?: unknown;
  }) {
    if (!chat.id || !/@(s\.whatsapp\.net|lid|g\.us)$/.test(chat.id)) return;
    try {
      this.events.chat({
        id: jidNormalizedUser(chat.id),
        provider: "whatsapp",
        name: chat.name || jidNormalizedUser(chat.id),
        type: chat.id.endsWith("@g.us") ? "group" : "direct",
        lastMessageAt: chat.conversationTimestamp
          ? Number(chat.conversationTimestamp) * 1000
          : null,
      });
    } catch {
      this.events.error("Could not store chat metadata");
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
