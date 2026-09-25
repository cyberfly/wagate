import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup } from "./helpers";
import {
  normalizeContacts,
  normalizeMessage,
  senderNames,
  phoneLinks,
  keyLinks,
} from "../src/messaging/baileys/normalizer";
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
test("group senders are named by phone number when WhatsApp gives one, with their push name", () => {
  const group = "120363000000000001@g.us";
  const raw = {
    key: {
      id: "g1",
      remoteJid: group,
      fromMe: false,
      participant: "106721380942046@lid",
      participantAlt: "60120000009@s.whatsapp.net",
    },
    pushName: "Hafiz",
    message: { conversation: "boleh je" },
    messageTimestamp: 1_700_000_000,
  };
  expect(normalizeMessage(raw)?.senderId).toBe("60120000009@s.whatsapp.net");
  // Without a phone number the LID stays the sender.
  expect(
    normalizeMessage({ ...raw, key: { ...raw.key, participantAlt: undefined } })
      ?.senderId,
  ).toBe("106721380942046@lid");
  expect(senderNames(raw)).toEqual([
    { id: "106721380942046@lid", pushName: "Hafiz" },
    { id: "60120000009@s.whatsapp.net", pushName: "Hafiz" },
  ]);
  expect(senderNames({ ...raw, key: { ...raw.key, fromMe: true } })).toEqual([]);
});
test("stored messages carry the sender's best name", async () => {
  const s = setup();
  const group = "120363000000000001@g.us";
  const message = (id: string, senderId: string) => ({
    id,
    provider: "whatsapp" as const,
    providerMessageId: id,
    chatId: group,
    senderId,
    direction: "incoming" as const,
    type: "text" as const,
    text: "hi",
    timestamp: Date.now(),
  });
  s.messages.save(message("a", "106721380942046@lid"));
  s.messages.save(message("b", direct));
  s.contacts.save([
    { id: "106721380942046@lid", pushName: "Hafiz" },
    { id: direct, name: "Aina — Studio", pushName: "Ai" },
  ]);
  expect(
    s.messages.page(group).messages.map((m) => [m.id, m.senderName]),
  ).toEqual([
    ["a", "Hafiz"],
    ["b", "Aina — Studio"],
  ]);
  const res = await s.call(
    `/v1/chats/${encodeURIComponent(group)}/messages`,
  );
  const body = (await res.json()) as { messages: { senderName: string }[] };
  expect(body.messages.map((m) => m.senderName)).toEqual(["Hafiz", "Aina — Studio"]);
});
test("LIDs are linked to phone numbers from contacts, members and message keys", () => {
  expect(
    phoneLinks([
      { id: "106721380942046@lid", phoneNumber: "60120000009@s.whatsapp.net" },
      { id: "60120000008@s.whatsapp.net", lid: "220409316274252@lid" },
      // Nothing to link: one side is missing.
      { id: "106386457382946@lid" },
    ]),
  ).toEqual([
    { lid: "106721380942046@lid", phone: "60120000009@s.whatsapp.net" },
    { lid: "220409316274252@lid", phone: "60120000008@s.whatsapp.net" },
  ]);
  expect(
    keyLinks({
      key: {
        remoteJid: "120363000000000001@g.us",
        participant: "106721380942046@lid",
        participantAlt: "60120000009@s.whatsapp.net",
      },
    }),
  ).toEqual([{ lid: "106721380942046@lid", phone: "60120000009@s.whatsapp.net" }]);
});
test("a LID sender shows the phone number and saved name behind it", () => {
  const s = setup();
  const group = "120363000000000001@g.us",
    lid = "106721380942046@lid",
    phone = "60120000009@s.whatsapp.net";
  s.messages.save({
    id: "old",
    provider: "whatsapp",
    providerMessageId: "old",
    chatId: group,
    senderId: lid,
    direction: "incoming",
    type: "text",
    text: "boleh je",
    timestamp: Date.now(),
  });
  const sender = () => {
    const [m] = s.messages.page(group).messages;
    return [m.senderName, m.senderPhone];
  };
  expect(sender()).toEqual([null, null]);
  s.contacts.linkPhones([{ lid, phone }]);
  expect(sender()).toEqual([null, phone]);
  s.contacts.save([{ id: lid, pushName: "Hafiz" }]);
  expect(sender()).toEqual(["Hafiz", phone]);
  // The name saved in your phone, stored under the number, wins.
  s.contacts.save([{ id: phone, name: "Hafiz UOB" }]);
  expect(sender()).toEqual(["Hafiz UOB", phone]);
});
test("synced group history takes its sender from the message, and repairs old rows", () => {
  const s = setup();
  const group = "120363000000000001@g.us";
  // History items carry the sender outside the key.
  const raw = {
    key: { id: "h1", remoteJid: group, fromMe: false },
    participant: "106721380942046@lid",
    pushName: "Hafiz",
    message: { conversation: "boleh je" },
    messageTimestamp: 1_700_000_000,
  };
  const message = normalizeMessage(raw)!;
  expect(message.senderId).toBe("106721380942046@lid");
  expect(senderNames(raw)).toEqual([
    { id: "106721380942046@lid", pushName: "Hafiz" },
  ]);
  // An earlier version stored it as sent by the group.
  expect(s.messages.save({ ...message, senderId: group })).toBe(true);
  expect(s.messages.save(message)).toBe(false);
  expect(s.messages.get(message.id)?.senderId).toBe("106721380942046@lid");
  // A known sender is never overwritten.
  expect(s.messages.save({ ...message, senderId: "60120000001@s.whatsapp.net" })).toBe(false);
  expect(s.messages.get(message.id)?.senderId).toBe("106721380942046@lid");
});
test("a group with senderless messages asks the phone to resend them, at most every ten minutes", async () => {
  const s = setup();
  const group = "120363000000000002@g.us";
  const save = (id: string, senderId: string, timestamp: number) =>
    s.messages.save({
      id,
      provider: "whatsapp",
      providerMessageId: id,
      chatId: group,
      senderId,
      direction: "incoming",
      type: "text",
      text: "hi",
      timestamp,
    });
  const repair = async () =>
    ((await (await s.call(`/internal/chats/${encodeURIComponent(group)}/repair-senders`, "POST")).json()) as {
      requested: boolean;
    }).requested;
  save("known", "106721380942046@lid", 1000);
  expect(await repair()).toBe(false);
  save("lost", group, 2000);
  save("newest", "106721380942046@lid", 3000);
  expect(await repair()).toBe(true);
  expect(s.provider.historyRequests).toEqual([
    { before: expect.objectContaining({ providerMessageId: "newest" }), count: 50 },
  ]);
  expect(await repair()).toBe(false);
  expect(s.provider.historyRequests).toHaveLength(1);
});
