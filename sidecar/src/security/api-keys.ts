import { createHash, randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
export const permissions = [
  "messages.read",
  "messages.send",
  "chats.read",
] as const;
export type Permission = (typeof permissions)[number];
/** What a key may do, and with which profiles; null profiles means every one. */
export interface KeyAccess {
  permissions: Permission[];
  profiles: string[] | null;
}
export class ApiKeys {
  constructor(private db: Database) {}
  create(name: string, scopes: Permission[], profiles: string[] | null = null) {
    const key = `local_${randomBytes(32).toString("base64url")}`;
    const id = crypto.randomUUID();
    this.db
      .query(
        "INSERT INTO api_keys(id,name,key_hash,permissions,profiles,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        id,
        name,
        this.hash(key),
        JSON.stringify(scopes),
        profiles ? JSON.stringify(profiles) : null,
        Date.now(),
      );
    return { id, key, name, permissions: scopes, profiles };
  }
  authenticate(key: string): Permission[] | null {
    return this.access(key)?.permissions ?? null;
  }
  access(key: string): KeyAccess | null {
    const row = this.db
      .query(
        "SELECT id,permissions,profiles FROM api_keys WHERE key_hash=? AND revoked_at IS NULL",
      )
      .get(this.hash(key)) as {
      id: string;
      permissions: string;
      profiles: string | null;
    } | null;
    if (!row) return null;
    this.db
      .query("UPDATE api_keys SET last_used_at=? WHERE id=?")
      .run(Date.now(), row.id);
    return {
      permissions: JSON.parse(row.permissions),
      profiles: row.profiles ? JSON.parse(row.profiles) : null,
    };
  }
  list() {
    return this.db
      .query(
        "SELECT id,name,permissions,profiles,created_at AS createdAt,last_used_at AS lastUsedAt,revoked_at AS revokedAt FROM api_keys ORDER BY created_at DESC",
      )
      .all();
  }
  revoke(id: string) {
    this.db
      .query("UPDATE api_keys SET revoked_at=? WHERE id=?")
      .run(Date.now(), id);
  }
  /**
   * Takes a removed profile out of every key. A key that could reach only
   * that profile can reach nothing, so it is revoked.
   */
  forgetProfile(profile: string) {
    const rows = this.db
      .query(
        "SELECT id,profiles FROM api_keys WHERE profiles IS NOT NULL AND revoked_at IS NULL",
      )
      .all() as { id: string; profiles: string }[];
    const update = this.db.query("UPDATE api_keys SET profiles=? WHERE id=?");
    this.db.transaction(() => {
      for (const row of rows) {
        const before: string[] = JSON.parse(row.profiles);
        if (!before.includes(profile)) continue;
        const after = before.filter((p) => p !== profile);
        if (after.length) update.run(JSON.stringify(after), row.id);
        else this.revoke(row.id);
      }
    })();
  }
  private hash(key: string) {
    return createHash("sha256").update(key).digest("hex");
  }
}
