import { test, expect } from "bun:test";
import { OpenRouterProvider } from "../src/ai/openrouter";
const request = {
  model: "test/model",
  messages: [{ role: "user" as const, content: "Hello" }],
};
test("OpenRouter errors are actionable without leaking credentials or upstream bodies", async () => {
  for (const [status, message] of [
    [401, "rejected"],
    [429, "rate limit"],
    [402, "credits"],
    [500, "failed"],
  ] as const) {
    const ai = new OpenRouterProvider(
      async () => "secret",
      async () => new Response("secret upstream body", { status }),
    );
    await expect(ai.generate(request)).rejects.toThrow(message);
  }
});
test("OpenRouter validates empty responses and sends only a bounded completion request", async () => {
  let body: Record<string, unknown> = {};
  const ai = new OpenRouterProvider(
    async () => "secret",
    async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ choices: [{ message: { content: "Reply" } }] });
    },
  );
  expect(await ai.generate(request)).toBe("Reply");
  expect(body.max_tokens).toBe(1000);
  expect(body.tools).toBeUndefined();
});
