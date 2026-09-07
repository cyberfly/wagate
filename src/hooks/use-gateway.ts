import { useEffect, useState, useCallback, useRef } from "react";
import { request, type Snapshot } from "../lib/api";
export function useGateway(chatId: string | null) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [error, setError] = useState("");
  const selected = useRef(chatId);
  selected.current = chatId;
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const id = selected.current;
    const version = ++generation.current;
    try {
      const next = await request<Snapshot>(
        "/internal/snapshot" + (id ? "?chatId=" + encodeURIComponent(id) : ""),
      );
      if (version === generation.current && id === selected.current) {
        setSnapshot(next);
        setError("");
      }
    } catch (e) {
      if (version === generation.current) setError(String(e));
    }
  }, []);
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
  }, [chatId, refresh]);
  return { snapshot, error, refresh };
}
