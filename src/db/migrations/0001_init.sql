-- AutoLogger catalog schema — ported near-verbatim from src/autologger/storage/db.py
-- (D1 *is* SQLite). Catalog tables only. login_sessions + oauth_csrf_tokens move to KV
-- with TTL (auth/identity.ts). Per-session live tables (events, transport, audio,
-- transcript, topics) belong to the phase-3 SessionDO and are out of scope.

-- Identity (from _migrate_auth_identity_v1) -----------------------------------
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    google_sub TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    given_name TEXT NOT NULL DEFAULT '',
    family_name TEXT NOT NULL DEFAULT '',
    picture_url TEXT NOT NULL DEFAULT '',
    created_at_utc TEXT NOT NULL,
    disabled_at_utc TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS user_studio_memberships (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    studio_id TEXT NOT NULL,
    PRIMARY KEY (user_id, studio_id)
);

CREATE TABLE IF NOT EXISTS user_prefs (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    active_studio_id TEXT NOT NULL DEFAULT '',
    active_show_id TEXT NOT NULL DEFAULT ''
);

-- User-defined teams; merged at runtime with built-ins from studio.ts ---------
-- (from _migrate_studio_definitions_v1)
CREATE TABLE IF NOT EXISTS studio_definitions (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at_utc TEXT NOT NULL
);

-- Shows (from _migrate_shows_schema + _migrate_shows_event_palette_presets) ----
CREATE TABLE IF NOT EXISTS shows (
    id TEXT PRIMARY KEY,
    studio_id TEXT NOT NULL,
    name TEXT NOT NULL,
    show_code TEXT NOT NULL,
    next_episode INTEGER NOT NULL DEFAULT 1,
    categories_json TEXT NOT NULL DEFAULT '[]',
    event_palette_json TEXT NOT NULL DEFAULT '[]',
    event_palette_preset TEXT NOT NULL DEFAULT 'custom',
    event_palette_custom_json TEXT NOT NULL DEFAULT '[]',
    created_at_utc TEXT NOT NULL
);

-- Key/value app settings (studio_config:<id> blobs + active studio/show) -------
CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Lightweight sessions index (enough to list sessions per show later without
-- waking a DO; full session live-data is phase-3 SessionDO, not here).
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    show_id TEXT REFERENCES shows(id),
    title TEXT NOT NULL DEFAULT '',
    archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_show ON sessions(show_id);

-- Seed the two built-in shows so a fresh DB matches the Python server's
-- _migrate_shows_v1 / _migrate_studio2_podcast_show_v1 output. Built-in *studios*
-- are constants in studio.ts (not rows); only shows live here. Category ids are
-- fixed (the Python seed uses runtime uuids; values are otherwise identical).
INSERT OR IGNORE INTO shows
    (id, studio_id, name, show_code, next_episode, categories_json,
     event_palette_json, event_palette_preset, event_palette_custom_json, created_at_utc)
VALUES (
    'show-autolog-test', 'test-studios', 'Autolog Test Show', 'ATS', 1,
    '[{"id":"a1000000-0000-4000-8000-000000000001","name":"Scene","color":"#4a9fd4","type":"BUTTON","dropdown_options":[],"on_label":"","off_label":""},{"id":"a1000000-0000-4000-8000-000000000002","name":"Audio issue","color":"#a86bdc","type":"DROPDOWN","dropdown_options":[{"label":"Lav","needs_context":false},{"label":"Boom","needs_context":false}],"on_label":"","off_label":""},{"id":"a1000000-0000-4000-8000-000000000003","name":"Note","color":"#6bcf7a","type":"TEXT","dropdown_options":[],"on_label":"","off_label":""}]',
    '["#4a9fd4","#a86bdc","#6bcf7a","#64748b","#64748b","#64748b","#64748b","#64748b","#64748b"]',
    'custom',
    '["#4a9fd4","#a86bdc","#6bcf7a","#64748b","#64748b","#64748b","#64748b","#64748b","#64748b"]',
    '2024-01-01T00:00:00Z'
);

INSERT OR IGNORE INTO shows
    (id, studio_id, name, show_code, next_episode, categories_json,
     event_palette_json, event_palette_preset, event_palette_custom_json, created_at_utc)
VALUES (
    'show-the-something-podcast', 'test-studio-2', 'The Something Podcast', 'TSP', 1,
    '[{"id":"b2000000-0000-4000-8000-000000000001","name":"Note","color":"#7cb7ff","type":"TEXT","dropdown_options":[],"on_label":"","off_label":""},{"id":"b2000000-0000-4000-8000-000000000002","name":"Mark","color":"#f4a82e","type":"BUTTON","dropdown_options":[],"on_label":"","off_label":""}]',
    '["#7cb7ff","#f4a82e","#64748b","#64748b","#64748b","#64748b","#64748b","#64748b","#64748b"]',
    'custom',
    '["#7cb7ff","#f4a82e","#64748b","#64748b","#64748b","#64748b","#64748b","#64748b","#64748b"]',
    '2024-01-01T00:00:00Z'
);
