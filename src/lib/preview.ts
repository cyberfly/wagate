// Development-only fixture. Dynamically imported only in Vite preview mode.
import {
  automationPreviewRequest,
  previewAutomations,
  previewAutomationPosts,
  previewGroups,
} from "./automation-preview";
import type {
  Snapshot,
  Message,
  Draft,
  Chat,
  TunnelState,
  Broadcast,
  BroadcastEvent,
  BroadcastRecipient,
  GroupImport,
  Profile,
} from "./api";
const now = Date.now();
let chats: Chat[] = [
  {
    id: "60111111111@s.whatsapp.net",
    provider: "whatsapp",
    name: "Ali Rahman",
    type: "direct",
    lastMessageAt: now,
    aiMode: "copilot",
    pinned: false,
    archived: false,
  },
  {
    id: "60222222222@s.whatsapp.net",
    provider: "whatsapp",
    name: "Design team",
    unreadCount: 3,
    type: "direct",
    lastMessageAt: now - 3600000,
    aiMode: "off",
    pinned: true,
    archived: false,
  },
  {
    id: "60333333333@s.whatsapp.net",
    provider: "whatsapp",
    name: "Sarah Lim",
    type: "direct",
    lastMessageAt: now - 7200000,
    aiMode: "off",
    pinned: false,
    archived: false,
  },
  {
    id: "60444444444@s.whatsapp.net",
    provider: "whatsapp",
    name: "Old supplier",
    type: "direct",
    lastMessageAt: now - 86400000 * 30,
    aiMode: "off",
    pinned: false,
    archived: true,
  },
];
// Mirrors the sidecar's order: pinned first, then by activity, archived last.
chats.sort(
  (a, b) =>
    Number(a.archived) - Number(b.archived) ||
    Number(b.pinned) - Number(a.pinned) ||
    (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0),
);
const ali = chats.find((c) => c.name === "Ali Rahman")!;
let messages: Message[] = [
  {
    id: "sample-1",
    provider: "whatsapp",
    providerMessageId: "sample-1",
    chatId: ali.id,
    senderId: ali.id,
    direction: "incoming",
    type: "text",
    text: "Hey! Do you have time to go over the proposal tomorrow?",
    timestamp: now - 180000,
  },
  {
    id: "sample-2",
    provider: "whatsapp",
    providerMessageId: "sample-2",
    chatId: ali.id,
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
    chatId: ali.id,
    senderId: ali.id,
    direction: "incoming",
    type: "text",
    text: "Great. Would 2 pm work for you?",
    timestamp: now,
  },
];
// Attachments, a reply, reactions, ticks, an edit and a deletion, as WhatsApp
// shows them. Their bytes are drawn when first opened.
const sample = (n: number, m: Partial<Message>, minutesAgo: number): Message => ({
  id: `media-${n}`,
  provider: "whatsapp",
  providerMessageId: `media-${n}`,
  chatId: ali.id,
  senderId: ali.id,
  direction: "incoming",
  type: "text",
  timestamp: now - minutesAgo * 60000,
  reactions: [],
  ...m,
});
messages.unshift(
  sample(1, { type: "image", text: "Whiteboard from today’s session", media: { mimetype: "image/png", width: 1200, height: 800, size: 184000 } }, 26 * 60),
  sample(2, { direction: "outgoing", senderId: "me", status: "read", text: "Thanks! *Very* helpful — I’ll share it with the team. Notes are at https://example.com/notes", quoted: { providerMessageId: "media-1", messageId: "media-1", fromMe: false, senderId: ali.id, senderName: "Ali Rahman", type: "image", text: "Whiteboard from today’s session" }, reactions: [{ emoji: "👍", count: 1, mine: false }] }, 26 * 60 - 2),
  sample(3, { type: "document", text: "Proposal-v3.pdf", media: { mimetype: "application/pdf", fileName: "Proposal-v3.pdf", size: 482000 } }, 25 * 60),
  sample(4, { type: "audio", media: { mimetype: "audio/ogg; codecs=opus", ptt: true, seconds: 14 }, reactions: [{ emoji: "❤️", count: 1, mine: true }] }, 24 * 60),
  sample(5, { direction: "outgoing", senderId: "me", status: "delivered", text: "Sent you the _final_ figures.", editedAt: now - 23 * 3600000 }, 23 * 60 + 30),
  sample(6, { deletedAt: now - 23 * 3600000 }, 23 * 60),
  sample(7, { type: "location", text: "Menara KL · Jalan Puncak", media: { latitude: 3.15278, longitude: 101.70361 } }, 22 * 60),
);
messages = messages.map((m) =>
  m.id === "sample-2" ? { ...m, status: "read" } : m.id === "sample-3" ? { ...m, quoted: { providerMessageId: "sample-1", messageId: "sample-1", fromMe: false, senderId: ali.id, senderName: "Ali Rahman", type: "text", text: "Hey! Do you have time to go over the proposal tomorrow?" } } : m,
);
/** Bytes for attachments sent in the sample UI, as base64. */
const sentMedia = new Map<string, { mimetype: string; data: string }>();
function drawImage(label: string, preview: boolean) {
  const canvas = document.createElement("canvas");
  canvas.width = preview ? 48 : 1200;
  canvas.height = preview ? 32 : 800;
  const g = canvas.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, canvas.width, canvas.height);
  grad.addColorStop(0, "#61afef");
  grad.addColorStop(1, "#c678dd");
  g.fillStyle = grad;
  g.fillRect(0, 0, canvas.width, canvas.height);
  if (!preview) {
    g.fillStyle = "#ffffffdd";
    g.font = "bold 64px sans-serif";
    g.fillText(label, 80, 420);
  }
  return canvas.toDataURL(preview ? "image/jpeg" : "image/png").split(",")[1]!;
}
/** A short tone as WAV, standing in for a voice note. */
function tone() {
  const rate = 8000, samples = rate * 2;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const text = (o: number, t: string) => [...t].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, 36 + samples, true); text(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate, true); view.setUint16(32, 1, true);
  view.setUint16(34, 8, true); text(36, "data"); view.setUint32(40, samples, true);
  for (let i = 0; i < samples; i++) bytes[44 + i] = 128 + Math.round(40 * Math.sin((i / rate) * 2 * Math.PI * 440));
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}
function previewMedia(id: string, preview: boolean) {
  const m = messages.find((x) => x.id === id);
  if (!m) throw new Error("Invalid message");
  const sent = sentMedia.get(id);
  if (sent && !preview) return { ...sent, complete: true };
  if (m.type === "image" || m.type === "video" || sent)
    return { mimetype: preview ? "image/jpeg" : "image/png", data: drawImage(m.text || "Photo", preview), complete: !preview };
  if (m.type === "audio") return { mimetype: "audio/wav", data: tone(), complete: true };
  if (m.type === "document") return { mimetype: "application/pdf", data: btoa("%PDF-1.4 sample"), complete: true };
  throw new Error("Media is unavailable for this message");
}
// A community group: members named, known only by number, and one message
// synced without its sender.
const community: Chat = {
  id: "120363000000000009@g.us",
  provider: "whatsapp",
  name: "AI learners",
  type: "group",
  lastMessageAt: now - 60000,
  aiMode: "off",
  pinned: false,
  archived: false,
};
chats.splice(1, 0, community);
const groupMessage = (
  n: number,
  sender: Partial<Message>,
  text: string,
  minutesAgo: number,
): Message => ({
  id: `group-${n}`,
  provider: "whatsapp",
  providerMessageId: `group-${n}`,
  chatId: community.id,
  senderId: community.id,
  direction: "incoming",
  type: "text",
  text,
  timestamp: now - minutesAgo * 60000,
  ...sender,
});
const nadia = { senderId: "100000000000001@lid", senderName: "Nadia", senderPhone: "60155550101@s.whatsapp.net" },
  unnamed = { senderId: "60155550102@s.whatsapp.net", senderName: null, senderPhone: "60155550102@s.whatsapp.net" };
