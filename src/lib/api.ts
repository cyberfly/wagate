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
} from "../../sidecar/src/messaging/types";
import type {
  Chat,
  Message,
  Draft,
  ConnectionState,
  Broadcast,
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
