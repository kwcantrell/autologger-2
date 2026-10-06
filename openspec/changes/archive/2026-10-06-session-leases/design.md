# Design: session-leases (ADR 0021 slice 8a)

## Context

The recording lease today (line numbers at base `6ec121c2`):

**Store.** `packages/session-core/src/leaseStore.ts` (`LeaseStore`, built per hub transaction) keeps
`lease_holder` (the client id) and `lease_seen_ms` in `catalog.session_meta`.
- Writes go through `metaSet`/`metaDelete` on the counting handle (`sessionCore.ts:435-490`), so
  every claim, heartbeat, release or expiry advances `catalog.sessions.revision`
  (`revision.int.test.ts:78`).
- `LEASE_STALE_MS = 40_000`.
- An empty (trimmed) client id is refused before any read: claim gives `false`, heartbeat gives
  `false`, release does nothing (`leaseStore.ts:29-30,45-46,55-56`).

| Operation | Behaviour |
| --- | --- |
| Claim | Succeeds when there is no holder, the caller is the holder, or the lease is stale. On success: arm the alarm at now+40 s and broadcast `lease.changed`. |
| Heartbeat | Holder only; re-arms the alarm. |
| Release | Holder only; frees the lease and broadcasts. |
| Status | Computes alive and age from `seen` on every read. |

**Hub.** `SessionHub` runs each lease operation as one write transaction behind the session's
`FOR UPDATE` row lock and the in-process FIFO lock.
- **The alarm** (`alarmTimer`, `SessionHub.ts:~497, 649-691`) is one in-process timer per hub. It
  runs `expireIfStale` as `systemCaller('session-lease-alarm')`, backing off from 1 s, doubling,
  capped at 40 s.
- **Opening a session** runs it as `systemCaller('session-open')`.

**Routes** (`server/src/routers/events.ts:154-188`). The body is `{client_id}`, trimmed by the
route. The schema is `z.string().min(1).max(256)` (`packages/contract/src/schemas.ts:124-127`).

| Route | Answers |
| --- | --- |
| `POST …/audio-recording-lease` | `200 {ok:true}`, or `409 {detail:"Another window, tab, or user is already recording audio for this session."}` |
| `POST …/heartbeat` | `200 {ok:boolean}` |
| `POST …/release` | `200 {ok:true}` |

The status exposes `audio_recording_lease_holder_id` (the raw tab id, to every viewer),
`_alive` and `_age_sec`.

**Web.**
- **Identity.** The holder is a per-tab UUID (`web/src/shared/utils/clientId.ts`).
- **Recorder.** The web claims before `getUserMedia`. It heartbeats every 8 s and ignores the result
  (`AudioRecorder.tsx:624-629`). It releases after the final drain, or with `sendBeacon` on
  `pagehide`.
- **Blocking.** The web treats a live lease whose holder id differs from its own as "another client
  is recording" (`TransportControls.tsx:309-314`, `computeRemoteRecordingBlocksMedia`).

**Companion.** It reads only `is_recording = lease_alive`.

## Assumptions

Each assumption gives the command that tested it and the observed output. The SQL tests ran inside
transactions that were rolled back on the dev database.

- **A1. The claim is atomic without the row lock.** Under READ COMMITTED, a conflicting upsert
  waits, then re-evaluates its `WHERE` against the newest row version.
  - Test: session s1 updated a row without committing; session s2 ran
    `INSERT … ON CONFLICT … DO UPDATE … WHERE value = 'X'`.
  - Observed: s2 blocked from 19:10:51.66 until s1's rollback at 19:10:53.655, then returned
    `INSERT 0 0`. With `WHERE value = '4'` it returned `INSERT 0 1`.
  - Session writes run `BEGIN ISOLATION LEVEL READ COMMITTED` (`postgresCatalogStore.ts:169`).
  - The committed-winner case is covered by the D6 race test.
