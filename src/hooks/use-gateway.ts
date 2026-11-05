import { useEffect, useState, useCallback, useRef } from "react";
import { request, type Snapshot } from "../lib/api";
/** `limit` is how many of the open chat's latest messages to keep loaded. */
export function useGateway(profile: string, chatId: string | null, limit = 50) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [error, setError] = useState("");
  const selected = useRef(chatId);
  selected.current = chatId;
  const current = useRef(profile);
  current.current = profile;
  const generation = useRef(0);
  const size = useRef(limit);
  size.current = limit;
  const refresh = useCallback(async () => {
    const id = selected.current,
      p = current.current;
    const version = ++generation.current;
    try {
      const next = await request<Snapshot>(
        "/internal/snapshot" +
          (id ? "?chatId=" + encodeURIComponent(id) + "&limit=" + size.current : ""),
        "GET",
        undefined,
        p,
      );
      // A reply for another profile or chat is stale; the next poll replaces it.
      if (
        version === generation.current &&
        id === selected.current &&
        p === current.current
      ) {
        setSnapshot(next);
        setError("");
      }
    } catch (e) {
      if (version === generation.current) setError(String(e));
    }
  }, []);
  // Another number's chats must never show under this one, even briefly.
  useEffect(() => {
    setSnapshot((s) => (s && s.profile?.id !== profile ? null : s));
  }, [profile]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      if (!stopped) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      stopped = true;
      ++generation.current;
      clearTimeout(timer);
    };
  }, [profile, chatId, limit, refresh]);
  return { snapshot, error, refresh };
}
