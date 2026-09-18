import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
// Pinned so a build always fetches a known cloudflared. Override for air-gapped installs.
export const version = process.env.WAGATE_CLOUDFLARED_VERSION || "2026.8.3";
const assets: Record<string, string> = {
  "darwin arm64": "cloudflared-darwin-arm64.tgz",
  "darwin x64": "cloudflared-darwin-amd64.tgz",
  "linux x64": "cloudflared-linux-amd64",
  "linux arm64": "cloudflared-linux-arm64",
  "win32 x64": "cloudflared-windows-amd64.exe",
};
export function asset() {
  return assets[`${process.platform} ${process.arch}`];
}
export function managedPath(dataDir: string) {
  return join(
    dataDir,
    "bin",
    process.platform === "win32" ? "cloudflared.exe" : "cloudflared",
  );
}
/** Explicit override, then our managed copy, then a system install. */
export function resolveBinary(dataDir: string): string | null {
  const override = process.env.WAGATE_CLOUDFLARED;
  if (override) return existsSync(override) ? override : null;
  const managed = managedPath(dataDir);
  if (existsSync(managed)) return managed;
  return Bun.which("cloudflared");
}
/**
 * Downloads the pinned cloudflared release into the data directory. The transport
 * is HTTPS to Cloudflare's official GitHub release; nothing else is trusted.
 */
export async function install(
  dataDir: string,
  onProgress: (percent: number) => void,
) {
  const name = asset();
  if (!name)
    throw new Error("Cloudflare Tunnel is not supported on this platform");
  const dir = join(dataDir, "bin");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const response = await fetch(
    `https://github.com/cloudflare/cloudflared/releases/download/${version}/${name}`,
    { redirect: "follow" },
  );
  if (!response.ok || !response.body)
    throw new Error("Cloudflare tunnel download failed");
  const total = Number(response.headers.get("content-length") || 0);
  const download = join(dir, name);
  const chunks: Uint8Array[] = [];
  let received = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
    received += chunk.byteLength;
    if (total) onProgress(Math.min(99, Math.round((received / total) * 100)));
  }
  await Bun.write(download, new Blob(chunks as BlobPart[]));
  const target = managedPath(dataDir);
  if (name.endsWith(".tgz")) {
    const tar = Bun.spawn(["tar", "-xzf", download, "-C", dir], {
      stdout: "ignore",
      stderr: "ignore",
    });
    if (await tar.exited) throw new Error("Cloudflare tunnel download failed");
    rmSync(download, { force: true });
  } else if (download !== target) {
    rmSync(target, { force: true });
    await Bun.write(target, Bun.file(download));
    rmSync(download, { force: true });
  }
  if (!existsSync(target)) throw new Error("Cloudflare tunnel download failed");
  chmodSync(target, 0o700);
  onProgress(100);
  return target;
}
