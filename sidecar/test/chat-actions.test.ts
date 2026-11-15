import { expect, test } from "bun:test";
import { pagePreview, privateAddress } from "../src/messages/link-preview";
import { normalizeMessage } from "../src/messaging/baileys/normalizer";
import type { Chat, GroupMember, Message } from "../src/messaging/types";
import { chatId, incoming, setup } from "./helpers";
const group = "120363000000000001@g.us";
const path = (id: string, rest = "") => `/internal/chats/${encodeURIComponent(id)}${rest}`;
const json = async <T>(response: Response | Promise<Response>) => (await (await response).json()) as T;
test("muting, archiving and marking unread go to WhatsApp before they are stored", async () => {
  const s = setup();
  s.sender.receive({ ...incoming("one", "Hello") }, true);
  await s.sender.markRead(chatId);
  const before = Date.now();

  let chat = await json<Chat>(s.call(path(chatId, "/mute"), "PUT", { mute: "8h" }));
  expect(chat.muted).toBe(true);
  const mute = s.provider.chatChanges[0]!.change as { mute: number };
  expect(mute.mute).toBeGreaterThanOrEqual(before + 8 * 3600_000);
  chat = await json<Chat>(s.call(path(chatId, "/mute"), "PUT", { mute: "always" }));
  expect(chat.muted).toBe(true);
  expect(s.provider.chatChanges[1]!.change).toEqual({ mute: -1 });
  chat = await json<Chat>(s.call(path(chatId, "/mute"), "PUT", { mute: "off" }));
  expect(chat.muted).toBe(false);
  expect((await s.call(path(chatId, "/mute"), "PUT", { mute: "2h" })).status).toBe(400);

  chat = await json<Chat>(s.call(path(chatId, "/archive"), "PUT", { archived: true }));
  expect(chat.archived).toBe(true);
  const archive = s.provider.chatChanges.at(-1)!;
  expect(archive.change).toEqual({ archive: true });
  // WhatsApp is told which message was the chat's last.
  expect(archive.last?.providerMessageId).toBe("one");
  chat = await json<Chat>(s.call(path(chatId, "/archive"), "PUT", { archived: false }));
  expect(chat.archived).toBe(false);

  chat = await json<Chat>(s.call(path(chatId, "/unread"), "POST"));
  expect(chat.unreadCount).toBe(1);
  expect(s.provider.chatChanges.at(-1)!.change).toEqual({ read: false });

  // A change WhatsApp refuses is not stored.
  s.provider.chatChangeError = new Error("WhatsApp refused");
  expect((await s.call(path(chatId, "/archive"), "PUT", { archived: true })).ok).toBe(false);
  expect(s.chats.get(chatId)!.archived).toBe(false);
  s.provider.chatChangeError = null;
  s.provider.state = { status: "disconnected" };
  const offline = await s.call(path(chatId, "/mute"), "PUT", { mute: "1w" });
  expect(offline.ok).toBe(false);
  expect(((await offline.json()) as { error: string }).error).toContain("disconnected");
  s.close();
});
test("deleting a chat removes its messages and takes it off the list until a new message", async () => {
  const s = setup();
  s.sender.receive({ ...incoming("one", "Hello") }, true);
  s.sender.receive({ ...incoming("two", "Again"), mediaSource: new Uint8Array([1]) }, true);
  s.messages.cacheMedia("two", "image/jpeg", new Uint8Array([1, 2]));
  s.sender.reaction({ providerMessageId: "one", senderId: chatId, emoji: "👍", timestamp: Date.now() });
  s.chats.setPinned(chatId, true);

  expect((await s.call(path(chatId), "DELETE")).status).toBe(200);
  expect(s.provider.chatChanges.at(-1)!.change).toEqual({ delete: true });
  expect(s.chats.list()).toEqual([]);
  expect(s.messages.page(chatId).messages).toEqual([]);
  const count = (table: string) =>
    (s.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  expect(count("media_cache") + count("reactions") + count("messages")).toBe(0);

  s.sender.receive({ ...incoming("three", "Back") }, true);
  const [chat] = s.chats.list();
  expect(chat).toMatchObject({ id: chatId, pinned: false, unreadCount: 1 });
  expect(s.messages.page(chatId).messages.map((m) => m.text)).toEqual(["Back"]);
  expect((await s.call(path("60111111111@s.whatsapp.net"), "DELETE")).ok).toBe(false);
  s.close();
});
test("blocking follows WhatsApp's list, under either of a person's ids", async () => {
  const s = setup();
  s.sender.receive({ ...incoming("one", "Hello") }, true);
  s.sender.receive({ ...incoming("g1", "Hi all"), chatId: group }, true);

  let chat = await json<Chat>(s.call(path(chatId, "/block"), "PUT", { blocked: true }));
  expect(chat.blocked).toBe(true);
  expect(s.provider.blocks).toEqual([{ chatId, blocked: true }]);
  chat = await json<Chat>(s.call(path(chatId, "/block"), "PUT", { blocked: false }));
  expect(chat.blocked).toBe(false);
  expect((await s.call(path(group, "/block"), "PUT", { blocked: true })).ok).toBe(false);

  // WhatsApp names blocked people by LID; the chat is known by phone number.
  const lid = "111222333444@lid";
  s.contacts.linkPhones([{ lid, phone: chatId }]);
  const main = s.profiles.main();
  main.chatActions.blocked([lid], "set");
  expect(s.chats.get(chatId)!.blocked).toBe(true);
  main.chatActions.blocked([chatId], "remove");
  expect(s.chats.get(chatId)!.blocked).toBe(false);
  main.chatActions.blocked([lid], "add");
  main.chatActions.blocked([], "set");
  expect(s.chats.get(chatId)!.blocked).toBe(false);
  s.close();
});
test("a send names only the people its text mentions", async () => {
  const s = setup();
  const ali = "60111111111@s.whatsapp.net",
    siti = "222333444555@lid";
  s.contacts.save([{ id: ali, name: "Ali" }]);
  const sent = await json<{ message: Message }>(
    s.call("/v1/messages/send", "POST", {
      chatId: group,
      text: "Thanks @60111111111 and @222333444555!",
      mentions: [ali, siti, "60999999999@s.whatsapp.net"],
    }),
  );
  expect(s.provider.extras.at(-1)!.mentions).toEqual([ali, siti]);
  expect(sent.message.mentions).toEqual([
    { id: ali, name: "Ali" },
    { id: siti, name: null },
  ]);
  const bad = await s.call("/v1/messages/send", "POST", {
    chatId: group,
    text: "Hi @abc",
    mentions: ["abc"],
  });
  expect(bad.status).toBe(400);
  // A caption can mention people too.
  await s.call("/v1/messages/send-media", "POST", {
    chatId: group,
    data: Buffer.from("x").toString("base64"),
    mimetype: "image/png",
    caption: "For @60111111111",
    mentions: [ali],
  });
  expect(s.provider.extras.at(-1)!.mentions).toEqual([ali]);
  s.close();
});
test("group members come with the names this device knows", async () => {
  const s = setup();
  const lid = "222333444555@lid",
    phone = "60122222222@s.whatsapp.net";
  s.provider.members = [
    { id: lid, phone: null, admin: true },
    { id: "60111111111@s.whatsapp.net", phone: "60111111111@s.whatsapp.net", admin: false },
    { id: "999888777666@lid", phone: null, admin: false },
  ];
  s.contacts.linkPhones([{ lid, phone }]);
  s.contacts.save([{ id: phone, name: "Siti" }, { id: "60111111111@s.whatsapp.net", pushName: "ali" }]);
  const { members } = await json<{ members: GroupMember[] }>(
    s.call(`/internal/groups/${encodeURIComponent(group)}/members`),
  );
  expect(members).toEqual([
    { id: "60111111111@s.whatsapp.net", phone: "60111111111@s.whatsapp.net", admin: false, name: "ali" },
    { id: lid, phone, admin: true, name: "Siti" },
    { id: "999888777666@lid", phone: null, admin: false, name: null },
  ]);
  expect((await s.call(`/internal/groups/${encodeURIComponent(chatId)}/members`)).ok).toBe(false);
  s.close();
});
test("a voice message is sent as one, with its length", async () => {
  const s = setup();
  const res = await s.call("/v1/messages/send-media", "POST", {
    chatId,
    data: Buffer.from("audio").toString("base64"),
    mimetype: "audio/mp4",
    voice: true,
    seconds: 4.2,
  });
  expect(res.status).toBe(200);
  expect(s.provider.media.at(-1)).toMatchObject({ voice: true, seconds: 4.2, mimetype: "audio/mp4" });
  const message = ((await res.json()) as { message: Message }).message;
  expect(message.media?.ptt).toBe(true);
  const wrong = await s.call("/v1/messages/send-media", "POST", {
    chatId,
    data: Buffer.from("x").toString("base64"),
    mimetype: "image/png",
    voice: true,
  });
  expect(wrong.status).toBe(400);
  s.close();
});
const page = (head: string, type = "text/html; charset=utf-8") => () =>
  new Response(`<html><head>${head}</head><body></body></html>`, { headers: { "Content-Type": type } });
test("a page describes itself for a link preview", async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
  const web = new Map<string, () => Response>([
    ["https://short.example/a", () => new Response(null, { status: 302, headers: { Location: "https://example.com/post" } })],
    [
      "https://example.com/post",
      page(`<title>Fallback</title>
        <meta property="og:title" content="Tom &amp; Jerry&#39;s &#x1F600;">
        <meta content='A   long
          description' name="description">
        <meta property="og:image" content="/cover.jpg">`),
    ],
    ["https://example.com/cover.jpg", () => new Response(jpeg, { headers: { "Content-Type": "image/jpeg" } })],
    ["https://example.com/plain", page("<title>Only a title</title>")],
    ["https://example.com/file.pdf", page("<title>No</title>", "application/pdf")],
    ["https://example.com/inward", () => new Response(null, { status: 301, headers: { Location: "http://127.0.0.1:8787/health" } })],
  ]);
  const fetched: string[] = [];
  const options = {
    fetch: async (url: string) => (fetched.push(url), web.get(url)?.() ?? new Response("", { status: 404 })),
    resolve: async (host: string) => (host === "inside.example" ? ["10.0.0.5"] : ["93.184.216.34"]),
  };
  expect(await pagePreview("https://short.example/a", options)).toEqual({
    url: "https://short.example/a",
    title: "Tom & Jerry's 😀",
    description: "A long description",
    image: { mimetype: "image/jpeg", data: jpeg },
  });
  expect(await pagePreview("https://example.com/plain", options)).toEqual({
    url: "https://example.com/plain",
    title: "Only a title",
  });
  expect(await pagePreview("https://example.com/file.pdf", options)).toBeNull();
  expect(await pagePreview("https://example.com/missing", options)).toBeNull();
  // Nothing on this computer or its network is ever asked.
  fetched.length = 0;
  for (const inward of [
    "http://localhost:8787/health",
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://192.168.1.1/",
    "http://inside.example/",
    "http://printer.local/",
    "file:///etc/passwd",
    "https://user:pass@example.com/",
  ])
    expect(await pagePreview(inward, options)).toBeNull();
  expect(fetched).toEqual([]);
  expect(await pagePreview("https://example.com/inward", options)).toBeNull();
  expect(fetched).toEqual(["https://example.com/inward"]);
  expect(["10.1.2.3", "172.20.0.1", "169.254.1.1", "100.64.0.1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"].every(privateAddress)).toBe(true);
  expect(["8.8.8.8", "172.32.0.1", "2606:4700::1111"].some(privateAddress)).toBe(false);
});
test("a link preview is looked up once, sent with the text and kept with the message", async () => {
  const s = setup();
  const url = "https://example.com/post";
  s.web.set(url, page(`<meta property="og:title" content="A post">`));
  const lookup = () =>
    json<{ preview: { title: string; image: unknown } | null }>(
      s.call("/internal/link-preview?url=" + encodeURIComponent(url)),
    );
  expect((await lookup()).preview).toMatchObject({ url, title: "A post", image: null });
  await lookup();
  expect(s.fetched).toEqual([url]);

  const thumbnail = Buffer.from([0xff, 0xd8, 0xff, 9, 9]);
  const send = (text: string, linkPreview: unknown) =>
    s.call("/v1/messages/send", "POST", { chatId, text, linkPreview });
  const res = await send(`Read ${url} today`, { url, title: "A post", thumbnail: thumbnail.toString("base64") });
  expect(res.status).toBe(200);
  const message = ((await res.json()) as { message: Message }).message;
  expect(message.media?.link).toEqual({ url, title: "A post", image: true });
  expect(s.provider.extras.at(-1)!.link).toMatchObject({ url, title: "A post" });
  // The stored picture never travels with the message itself.
  expect(JSON.stringify(message)).not.toContain("linkThumbnail");
  const picture = await json<{ data: string; mimetype: string }>(
    s.call(`/internal/messages/${encodeURIComponent(message.id)}/media?preview=1`),
  );
  expect(Buffer.from(picture.data, "base64")).toEqual(thumbnail);

  expect((await send("No link here", { url, title: "A post" })).status).toBe(400);
  expect((await send(`Read ${url}`, { url, title: "A post", thumbnail: Buffer.from("png").toString("base64") })).status).toBe(400);

  // Turned off, nothing is fetched.
  await s.call("/internal/preferences", "PUT", { links: false });
  s.web.set("https://example.com/other", page("<title>Other</title>"));
  expect(
    (await json<{ preview: unknown }>(s.call("/internal/link-preview?url=" + encodeURIComponent("https://example.com/other")))).preview,
  ).toBeNull();
  expect(s.fetched).toEqual([url]);
  s.close();
});
test("a received link preview is kept with its message, the picture apart", () => {
  const raw = (extendedTextMessage: Record<string, unknown>) =>
    ({
      key: { remoteJid: chatId, id: "L1", fromMe: false },
      messageTimestamp: 1_700_000_000,
      message: { extendedTextMessage },
    }) as Parameters<typeof normalizeMessage>[0];
  const url = "https://example.com/post";
  const jpegThumbnail = new Uint8Array([0xff, 0xd8, 0xff, 7]);
  const message = normalizeMessage(
    raw({ text: `See ${url}`, matchedText: url, title: "A post", description: "About it", jpegThumbnail }),
  )!;
  expect(message.type).toBe("text");
  expect(message.media).toEqual({ link: { url, title: "A post", description: "About it", image: true } });
  expect(message.linkThumbnail).toEqual(jpegThumbnail);
  // A preview for a link the text does not contain is not trusted.
  expect(normalizeMessage(raw({ text: "See nothing", matchedText: url, title: "A post" }))!.media).toBeUndefined();
  expect(normalizeMessage(raw({ text: `See ${url}`, matchedText: url }))!.media).toBeUndefined();
  expect(normalizeMessage(raw({ text: "x javascript:alert(1)", matchedText: "javascript:alert(1)", title: "t" }))!.media).toBeUndefined();
});