- **A2. The update policy's USING must not name the holder.** Postgres evaluates the
  `DO UPDATE … WHERE` first, then the UPDATE policy's USING on rows that pass.
  - With a holder-scoped USING, a refused claim against a live lease returns `INSERT 0 0`, but a
    *takeover* of an expired lease fails: `ERROR: 42501: new row violates row-level security
    policy (USING expression)`.
  - With USING = the access rule alone:
    - the takeover gives `INSERT 0 1` (holder V);
    - a delete of another user's lease gives `DELETE 0`;
    - an update of the holder to another user gives `42501`;
    - inserts naming another user, on an inaccessible show, or with a null holder each give
      `42501`.
- **A3. bigint is already a number.** The adapter parses bigint as a JS number
  (`postgresCatalogStore.ts:138`, `types: { bigint: { … parse: Number } }`), so no conversion is
  needed for epoch ms.
- **A4. Lease routes always run as a user, and the harness as a system task.**
  - Routes: `getSessionHub` → `.as(sessionCaller(c))` → `userCaller(requireUser(c).id)`
    (`server/src/routers/_helpers.ts:28-40`). The only callers of claim, heartbeat and release are
    `events.ts:164,178,186`.
  - Harness: it uses `TEST_CALLER = systemCaller('test-harness')` (`testHub.ts:16`).
    `boundCore` binds with no caller, so `callerUserId` is null there.
- **A5. Refusals count as no change.**
  - A refused claim (`ON CONFLICT DO UPDATE WHERE false`) reports `changes: 0`; the adapter maps
    postgres.js `count` (`postgresCatalogStore.ts:897,933`).
  - The counting handle advances the revision only `if (result.changes > 0)`
    (`sessionCore.ts:163`).
- **A6. The default privileges grant what the table needs.**
  - `pg_default_acl` for `postgres` in schema `catalog` is `{catalog_user=arwd, catalog_system=arwd}`.
  - A table created as `postgres` got both grants; one created as `supabase_admin` got none.
  - So the migration runs as `postgres`, like the others. The exposure test loops over the table
    list for `anon`, `authenticated`, `service_role` and `public` (`catalogSchema.pg.test.ts:959-973`).
- **A7. The dev database holds no lease meta rows.**
  `select key, count(*) from catalog.session_meta group by 1` returns only `relink_checked_rev`,
  `events_stream_revision` and `audio_seam_parts_json`.
- **A8. Containers on one host share the kernel clock.** Across hosts, NTP keeps skew far below the
  32 s margin (a 40 s TTL minus an 8 s heartbeat). D6 case (d) runs one process 500 ms ahead.

## Decisions

### D1. The table and its policies

```sql
create table catalog.session_leases (
  session_id       text collate "C" not null references catalog.sessions (id),
  kind             text collate "C" not null,
  holder_client_id text collate "C" not null,
  holder_user_id   text collate "C",            -- null: a reviewed system task holds it
  heartbeat_at_ms  bigint not null,
  expires_at_ms    bigint not null,
  primary key (session_id, kind),
  constraint session_leases_kind_check check (kind in ('recording')),
  constraint session_leases_client_check check (holder_client_id <> '' and length(holder_client_id) <= 256)
);
```

- **Key.** It leads with `session_id`, as the session tables do.
- **8b.** It only replaces the named kind check and adds entries to a TypeScript `LeaseKind` union
  and TTL map. If 8b needs a claim time (for example transcript generation's frozen
  `started_at`), it adds the column then; 8a has no reader for one.
- **No foreign key to users**, matching `session_overwrites.user_id`.
- **Sessions are only soft-deleted** (`ui_hidden`), so the no-cascade session foreign key blocks
  nothing.

**Row-level security.** `R` is the 7b-2 access rule:
`exists (… sessions s where s.id = session_id and s.show_id in (select catalog.accessible_shows(catalog.app_user_id())))`.
- `session_leases_system_all`: all commands, to `catalog_system`.
- `_user_select`: using `R`.
- `_user_insert`: with check `R and holder_user_id = catalog.app_user_id()`.
- `_user_update`: using `R`, with check `R and holder_user_id = catalog.app_user_id()`. USING is `R`
  alone (A2).
