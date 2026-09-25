export const schema = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, provider TEXT NOT NULL, name TEXT);
CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, name TEXT);
CREATE TABLE IF NOT EXISTS chats (
 id TEXT PRIMARY KEY, provider TEXT NOT NULL DEFAULT 'whatsapp', provider_chat_id TEXT NOT NULL,
 name TEXT NOT NULL, type TEXT NOT NULL, last_message_at INTEGER,
 ai_mode TEXT NOT NULL DEFAULT 'off' CHECK(ai_mode IN ('off','copilot')),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
 id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_message_id TEXT NOT NULL,
 chat_id TEXT NOT NULL REFERENCES chats(id), sender_id TEXT NOT NULL,
 direction TEXT NOT NULL, type TEXT NOT NULL, text TEXT, timestamp INTEGER NOT NULL,
 created_at INTEGER NOT NULL, UNIQUE(chat_id, provider_message_id)
);
CREATE INDEX IF NOT EXISTS messages_chat_time ON messages(chat_id,timestamp DESC,id DESC);
CREATE TABLE IF NOT EXISTS api_keys (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
 permissions TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS webhooks (id TEXT PRIMARY KEY, url TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS ai_profiles (id TEXT PRIMARY KEY, model TEXT NOT NULL, system_prompt TEXT NOT NULL, context_size INTEGER NOT NULL DEFAULT 20);
CREATE TABLE IF NOT EXISTS drafts (
 id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), source_message_id TEXT NOT NULL UNIQUE,
 text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL
);
PRAGMA user_version = 1;
`;
export const broadcastSchema = `
CREATE TABLE IF NOT EXISTS broadcasts (
 id TEXT PRIMARY KEY, name TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('running','paused','completed','cancelled')),
 min_delay INTEGER NOT NULL, max_delay INTEGER NOT NULL, error TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS broadcast_recipients (
 broadcast_id TEXT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE, position INTEGER NOT NULL,
 chat_id TEXT NOT NULL, label TEXT NOT NULL, text TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','uncertain','cancelled')),
 message_id TEXT, error TEXT, sent_at INTEGER,
 PRIMARY KEY(broadcast_id, position)
);
CREATE INDEX IF NOT EXISTS broadcast_recipients_status ON broadcast_recipients(broadcast_id,status,position);
PRAGMA user_version = 2;
`;
export const broadcastLogSchema = `
ALTER TABLE broadcast_recipients ADD COLUMN attempted_at INTEGER;
CREATE TABLE IF NOT EXISTS broadcast_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 broadcast_id TEXT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
 at INTEGER NOT NULL,
 type TEXT NOT NULL CHECK(type IN ('created','sent','uncertain','paused','resumed','cancelled','completed')),
 position INTEGER, detail TEXT
);
CREATE INDEX IF NOT EXISTS broadcast_events_broadcast ON broadcast_events(broadcast_id,id);
PRAGMA user_version = 3;
`;
// contacts.name is the name saved in your phone; push_name is the name the
// contact set for themselves; imported_name came from your own broadcast CSV.
// Names already sent to in a broadcast are backfilled, latest broadcast first.
export const contactNamesSchema = `
ALTER TABLE contacts ADD COLUMN push_name TEXT;
ALTER TABLE contacts ADD COLUMN imported_name TEXT;
ALTER TABLE contacts ADD COLUMN updated_at INTEGER;
INSERT INTO contacts(id,imported_name,updated_at)
 SELECT r.chat_id,r.label,MAX(b.created_at) FROM broadcast_recipients r JOIN broadcasts b ON b.id=r.broadcast_id
 WHERE r.label<>substr(r.chat_id,1,instr(r.chat_id,'@')-1)
 GROUP BY r.chat_id
 ON CONFLICT(id) DO UPDATE SET imported_name=excluded.imported_name,updated_at=excluded.updated_at;
