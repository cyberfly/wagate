import { useEffect, useState, useCallback, useRef } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { request, type Snapshot } from "../lib/api";
/**
 * The desktop app is told when something changes, so its poll is only a
 * safety net. The browser preview has no such signal and polls.
 */
const pollEvery = isTauri() ? 15000 : 2000;
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
      if (!stopped) timer = setTimeout(poll, pollEvery);
    };
    void poll();
    return () => {
      stopped = true;
      ++generation.current;
      clearTimeout(timer);
    };
  }, [profile, chatId, limit, refresh]);
  // The gateway says which number changed; "*" is app-wide state. Changes
  // that arrive during a refresh are folded into one more.
  useEffect(() => {
    if (!isTauri()) return;
    let stopped = false,
      running = false,
      again = false,
      off: (() => void) | undefined;
    const pump = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          await refresh();
        } while (again && !stopped);
      } finally {
        running = false;
      }
    };
    void listen<{ profile?: string }>("gateway-changed", (event) => {
      const changed = event.payload?.profile;
      if (!changed || changed === "*" || changed === current.current) void pump();
    }).then((unlisten) => {
      if (stopped) unlisten();
      else off = unlisten;
    });
    return () => {
      stopped = true;
      off?.();
    };
  }, [refresh]);
  return { snapshot, error, refresh };
}
