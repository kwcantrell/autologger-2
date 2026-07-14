# Implementation Tasks

> Ordering mirrors the design Migration Plan. Every task ends with `npm run typecheck`
> and `npm test` green; renames and semantic reshapes stay in **separate commits**.
> **Gate status:** adversarial spec panel + owner spec-review gate COMPLETE (see design.md
> Panel & review log). Parity rule from the gate: **any seam without covering tests gets a
> characterization test BEFORE it is reshaped** — "existing suites pass" is not sufficient
> for an untested seam.

## 1. Phase 1a — Pure renames (no behavior change)

- [x] 1.1 Rename dir `server/src/durable/` → `server/src/session/`; update all imports (locate by content, anchors are stale)
- [x] 1.2 Rename `server/src/db/d1.ts` → `catalog.ts` and `server/src/node/d1Adapter.ts` → `catalogStore.ts`; fix imports
- [x] 1.3 Rename `getSessionDO`→`getSessionHub`, the `SESSION_DO` binding key, and `stub` locals → `hub`; purge "the Worker"/"the DO"/`SessionDO` live references in identifiers and comments
- [x] 1.4 Update header comments citing DO/D1/Worker origin to describe role, not platform; purge the `R2` **noun in comments only** — leave the `r2_key` schema column untouched (grandfathered; renaming it is a forbidden migration)
- [x] 1.5 Rename-sweep **beyond typecheck**: grep retired identifiers across `AUTH-API.md`, `docs/` (except frozen `docs/superpowers/**`), `companion/companion/manifest.json`, `main.ts` (`startSweeper` on the renamed key), and test fixtures that string-key `env`
- [x] 1.6 `npm run typecheck` + `npm test` green; commit as a pure-rename commit

## 2. Phase 1b — Session seam reshape (keep seam, shed DO shape)

- [x] 2.1 **Characterization tests first:** pin the three `rowsWritten` readers — `setAudioSegmentWaveform` (404 + `audio.changed` broadcast), `deleteTopic` (404), `deleteTranscriptWord` (404) — asserting current status + broadcast behavior on missing ids
- [x] 2.2 Reshape `SessionCtx.sql` (→ `SessionRuntime.sql`, an interface) from `exec()→{toArray,rowsWritten}` to `all(sql,...binds)` (rows) and `run(sql,...binds)` returning `{ changes }`; rewire the three readers to `run().changes`
- [x] 2.3 Keep a distinct `void` multi-statement `exec` path for `initSchema` (zero-bind); keep the schema-init test covering it
- [x] 2.4 Collapse `SqlShim` into `SessionHub`'s constructor or a ~5-line adapter; update `SessionCore.all/first/db.exec` and every `core.db.exec` write site
- [x] 2.5 Confirm hub RPC bodies remain zero-`await` and transactional; add a fake-runtime `SessionCore` test (in-mem sql + fake sockets); `npm run typecheck` + `npm test` green

## 3. Phase 1c — Catalog seam reshape + facade cleanup

- [x] 3.1 **Characterization tests first** for the change-detecting `.meta.changes` readers (`authStore`, `sessionIndexStore` ×2 — removed-membership / archived-session detection)
- [x] 3.2 Reshape `prepare().bind().all()/first()/run()` → `all()/run()` with `run()` returning `{ changes }`; replace `batch()` with `tx()` implemented via `db.transaction()` (not raw `BEGIN/COMMIT`); update the 2 callers (authStore, studioRegistry)
- [x] 3.3 Add a `tx()` **rollback test** (force a constraint violation mid-transaction, assert no partial write) for the two former-`batch` sites
- [x] 3.4 Remove the async costume: delete the ~81 `db/` awaits, drop the `async` method signatures, and update the ~79 awaited call sites across routers + middleware
- [x] 3.5 Delete the `Catalog` facade's ~70 flat delegate methods; repoint callers to `catalog.<store>.<method>()`
- [x] 3.6 `npm run typecheck` + `npm test` green; commit

