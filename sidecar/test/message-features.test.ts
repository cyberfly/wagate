import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WAMessageStatus, WAMessageStubType, proto } from "@whiskeysockets/baileys";
import {
  embeddedThumbnail,
  historyReactions,
  normalizeChange,
  normalizeMessage,
  normalizeReaction,
} from "../src/messaging/baileys/normalizer";
import { mediaFileName } from "../src/messages/message-service";
import { setup, incoming, chatId } from "./helpers";
const group = "120363000000000009@g.us";
test("reads image details, the reply context and keeps a downloadable copy", () => {
  const message = normalizeMessage(
    {
      key: { id: "IMG1", remoteJid: group, participant: "111@lid", participantAlt: "60111@s.whatsapp.net" },
      messageTimestamp: 100,
      message: {
        imageMessage: {
          caption: "Look",
          mimetype: "image/jpeg",
          fileLength: 2048,
          width: 800,
          height: 600,
          mediaKey: new Uint8Array([9, 9]),
          directPath: "/v/t62/abc",
          url: "https://mmg.whatsapp.net/abc",
          jpegThumbnail: new Uint8Array([0xff, 0xd8, 1]),
          contextInfo: {
            stanzaId: "Q1",
            participant: "60999@s.whatsapp.net",
            quotedMessage: { conversation: "Original question" },
          },
        },
      },
    },
    { id: "60999:3@s.whatsapp.net", lid: "777@lid" },
  )!;
  expect(message).toMatchObject({
    type: "image",
    text: "Look",
    senderId: "60111@s.whatsapp.net",
    media: { mimetype: "image/jpeg", size: 2048, width: 800, height: 600 },
    quoted: {
      providerMessageId: "Q1",
      senderId: "60999@s.whatsapp.net",
      fromMe: true,
      type: "text",
      text: "Original question",
    },
  });
  // The stored copy rebuilds the attachment without the reply context.
  const decoded = proto.Message.decode(message.mediaSource!);
  expect(decoded.imageMessage?.directPath).toBe("/v/t62/abc");
  expect(decoded.imageMessage?.contextInfo).toBeFalsy();
  expect([...embeddedThumbnail(message.mediaSource)!]).toEqual([0xff, 0xd8, 1]);
});
test("describes stickers, voice notes, locations, contacts and polls", () => {
  const key = { id: "X", remoteJid: chatId, fromMe: false };
  const of = (message: proto.IMessage) =>
    normalizeMessage({ key, messageTimestamp: 1, message })!;
  expect(of({ stickerMessage: { mimetype: "image/webp" } }).type).toBe("sticker");
  expect(of({ audioMessage: { ptt: true, seconds: 7 } })).toMatchObject({
    type: "audio",
    media: { ptt: true, seconds: 7 },
  });
  expect(
    of({ locationMessage: { degreesLatitude: 3.1, degreesLongitude: 101.6, name: "KLCC" } }),
  ).toMatchObject({ type: "location", text: "KLCC", media: { latitude: 3.1, longitude: 101.6 } });
  expect(of({ contactMessage: { displayName: "Aisyah" } })).toMatchObject({
    type: "contact",
    text: "Aisyah",
  });
  expect(
    of({ pollCreationMessage: { name: "Lunch?", options: [{ optionName: "Yes" }, { optionName: "No" }] } }).text,
  ).toBe("Lunch?\n○ Yes\n○ No");
  expect(
    of({ documentMessage: { fileName: "invoice.pdf", mimetype: "application/pdf" } }),
  ).toMatchObject({ type: "document", text: "invoice.pdf", media: { fileName: "invoice.pdf" } });
  // Votes, pins and reactions change other messages; they are not bubbles.
  expect(normalizeMessage({ key, messageTimestamp: 1, message: { pollUpdateMessage: {} } })).toBeNull();
  expect(normalizeMessage({ key, messageTimestamp: 1, message: { pinInChatMessage: {} } })).toBeNull();
});
test("keeps deleted history, our message status, reactions, edits and deletes", () => {
  expect(
    normalizeMessage({
      key: { id: "D", remoteJid: chatId },
      messageTimestamp: 5,
      messageStubType: WAMessageStubType.REVOKE,
    }),
  ).toMatchObject({ deletedAt: 5000, providerMessageId: "D" });
  expect(
    normalizeMessage({
      key: { id: "S", remoteJid: chatId, fromMe: true },
      messageTimestamp: 5,
      status: WAMessageStatus.READ,
      message: { conversation: "hi" },
    })?.status,
  ).toBe("read");
  expect(
    historyReactions({
      key: { id: "T", remoteJid: chatId },
      reactions: [
        { key: { fromMe: true }, text: "👍", senderTimestampMs: 10 },
        { key: { remoteJid: chatId }, text: "❤️", senderTimestampMs: 11 },
      ],
    }),
  ).toEqual([
    { providerMessageId: "T", senderId: "me", emoji: "👍", timestamp: 10 },
    { providerMessageId: "T", senderId: chatId, emoji: "❤️", timestamp: 11 },
  ]);
  expect(
    normalizeReaction({
      key: { id: "T", remoteJid: group },
      reaction: { key: { remoteJid: group, participant: "60111@s.whatsapp.net" }, text: "" },
    }),
  ).toMatchObject({ senderId: "60111@s.whatsapp.net", emoji: "" });
  expect(
    normalizeChange({
      key: { id: "E", remoteJid: chatId },
      update: { message: { editedMessage: { message: { conversation: "fixed" } } }, messageTimestamp: 9 },
    }),
  ).toEqual({ providerMessageId: "E", kind: "edit", text: "fixed", timestamp: 9000 });
  expect(
    normalizeChange({
      key: { id: "E", remoteJid: chatId },
      update: { message: null, messageStubType: WAMessageStubType.REVOKE },
    })?.kind,
  ).toBe("delete");
});
test("stores replies, reactions, edits, deletes and status moving forward only", async () => {
  const t = setup();
  try {
    const original = incoming("whatsapp:" + chatId + ":Q1", "Can you send the file?");
    original.providerMessageId = "Q1";
    t.sender.receive(original, true);
    const reply = { ...incoming("whatsapp:" + chatId + ":R1", "Here it is"), providerMessageId: "R1" };
    reply.quoted = { providerMessageId: "Q1", fromMe: false, type: "text", text: "stale copy" };
    t.sender.receive(reply, true);
    // The quote links to the stored message and shows its current text.
    expect(t.messages.get(reply.id)?.quoted).toMatchObject({
      messageId: original.id,
      text: "Can you send the file?",
    });
    t.sender.reaction({ providerMessageId: "Q1", senderId: "me", emoji: "👍", timestamp: 1 });
    t.sender.reaction({ providerMessageId: "Q1", senderId: chatId, emoji: "👍", timestamp: 2 });
    t.sender.reaction({ providerMessageId: "Q1", senderId: "60222@s.whatsapp.net", emoji: "😂", timestamp: 3 });
    expect(t.messages.get(original.id)?.reactions).toEqual([
      { emoji: "👍", count: 2, mine: true },
      { emoji: "😂", count: 1, mine: false },
    ]);
    t.sender.reaction({ providerMessageId: "Q1", senderId: "me", emoji: "", timestamp: 4 });
    expect(t.messages.get(original.id)?.reactions?.[0]).toEqual({ emoji: "👍", count: 1, mine: false });
    t.sender.change({ providerMessageId: "Q1", kind: "edit", text: "Can you send the PDF?", timestamp: 50 });
    expect(t.messages.get(original.id)).toMatchObject({ text: "Can you send the PDF?", editedAt: 50 });
    expect(t.messages.get(reply.id)?.quoted?.text).toBe("Can you send the PDF?");
    t.sender.change({ providerMessageId: "Q1", kind: "delete", timestamp: 60 });
    expect(t.messages.get(original.id)).toMatchObject({ text: null, deletedAt: 60 });
    expect(t.messages.get(reply.id)?.quoted?.text).toBeUndefined();
    // A reply to a deleted message is refused.
    expect(t.sender.send(chatId, "ok", { replyTo: original.id })).rejects.toThrow("deleted");
    const sent = await t.sender.send(chatId, "Thanks");
    expect(sent.status).toBe("sent");
    t.sender.receipt({ providerMessageId: sent.providerMessageId, status: "read" });
    t.sender.receipt({ providerMessageId: sent.providerMessageId, status: "delivered" });
    expect(t.messages.get(sent.id)?.status).toBe("read");
  } finally {
    t.close();
  }
});
test("replies quote the stored message and stay within their chat", async () => {
  const t = setup();
  try {
    const original = { ...incoming("whatsapp:" + chatId + ":Q2", "Meeting at 3?"), providerMessageId: "Q2" };
    t.sender.receive(original, true);
    const res = await t.call("/v1/messages/send", "POST", {
      chatId,
      text: "Yes",
      replyTo: original.id,
    });
    expect(res.status).toBe(200);
    const { message } = (await res.json()) as { message: { quoted: { messageId: string } } };
    expect(t.provider.quotes.at(-1)).toMatchObject({ providerMessageId: "Q2", text: "Meeting at 3?" });
    expect(message.quoted.messageId).toBe(original.id);
    const other = await t.call("/v1/messages/send", "POST", {
      chatId: "60111111111",
      text: "Yes",
      replyTo: original.id,
    });
    expect(other.status).toBe(400);
    expect(((await other.json()) as { error: string }).error).toContain("not in this chat");
  } finally {
    t.close();
  }
});
test("sends attachments, reacts, and downloads media once with a preview fallback", async () => {
  const t = setup();
  const dir = mkdtempSync(join(tmpdir(), "wagate-media-"));
  try {
    const res = await t.call("/v1/messages/send-media", "POST", {
      chatId,
      data: "data:image/png;base64," + Buffer.from("png-bytes").toString("base64"),
      mimetype: "image/png",
      caption: "Receipt",
    });
    expect(res.status).toBe(200);
    const { message } = (await res.json()) as { message: { id: string; type: string; media: unknown; mediaSource?: unknown } };
    expect(message).toMatchObject({ type: "image", media: { mimetype: "image/png" } });
    // The download reference never leaves the sidecar.
    expect(message.mediaSource).toBeUndefined();
    expect(Buffer.from(t.provider.media[0]!.data).toString()).toBe("png-bytes");
    const bad = await t.call("/v1/messages/send-media", "POST", { chatId, data: "!!", mimetype: "image/png" });
    expect(bad.status).toBe(400);
    // Downloads are cached: the second open does not download again.
    const id = message.id;
    const providerId = id.split(":").at(-1)!;
    t.provider.downloads.set(providerId, new Uint8Array(Buffer.from("full-image")));
    for (let i = 0; i < 2; i++) {
      const media = (await (await t.call(`/internal/messages/${encodeURIComponent(id)}/media`)).json()) as {
        data: string;
        complete: boolean;
      };
      expect(media.complete).toBe(true);
      expect(Buffer.from(media.data, "base64").toString()).toBe("full-image");
    }
    expect(t.provider.downloadCalls).toBe(1);
    const raw = await t.call(`/v1/messages/${encodeURIComponent(id)}/media`);
    expect(raw.headers.get("Content-Type")).toBe("image/png");
    expect(await raw.text()).toBe("full-image");
    // A failed download falls back to the embedded preview.
    const second = { ...incoming("whatsapp:" + chatId + ":M2", "pic"), providerMessageId: "M2", type: "image" as const, mediaSource: new Uint8Array([1]) };
    t.sender.receive(second, false);
    t.provider.thumbnails.set("M2", new Uint8Array([7]));
    const fallback = (await (await t.call(`/internal/messages/${encodeURIComponent(second.id)}/media`)).json()) as {
      complete: boolean;
      mimetype: string;
    };
    expect(fallback).toMatchObject({ complete: false, mimetype: "image/jpeg" });
    const react = await t.call(`/v1/messages/${encodeURIComponent(second.id)}/react`, "POST", { emoji: "🔥" });
    expect(((await react.json()) as { message: { reactions: unknown } }).message.reactions).toEqual([
      { emoji: "🔥", count: 1, mine: true },
    ]);
    expect(t.provider.reactions[0]?.target.providerMessageId).toBe("M2");
    const saved = await t.sender.saveMedia(id, dir);
    expect(readFileSync(saved.path, "utf8")).toBe("full-image");
    expect(saved.path).toMatch(/WhatsApp Image .*\.png$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    t.close();
  }
});
test("names downloaded files safely", () => {
  expect(
    mediaFileName({ type: "document", timestamp: 0, media: { fileName: "../../etc/pass:wd" } }, "text/plain"),
  ).toBe("etc-pass-wd");
});
test("attachments stored without a download reference are marked and repaired from a later copy", async () => {
  const t = setup();
  try {
    const old = { ...incoming("whatsapp:" + chatId + ":OLD", "caption"), providerMessageId: "OLD", type: "image" as const };
    t.sender.receive(old, false);
    expect(t.messages.get(old.id)?.mediaAvailable).toBe(false);
    // Opening the chat asks the phone for its recent history again.
    const repair = await t.call(`/internal/chats/${encodeURIComponent(chatId)}/repair-senders`, "POST");
    expect(((await repair.json()) as { requested: boolean }).requested).toBe(true);
    expect(t.provider.historyRequests).toHaveLength(1);
    // The resent copy fills in what the stored row lacked.
    t.sender.receive({ ...old, media: { mimetype: "image/jpeg" }, mediaSource: new Uint8Array([1, 2]) }, false);
    expect(t.messages.get(old.id)).toMatchObject({ mediaAvailable: true, media: { mimetype: "image/jpeg" } });
    expect(t.messages.senderRepairAnchor(chatId)).toBeNull();
  } finally {
    t.close();
  }
});
test("only web links are opened", async () => {
  const t = setup();
  try {
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "not a url"]) {
      const res = await t.call("/internal/open", "POST", { url });
      expect(res.status).toBe(400);
    }
  } finally {
    t.close();
  }
});
