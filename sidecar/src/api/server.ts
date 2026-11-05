import { Hono, type Context, type Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import { timingSafeEqual } from "node:crypto";
import { streamSSE } from "hono/streaming";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ApiKeys, permissions, type Permission } from "../security/api-keys";
import { resolveChatId } from "../messages/message-service";
import type { Settings } from "../config/settings";
import type { Vault } from "../security/vault";
import type { TunnelService } from "../tunnel/tunnel-service";
import type { ProfileManager } from "../profiles/profile-manager";
import type { ProfileRuntime } from "../profiles/profile-runtime";
import { defaultProfile } from "../profiles/profile-manager";
interface Services {
  /** Every WhatsApp number; each request works with one of them. */
  profiles: ProfileManager;
  keys: ApiKeys;
  /** App-wide settings: AI model and prompt, shared by every profile. */
  settings: Settings;
  vault: () => Promise<Vault>;
  desktopToken: string;
  port: number;
  tunnel?: TunnelService;
  /**
   * Builds the internet-facing variant: no `/internal` routes, no desktop
   * token, a minimal `/health`, and throttling of failed authentication.
   */
  publicMode?: boolean;
  databaseHealthy: () => boolean;
  /** Runs the command that opens a link; tests replace it. */
  openUrl?: (command: string[]) => void;
  log: (level: "info" | "error", event: string) => void;
}
/** Chooses a profile for one request; the query form suits EventSource clients. */
export const profileHeader = "X-Wagate-Profile";
type Env = {
  Variables: {
    scopes: Permission[];
    desktop: boolean;
    /** Profiles the caller's key may use; null means every profile. */
    keyProfiles: string[] | null;
    runtime?: ProfileRuntime;
  };
};
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
/** A string field that may be left out; blank counts as left out. */
function optional(value: unknown, name: string, max = 200) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > max) throw new Error(`Invalid ${name}`);
  return value.trim() || undefined;
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
  /**
   * The profile a request works with: the header or query names it, a key
   * limited to one profile implies it, and otherwise it is the main one.
   */
  const profile = (c: Context<Env>): ProfileRuntime => {
    const cached = c.get("runtime");
    if (cached) return cached;
    const header = c.req.header(profileHeader)?.trim(),
      query = c.req.query("profile")?.trim();
    if (header && query && header !== query)
      throw new HTTPException(400, {
        message: "Profile header and query name different profiles",
      });
    const allowed = c.get("keyProfiles");
    const id =
      header || query || (allowed?.length === 1 ? allowed[0] : defaultProfile);
    // A restricted key learns nothing about profiles it cannot use.
    if (allowed && !allowed.includes(id))
      throw new HTTPException(403, {
        message: "This API key cannot use that profile",
      });
    const runtime = s.profiles.get(id);
    if (!runtime) throw new HTTPException(404, { message: "Profile not found" });
    c.set("runtime", runtime);
    return runtime;
  };
  const limit = (maxSize: number, error: string) =>
    bodyLimit({ maxSize, onError: (c) => c.json({ error }, 413) });
  const standardLimit = limit(64 * 1024, "Request too large");
  // Base64 makes a 16 MB attachment about 22 MB of JSON.
  const mediaLimit = limit(23 * 1024 * 1024, "Attachment is too large. Send files up to 16 MB.");
  // A CSV broadcast carries every rendered message in one request.
  const broadcastLimit = limit(
    4 * 1024 * 1024,
    "Broadcast is too large. Split the CSV into smaller files.",
  );
  app.use("*", (c, next) =>
    (c.req.path === "/v1/messages/send-media"
      ? mediaLimit
      : !s.publicMode &&
          (c.req.path === "/internal/broadcasts" ||
            c.req.path === "/internal/group-imports")
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
            whatsapp: s.profiles.main().provider.getConnectionState().status,
            profiles: s.profiles.list().length,
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
      c.set("keyProfiles", null);
    } else {
      const access = s.keys.access(key);
      if (!access) {
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
      c.set("scopes", access.permissions);
      c.set("keyProfiles", access.profiles);
    }
    await next();
  });
  const requireScope =
    (scope: Permission) => async (c: Context<Env>, next: Next) => {
      if (!c.get("scopes").includes(scope))
        return c.json({ error: "Insufficient permissions" }, 403);
      await next();
    };
  app.get("/v1/status", (c) => {
    const p = profile(c);
    const { id, name, account } = s.profiles.describe(p.id)!;
    return c.json({
      status: "ok",
      whatsapp: p.provider.getConnectionState().status,
      database: p.databaseHealthy() ? "connected" : "error",
      profile: { id, name, account },
      version: "0.1.1",
    });
  });
  // Any valid key may list the numbers it can use, to pick one per request.
  app.get("/v1/profiles", (c) => {
    const allowed = c.get("keyProfiles");
    return c.json({
      profiles: s.profiles
        .list()
        .filter((p) => !allowed || allowed.includes(p.id))
        .map(({ id, name, account, status, isDefault }) => ({
          id,
          name,
          account,
          status,
          isDefault,
        })),
    });
  });
  app.get("/v1/chats", requireScope("chats.read"), (c) =>
    c.json({ chats: profile(c).chats.list() }),
  );
  app.get("/v1/chats/:chatId/messages", requireScope("messages.read"), (c) => {
    const limit = Number(c.req.query("limit") || 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      return c.json({ error: "limit must be 1–100" }, 400);
    return c.json(
      profile(c).messages.page(
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
    const message = await profile(c).sender.send(
      string(data.chatId || data.to, "recipient", 100),
      string(data.text, "text"),
      { replyTo: optional(data.replyTo, "reply") },
    );
    return c.json({ success: true, messageId: message.id, message });
  });
  app.post("/v1/messages/send-media", requireScope("messages.send"), async (c) => {
    const data = await body(c);
    if (data.to && data.chatId)
      return c.json({ error: "Provide to or chatId, not both" }, 400);
    const encoded = string(data.data, "attachment", 23 * 1024 * 1024).replace(/^data:[^,]*,/, "");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
      throw new Error("Invalid attachment: data must be base64");
    const message = await profile(c).sender.sendMedia(
      string(data.chatId || data.to, "recipient", 100),
      {
        data: new Uint8Array(Buffer.from(encoded, "base64")),
        mimetype: string(data.mimetype, "attachment type", 100).toLowerCase(),
        fileName: optional(data.fileName, "file name", 200),
        caption: optional(data.caption, "caption", 4000),
      },
      { replyTo: optional(data.replyTo, "reply") },
    );
    return c.json({ success: true, messageId: message.id, message });
  });
  app.post("/v1/messages/:id/react", requireScope("messages.send"), async (c) => {
    const data = await body(c);
    if (typeof data.emoji !== "string") throw new Error("Invalid reaction");
    const message = await profile(c).sender.react(c.req.param("id")!, data.emoji);
    return c.json({ success: true, message });
  });
  app.get("/v1/messages/:id/media", requireScope("messages.read"), async (c) => {
    const media = await profile(c).sender.media(c.req.param("id")!);
    if (!media.complete)
      return c.json({ error: media.error || "Media could not be downloaded. Try again later." }, 502);
    return c.body(Buffer.from(media.data), 200, { "Content-Type": media.mimetype });
  });
  app.get(
    "/v1/events",
    requireScope("messages.read"),
    requireScope("chats.read"),
    (c) => {
      // Resolved before streaming starts, so a bad profile is a plain error.
      const events = profile(c).events;
      return streamSSE(c, async (stream) => {
        const unsubscribe = events.subscribe((event) => {
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
      });
    },
  );
  if (!s.publicMode) {
    app.use("/internal/*", async (c, next) => {
      if (!c.get("desktop"))
        return c.json({ error: "Desktop access required" }, 403);
      await next();
    });
    app.get("/internal/snapshot", (c) => {
      const chatId = c.req.query("chatId");
      // Scrolling up asks for more of the chat's stored history.
      const limit = Math.min(500, Math.max(50, Number(c.req.query("limit")) || 50));
      const p = profile(c);
      const page = chatId ? p.messages.page(chatId, limit) : null;
      return c.json({
        health: {
          status: s.databaseHealthy() && p.databaseHealthy() ? "ok" : "error",
          database:
            s.databaseHealthy() && p.databaseHealthy() ? "connected" : "error",
          version: "0.1.1",
          ai:
            s.settings.get("ai.configured") === "true"
              ? "configured"
              : "not_configured",
        },
        profile: s.profiles.describe(p.id),
        profiles: s.profiles.list(),
        connection: p.provider.getConnectionState(),
        chats: p.chats.list(),
        messages: page?.messages ?? [],
        hasMoreMessages: !!page?.nextCursor,
        drafts: chatId ? p.drafts.list(chatId) : [],
        processing: p.copilot.status(),
        tunnel: s.tunnel?.status() ?? null,
        broadcasts: p.broadcasts.list(),
        automations: p.automations.list(),
        automationPosts: p.automations.posts(),
        groupImports: p.groupImports.list(),
        alerts: p.alerts,
      });
    });
    app.get("/internal/profiles", (c) =>
      c.json({ profiles: s.profiles.list() }),
    );
    app.post("/internal/profiles", async (c) => {
      const data = await body(c);
      return c.json(s.profiles.create(data.name));
    });
    app.put("/internal/profiles/:id", async (c) => {
      const data = await body(c);
      return c.json(s.profiles.rename(c.req.param("id"), data.name));
    });
    app.delete("/internal/profiles/:id", async (c) =>
      c.json(await s.profiles.remove(c.req.param("id"))),
    );
    // Links in messages open in the system browser. Only web addresses are
    // passed on, as one argument and never through a shell.
    app.post("/internal/open", async (c) => {
      const data = await body(c);
      let url: URL;
      try {
        url = new URL(string(data.url, "link", 4000));
      } catch {
        throw new Error("Invalid link");
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Invalid link");
      const command =
        process.platform === "darwin"
          ? ["open", url.href]
          : process.platform === "win32"
            ? ["rundll32", "url.dll,FileProtocolHandler", url.href]
            : ["xdg-open", url.href];
      (s.openUrl ?? ((cmd: string[]) => void Bun.spawn(cmd, { stdio: ["ignore", "ignore", "ignore"] })))(command);
      return c.json({ success: true });
    });
    // The webview receives JSON only, so attachments travel as base64.
    app.get("/internal/messages/:id/media", async (c) => {
      const sender = profile(c).sender, id = c.req.param("id")!;
      const media: { mimetype: string; data: Uint8Array; complete: boolean; error?: string } =
        c.req.query("preview") ? sender.preview(id) : await sender.media(id);
      return c.json({
        mimetype: media.mimetype,
        data: Buffer.from(media.data).toString("base64"),
        complete: media.complete,
        ...(media.complete ? {} : { error: media.error ?? null }),
      });
    });
    app.post("/internal/messages/:id/save", async (c) =>
      c.json(await profile(c).sender.saveMedia(c.req.param("id")!)),
    );
    app.get("/internal/groups", async (c) =>
      c.json({ groups: await profile(c).provider.listGroups() }),
    );
    app.post("/internal/group-imports", async (c) => {
      const data = await body(c);
      if (!Array.isArray(data.members)) throw new Error("Invalid members");
      return c.json(
        await profile(c).groupImports.start(
          string(data.groupId, "group", 100),
          data.members.map((m: unknown) => {
            if (!m || typeof m !== "object") throw new Error("Invalid members");
            const { phone, label } = m as Record<string, unknown>;
            return {
              phone: string(phone, "phone number", 20),
              label: typeof label === "string" ? label : "",
            };
          }),
          { minDelay: Number(data.minDelay), maxDelay: Number(data.maxDelay) },
        ),
      );
    });
    app.post("/internal/groups/:groupId/participants", async (c) => {
      const data = await body(c);
      if (!Array.isArray(data.phones)) throw new Error("Invalid phone numbers");
      return c.json(
        await profile(c).groupImports.add(
          resolveChatId(c.req.param("groupId")!),
          data.phones.map((p: unknown) => string(p, "phone number", 20)),
        ),
      );
    });
    app.post("/internal/group-imports/:id/cancel", (c) =>
      c.json(profile(c).groupImports.cancel(c.req.param("id"))),
    );
    app.delete("/internal/group-imports/:id", (c) => {
      profile(c).groupImports.remove(c.req.param("id"));
      return c.json({ success: true });
    });
    app.put("/internal/automations/:chatId", async (c) =>
      c.json(
        await profile(c).automations.save(
          resolveChatId(c.req.param("chatId")!),
          await body(c),
        ),
      ),
    );
    app.post("/internal/automations/:chatId/pause", (c) =>
      c.json(profile(c).automations.pause(resolveChatId(c.req.param("chatId")!))),
    );
    app.post("/internal/automations/:chatId/resume", async (c) =>
      c.json(await profile(c).automations.resume(resolveChatId(c.req.param("chatId")!))),
    );
    app.post("/internal/automations/:chatId/preview", async (c) =>
      c.json(
        await profile(c).automations.preview(resolveChatId(c.req.param("chatId")!)),
      ),
    );
    app.post("/internal/automation-posts/:id/approve", async (c) => {
      const data = await body(c);
      return c.json(
        await profile(c).automations.approve(
          c.req.param("id"),
          string(data.text, "automation post"),
        ),
      );
    });
    app.delete("/internal/automation-posts/:id", (c) =>
      c.json(profile(c).automations.dismiss(c.req.param("id"))),
    );
    app.post("/internal/connection/connect", async (c) => {
      const p = profile(c);
      p.settings.set("whatsapp.autoConnect", "true");
      await p.provider.connect();
      return c.json(p.provider.getConnectionState());
    });
    app.post("/internal/connection/disconnect", async (c) => {
      const p = profile(c);
      p.settings.set("whatsapp.autoConnect", "false");
      await p.provider.disconnect();
      return c.json({ success: true });
    });
    app.post("/internal/connection/logout", async (c) => {
      const p = profile(c);
      p.settings.set("whatsapp.autoConnect", "false");
      await p.provider.logout();
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
    app.put("/internal/chats/:chatId/pin", async (c) => {
      const { pinned } = await body(c);
      if (typeof pinned !== "boolean")
        return c.json({ error: "pinned must be a boolean" }, 400);
      const chatId = resolveChatId(c.req.param("chatId")!);
      if (!profile(c).chats.get(chatId)) return c.json({ error: "Chat not found" }, 404);
      return c.json(profile(c).chats.setPinned(chatId, pinned));
    });
    app.put("/internal/chats/:chatId/mode", async (c) => {
      const { mode } = await body(c);
      if (mode !== "off" && mode !== "copilot")
        throw new Error("Mode must be off or copilot");
      const chatId = resolveChatId(c.req.param("chatId")!);
      if (!profile(c).chats.get(chatId)) return c.json({ error: "Chat not found" }, 404);
      return c.json(profile(c).chats.setMode(chatId, mode));
    });
    // Recent group messages stored without a sender are asked for again, at
    // most once every ten minutes per chat; the copies fill the sender in.
    const repairs = new Map<string, number>();
    app.post("/internal/chats/:chatId/repair-senders", async (c) => {
      const chatId = resolveChatId(c.req.param("chatId")!);
      const p = profile(c);
      const anchor = p.messages.senderRepairAnchor(chatId);
      const key = p.id + " " + chatId;
      if (!anchor || Date.now() - (repairs.get(key) ?? 0) < 10 * 60_000)
        return c.json({ requested: false });
      repairs.set(key, Date.now());
      await p.provider.requestHistory(anchor, 50);
      return c.json({ requested: true });
    });
    // Older messages than this device has are asked of the phone; they arrive
    // later as history. At most once a minute per chat.
    const older = new Map<string, number>();
    app.post("/internal/chats/:chatId/older", async (c) => {
      const chatId = resolveChatId(c.req.param("chatId")!);
      const p = profile(c);
      const oldest = p.messages.oldest(chatId);
      const key = p.id + " " + chatId;
      if (!oldest || Date.now() - (older.get(key) ?? 0) < 60_000)
        return c.json({ requested: false });
      older.set(key, Date.now());
      await p.provider.requestHistory(oldest, 50);
      return c.json({ requested: true });
    });
    app.post("/internal/chats/:chatId/draft", async (c) =>
      c.json(await profile(c).copilot.generate(resolveChatId(c.req.param("chatId")!))),
    );
    app.post("/internal/drafts/:id/send", async (c) => {
      const data = await body(c);
      return c.json(
        await profile(c).copilot.approve(c.req.param("id"), string(data.text, "text")),
      );
    });
    app.delete("/internal/drafts/:id", (c) => {
      if (!profile(c).drafts.dismiss(c.req.param("id")))
        return c.json({ error: "Draft cannot be dismissed" }, 409);
      return c.json({ success: true });
    });
    app.post("/internal/broadcasts", async (c) => {
      const data = await body(c);
      if (!Array.isArray(data.recipients))
        throw new Error("Invalid recipients");
      return c.json(
        profile(c).broadcasts.create({
          name: string(data.name, "broadcast name", 120),
          minDelay: Number(data.minDelay),
          maxDelay: Number(data.maxDelay),
          recipients: data.recipients.map((r: unknown) => {
            if (!r || typeof r !== "object")
              throw new Error("Invalid recipients");
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
      c.json(profile(c).broadcasts.get(c.req.param("id"))),
    );
    app.post("/internal/broadcasts/:id/export", (c) =>
      c.json(profile(c).broadcasts.export(c.req.param("id"))),
    );
    for (const action of ["pause", "resume", "cancel"] as const)
      app.post(`/internal/broadcasts/:id/${action}`, (c) =>
        c.json(profile(c).broadcasts[action](c.req.param("id"))),
      );
    app.delete("/internal/broadcasts/:id", (c) => {
      profile(c).broadcasts.remove(c.req.param("id"));
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
      // Absent or null: every profile, including ones added later.
      let profiles: string[] | null = null;
      if (data.profiles !== undefined && data.profiles !== null) {
        const known = new Set(s.profiles.list().map((p) => p.id));
        if (
          !Array.isArray(data.profiles) ||
          !data.profiles.length ||
          data.profiles.some((p) => typeof p !== "string" || !known.has(p))
        )
          throw new Error("Choose valid profiles for this API key");
        profiles = [...new Set(data.profiles as string[])];
      }
      return c.json(
        s.keys.create(
          string(data.name, "key name", 80),
          data.permissions as Permission[],
          profiles,
        ),
      );
    });
    app.delete("/internal/keys/:id", (c) => {
      s.keys.revoke(c.req.param("id"));
      return c.json({ success: true });
    });
  }
  app.onError((error, c) => {
    if (error instanceof HTTPException)
      return c.json(
        { error: error.message },
        error.status as ContentfulStatusCode,
      );
    s.log("error", "api.request.failed");
    const safe =
      /^(Secure storage |Invalid |Media |Attachment |Expected |Use |Text must |WhatsApp is disconnected|WhatsApp did not|WhatsApp returned|OpenRouter |Add an OpenRouter|AI reply|Enable Copilot|A draft is|No recent |Copilot |Draft |Reply must|Context size|Mode must|Choose valid|Cloudflare |The Cloudflare|Broadcast |Automation |Group import |Profile )/.test(
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
