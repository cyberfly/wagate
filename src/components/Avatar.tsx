import { useEffect, useRef, useState } from "react";
import { chatTitle, getActiveProfile, initials, request, type Chat } from "../lib/api";
// Pictures are small, so they are kept as data URLs for as long as the app
// runs. Each is asked for once it scrolls into view; asking also lets the
// gateway look the picture up on WhatsApp when it has none stored yet.
const cache = new Map<string, Promise<string | null>>();
function load(chatId: string, version: number | null) {
  const key = getActiveProfile() + "\n" + chatId + "\n" + (version ?? "");
  let known = cache.get(key);
  if (!known) {
    known = request<{ data: string | null }>(
      `/internal/chats/${encodeURIComponent(chatId)}/avatar`,
    ).then((r) => (r.data ? "data:image/jpeg;base64," + r.data : null));
    cache.set(key, known);
    known.catch(() => cache.delete(key));
  }
  return known;
}
/** A chat's profile picture, or its initials until one is known. */
export function Avatar({ chat }: { chat: Pick<Chat, "id" | "name" | "avatar"> }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const version = chat.avatar ?? null;
  useEffect(() => {
    if (visible) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return setVisible(true);
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);
  useEffect(() => {
    if (!visible) return;
    let live = true;
    load(chat.id, version).then(
      (next) => live && setUrl(next),
      () => live && setUrl(null),
    );
    return () => {
      live = false;
    };
  }, [chat.id, version, visible]);
  return (
    <span ref={ref} className={"avatar" + (url ? " has-photo" : "")}>
      {url ? <img src={url} alt="" onError={() => setUrl(null)} /> : initials(chatTitle(chat))}
    </span>
  );
}
