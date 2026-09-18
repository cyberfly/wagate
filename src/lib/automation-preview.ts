import type { GroupInfo, GroupAutomation, AutomationPost } from "./api";
import {
  nextRun,
  validateAutomation,
} from "../../sidecar/src/automation/schedule";
export const previewGroups: GroupInfo[] = [
  {
    id: "120363000000000001@g.us",
    name: "AI for business",
    memberCount: 148,
    isAdmin: true,
  },
  {
    id: "120363000000000002@g.us",
    name: "Marketing circle",
    memberCount: 86,
    isAdmin: true,
  },
  {
    id: "120363000000000003@g.us",
    name: "Founders Malaysia",
    memberCount: 212,
    isAdmin: true,
  },
  {
    id: "120363000000000004@g.us",
    name: "Design community",
    memberCount: 64,
    isAdmin: true,
  },
  {
    id: "120363000000000005@g.us",
    name: "Learning together",
    memberCount: 37,
    isAdmin: true,
  },
  {
    id: "120363000000000006@g.us",
    name: "Neighbourhood chat",
    memberCount: 52,
    isAdmin: false,
  },
];
export const previewAutomations: GroupAutomation[] = [
  {
    chatId: previewGroups[0].id,
    groupName: previewGroups[0].name,
    topics:
      "Practical AI tools for small businesses and relevant technology updates",
    instructions:
      "Write in Bahasa Melayu. Keep it practical, under 150 words, and end with a discussion question.",
    source: "mixed",
    delivery: "approval",
    timeZone: "Asia/Kuala_Lumpur",
    schedule: {
      kind: "weekly",
      weekdays: [1, 3, 5],
      times: ["09:00", "18:00"],
    },
    enabled: false,
    nextRunAt: null,
    updatedAt: Date.now(),
    revision: 1,
  },
];
export const previewAutomationPosts: AutomationPost[] = [];
export function automationPreviewRequest(
  path: string,
  method: string,
  data: Record<string, unknown> | undefined,
  onSend: (id: string, text: string) => unknown,
) {
  if (path === "/internal/groups")
    return { groups: previewGroups.map((g) => ({ ...g })) };
  const [, , resource, rawId, action] = path.split("/");
  const id = decodeURIComponent(rawId);
  if (resource === "automation-posts") {
    const post = previewAutomationPosts.find((p) => p.id === id);
    if (!post || post.status !== "pending")
      throw new Error("Automation post is not awaiting approval");
    if (method === "DELETE") post.status = "dismissed";
    else if (action === "approve") {
      const text = String(data?.text || "").trim();
      if (!text) throw new Error("Automation post is empty");
      post.text = text;
      post.status = "sent";
      post.sentAt = Date.now();
      post.messageId = crypto.randomUUID();
      onSend(post.chatId, text);
    }
    return { ...post };
  }
  const old = previewAutomations.find((c) => c.chatId === id);
  const group = previewGroups.find((g) => g.id === id && g.isAdmin);
  if (!group) throw new Error("Automation requires an admin group");
  if (action === "preview") {
    if (!old) throw new Error("Save this group’s settings first");
    if (
      previewAutomationPosts.some(
        (p) => p.chatId === id && p.status === "pending",
      )
    )
      throw new Error("A draft is already waiting for this group");
    const post: AutomationPost = {
      id: crypto.randomUUID(),
      chatId: id,
      groupName: group.name,
      status: "pending",
      text: `✧ Sample post for ${group.name}\n\nTry one small experiment this week: choose a routine task, use an AI tool to draft a first version, and review the result before sharing it.\n\nYour topics: ${old.topics}\n\nWhat task would you try first?\n\n(UI preview only — no live research or AI request was made.)`,
      error: null,
      scheduledFor: null,
      createdAt: Date.now(),
      sentAt: null,
      messageId: null,
      providerMessageId: null,
    };
    previewAutomationPosts.unshift(post);
    return { ...post };
  }
  const input = validateAutomation(
    action === "pause"
      ? { ...old, enabled: false }
      : action === "resume"
        ? { ...old, enabled: true }
        : data,
  );
  const c: GroupAutomation = {
    ...input,
    chatId: id,
    groupName: group.name,
    nextRunAt: input.enabled ? nextRun(input, Date.now()) : null,
    updatedAt: Date.now(),
    revision: (old?.revision || 0) + 1,
  };
  if (old) previewAutomations.splice(previewAutomations.indexOf(old), 1, c);
  else previewAutomations.push(c);
  return { ...c };
}
