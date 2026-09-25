import { invoke, isTauri } from "@tauri-apps/api/core";
export async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  if (import.meta.env.DEV && import.meta.env.MODE === "preview") {
    const { previewRequest } = await import("./preview");
    return previewRequest(path, method, body) as T;
  }
  if (!isTauri())
    throw new Error(
      "Open Wagate as a desktop app with bun run desktop:dev. For a sample UI, use bun run preview:ui.",
    );
  return invoke<T>("gateway_request", { path, method, body: body ?? null });
}
export type {
  Chat,
  Message,
  Draft,
  ConnectionState,
  Broadcast,
  BroadcastEvent,
  BroadcastRecipient,
  GroupInfo,
  GroupImport,
  GroupImportMember,
} from "../../sidecar/src/messaging/types";
export type {
  AutomationPost,
  AutomationSchedule,
  GroupAutomation,
  GroupAutomationInput,
} from "../../sidecar/src/automation/types";
import type {
  AutomationPost,
  GroupAutomation,
} from "../../sidecar/src/automation/types";
import type {
  Chat,
  Message,
  Draft,
  ConnectionState,
  Broadcast,
  GroupImport,
} from "../../sidecar/src/messaging/types";
export interface TunnelState {
  status: "off" | "installing" | "starting" | "online" | "error";
  url: string | null;
  error: string | null;
  installed: boolean;
  supported: boolean;
  progress: number | null;
}
export interface Snapshot {
  health: { status: string; database: string; version: string; ai: string };
  connection: ConnectionState;
  chats: Chat[];
  messages: Message[];
  drafts: Draft[];
  processing: string[];
  tunnel: TunnelState | null;
  broadcasts: Broadcast[];
  automations: GroupAutomation[];
  automationPosts: AutomationPost[];
  groupImports: GroupImport[];
  alerts: { id: number; error: string }[];
}
export const tunnelLabel: Record<string, string> = {
  off: "Private",
  installing: "Downloading cloudflared",
  starting: "Opening tunnel",
  online: "Public",
  error: "Needs attention",
};
export const statusLabel: Record<string, string> = {
  disconnected: "Disconnected",
  connecting: "Connecting",
  qr_required: "Scan QR code",
  connected: "Connected",
  reconnecting: "Reconnecting",
  auth_error: "Session needs attention",
};
export function displayName(id: string) {
  return id.split("@")[0];
}
/** A chat's name, or its number when WhatsApp and your contacts know none. */
export function chatTitle(chat: Pick<Chat, "id" | "name">) {
  return chat.name && chat.name !== chat.id ? chat.name : displayName(chat.id);
}
/** `+60123456789` for phone-number chats; other ids are not dialable. */
export function phoneLabel(id: string) {
  return id.endsWith("@s.whatsapp.net")
    ? "+" + displayName(id)
    : displayName(id);
}
export function initials(title: string) {
  const words = title.match(/\p{L}[\p{L}\p{M}'’-]*/gu);
  return words
    ? words
        .slice(0, 2)
        .map((w) => w[0])
        .join("")
        .toUpperCase()
    : title.slice(0, 2);
}
