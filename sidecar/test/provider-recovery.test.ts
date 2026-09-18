import { test, expect } from "bun:test";
import { BaileysProvider } from "../src/messaging/baileys/baileys-provider";

test("credential-store failure permits retry without deleting the WhatsApp session", async () => {
  let attempts = 0;
  const provider = new BaileysProvider(
    async () => {
      attempts++;
      throw new Error("Credential store unavailable");
    },
    {
      connection: () => {},
      chat: () => {},
      message: () => {},
      receipt: () => {},
      contacts: () => {},
      error: () => {},
    },
  );
  await provider.connect();
  expect(provider.getConnectionState().status).toBe("disconnected");
  await provider.connect();
  expect(attempts).toBe(2);
});
