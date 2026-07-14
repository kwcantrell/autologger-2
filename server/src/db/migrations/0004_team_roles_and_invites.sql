-- teams-self-serve (design D1/D2/D9): role'd memberships + pending email invites.

-- D1: every membership carries a role. New grants default 'member' (invites,
-- admin-plane adds); team creation inserts 'admin' explicitly in application code.
ALTER TABLE user_studio_memberships ADD COLUMN role TEXT NOT NULL DEFAULT 'member';

-- One-time backfill (D1, gate ruling 2026-07-14): pre-existing memberships become
-- 'admin' so every existing team stays self-manageable, EXCLUDING built-in studio
-- memberships (which stay 'member' — built-ins are excluded from the self-serve
-- management surface wholesale). Built-in ids are hardcoded here — not read from
-- BUILTIN_STUDIO_ORDER in server/src/studio.ts — because migrations are frozen
-- snapshots that must not depend on application code that can change later.
UPDATE user_studio_memberships
SET role = 'admin'
WHERE studio_id NOT IN ('test-studios', 'test-studio-2');

-- D2: pending email invites, keyed on (studio_id, normalized email). email_norm is
-- pre-normalized by application code (JS toLowerCase().trim()) before it ever
-- reaches SQL — never compare/store via SQL lower(), whose ASCII-only folding
-- diverges from JS on non-ASCII local parts. invited_by_user_id is an audit
-- breadcrumb only (not exposed by the API).
CREATE TABLE IF NOT EXISTS team_invites (
    studio_id TEXT NOT NULL,
    email_norm TEXT NOT NULL,
    invited_by_user_id TEXT NOT NULL,
    invited_at_utc TEXT NOT NULL,
    PRIMARY KEY (studio_id, email_norm)
);
