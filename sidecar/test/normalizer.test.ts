import { test, expect } from "bun:test";
import { normalizeMessage } from "../src/messaging/baileys/normalizer";
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
