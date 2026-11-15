import { test, expect } from "bun:test";
import { WAMessageStubType, type WAMessage } from "@whiskeysockets/baileys";
import { normalizeMessage } from "../src/messaging/baileys/normalizer";
import { setup, incoming, chatId } from "./helpers";
const group = "120363000000000001@g.us";
const me = "60111111111@s.whatsapp.net";
const stub = (type: number, params: string[], participant?: string, id = "EVT" + type): WAMessage => ({
  key: { remoteJid: group, id, fromMe: false, ...(participant ? { participant } : {}) },
  messageTimestamp: 1_757_000_000,
  messageStubType: type,
  messageStubParameters: params,
});
test("group events become system messages that name people as mentions", () => {
  const T = WAMessageStubType;
  const added = normalizeMessage(
    stub(
      T.GROUP_PARTICIPANT_ADD,
      [
        // Baileys names each person with both ids; the phone number is kept.
        JSON.stringify({ id: "111222333@lid", phoneNumber: "60122222222@s.whatsapp.net" }),
        "60133333333@s.whatsapp.net",
      ],
      "60144444444@s.whatsapp.net",
    ),
    { id: me },
  )!;
  expect(added).toMatchObject({
    type: "system",
    chatId: group,
    direction: "incoming",
    senderId: "60144444444@s.whatsapp.net",
    text: "@60144444444 added @60122222222 and @60133333333",
  });
  expect(added.mentions!.map((m) => m.id)).toEqual([
    "60144444444@s.whatsapp.net",
    "60122222222@s.whatsapp.net",
    "60133333333@s.whatsapp.net",
  ]);
  const text = (type: number, params: string[], participant?: string) =>
    normalizeMessage(stub(type, params, participant), { id: me })?.text;
  // Someone who adds themselves joined; removing yourself is leaving.
  expect(text(T.GROUP_PARTICIPANT_ADD, ["60122222222@s.whatsapp.net"], "60122222222@s.whatsapp.net")).toBe(
    "@60122222222 joined",
  );
  expect(text(T.GROUP_PARTICIPANT_LEAVE, ["60122222222@s.whatsapp.net"])).toBe("@60122222222 left");
  expect(text(T.GROUP_PARTICIPANT_REMOVE, [me], "60144444444@s.whatsapp.net")).toBe("@60144444444 removed You");
  expect(text(T.GROUP_PARTICIPANT_PROMOTE, [me])).toBe("You are now an admin");
  expect(text(T.GROUP_PARTICIPANT_DEMOTE, ["60122222222@s.whatsapp.net"])).toBe(
    "@60122222222 is no longer an admin",
  );
  expect(text(T.GROUP_CHANGE_SUBJECT, ["Launch crew"], "60144444444@s.whatsapp.net")).toBe(
    "@60144444444 changed the group name to “Launch crew”",
  );
  expect(text(T.GROUP_CHANGE_ANNOUNCE, ["on"])).toBe("Only admins can send messages now");
  // An event with nobody to name, or one Wagate does not describe, is left out.
  expect(text(T.GROUP_PARTICIPANT_ADD, [])).toBeUndefined();
  expect(text(T.CIPHERTEXT, [])).toBeUndefined();
  // Outside a group a stub is not a group event.
  expect(
    normalizeMessage({ ...stub(T.GROUP_PARTICIPANT_LEAVE, [me]), key: { remoteJid: me, id: "X" } }, { id: me }),
  ).toBeNull();
});
test("a group event is stored and shown without counting as unread or as the chat's last message", () => {
  const s = setup();
  s.sender.receive({ ...incoming("hello", "Hello all"), chatId: group, senderId: "60122222222@s.whatsapp.net" }, true);
  const event = normalizeMessage(
    stub(WAMessageStubType.GROUP_PARTICIPANT_LEAVE, ["60122222222@s.whatsapp.net"]),
    { id: me },
  )!;
  event.timestamp = Date.now() + 1000;
  expect(s.sender.receive(event, true)).toBe(true);
  const chat = s.chats.get(group)!;
  expect(chat.unreadCount).toBe(1);
  expect(chat.lastMessage).toBe("Hello all");
  const page = s.messages.page(group).messages;
  expect(page.at(-1)).toMatchObject({ type: "system", text: "@60122222222 left" });
  expect(page.at(-1)!.mentions).toEqual([{ id: "60122222222@s.whatsapp.net", name: null }]);
  s.close();
});
test("message search finds text across chats, newest first, with its place in the chat", async () => {
  const s = setup();
  const at = Date.now();
  const add = (id: string, text: string, chatId: string, ago: number) =>
    s.sender.receive({ ...incoming(id, text), chatId, timestamp: at - ago }, false);
  const other = "60199999999@s.whatsapp.net";
  add("a", "The invoice is ready for you", other, 5000);
  add("b", "Lunch tomorrow?", other, 4000);
  add("c", "Please resend the INVOICE, 100% urgent", group, 3000);
  add("d", "ok", group, 2000);
  add("e", "thanks", group, 1000);
  const hits = s.messages.search("invoice");
  expect(hits.map((h) => [h.id, h.chatId, h.position])).toEqual([
    ["c", group, 3],
    ["a", other, 2],
  ]);
  expect(hits[0]!.snippet).toBe("Please resend the INVOICE, 100% urgent");
  // % and _ are searched for as typed, not as wildcards.
  expect(s.messages.search("100%").map((h) => h.id)).toEqual(["c"]);
  expect(s.messages.search("1_0")).toEqual([]);
  expect(s.messages.search("  ")).toEqual([]);
  const res = await s.call("/internal/search?q=lunch");
  expect(((await res.json()) as { results: { id: string }[] }).results.map((r) => r.id)).toEqual(["b"]);
  expect((await s.call("/internal/search?q=l")).status).toBe(400);
  const key = s.keys.create("read", ["messages.read", "chats.read"]);
  expect((await s.call("/internal/search?q=lunch", "GET", undefined, key.key)).status).toBe(403);
  s.close();
});
test("profile pictures are looked up once for chats the app shows, then served from storage", async () => {
  const s = setup();
  s.sender.receive(incoming(), false);
  const other = "60199999999@s.whatsapp.net";
  const path = (id: string) => "/internal/chats/" + encodeURIComponent(id) + "/avatar";
  const data = async (id: string) => ((await (await s.call(path(id))).json()) as { data: string | null }).data;
  const settle = () => new Promise((r) => setTimeout(r, 30));
  s.provider.pictures.set(chatId, new Uint8Array([1, 2, 3]));
  // The first request has nothing stored and starts the lookups.
  expect(await data(chatId)).toBeNull();
  expect(await data(other)).toBeNull();
  expect(s.chats.get(chatId)!.avatar).toBeNull();
  await settle();
  expect(s.provider.pictureCalls).toEqual([chatId, other]);
  expect(await data(chatId)).toBe(Buffer.from([1, 2, 3]).toString("base64"));
  expect(typeof s.chats.get(chatId)!.avatar).toBe("number");
  // "No picture" is remembered too, so nothing is asked again.
  expect(await data(other)).toBeNull();
  await settle();
  expect(s.provider.pictureCalls).toHaveLength(2);
  // A failed lookup is not retried straight away, and nothing is asked while disconnected.
  const third = "60188888888@s.whatsapp.net";
  s.provider.pictureError = new Error("timeout");
  await data(third);
  await settle();
  await data(third);
  await settle();
  expect(s.provider.pictureCalls).toHaveLength(3);
  s.provider.pictureError = null;
  s.provider.state = { status: "disconnected" };
  await data("60177777777@s.whatsapp.net");
  await settle();
  expect(s.provider.pictureCalls).toHaveLength(3);
  const key = s.keys.create("read", ["chats.read"]);
  expect((await s.call(path(chatId), "GET", undefined, key.key)).status).toBe(403);
  s.close();
});
test("presence is shared only while a chat is open, and shows who is online or typing", async () => {
  const s = setup();
  s.sender.receive(incoming(), false);
  const presence = s.profiles.main().presence;
  const path = "/internal/chats/" + encodeURIComponent(chatId) + "/presence";
  const snapshot = async (id: string) =>
    ((await (await s.call("/internal/snapshot?chatId=" + encodeURIComponent(id))).json()) as {
      presence: { online: boolean; typing: { id: string; name: string | null; state: string }[] };
    }).presence;
  // Typing is not sent before the chat is open in front of the person.
  await s.call(path, "POST", { state: "composing" });
  expect(s.provider.presences).toEqual([]);
  expect((await s.call(path, "POST", { state: "busy" })).status).toBe(400);
  await s.call(path, "POST", { state: "open" });
  await s.call(path, "POST", { state: "open" });
  expect(s.provider.presences).toEqual([{ state: "available" }]);
  expect(s.provider.watched).toEqual([chatId]);
  await s.call(path, "POST", { state: "composing" });
  expect(s.provider.presences.at(-1)).toEqual({ state: "composing", chatId });
  expect(await snapshot(chatId)).toEqual({ online: false, typing: [] });
  presence.apply({ chatId, participant: chatId, state: "available" });
  expect(await snapshot(chatId)).toEqual({ online: true, typing: [] });
  presence.apply({ chatId, participant: chatId, state: "composing" });
  expect(await snapshot(chatId)).toEqual({
    online: true,
    typing: [{ id: chatId, name: null, state: "composing" }],
  });
  presence.apply({ chatId, participant: chatId, state: "unavailable" });
  expect(await snapshot(chatId)).toEqual({ online: false, typing: [] });
  // In a group, people are named and nobody is "online".
  const member = "60122222222@s.whatsapp.net";
  s.profiles.main().contacts.save([{ id: member, name: "Nadia" }]);
  presence.apply({ chatId: group, participant: member, state: "recording" });
  expect(await snapshot(group)).toEqual({
    online: false,
    typing: [{ id: member, name: "Nadia", state: "recording" }],
  });
  // Leaving goes offline and forgets what was seen.
  await s.call("/internal/presence/away", "POST");
  expect(s.provider.presences.at(-1)).toEqual({ state: "unavailable" });
  expect(await snapshot(group)).toEqual({ online: false, typing: [] });
  // With presence turned off nothing is sent at all.
  const sent = s.provider.presences.length;
  await s.call("/internal/preferences", "PUT", { presence: false });
  expect(await (await s.call(path, "POST", { state: "open" })).json()).toEqual({ success: true, active: false });
  expect(s.provider.presences).toHaveLength(sent);
  s.close();
});
