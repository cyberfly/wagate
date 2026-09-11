import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { migrations } from "./schema";
export function openDatabase(path: string) {
  if (path !== ":memory:")
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true, strict: true });
  db.exec(
    "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
  );
  const version = (
    db.query("PRAGMA user_version").get() as { user_version: number }
  ).user_version;
  if (version > migrations.length)
    throw new Error("Database belongs to a newer Wagate version");
  if (version < migrations.length)
    db.transaction(() => {
      for (const migration of migrations.slice(version)) db.exec(migration);
    })();
  if (path !== ":memory:") chmodSync(path, 0o600);
  return db;
}
