import type { Database } from "bun:sqlite";
import type { ContactNames } from "../messaging/types";
const clean = (value?: string | null) => value?.trim().slice(0, 200) || null;
/**
 * Names for people, from three sources. ChatRepository picks one to show:
 * saved name, then WhatsApp's chat name, then imported, then push name.
 */
export class ContactRepository {
  constructor(private db: Database) {}
  /** Saved and profile names from WhatsApp. */
  save(contacts: ContactNames[]) {
    const upsert = this.db.query(
      `INSERT INTO contacts(id,name,push_name,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET
       name=COALESCE(excluded.name,contacts.name),push_name=COALESCE(excluded.push_name,contacts.push_name),updated_at=excluded.updated_at`,
    );
    this.db.transaction(() => {
      const now = Date.now();
      for (const c of contacts) {
        const name = clean(c.name),
          pushName = clean(c.pushName);
        if (name || pushName) upsert.run(c.id, name, pushName, now);
      }
    })();
  }
  /** Names the user supplied, such as a broadcast CSV. The latest import wins. */
  import(names: { id: string; name: string }[]) {
    const upsert = this.db.query(
      `INSERT INTO contacts(id,imported_name,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET
       imported_name=excluded.imported_name,updated_at=excluded.updated_at`,
    );
    this.db.transaction(() => {
      const now = Date.now();
      for (const n of names) {
        const name = clean(n.name);
        if (name) upsert.run(n.id, name, now);
      }
    })();
  }
}
