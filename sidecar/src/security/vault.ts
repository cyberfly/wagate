import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import type { Database } from "bun:sqlite";
export class Vault {
  constructor(
    private db: Database,
    private master: Buffer,
  ) {
    if (master.length !== 32) throw new Error("Invalid vault key");
    db.exec(
      "CREATE TABLE IF NOT EXISTS secrets (id TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
  }
  static async open(db: Database, dataDir: string) {
    const name =
      "vault-" +
      createHash("sha256").update(dataDir).digest("hex").slice(0, 24);
    let key = await Bun.secrets.get({ service: "com.wagate.desktop", name });
    if (!key) {
      const existing = db
        .query("SELECT name FROM sqlite_master WHERE name='secrets'")
        .get();
      if (existing && db.query("SELECT id FROM secrets LIMIT 1").get())
        throw new Error(
          "Secure storage key is missing; existing credentials cannot be decrypted",
        );
      key = randomBytes(32).toString("base64");
      await Bun.secrets.set({
        service: "com.wagate.desktop",
        name,
        value: key,
      });
    }
    return new Vault(db, Buffer.from(key, "base64"));
  }
  get(id: string): string | null {
    const row = this.db
      .query("SELECT value FROM secrets WHERE id=?")
      .get(id) as { value: string } | null;
    if (!row) return null;
    const data = Buffer.from(row.value, "base64");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.master,
      data.subarray(0, 12),
    );
    decipher.setAAD(Buffer.from(id));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([
      decipher.update(data.subarray(28)),
      decipher.final(),
    ]).toString();
  }
  set(id: string, value: string) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.master, nonce);
    cipher.setAAD(Buffer.from(id));
    const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
    this.db
      .query("INSERT OR REPLACE INTO secrets(id,value) VALUES(?,?)")
      .run(
        id,
        Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString(
          "base64",
        ),
      );
  }
  delete(id: string) {
    this.db.query("DELETE FROM secrets WHERE id=?").run(id);
  }
  clearPrefix(prefix: string) {
    this.db
      .query("DELETE FROM secrets WHERE substr(id,1,?)=?")
      .run(prefix.length, prefix);
  }
  transaction(fn: () => void) {
    this.db.transaction(fn)();
  }
}
