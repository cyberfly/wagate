import { test, expect } from "bun:test";
import { normalizeChat, normalizeMessage } from "../src/messaging/baileys/normalizer";
import { setup, incoming, chatId } from "./helpers";
const live = (id: string, text = "hi") => ({ ...incoming("whatsapp:" + chatId + ":" + id, text), providerMessageId: id });
test("reads unread counts, forwards and mentions from WhatsApp", () => {
  // History states the count; live updates only say read (0) or marked unread (-1).
  expect(normalizeChat({ id: chatId, unreadCount: 4, conversationTimestamp: 1 }, true)?.unreadCount).toBe(4);
  expect(normalizeChat({ id: chatId, unreadCount: 1 })?.unreadCount).toBeUndefined();
  expect(normalizeChat({ id: chatId, unreadCount: 0 })?.unreadCount).toBe(0);
  expect(normalizeChat({ id: chatId, unreadCount: -1 })?.unreadCount).toBe(-1);
  const m = normalizeMessage({
    key: { id: "F", remoteJid: "120363000000000009@g.us", participant: "60111@s.whatsapp.net" },
    messageTimestamp: 1,
    message: {
      extendedTextMessage: {
        text: "@60222 see this",
        contextInfo: { isForwarded: true, forwardingScore: 1, mentionedJid: ["60222@s.whatsapp.net", "60222@s.whatsapp.net"] },
      },
    },
  });
  expect(m).toMatchObject({ forwarded: true, mentions: [{ id: "60222@s.whatsapp.net" }] });
});
test("counts live incoming messages as unread until read here, on the phone or by replying", async () => {
  const t = setup();
  try {
    t.sender.receive(live("A"), false);
    expect(t.chats.get(chatId)?.unreadCount).toBe(0);
    t.sender.receive(live("B"), true);
    t.sender.receive(live("C"), true);
    expect(t.chats.get(chatId)?.unreadCount).toBe(2);
    const res = await t.call(`/internal/chats/${encodeURIComponent(chatId)}/read`, "POST");
    expect(await res.json()).toEqual({ read: 2 });
    // Receipts go for the two newest incoming messages.
    expect(t.provider.read[0]?.map((m) => m.providerMessageId)).toEqual(["C", "B"]);
    expect(t.chats.get(chatId)?.unreadCount).toBe(0);
    t.sender.receive(live("D"), true);
    t.chats.apply({ id: chatId, type: "direct", unreadCount: 0 });
    expect(t.chats.get(chatId)?.unreadCount).toBe(0);
    t.chats.apply({ id: chatId, type: "direct", unreadCount: -1 });
    expect(t.chats.get(chatId)?.unreadCount).toBe(1);
    await t.sender.send(chatId, "reply");
    expect(t.chats.get(chatId)?.unreadCount).toBe(0);
  } finally {
    t.close();
  }
});
test("edits and deletes our own messages within WhatsApp's limits", async () => {
  const t = setup();
  try {
    const sent = await t.sender.send(chatId, "Meet at 3");
    const edit = await t.call(`/v1/messages/${encodeURIComponent(sent.id)}`, "PUT", { text: "Meet at 4" });
    expect(((await edit.json()) as { message: { text: string; editedAt: number } }).message).toMatchObject({ text: "Meet at 4" });
    expect(t.provider.edits[0]).toMatchObject({ text: "Meet at 4" });
    // Others' messages, and old ones, are refused.
    t.sender.receive(live("THEIRS"), true);
    expect(t.sender.edit("whatsapp:" + chatId + ":THEIRS", "x")).rejects.toThrow("your own");
    t.db.query("UPDATE messages SET timestamp=? WHERE id=?").run(Date.now() - 20 * 60_000, sent.id);
    expect(t.sender.edit(sent.id, "late")).rejects.toThrow("too old");
    const del = await t.call(`/v1/messages/${encodeURIComponent(sent.id)}?for=everyone`, "DELETE");
    expect(del.status).toBe(200);
    expect(t.provider.revoked).toHaveLength(1);
    expect(t.messages.get(sent.id)?.deletedAt).toBeGreaterThan(0);
    // Delete for me removes any message locally, without telling WhatsApp.
    const mine = await t.call(`/v1/messages/${encodeURIComponent("whatsapp:" + chatId + ":THEIRS")}`, "DELETE");
    expect(mine.status).toBe(200);
    expect(t.messages.get("whatsapp:" + chatId + ":THEIRS")).toBeNull();
  } finally {
    t.close();
  }
});
test("forwards text and downloadable media to up to five chats", async () => {
  const t = setup();
  try {
    t.sender.receive(live("TXT", "Worth reading"), true);
    const res = await t.call(`/v1/messages/${encodeURIComponent("whatsapp:" + chatId + ":TXT")}/forward`, "POST", {
      chatIds: ["60111111111", "60222222222"],
    });
    const body = (await res.json()) as { messages: { chatId: string; forwarded: boolean }[] };
    expect(body.messages.map((m) => m.chatId)).toEqual(["60111111111@s.whatsapp.net", "60222222222@s.whatsapp.net"]);
    expect(body.messages[0]?.forwarded).toBe(true);
    const tooMany = await t.call(`/v1/messages/${encodeURIComponent("whatsapp:" + chatId + ":TXT")}/forward`, "POST", {
      chatIds: ["601", "602", "603", "604", "605", "606"].map((n) => n + "1111111"),
    });
    expect(tooMany.status).toBe(400);
    t.sender.receive({ ...live("PIC"), type: "image" }, true);
    expect(t.sender.forward("whatsapp:" + chatId + ":PIC", ["60111111111"])).rejects.toThrow("can’t be forwarded");
  } finally {
    t.close();
  }
});
test("keeps the media cache within its size limit, least recently used first", () => {
  const t = setup();
  try {
    for (const id of ["a", "b", "c"]) t.sender.receive(live(id), false);
    const bytes = new Uint8Array(400);
    t.messages.cacheMedia("whatsapp:" + chatId + ":a", "image/png", bytes, 1000);
    t.messages.cacheMedia("whatsapp:" + chatId + ":b", "image/png", bytes, 1000);
    // Reading "a" makes "b" the least recently used.
    t.db.query("UPDATE media_cache SET created_at=created_at-10").run();
    t.messages.cachedMedia("whatsapp:" + chatId + ":a");
    t.messages.cacheMedia("whatsapp:" + chatId + ":c", "image/png", bytes, 1000);
    expect(t.messages.cachedMedia("whatsapp:" + chatId + ":b")).toBeNull();
    expect(t.messages.cachedMedia("whatsapp:" + chatId + ":a")).not.toBeNull();
    expect(t.messages.cachedMedia("whatsapp:" + chatId + ":c")).not.toBeNull();
  } finally {
    t.close();
  }
});
