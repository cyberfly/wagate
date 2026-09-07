import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const path of temporaryDirectories.splice(0))
    rmSync(path, { recursive: true, force: true });
});
import { openDatabase } from "../src/db/database";
import { ChatRepository } from "../src/chats/chat-repository";
import { MessageRepository } from "../src/messages/message-repository";
import { ApiKeys } from "../src/security/api-keys";
import type { Message } from "../src/messaging/types";
test("message deduplication, stable pagination and chat metadata survive reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "wagate-test-"));
  temporaryDirectories.push(dir);
  const path = join(dir, "test.sqlite");
  let db = openDatabase(path);
  let chats = new ChatRepository(db);
  let messages = new MessageRepository(db, chats);
  const m: Message = {
    id: "a",
    provider: "whatsapp",
    providerMessageId: "p1",
    chatId: "123456789@s.whatsapp.net",
    senderId: "123456789",
    direction: "incoming",
    type: "text",
    text: "hello",
    timestamp: 10,
  };
  expect(messages.save(m)).toBe(true);
  expect(messages.save(m)).toBe(false);
  chats.upsert({
    id: m.chatId,
    provider: "whatsapp",
    name: "Ali",
    type: "direct",
    lastMessageAt: 10,
  });
  chats.setMode(m.chatId, "copilot");
  messages.save({ ...m, id: "b", providerMessageId: "p2" });
  messages.save({ ...m, id: "c", providerMessageId: "p3", timestamp: 1 });
  db.close();
  db = openDatabase(path);
  chats = new ChatRepository(db);
  messages = new MessageRepository(db, chats);
  expect(chats.get(m.chatId)).toMatchObject({
    name: "Ali",
    lastMessageAt: 10,
    aiMode: "copilot",
  });
  const page = messages.page(m.chatId, 1);
  expect(page.messages[0].id).toBe("b");
  expect(messages.page(m.chatId, 1, page.nextCursor!).messages[0].id).toBe("a");
  db.close();
});
test("API keys store hashes, enforce revocation", () => {
  const db = openDatabase(":memory:");
  const keys = new ApiKeys(db);
  const created = keys.create("test", ["messages.read"]);
  expect(keys.authenticate(created.key)).toEqual(["messages.read"]);
  expect(
    JSON.stringify(db.query("SELECT * FROM api_keys").all()),
  ).not.toContain(created.key);
  keys.revoke(created.id);
  expect(keys.authenticate(created.key)).toBeNull();
  db.close();
});
