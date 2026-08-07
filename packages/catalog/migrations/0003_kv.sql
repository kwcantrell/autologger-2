-- src/db/migrations/0003_kv.sql
-- Value-based KV replacement (login sessions, OAuth CSRF, companion last_command).
-- Companion presence is NOT here — it lives in the in-memory PresenceRegistry.
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER
);
