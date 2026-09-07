import type { EventBus } from "../events/event-bus";
import { asset, install, resolveBinary } from "./cloudflared";
export type TunnelStatus =
  "off" | "installing" | "starting" | "online" | "error";
export interface TunnelState {
  status: TunnelStatus;
  url: string | null;
  error: string | null;
  /** Whether a cloudflared binary is available to run. */
  installed: boolean;
  /** Whether this platform has a cloudflared release we can download. */
  supported: boolean;
  /** Download progress, 0–100, while status is "installing". */
  progress: number | null;
}
interface Options {
  dataDir: string;
  events: EventBus;
  log: (
    level: "info" | "error",
    event: string,
    details?: Record<string, string | number>,
  ) => void;
  /** Handler for the public-only API served on an ephemeral loopback port. */
  fetch: (request: Request) => Response | Promise<Response>;
  /** Seconds to wait for Cloudflare to hand back a public URL. */
  timeout?: number;
}
const quickUrl = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;
/**
 * Publishes the read/send API through a Cloudflare quick tunnel.
 *
 * The tunnel never points at the main gateway port. It gets its own loopback
 * server carrying the public routes only, so `/internal/*` and the desktop
 * token stay unreachable from the internet by construction.
 */
export class TunnelService {
  private state: TunnelState;
  private child: ReturnType<typeof Bun.spawn> | null = null;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  constructor(private options: Options) {
    this.state = {
      status: "off",
      url: null,
      error: null,
      installed: !!resolveBinary(options.dataDir),
      supported: !!asset() || !!resolveBinary(options.dataDir),
      progress: null,
    };
  }
  status(): TunnelState {
    // Re-check while idle so a cloudflared installed outside Wagate is picked up.
    if (this.state.status === "off" || this.state.status === "error")
      this.state.installed = !!resolveBinary(this.options.dataDir);
    return { ...this.state };
  }
  private set(next: Partial<TunnelState>) {
    this.state = { ...this.state, ...next };
    this.options.events.publish("tunnel.updated", this.status());
  }
  private fail(message: string) {
    this.options.log("error", "tunnel.failed");
    this.teardown();
    this.set({ status: "error", url: null, error: message, progress: null });
  }
  /** Downloads cloudflared in the background; progress shows up in the state. */
  install() {
    if (this.state.status === "installing" || this.state.status === "starting")
      throw new Error("Cloudflare tunnel is already working");
    if (this.state.status === "online")
      throw new Error("Cloudflare tunnel is already running");
    if (!asset())
      throw new Error("Cloudflare Tunnel is not supported on this platform");
    this.set({ status: "installing", error: null, progress: 0 });
    void install(this.options.dataDir, (progress) => {
      if (this.state.status === "installing") this.set({ progress });
    })
      .then(() => {
        this.options.log("info", "tunnel.installed");
        this.set({
          status: "off",
          installed: true,
          progress: null,
          error: null,
        });
      })
      .catch(() => {
        this.set({
          status: "error",
          progress: null,
          error:
            "Cloudflare tunnel download failed. Check your connection, or install cloudflared yourself.",
        });
      });
    return this.status();
  }
  /** Starts the public server and cloudflared. Resolves as soon as they spawn. */
  start() {
    if (this.state.status === "online")
      throw new Error("Cloudflare tunnel is already running");
    if (this.state.status === "starting" || this.state.status === "installing")
      throw new Error("Cloudflare tunnel is already working");
    const binary = resolveBinary(this.options.dataDir);
    if (!binary)
      throw new Error(
        "Cloudflare tunnel needs cloudflared. Download it here or install it yourself.",
      );
    this.stopping = false;
    this.set({ status: "starting", url: null, error: null, progress: null });
    let port: number;
    try {
      this.server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: this.options.fetch,
        idleTimeout: 60,
      });
      if (!this.server.port) throw new Error("no port");
      port = this.server.port;
    } catch {
      this.fail("Cloudflare tunnel could not open a local port");
      return this.status();
    }
    try {
      this.child = Bun.spawn(
        [
          binary,
          "tunnel",
          "--no-autoupdate",
          "--url",
          `http://127.0.0.1:${port}`,
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
    } catch {
      this.fail("Cloudflare tunnel could not start cloudflared");
      return this.status();
    }
    this.options.log("info", "tunnel.starting");
    this.timer = setTimeout(
      () => {
        if (this.state.status === "starting")
          this.fail(
            "Cloudflare did not return a public address in time. Try again.",
          );
      },
      (this.options.timeout ?? 60) * 1000,
    );
    // cloudflared prints the assigned hostname to stderr; stdout is watched too
    // because that varies by version. Output is scanned, never logged.
    const child = this.child;
    void this.watch(child.stderr);
    void this.watch(child.stdout);
    void child.exited.then(() => {
      // Ignore a previous process exiting after a restart already took over.
      if (this.child !== child || this.stopping) return;
      this.fail("The Cloudflare tunnel stopped. Start it again to go public.");
    });
    return this.status();
  }
  private async watch(stream: unknown) {
    if (!stream || typeof stream === "number") return;
    const decoder = new TextDecoder();
    let tail = "";
    try {
      for await (const chunk of stream as AsyncIterable<Uint8Array>) {
        if (this.state.status !== "starting") return;
        // Keep a small tail so a hostname split across chunks still matches.
        tail = (tail + decoder.decode(chunk, { stream: true })).slice(-4096);
        const match = quickUrl.exec(tail);
        if (match) {
          if (this.timer) clearTimeout(this.timer);
          this.timer = null;
          this.options.log("info", "tunnel.online");
          this.set({ status: "online", url: match[0], error: null });
          return;
        }
      }
    } catch {
      /* the process ended; child.exited reports the outcome */
    }
  }
  private teardown() {
    // Marks the exit as ours, so the child's exit is not reported as a failure.
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.child?.kill();
    this.child = null;
    this.server?.stop(true);
    this.server = null;
  }
  stop() {
    this.stopping = true;
    this.teardown();
    if (this.state.status !== "off") this.options.log("info", "tunnel.stopped");
    this.set({ status: "off", url: null, error: null, progress: null });
    return this.status();
  }
  close() {
    this.stopping = true;
    this.teardown();
  }
}
