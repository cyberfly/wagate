import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/events/event-bus";
import { TunnelService } from "../src/tunnel/tunnel-service";
import { setup } from "./helpers";
const url = "https://silent-forest-1234.trycloudflare.com";
/** Stands in for cloudflared: announces a hostname, then stays alive. */
function fakeCloudflared(script: string) {
  const dir = mkdtempSync(join(tmpdir(), "wagate-tunnel-"));
  const path = join(dir, "cloudflared");
  writeFileSync(path, "#!/bin/sh\n" + script);
  chmodSync(path, 0o700);
  return { dir, path };
}
async function until(check: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await Bun.sleep(20);
  }
  return false;
}
function service(binary: string, timeout = 5) {
  const dir = mkdtempSync(join(tmpdir(), "wagate-data-"));
  process.env.WAGATE_CLOUDFLARED = binary;
  return new TunnelService({
    dataDir: dir,
    events: new EventBus(),
    log: () => {},
    fetch: () => new Response("ok"),
    timeout,
  });
}
test("a quick tunnel reports its public address and serves the public API there", async () => {
  const fake = fakeCloudflared(
    `echo "INF |  ${url}  |" >&2\nwhile true; do sleep 1; done\n`,
  );
  const tunnel = service(fake.path);
  expect(tunnel.status().status).toBe("off");
  tunnel.start();
  expect(tunnel.status().status).toBe("starting");
  expect(await until(() => tunnel.status().status === "online")).toBe(true);
  expect(tunnel.status().url).toBe(url);
  tunnel.stop();
  expect(tunnel.status()).toMatchObject({ status: "off", url: null });
  tunnel.close();
});
test("a hostname split across reads is still recognised", async () => {
  const fake = fakeCloudflared(
    `printf 'INF https://silent-forest-' >&2\nsleep 0.3\nprintf '1234.trycloudflare.com\\n' >&2\nwhile true; do sleep 1; done\n`,
  );
  const tunnel = service(fake.path);
  tunnel.start();
  expect(await until(() => tunnel.status().status === "online")).toBe(true);
  expect(tunnel.status().url).toBe(url);
  tunnel.close();
});
test("cloudflared exiting without an address surfaces an error, not a stuck tunnel", async () => {
  const fake = fakeCloudflared(`echo "ERR failed" >&2\nexit 1\n`);
  const tunnel = service(fake.path);
  tunnel.start();
  expect(await until(() => tunnel.status().status === "error")).toBe(true);
  expect(tunnel.status().url).toBe(null);
  expect(tunnel.status().error).toContain("Cloudflare");
  tunnel.close();
});
test("a tunnel that never gets an address times out", async () => {
  const fake = fakeCloudflared(`while true; do sleep 1; done\n`);
  const tunnel = service(fake.path, 1);
  tunnel.start();
  expect(await until(() => tunnel.status().status === "error", 4000)).toBe(
    true,
  );
  expect(tunnel.status().error).toContain("in time");
  tunnel.close();
});
test("starting twice is rejected instead of leaking a second process", async () => {
  const fake = fakeCloudflared(
    `echo "INF ${url}" >&2\nwhile true; do sleep 1; done\n`,
  );
  const tunnel = service(fake.path);
  tunnel.start();
  expect(() => tunnel.start()).toThrow("already working");
  expect(await until(() => tunnel.status().status === "online")).toBe(true);
  expect(() => tunnel.start()).toThrow("already running");
  tunnel.close();
});
test("the public app publishes the key routes and hides internal ones", async () => {
  const s = setup();
  const key = s.keys.create("public", ["chats.read"]);
  const call = (path: string, bearer = key.key) =>
    s.publicApp.request(path, {
      headers: { Authorization: "Bearer " + bearer },
    });
  expect((await call("/v1/chats")).status).toBe(200);
  // The desktop token is worthless on the public listener...
  expect((await call("/internal/snapshot", "test-desktop-token")).status).toBe(
    401,
  );
  // ...and the internal routes are not mounted there at all.
  expect((await call("/internal/snapshot")).status).toBe(404);
  expect((await call("/internal/settings")).status).toBe(404);
  expect((await call("/internal/tunnel/start")).status).toBe(404);
  // Public health leaks no account detail.
  expect(await (await s.publicApp.request("/health")).json()).toEqual({
    status: "ok",
  });
  s.close();
});
test("public key guessing is throttled while valid keys keep working", async () => {
  const s = setup();
  const key = s.keys.create("public", ["chats.read"]);
  const guess = () =>
    s.publicApp.request("/v1/chats", {
      headers: { Authorization: "Bearer local_wrong" },
    });
  for (let i = 0; i < 20; i++) expect((await guess()).status).toBe(401);
  expect((await guess()).status).toBe(429);
  expect(
    (
      await s.publicApp.request("/v1/chats", {
        headers: { Authorization: "Bearer " + key.key },
      })
    ).status,
  ).toBe(200);
  s.close();
});
test("going public requires an active API key", async () => {
  const s = setup();
  expect((await s.call("/internal/tunnel/start", "POST")).status).toBe(400);
  const key = s.keys.create("public", ["chats.read"]);
  s.keys.revoke(key.id);
  expect((await s.call("/internal/tunnel/start", "POST")).status).toBe(400);
  s.close();
});
