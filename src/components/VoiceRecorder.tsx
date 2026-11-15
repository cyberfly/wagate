import { useEffect, useRef, useState } from "react";
/** Longest voice message recorded here. */
export const maxVoiceSeconds = 10 * 60;
// WhatsApp plays Ogg Opus and MP4 audio everywhere; WebM only as a last resort.
const formats = [
  "audio/ogg;codecs=opus",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/webm;codecs=opus",
  "audio/webm",
];
export interface Recording {
  blob: Blob;
  /** Without codec details, such as `audio/mp4`. */
  mimetype: string;
  seconds: number;
}
/** Whether this window can record from a microphone at all. */
export function canRecord() {
  return typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}
/**
 * Records a voice message from the microphone. `start` asks for the
 * microphone; `finish` resolves with the recording; `cancel` discards it.
 */
export function useVoiceRecorder(fail: (message: string) => void) {
  const [state, setState] = useState<"idle" | "starting" | "recording">("idle"),
    [seconds, setSeconds] = useState(0);
  const session = useRef<{
    recorder: MediaRecorder;
    stream: MediaStream;
    chunks: Blob[];
    started: number;
    /** Set once the longest length is reached and recording has stopped. */
    length?: number;
    timer: ReturnType<typeof setInterval>;
  } | null>(null);
  /** Guards against a start that is cancelled before the microphone answers. */
  const attempt = useRef(0);
  const release = () => {
    const s = session.current;
    session.current = null;
    if (s) {
      clearInterval(s.timer);
      s.stream.getTracks().forEach((t) => t.stop());
    }
    setState("idle");
    setSeconds(0);
  };
  const elapsed = () => {
    const s = session.current;
    return s ? (s.length ?? (performance.now() - s.started) / 1000) : 0;
  };
  const start = async () => {
    if (state !== "idle") return;
    if (!canRecord()) return fail("This device can’t record audio here.");
    const mine = ++attempt.current;
    setState("starting");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      if (mine === attempt.current) setState("idle");
      const name = (error as { name?: string } | null)?.name;
      return fail(
        name === "NotFoundError"
          ? "No microphone was found."
          : "Wagate can’t use the microphone. Allow it in your system’s privacy settings, then try again.",
      );
    }
    if (mine !== attempt.current) return stream.getTracks().forEach((t) => t.stop());
    try {
      const mimeType = formats.find((f) => MediaRecorder.isTypeSupported(f));
      const recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: 32_000,
      });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      recorder.start();
      const timer = setInterval(() => {
        const s = session.current;
        if (!s) return;
        const now = elapsed();
        setSeconds(Math.floor(now));
        if (now >= maxVoiceSeconds && s.length === undefined) {
          s.length = maxVoiceSeconds;
          if (s.recorder.state === "recording") s.recorder.pause();
          fail("Voice messages can be up to 10 minutes. Send this one or discard it.");
        }
      }, 250);
      session.current = { recorder, stream, chunks, started: performance.now(), timer };
      setState("recording");
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      setState("idle");
      fail("Recording could not start on this device.");
    }
  };
  const cancel = () => {
    attempt.current++;
    const s = session.current;
    if (s && s.recorder.state !== "inactive") {
      s.recorder.onstop = null;
      s.recorder.stop();
    }
    release();
  };
  const finish = () =>
    new Promise<Recording | null>((resolve) => {
      const s = session.current;
      if (!s) return resolve(null);
      const length = elapsed();
      const done = () => {
        const type = (s.recorder.mimeType || s.chunks[0]?.type || "audio/mp4").split(";")[0]!.trim();
        const blob = new Blob(s.chunks, { type });
        release();
        resolve(blob.size && length >= 1 ? { blob, mimetype: type, seconds: Math.round(length * 10) / 10 } : null);
      };
      if (s.recorder.state === "inactive") return done();
      s.recorder.onstop = done;
      s.recorder.stop();
    });
  // Leaving the screen lets go of the microphone.
  useEffect(() => cancel, []);
  return { state, seconds, start, cancel, finish };
}
export function MicIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}
