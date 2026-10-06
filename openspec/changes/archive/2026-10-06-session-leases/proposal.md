# Session leases: the recording lease moves into `catalog.session_leases`, bound to its user

Tier: 2
Tier reason: a migration adds a new table with row-level security (`supabase/migrations/**`, a
high-risk path). The lease decides a cross-process race with a conditional upsert. The change binds
the recording lease to the signed-in user and hides the holder's tab id from other viewers. It also
changes three observable contracts: who may heartbeat or release, what the status's holder field
shows, and whether a heartbeat advances the session revision. ADR 0021 slice 8a.

Approved-by: Kalen 2026-10-06

## Why

ADR 0021 makes a `session_leases (session_id, kind, holder, expires_at)` table the only authority
for recording and auto-generate, so that more than one server process can run. Today:

- **Storage.** The recording lease is two `catalog.session_meta` keys.
- **Expiry.** An in-process timer per session hub frees an expired lease. Nothing else knows to free
  it if that process dies.
- **Holder.** The holder is a per-tab client id, and `GET /status` shows it to every viewer. Any
  user with access to the session can therefore release, extend, or squat on someone else's lease.
- **Revision.** Every heartbeat advances the session revision, about 7 times a minute per
  recording.
- **Lost leases stay lost.** A heartbeat lapse of more than 40 s mid-take loses the lease for the
  rest of the take, and nothing notices.

## Owner decisions (owner, 2026-10-06)

The plan of record is `~/.claude/plans/i-want-to-use-witty-wreath.md`.

1. **Split slice 8.** 8a (this change) covers the recording lease. 8b moves the auto-generate kinds
   (the shared AI turn slot, transcript generation, YouTube import) from in-process maps to leases.
   Each gets its own proposal, panel and approval.
2. **Ready, not on.** Leases become correct across processes. Production stays single-process: the
   fixed `container_name` and the `DATA_DIR` lock remain.
3. **The lease belongs to a user and a client.**
   - Heartbeat and release act only for the same user and client.
   - Anyone else's heartbeat answers `{"ok":false}`; anyone else's release answers `{"ok":true}`
     and changes nothing.
   - A claim by another user or another client while the lease is alive gets the existing `409`.
4. **Only lease state changes advance the revision.** Claim, release and expiry each advance it; a
   heartbeat does not.
5. **No global sweeper in 8a.** It is deferred to slice 9.
6. **System tasks may hold a lease.** For a reviewed system task, `holder_user_id` is null; users
   can never write null.

After the adversarial panel (owner, 2026-10-06):

7. **Only the holder sees its tab id.** The status shows the real client id to the holding user.
   Every other viewer, including Companion, gets the fixed value `"another-client"`. This closes
   the leak and the squat. The web needs no change for it: it still shows "someone else is
   recording".
8. **The recorder re-claims a refused heartbeat.** When a heartbeat answers `{"ok":false}`
   mid-take, the web re-claims at once. If someone else now holds the lease, it shows a warning and
   keeps recording.

## For the approver

**What a person sees**
- **Normally, nothing changes.** Three exceptions:
  - nobody can stop, extend or squat on another user's recording lease any more;
  - a recording that lost its lease (a restart, sleep, a network blip) now takes it back, or warns
    if someone else took it;
  - on a shared browser, if one user records and then signs out without stopping, a second user
    gets "already recording" for up to 40 s.

**How the server enforces it**
- **Expiry no longer depends on one process's timer** (design D5). Whether a lease is alive is always
  read from the stored expiry. Any process frees an expired lease, through its alarm, opening the
  session, or a takeover claim. A race between processes frees it once.
- **Heartbeats are strict** (D3). A heartbeat after expiry is refused even if the lease hasn't been
  freed. The recorder then re-claims (D7).
- **Row-level security does not tie a live lease to its holder** (D1). The database can't judge
  expiry. The server's statements, which are the only writers, enforce the holder. This is the same
  trust model as the other session tables, and a test pins it.
