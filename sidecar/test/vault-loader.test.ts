import { test, expect } from "bun:test";
import { createVaultLoader } from "../src/security/vault-loader";
import { Vault } from "../src/security/vault";
import { openDatabase } from "../src/db/database";

test("a stalled OS operation times out without creating duplicate prompts on retry", async () => {
  const db = openDatabase(":memory:");
  const vault = new Vault(db, Buffer.alloc(32, 2));
  let complete!: (value: Vault) => void;
  let calls = 0;
  const load = createVaultLoader(() => {
    calls++;
    return new Promise((resolve) => (complete = resolve));
  }, 5);
  await expect(load()).rejects.toThrow("Secure storage");
  await expect(load()).rejects.toThrow("Secure storage");
  expect(calls).toBe(1);
  complete(vault);
  expect(await load()).toBe(vault);
  expect(calls).toBe(1);
  db.close();
});
test("a rejected OS operation can be retried, without leaking the upstream error", async () => {
  let calls = 0;
  const load = createVaultLoader(async () => {
    calls++;
    throw new Error("secret upstream diagnostic");
  }, 5);
  await expect(load()).rejects.toThrow("Secure storage");
  await expect(load()).rejects.toThrow("Secure storage");
  expect(calls).toBe(2);
});
