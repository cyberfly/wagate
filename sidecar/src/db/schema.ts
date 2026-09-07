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
