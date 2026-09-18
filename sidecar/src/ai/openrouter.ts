import type { AIProvider, AIRequest } from "./ai-provider";
export class OpenRouterProvider implements AIProvider {
  constructor(
    private getKey: () => Promise<string | null>,
    private request: (
      input: string,
      init: RequestInit,
    ) => Promise<Response> = fetch,
  ) {}
  async generate(request: AIRequest) {
    const { webSearch, ...completion } = request;
    const key = await this.getKey();
    if (!key) throw new Error("Add an OpenRouter API key in Settings");
    let response: Response;
    try {
      response = await this.request(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            "X-OpenRouter-Title": "Wagate",
          },
          body: JSON.stringify({
            ...completion,
            stream: false,
            max_tokens: 1000,
            ...(webSearch
              ? {
                  tools: [
                    {
                      type: "openrouter:web_search",
                      parameters: {
                        engine: "exa",
                        max_results: 3,
                        max_total_results: 3,
                        max_uses: 1,
                        max_characters: 2000,
                      },
                    },
                  ],
                }
              : {}),
          }),
          signal: AbortSignal.timeout(45000),
        },
      );
    } catch {
      throw new Error(
        "OpenRouter is unavailable or timed out. Try again later.",
      );
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403)
        throw new Error("OpenRouter rejected the API key");
      if (response.status === 429)
        throw new Error("OpenRouter rate limit reached. Try again later.");
      if (response.status === 402)
        throw new Error("OpenRouter credits are insufficient");
      throw new Error(`OpenRouter request failed (${response.status})`);
    }
    const data = (await response.json()) as {
      choices?: {
        message?: {
          content?: string;
          annotations?: { type?: string; url_citation?: { url?: string } }[];
        };
      }[];
    };
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim())
      throw new Error("OpenRouter returned an empty response");
    let result = text.trim();
    if (webSearch) {
      const urls = [
        ...new Set(
          (data.choices?.[0]?.message?.annotations ?? [])
            .filter((a) => a.type === "url_citation")
            .map((a) => a.url_citation?.url)
            .filter((url): url is string => {
              try {
                const u = new URL(url!);
                return (
                  (u.protocol === "https:" || u.protocol === "http:") &&
                  !u.username &&
                  !u.password
                );
              } catch {
                return false;
              }
            }),
        ),
      ].slice(0, 3);
      if (!urls.length)
        throw new Error(
          "OpenRouter web search returned no verified sources. Nothing was posted.",
        );
      const missing = urls.filter((url) => !result.includes(url));
      if (missing.length) result += "\n\nSources:\n" + missing.join("\n");
    }
    if (result.length > 10000) throw new Error("AI reply is too long");
    return result;
  }
}