- **The revision moves less** (D5). It still advances once per claim, release and expiry.

**What stays the same**
- Request schemas, response shapes, Companion, and the 40 s TTL with the 8 s heartbeat cadence.

## What Changes

- **Migration `20261011000000_session_leases.sql`** creates `catalog.session_leases`:
  - columns `session_id`, `kind`, `holder_client_id`, `holder_user_id`, `heartbeat_at_ms` and
    `expires_at_ms`;
  - primary key `(session_id, kind)`, with `kind` checked to `'recording'`;
  - row-level security: system-all, plus user policies scoped to accessible shows that write only the
    user's own id.

  It copies nothing, and the old meta keys stay for a later cleanup.
- **`LeaseStore`** is rewritten on the table:
  - an empty or NUL client id is refused before any statement;
  - claim is a conditional upsert;
  - heartbeat is a strict conditional update that does not count towards the revision;
  - release is a conditional delete;
  - expiry deletes the expired rows and re-arms the alarm;
  - status masks the holder id for anyone but the holder.
- **`SessionCore`** gains `heartbeatLeaseUncounted` (purpose-specific, like `metaSetUncounted`) and
  `callerUserId`.
- **Web.** `AudioRecorder` re-claims after a refused heartbeat, and warns on a `409`.
- **Tests:**
  - a two-process race test;
  - pg policy tests;
  - route tests with a second user, blank and NUL ids, and masking;
  - recorder tests.
- **Docs:** README hub notes and the ADR 0021 slice 8 entry.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `api-contract-freeze`
  - MODIFIED "The session revision advances once per session write": lease claims, releases and
    expiries count; heartbeats do not.
  - ADDED "The recording lease is held by one user and client", covering the client-id guard,
    claim, heartbeat, release, expiry and the masked holder id.
- `catalog-database`
  - ADDED "Session leases are stored in the catalog".
  - MODIFIED "Session content tables": the lease meta keys are retired.
- `core-ports-architecture`: ADDED "Recording leases are correct across processes".
- `live-recording-chunks`: MODIFIED "One lease and one event pair per recording", so the recorder
  re-claims after a refused heartbeat.

## Impact

- **Database:** `supabase/migrations/20261011000000_session_leases.sql`.
- **Session runtime:** `packages/session-core/src/{leaseStore.ts,sessionCore.ts,SessionHub.ts}`.
- **Web:** `web/src/pages/index/components/AudioRecorder.tsx` and its tests.
- **Server tests:**
  - `server/src/test/session/{leaseStore,revision,SessionHub.alarm,retry,isolation,leaseRace}.int.test.ts`;
  - `server/src/test/SessionHub.int.test.ts`;
  - `server/src/test/pg/catalogSchema.pg.test.ts`.
- **Docs:** `README.md` and `docs/decisions/0021-migrate-to-self-hosted-supabase.md`.
- **Unchanged:** `server/src/routers/**` route code, `packages/contract`, Companion, and the
  response fixtures.

## Non-goals

- **8b:** the auto-generate, AI, transcript and YouTube single-flight slots.
- **Not done here, because they need more than one process:**
  - running a second process;
  - the `pg_notify` socket close;
  - cross-process `lease.changed` fan-out (slice 9). Until then, other processes' clients see lease
    changes by polling.
- **Deferred to slice 9:**
  - a global expired-lease sweeper;
  - Realtime Presence and early release when a holder leaves.
- **No owner or admin force-release.**
- **Unchanged:**
  - the lease routes' request and response shapes, the 40 s TTL and the 8 s heartbeat cadence;
  - the old meta rows, which are not dropped here.

## After merge

On the dev stack:

1. Record in one tab.
2. A second user gets the `409`, and their status shows `another-client`.
3. Stop recording; the table is empty.
4. Restart the server for more than 40 s mid-take; the recorder re-claims.
5. Heartbeats leave `catalog.sessions.revision` unchanged.
