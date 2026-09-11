// Development-only fixture. Dynamically imported only in Vite preview mode.
import type {
  Snapshot,
  Message,
  Draft,
  Chat,
  TunnelState,
  Broadcast,
  BroadcastEvent,
  BroadcastRecipient,
} from "./api";
const now = Date.now();
const chats: Chat[] = [
  {
    id: "60111111111@s.whatsapp.net",
    provider: "whatsapp",
    name: "Ali Rahman",
    type: "direct",
    lastMessageAt: now,
    aiMode: "copilot",
  },
  {
    id: "60222222222@s.whatsapp.net",
    provider: "whatsapp",
    name: "Design team",
    type: "direct",
    lastMessageAt: now - 3600000,
    aiMode: "off",
  },
  {
    id: "60333333333@s.whatsapp.net",
    provider: "whatsapp",
    name: "Sarah Lim",
    type: "direct",
    lastMessageAt: now - 7200000,
    aiMode: "off",
  },
];
const messages: Message[] = [
  {
    id: "sample-1",
    provider: "whatsapp",
    providerMessageId: "sample-1",
    chatId: chats[0].id,
    senderId: chats[0].id,
    direction: "incoming",
    type: "text",
    text: "Hey! Do you have time to go over the proposal tomorrow?",
    timestamp: now - 180000,
  },
  {
    id: "sample-2",
    provider: "whatsapp",
    providerMessageId: "sample-2",
    chatId: chats[0].id,
    senderId: "me",
    direction: "outgoing",
    type: "text",
    text: "Hi Ali, absolutely. The updated version is ready.",
    timestamp: now - 120000,
  },
  {
    id: "sample-3",
    provider: "whatsapp",
    providerMessageId: "sample-3",
    chatId: chats[0].id,
    senderId: chats[0].id,
    direction: "incoming",
    type: "text",
    text: "Great. Would 2 pm work for you?",
    timestamp: now,
  },
];
const drafts: Draft[] = [
  {
    id: "sample-draft",
    chatId: chats[0].id,
    sourceMessageId: "sample-3",
    text: "2 pm works for me. I’ll have the proposal ready for us to review. See you then!",
    status: "pending",
    createdAt: now,
  },
];
let connection: Snapshot["connection"] = {
  status: "connected",
  account: "60000000000@s.whatsapp.net",
};
let config = {
  ai: {
    model: "openai/gpt-4o-mini",
    systemPrompt:
      "Draft a helpful, concise reply. Return only the proposed reply.",
    contextSize: 20,
    guardEnabled: true,
  },
  hasKey: false,
  port: 8787,
};
const keys: {
  id: string;
  name: string;
  permissions: string;
  createdAt: number;
  lastUsedAt: null;
  revokedAt: number | null;
}[] = [];
let tunnel: TunnelState = {
  status: "off",
  url: null,
  error: null,
  installed: true,
  supported: true,
  progress: null,
};
const broadcasts: {
  broadcast: Omit<
    Broadcast,
    | "total"
    | "sent"
    | "delivered"
    | "failed"
    | "pending"
    | "uncertain"
    | "cancelled"
  >;
  recipients: BroadcastRecipient[];
  events: BroadcastEvent[];
}[] = [];
let eventId = 0;
function summary({ broadcast, recipients }: (typeof broadcasts)[number]) {
  const count = (...s: string[]) =>
    recipients.filter((r) => s.includes(r.status)).length;
  return {
    ...broadcast,
    total: recipients.length,
    sent: count("sent", "delivered", "read"),
    delivered: count("delivered", "read"),
    failed: count("failed"),
    pending: count("pending", "sending"),
    uncertain: count("uncertain"),
    cancelled: count("cancelled"),
  };
}
function record(
  entry: (typeof broadcasts)[number],
  type: BroadcastEvent["type"],
  detail: string | null = null,
  recipient?: BroadcastRecipient,
) {
  entry.events.push({
    id: ++eventId,
    at: Date.now(),
    type,
    position: recipient?.position ?? null,
    label: recipient?.label ?? null,
    chatId: recipient?.chatId ?? null,
    detail,
  });
  entry.broadcast.updatedAt = Date.now();
}
// Sends one recipient per UI poll instead of waiting for real pacing.
function advanceBroadcast() {
  const b = broadcasts.find((x) => x.broadcast.status === "running");
  if (!b) return;
  const next = b.recipients.find((r) => r.status === "pending");
  if (next) {
    next.status = "sent";
    next.attemptedAt = Date.now() - 400;
    next.sentAt = Date.now();
    next.messageId = crypto.randomUUID();
    record(b, "sent", null, next);
  } else {
    b.broadcast.status = "completed";
    record(b, "completed", `${summary(b).sent} sent`);
  }
}
function broadcastRequest(
  path: string,
  method: string,
  data: Record<string, unknown> | undefined,
) {
  if (path === "/internal/broadcasts" && method === "POST") {
    const now = Date.now();
    const recipients = data?.recipients as {
      to: string;
      label: string;
      text: string;
    }[];
    const entry = {
      broadcast: {
        id: crypto.randomUUID(),
        name: String(data?.name),
        status: "running" as Broadcast["status"],
        minDelay: Number(data?.minDelay),
        maxDelay: Number(data?.maxDelay),
        error: null,
        createdAt: now,
        updatedAt: now,
      },
      recipients: recipients.map(
        (r, i): BroadcastRecipient => ({
          position: i + 1,
          chatId: r.to + "@s.whatsapp.net",
          label: r.label || r.to,
          text: r.text,
          status: "pending",
          messageId: null,
          error: null,
          attemptedAt: null,
          sentAt: null,
        }),
      ),
      events: [],
    };
    broadcasts.unshift(entry);
    record(entry, "created", `${recipients.length} recipients`);
    return summary(entry);
  }
  const [, , , id, action] = path.split("/");
  const entry = broadcasts.find((b) => b.broadcast.id === id);
  if (!entry) throw new Error("Broadcast not found");
  const b = entry.broadcast;
  if (method === "DELETE") broadcasts.splice(broadcasts.indexOf(entry), 1);
  else if (action === "export")
    return {
      path: `~/Downloads/${b.name}-send-log.csv (preview: nothing saved)`,
    };
  else if (action === "pause") {
    b.status = "paused";
    record(entry, "paused");
  } else if (action === "resume") {
    b.status = "running";
    record(entry, "resumed");
  } else if (action === "cancel") {
    b.status = "cancelled";
    let skipped = 0;
    for (const r of entry.recipients)
      if (r.status === "pending") {
        r.status = "cancelled";
        skipped++;
      }
    record(entry, "cancelled", `${skipped} not sent`);
  } else
    return {
      broadcast: summary(entry),
      recipients: entry.recipients,
      events: entry.events,
    };
  return summary(entry);
}
export async function previewRequest(
  path: string,
  method: string,
  body: unknown,
): Promise<unknown> {
  const url = new URL(path, "http://preview.local");
  const data = body as Record<string, unknown> | undefined;
  if (url.pathname.startsWith("/internal/broadcasts"))
    return broadcastRequest(url.pathname, method, data);
  if (url.pathname === "/internal/snapshot") {
    advanceBroadcast();
    const id = url.searchParams.get("chatId");
    return {
      health: {
        status: "ok",
        database: "connected",
        version: "0.1.1",
        ai: config.hasKey ? "configured" : "not_configured",
      },
      connection,
      chats: [...chats],
      messages: messages.filter((m) => m.chatId === id),
      drafts: drafts.filter((d) => d.chatId === id && d.status === "pending"),
      processing: [],
      tunnel,
      broadcasts: broadcasts.map(summary),
      alerts: [],
    } satisfies Snapshot;
  }
  if (url.pathname.startsWith("/internal/tunnel")) {
    if (path === "/internal/tunnel/start")
      tunnel = {
        ...tunnel,
        status: "online",
        url: "https://sample-preview-gateway.trycloudflare.com",
        error: null,
      };
    if (path === "/internal/tunnel/stop")
      tunnel = { ...tunnel, status: "off", url: null, error: null };
    if (path === "/internal/tunnel/install")
      tunnel = { ...tunnel, installed: true };
    return { ...tunnel };
  }
  if (path === "/internal/settings") {
    if (method === "PUT") {
      config = {
        ...config,
        ai: {
          model: String(data?.model),
          systemPrompt: String(data?.systemPrompt),
          contextSize: Number(data?.contextSize),
          guardEnabled: data?.guardEnabled !== false,
        },
        hasKey: config.hasKey || !!data?.apiKey,
      };
    }
    return { ...config };
  }
  if (path === "/internal/settings/key") {
    config.hasKey = false;
    return { success: true };
  }
  if (path === "/internal/keys") {
    if (method === "POST") {
      const id = crypto.randomUUID();
      keys.push({
        id,
        name: String(data?.name),
        permissions: JSON.stringify(data?.permissions),
        createdAt: Date.now(),
        lastUsedAt: null,
        revokedAt: null,
      });
      return { key: "PREVIEW_ONLY_NOT_A_REAL_API_KEY" };
    }
    return { keys: [...keys] };
  }
  if (path.startsWith("/internal/keys/")) {
    const key = keys.find((k) => k.id === path.split("/").pop());
    if (key) key.revokedAt = Date.now();
    return {};
  }
  if (path.startsWith("/internal/connection/")) {
    connection = {
      status: path.endsWith("/connect") ? "connected" : "disconnected",
    };
    return connection;
  }
  if (path.endsWith("/mode")) {
    const chat = chats.find(
      (c) => c.id === decodeURIComponent(path.split("/")[3]),
    );
    if (chat) chat.aiMode = data?.mode === "copilot" ? "copilot" : "off";
    return chat;
  }
  if (path === "/v1/messages/send" || path.endsWith("/send")) {
    const draft = drafts.find((d) => d.id === path.split("/")[3]);
    const id = crypto.randomUUID();
    messages.push({
      ...messages[0],
      id,
      providerMessageId: id,
      chatId: draft?.chatId || String(data?.chatId),
      direction: "outgoing",
      text: String(data?.text),
      timestamp: Date.now(),
    });
    if (draft) draft.status = "sent";
    return { success: true, messageId: id };
  }
  if (path.startsWith("/internal/drafts/")) {
    const draft = drafts.find((d) => d.id === path.split("/")[3]);
    if (draft) draft.status = "dismissed";
    return {};
  }
  if (path.endsWith("/draft")) return drafts[0];
  throw new Error("This action is not available in the sample UI");
}
