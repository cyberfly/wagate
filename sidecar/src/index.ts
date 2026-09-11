import { createVaultLoader } from "./security/vault-loader";
import { join, resolve } from "node:path";
import { mkdirSync, chmodSync } from "node:fs";
import { openDatabase } from "./db/database";
import { ChatRepository } from "./chats/chat-repository";
import { MessageRepository } from "./messages/message-repository";
import { MessageService } from "./messages/message-service";
import { BaileysProvider } from "./messaging/baileys/baileys-provider";
import { EventBus } from "./events/event-bus";
import { ApiKeys } from "./security/api-keys";
import { Vault } from "./security/vault";
import { Settings } from "./config/settings";
import { createLogger } from "./config/logger";
import { createApi } from "./api/server";
import { OpenRouterProvider } from "./ai/openrouter";
import { DraftRepository } from "./ai/draft-repository";
import { CopilotService } from "./ai/copilot-service";
import { TunnelService } from "./tunnel/tunnel-service";
import { BroadcastRepository } from "./broadcast/broadcast-repository";
import { BroadcastService } from "./broadcast/broadcast-service";
import { ContactRepository } from "./contacts/contact-repository";
process.umask(0o077);
const port = Number(process.env.WAGATE_PORT || 8787);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("WAGATE_PORT must be 1024–65535");
const dataDir = resolve(process.env.WAGATE_DATA_DIR || ".data");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
chmodSync(dataDir, 0o700);
const log = createLogger(dataDir);
// Some transitive Signal libraries log full session objects. Never forward their arguments.
console.log = () => log("info", "dependency.log");
console.warn = () => log("error", "dependency.warning");
console.error = () => log("error", "dependency.error");
const db = openDatabase(join(dataDir, "wagate.sqlite"));
const events = new EventBus(),
  chats = new ChatRepository(db),
  messages = new MessageRepository(db, chats),
  settings = new Settings(db),
  keys = new ApiKeys(db),
  drafts = new DraftRepository(db),
  contacts = new ContactRepository(db);
const vault = createVaultLoader(() => Vault.open(db, dataDir));
const provider = new BaileysProvider(vault, {
  connection: (state) => {
    events.publish("messaging.connection", state);
    log("info", "whatsapp.state", { state: state.status });
    if (state.status === "connected") resyncAccountStateOnce();
  },
  message: (message, live) => sender.receive(message, live),
  receipt: (receipt) => {
    if (receipt.status === "failed")
      log("error", "whatsapp.message.rejected", { code: receipt.error ?? "none" });
    broadcasts.receipt(receipt);
  },
  chat: (chat) => {
    if (chats.apply(chat)) events.publish("chat.updated", { id: chat.id });
  },
  contacts: (names) => contacts.save(names),
  error: () => {
    log("error", "whatsapp.operation.failed");
    events.publish("messaging.error", {
      error: "WhatsApp operation failed. Check local storage and reconnect.",
    });
  },
});
// Account state synced before Wagate stored it (saved contact names; pins and
// archives, which order the inbox) needs one fresh copy from WhatsApp. Fetch
// what is missing once, after the connection settles; a failure leaves the
// flags unset so the next connection tries again.
const accountState = [
  { flag: "contacts.resynced", collection: "critical_unblock_low" },
  { flag: "chats.resynced", collection: "regular_low" },
] as const;
let accountResync: ReturnType<typeof setTimeout> | undefined;
function resyncAccountStateOnce() {
  const missing = accountState.filter((s) => settings.get(s.flag) !== "true");
  if (accountResync || !missing.length) return;
  accountResync = setTimeout(() => {
    provider
      .resyncAccountState(missing.map((s) => s.collection))
      .then(() => {
        for (const s of missing) settings.set(s.flag, "true");
        log("info", "whatsapp.account_state.resynced", {
          collections: missing.map((s) => s.collection).join(","),
        });
      })
      .catch(() => log("error", "whatsapp.account_state.resync_failed"))
      .finally(() => (accountResync = undefined));
  }, 10000);
}
const sender = new MessageService(provider, messages, events);
const ai = new OpenRouterProvider(async () =>
  (await vault()).get("openrouter"),
);
const copilot = new CopilotService(
  ai,
  chats,
  messages,
  sender,
  drafts,
  settings,
  events,
);
const broadcasts = new BroadcastService(
  new BroadcastRepository(db),
  sender,
  provider,
  events,
);
const desktopToken = process.env.WAGATE_DESKTOP_TOKEN || "";
delete process.env.WAGATE_DESKTOP_TOKEN;
const databaseHealthy = () => {
  try {
    db.query("SELECT 1").get();
    return true;
  } catch {
    return false;
  }
};
const services = {
  provider,
  keys,
  chats,
  messages,
  sender,
  events,
  settings,
  vault,
  drafts,
  copilot,
  broadcasts,
  port,
  databaseHealthy,
  log,
};
// The tunnel serves this second app, which carries the public routes only, on
// its own ephemeral loopback port. `/internal` never leaves the machine.
const publicApp = createApi({
  ...services,
  desktopToken: "",
  publicMode: true,
});
const tunnel = new TunnelService({
  dataDir,
  events,
  log,
  fetch: publicApp.fetch,
});
const app = createApi({ ...services, desktopToken, tunnel });
let server: ReturnType<typeof Bun.serve>;
try {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: app.fetch,
    idleTimeout: 60,
  });
} catch {
  log("error", "sidecar.bind.failed", { port });
  db.close();
  process.exit(1);
}
log("info", "sidecar.started", { port });
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  clearTimeout(accountResync);
  copilot.close();
  broadcasts.close();
  tunnel.close();
  server.stop(true);
  await provider.disconnect();
  db.close();
  log("info", "sidecar.stopped");
  process.exit(0);
};
// Last resort: never leave a public tunnel running after the gateway is gone.
process.on("exit", () => tunnel.close());
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
if (process.env.WAGATE_DESKTOP === "1") {
  process.stdin.resume();
  process.stdin.on("data", (data) => {
    if (data.toString().includes("shutdown")) void shutdown();
  });
  process.stdin.on("end", () => void shutdown());
}
if (settings.get("whatsapp.autoConnect") === "true") void provider.connect();