- `_user_delete`: using `R and holder_user_id = catalog.app_user_id()`.

**What RLS does not do.** It does not tie a *live* lease to its holder. A `catalog_user` binding
with show access could rewrite another user's live lease to itself with a plain `UPDATE`. The
database can't judge expiry, because it has no Clock time.
- The binding to a user is therefore enforced by the server's statements (D3), which are the only
  writers.
- A pg test pins this behaviour as accepted.
- The same is true today of every session-content table under 7b-2.

**Migration.**
- The table starts empty.
- The `lease_holder` / `lease_seen_ms` meta rows stay in place for a later cleanup migration, with
  `events_stream_revision`.
- The migration runs as `postgres` (A6).

### D2. The time base is the Clock port

- Every comparison binds `now` from `core.now()`.
- Stored times are epoch ms, never database `now()`. Core-ports-architecture requires lease
  staleness and alarm scheduling to share the Clock, and the fake-clock tests depend on it. The
  precedent is `kv.expires_at`.
- TTL per kind: `{ recording: LeaseStore.LEASE_STALE_MS }` (40 000).
- Clock skew: A8.

### D3. Statements

All of them run inside the hub transaction. The session row lock is kept for ordering with the
revision and broadcasts; each statement decides its outcome on its own (A1).

**Client-id guard (unchanged from today).** The route trims the client id. Before any statement:
- An empty id is refused: claim gives `false` (409), heartbeat gives `false`, release does nothing.
- An id containing NUL (`\u0000`) is treated the same way. Postgres rejects NUL in text (`22021`),
  so binding it would give a 500.

**Claim** (counting handle; wins when `changes === 1`):

```sql
INSERT INTO session_leases (session_id, kind, holder_client_id, holder_user_id, heartbeat_at_ms, expires_at_ms)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT (session_id, kind) DO UPDATE SET
  holder_client_id = excluded.holder_client_id, holder_user_id = excluded.holder_user_id,
  heartbeat_at_ms = excluded.heartbeat_at_ms, expires_at_ms = excluded.expires_at_ms
WHERE session_leases.expires_at_ms <= ?
   OR (session_leases.holder_client_id = excluded.holder_client_id
       AND session_leases.holder_user_id IS NOT DISTINCT FROM excluded.holder_user_id)
```

- On a win it arms the alarm at `now + ttl` and broadcasts `lease.changed`.
- A refused claim writes nothing, and the revision does not move (A5).
- A claim by the same user and client refreshes the lease, which counts as a claim.
- There is no `RETURNING`: the repo scan forbids writes through `all(`.

**Heartbeat.** A purpose-specific `SessionCore.heartbeatLeaseUncounted(...)` runs this on the raw
handle, so it never advances the revision (D5):

```sql
UPDATE session_leases SET heartbeat_at_ms = ?, expires_at_ms = ?
WHERE session_id = ? AND kind = ? AND holder_client_id = ? AND holder_user_id IS NOT DISTINCT FROM ? AND expires_at_ms > ?
```

- On success it re-arms the alarm. It never broadcasts.
- It is strict: an expired lease cannot be revived, whether or not a process has freed it yet. The
  web re-claims instead (D7).

**Release** (counting handle; broadcasts when a row changed):

```sql
DELETE FROM session_leases WHERE session_id = ? AND kind = ? AND holder_client_id = ? AND holder_user_id IS NOT DISTINCT FROM ?
```

**Expire** (`expireIfStale`, all kinds, counting handle; broadcasts when a row changed):
- It runs `DELETE … WHERE session_id = ? AND expires_at_ms <= ?`.
- It then re-arms the alarm at the `min(expires_at_ms)` of any remaining rows.

**Status.**
- It reads the `recording` row.
- `alive = now < expires_at_ms`.
- `age_sec = max(0, (now - heartbeat_at_ms) / 1000)`.
- `holder_id` follows D4. An expired row that nobody has freed reports `alive: false`, as today.

**Caller identity.** `SessionCore.callerUserId` gives the user caller's id; it is null for a system
or token caller.

