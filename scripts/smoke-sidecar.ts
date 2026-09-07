import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
const host = (await Bun.$`rustc --print host-tuple`.text()).trim();
const binary = resolve(
  `src-tauri/binaries/wagate-sidecar-${host}${process.platform === "win32" ? ".exe" : ""}`,
);
const dir = await mkdtemp(join(tmpdir(), "wagate-smoke-"));
const token = crypto.randomUUID();
const port = 18787;
const child = Bun.spawn([binary], {
  cwd: dir,
  env: {
    ...process.env,
    WAGATE_PORT: String(port),
    WAGATE_DATA_DIR: dir,
    WAGATE_DESKTOP: "1",
    WAGATE_DESKTOP_TOKEN: token,
  },
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/internal/snapshot`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (response.ok) {
        const snapshot = (await response.json()) as {
          health: { database: string };
        };
        if (snapshot.health.database !== "connected")
          throw new Error("Database unavailable");
        ready = true;
        break;
      }
    } catch {}
    await Bun.sleep(100);
  }
  if (!ready) throw new Error("Compiled sidecar failed readiness");
  if ((await fetch(`http://127.0.0.1:${port}/v1/chats`)).status !== 401)
    throw new Error("Unauthenticated data access");
  child.stdin.write("shutdown\n");
  child.stdin.flush();
  const code = await Promise.race([
    child.exited,
    Bun.sleep(5000).then(() => {
      throw new Error("Shutdown timed out");
    }),
  ]);
  if (code !== 0) throw new Error(`Exit ${code}`);
  console.log(
    "PASS: compiled sidecar starts outside project, SQLite connects, auth enforced, graceful shutdown exits 0.",
  );
} finally {
  child.kill();
  await child.exited;
  await rm(dir, { recursive: true, force: true });
}
