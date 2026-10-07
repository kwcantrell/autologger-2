# Design: session-frame-bus (ADR 0021 slice 9a)

## Context

Line numbers are at base `supabase-migration` after #82.

**How frames go out today**
- `SessionCore.broadcast` (`sessionCore.ts:360-366`) holds frames on a transaction-bound core.
  `SessionHub.transaction` (`SessionHub.ts:611-644`) calls `flushHeldBroadcasts()` after
  `storage.tx` resolves (COMMIT), still inside the hub's FIFO lock. `sendToSockets` then walks the
  hub's `socketSet` (`sessionCore.ts:409-417`).
- A retried attempt drops its held frames, and a failed transaction discards them.
- No current transaction sends two identical frames (panel: every `inTxn` body was read).
- **Commands.** The root core's `broadcastCommand` sends at once (`sessionCore.ts:433`). Callers:
  - `handleSocketMessage` (`SessionHub.ts:767-778`), which checks only that the command is a
    string;
  - `POST /api/companion/command` (`companion.ts:297`), which checks it against
    `companionCommandBodySchema` (`record-start|record-stop|record-toggle|play-toggle`).
- **Access loss.** `closeSocketsAfterAccessLoss` (`server/src/routers/_helpers.ts:115-150`) runs
  after the revoking transaction commits. It re-checks access per show, lists the lost sessions and
  calls `registry.closeUserSockets` in this process only. If anything fails, it closes all of the
  user's local sockets.
  - Callers in `teams.ts`: grant revoke `:325`, demotion `:352`, removal `:376`, leave `:395`.
  - Callers in `admin.ts`: support-plane `:122`, `:135`.

**Already shared or correct across processes:** writes, leases and the KV store.

**Driver.** `packages/storage` uses postgres.js 3.4.9. `sql.listen(channel, fn, onlisten)`:
- runs on a dedicated `max:1` connection;
- re-runs LISTEN after any connection loss;
- calls `onlisten` after every successful LISTEN.

The panel verified this with backend termination, a 45 s outage and NOLOGIN.

**Postgres (panel-verified):**
- NOTIFY is delivered only on commit, in commit order across connections, and in issue order
  within a transaction.
- Identical payloads within one transaction are folded.
- Notifications sent while a listener is disconnected are lost.
- The payload limit is under 8000 bytes, counted in bytes.
- `pg_notify` is executable by every role, including in read-only transactions.

**Connections.**
- The `autologger_app` role limit is 20, for all processes together.
- One process holds 12 (3 root, 5 transaction, 4 session; `idle_timeout: 0`).
- The integration container raises the limit to 280 (`pgIntegrationSetup.ts:26`).

**Test harness.** It builds every env through `createBindings` (`server/src/test/harness.ts:61`, 49
callers). It does not run `main.ts`.

## Decisions

### D1. The bus port; Postgres only from `main.ts`

```ts
export type BusMessage =
  | { k: 'frame'; s: string; f: string }                                  // session id, frame JSON
  | { k: 'close'; u: string; s: readonly string[] | 'all'; c: number };   // user, sessions, code
export interface SessionFrameBus {
  publishInTx(t: SqlHandle, msgs: readonly BusMessage[]): Promise<void>; // before COMMIT
  afterCommit(msgs: readonly BusMessage[]): void;                        // local bus only
  publishNow(msg: BusMessage): Promise<void>;                            // commands only
}
```

- **`LocalFrameBus`** (session-core) is the default. `publishInTx` is a no-op, and `afterCommit` and
  `publishNow` deliver straight to the registry. Behaviour is today's exactly.
- **`PostgresFrameBus`** (storage). Storage may import only `ports`, so `config.ts` passes it the
  allowed frame types and commands (session-core's `SESSION_FRAME_TYPES`, and `SESSION_COMMANDS`
  from `companionCommandBodySchema`), and storage declares the message and handle types
  structurally (owner, 2026-10-07, after approval):
  - `publishInTx` sends `select pg_notify('autologger_session_frames', $1)` per message, on the given
    transaction handle;
  - `afterCommit` is a no-op;
  - `publishNow` uses the bus's own publisher connection.
- **Wiring is opt-in (panel, critical).** `createBindings` takes `frameBus?: 'local' | 'postgres'`,
  default `'local'`.
  - Only `main.ts` passes `'postgres'`, and it starts the listener before `listen()`.
  - The test harness and its 49 callers keep the local bus, unchanged.
  - New multi-process tests build their own `'postgres'` bindings.
- **Delivery.** The registry receives messages through `registry.deliver(msg)`:
  - a frame goes to the live hub of `s`, which sends it to its sockets (no live hub means no sockets,
    so the frame is dropped);
  - a close goes to `closeUserSockets(u, s, c)`.

