-- session-title-suffix (design D2/D3/D4/D7): per-show title-suffix preference
-- driving create-time session title derivation (`CODE_YYMMDD` vs
-- `CODE_episode`). New rows default to 'date'; pre-existing shows are
-- backfilled to 'episode' so their current episode-number workflow keeps
-- working unchanged (D7, gate ruling 2026-08-02).
ALTER TABLE shows ADD COLUMN title_suffix TEXT NOT NULL DEFAULT 'date';

-- One-time backfill (D7): every show that already existed when this
-- migration runs keeps the Episode Number workflow. Shows created AFTER this
-- migration runs pick up the column default ('date') on INSERT.
UPDATE shows SET title_suffix = 'episode';

-- shows.next_episode is retained but UNUSED as of this change (design D1,
-- gate ruling 2026-08-02 — soft-retain for rollback safety): application
-- code no longer bumps it on session create and it is not exposed on the
-- show wire. NOT dropped here. See server/src/db/showsStore.ts (createShow /
-- updateShowFields) and server/src/db/sessionIndexStore.ts (createSessionIndex).
