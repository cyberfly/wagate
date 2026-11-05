import { invoke, isTauri } from "@tauri-apps/api/core";
/** The main profile, which every install has and which cannot be removed. */
export const defaultProfile = "default";
const storedProfile = "wagate.profile";
let activeProfile = defaultProfile;
try {
  activeProfile = localStorage.getItem(storedProfile) || defaultProfile;
} catch {
  /* storage unavailable: start with the main profile */
}
/** The WhatsApp number that requests act on, unless one is named. */
export function getActiveProfile() {
  return activeProfile;
}
export function setActiveProfile(id: string) {
  activeProfile = id;
  try {
    localStorage.setItem(storedProfile, id);
  } catch {
    /* the choice lasts until the app closes */
  }
}
/** Adds `profile=` so the gateway knows which number a request is for. */
export function withProfile(path: string, profile: string) {
  return (
    path + (path.includes("?") ? "&" : "?") + "profile=" + encodeURIComponent(profile)
  );
}
export async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
  profile = activeProfile,
): Promise<T> {
  path = withProfile(path, profile);
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
  GroupAddResult,
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
export interface Profile {
  id: string;
  name: string;
  /** The number last linked to this profile, as a WhatsApp JID. */
  account: string | null;
  createdAt: number;
  isDefault: boolean;
  status: ConnectionState["status"];
  error?: string;
}
export interface Snapshot {
  health: { status: string; database: string; version: string; ai: string };
  /** The profile this snapshot describes. */
  profile: Profile;
  /** Every WhatsApp number in the app, the main one first. */
  profiles: Profile[];
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
/** A profile's number for display, such as `+60123456789`, or a hint to link one. */
export function profileNumber(profile: Pick<Profile, "account">) {
  return profile.account ? phoneLabel(profile.account) : "No number linked yet";
}
