import { test, expect } from "bun:test";
import { setup, incoming, chatId } from "./helpers";
const settle = async () => {
  await Bun.sleep(15);
};
test("AI off and history sync never generate replies", async () => {
  const s = setup();
  s.sender.receive(incoming(), true);
  await settle();
  expect(s.requests).toHaveLength(0);
  s.chats.setMode(chatId, "copilot");
  s.sender.receive(incoming("history"), false);
  await settle();
  expect(s.requests).toHaveLength(0);
  expect(s.provider.sent).toHaveLength(0);
  s.close();
});
test("incoming live message creates exactly one draft, bounded context, sends only on approval", async () => {
  const s = setup();
  s.sender.receive(incoming("older"), false);
  s.chats.setMode(chatId, "copilot");
  s.settings.setAi({
    model: "test/model",
    systemPrompt: "System",
    contextSize: 2,
    guardEnabled: true,
  });
  s.sender.receive(incoming("source"), true);
  s.sender.receive(incoming("source"), true);
  await settle();
  expect(s.requests).toHaveLength(1);
  expect(s.requests[0].messages).toHaveLength(4);
  expect(s.requests[0].messages[0].content).toContain("not a general-purpose");
  expect(s.provider.sent).toHaveLength(0);
  const draft = s.drafts.list(chatId)[0];
  expect(draft.status).toBe("pending");
  await s.copilot.approve(draft.id, "Edited by user");
  expect(s.provider.sent[0].text).toBe("Edited by user");
  expect(s.drafts.get(draft.id)?.status).toBe("sent");
  await expect(s.copilot.approve(draft.id, "Duplicate")).rejects.toThrow();
  expect(s.provider.sent).toHaveLength(1);
  s.close();
});
test("turning Copilot off during generation discards the reply", async () => {
  let complete!: (text: string) => void;
  const s = setup({
    generate: () => new Promise((resolve) => (complete = resolve)),
  });
  s.sender.receive(incoming(), false);
  s.chats.setMode(chatId, "copilot");
  const generating = s.copilot.generate(chatId);
  s.chats.setMode(chatId, "off");
  complete("Reply");
  await expect(generating).rejects.toThrow("turned off");
  expect(s.drafts.list(chatId)).toHaveLength(0);
  expect(s.provider.sent).toHaveLength(0);
  s.close();
});
test("failed send marks uncertain, preventing blind retries", async () => {
  const s = setup();
  s.sender.receive(incoming(), false);
  s.chats.setMode(chatId, "copilot");
  const draft = await s.copilot.generate(chatId);
  s.provider.sendText = async () => {
    throw new Error("Connection lost after send");
  };
  await expect(s.copilot.approve(draft.id, draft.text)).rejects.toThrow();
  expect(s.drafts.get(draft.id)?.status).toBe("uncertain");
  await expect(s.copilot.approve(draft.id, draft.text)).rejects.toThrow(
    "verification",
  );
  s.close();
});