### D4. Only the holder sees its tab id (owner decision 7)

**The problem.** The tab id is the holder's credential. Showing it to every viewer let any user with
session access squat on it after the holder released: they would claim with that id and heartbeat
it. The real holder's tab would then show "recording" as its own, and its Record click would get a
409.

**The rule.** `audio_recording_lease_holder_id` is the real `holder_client_id` only when the caller
is the holding user (`callerUserId === holder_user_id`), or when both are null (a system caller
reading a system-held lease). Every other caller, including the Companion token caller, gets the
fixed value `"another-client"`.
- The fixed value is non-empty and never equals a tab UUID.
- So `computeRemoteRecordingBlocksMedia` still treats the lease as another client's, and the web
  needs no change.
- With no lease the field stays as it is today.
- The "both null" case only matters to test harness reads. In 8a every lease route runs as a user
  (A4), so no system task holds a recording lease.
- Companion never receives the field: `/api/companion/state` exposes only `is_recording`, and the
  token-only Companion cannot call `GET /status` (`requireUser`).

### D5. Expiry does not depend on one process's timer, and heartbeats don't count

**Liveness.** It is always read from `expires_at_ms`, in status and in the claim. If no process ever
frees an expired row, every reader sees "not recording", and anyone can claim it.

**Who frees an expired row.** Any process, through any of three paths:
- its lease alarm, armed by a claim or heartbeat on that process;
- opening the session;
- a takeover claim.

Freeing deletes the row once, advances the revision once, and broadcasts `lease.changed` to that
process's sockets. A second process racing it deletes 0 rows and does nothing.

**Not added: status-read arming.** The first draft armed an idle alarm from a status read. The panel
cut it: liveness is already computed on every read, a takeover is one upsert, and in single-process
production it never fires. It also raced the alarm's own run (the timer slot is cleared before the
run takes the lock).

**Rows nobody frees.** An expired row on a session no process is looking at stays until the next
open or claim, and reads as not alive. The global sweeper is deferred to slice 9 (owner decision 5).

**Unchanged:**
- `evictIdle` skips hubs with an armed alarm;
- `runAlarm` keeps its backoff;
- no new system reasons are needed (`server/src/catalogSystem.repo.test.ts:52-57`).

**Revision.**
- Claim, release and expire go through `core.db.run`, the counting handle. Each advances the
  revision once when it changes a row.
- The heartbeat goes through `heartbeatLeaseUncounted`. This follows the purpose-specific
  `metaSetUncounted` precedent (`sessionCore.ts:473-482`), with no generic escape hatch and no new
  repo guard.

### D6. Test strategy

Test-first, one commit per group.

**Cross-process** (`server/src/test/session/leaseRace.int.test.ts`). Two registries over two
adapters share a fake time, following the precedent in `versionRace.int.test.ts` /
`crossProcess.int.test.ts`. They check that:
- **(a)** 200 rounds of two users claiming give exactly one winner per round, and the revision rises
  by 2 per round after the winner releases;
- **(b)** the bare upsert on two transactions, without the session row lock, still gives one
  winner;
- **(c)** when A claims and dies, B's status reads not alive once the lease expires, and B's claim
  takes it over;
- **(d)** when both alarms fire, the row goes once, the revision rises by 1, and one broadcast goes
  out in total;
- **(e)** when B's clock is 500 ms ahead while A heartbeats every 8 s, B never frees the lease.

**Existing tests that change.** Only these categories; anything else is a stop.
1. Tests that read or write the lease meta keys move to the table: `leaseStore.int.test.ts`,
   `retry.int.test.ts:33-40`.
2. The assertion that a heartbeat advances the revision (`revision.int.test.ts:78-108`).
3. The catalog schema, policy lists and recorded schema (`catalogSchema.pg.test.ts`), plus any
   policy-count test.
4. The obsolete NaN-coercion lease test (`leaseStore.int.test.ts:~95`).
5. `SessionHub.alarm.int.test.ts:100-110`. Its uncommitted "fresh heartbeat" becomes a raw
   `UPDATE session_leases SET expires_at_ms …`.
