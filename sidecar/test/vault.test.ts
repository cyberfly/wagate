import { test, expect } from "bun:test";
import { Vault } from "../src/security/vault";
import { openDatabase } from "../src/db/database";
import { createAuth } from "../src/messaging/baileys/auth";
test("vault encrypts credentials and authenticates record identity", () => {
  const db = openDatabase(":memory:");
  const vault = new Vault(db, Buffer.alloc(32, 7));
  vault.set("openrouter", "secret-key");
  const raw = db.query("SELECT value FROM secrets").get() as { value: string };
  expect(raw.value).not.toContain("secret-key");
  expect(vault.get("openrouter")).toBe("secret-key");
  db.query("INSERT INTO secrets(id,value) VALUES(?,?)").run("wrong", raw.value);
  expect(() => vault.get("wrong")).toThrow();
  expect(() => new Vault(db, Buffer.alloc(32, 8)).get("openrouter")).toThrow();
  db.close();
});
test("Baileys credentials and binary signal keys round-trip from encrypted storage", async () => {
  const db = openDatabase(":memory:");
  const vault = new Vault(db, Buffer.alloc(32, 7));
  const auth = createAuth(vault);
  auth.state.creds.registered = true;
  auth.saveCreds();
  const bytes = Buffer.from([1, 2, 3]);
  await auth.state.keys.set({ session: { test: bytes } });
  const restored = createAuth(vault);
  expect(restored.state.creds.registered).toBe(true);
  expect(
    Buffer.from((await restored.state.keys.get("session", ["test"])).test),
  ).toEqual(bytes);
  await restored.state.keys.set({ session: { test: null } });
  expect(
    (await restored.state.keys.get("session", ["test"])).test,
  ).toBeUndefined();
  expect(JSON.stringify(db.query("SELECT * FROM secrets").all())).not.toContain(
    "noiseKey",
  );
  db.close();
});
