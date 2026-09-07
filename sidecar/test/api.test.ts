import { test, expect } from "bun:test";
import { setup, incoming, chatId } from "./helpers";
test("health is minimal; all data routes require authentication and reject browser origins", async () => {
  const s = setup();
  expect((await s.app.request("/health")).status).toBe(200);
  expect((await s.app.request("/v1/chats")).status).toBe(401);
  expect(
    (
      await s.call(
        "/internal/settings",
        "GET",
        undefined,
        "test-desktop-token",
        { Origin: "https://evil.example" },
      )
    ).status,
  ).toBe(403);
  s.close();
});
test("scopes separate reads, sends and desktop secrets; revocation is immediate", async () => {
  const s = setup();
  const key = s.keys.create("read only", ["messages.read"]);
  expect((await s.call("/v1/chats", "GET", undefined, key.key)).status).toBe(
    403,
  );
  expect(
    (
      await s.call(
        "/v1/chats/" + chatId + "/messages",
        "GET",
        undefined,
        key.key,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await s.call(
        "/v1/messages/send",
        "POST",
        { to: "60123456789", text: "Hello" },
        key.key,
      )
    ).status,
  ).toBe(403);
  expect(
    (await s.call("/internal/settings", "GET", undefined, key.key)).status,
  ).toBe(403);
  s.keys.revoke(key.id);
  expect((await s.call("/v1/status", "GET", undefined, key.key)).status).toBe(
    401,
  );
  s.close();
});
test("send via phone convenience persists messages and validates input", async () => {
  const s = setup();
  const key = s.keys.create("sender", ["messages.send"]);
  const response = await s.call(
    "/v1/messages/send",
    "POST",
    { to: "+60123456789", text: " Hello " },
    key.key,
  );
  expect(response.status).toBe(200);
  expect(s.provider.sent[0]).toMatchObject({ chatId, text: "Hello" });
  expect(s.messages.page(chatId).messages).toHaveLength(1);
  expect(
    (
      await s.call(
        "/v1/messages/send",
        "POST",
        { to: "bad", text: "Hello" },
        key.key,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await s.call(
        "/v1/messages/send",
        "POST",
        { to: "60123456789", text: " " },
        key.key,
      )
    ).status,
  ).toBe(400);
  expect(s.provider.sent).toHaveLength(1);
  await s.provider.disconnect();
  expect(
    (
      await s.call(
        "/v1/messages/send",
        "POST",
        { to: "60123456789", text: "Hello" },
        key.key,
      )
    ).status,
  ).toBe(400);
  s.close();
});
test("settings never return credentials; unsupported automation mode rejected", async () => {
  const s = setup();
  s.sender.receive(incoming(), false);
  const response = await s.call("/internal/settings", "PUT", {
    model: "provider/model",
    systemPrompt: "Be helpful",
    contextSize: 20,
    apiKey: "secret-openrouter-test",
  });
  expect(response.status).toBe(200);
  expect(await (await s.call("/internal/settings")).text()).not.toContain(
    "secret-openrouter-test",
  );
  expect(s.vault.get("openrouter")).toBe("secret-openrouter-test");
  expect(
    (
      await s.call("/internal/chats/" + chatId + "/mode", "PUT", {
        mode: "autopilot",
      })
    ).status,
  ).toBe(400);
  expect(
    (await s.call("/v1/chats/" + chatId + "/messages?limit=900")).status,
  ).toBe(400);
  expect(
    (await s.call("/v1/chats/" + chatId + "/messages?cursor=bad")).status,
  ).toBe(400);
  s.close();
});
test("malformed JSON and oversized bodies do not reach services", async () => {
  const s = setup();
  expect(
    (
      await s.app.request("/v1/messages/send", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-desktop-token",
          "Content-Type": "application/json",
        },
        body: "{bad",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await s.call("/v1/messages/send", "POST", {
        to: "60123456789",
        text: "x".repeat(100000),
      })
    ).status,
  ).toBe(413);
  expect(s.provider.sent).toHaveLength(0);
  s.close();
});
