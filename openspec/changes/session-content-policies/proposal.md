# Session content policies: the database checks show access on session content, per hub call

Tier: 2
Tier reason: authorization (row-level policies on the nine session tables and every session hub
call bound to its caller), a migration (a `SECURITY DEFINER` helper, nine policies and
re-granted privileges), a storage port contract (`SessionStorage` and the hub facade take a caller
per call), the reviewed system bindings (new reasons, a scan that learns the session caller) and
the refusal path of every session-scoped route. It touches `supabase/migrations/**` and
`server/src/routers/**`, both high-risk paths. ADR 0021 slice 7b-2.

Approved-by: Kalen 2026-10-03

## Why

Slice 7b-1 moved session content into nine `catalog.session_*` tables, but every session
statement runs as the system task `session-hub` against allow-all policies. The only access check
is the app's gate (`requireSession`): a grant revoked between the gate and the hub write, a missing
gate on a future route, or a background job whose creator lost access still reads and writes
content. 6a/6b-2 gave the rest of the catalog a database backstop; 7b-1 left session content as the
one hole and named the three constraints 7b-2 must meet (session-tables design D2, D14).

## Owner decisions (owner, 2026-10-03)

Plan of record `parsed-honking-lobster.md`:
1. **The rule is full show access** (`accessible_shows`) for read, insert, update and delete on
   all nine tables: the owner or an admin of the show's team, or a member with a grant (any grant,
   `can_write` included or not, as `requireSession`). It is the rule `requireSession` applies. A
   team member without a grant keeps seeing session titles only (the `sessions` read rule is
   unchanged).
2. **AI turns and the log-import job run as the user who started them.** No new system reason is
   needed for them; a creator who lost access has their writes refused by the database, as well as
   by the log import's per-sheet re-check.
3. **No access is told apart from no session** by a new definer helper,
   `catalog.session_exists(id)`, asked after a refused row lock or read probe: the adapter raises
   `SessionAccessDeniedError` or `SessionNotFoundError`. Routes keep their masked answers.
4. **One change**, not split into 7b-2a/7b-2b (it lands as reviewable commits, tasks.md).

## Owner decisions after the panel (owner, 2026-10-03)

The three-reviewer panel found one critical and four major issues (`panel.md`). The owner decided:
- **P1. Undo steps run as a reviewed system task, `session-undo`.** These are the compensating
  steps a route takes after one of its own later steps fails or refuses: the local and YouTube
  imports' `deleteAudioSegment` / `rollbackLocalAudioImportSegment`, the audio upload's undo
  (`audio.ts:214`), and event generation's regenerate delete (`events.ts:597`). Each removes only
  what the same request wrote or, for the regenerate delete, the snapshot that request replaced
  (design D7). A race test covers each.
- **P2. Disabled accounts: stated, nothing changes.** "Loses access" means a membership or a grant,
  as in 6a. Disabling an account is checked at sign-in and ends that account's login sessions; an
  AI turn or log-import job of a disabled account that is already running finishes (Non-goals).

Panel fixes folded in without a scope change: the policy form is a correlated `exists`, flat in the
number of sessions (design A6, D1); `GET /api/companion/state` keeps its frozen no-access `200`
shape; the YouTube import's `502` catch-all lets the access refusal through as `404`; the group-3
implementation splits into two green commits; the remaining minors are in `panel.md`.

## For the approver

- **A session write racing a revoke is now refused** (design D8). Today a request that passed
  `requireSession` writes even if the grant is revoked before its hub call. Now the row lock is
  taken under the caller's policy and fails; the route answers the status it already gives for
  missing access (`404 Session not found`; Companion with a cookie: its no-active-session answers,
  `409` for `categories`/`log`/`transport`/`command` and the masked `200` for `state`). Writes the
  request already made are undone by its existing undo steps, as `session-undo` (P1). This is what
  core-ports-architecture "Policy outcomes keep each route's status" already prescribes for catalog
  writes; a serial order (revoke, then request) produces it, so no api-contract-freeze change.