## 4. Phase 1d — Composition root split + auth de-dup (Phase 1 parity checkpoint)

- [x] 4.1 Split `createBindings` output into `{ ports, config }`; role-name service keys (`catalog`, `kv`, `sessions`, `audio`, `presence`); delete `export type Env = Bindings`
- [x] 4.2 Update `wireApp`/router `c.env` access to the new shape **preserving the per-request in-place env-mutation identity** the `@hono/node-ws` upgrade compares on (do not replace/spread `c.env`); keep `companion-ws.int.test` as the acceptance gate
- [x] 4.3 Delete the duplicated login check in `requireSession` (middleware + retained `apiRequestRequiresLogin` already enforce it); keep existence(404) + membership scope
- [x] 4.4 **Parity checkpoint:** full unit + integration suites green with zero expected-response edits; confirm `503` null-adapter routes and the real WS upgrade unchanged; commit

## 5. Phase 2 — Clock port (app-wide; alarm/clock one time base)

- [x] 5.1 Add a synchronous `Clock` port (`now(): number`); fold it into `SessionRuntime` (real adapter = `Date.now`)
- [x] 5.2 Route all `durable/` decision reads through the clock: `leaseStore` staleness/expiry, `armAlarm` delay (so alarm + expiry share one time base), `transportStore` live timecode, `eventStore` wall-clock marking, `SessionHub` idle-eviction
- [x] 5.3 Fake-clock test: claim a lease, advance the clock past the threshold, trigger expiry **through the hub** — lease frees with no real time, no busy-refire / no missed fire
- [x] 5.4 Thread the same `Clock` into `KvStore` TTL (`kvStore.ts` ×2 decisions), `PresenceRegistry` freshness, and the `companion.ts`/`sessions.ts` timestamp stamps; fake-clock tests for KV/CSRF expiry + presence staleness
- [x] 5.5 `npm run typecheck` + `npm test` green

## 6. Phase 2 — IdentityVerifier port

- [x] 6.1 Introduce an `IdentityVerifier` port wrapping JWKS verify + OAuth code exchange; move `jwksCache` to instance state (kill the module-level singleton) and read the JWKS TTL from the injected `Clock` (`oauth_google.ts` ×2)
- [x] 6.2 Add a fake `IdentityVerifier` and prove token verification without network; suite green
- [x] _(BlobStore port CUT at the gate — stays concrete, rename-only, handled in Phase 1a)_

## 7. Phase 2 — Consolidate authorization (safe half only)

- [x] 7.1 **New integration test first:** the `API_TOKEN` cross-studio path under `REQUIRE_LOGIN=1` (currently untested) — a machine client reaches a session in a studio it isn't a member of
- [x] 7.2 Refactor `requireSession` to resolve + authorize (existence + membership + admin) behind the identity middleware already resolved; **retain** `apiRequestRequiresLogin` (the per-route-policy rework is deferred)
- [x] 7.3 Preserve exactly, each with a locking test: `API_TOKEN` bypasses membership; cross-studio ⇒ 404 (not 403); admin 503-unset vs 401-wrong; session cookie grants no admin
- [x] 7.4 Gate/auth integration tests green
- [x] _(Show/enrichment domain-service extraction DEFERRED at the gate — no second caller today)_

## 8. Docs + closeout

- [x] 8.1 Repo identity: drop `— autologger-cf` from the titles of `README.md`, `CLAUDE.md`, `AUTH-API.md` (canonical name `autologger`, keep the "portable Node server" descriptor); fix the placeholder repo/bugs URLs in `companion/companion/manifest.json` (`github.com/local/autologger-cf` → `…/autologger`). **Leave `docs/superpowers/**` untouched** (frozen migration records)
- [ ] 8.2 Post-gate consistency read: one light-tier reviewer over the final artifacts + docs for stale pre-decision language and broken cross-references (CLAUDE.md SDLC)
- [ ] 8.3 Run `openspec validate de-cloudflare-strong-core --strict`; then `/opsx:archive` when merged