### D2. Signed messages (owner decision: HMAC)

- **Envelope.** `{"v":1,"n":<seq>,"k":…,…,"h":"<hex HMAC-SHA256>"}`.
  - The HMAC covers the canonical JSON of the envelope without `h`.
  - The key is `FRAME_BUS_SECRET`: at least 32 characters, server-only.
- **Receiver checks.** A message is dropped and logged (`frame bus: dropped <reason>`, never the
  payload) if any check fails:
  - the signature, compared with `timingSafeEqual`;
  - `v === 1`;
  - for a frame, that `f` parses and its `type` is one of `event.changed`, `transport.changed`,
    `audio.changed`, `lease.changed` or `command`;
  - for a command frame, that `command` is in the contract enum;
  - for a close, that `c` is `4403`.
- **The secret.** Added to `docker/secrets-env.yaml`, and set by the owner in OpenBao for dev, stage
  and prod. With the Postgres bus, `main.ts` refuses to boot without it.
- **Sequence numbers.** `n` is a per-process counter. It makes every payload unique, so Postgres
  never folds two equal frames (panel finding).
- **Size.** A payload over 7900 bytes (`Buffer.byteLength`) is an error at publish time. Frames
  are under 400 bytes signed. Closes are split (D5).

### D3. Write frames: published in the transaction, delivered from the listener

- **Publishing.** `SessionHub.transaction` reads the core's held frames after
  `writeProjectionIfDirty()` and still inside `storage.tx`, then calls `bus.publishInTx(t, msgs)` on
  the raw handle `t`. It must not use `bound.core.db`: the counting handle would advance the
  revision.
- **After COMMIT,** `bus.afterCommit(msgs)` delivers on the local bus, as today, and does nothing
  on the Postgres bus.
- **Retries and failures.** A retried attempt's notifies roll back with it. A publish error fails
  the write.
- **Delivery.** `PostgresFrameBus.start(registry)` runs `sql.listen(channel, onMessage, onListen)`
  on a dedicated connection with `application_name` `autologger-frame-bus`.
  - `onMessage` verifies (D2), then calls `registry.deliver`.
  - The writing process delivers its own frames this way too, so every socket gets one
    database-ordered stream.
  - Delivery runs outside the FIFO lock.

### D4. Commands

`handleSocketMessage(raw, ws?)` and `broadcastCommand`. The socket argument is optional and added
(owner, 2026-10-07, after approval) on the facade, the entry and the view. `sessionWs.ts` passes the
socket Hono hands to every handler. Without it, one bucket per hub applies.
- drop a command not in the contract enum (a browser could send any string before);
- rate-limit to 10 per second per socket (a token bucket on the attached socket), dropping excess;
- publish with `bus.publishNow`.

The Companion route already validates its command and is not rate-limited here; its rate is one
POST per user action. A publish error is logged, never thrown into the route or the socket handler,
which is fire-and-forget as today. The publisher connection is the bus's own, not a root slot (panel:
pool starvation).

### D5. Access-loss closes inside the revoking transaction (owner decision)

`closeSocketsAfterAccessLoss` becomes `publishAccessLossInTx(cat, bus, userId, showIds)`, called as
the last step inside each revoking transaction's body (the six call sites above).
- **Inside the transaction** it re-checks access per show on the transaction's own handle (it reads
  its own uncommitted revoke), lists the lost sessions, and publishes `{k:'close', u, s:[…], c:4403}`
  messages. Each carries at most 150 session ids (about 6 KB signed).
- **Leave (owner, 2026-10-07, after approval).** `POST /api/teams/:id/leave` runs as the leaving
  user, and row-level security hides the team's shows and sessions from them once their
  membership is deleted. So the leave route lists the team's sessions in the same transaction
  before `authRemoveMembership`, and publishes closes for all of them after it: with no membership
  the user reaches none of the team's shows. A session another user creates between the pre-list and the
  commit, on which the leaver opens a socket inside that window, survives the leave: a negligible
  edge case (re-panel). The other five sites run as an owner, an admin or the support-plane system
  caller, who still see the rows, so they re-check after the write as above. The support-plane
  delete (`admin.ts` ~133) is wrapped in `catalog.tx` so its close publishes in its transaction.
- **On commit,** every process, the revoking one included, closes the user's sockets on those
  sessions. On the local bus, the messages are held and delivered after COMMIT through
  `afterCommit`.
- **On failure.** If the check, the listing or the publish fails, the revoke fails, a 500 with
  nothing changed. The old post-commit "close all locally" fallback is removed, because the revoke
  can no longer commit without its close.
- **Catalog handle.** The catalog transaction facade gains `notify(channel, payload)` for this,
  running `select pg_notify` under the transaction's binding. The panel verified that `catalog_user`
  can execute it.

