## Context

The server is a Python → Cloudflare-Workers → portable-Node port. The CF → Node
migration introduced the seams a ports-and-adapters architecture needs — but named them
after the platform being left behind and shaped their APIs like Cloudflare's:

- `SessionHub`'s constructor (`SessionHub.ts:48-73`) is already a **composition root**:
  it wires `SqlShim(better-sqlite3)`, `() => this.socketSet`, and `armAlarm/setTimeout`
  into `SessionCore` through the `SessionCtx` port. The port is real; `SessionCtx.sql.exec()
  → { toArray(), rowsWritten }` is the **Durable Object storage API shape**.
- `CatalogDb` / `CatalogStmt` / `Stmt` (`d1Adapter.ts`) reshape better-sqlite3 into **D1's**
  `prepare().bind().all()/first()/run().meta.changes` + `batch()`. Catalog stores `await`
  this — **verified to reach no real I/O**: ~81 awaits across the five `db/` stores; the
  promises are async-fn microtasks over synchronous better-sqlite3 (some await sibling
  `async` store methods, so they *are* genuine promises — but every chain bottoms out at
  synchronous SQLite, with no fetch/stream/timer). De-async-ing therefore also removes the
  `async` method signatures and updates ~79 awaited call sites across the routers +
  middleware — not just the 81 awaits inside `db/`.
- The composition root's output is a Cloudflare `env` object (`types.ts` `Bindings`):
  service bindings `DB`/`AUTH`/`SESSION_DO`/`AUDIO`/`PRESENCE` mixed with 13 config
  strings, plus `export type Env = Bindings`.
- The router/hub division of labor follows the **dead CF process boundary**: the DO
  couldn't reach D1, so show/enrichment logic was pushed into routers (`events.ts` header:
  *"enriches events in the Worker… keeping show logic out of the DO"*).

Nothing is broken; the code documents its own fossils. The task is to re-cut these seams
around the **domain** and delete the Cloudflare-shaped middle layers.

**Permanent constraint (settled with the owner):** single Node process, state on local
disk under `DATA_DIR`, no cloud account — asserted as a product invariant in `CLAUDE.md`.
A networked/Postgres catalog is explicitly out. This is what makes catalog-sync correct.

## Goals / Non-Goals

**Goals:**
- A domain-shaped core with named ports; no Cloudflare noun survives in live code.
- Persistence seams shed their CF API shapes (DO cursor, D1 prepare/bind) while keeping
  the seam as a single substitutable boundary.
- Strictly parity-preserving: identical HTTP/WS surface, JSON shapes, and status codes.
- Higher testability where it pays (SessionRuntime, Clock, IdentityVerifier).

**Non-Goals:**
- No async/networked persistence for either half (single-process is permanent).
- No merging of the WS and Companion long-poll driving adapters — both are legitimate.
- No change to the `503` null-adapter routes; transcription/YouTube-import stay disabled
  (the transcribe-MCP design was dropped).
- No new runtime dependencies; `restart_supported` stays `false`.
- Not interface-per-store hexagonal zealotry — only the ports in the revised D5 ledger
  (SessionRuntime, Clock, IdentityVerifier) earn an interface boundary.

## Decisions

### D1 — Catalog persistence is synchronous (RESOLVED)

Collapse the catalog seam to a synchronous `CatalogStore` port (`all()`/`run()`/`tx()`),
delete the no-op `await`s, and drop D1's `prepare().bind()` shape.

- **Why:** the async is 100% costume today (verified no-op), and a networked catalog
  contradicts the permanent single-process invariant. Keeping async hedges toward a cloud
  posture the project explicitly rejected (YAGNI).
