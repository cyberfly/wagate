import { mkdir } from "node:fs/promises";
const host = (await Bun.$`rustc --print host-tuple`.text()).trim();
const target = process.env.TAURI_ENV_TARGET_TRIPLE || host;
const targets: Record<string, string> = {
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "x86_64-pc-windows-msvc": "bun-windows-x64",
  "x86_64-unknown-linux-gnu": "bun-linux-x64",
  "aarch64-unknown-linux-gnu": "bun-linux-arm64",
};
if (!targets[target]) throw new Error(`Unsupported sidecar target: ${target}`);
await mkdir("src-tauri/binaries", { recursive: true });
const outfile = `src-tauri/binaries/wagate-sidecar-${target}${target.includes("windows") ? ".exe" : ""}`;
const child = Bun.spawn(
  [
    "bun",
    "build",
    "sidecar/src/index.ts",
    "--compile",
    `--target=${targets[target]}`,
    "--outfile",
    outfile,
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if (await child.exited) process.exit(1);