### D6. Losing the listener

`onListen` fires on the first LISTEN and after every re-listen.
- **On a re-listen,** the process closes every attached session socket with `1012`
  (`registry.closeAllSockets(1012)`), once per loss. The web reconnects and re-syncs, and the panel
  verified the client ignores close codes.
- **While the connection is down,** local sockets get no frames. This is accepted and stated in the
  spec.
- **Reconnect backoff** is postgres.js's own (about 19 s after a refused-connection outage).

### D7. Connection budget (owner decision: raise the limit to 45)

- **Migration** `20261013000000_app_role_connection_limit.sql`:
  `alter role autologger_app connection limit 45`.
  - It also raises an error if `current_setting('max_connections')::int` is less than 100.
  - Each migration runs once (`schema_migrations`), so the catalog-schema migration's
    `connection limit 20` is left as it is; the new migration supersedes it. The catalog-database
    spec states the resulting limit, 45.
- **Per process:** 12 pool connections, plus the listener and the publisher, gives 14. Three
  processes fit in 42 of 45. Postgres's 100 connections stay shared with the Supabase services
  (about 13 in dev today) and `migrate`, as the original cap intended (catalog-pg-schema panel). A
  fourth process raises the limit in its own change.
- **The README** states the per-process budget and the three-process ceiling.

### D8. Tests (test first)

**Unit, `packages/session-core/src/frameBus.test.ts`, local bus:**
- delivery after commit, in issue order;
- a failed or retried transaction delivers only what committed;
- commands are validated and rate-limited (an 11th command within 1 s is dropped, an unknown command
  is dropped);
- a close reaches `closeUserSockets`.

**Unit, signing (storage):**
- a valid message verifies;
- a message with a tampered field, a wrong key, an unknown version, a bad frame type or an unknown
  command is dropped;
- the size limit is counted in bytes;
- sequence numbers are unique.

**Integration, `server/src/test/session/frameBus.int.test.ts`.** Two `'postgres'` bindings act as
two processes on one test database. Each test terminates only its own listener: the bus exposes the
listener's backend pid via `pg_backend_pid()` on listen (panel: other files' listeners). It covers:
- the six `core-ports-architecture` scenarios:
  - cross-process delivery exactly once;
  - 2×100 interleaved writes with strictly increasing revisions on both sides;
  - a rollback publishes nothing;
  - a command crosses processes;
  - a forged `pg_notify` from a role without the secret is dropped;
  - a 300-session team removal closes the socket on B;
- an unchanged revision;
- the two `api-contract-freeze` `1012` scenarios.

**Route level, `sessionWs.access.int.test.ts` (new cases, two `'postgres'` apps):**
- a grant revoke through A closes M's socket on B with `4403`, and other sockets stay open;
- an injected publish failure makes the revoke `500`, and the grant is still present.

**Migration (pg project):** `rolconnlimit = 45`, plus the `max_connections` guard.

**Existing tests** pass unchanged on the local bus. Allowed changes:
1. Tests of `closeSocketsAfterAccessLoss` (`_helpers.test.ts` and the access tests) may follow its
   move into the transaction, with the same observable closes.
2. The catalog-database role snapshot test (`catalogSchema.pg.test.ts:595-621`): its expected limit
   becomes 45, and (owner, 2026-10-07, after approval) it re-applies the connection-limit migration
   in the same transaction that reads the role. Roles are cluster-wide, and `teamOwner.pg.test.ts`
   (around lines 99-101) replays the whole catalog-schema migration, which resets the limit to 20,
   in a parallel file without any lock. Reading inside the transaction that set the value makes the
   read deterministic; the role-guard lock adds nothing, because that replay doesn't take it
   (re-panel). A concurrent `ALTER ROLE` can fail with "tuple concurrently updated", so the
   snapshot test, and the new limit test, retry their transaction once on that error.

Any other change is a stop.

### D9. Latency

A one-off bench, not committed: 200 writes on the dev database, with the median time from COMMIT
to delivery on a socket in the same process and in another process. Recorded; no stop rule.

## Risks

- **A write fails when NOTIFY fails** (queue full, at 8 GB): accepted. A stalled listener means a
  dead process.
- **The fan-out volume** is every frame to every process, which is negligible at today's rates.
- **The secret** is one more value to provision and rotate. Rotation needs a restart of every
  process at once; this is documented.
- **Command validation is a small behaviour change.** A browser socket's unknown command strings
  were relayed before and are now dropped. The web only ever sends contract commands.

## Rollback

Revert the code: the default local bus restores today's behaviour. The connection-limit migration
can stay, since a higher limit is harmless, or be reverted with a forward migration back to 20. The
secret can be left unused.
