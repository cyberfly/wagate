import { test, expect } from "bun:test";
import { setup, incoming, chatId } from "./helpers";
import { normalizeChat } from "../src/messaging/baileys/normalizer";
/** Reads a server-sent event stream one event at a time. */
function reader(response: Response) {
  const body = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const seen: { event: string; data: any }[] = [];
  const next = async () => {
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const field = (name: string) =>
          block.split("\n").find((l) => l.startsWith(name + ":"))?.slice(name.length + 1).trim() ?? "";
        const event = { event: field("event"), data: JSON.parse(field("data") || "{}") };
        seen.push(event);
        return event;
      }
      const chunk = await body.read();
      if (chunk.done) throw new Error("stream ended");
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
  return {
    seen,
    /** The next event of this kind; earlier ones stay in `seen`. */
    async until(name: string) {
      for (;;) {
        const event = await next();
        if (event.event === name) return event.data;
      }
    },
    close: () => body.cancel(),
  };
}
test("mutes are read from WhatsApp, stored, and expire", () => {
  expect(normalizeChat({ id: chatId, muteEndTime: -1 })).toMatchObject({ mutedUntil: -1 });
  expect(normalizeChat({ id: chatId, muteEndTime: null })).toMatchObject({ mutedUntil: null });
  expect(normalizeChat({ id: chatId, muteEndTime: { toNumber: () => 0 } })).toMatchObject({
    mutedUntil: null,
  });
  expect(normalizeChat({ id: chatId, muteEndTime: 1_900_000_000 })).toMatchObject({
    mutedUntil: 1_900_000_000_000,
  });
  expect(normalizeChat({ id: chatId })).not.toHaveProperty("mutedUntil");
  const s = setup();
  s.sender.receive(incoming(), true);
  expect(s.chats.get(chatId)!.muted).toBe(false);
  expect(s.chats.unreadChats()).toBe(1);
  s.chats.apply({ id: chatId, type: "direct", mutedUntil: -1 });
  expect(s.chats.get(chatId)!.muted).toBe(true);
  expect(s.chats.unreadChats()).toBe(0);
  // A mute that already ended no longer counts.
  s.chats.apply({ id: chatId, type: "direct", mutedUntil: Date.now() - 1000 });
  expect(s.chats.get(chatId)!.muted).toBe(false);
  s.chats.apply({ id: chatId, type: "direct", mutedUntil: Date.now() + 60_000 });
  expect(s.chats.get(chatId)!.muted).toBe(true);
  s.chats.apply({ id: chatId, type: "direct", mutedUntil: null });
  expect(s.chats.get(chatId)!.muted).toBe(false);
  s.close();
});
test("the desktop stream reports changes, the unread badge and notifications", async () => {
  const s = setup();
  const key = s.keys.create("read", ["chats.read", "messages.read"]);
  expect((await s.call("/internal/events", "GET", undefined, key.key)).status).toBe(403);
  const stream = reader(await s.call("/internal/events"));
  expect(await stream.until("unread")).toEqual({ count: 0 });
  s.sender.receive(incoming("one", "Are you   free\ntomorrow?"), true);
  expect(await stream.until("notify")).toEqual({
    profile: "default",
    chatId,
    title: "+60123456789",
    body: "Are you free tomorrow?",
  });
  expect(await stream.until("changed")).toEqual({ profile: "default" });
  expect(await stream.until("unread")).toEqual({ count: 1 });
  // History sync and our own messages never notify.
  s.sender.receive(incoming("old"), false);
  await stream.until("changed");
  // A muted chat stays quiet and leaves the badge.
  s.chats.apply({ id: chatId, type: "direct", mutedUntil: -1 });
  s.sender.receive(incoming("m2"), true);
  expect(await stream.until("unread")).toEqual({ count: 0 });
  expect(stream.seen.filter((e) => e.event === "notify")).toHaveLength(1);
  s.chats.apply({ id: chatId, type: "direct", mutedUntil: null });
  // Previews can be hidden, and notifications turned off.
  expect((await s.call("/internal/preferences", "PUT", { preview: "no" })).status).toBe(400);
  expect(await (await s.call("/internal/preferences", "PUT", { preview: false })).json()).toEqual({
    notifications: true,
    preview: false,
    presence: true,
    links: true,
  });
  s.sender.receive(incoming("m3"), true);
  expect(await stream.until("notify")).toMatchObject({ body: "New message" });
  await s.call("/internal/preferences", "PUT", { notifications: false });
  s.sender.receive(incoming("m4"), true);
  await stream.until("changed");
  expect(stream.seen.filter((e) => e.event === "notify")).toHaveLength(2);
  await stream.close();
  s.close();
});
test("the terms are accepted once, from the desktop app only", async () => {
  const s = setup();
  const accepted = async () =>
    ((await (await s.call("/internal/snapshot")).json()) as { termsAccepted: boolean }).termsAccepted;
  expect(await accepted()).toBe(false);
  const key = s.keys.create("send", ["messages.send"]);
  expect((await s.call("/internal/terms/accept", "POST", undefined, key.key)).status).toBe(403);
  expect((await s.call("/internal/terms/accept", "POST")).status).toBe(200);
  expect(await accepted()).toBe(true);
  s.close();
});
