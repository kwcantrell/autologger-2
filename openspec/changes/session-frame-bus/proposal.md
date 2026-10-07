# Session frame bus: live session frames reach every server process, in commit order

Tier: 2
Tier reason: it changes concurrency and ordering guarantees (broadcast order across processes) and
the WebSocket emission semantics of the frozen contract: access-loss closes and a new close on
bus loss. It touches `packages/session-core`, `packages/storage` and the composition root. ADR 0021
slice 9a.

Approved-by: Kalen 2026-10-07

## Why

The server cannot run as more than one process. Session writes are already correct across
processes, because they lock the row with `FOR UPDATE` and the leases are database-backed. But
every WebSocket frame is delivered only to sockets attached in the process that made the write
(`SessionCore.sendToSockets` walks the local hub's socket set). With two processes:

- **Missed frames.** A browser on process B misses `event.changed`, `transport.changed`,
  `audio.changed` and `lease.changed` for writes served by A. The events list never refreshes, and
  an idle session's transport status goes stale.
- **Lost commands.** A Companion record/play `command` relayed through A never reaches a browser
  socket on B.
- **Sockets left open.** A user who loses access keeps their open sockets on B, still receiving
  frames. `closeUserSockets` only sees this process's hubs.

## Owner decisions (owner, 2026-10-07)

1. **A Postgres NOTIFY bridge, not Supabase Realtime.** Every server process listens on one channel,
   and every frame travels through it. The WebSocket protocol, the frame shapes and the web client
   are unchanged. The ADR 0021 plan for Realtime to replace the WebSocket is deferred, and this
   change amends ADR 0021 and ADR 0023.
2. **Per-process request state is fixed properly later (9b),** with no sticky routing.
3. **9a comes first.**
4. **Messages are HMAC-signed (panel).** Any database login role can `pg_notify`. A server-only
   `FRAME_BUS_SECRET` signs every message, and receivers drop unsigned or invalid ones, so no other
   role can forge a frame, a record command or a close.
5. **The app role's connection limit rises to 60 by migration (panel).** The limit counts every
   process together. A process uses 14 connections (12 pool, a listener and a publisher), so 60
   fits four processes.
6. **Access-loss closes are published inside the revoking transaction (panel).** The close is
   published in the same transaction as the revoke (grant revoke, removal, leave, demotion,
   support-plane delete). A revoke whose close cannot be published fails and changes nothing.

## What changes

- **A `SessionFrameBus` port.**
  - The local implementation is today's behaviour: it delivers after COMMIT within the process. It
    stays the default for the hub, `createBindings` and every test harness.
  - The Postgres implementation is opted into only by the production entry point (`main.ts`).
- **Write frames.** They are published with `pg_notify` inside the write transaction. Every process,
  the writer included, delivers from its listener, so each socket gets a session's frames in commit
  order whichever processes wrote them. Each message carries a sequence number, so Postgres never
  folds two equal frames.
- **Commands.** They are checked against the contract's command values, rate-limited to 10 per
  second per socket, and published on the bus's own connection.
- **Access-loss closes.** They are published in the revoking transaction, split to fit the payload
  limit.
- **Losing the listener.** When the listener reconnects after a loss, the process closes its
  sockets with `1012`, and the web reconnects and re-syncs.
- **A migration** raises `autologger_app`'s connection limit to 60.
- **A new secret,** `FRAME_BUS_SECRET`, is added to the secrets allowlist. The owner sets it in
  OpenBao for dev, stage and prod.

## Not changing

- Frame shapes, types, emission points, and revision semantics.
- The web and the Companion. The Companion command route still picks its session from this
  process's presence map (9d's). Once it has a session, the command reaches every process.
- Write correctness, which already holds across processes.
- The single-replica topology (`container_name`, Caddy, DATA_DIR). That comes after slice 10.

## Impact

- **Spec deltas:**
  - `core-ports-architecture`: a new requirement, "Session frames reach every process in commit
    order", plus amended "Session runtime…", "Every catalog and session call is bound to a caller"
    and "The Postgres session adapter";
  - `api-contract-freeze`: access-loss closes become cross-process, and a new `1012` close after
    the listener reconnects;
  - `team-management`: "Show grants" and "Owner-anchored team lifecycle…";
  - `catalog-database`: the connection limit.
- **Behaviour.** A browser socket's unknown command strings are now dropped (the web never sends
  any). A revoke now fails if its close cannot be published.
- **Secrets.** One new server-only secret. Stage and prod need it set before deploy, and `main.ts`
  refuses to boot without it.
- **Latency.** Local frames now take one database round trip (NOTIFY delivery) before reaching
  sockets. This is measured and recorded, with no stop rule.
- **Connections.** 14 per process (+2).
- **Code:**
  - `packages/session-core` (`sessionCore.ts`, `SessionHub.ts`, the new `frameBus.ts`);
  - `packages/storage` (the new Postgres bus);
  - `packages/catalog` (the transaction `notify`);
  - `server/src/main.ts`, `server/src/node/config.ts`, `server/src/routers/{_helpers,teams,admin}.ts`;
  - a migration and `docker/secrets-env.yaml`;
  - README, `docs/security.md`, ADR 0021 and ADR 0023.

## Non-goals

- Supabase Realtime and Presence.
- The Companion device credential (9d).
- Per-process request state: log-import jobs, AI v2 answers, chat resume (9b).
- Deployment-wide ceilings, transcript status and sweepers (9c).
- Running a second replica in prod or stage.
