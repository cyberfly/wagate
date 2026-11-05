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
  // A second profile gets its own database directory, answers on its own,
  // and leaves nothing behind when removed. No WhatsApp connection is made.
  const call = (path: string, method = "GET", body?: unknown) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const created = await call("/internal/profiles", "POST", { name: "Smoke" });
  if (!created.ok) throw new Error("Profile creation failed");
  const { id } = (await created.json()) as { id: string };
  const profileDb = join(dir, "profiles", id, "wagate.sqlite");
  if (!(await Bun.file(profileDb).exists()))
    throw new Error("Profile database missing");
  const scoped = (await (
    await call(`/internal/snapshot?profile=${id}`)
  ).json()) as { profile: { id: string }; profiles: unknown[] };
  if (scoped.profile.id !== id || scoped.profiles.length !== 2)
    throw new Error("Profile snapshot mismatch");
  if (!(await call(`/internal/profiles/${id}`, "DELETE")).ok)
    throw new Error("Profile removal failed");
  if (await Bun.file(profileDb).exists())
    throw new Error("Removed profile left its database");
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
    "PASS: compiled sidecar starts outside project, SQLite connects, auth enforced, profiles create and remove, graceful shutdown exits 0.",
  );
} finally {
  child.kill();
  await child.exited;
  await rm(dir, { recursive: true, force: true });
}
