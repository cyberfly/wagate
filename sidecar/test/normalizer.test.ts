import { test, expect } from "bun:test";
import { WAMessageStatus } from "@whiskeysockets/baileys";
import {
  normalizeMessage,
  normalizeReceipt,
} from "../src/messaging/baileys/normalizer";
test("reads rejections, deliveries and reads of our own messages", () => {
  // Baileys reports a server ack carrying an error as status ERROR, with the
  // code as the first stub parameter. The ack may come from the recipient's LID.
  const own = { id: "3EB0A1", remoteJid: "1234567890@lid", fromMe: true };
  expect(
    normalizeReceipt({
      key: own,
      update: { status: WAMessageStatus.ERROR, messageStubParameters: ["463"] },
    }),
  ).toEqual({ providerMessageId: "3EB0A1", status: "failed", error: "463" });
  expect(
    normalizeReceipt({ key: own, update: { status: WAMessageStatus.ERROR } }),
  ).toEqual({ providerMessageId: "3EB0A1", status: "failed" });
  expect(
    normalizeReceipt({ key: own, update: { status: WAMessageStatus.DELIVERY_ACK } }),
  ).toMatchObject({ status: "delivered" });
  expect(
    normalizeReceipt({ key: own, update: { status: WAMessageStatus.PLAYED } }),
  ).toMatchObject({ status: "read" });
  // Pending and server acks say nothing new; others' messages are not ours.
  expect(
    normalizeReceipt({ key: own, update: { status: WAMessageStatus.SERVER_ACK } }),
  ).toBeNull();
  expect(
    normalizeReceipt({
      key: { ...own, fromMe: false },
      update: { status: WAMessageStatus.READ },
    }),
  ).toBeNull();
});
const key = { id: "one", remoteJid: "123456789@s.whatsapp.net", fromMe: false };
test("normalizes wrapped text and outgoing messages with timestamps", () => {
  expect(
    normalizeMessage({
      key,
      messageTimestamp: 100,
      message: {
        ephemeralMessage: {
          message: { extendedTextMessage: { text: "hello" } },
        },
      },
    }),
  ).toMatchObject({
    type: "text",
    text: "hello",
    timestamp: 100000,
    direction: "incoming",
  });
  expect(
    normalizeMessage({
      key: { ...key, fromMe: true },
      messageTimestamp: 100,
      message: { conversation: "sent" },
    })?.direction,
  ).toBe("outgoing");
});
test("ignores status broadcasts, protocol messages and missing IDs", () => {
  expect(
    normalizeMessage({
      key: { ...key, remoteJid: "status@broadcast" },
      messageTimestamp: 100,
      message: { conversation: "status" },
    }),
  ).toBeNull();
  expect(
    normalizeMessage({
      key,
      messageTimestamp: 100,
      message: { protocolMessage: {} },
    }),
  ).toBeNull();
  expect(
    normalizeMessage({ key: {}, message: { conversation: "bad" } }),
  ).toBeNull();
});
test("normalizes media without processing attachments", () => {
  expect(
    normalizeMessage({
      key,
      messageTimestamp: 100,
      message: { imageMessage: { caption: "photo" } },
    }),
  ).toMatchObject({ type: "image", text: "photo" });
});
test("outgoing sender is the linked account, not the recipient", () => {
  expect(
    normalizeMessage(
      {
        key: { ...key, fromMe: true },
        messageTimestamp: 100,
        message: { conversation: "Hello" },
      },
      "60999999999:2@s.whatsapp.net",
    )?.senderId,
  ).toBe("60999999999@s.whatsapp.net");
});
