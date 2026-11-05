import { useEffect, useRef, useState } from "react";
import { getActiveProfile, request } from "./api";
export interface LoadedMedia {
  url: string;
  mimetype: string;
  /** False when only WhatsApp's small embedded preview could be shown. */
  complete: boolean;
  error?: string | null;
}
interface MediaResponse {
  mimetype: string;
  data: string;
  complete: boolean;
  error?: string | null;
}
// Attachments are kept as blob URLs while the app runs, so scrolling back or
// reopening a chat does not ask the gateway again. The oldest are let go.
const limit = 150;
const cache = new Map<string, Promise<LoadedMedia>>();
function toBlob(base64: string, mimetype: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimetype });
}
export function loadMedia(messageId: string, preview = false) {
  const key = getActiveProfile() + "\n" + messageId + (preview ? "\npreview" : "");
  const known = cache.get(key);
  if (known) return known;
  const loading = request<MediaResponse>(
    `/internal/messages/${encodeURIComponent(messageId)}/media${preview ? "?preview=1" : ""}`,
  ).then((r) => ({
    url: URL.createObjectURL(toBlob(r.data, r.mimetype)),
    mimetype: r.mimetype,
    complete: r.complete,
    error: r.error,
  }));
  cache.set(key, loading);
  // A failure, or only a preview of the full file, is tried again next time.
  loading
    .then((m) => {
      if (!preview && !m.complete) cache.delete(key);
    })
    .catch(() => cache.delete(key));
  while (cache.size > limit) {
    const [oldest, value] = cache.entries().next().value!;
    cache.delete(oldest);
    void value.then((m) => URL.revokeObjectURL(m.url)).catch(() => {});
  }
  return loading;
}
type State =
  | { status: "idle" | "loading"; media?: undefined; error?: undefined }
  | { status: "ready"; media: LoadedMedia; error?: undefined }
  | { status: "error"; media?: undefined; error: string };
/**
 * Loads a message's attachment once `enabled`; with `lazy`, only after the
 * element in `ref` scrolls into view.
 */
export function useMedia(messageId: string, enabled: boolean, opts: { preview?: boolean; lazy?: boolean } = {}) {
  const [state, setState] = useState<State>({ status: "idle" });
  const [visible, setVisible] = useState(!opts.lazy);
  const [attempt, setAttempt] = useState(0);
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!opts.lazy || visible) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return setVisible(true);
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "300px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [opts.lazy, visible]);
  useEffect(() => {
    if (!enabled || !visible) return;
    let live = true;
    setState({ status: "loading" });
    loadMedia(messageId, opts.preview).then(
      (media) => live && setState({ status: "ready", media }),
      (e) => live && setState({ status: "error", error: String(e).replace(/^Error: /, "") }),
    );
    return () => {
      live = false;
    };
  }, [messageId, enabled, visible, opts.preview, attempt]);
  return { ...state, ref, retry: () => setAttempt((n) => n + 1) };
}
/** Reads a picked or pasted file as base64 for the gateway. */
export function readFile(file: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(new Error("The file could not be read"));
    reader.readAsDataURL(file);
  });
}
export function fileSize(bytes?: number) {
  if (!bytes) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " kB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}
export function duration(seconds?: number) {
  if (!seconds) return "";
  return Math.floor(seconds / 60) + ":" + String(Math.floor(seconds % 60)).padStart(2, "0");
}
