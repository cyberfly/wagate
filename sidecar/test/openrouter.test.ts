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
test("news generation uses bounded web search and includes returned source citations", async () => {
  let body: Record<string, unknown> = {};
  const ai = new OpenRouterProvider(
    async () => "secret",
    async (_url, init) => {
      body = JSON.parse(String(init.body));
      return Response.json({
        choices: [
          {
            message: {
              content: "A current update",
              annotations: [
                {
                  type: "url_citation",
                  url_citation: { url: "https://example.com/news" },
                },
                {
                  type: "url_citation",
                  url_citation: { url: "javascript:alert(1)" },
                },
              ],
            },
          },
        ],
      });
    },
  );
  expect(await ai.generate({ ...request, webSearch: true })).toBe(
    "A current update\n\nSources:\nhttps://example.com/news",
  );
  expect(body.webSearch).toBeUndefined();
  const tools = body.tools as {
    type: string;
    parameters: { max_results: number; max_uses: number };
  }[];
  expect(tools[0].type).toBe("openrouter:web_search");
  expect(tools[0].parameters.max_results).toBe(3);
  expect(tools[0].parameters.max_uses).toBe(1);
});
test("news never falls back to uncited model knowledge when web search returns no sources", async () => {
  const ai = new OpenRouterProvider(
    async () => "secret",
    async () =>
      Response.json({
        choices: [
          {
            message: {
              content: "Unverified news with https://invented.example/story",
            },
          },
        ],
      }),
  );
  await expect(ai.generate({ ...request, webSearch: true })).rejects.toThrow(
    "no verified sources",
  );
});
