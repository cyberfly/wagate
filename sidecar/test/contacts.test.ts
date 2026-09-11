import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup } from "./helpers";
import { normalizeContacts } from "../src/messaging/baileys/normalizer";
import { openDatabase } from "../src/db/database";
import { migrations } from "../src/db/schema";
import { ChatRepository } from "../src/chats/chat-repository";
const direct = "60120000001@s.whatsapp.net";
const chat = (id: string, name = id) => ({
  id,
  provider: "whatsapp" as const,
  name,
  type: id.endsWith("@g.us") ? ("group" as const) : ("direct" as const),
  lastMessageAt: 1,
});
test("a chat shows the best name WhatsApp knows: saved, WhatsApp's, profile, then number", () => {
  const s = setup();
  const name = () => s.chats.get(direct)!.name;
  s.chats.upsert(chat(direct));
  expect(name()).toBe(direct);
  s.contacts.save([{ id: direct, pushName: "🌸 Ai" }]);
  expect(name()).toBe("🌸 Ai");
  s.chats.upsert(chat(direct, "Aina (WhatsApp)"));
  expect(name()).toBe("Aina (WhatsApp)");
  s.contacts.save([{ id: direct, name: "Aina — Studio" }]);
  expect(name()).toBe("Aina — Studio");
  // A later push name fills its own slot and never erases the saved name.
  s.contacts.save([{ id: direct, pushName: "Ai" }, { id: direct, name: "  " }]);
  expect(name()).toBe("Aina — Studio");
  expect(s.chats.list()[0].name).toBe("Aina — Studio");
  // Group subjects are the chat's own name and stay put.
  s.chats.upsert(chat("120363000000000000@g.us", "Launch crew"));
  expect(s.chats.get("120363000000000000@g.us")!.name).toBe("Launch crew");
  s.close();
});
test("contact sync names are stored under both the phone-number id and the LID", () => {
  expect(
    normalizeContacts([
      {
        id: "111222333@lid",
        lid: "111222333@lid",
        phoneNumber: "60120000001@s.whatsapp.net",
        name: " Aina ",
      },
      { id: "60120000002@s.whatsapp.net", notify: "Ben" },
      { id: "60120000003@s.whatsapp.net", verifiedName: "Chong Trading" },
      { id: "60120000004@s.whatsapp.net" },
      { id: "120363000000000000@g.us", name: "Group" },
      { id: "status@broadcast", notify: "Status" },
    ]),
  ).toEqual([
    { id: "111222333@lid", name: "Aina", pushName: undefined },
    { id: direct, name: "Aina", pushName: undefined },
    { id: "60120000002@s.whatsapp.net", name: undefined, pushName: "Ben" },
    {
      id: "60120000003@s.whatsapp.net",
      name: undefined,
      pushName: "Chong Trading",
    },
  ]);
});
test("a broadcast's CSV names never label chats", async () => {
  const s = setup();
  const b = s.broadcasts.create({
    name: "Launch",
    minDelay: 5,
    maxDelay: 10,
    recipients: [{ to: "60120000001", label: "Aina Salleh", text: "Hi" }],
  });
  for (let i = 0; i < 100 && !s.provider.sent.length; i++) await Bun.sleep(5);
  s.broadcasts.close();
  expect(s.broadcasts.get(b.id).recipients[0].label).toBe("Aina Salleh");
  expect(s.chats.get(direct)!.name).toBe(direct);
  s.close();
});
test("upgrading removes CSV names but keeps names from WhatsApp", () => {
  const dir = mkdtempSync(join(tmpdir(), "wagate-contacts-"));
  const path = join(dir, "wagate.sqlite");
  const old = new Database(path, { create: true });
  for (const step of migrations.slice(0, 5)) old.exec(step);
  old.exec(`
    INSERT INTO contacts(id,name,imported_name) VALUES
      ('${direct}',NULL,'Aina Salleh'),
      ('60120000002@s.whatsapp.net','Ben (saved)','Ben from CSV');
    INSERT INTO chats(id,provider,provider_chat_id,name,type,last_message_at,created_at,updated_at) VALUES
      ('${direct}','whatsapp','${direct}','${direct}','direct',1,1,1),
      ('60120000002@s.whatsapp.net','whatsapp','x','60120000002@s.whatsapp.net','direct',2,1,1);
  `);
  old.close();
  const db = openDatabase(path);
  const chats = new ChatRepository(db);
  expect(chats.get(direct)!.name).toBe(direct);
  expect(chats.get("60120000002@s.whatsapp.net")!.name).toBe("Ben (saved)");
  expect(db.query("SELECT COUNT(*) AS n FROM contacts").get()).toEqual({ n: 1 });
  expect(chats.get(direct)).toMatchObject({ pinned: false, archived: false });
  db.close();
  rmSync(dir, { recursive: true });
});
test("the chats API returns contact names", async () => {
  const s = setup();
  s.chats.upsert(chat(direct));
  s.contacts.save([{ id: direct, name: "Aina" }]);
  const key = s.keys.create("reader", ["chats.read"]);
  const { chats } = (await (
    await s.call("/v1/chats", "GET", undefined, key.key)
  ).json()) as { chats: { id: string; name: string }[] };
  expect(chats).toContainEqual(expect.objectContaining({ id: direct, name: "Aina" }));
  s.close();
});