messages.push(
  groupMessage(1, {}, "Is there a recording of last night’s class?", 30),
  groupMessage(2, nadia, "Can the plugin technique work in ChatGPT too?", 12),
  groupMessage(3, nadia, "I haven’t tried it there yet.", 11),
  groupMessage(4, unnamed, "Check your email for the link.", 5),
  groupMessage(6, { ...nadia, forwarded: true, mentions: [{ id: "60155550102@s.whatsapp.net", name: null }, { id: "100000000000001@lid", name: "Nadia" }] }, "@60155550102 thanks! Forwarding the slides here for @100000000000001 too.", 3),
  groupMessage(5, { senderId: "me", direction: "outgoing" }, "The recording is up — see the pinned post.", 1),
);
let drafts: Draft[] = [
  {
    id: "sample-draft",
    chatId: ali.id,
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
  hasKey: true,
  port: 8787,
};
const keys: {
  id: string;
  name: string;
  permissions: string;
  profiles: string | null;
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
let broadcasts: {
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
      recipients: recipients.map((r, i): BroadcastRecipient => ({
        position: i + 1,
        chatId: r.to + "@s.whatsapp.net",
        label: r.label || r.to,
        text: r.text,
        status: "pending",
        messageId: null,
        error: null,
        attemptedAt: null,
        sentAt: null,
      })),
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
let groupImports: GroupImport[] = [];
/** Adds one batch of five per poll; some people need an invite or are already in. */
function advanceGroupImport() {
  const job = groupImports.find((j) => j.status === "running");
  if (!job) return;
  const batch = job.members.filter((m) => m.status === "pending").slice(0, 5);
  for (const m of batch) {
    const n = job.members.indexOf(m) + 1;
    if (n % 7 === 0) {
      m.status = "invite";
      m.error = "Their privacy settings need an invite link";
    } else m.status = n % 11 === 0 ? "already" : "added";
  }
  if (!job.members.some((m) => m.status === "pending")) job.status = "completed";
  job.updatedAt = Date.now();
}
function groupImportRequest(path: string, method: string, data?: Record<string, unknown>) {
  const [, , , id, action] = path.split("/");
  if (!id && method === "POST") {
    if (groupImports.some((j) => j.status === "running"))
      throw new Error("Group import is already running. Wait for it or cancel it first.");
    const group = previewGroups.find((g) => g.id === data?.groupId);
    if (!group?.isAdmin)
      throw new Error("Group import needs you to be an admin of this group on WhatsApp");
    const job: GroupImport = {
      id: crypto.randomUUID(),
      groupId: group.id,
      groupName: group.name,
      status: "running",
      minDelay: Number(data?.minDelay),
      maxDelay: Number(data?.maxDelay),
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      members: (data?.members as { phone: string; label: string }[]).map((m) => ({
        phone: m.phone,
        label: m.label || m.phone,
        status: "pending",
        error: null,
      })),
    };
    groupImports.unshift(job);
    return job;
  }
  const job = groupImports.find((j) => j.id === id);
  if (!job) throw new Error("Group import not found");
  if (action === "cancel") {
    job.status = "cancelled";
    for (const m of job.members) if (m.status === "pending") m.status = "cancelled";
    return job;
  }
  groupImports.splice(groupImports.indexOf(job), 1);
  return { success: true };
}
// Each fictional number has its own chats, messages, drafts, broadcasts,
// imports and connection; requests swap the module's data to the one asked for.
interface PreviewProfile {
  profile: Omit<Profile, "status">;
  chats: Chat[];
  messages: Message[];
  drafts: Draft[];
  broadcasts: typeof broadcasts;
  groupImports: GroupImport[];
  connection: Snapshot["connection"];
}
const shopChat = (n: number, name: string, minutesAgo: number): Chat => ({
  id: `6017000000${n}@s.whatsapp.net`,
  provider: "whatsapp",
  name,
  type: "direct",
  lastMessageAt: now - minutesAgo * 60000,
  aiMode: "off",
  pinned: false,
  archived: false,
});
const shopChats = [shopChat(1, "Mei Ling", 8), shopChat(2, "Hafiz Catering", 95)];
const shopMessage = (
  chat: Chat,
  n: number,
  direction: Message["direction"],
  text: string,
  minutesAgo: number,
): Message => ({
  id: `shop-${n}`,
  provider: "whatsapp",
  providerMessageId: `shop-${n}`,
  chatId: chat.id,
  senderId: direction === "incoming" ? chat.id : "me",
  direction,
  type: "text",
  text,
  timestamp: now - minutesAgo * 60000,
});
const previewProfiles: PreviewProfile[] = [
  {
    profile: { id: "default", name: "Main", account: connection.account ?? null, createdAt: 0, isDefault: true },
    chats,
    messages,
    drafts,
    broadcasts,
    groupImports,
    connection,
  },
  {
    profile: { id: "p_5a1e5f0b7c2d", name: "Shop", account: "60100000002@s.whatsapp.net", createdAt: now - 86400000, isDefault: false },
    chats: shopChats,
    messages: [
      shopMessage(shopChats[0], 1, "incoming", "Is the large tote still in stock?", 10),
      shopMessage(shopChats[0], 2, "outgoing", "Yes! Two left in navy.", 9),
      shopMessage(shopChats[0], 3, "incoming", "I’ll take one, please.", 8),
      shopMessage(shopChats[1], 4, "incoming", "Can we confirm Friday’s order?", 95),
    ],
    drafts: [],
    broadcasts: [],
    groupImports: [],
    connection: { status: "connected", account: "60100000002@s.whatsapp.net" },
  },
  {
    profile: { id: "p_9c03d4e1aa60", name: "Support", account: null, createdAt: now - 3600000, isDefault: false },
    chats: [],
    messages: [],
    drafts: [],
    broadcasts: [],
    groupImports: [],
    connection: { status: "disconnected" },
  },
];
let currentProfile = previewProfiles[0];
function useProfile(id: string) {
  currentProfile.connection = connection;
  const next = previewProfiles.find((p) => p.profile.id === id);
  if (!next) throw new Error("Profile not found");
  currentProfile = next;
  ({ chats, messages, drafts, broadcasts, groupImports, connection } = next);
}
function profileSummary(p: PreviewProfile): Profile {
  const state = p === currentProfile ? connection : p.connection;
  return { ...p.profile, account: state.account ?? p.profile.account, status: state.status };
}
function profileName(value: unknown, except?: string) {
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!name || name.length > 40) throw new Error("Profile name must be 1–40 characters");
  if (previewProfiles.some((p) => p.profile.id !== except && p.profile.name.toLowerCase() === name.toLowerCase()))
    throw new Error(`Profile “${name}” already exists`);
  return name;
}
function profilesRequest(path: string, method: string, data?: Record<string, unknown>) {
  const id = path.split("/")[3];
  if (!id && method === "POST") {
    const name = profileName(data?.name);
    if (previewProfiles.length >= 10) throw new Error("Profile limit reached: Wagate runs up to 10 numbers");
    const hex = [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const entry: PreviewProfile = {
      profile: { id: "p_" + hex, name, account: null, createdAt: Date.now(), isDefault: false },
      chats: [],
      messages: [],
      drafts: [],
      broadcasts: [],
      groupImports: [],
      connection: { status: "disconnected" },
    };
    previewProfiles.push(entry);
    return profileSummary(entry);
  }
  if (!id) return { profiles: previewProfiles.map(profileSummary) };
  const entry = previewProfiles.find((p) => p.profile.id === id);
  if (!entry) throw new Error("Profile not found");
  if (method === "PUT") {
    entry.profile.name = profileName(data?.name, id);
    return profileSummary(entry);
  }
  if (entry.profile.isDefault)
    throw new Error(`Profile “${entry.profile.name}” is the main profile and cannot be removed; reset its session instead`);
  const unlinked = (entry === currentProfile ? connection : entry.connection).status === "connected";
  previewProfiles.splice(previewProfiles.indexOf(entry), 1);
  if (entry === currentProfile) useProfile("default");
  for (const key of keys) {
    if (!key.profiles) continue;
    const left = (JSON.parse(key.profiles) as string[]).filter((p) => p !== id);
    if (left.length) key.profiles = JSON.stringify(left);
    else key.revokedAt ??= Date.now();
  }
  return { success: true, unlinked };
}
export async function previewRequest(
  path: string,
  method: string,
  body: unknown,
): Promise<unknown> {
  const url = new URL(path, "http://preview.local");
  const data = body as Record<string, unknown> | undefined;
  // Routes below match the bare path; the profile only picks the data.
  const profile = url.searchParams.get("profile") || "default";
  url.searchParams.delete("profile");
  path = url.pathname + url.search;
  if (url.pathname.startsWith("/internal/profiles"))
    return profilesRequest(url.pathname, method, data);
  useProfile(profile);
  if (
    !currentProfile.profile.isDefault &&
    (url.pathname === "/internal/groups" ||
      url.pathname.startsWith("/internal/automations/") ||
      url.pathname.startsWith("/internal/automation-posts/"))
  )
    throw new Error("Group automation previews use the Main profile in the sample UI");
  if (
    url.pathname === "/internal/groups" ||
    url.pathname.startsWith("/internal/automations/") ||
    url.pathname.startsWith("/internal/automation-posts/")
  )
    return automationPreviewRequest(
      url.pathname,
      method,
      data,
      (chatId, text) => {
        const now = Date.now(),
          id = crypto.randomUUID();
        messages.push({
          id,
          provider: "whatsapp",
          providerMessageId: id,
          chatId,
          senderId: "me",
          direction: "outgoing",
          type: "text",
          text,
          timestamp: now,
        });
        const existing = chats.find((c) => c.id === chatId);
        if (existing) existing.lastMessageAt = now;
        else
          chats.unshift({
            id: chatId,
            provider: "whatsapp",
            name: previewGroups.find((g) => g.id === chatId)?.name || chatId,
            type: "group",
            lastMessageAt: now,
            aiMode: "off",
            pinned: false,
            archived: false,
          });
        return { success: true, messageId: id };
      },
    );
  if (url.pathname.startsWith("/internal/broadcasts"))
    return broadcastRequest(url.pathname, method, data);
  if (/^\/internal\/groups\/[^/]+\/participants$/.test(url.pathname))
    // Numbers ending in 7 stand in for people whose privacy needs an invite.
    return {
      results: (data?.phones as string[]).map((phone) =>
        phone.endsWith("7")
          ? { phone, status: "invite", error: "Their privacy settings need an invite link" }
          : { phone, status: "added" },
      ),
    };
  if (url.pathname.startsWith("/internal/group-imports"))
    return groupImportRequest(url.pathname, method, data);
  if (url.pathname === "/internal/snapshot") {
    advanceBroadcast();
    advanceGroupImport();
    const id = url.searchParams.get("chatId");
    return {
      health: {
        status: "ok",
        database: "connected",
        version: "0.2.0",
        ai: config.hasKey ? "configured" : "not_configured",
      },
      profile: profileSummary(currentProfile),
      profiles: previewProfiles.map(profileSummary),
      connection,
      chats: [...chats]
        .sort(
          (a, b) =>
            Number(a.archived) - Number(b.archived) ||
            Number(b.pinned) - Number(a.pinned) ||
            (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0),
        )
        .map((c) => ({
          ...c,
          lastMessage: messages.filter((m) => m.chatId === c.id).at(-1)?.text,
        })),
      messages: messages.filter((m) => m.chatId === id),
      drafts: drafts.filter((d) => d.chatId === id && d.status === "pending"),
      processing: [],
      tunnel,
      broadcasts: broadcasts.map(summary),
      automations: currentProfile.profile.isDefault
        ? previewAutomations.map((c) => ({ ...c }))
        : [],
      automationPosts: currentProfile.profile.isDefault
        ? previewAutomationPosts.map((p) => ({ ...p }))
        : [],
      groupImports: groupImports.map((j) => ({
        ...j,
        members: j.members.map((m) => ({ ...m })),
      })),
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
        profiles: data?.profiles ? JSON.stringify(data.profiles) : null,
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
    // A new preview profile "links" a fictional number on first connect.
    const account =
      currentProfile.profile.account ??
      (currentProfile.profile.isDefault
        ? undefined
        : `6010000${String(previewProfiles.indexOf(currentProfile) + 1).padStart(4, "0")}@s.whatsapp.net`);
    if (path.endsWith("/connect")) currentProfile.profile.account = account ?? null;
    if (path.endsWith("/logout")) currentProfile.profile.account = null;
    connection = path.endsWith("/connect")
      ? { status: "connected", account }
      : { status: "disconnected" };
    return connection;
  }
  if (path.endsWith("/pin")) {
    const chat = chats.find(
      (c) => c.id === decodeURIComponent(path.split("/")[3]),
    );
    if (!chat) throw new Error("Chat not found");
    chat.pinned = data?.pinned === true;
    return { ...chat };
  }
  if (path.endsWith("/mode")) {
    const chat = chats.find(
      (c) => c.id === decodeURIComponent(path.split("/")[3]),
    );
    if (chat) chat.aiMode = data?.mode === "copilot" ? "copilot" : "off";
    return chat;
  }
  const messageRoute = url.pathname.match(/^\/(?:internal|v1)\/messages\/([^/]+)\/(media|save|react)$/);
  if (messageRoute) {
    const id = decodeURIComponent(messageRoute[1]!);
    if (messageRoute[2] === "media") {
      await new Promise((r) => setTimeout(r, 400));
      return previewMedia(id, url.searchParams.has("preview"));
    }
    const m = messages.find((x) => x.id === id);
    if (!m) throw new Error("Invalid message");
    if (messageRoute[2] === "save")
      return { path: "~/Downloads/" + (m.media?.fileName || `WhatsApp ${m.type} sample`) };
    const emoji = String(data?.emoji ?? "");
    const rest = (m.reactions ?? [])
      .map((r) => (r.mine ? { ...r, count: r.count - 1, mine: false } : r))
      .filter((r) => r.count > 0);
    const same = rest.find((r) => r.emoji === emoji);
    if (same) Object.assign(same, { count: same.count + 1, mine: true });
    else if (emoji) rest.push({ emoji, count: 1, mine: true });
    m.reactions = rest;
    return { success: true, message: m };
  }
  if (url.pathname === "/internal/open") return { success: true };
  if (/^\/internal\/chats\/[^/]+\/read$/.test(url.pathname)) {
    const chat = chats.find((c) => c.id === decodeURIComponent(url.pathname.split("/")[3]!));
    const read = chat?.unreadCount ?? 0;
    if (chat) chat.unreadCount = 0;
    return { read };
  }
  const own = url.pathname.match(/^\/v1\/messages\/(?!send(?:-media)?$)([^/]+)(\/forward)?$/);
  if (own) {
    const m = messages.find((x) => x.id === decodeURIComponent(own[1]!));
    if (!m) throw new Error("Invalid message");
    if (own[2]) {
      const sent = (data?.chatIds as string[]).map((chatId) => {
        const copy: Message = { ...m, id: crypto.randomUUID(), chatId, senderId: "me", direction: "outgoing", forwarded: true, quoted: null, reactions: [], status: "sent", editedAt: null, timestamp: Date.now() };
        if (sentMedia.has(m.id)) sentMedia.set(copy.id, sentMedia.get(m.id)!);
        messages.push(copy);
        return copy;
      });
      return { success: true, messages: sent };
    }
    if (method === "PUT") Object.assign(m, { text: String(data?.text), editedAt: Date.now() });
    else if (url.searchParams.get("for") === "everyone") Object.assign(m, { deletedAt: Date.now(), text: undefined, media: null });
    else messages = messages.filter((x) => x !== m);
    return { success: true, message: m };
  }
  if (url.pathname.endsWith("/older")) return { requested: true };
  /** The reply context a sample send carries. */
  const quote = (replyTo: unknown): Message["quoted"] => {
    const q = messages.find((m) => m.id === replyTo);
    return q
      ? { providerMessageId: q.providerMessageId, messageId: q.id, fromMe: q.direction === "outgoing", senderId: q.senderId, senderName: q.senderName ?? null, type: q.type, text: q.text }
      : null;
  };
  if (path === "/v1/messages/send-media") {
    const id = crypto.randomUUID();
    const mimetype = String(data?.mimetype);
    const type: Message["type"] = /^image\/(jpeg|png|webp)$/.test(mimetype) ? "image" : mimetype === "video/mp4" ? "video" : mimetype.startsWith("audio/") ? "audio" : "document";
    sentMedia.set(id, { mimetype, data: String(data?.data) });
    messages.push({
      id,
      provider: "whatsapp",
      providerMessageId: id,
      chatId: String(data?.chatId),
      senderId: "me",
      direction: "outgoing",
      type,
      text: (data?.caption as string | undefined) || (type === "document" ? String(data?.fileName) : undefined),
      media: { mimetype, fileName: type === "document" ? String(data?.fileName) : undefined, size: Math.round((String(data?.data).length * 3) / 4) },
      quoted: quote(data?.replyTo),
      status: "sent",
      reactions: [],
      timestamp: Date.now(),
    });
    return { success: true, messageId: id };
  }
  if (path === "/v1/messages/send" || path.endsWith("/send")) {
    const draft = drafts.find((d) => d.id === path.split("/")[3]);
    const id = crypto.randomUUID();
    const chatId = draft?.chatId || String(data?.chatId);
    messages.push({
      id,
      provider: "whatsapp",
      providerMessageId: id,
      chatId,
      senderId: "me",
      direction: "outgoing",
      type: "text",
      text: String(data?.text),
      quoted: quote(data?.replyTo),
      status: "sent",
      reactions: [],
      timestamp: Date.now(),
    });
    const chat = chats.find((c) => c.id === chatId);
    if (chat) chat.lastMessageAt = Date.now();
    if (draft) draft.status = "sent";
    return { success: true, messageId: id };
  }
  if (path.startsWith("/internal/drafts/")) {
    const draft = drafts.find((d) => d.id === path.split("/")[3]);
    if (draft) draft.status = "dismissed";
    return {};
  }
  if (path.endsWith("/draft")) return drafts[0];
  if (path.endsWith("/repair-senders")) return { requested: false };
  throw new Error("This action is not available in the sample UI");
}
