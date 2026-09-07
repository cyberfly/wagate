import { createHash, randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
export const permissions = [
  "messages.read",
  "messages.send",
  "chats.read",
] as const;
export type Permission = (typeof permissions)[number];
export class ApiKeys {
  constructor(private db: Database) {}
  create(name: string, scopes: Permission[]) {
    const key = `local_${randomBytes(32).toString("base64url")}`;
    const id = crypto.randomUUID();
    this.db
      .query(
        "INSERT INTO api_keys(id,name,key_hash,permissions,created_at) VALUES(?,?,?,?,?)",
      )
      .run(id, name, this.hash(key), JSON.stringify(scopes), Date.now());
    return { id, key, name, permissions: scopes };
  }
  authenticate(key: string): Permission[] | null {
    const row = this.db
      .query(
        "SELECT id,permissions FROM api_keys WHERE key_hash=? AND revoked_at IS NULL",
      )
      .get(this.hash(key)) as { id: string; permissions: string } | null;
    if (!row) return null;
    this.db
      .query("UPDATE api_keys SET last_used_at=? WHERE id=?")
      .run(Date.now(), row.id);
    return JSON.parse(row.permissions);
  }
  list() {
    return this.db
      .query(
        "SELECT id,name,permissions,created_at AS createdAt,last_used_at AS lastUsedAt,revoked_at AS revokedAt FROM api_keys ORDER BY created_at DESC",
      )
      .all();
  }
  revoke(id: string) {
    this.db
      .query("UPDATE api_keys SET revoked_at=? WHERE id=?")
      .run(Date.now(), id);
  }
  private hash(key: string) {
    return createHash("sha256").update(key).digest("hex");
  }
}
