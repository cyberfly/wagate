// Development-only fixture. Dynamically imported only in Vite preview mode.
import type { Snapshot, Message, Draft, Chat } from "./api";
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
export async function previewRequest(
  path: string,
  method: string,
  body: unknown,
): Promise<unknown> {
  const url = new URL(path, "http://preview.local");
  const data = body as Record<string, unknown> | undefined;
  if (url.pathname === "/internal/snapshot") {
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
      alerts: [],
    } satisfies Snapshot;
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
