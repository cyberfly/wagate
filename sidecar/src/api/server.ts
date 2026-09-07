import { Hono, type Context, type Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import { timingSafeEqual } from "node:crypto";
import { streamSSE } from "hono/streaming";
import type { MessagingProvider } from "../messaging/messaging-provider";
import { ApiKeys, permissions, type Permission } from "../security/api-keys";
import type { ChatRepository } from "../chats/chat-repository";
import type { MessageRepository } from "../messages/message-repository";
import {
  resolveChatId,
  type MessageService,
} from "../messages/message-service";
import type { EventBus } from "../events/event-bus";
import type { Settings } from "../config/settings";
import type { Vault } from "../security/vault";
import type { DraftRepository } from "../ai/draft-repository";
import type { CopilotService } from "../ai/copilot-service";
interface Services {
  provider: MessagingProvider;
  keys: ApiKeys;
  chats: ChatRepository;
  messages: MessageRepository;
  sender: MessageService;
  events: EventBus;
  settings: Settings;
  vault: () => Promise<Vault>;
  drafts: DraftRepository;
  copilot: CopilotService;
  desktopToken: string;
  port: number;
  databaseHealthy: () => boolean;
  log: (level: "info" | "error", event: string) => void;
}
type Env = { Variables: { scopes: Permission[]; desktop: boolean } };
function equal(a: string, b: string) {
  const aa = Buffer.from(a),
    bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
async function body(c: Context) {
  try {
    const value = await c.req.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw 0;
    return value as Record<string, unknown>;
  } catch {
    throw new Error("Expected a JSON object");
  }
}
function string(value: unknown, name: string, max = 10000) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`Invalid ${name}`);
  return value.trim();
}
export function createApi(s: Services) {
  const app = new Hono<Env>();
  const alerts: { id: number; error: string }[] = [];
  s.events.subscribe((event) => {
    if (event.type.endsWith(".error")) {
      alerts.push({
        id: event.id,
        error: (event.data as { error: string }).error,
      });
      if (alerts.length > 5) alerts.shift();
    }
  });
  app.use(
    "*",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) => c.json({ error: "Request too large" }, 413),
    }),
  );
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    if (c.req.header("Origin"))
      return c.json(
        {
          error:
            "Browser-origin requests are disabled; use the desktop app or an API client",
        },
        403,
      );
    await next();
  });
  app.get("/health", (c) =>
    c.json({
      status: s.databaseHealthy() ? "ok" : "error",
      database: s.databaseHealthy() ? "connected" : "error",
      whatsapp: s.provider.getConnectionState().status,
      version: "0.1.0",
    }),
  );
  app.use("*", async (c, next) => {
    const key = c.req.header("Authorization")?.replace(/^Bearer /, "") || "";
    if (s.desktopToken && equal(key, s.desktopToken)) {
      c.set("desktop", true);
      c.set("scopes", [...permissions]);
    } else {
      const scopes = s.keys.authenticate(key);
      if (!scopes) return c.json({ error: "Unauthorized" }, 401);
      c.set("desktop", false);
      c.set("scopes", scopes);
    }
    await next();
  });
  const requireScope =
    (scope: Permission) => async (c: Context<Env>, next: Next) => {
      if (!c.get("scopes").includes(scope))
        return c.json({ error: "Insufficient permissions" }, 403);
      await next();
    };
  app.get("/v1/status", (c) =>
    c.json({
      status: "ok",
      whatsapp: s.provider.getConnectionState().status,
      database: s.databaseHealthy() ? "connected" : "error",
      version: "0.1.0",
    }),
  );
  app.get("/v1/chats", requireScope("chats.read"), (c) =>
    c.json({ chats: s.chats.list() }),
  );
  app.get("/v1/chats/:chatId/messages", requireScope("messages.read"), (c) => {
    const limit = Number(c.req.query("limit") || 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      return c.json({ error: "limit must be 1–100" }, 400);
    return c.json(
      s.messages.page(
        resolveChatId(c.req.param("chatId")!),
        limit,
        c.req.query("cursor"),
      ),
    );
  });
  app.post("/v1/messages/send", requireScope("messages.send"), async (c) => {
    const data = await body(c);
    if (data.to && data.chatId)
      return c.json({ error: "Provide to or chatId, not both" }, 400);
    const message = await s.sender.send(
      string(data.chatId || data.to, "recipient", 100),
      string(data.text, "text"),
    );
    return c.json({ success: true, messageId: message.id, message });
  });
  app.get(
    "/v1/events",
    requireScope("messages.read"),
    requireScope("chats.read"),
    (c) =>
      streamSSE(c, async (stream) => {
        const unsubscribe = s.events.subscribe((event) => {
          if (
            event.type.startsWith("message.") ||
            event.type === "chat.updated"
          )
            void stream
              .writeSSE({
                event: event.type,
                data: JSON.stringify(event.data),
                id: String(event.id),
              })
              .catch(() => {});
        });
        stream.onAbort(unsubscribe);
        try {
          while (!stream.aborted) {
            await stream.writeSSE({ event: "heartbeat", data: "{}" });
            await stream.sleep(15000);
          }
        } finally {
          unsubscribe();
        }
      }),
  );
  app.use("/internal/*", async (c, next) => {
    if (!c.get("desktop"))
      return c.json({ error: "Desktop access required" }, 403);
    await next();
  });
  app.get("/internal/snapshot", (c) => {
    const chatId = c.req.query("chatId");
    return c.json({
      health: {
        status: s.databaseHealthy() ? "ok" : "error",
        database: s.databaseHealthy() ? "connected" : "error",
        version: "0.1.0",
        ai:
          s.settings.get("ai.configured") === "true"
            ? "configured"
            : "not_configured",
      },
      connection: s.provider.getConnectionState(),
      chats: s.chats.list(),
      messages: chatId ? s.messages.page(chatId).messages : [],
      drafts: chatId ? s.drafts.list(chatId) : [],
      processing: s.copilot.status(),
      alerts,
    });
  });
  app.post("/internal/connection/connect", async (c) => {
    s.settings.set("whatsapp.autoConnect", "true");
    await s.provider.connect();
    return c.json(s.provider.getConnectionState());
  });
  app.post("/internal/connection/disconnect", async (c) => {
    s.settings.set("whatsapp.autoConnect", "false");
    await s.provider.disconnect();
    return c.json({ success: true });
  });
  app.post("/internal/connection/logout", async (c) => {
    s.settings.set("whatsapp.autoConnect", "false");
    await s.provider.logout();
    return c.json({ success: true });
  });
  app.get("/internal/settings", (c) =>
    c.json({
      ai: s.settings.getAi(),
      hasKey: s.settings.get("ai.configured") === "true",
      port: s.port,
    }),
  );
  app.put("/internal/settings", async (c) => {
    const data = await body(c);
    const model = string(data.model, "model", 150);
    if (!/^[\w.-]+\/[\w.:/-]+$/.test(model))
      throw new Error("Use a provider/model ID");
    const systemPrompt = string(data.systemPrompt, "system prompt", 8000);
    const contextSize = Number(data.contextSize);
    if (!Number.isInteger(contextSize) || contextSize < 1 || contextSize > 50)
      throw new Error("Context size must be 1–50");
    if (
      data.guardEnabled !== undefined &&
      typeof data.guardEnabled !== "boolean"
    )
      throw new Error("Invalid request guard");
    const guardEnabled = data.guardEnabled !== false;
    if (data.apiKey !== undefined) {
      const key = string(data.apiKey, "API key", 512);
      (await s.vault()).set("openrouter", key);
      s.settings.set("ai.configured", "true");
    }
    s.settings.setAi({ model, systemPrompt, contextSize, guardEnabled });
    return c.json({ success: true });
  });
  app.delete("/internal/settings/key", async (c) => {
    (await s.vault()).delete("openrouter");
    s.settings.set("ai.configured", "false");
    return c.json({ success: true });
  });
  app.put("/internal/chats/:chatId/mode", async (c) => {
    const { mode } = await body(c);
    if (mode !== "off" && mode !== "copilot")
      throw new Error("Mode must be off or copilot");
    const chatId = resolveChatId(c.req.param("chatId")!);
    if (!s.chats.get(chatId)) return c.json({ error: "Chat not found" }, 404);
    return c.json(s.chats.setMode(chatId, mode));
  });
  app.post("/internal/chats/:chatId/draft", async (c) =>
    c.json(await s.copilot.generate(resolveChatId(c.req.param("chatId")!))),
  );
  app.post("/internal/drafts/:id/send", async (c) => {
    const data = await body(c);
    return c.json(
      await s.copilot.approve(c.req.param("id"), string(data.text, "text")),
    );
  });
  app.delete("/internal/drafts/:id", (c) => {
    if (!s.drafts.dismiss(c.req.param("id")))
      return c.json({ error: "Draft cannot be dismissed" }, 409);
    return c.json({ success: true });
  });
  app.get("/internal/keys", (c) => c.json({ keys: s.keys.list() }));
  app.post("/internal/keys", async (c) => {
    const data = await body(c);
    if (
      !Array.isArray(data.permissions) ||
      !data.permissions.length ||
      data.permissions.some((p) => !permissions.includes(p))
    )
      throw new Error("Choose valid API permissions");
    return c.json(
      s.keys.create(
        string(data.name, "key name", 80),
        data.permissions as Permission[],
      ),
    );
  });
  app.delete("/internal/keys/:id", (c) => {
    s.keys.revoke(c.req.param("id"));
    return c.json({ success: true });
  });
  app.onError((error, c) => {
    s.log("error", "api.request.failed");
    const safe =
      /^(Secure storage |Invalid |Expected |Use |Text must |WhatsApp is disconnected|WhatsApp did not|WhatsApp returned|OpenRouter |Add an OpenRouter|AI reply|Enable Copilot|A draft is|No recent |Copilot |Draft |Reply must|Context size|Mode must|Choose valid)/.test(
        error.message,
      );
    return c.json(
      {
        error: safe
          ? error.message
          : "Request failed. Check connection and local storage.",
      },
      safe ? 400 : 500,
    );
  });
  return app;
}