PRAGMA user_version = 4;
`;
// WhatsApp can reject a message after it left the socket, and later confirms
// delivery and reading. SQLite cannot widen a CHECK constraint in place, so
// both tables are rebuilt with their rows, ids and indexes.
export const deliverySchema = `
CREATE TABLE broadcast_recipients_next (
 broadcast_id TEXT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE, position INTEGER NOT NULL,
 chat_id TEXT NOT NULL, label TEXT NOT NULL, text TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','delivered','read','failed','uncertain','cancelled')),
 message_id TEXT, error TEXT, sent_at INTEGER, attempted_at INTEGER,
 PRIMARY KEY(broadcast_id, position)
);
INSERT INTO broadcast_recipients_next(broadcast_id,position,chat_id,label,text,status,message_id,error,sent_at,attempted_at)
 SELECT broadcast_id,position,chat_id,label,text,status,message_id,error,sent_at,attempted_at FROM broadcast_recipients;
DROP TABLE broadcast_recipients;
ALTER TABLE broadcast_recipients_next RENAME TO broadcast_recipients;
CREATE INDEX broadcast_recipients_status ON broadcast_recipients(broadcast_id,status,position);
CREATE TABLE broadcast_events_next (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 broadcast_id TEXT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
 at INTEGER NOT NULL,
 type TEXT NOT NULL CHECK(type IN ('created','sent','failed','uncertain','paused','resumed','cancelled','completed')),
 position INTEGER, detail TEXT
);
INSERT INTO broadcast_events_next(id,broadcast_id,at,type,position,detail)
 SELECT id,broadcast_id,at,type,position,detail FROM broadcast_events;
DROP TABLE broadcast_events;
ALTER TABLE broadcast_events_next RENAME TO broadcast_events;
CREATE INDEX broadcast_events_broadcast ON broadcast_events(broadcast_id,id);
PRAGMA user_version = 5;
`;
// Names now come from WhatsApp only, so broadcast CSV names are removed.
// Chats gain WhatsApp's pin and archive state, which order the inbox.
export const chatOrderSchema = `
DELETE FROM contacts WHERE name IS NULL AND push_name IS NULL;
ALTER TABLE contacts DROP COLUMN imported_name;
ALTER TABLE chats ADD COLUMN pinned_at INTEGER;
ALTER TABLE chats ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
PRAGMA user_version = 6;
`;
// NULL follows WhatsApp; 0 or 1 is a persistent local inbox override.
export const inboxPinsSchema = `
ALTER TABLE chats ADD COLUMN inbox_pinned INTEGER CHECK(inbox_pinned IN (0,1));
ALTER TABLE chats ADD COLUMN inbox_pinned_at INTEGER;
PRAGMA user_version = 7;
`;
export const groupAutomationSchema = `
CREATE TABLE group_automations (
 chat_id TEXT PRIMARY KEY REFERENCES chats(id), group_name TEXT NOT NULL,
 topics TEXT NOT NULL, instructions TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('original','news','mixed')),
 delivery TEXT NOT NULL CHECK(delivery IN ('automatic','approval')), time_zone TEXT NOT NULL,
 schedule TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, next_run_at INTEGER,
 updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE automation_posts (
 id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES group_automations(chat_id), group_name TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('generating','pending','sending','sent','delivered','read','failed','uncertain','dismissed','skipped')),
 text TEXT NOT NULL DEFAULT '', error TEXT, scheduled_for INTEGER, created_at INTEGER NOT NULL,
 sent_at INTEGER, message_id TEXT, provider_message_id TEXT, UNIQUE(chat_id,scheduled_for)
);
CREATE INDEX automation_posts_chat ON automation_posts(chat_id,created_at DESC,id DESC);
CREATE INDEX automation_posts_receipt ON automation_posts(provider_message_id);
PRAGMA user_version = 8;
`;
// Group senders are often known only by LID. WhatsApp reveals the phone number
// behind a LID in messages, contacts and group member lists; it is kept here
// so old messages show a number and the name saved for it.
export const lidPhonesSchema = `
CREATE TABLE lid_phones (lid TEXT PRIMARY KEY, phone TEXT NOT NULL, updated_at INTEGER NOT NULL);
PRAGMA user_version = 9;
`;
/** Applied in order; entry N moves the database from version N to N+1. */
export const migrations = [
  schema,
  broadcastSchema,
  broadcastLogSchema,
  contactNamesSchema,
  deliverySchema,
  chatOrderSchema,
  inboxPinsSchema,
  groupAutomationSchema,
  lidPhonesSchema,
];
