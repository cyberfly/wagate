import type { Database } from "bun:sqlite";
import type { ContactNames, PhoneLink } from "../messaging/types";
const clean = (value?: string | null) => value?.trim().slice(0, 200) || null;
/**
 * Names for people, as WhatsApp knows them. ChatRepository picks one to show:
 * the saved name, then WhatsApp's chat name, then the profile name.
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
  /** Which phone number each LID belongs to. */
  linkPhones(links: PhoneLink[]) {
    const upsert = this.db.query(
      `INSERT INTO lid_phones(lid,phone,updated_at) VALUES(?,?,?) ON CONFLICT(lid) DO UPDATE SET
       phone=excluded.phone,updated_at=excluded.updated_at WHERE phone<>excluded.phone`,
    );
    this.db.transaction(() => {
      const now = Date.now();
      for (const l of links) upsert.run(l.lid, l.phone, now);
    })();
  }
}
