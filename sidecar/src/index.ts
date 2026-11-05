import { createVaultLoader } from "./security/vault-loader";
import { join, resolve } from "node:path";
import { mkdirSync, chmodSync, rmSync } from "node:fs";
import { openDatabase } from "./db/database";
import { BaileysProvider } from "./messaging/baileys/baileys-provider";
import { EventBus } from "./events/event-bus";
import { ApiKeys } from "./security/api-keys";
import { Vault } from "./security/vault";
import { Settings } from "./config/settings";
import { createLogger } from "./config/logger";
import { createApi } from "./api/server";
import { OpenRouterProvider } from "./ai/openrouter";
import { TunnelService } from "./tunnel/tunnel-service";
import { ProfileRuntime } from "./profiles/profile-runtime";
import { ProfileManager } from "./profiles/profile-manager";
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
// The main database is the main profile's, and holds what profiles share.
const db = openDatabase(join(dataDir, "wagate.sqlite"));
const settings = new Settings(db),
  keys = new ApiKeys(db);
const vault = createVaultLoader(() =>
  Vault.open(db, dataDir, () => profiles.databases()),
);
const ai = new OpenRouterProvider(async () =>
  (await vault()).get("openrouter"),
);
const profileDir = (id: string) => join(dataDir, "profiles", id);
const profiles = new ProfileManager(db, {
  open: (id) => {
    const dir = profileDir(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    return openDatabase(join(dir, "wagate.sqlite"));
  },
  destroy: (id) => {
    // Profile ids are generated, never user text; still, stay inside profiles/.
    if (!/^p_[0-9a-f]{12}$/.test(id)) return;
    rmSync(profileDir(id), { recursive: true, force: true });
  },
  removed: (id) => keys.forgetProfile(id),
  log,
  runtime: (id, profileDb) =>
    new ProfileRuntime({
      id,
      db: profileDb,
      ai,
      aiSettings: settings,
      log,
      // Every profile shares the one master key in the OS credential store.
      provider: (events) =>
        new BaileysProvider(
          profileDb === db
            ? vault
            : async () => (await vault()).forDatabase(profileDb),
          events,
        ),
    }),
});
// Opened before the port is bound; nothing connects until profiles.start().
profiles.load();
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
  profiles,
  keys,
  settings,
  vault,
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
  events: new EventBus(),
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
  await profiles.close();
  db.close();
  process.exit(1);
}
log("info", "sidecar.started", { port });
profiles.start();
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  tunnel.close();
  server.stop(true);
  await profiles.close();
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