- **Reversal path is cheap:** the `CatalogStore` **boundary is preserved** as one named
  seam. If a networked catalog ever became real (it won't, per invariant), re-introducing
  an async adapter behind that seam is a bounded change, not a rewrite.
- **Alternative considered — keep an async port:** rejected. It buys nothing today, keeps
  ~81 misleading awaits, and signals a portability the product disavows.

### D2 — Clock scope: app-wide, staged (RESOLVED)

Introduce a single synchronous `Clock` (`now(): number`) and route **every decision-making
time read** through it — not just the session half. Rollout is staged so the session Clock
proves the pattern first, but the end state is app-wide within this change.

- **Session half:** folded into `SessionRuntime`; `leaseStore` staleness/expiry reads it,
  and so do the other `durable/` decision reads the panel surfaced — `transportStore` live
  timecode, `eventStore` wall-clock marking, `SessionHub` idle-eviction, and crucially the
  **alarm scheduler**: `armAlarm` computes its delay from clock time so an alarm scheduled
  from `clock.now()` and an expiry check reading `clock.now()` share one time base (no
  real-`setTimeout`-vs-fake-clock skew that would busy-refire or never fire through the hub).
- **App-wide:** `KvStore` login-session/CSRF TTL expiry (`kvStore.ts` ×3), `PresenceRegistry`
  freshness window (`presence.ts`), and the `IdentityVerifier` JWKS cache TTL
  (`oauth_google.ts` ×2) all take the injected clock. Trivial inbound-adapter timestamp
  stamps (`companion.ts`, `sessions.ts`) use it too, for one coherent time source.
- **Why app-wide now (not deferred):** the non-session reads are only ~7 sites, and the two
  highest-value ones (JWKS TTL, KV TTL) are already in Phase 2's blast radius via the
  IdentityVerifier extraction and sit right beside the lease clock. Deferring would ship a
  **half-clocked codebase** (some TTL/expiry deterministically testable, some not) — an
  inconsistency that becomes its own later cleanup.
- **Alternative — session-only, defer the rest:** rejected. Smaller diff, but leaves the
  inconsistency above and forces a second pass over code IdentityVerifier already touches.

### D8 — Repo identity: canonical name is `autologger` (RESOLVED)

Drop the `-cf` (Cloudflare) suffix from the project identity; the canonical name is
**`autologger`**, matching the workspace packages (`autologger`, `autologger-server`,
`autologger-web`, `companion-module-autologger`).

- **Scope:** retitle `README.md`, `CLAUDE.md`, `AUTH-API.md` (drop `— autologger-cf`); fix
  the placeholder repo/bugs URLs in `companion/companion/manifest.json`
  (`github.com/local/autologger-cf` → `…/autologger`). Keep the "portable Node server"
  descriptor the README body already uses.
- **Left untouched:** `docs/superpowers/**` — frozen migration records that describe the
  Cloudflare-era `autologger-cf` Worker accurately; rewriting them would falsify history.
- **Why:** `-cf` now actively misleads (there is no Cloudflare); package names already
  settled the canonical form. Low risk, pure clarity.

### D3 — The synchronous asymmetry is deliberate, and here it is symmetric-by-value

The session spine port MUST be synchronous (zero-`await` hub invariant, single-writer
embedded SQLite). The catalog port is **also** synchronous now (D1). So both halves are
sync — but for **different reasons**, and the boundaries stay distinct:

```
  SessionRuntime port          CatalogStore port
  ─────────────────            ─────────────────
  sync BECAUSE the hub is       sync BECAUSE the store is embedded and
  single-writer zero-await      the product is single-process forever
  → embedded-only by design     → boundary kept for cheap future reversal
```

This is recorded so a future reader does not "unify" them into one abstraction — they
answer to different constraints even though both are currently synchronous.

### D4 — Keep the seam, shed the shape (both persistence layers)

- **Session:** `SessionCore` is already the domain substrate (`all`/`first`/`db.exec`).
  Reshape `SessionCtx.sql.exec()→{toArray,rowsWritten}` to `all()` (rows) and `run()`
  returning `{ changes }`. **Correction (panel):** `rowsWritten` is NOT dead — it has three
  live readers that drive behavior: `audioStore.setAudioSegmentWaveform` (404 + the
  `audio.changed` broadcast), `topicStore.deleteTopic` (404), `transcriptStore`
  `deleteTranscriptWord` (404). So `run()` MUST carry the affected-row count, symmetric with
  the catalog `.meta.changes` treatment. Collapse `SqlShim` into `SessionHub` or a ~5-line
  adapter; keep a distinct `void` multi-statement `exec` path for `initSchema`. Stays sync.
- **Catalog:** `batch()` (real transaction, 2 callers — `authStore`, `studioRegistry`)
  becomes `tx()` implemented via `db.transaction()` (not raw `BEGIN/COMMIT`, which would
  throw on reentry); `Stmt`/`CatalogStmt` reshape to `all()/run()` with `run()` returning
  `{ changes }` (3 readers: `authStore`, `sessionIndexStore` ×2). Delete the `Catalog`
  facade's ~70 delegate methods; callers use the store fields directly.
- **Composition root:** split `createBindings` into `{ ports, config }`; role-name the
  service keys; delete `Env = Bindings`. **Preserve** the per-request in-place `env`-mutation
  identity contract the `@hono/node-ws` upgrade compares on (do not replace/spread `c.env`
  per request); the Companion WS integration test is the acceptance gate.

### D5 — The port ledger (what earns a boundary vs. stays concrete) — REVISED at the gate

The gate cut `BlobStore` from the ledger: its only justification was "S3/R2 someday," which
the permanent no-cloud invariant forbids — the same reasoning that keeps `KvStore` concrete.
A `port` earns an **interface** only when a fake or second implementation has real value.

| Port | From | Shape | Why it earns an interface |
|------|------|-------|---------------------------|
| `SessionRuntime` | `SessionCtx` | sync: sql + sockets + alarm + **clock** | fake substrate unlocks store tests; embedded-only |
| `Clock` | scattered `Date.now()` | sync: `now()` | **new**; fake clock unlocks lease/TTL tests (D2) |
| `IdentityVerifier` | `oauth_google.ts` fns | instance w/ JWKS cache | fake verifier + kills the `let jwksCache` singleton |

`CatalogStore` (from `CatalogDb`) is a **reshape, not a swappable port**: its API is de-D1'd
to `all/run/tx` and made synchronous, but stores may keep constructing/importing the concrete
class — there is no second adapter (single-process forever), so no dependency-inversion
ceremony. The seam boundary still exists as one named type; we simply do not overclaim
"substitutable without touching call sites."

**Stay concrete, rename-only:** `BlobStore` (S3 forbidden by invariant — extract an interface
only if a real second backend ever appears), `KvStore` (sync-embedded; a port only if Redis,
also forbidden), `PresenceRegistry` (in-memory *by design*, rebuilt by heartbeats).
`crypto.randomUUID` (×9) left as-is unless deterministic-id tests are wanted later.

### D6 — Inbound: consolidate auth (safely); DEFER the two rearchitects — REVISED at the gate

- **Show/enrichment domain service — DEFERRED.** The enrichment functions are *already*
  extracted into `studio.ts`; what remains in the router (`relinkMaps`, `sessionDeckFromRow`,
  master-timecode arithmetic) is already-pure code with **no second caller** — the hub can't
  reach the catalog, so "callable by both router and hub" has no consumer. Extracting a
  service now is relocation, not simplification, and adds characterization-test cost to a
  working path. Defer until a genuine second caller appears.
- **Auth — do the safe half, defer the rearchitect.** Keep: middleware owns authentication;
  `requireSession` becomes resolve + authorize (existence + membership + admin), with the
  **duplicated login check deleted**. **DEFERRED:** retiring the `apiRequestRequiresLogin`
  URL-prefix matcher for an explicit per-route policy — that re-architects working,
  test-covered auth and carries an unresolved representation question, for no bug. The
  matcher stays. The consolidation MUST preserve, each pinned by a spec scenario: the
  `API_TOKEN`-bypasses-membership path (Companion), the cross-studio **404-not-403** masking,
  and admin **503-unset vs 401-wrong**. A new integration test MUST cover the `API_TOKEN`
  cross-studio path (currently untested) before `authorize` is touched.

### D7 — Sequencing: Phase 1 is subtraction, Phase 2 is adoption

Phase 1 (rename + reshape + delete, no behavior change) lands first and is gated by the
existing suites plus characterization tests as the parity oracle. Phase 2 (Clock,
IdentityVerifier, and the auth consolidation) each lands with a fake adapter / locking
tests; BlobStore stays concrete/rename-only (D5) and the enrichment extraction is deferred
(D6). This keeps every commit either pure-subtraction or additive-with-tests.

## Risks / Trade-offs

- **Wide rename churns git blame across `server/src`** → do the rename as its own
  mechanical, review-isolated commit(s); rely on the test suite + typecheck as the oracle;
  keep semantic reshapes in separate commits from pure renames.
- **`SqlShim`'s `initSchema` multi-statement path** (zero-bind `db.exec`) is load-bearing
  and easy to drop during reshape → preserve an explicit `exec(multiStatementSql)` path or
  keep schema init distinct from the `all/run` seam; cover with the existing schema-init test.
- **Catalog `.meta.changes` readers** (update-detection) depend on the `run()` return →
  audit every `run().meta.changes` reader before reshaping `run()`'s return type; keep a
  `{ changes }` result.
- **Enrichment extraction could subtly change ordering/semantics** if the router did more
  than it appeared → extract behind characterization tests; assert byte-identical JSON on a
  representative session before/after.
- **Auth consolidation is behavior-adjacent** (401/404/503 shapes) and the `API_TOKEN`
  cross-studio path is **untested** → add the three parity scenarios (D6) and a new
  `API_TOKEN` cross-studio integration test BEFORE touching `authorize`; the "404 not 403"
  masking and admin "503-unset vs 401-wrong" MUST be preserved.
- **Deleting `requireSession`'s login backstop removes defense-in-depth** → safe only because
  `authContext` runs on `*` and `apiRequestRequiresLogin` (retained) gates 100% of
  `requireSession` callers; this is why the per-route-policy rework is deferred, not the
  dup-deletion.
- **`{ports, config}` split can break the WS upgrade** → the handshake compares the
  per-request `env` object identity; do not replace/spread it. Companion WS int test gates
  the split commit.
- **Clock/alarm time-base skew** → alarm delay computed from `clock.now()`; a hub-level
  lease-expiry test with a fake clock is the acceptance check (D2).
- **`tx()` atomicity + reentrancy** → implement via `db.transaction()`; add a rollback test
  (force a constraint violation mid-`tx`, assert no partial write) for the two `batch` sites.
- **Rename/delete blast radius beyond typecheck** → grep the retired identifiers across docs,
  `AUTH-API.md`, the Companion `manifest.json`, `main.ts` (`startSweeper` on the role-renamed
  key), and test fixtures that string-key `env` — not just `server/src`.
- **`r2_key` is a live schema column** → grandfathered (D-below); purge the *noun* in comments
  only, never the column, to keep "no schema change" true.
- **Scope creep into `BlobStore`/`KvStore`/`PresenceRegistry` port-ification** → the revised
  ledger (D5) is the boundary; log any deviation rather than silently expanding.

## Migration Plan

1. **Phase 1a — pure renames** (`durable/`→`session/`, `d1.ts`→`catalog.ts`,
   `getSessionDO`/`SESSION_DO`/`stub`→hub, comment/noun purge). Typecheck + full suite green.
2. **Phase 1b — session seam reshape** (`sql`→`all/run`, drop `rowsWritten`, collapse
   `SqlShim`). Suite green.
3. **Phase 1c — catalog seam reshape** (`prepare().bind()`→`all/run`, `batch`→`tx`, delete
   no-op awaits + the ~70 delegates). Suite green.
4. **Phase 1d — composition root split** (`{ports, config}`, drop `Env` alias, role-named
   keys) + delete duplicated login check. Suite green. **← Phase 1 parity checkpoint.**
5. **Phase 2** — introduce the surviving ports one slice at a time, each with its fake
   adapter / locking tests: Clock → IdentityVerifier → authz consolidation. (BlobStore
   stays concrete/rename-only per D5; enrichment extraction deferred per D6.)

**Rollback:** each phase/slice is an independent commit gated by the suite; revert the
offending commit. No data migration, no schema change, no runtime dependency change, so
rollback is code-only.

## Open Questions

_Clock scope (D2, app-wide), repo identity (D8), the `BlobStore` cut, the two deferrals
(enrichment service, per-route-policy registry), and the `r2_key` grandfather are all
resolved above / at the gate._

- _None blocking._ The per-route auth-policy representation question is moot for this change
  (the rework is deferred); it returns only if a future change retires
  `apiRequestRequiresLogin`.

## Panel & review log

**2026-07-13 — Adversarial spec panel** (4 reviewers: requirements / assumptions /
failure-abuse / scope-simpler, calibrated skeptical) + owner spec-review gate.

### Blockers / majors fixed in place

- **`rowsWritten` is not dead** (assumptions + failure, independently). Three live readers
  drive 404s + the `audio.changed` broadcast (`audioStore:125-126`, `topicStore:87`,
  `transcriptStore:93`). Struck the "dead / no reader" claim; `run()` now MUST return
  `{ changes }` (D4, spec). *Was a factual error in the original proposal/design.*
- **Weak parity oracle** (requirements). Reshaped seams (`requireSession`, `authContext`,
  session SQL, enrichment) have no covering tests. Added a spec requirement: characterization
  test before reshaping any untested seam.
- **Auth invariants unprotected** (requirements + failure). Added spec scenarios for
  `API_TOKEN`-bypasses-membership, cross-studio 404-not-403, admin 503-vs-401, plus a
  required `API_TOKEN` cross-studio integration test before touching `authorize`.
- **Clock/alarm time-base skew** (failure). Added the shared-time-base requirement (D2, spec)
  so hub-level lease-expiry tests are deterministic.
- **WS env-identity vs Ports/Config split** (requirements + failure). Added a spec
  requirement + Companion-WS gate to preserve the in-place `env`-mutation identity.
- **De-async wording + blast radius** (assumptions). Corrected "no genuine promise" and
  recorded the true scope (~79 external call sites + method signatures), D-context/D4.
- **`initSchema` multi-statement `exec`, `tx()` via `db.transaction()`, rollback test,
  rename-sweep beyond typecheck** — added as spec scenarios / risks / tasks.

### Findings escalated to the gate (with decision)

- **Cut `BlobStore` port → rename-only** (scope). *Decision: ACCEPTED.* "S3 someday"
  contradicts the no-cloud invariant; same rule as `KvStore`. Ledger revised to 4 ports;
  `CatalogStore` downgraded from swappable port to reshape-only for the same reason.
- **Clock scope: narrow to lease+JWKS vs app-wide** (scope). *Decision: KEEP APP-WIDE.*
  Owner chose one coherent time source; the correctness fix (shared alarm/clock base) applies
  regardless.
- **Defer enrichment domain-service + auth per-route-policy registry** (scope). *Decision:
  DEFER BOTH.* Kept the safe auth dup-deletion + `authorize` consolidation; deferred the two
  rearchitectures of working code until a real trigger.
- **Spec framing: normative capability vs CI/lint** (scope). *Decision: KEEP normative
  capability* with the hardened requirements.
- **`r2_key` vs "no R2 noun"** (requirements). *Decision: GRANDFATHER* the column as a legacy
  schema token (exception clause in the spec) — renaming it would force a forbidden migration.

### Minors accepted as residual

- Some Clock/no-CF-noun scenarios are effectively frozen lint checks (scope) — accepted as
  the cost of the normative-capability framing the owner chose.
- `IdentityVerifier` wrapping `exchangeAuthorizationCode`/`googleAuthorizationUrl` is modest
  value beyond the singleton kill (scope) — kept; the instance pays for itself.

**Post-gate:** targeted edits applied to proposal/design/spec/tasks; a light-tier consistency
read (per CLAUDE.md) is queued as task 8.2 before any push.