- **A session read racing a revoke answers the same masked status** (design D4). Under the
  policies a read without access would return empty lists, a body no serial order produces. A user
  snapshot therefore checks access first (one statement pipelined with `BEGIN`, no extra round
  trip) and refuses like a write.
- **Background work stops at the database when its user loses access** (owner decision 2): an AI
  tool call after a revoke fails with a neutral tool error; a log-import sheet after a revoke is
  reported failed, and the per-sheet re-check stops the job.
- **Write latency rises slightly and does not grow with the catalog** (design A6, D11): the policy
  costs one primary-key probe of `catalog.sessions` per row checked. Spike at 300, 3,000 and 20,000
  accessible sessions: a one-row insert 0.45 ms flat, a 200-row events read 0.65-2.0 ms, the
  31,621-row words insert 238-251 ms (the first draft's set form grew to 9.3 ms and 18.3 ms at
  20,000). The stop rule is the owner's current one, measured under a user binding with 300 and
  3,000 sessions seeded.
- **Token-only Companion calls stay system calls for any session id** (slice 9's credential), and
  are the one path the policies do not cover.
- **The scan of reviewed bindings grows** (design D9): session callers are made only by
  `systemCaller('<reason>')` (scanned like `.system(`) and `userCaller(id)` (two reviewed router
  files); `new PostgresSessionDb(` only in the composition root and the merge script;
  `server/scripts` joins the scanned roots.

## What Changes

- **Migration** `supabase/migrations/20261009000000_session_content_policies.sql` (design D1; draft
  pinned as `spike/20261009000000_session_content_policies.sql`): definer helper
  `catalog.session_exists(id)` in the 6b-2 pattern; one `<table>_user_all` policy per session table,
  `exists (select 1 from catalog.sessions s where s.id = session_id and s.show_id in (select
  catalog.accessible_shows(catalog.app_user_id())))` for using and with check; `select, insert,
  update, delete` re-granted to `catalog_user`. 23 `catalog_user` policies become 32.
- **The session caller** (design D2): `SessionCaller`, an opaque value made only by
  `userCaller(userId)` and `systemCaller(reason)` in session-core.
- **The seam carries the caller per call** (design D3): `SessionStorage.tx(caller, fn)` and
  `snapshot(caller, fn)`; `registry.get(id)` resolves an entry whose storage methods are reached only
  through `hub.as(caller)`, a view sharing the hub's FIFO lock, broadcasts and alarm. The hub's own
  calls run as `session-open` (open: seed and stale-lease cleanup) and `session-lease-alarm`.
- **The adapter binds per call** (design D4, D5): `PostgresSessionDb` takes the catalog root and
  binds each call to its caller (`bindUser` returns the session-capable handle on the concrete
  adapter; the `CatalogRoot` port is unchanged). A refused row lock, or a user snapshot whose
  pipelined probe finds no access, raises `SessionAccessDeniedError` (new, neutral message) or
  `SessionNotFoundError` by `session_exists`.
- **Callers** (design D6, D7): `getSessionHub` binds to the signed-in user; token-only Companion
  calls to `companion-token`; AI turns carry the route's caller to their tool bodies; the log-import
  job binds to its creator; undo steps bind to `session-undo` (P1); session create only opens the
  hub; the merge script runs as `merge-audio-script`.
- **Refusals** (design D8): `app.onError` answers `SessionAccessDeniedError` with
  `404 {"detail":"Session not found"}`; the YouTube import's catch-all passes it through; the
  Companion routes map it to their no-access answers. No new status anywhere.
- **Reviewed bindings** (design D9), **tests** (design D12), **README** show-access and SessionHub
  notes, **ADR 0021** 7b-2 entry (design D13).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `catalog-database`:
  - MODIFIED "Row-level security is enabled on every catalog table": every table but `kv` has
    `catalog_user` policies; the session tables follow show access.
  - MODIFIED "User policies enforce the team permission model": the session content row in the
    rule table and the matrix, a member without a grant, and the row lock.
  - MODIFIED "Policy helpers are reviewed definer functions": `session_exists`.
- `core-ports-architecture`:
  - REMOVED "Every catalog call is bound to a caller", ADDED "Every catalog and session call is
    bound to a caller": hub calls bound per call, the session caller constructors, the reasons, and
    a replacement for the scenario "Session hub statements run as the session-hub system task"
    (OpenSpec refuses a MODIFIED block that drops a scenario; checked, `panel.md` minor 8).
  - MODIFIED "Policy outcomes keep each route's status": hub calls refused in a race, undo steps.
  - MODIFIED "Session runtime is an asynchronous, per-session serialized port on Postgres": the
    caller per call, no access told apart from no session.
  - MODIFIED "The Postgres session adapter": per-call bindings, the read probe.

`api-contract-freeze` and `team-management` are not changed: no status, body, header or frame
changes for a request a serial order can produce, and the access rule is team-management's
"Member content access", unchanged.

## Non-goals

- **Changing the `sessions` row rules** (titles stay readable by every member) or any route's
  status, body or message.
- **A Companion device credential** (slice 9); token-only calls stay `companion-token` for any
  session id, and presence stores a token-only caller's session id unchecked, as today.
- **Disabled accounts** (P2): access means a membership or a grant. Disabling an account is checked
  at sign-in and ends its login sessions; an AI turn or log-import job already running for a
  disabled account runs to completion under that account's memberships and grants.
- **Revisions, version checks and `409`s** (7c); **session leases across processes** (slice 8).
- **Optimising the adapter's per-transaction overhead** (ADR 0021 revisit item).
- **Per-row policies on `created_by`**, `can_write`, or any rule finer than show access.
- **New runtime dependencies.**

## Impact

- **Code:**
  - `supabase/migrations/20261009000000_session_content_policies.sql`;
  - `packages/storage/src`: `postgresCatalogStore.ts` (the read probe, the existence check,
    `bindUser`'s return type), `postgresSessionSql.ts`, `catalogErrors.ts`
    (`SessionAccessDeniedError`), `index.ts`;
  - `packages/session-core/src`: `sessionCore.ts` (the seam), `SessionHub.ts` (`as`, the facade
    split, the system callers), new `sessionCaller.ts`, `index.ts`;
  - `packages/ai-runtime/src`: `aiMcpServer.ts`, `mcpTools.ts`, `aiTurn.ts`, `topicGenerate.ts`;
  - `server/src`: `node/config.ts`, `app.ts`, routers `_helpers.ts` (`getSessionHub` binds; its
    call sites are unchanged), `companion.ts`, `sessions.ts`, `audio.ts`, `events.ts`, `aiV2.ts`,
    `ai.ts`, `transcribe.ts`, `logImport.ts`: about 13 production edits;
    `server/scripts/merge-session-audio.ts`;
  - tests (design D12).
- **Specs:** the deltas above.
- **Docs:** README; ADR 0021's slice 7 entry.
- **Operators:** the migration runs with `make <env>-up`. No env var, no data change.
- **Performance:** design A6 and D11.

## After merge

Outside tasks.md, because they need the merged branch or `make stage-up` permission:
- **Dev live check** (`make dev-up` applies the migration): the 7b-1 checklist (log, edit and
  delete events with a second tab open; start and stop takes; topic and event generation; a local
  audio import); Companion with a token and with a cookie; an AI chat event; a log import; in
  `psql`, as `catalog_user` with `app.user_id` set to the owner the session tables show rows, and
  set to an outsider none.
- **Stage live check**, with the owner's permission for `make stage-up`: the same walk-through.
- **Prod:** prod runs `main` until slice 11's cutover, so no prod step here.
