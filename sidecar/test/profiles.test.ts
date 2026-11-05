import { test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup, incoming, chatId } from "./helpers";
import { migrations } from "../src/db/schema";
import { openDatabase } from "../src/db/database";
import { ApiKeys } from "../src/security/api-keys";
import { Vault } from "../src/security/vault";
import { createAuth } from "../src/messaging/baileys/auth";
import { ProfileManager, maxProfiles } from "../src/profiles/profile-manager";
import { ProfileRuntime } from "../src/profiles/profile-runtime";
import { FakeProvider } from "./helpers";
import { Settings } from "../src/config/settings";
const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});
function open() {
  const s = setup();
  cleanup.push(s.close);
  return s;
}
async function json(response: Response) {
  return { status: response.status, body: await response.json() };
}
async function addProfile(s: ReturnType<typeof setup>, name = "Shop") {
  const created = await json(
    await s.call("/internal/profiles", "POST", { name }),
  );
  expect(created.status).toBe(200);
  return created.body as { id: string; name: string; isDefault: boolean };
}
test("an upgraded database has one main profile, and every key reaches all profiles", () => {
  const dir = mkdtempSync(join(tmpdir(), "wagate-profiles-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "wagate.sqlite");
  const old = new Database(path, { create: true });
  for (const m of migrations.slice(0, 9)) old.exec(m);
  old.close();
  {
    const v9 = new Database(path);
    v9.query(
      "INSERT INTO api_keys(id,name,key_hash,permissions,created_at) VALUES('k','old','h','[\"chats.read\"]',1)",
    ).run();
    v9.close();
  }
  const db = openDatabase(path);
  expect(db.query("SELECT id,name,account FROM profiles").all()).toEqual([
    { id: "default", name: "Main", account: null },
  ]);
  expect(
    (new ApiKeys(db).list()[0] as { profiles: string | null }).profiles,
  ).toBeNull();
  db.close();
});
test("each profile keeps its own chats, messages and connection", async () => {
  const s = open();
  const shop = await addProfile(s);
  expect(shop).toMatchObject({ name: "Shop", isDefault: false });
  s.sender.receive(incoming("main-1", "For the main number"), false);
  const shopRuntime = s.profiles.get(shop.id)!;
  shopRuntime.sender.receive(
    {
      ...incoming("shop-1", "For the shop"),
      chatId: "60999999999@s.whatsapp.net",
      senderId: "60999999999@s.whatsapp.net",
    },
    false,
  );
  const main = (await json(await s.call("/internal/snapshot"))).body;
  const other = (
    await json(await s.call("/internal/snapshot?profile=" + shop.id))
  ).body;
  expect(main.profile.id).toBe("default");
  expect(main.chats.map((c: { id: string }) => c.id)).toEqual([chatId]);
  expect(other.profile).toMatchObject({ id: shop.id, name: "Shop" });
  expect(other.chats.map((c: { id: string }) => c.id)).toEqual([
    "60999999999@s.whatsapp.net",
  ]);
  expect(main.profiles.map((p: { name: string }) => p.name)).toEqual([
    "Main",
    "Shop",
  ]);
  // Disconnecting one number leaves the other connected.
  await s.call("/internal/connection/disconnect?profile=" + shop.id, "POST");
  expect(s.providers.get(shop.id)!.state.status).toBe("disconnected");
  expect(s.provider.state.status).toBe("connected");
  expect(shopRuntime.settings.get("whatsapp.autoConnect")).toBe("false");
  expect(
    s.profiles.main().settings.get("whatsapp.autoConnect"),
  ).toBeUndefined();
});
test("REST calls choose a profile by header or query; the main profile is the default", async () => {
  const s = open();
  const shop = await addProfile(s);
  const key = s.keys.create("all", ["messages.send", "chats.read"]);
  const send = (headers: Record<string, string>, query = "") =>
    s.call(
      "/v1/messages/send" + query,
      "POST",
      { to: "60123456789", text: "Hi" },
      key.key,
      headers,
    );
  expect((await send({})).status).toBe(200);
  expect((await send({ "X-Wagate-Profile": shop.id })).status).toBe(200);
  expect((await send({}, "?profile=" + shop.id)).status).toBe(200);
  expect(s.provider.sent).toHaveLength(1);
  expect(s.providers.get(shop.id)!.sent).toHaveLength(2);
  expect((await send({ "X-Wagate-Profile": "p_nope" })).status).toBe(404);
  const conflict = await json(
    await send({ "X-Wagate-Profile": shop.id }, "?profile=default"),
  );
  expect(conflict.status).toBe(400);
  const status = await json(
    await s.call("/v1/status", "GET", undefined, key.key, {
      "X-Wagate-Profile": shop.id,
    }),
  );
  expect(status.body.profile).toMatchObject({ id: shop.id, name: "Shop" });
});
test("a key limited to one profile uses it implicitly and cannot reach the others", async () => {
  const s = open();
  const shop = await addProfile(s);
  const created = await json(
    await s.call("/internal/keys", "POST", {
      name: "shop bot",
      permissions: ["messages.send", "chats.read"],
      profiles: [shop.id],
    }),
  );
  expect(created.status).toBe(200);
  const key = created.body.key as string;
  const send = (headers: Record<string, string> = {}) =>
    s.call(
      "/v1/messages/send",
      "POST",
      { to: "60123456789", text: "Hi" },
      key,
      headers,
    );
  expect((await send()).status).toBe(200);
  expect(s.providers.get(shop.id)!.sent).toHaveLength(1);
  expect(s.provider.sent).toHaveLength(0);
  expect((await send({ "X-Wagate-Profile": "default" })).status).toBe(403);
  // A missing profile looks the same as a forbidden one to a restricted key.
  expect((await send({ "X-Wagate-Profile": "p_000000000000" })).status).toBe(
    403,
  );
  const listed = await json(
    await s.call("/v1/profiles", "GET", undefined, key),
  );
  expect(listed.body.profiles.map((p: { id: string }) => p.id)).toEqual([
    shop.id,
  ]);
  const unrestricted = s.keys.create("all", ["chats.read"]);
  const all = await json(
    await s.call("/v1/profiles", "GET", undefined, unrestricted.key),
  );
  expect(all.body.profiles).toHaveLength(2);
  expect(
    (
      await s.call("/internal/keys", "POST", {
        name: "bad",
        permissions: ["chats.read"],
        profiles: ["p_missing"],
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await s.call("/internal/keys", "POST", {
        name: "empty",
        permissions: ["chats.read"],
        profiles: [],
      })
    ).status,
  ).toBe(400);
});
test("profiles are managed from the desktop only, with validated unique names", async () => {
  const s = open();
  const key = s.keys.create("all", [
    "chats.read",
    "messages.read",
    "messages.send",
  ]);
  expect(
    (await s.call("/internal/profiles", "POST", { name: "X" }, key.key)).status,
  ).toBe(403);
  expect(
    (await s.call("/internal/profiles", "POST", { name: "  " })).status,
  ).toBe(400);
  expect(
    (await s.call("/internal/profiles", "POST", { name: "x".repeat(41) }))
      .status,
  ).toBe(400);
  const shop = await addProfile(s, "  Shop   front ");
  expect(shop.name).toBe("Shop front");
  const duplicate = await json(
    await s.call("/internal/profiles", "POST", { name: "shop FRONT" }),
  );
  expect(duplicate).toMatchObject({ status: 400 });
  expect(duplicate.body.error).toContain("already exists");
  const renamed = await json(
    await s.call("/internal/profiles/" + shop.id, "PUT", { name: "Support" }),
  );
  expect(renamed.body.name).toBe("Support");
  expect(
    (await s.call("/internal/profiles/default", "PUT", { name: "support" }))
      .status,
  ).toBe(400);
  expect(
    (await s.call("/internal/profiles/default", "PUT", { name: "Personal" }))
      .status,
  ).toBe(200);
  expect(s.profiles.list().map((p) => p.name)).toEqual(["Personal", "Support"]);
  expect(
    (await s.call("/internal/profiles/p_missing", "PUT", { name: "Y" })).status,
  ).toBe(400);
});
test("the number of profiles is bounded", async () => {
  const s = open();
  for (let i = 1; i < maxProfiles; i++) await addProfile(s, "Number " + i);
  const over = await json(
    await s.call("/internal/profiles", "POST", { name: "One too many" }),
  );
  expect(over.status).toBe(400);
  expect(over.body.error).toContain("limit");
});
test("removing a profile unlinks it, deletes its data and narrows API keys", async () => {
  const s = open();
  const shop = await addProfile(s);
  const only = s.keys.create("shop only", ["chats.read"], [shop.id]);
  const both = s.keys.create("both", ["chats.read"], ["default", shop.id]);
  const provider = s.providers.get(shop.id)!;
  let loggedOut = false;
  provider.logout = async () => {
    loggedOut = true;
    await provider.disconnect();
  };
  const main = await json(await s.call("/internal/profiles/default", "DELETE"));
  expect(main.status).toBe(400);
  expect(main.body.error).toContain("main profile");
  const removed = await json(
    await s.call("/internal/profiles/" + shop.id, "DELETE"),
  );
  expect(removed.body).toEqual({ success: true, unlinked: true });
  expect(loggedOut).toBe(true);
  expect(s.destroyed).toEqual([shop.id]);
  expect(s.profiles.get(shop.id)).toBeUndefined();
  expect((await s.call("/internal/snapshot?profile=" + shop.id)).status).toBe(
    404,
  );
  expect(s.keys.authenticate(only.key)).toBeNull();
  expect(s.keys.access(both.key)!.profiles).toEqual(["default"]);
  expect((await s.call("/internal/profiles/" + shop.id, "DELETE")).status).toBe(
    400,
  );
});
test("removal goes ahead when unlinking from the phone does not answer", async () => {
  const s = open();
  const shop = await addProfile(s);
  s.providers.get(shop.id)!.logout = () => new Promise(() => {});
  const removed = await json(
    await s.call("/internal/profiles/" + shop.id, "DELETE"),
  );
  expect(removed.body).toEqual({ success: true, unlinked: false });
  expect(s.profiles.list()).toHaveLength(1);
});
test("the linked number is remembered, and a number linked twice is flagged", async () => {
  const s = open();
  const shop = await addProfile(s);
  const account = "60123450000@s.whatsapp.net";
  s.profiles.main().events.publish("messaging.connection", {
    status: "connected",
    account,
  });
  expect(s.profiles.describe("default")!.account).toBe(account);
  // Disconnected profiles still show the number they last linked.
  s.provider.state = { status: "disconnected" };
  expect(s.profiles.describe("default")!.account).toBe(account);
  s.profiles.get(shop.id)!.events.publish("messaging.connection", {
    status: "connected",
    account,
  });
  const snapshot = (
    await json(await s.call("/internal/snapshot?profile=" + shop.id))
  ).body;
  expect(snapshot.alerts.at(-1).error).toContain("“Main” profile");
  // The warning belongs to the profile that linked the number second.
  const main = (await json(await s.call("/internal/snapshot"))).body;
  expect(main.alerts).toEqual([]);
});
test("a profile whose data cannot open is listed with an error and the rest run", () => {
  const db = openDatabase(":memory:");
  const settings = new Settings(db);
  db.query(
    "INSERT INTO profiles(id,name,created_at) VALUES('p_broken','Broken',1)",
  ).run();
  db.query(
    "INSERT INTO profiles(id,name,created_at) VALUES('p_good','Good',2)",
  ).run();
  const started: string[] = [];
  const profiles = new ProfileManager(db, {
    open: (id) => {
      if (id === "p_broken") throw new Error("disk");
      return openDatabase(":memory:");
    },
    destroy: () => {},
    log: () => {},
    runtime: (id, profileDb) => {
      const runtime = new ProfileRuntime({
        id,
        db: profileDb,
        ai: { generate: async () => "" },
        aiSettings: settings,
        log: () => {},
        provider: () => new FakeProvider(),
      });
      const start = runtime.start.bind(runtime);
      runtime.start = () => {
        started.push(id);
        start();
      };
      return runtime;
    },
  });
  profiles.load();
  expect(started).toEqual([]);
  profiles.start();
  expect(started).toEqual(["default", "p_good"]);
  const broken = profiles.describe("p_broken")!;
  expect(broken.error).toContain("could not be opened");
  expect(profiles.get("p_broken")).toBeUndefined();
  expect(profiles.get("p_good")).toBeDefined();
  void profiles.close();
  db.close();
});
test("profiles share one vault key but keep their WhatsApp sessions apart", () => {
  const mainDb = openDatabase(":memory:"),
    shopDb = openDatabase(":memory:");
  const main = new Vault(mainDb, Buffer.alloc(32, 3));
  const shop = main.forDatabase(shopDb);
  createAuth(main).saveCreds();
  expect(shop.get("wa:creds")).toBeNull();
  const auth = createAuth(shop);
  auth.state.creds.registered = true;
  auth.saveCreds();
  expect(createAuth(shop).state.creds.registered).toBe(true);
  expect(createAuth(main).state.creds.registered).toBe(false);
  shop.clearPrefix("wa:");
  expect(main.get("wa:creds")).not.toBeNull();
  mainDb.close();
  shopDb.close();
});
