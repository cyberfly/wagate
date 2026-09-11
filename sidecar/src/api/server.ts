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
import type { TunnelService } from "../tunnel/tunnel-service";
import type { BroadcastService } from "../broadcast/broadcast-service";
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
  broadcasts: BroadcastService;
  desktopToken: string;
  port: number;
  tunnel?: TunnelService;
  /**
   * Builds the internet-facing variant: no `/internal` routes, no desktop
   * token, a minimal `/health`, and throttling of failed authentication.
   */
  publicMode?: boolean;
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
  const tunnel = () => {
    if (!s.tunnel) throw new Error("Cloudflare tunnel is unavailable");
    return s.tunnel;
  };
  const alerts: { id: number; error: string }[] = [];
  if (!s.publicMode)
    s.events.subscribe((event) => {
      if (event.type.endsWith(".error")) {
        alerts.push({
          id: event.id,
          error: (event.data as { error: string }).error,
        });
        if (alerts.length > 5) alerts.shift();
      }
    });
  const limit = (maxSize: number, error: string) =>
    bodyLimit({ maxSize, onError: (c) => c.json({ error }, 413) });
  const standardLimit = limit(64 * 1024, "Request too large");
  // A CSV broadcast carries every rendered message in one request.
  const broadcastLimit = limit(
    4 * 1024 * 1024,
    "Broadcast is too large. Split the CSV into smaller files.",
  );
  app.use("*", (c, next) =>
    (!s.publicMode && c.req.path === "/internal/broadcasts"
      ? broadcastLimit
      : standardLimit)(c, next),
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
    // The public variant reveals nothing about the account behind the tunnel.
    c.json(
      s.publicMode
        ? { status: s.databaseHealthy() ? "ok" : "error" }
        : {
            status: s.databaseHealthy() ? "ok" : "error",
            database: s.databaseHealthy() ? "connected" : "error",
            whatsapp: s.provider.getConnectionState().status,
            version: "0.1.1",
          },
    ),
  );
  let authWindow = 0,
    failures = 0;
  app.use("*", async (c, next) => {
    const key = c.req.header("Authorization")?.replace(/^Bearer /, "") || "";
    if (!s.publicMode && s.desktopToken && equal(key, s.desktopToken)) {
      c.set("desktop", true);
      c.set("scopes", [...permissions]);
    } else {
      const scopes = s.keys.authenticate(key);
      if (!scopes) {
        // Valid keys are never throttled, so a flood of guesses cannot lock
        // a real integration out.
        if (s.publicMode) {
          const minute = Math.floor(Date.now() / 60000);
          if (minute !== authWindow) {
            authWindow = minute;
            failures = 0;
          }
          if (++failures > 20)
            return c.json({ error: "Too many attempts" }, 429);
        }
        return c.json({ error: "Unauthorized" }, 401);
      }
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
      version: "0.1.1",
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
  if (!s.publicMode) {
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
          version: "0.1.1",
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
        tunnel: s.tunnel?.status() ?? null,
        broadcasts: s.broadcasts.list(),
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
    app.post("/internal/broadcasts", async (c) => {
      const data = await body(c);
      if (!Array.isArray(data.recipients))
        throw new Error("Invalid recipients");
      return c.json(
        s.broadcasts.create({
          name: string(data.name, "broadcast name", 120),
          minDelay: Number(data.minDelay),
          maxDelay: Number(data.maxDelay),
          recipients: data.recipients.map((r: unknown) => {
            if (!r || typeof r !== "object") throw new Error("Invalid recipients");
            const { to, label, text } = r as Record<string, unknown>;
            return {
              to: string(to, "recipient", 100),
              label: typeof label === "string" ? label : "",
              text: string(text, "text"),
            };
          }),
        }),
      );
    });
    app.get("/internal/broadcasts/:id", (c) =>
      c.json(s.broadcasts.get(c.req.param("id"))),
    );
    app.post("/internal/broadcasts/:id/export", (c) =>
      c.json(s.broadcasts.export(c.req.param("id"))),
    );
    for (const action of ["pause", "resume", "cancel"] as const)
      app.post(`/internal/broadcasts/:id/${action}`, (c) =>
        c.json(s.broadcasts[action](c.req.param("id"))),
      );
    app.delete("/internal/broadcasts/:id", (c) => {
      s.broadcasts.remove(c.req.param("id"));
      return c.json({ success: true });
    });
    app.get("/internal/tunnel", (c) => c.json(tunnel().status()));
    app.post("/internal/tunnel/install", (c) => c.json(tunnel().install()));
    app.post("/internal/tunnel/start", (c) => {
      if (
        !s.keys
          .list()
          .some((k) => !(k as { revokedAt: number | null }).revokedAt)
      )
        throw new Error(
          "Cloudflare tunnel needs at least one active API key. Create one first.",
        );
      return c.json(tunnel().start());
    });
    app.post("/internal/tunnel/stop", (c) => c.json(tunnel().stop()));
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
  }
  app.onError((error, c) => {
    s.log("error", "api.request.failed");
    const safe =
      /^(Secure storage |Invalid |Expected |Use |Text must |WhatsApp is disconnected|WhatsApp did not|WhatsApp returned|OpenRouter |Add an OpenRouter|AI reply|Enable Copilot|A draft is|No recent |Copilot |Draft |Reply must|Context size|Mode must|Choose valid|Cloudflare |The Cloudflare|Broadcast )/.test(
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
