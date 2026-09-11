import { test, expect } from "bun:test";
import { setup } from "./helpers";
import { normalizeChat } from "../src/messaging/baileys/normalizer";
const id = (n: number) => `6012000000${n}@s.whatsapp.net`;
const seen = (s: ReturnType<typeof setup>, n: number, at: number) =>
  s.chats.apply({ id: id(n), type: "direct", lastMessageAt: at });
test("account sync never adds chats it cannot place; it only updates known ones", () => {
  const s = setup();
  // An archive, mute, pin or read marker for a chat with no known activity.
  expect(s.chats.apply({ id: id(1), type: "direct", archived: true })).toBe(false);
  expect(s.chats.apply({ id: id(1), type: "direct", pinnedAt: 5 })).toBe(false);
  expect(s.chats.get(id(1))).toBeNull();
  expect(seen(s, 1, 1000)).toBe(true);
  expect(s.chats.apply({ id: id(1), type: "direct", archived: true })).toBe(true);
  expect(s.chats.get(id(1))).toMatchObject({
    lastMessageAt: 1000,
    archived: true,
    pinned: false,
  });
  // Older activity never moves a chat back in time.
  seen(s, 1, 10);
  expect(s.chats.get(id(1))!.lastMessageAt).toBe(1000);
  s.close();
});
test("the inbox follows WhatsApp: pinned first, then by activity, archived last", () => {
  const s = setup();
  seen(s, 1, 1000);
  seen(s, 2, 5000);
  seen(s, 3, 3000);
  seen(s, 4, 9000);
  seen(s, 5, 2000);
  s.chats.apply({ id: id(3), type: "direct", pinnedAt: 100 });
  s.chats.apply({ id: id(1), type: "direct", pinnedAt: 200 });
  s.chats.apply({ id: id(4), type: "direct", archived: true });
  // Chats known only by id, with no activity, stay out of the list.
  s.chats.upsert({
    id: id(6),
    provider: "whatsapp",
    name: id(6),
    type: "direct",
    lastMessageAt: null,
  });
  const order = () => s.chats.list().map((c) => c.id);
  expect(order()).toEqual([id(1), id(3), id(2), id(5), id(4)]);
  // Unpinning and unarchiving put chats back in activity order.
  s.chats.apply({ id: id(1), type: "direct", pinnedAt: null });
  s.chats.apply({ id: id(4), type: "direct", archived: false });
  expect(order()).toEqual([id(3), id(4), id(2), id(5), id(1)]);
  // A new message moves a chat to the top of the unpinned chats.
  s.sender.receive(
    {
      id: "m",
      provider: "whatsapp",
      providerMessageId: "m",
      chatId: id(5),
      senderId: id(5),
      direction: "incoming",
      type: "text",
      text: "hi",
      timestamp: 20000,
    },
    true,
  );
  expect(order()).toEqual([id(3), id(5), id(4), id(2), id(1)]);
  s.close();
});
test("chat events take the latest of WhatsApp's timestamps and normalise pins", () => {
  // History entries may have only lastMsgTimestamp, sometimes as a Long.
  expect(
    normalizeChat({
      id: "111222333@lid",
      conversationTimestamp: null,
      // A protobuf Long, as history sync delivers it.
      lastMsgTimestamp: { toNumber: () => 1_757_000_000 },
    }),
  ).toEqual({
    id: "111222333@lid",
    type: "direct",
    lastMessageAt: 1_757_000_000_000,
  });
  expect(
    normalizeChat({
      id: "120363000000000000@g.us",
      name: "Launch crew",
      conversationTimestamp: 1_757_000_100,
      lastMessageRecvTimestamp: 1_757_000_050,
      pinned: 1_757_000_000,
      archived: false,
    }),
  ).toEqual({
    id: "120363000000000000@g.us",
    type: "group",
    name: "Launch crew",
    lastMessageAt: 1_757_000_100_000,
    pinnedAt: 1_757_000_000_000,
    archived: false,
  });
  // Account-sync pins are already in milliseconds; an unpin is null.
  expect(normalizeChat({ id: id(1), pinned: 1_757_000_000_123 })).toMatchObject({
    pinnedAt: 1_757_000_000_123,
  });
  expect(normalizeChat({ id: id(1), pinned: null })).toMatchObject({
    pinnedAt: null,
  });
  expect(normalizeChat({ id: id(1), archived: null })).toEqual({
    id: id(1),
    type: "direct",
  });
  expect(normalizeChat({ id: "status@broadcast" })).toBeNull();
});