6. The session-isolation guard (`server/src/test/session/isolation.int.test.ts`) adds
   `session_leases` to its `TABLES` map. Its `fill()` claims a lease, so that write must stay
   covered.
7. Status assertions on `audio_recording_lease_holder_id` made by a caller other than the holder
   expect `"another-client"`.
8. Web tests of `AudioRecorder` heartbeats (D7).

### D7. The recorder re-claims a refused heartbeat (owner decision 8)

**The problem.** A lapse of more than 40 s mid-take (a deploy or restart, sleep, a network blip)
loses the lease for the rest of the take. The web keeps recording with no lease: status and
Companion say "not recording", and a second user could start recording in the same session. Today's
code behaves the same; a strict heartbeat makes the lapse permanent.

**The fix** in `web/src/pages/index/components/AudioRecorder.tsx` is a small state machine per
take, with two modes: *holding* and *lost*.

| Mode | On each 8 s tick | Response | Next mode |
| --- | --- | --- | --- |
| Holding | Send a heartbeat | `{ok:true}` | Holding |
| | | `{ok:false}` | Send one re-claim at once with the take's client id |
| Lost | Send a claim (not a heartbeat) | `200` | Holding |
| | | `409` | Lost |

A re-claim that succeeds returns to *holding*. A re-claim refused with `409` moves to *lost*.

- **One warning per loss.** On entering *lost*, the recorder shows one warning toast ("Another
  window, tab, or user now holds the recording lease."). It warns again only after a successful
  re-claim and a later loss.
- **Capture always continues.** No data is discarded.
- **One request at a time.** At most one claim or heartbeat is in flight; a tick skips while one
  is pending.
- **Bound to its take.** Every response is checked against the take that sent it
  (`takeRef.current === take`, still capturing) before it is acted on.
  - A claim that succeeds after its take stopped is released at once.
  - `finalizeStop` waits for an in-flight claim to settle before it sends its release, so a
    re-claim can never land after the final release.
- **`pagehide`** stays best-effort: the beacon release goes out regardless. If a re-claim is in
  flight at that moment and lands after it, the lease lapses after 40 s, as a closed tab's lease
  does today.

**Tests:** `AudioRecorder` tests cover:
- a refused heartbeat leading to one re-claim;
- a `409` on the re-claim giving one toast while capture continues;
- each later tick sending a claim and no heartbeat, with no second toast on a repeated `409`;
- a later successful claim returning to heartbeats;
- a stop while a re-claim is pending, which ends with a release after the claim settles;
- a claim that succeeds after its take stopped being released;
- a successful heartbeat sending no claim.

**Spec:** live-recording-chunks "One lease and one event pair per recording" is MODIFIED to allow a
re-claim after a refused heartbeat.

## Risks and trade-offs

- **RLS doesn't bind a live lease** (D1). The server's statements are the only writers; this is
  accepted and pinned by a test.
- **Revision bumps in the wrong place.** If the claim used `RETURNING` it would not count, and if the
  heartbeat used `db.run` it would. `revision.int.test.ts` and the existing write scan guard both.
- **Cross-process `lease.changed`** reaches only the freeing process's sockets until slice 9. That
  is acceptable with one production process.
- **Clock skew** (A8).
- **Shared browser.** If user A records and signs out without releasing, user B, with the same tab
  id, gets a 409 for up to 40 s.
- **Masked holder id.** A non-holder viewer can no longer tell two other clients apart. Nothing
  reads that.
- **Retries.** A `40P01` retry re-runs the body. The statements are idempotent per attempt, and held
  alarms and broadcasts reset per attempt (`SessionHub.ts:600-635`).

## Migration and rollback

- **Forward-only.** The table starts empty. Deploy it while no recording is running: a take in
  progress at deploy loses its lease, and with D7 it re-claims on the next heartbeat.
- **Rollback.** Revert the code, and the server ignores the table and goes back to the meta keys.
  The reverted web has no D7, so roll back between takes.
