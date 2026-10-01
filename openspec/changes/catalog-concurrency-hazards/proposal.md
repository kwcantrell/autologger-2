# Catalog concurrency hazards: race-free team writes, ordered session mirror, bounded root statements

Tier: 2
Tier reason: concurrency and transaction ordering across teams, auth and session routes; observable outcome changes on frozen routes; touches `server/src/routers/**` and the catalog port.

Approved-by: Kalen 2026-10-01 (re-approved after re-panel)

## Why

Since 4c, the catalog runs on Postgres, and requests interleave at every catalog await. ADR 0021's
slice 4 hazard list (items 2-20) is therefore live on dev and stage. Prod is on hold until cutover.
This change, 4d, fixes those hazards before 4e removes the SQLite catalog. Every fix is a transaction, a
conditional statement or an in-process ordering. After the panel, the owner also added two
per-team indexes, so writes in different teams stop conflicting.

## What Changes

- **Team writes are race-free** (#8-#13, #18):
  - **Admin re-check.** Every team admin write (rename, delete, invite, revoke, role change,
    remove) re-checks the caller's admin role, locked for share, inside the same catalog
    transaction as the write. The early check stays, so the order of statuses doesn't change.
  - **Team creation** (cap check, studio, admin membership) is one transaction, on both the
    user and admin planes. It refuses an id that still has shows, and it removes leftover
    memberships, invites and settings for the id, so a reused team id starts empty.
  - **Admin-plane membership removal and account disable are unchanged.** The support plane
    is not subject to last-admin protection (re-panel, 2026-10-01).
  - **Invites** (user lookup, cap check, grant or pending row) are one transaction.
  - **Role changes** update only an existing membership. A member removed concurrently gets
    `404`; the removed member is not re-created.
  - **Removal** checks the membership inside the guarded transaction. A raced second removal gets
    `404`.
  - **Show creation** checks that the team exists, and the caller's membership, inside its
    transaction. The admin-plane membership add re-checks the team the same way.
- **First sign-in** (#15): two concurrent first sign-ins for one Google account both succeed. The
  second finds the user the first created; before, it got a latent `500`.
- **Settings defaults** (#20, #14): reading a team's settings writes the default only when the row
  is missing and the team exists, using `INSERT … ON CONFLICT DO NOTHING` outside a transaction.
  Concurrent first loads no longer conflict, and a deleted team's settings are never recreated.
- **Session mirror** (#3, #4, #17): each session's live projection is mirrored into the catalog
  by one ordered writer per session, which always writes the session's latest state.
  - **Owner (2026-10-01):** a failed mirror write logs a warning and never fails a request whose
    session change is already saved.
  - YouTube and local audio import now mirror too.
  - The episode date written after a YouTube import is best-effort.
- **Companion ack** (#2): it marks the command acknowledged only if that command is still the
  latest, using one compare-and-set statement.
- **Active show** (#5):
  - repairing a stale active show no longer overwrites a concurrent profile update;
  - the anonymous profile's show and studio are written in one transaction.
- **Log import** (#6): the detached job builds its own catalog. Its progress lines keep every
  domain message; a catalog or driver failure appears as a generic line and is logged.
- **Expired KV rows** (#16) are purged every 10 minutes, as well as at boot.
- **Statements outside a transaction** (#19) have a 5 s client-side time limit, and each root
  connection carries one statement at a time. A timeout gets the generic `500` (owner). The
  session mirror waits for a timed-out write to finish before the next one, so order holds.
- **Per-team indexes** (owner, after the panel): `user_studio_memberships (studio_id)` and
  `shows (studio_id)`, in one additive migration.
- **#7 needs no change.** No route holds a session hub across an await.
- **Revisit list.** The owner asked (2026-10-01) that each alternative not taken here be listed
  in ADR 0021 for review after the migration.
- **Size.** After the panel the estimate is 550-650 counted lines. The owner chose one PR, with
  the human-applied `size-override` label and a ceiling of about 650; past that, the work stops
  and splits.

## Non-goals

- **No schema change beyond the two additive indexes.** Foreign keys to `studio_definitions` are
  deferred to the revisit list, because built-in studios aren't rows.
- **No new status codes:** no `503`, no `Retry-After`, no `429`.
- **No multi-process mirror ordering** (a `live_revision` column). That belongs with slice 8
  session leases.
- **No reconcile-on-read** for a mirror write that failed.
- **No removal of the SQLite catalog.** That is 4e.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `team-management`: ADDED "Concurrent team writes".
- `api-contract-freeze`: ADDED "Catalog mirror failures don't fail saved session changes",
  "Concurrent first sign-in succeeds", and "Log-import job lines carry no internal error text".
  MODIFIED "YouTube import endpoint behavior": the success row is best-effort for the episode date
  and the mirror.
- `auto-event-generation`: MODIFIED "Generated events append, bounded and attributable": the
  projection is current when the mirror succeeds, and otherwise logged and healed.
- `youtube-audio-import`: MODIFIED "Publish-date opt-in writes the session episode date via the
  catalog layer": the episode date is best-effort.
- `catalog-database`: ADDED "Session live projection is mirrored in order", "Settings defaults are
  race-free and never recreate a deleted team", and "Expired key/value rows are purged
  periodically".
- `core-ports-architecture`: ADDED "Key/value compare-and-set" and "Root catalog statements are
  time-bounded".

## Impact

- **Code:**
  - `server/src/routers/{teams,shows,admin,auth,companion,events,sessions,logImport,profile}.ts`;
  - new `server/src/sessionMirror.ts`, wired into `server/src/node/config.ts` (a port), plus
    `server/src/main.ts`;
  - `packages/catalog/src/{authStore,studioRegistry,sessionIndexStore}.ts`;
  - `packages/ports/src/kvStore.ts`;
  - `packages/storage/src/{kvStore,postgresCatalogStore}.ts`.
- **Tests:**
  - a gated-catalog test seam (`server/src/test/`);
  - one forced-interleaving test per hazard;
  - the `events.generate.int.test.ts` 500 pin is updated.
- **Migration:** `supabase/migrations/<ts>_catalog_team_indexes.sql`.
- **Docs:** ADR 0021 (4d closed out, the revisit list), plus `docs/supabase.md`.
