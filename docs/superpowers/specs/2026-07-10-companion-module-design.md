# Bitfocus Companion module for autologger-cf — design

**Date:** 2026-07-10
**Status:** Draft (awaiting spec-review gate)
**Author:** Kalen Cantrell (with Claude)

## Summary

Add a **Bitfocus Companion (Stream Deck) module** to the `autologger-cf` repo so an
operator can control an AutoLogger production-logging session from a hardware surface:
log events by category, roll/stop takes, and drive record/play — with live button
feedback (rolling / recording / playing / session-active) and text variables (timecode,
take, session title, etc.).

The module is a **pure client of the server's existing `/api/companion/*` endpoints**.
It adds **no new server API surface** — it consumes the shapes already implemented in
`server/src/routers/companion.ts`. It is authored fresh for this repo against those
endpoints; it is **not** a copy or port of any prior module.

## Goals

- One-tap **event logging** by show category from a Stream Deck button.
- **Transport** control: roll / stop / toggle the active take.
- **Record** control: record-start / record-stop / record-toggle.
- **Play** toggle.
- **Live feedback** on buttons: rolling, recording, playing, session-active.
- **Variables** for button text: timecode, current take, session/deck title, show
  name/code, logged-event count, frame rate, connected clients, active session id.
- Ship pre-wired **presets** so an operator gets working buttons by drag-and-drop.
- Live in the repo as a first-class **npm workspace**, wired into root typecheck/lint,
  with unit tests and a headless-Companion e2e harness.

## Non-goals

- **No new server endpoints or changes to `/api/companion/*` shapes.** This is a client.
  (Parity guardrail: server API changes need their own spec.)
- **No WebSocket push.** State is obtained by polling (decision below). A future
  real-time upgrade would be a separate spec touching the server.
- **No transcription / YouTube control** — those are intentionally `503` on this
  deployment.
- **No audio-segment upload** from Companion (the browser owns the mic; record/play are
  relayed *commands*, not media transfers).

## Architecture decision: HTTP polling + post-action refresh (A+C)

The module obtains live state by **polling `GET /api/companion/state`** on a configurable
interval (default 1000 ms) and refreshing categories when the active show changes. After
**every successful action** it issues an **immediate state refetch** so button feedback
flips without waiting for the next poll tick.

**Rejected alternative — WebSocket push (B):** near-real-time, but requires adding
machine-token auth to the server WS (or a new `/api/companion/ws`) plus reconnect /
active-session-switch lifecycle in the module. That is new server surface (needs its own
spec) and materially more code for a nicer timecode readout. Deferred.

Consequence accepted: **timecode/variables update at poll granularity, not
frame-accurate.** Acceptable for a logging control surface. A single Companion instance
polling ~1 req/s against a single-process local server is negligible load.

### Concurrency invariants (poll + refresh + destroy)

The poll tick, the post-action `refreshNow()`, and instance teardown all touch the same
fetch/state machinery, so the module MUST enforce these invariants (verified hazards from
the spec panel):

- **Single state fetch in flight.** Both the interval tick and `refreshNow()` funnel
  through one `pollState()` that no-ops (or coalesces) if a state fetch is already
  running. No overlapping `/state` requests.
- **Response fencing.** Each state request carries a monotonically increasing sequence
  number; a response is applied to variables/feedbacks only if it is the newest issued.
  A late-arriving older response is dropped, never overwrites fresher state.
- **`refreshNow()` shares the exact tick logic** — including the `show_id`-diff check that
  triggers a `/categories` refetch — it is not a separate simplified path.
- **Scheduling is self-rescheduling `setTimeout`, not `setInterval`** — the next tick is
  scheduled only after the current one settles, so a slow/hung server cannot pile up ticks.
- **Teardown cancels everything.** `destroy()`/`configUpdated` clear the schedule timer and
  the `refreshNow` debounce timer, and abort every in-flight fetch (poll, refresh, and
  action requests) via a single instance-scoped `AbortController`. An `isDestroyed` flag
  guards every fetch `.then()` so no `setVariableValues`/`checkFeedbacks` fires on a torn-
  down instance (e.g. an action's post-resolve `refreshNow()` after a connection delete).

### Base-API version pin (Companion 4.3.4 compatibility)

Companion 4.3.4 accepts module-API versions in the range `~0.6 || 1 - 1.14.x || 2 - 2.0.x`
(from its own `ModuleApiVersionCheck`). npm-latest `@companion-module/base` is **2.1.1**,
which Companion 4.3.4 **rejects at load**. The dependency MUST be pinned to the `2.0.x`
range (`"@companion-module/base": "~2.0.0"`), NOT `latest` / an unqualified `^2`. A build
or CI check should fail if the resolved version falls outside `0.6.x`/`1.x≤1.14`/`2.0.x`.
Confirm the manifest `runtime.type` enum (expected `node22`, whose runtime dir exists in
the install) against the pinned base version's manifest schema before writing the manifest.

## Server endpoints consumed (already implemented)

All under `server/src/routers/companion.ts`. The module never calls anything else.

| Method & path | Purpose | Request body | Response (used fields) |
|---|---|---|---|
| `GET /api/companion/state` | Poll live state | — | `connected_clients`, `active_session_id`, `session{ id, title, deck_title, timecode, frame_rate, is_rolling, current_take, is_recording, is_playing, logged_event_count, events_stream_revision, show_id, show_name, show_code }` (nullable), `last_command` |
| `GET /api/companion/categories` | Log-action dropdown | — | `session_id`, `show_id`, `show_name`, `show_code`, `categories[]` |
| `POST /api/companion/log` | Log an event | `{ category_id? , category_label? , message }` | enriched event (ignored beyond ok/err) |
| `POST /api/companion/transport` | Roll/stop take | `{ action: "start"\|"stop"\|"toggle" }` | `{ ok, is_rolling, current_take }` |
| `POST /api/companion/command` | Record/play relay | `{ type: "record-start"\|"record-stop"\|"record-toggle"\|"play-toggle" }` | `{ ok, command_id, active_session_id }` |

Notes:
- The **"active session" is server-resolved** from browser presence (freshest visible
  tab). The module does not choose a session; it acts on whatever the server reports.
  When no browser/session is open, mutating endpoints return **409**.
- **Presence:** the module does **not** POST `/api/companion/presence` (that is the
  browser's heartbeat). It is an observer + commander, not a presence participant.

### Trust boundaries (not all state is authoritative)

The panel confirmed three fields carry weaker guarantees than a naïve reading suggests;
the module and HELP.md must treat them accordingly:

- **`command` (record/play) is fire-and-forget.** `POST /api/companion/command` returns
  `{ ok: true }` when the command is *broadcast* over the session WebSocket — **not** when
  a browser executed it. The server exposes an ack channel (`state.last_command.ok` /
  `.error` / `.delivered_to`, flipped by the browser's `POST /commands/:id/ack`). The
  module MUST consume `last_command` and surface delivery: a `command_delivered` /
  `command_error` variable (and optionally a short-lived "pending" feedback). Without this,
  a "Record" press with no listening browser flashes success and the feedback lies.
- **`is_recording` self-corrects; `is_playing` does not.** `is_recording` is backed by a
  server-side recording lease (`lease.lease_alive`), so a dropped record command is
  revealed on a later poll. `is_playing` is derived purely from the browser's self-reported
  presence flag (valid only within the 15 s presence window) with **no server-side
  correction** — it can lag, or read stale-true if a tab dies uncleanly. The `playing`
  feedback and HELP.md must be labeled best-effort, distinct from `rolling`/`recording`.
- **Active-session resolution can silently retarget** (data-integrity hazard). The server
  picks the freshest *visible* presence row within a 15 s window. With multiple tabs/
  stations open, the session the operator *believes* is active may not be the one the
  server picks, and it can flip mid-shift with no 409 — a take/event silently lands on the
  wrong session. Mitigation baked into this spec: **every preset's default button text
  includes the session/show identifier** (`deck_title` or `show_code`), so the operator can
  see the target on the surface. A stronger guard (an optional "expected session id" action
  option compared against `active_session_id`, aborting on mismatch) is **escalated to the
  gate**, not adopted unilaterally.

## Auth

- Server gates writes behind login only when `REQUIRE_LOGIN=1`. Auth accepts a **Bearer
  `API_TOKEN`** (device credential) — see `server/src/middleware/auth.ts` /
  `auth/identity.ts`.
- Module config exposes an **optional API token** field. When set, every request sends
  `Authorization: Bearer <token>`. When the server runs `REQUIRE_LOGIN=0` (open LAN box),
  the token can be left blank.
- The server env var is **`API_TOKEN`** (this Node repo) — *not* `AUTOLOGGER_API_TOKEN`
  (that is the Python sibling's name). README/config docs must use the Node name.
- `401` from any call → instance status `BadConfig` ("check API token / login").

## Package & placement

New **`companion/` npm workspace** alongside `server/`, `web/`:

```
companion/
  package.json            # name companion-module-autologger, private, ESM, build/dev/test/package scripts
  tsconfig.json           # extends repo style; outDir dist/
  vitest.config.ts        # unit tests
  companion/
    manifest.json         # type connection, id "autologger", runtime node22, entrypoint ../dist/main.js
    HELP.md               # operator-facing help shown in Companion UI
  src/
    main.ts               # instance class: lifecycle, config apply, poll loop, status
    config.ts             # config fields + typed AppConfig
    api.ts                # typed fetch client for the 5 endpoints (+ shared error mapping)
    state.ts              # pure: server state snapshot -> variable values + feedback booleans
    actions.ts            # log_event, transport, record, play_toggle
    feedbacks.ts          # rolling, recording, playing, session_active (boolean feedbacks)
    variables.ts          # variable definitions
    presets.ts            # roll/stop, record, play, log-event presets
    upgrades.ts           # empty upgrade-script array (v0.1.0 baseline)
  dist/                   # tsc output (gitignored)
```

- Add `"companion"` to root `package.json` `workspaces`.
- Wire into root scripts: `typecheck` runs `-w companion`; `test` runs `-w companion`;
  `lint` includes the `companion/src` path (biome). (e2e already runs at repo root.)
- `dist/` gitignored (build artifact), like `web/dist/`.

## Module internals

### Config (`config.ts`)
- **Server URL** — text, default `http://127.0.0.1:8787`. Trailing slash normalized.
- **API token** — text (password-style), optional. Blank ⇒ no `Authorization` header.
- **Poll interval (ms)** — number, default 1000, min ~250, max ~10000.

### API client (`api.ts`)
- Thin wrapper over global `fetch` with base URL + optional Bearer header + timeout
  (AbortController). One typed method per endpoint. Maps transport-level and HTTP-status
  failures to a small tagged error type
  (`{ kind: 'network'|'auth'|'no_session'|'bad_category'|'http', ... }`) so `main.ts` can
  set instance status and `actions.ts` can log a useful message.
- `409` → `no_session`; `401` → `auth`; `400` → `bad_category`; other non-2xx → `http`;
  fetch throw/timeout → `network`.

### State → UI (`state.ts`, pure)
- `toVariableValues(state)` → `Record<varId, string|number>` (empty/`'—'` sentinels when
  no session), including `command_delivered`/`command_error` derived from
  `state.last_command`.
- `toFeedbackFlags(state)` → `{ rolling, recording, playing, session_active }`.
- Pure functions ⇒ unit-tested without the Companion base class.

### Poll loop (`main.ts`)
- On `init(config)`: build client, set status `Connecting`, do first poll + category
  fetch, start interval timer.
- Each tick: `GET /state`. On success → `setVariableValues`, `checkFeedbacks`, status
  `Ok`; if `show_id` changed since last tick → refetch `/categories` and rebuild the
  `log_event` category dropdown (`this.setActionDefinitions`). On failure → map error to
  status (`ConnectionFailure` / `BadConfig`), keep last-known variables.
- On `configUpdated`: tear down (per Concurrency invariants), rebuild client, restart loop.
- On `destroy`: full teardown per Concurrency invariants (schedule + debounce timers,
  abort all fetches, `isDestroyed` guard).
- **Post-action refresh (C):** after any action's HTTP call resolves ok, call a shared
  `refreshNow()` that funnels through the same single-in-flight `pollState()` as the tick
  (debounced so a burst of presses doesn't stack refetches; see Concurrency invariants).

### Actions (`actions.ts`)
- `log_event` — options: **category** (dropdown, populated from `/categories`, **default =
  first available category** so a freshly-dropped button is never empty; sends
  `category_id`) + **message** (text, `await parseVariablesInString`). → `POST /log`.
- `transport` — option: **action** dropdown start/stop/toggle. → `POST /transport`.
- `record` — option: **type** dropdown record-start/stop/toggle. → `POST /command`.
- `play_toggle` — no options. → `POST /command {type:"play-toggle"}`.
- Every handler: on `no_session` (409) → `this.log('warn', …)` (surface via
  session_active feedback); on `bad_category` (400) → `this.log('warn', 'Unknown category
  for the active show — re-pick the category (the show may have changed)')`; on other error
  → `this.log('error', …)`; on ok → `refreshNow()`.
- **Stale category after a show switch:** a button configured with a `category_id` from a
  previous show keeps its stored value even after `setActionDefinitions` rebuilds the
  dropdown. Pressing it yields a server **400** ("Unknown category"), which surfaces as the
  distinct `bad_category` warn above — not a silent failure and not the generic http bucket.

### Feedbacks (`feedbacks.ts`) — all boolean
- `rolling`, `recording`, `playing`, `session_active`. Default styles: rolling → red bg,
  recording → deep-red bg, playing → green bg, session_active inverse (warn when NOT
  active). Read from last polled snapshot via `state.ts`. **`playing` is best-effort**
  (presence-derived, no server self-correction) — see Trust boundaries.

### Variables (`variables.ts`)
`timecode`, `take`, `session_title`, `deck_title`, `show_name`, `show_code`,
`event_count`, `frame_rate`, `connected_clients`, `active_session_id`,
`command_delivered`, `command_error`. Seeded to
sentinels at init.

### Presets (`presets.ts`)
Every preset's default button text carries the **session/show identifier** (`deck_title`
or `show_code`) alongside its state readout, so the operator can see *which* session the
surface is driving (mitigates the silent-retarget hazard — see Trust boundaries).
- **Roll/Stop** — `transport toggle`, text `$(autologger:deck_title)\n$(autologger:timecode)`,
  `rolling` feedback.
- **Record** — `record record-toggle`, text `$(autologger:deck_title)`, `recording`
  feedback.
- **Play** — `play_toggle`, text `$(autologger:deck_title)`, `playing` feedback.
- **Log event** — `log_event` (categories can't be enumerated at drop time; ship a generic
  one whose category defaults to the first available at press time and an empty message the
  operator fills), `session_active` feedback for the "no session" warning.

## Error handling summary

| Condition | Instance status | Action behavior |
|---|---|---|
| Poll ok | `Ok` | — |
| First poll pending | `Connecting` | — |
| fetch throw / timeout | `ConnectionFailure` | actions still attempt; log network error |
| `401` (incl. token rotated mid-session) | `BadConfig` | action logs auth error |
| `409` on action (no active session) | stays `Ok` (server reachable) | action logs warn; `session_active` feedback false |
| `400` (unknown category) | stays `Ok` | action logs distinct `bad_category` warn (re-pick category) |
| other non-2xx | `Ok`/`UnknownWarning` | action logs http error |

Polls never throw out of the timer callback — failures are caught and mapped.

**Repeated-failure backoff.** On sustained `401`/`ConnectionFailure` (wrong URL, rotated
token — neither self-heals), the poll loop widens its interval (capped exponential backoff)
so a misconfigured connection doesn't hammer a dead endpoint every second; a successful
poll or a `configUpdated` resets it to the configured interval. This also bounds the
per-press latency cost of a permanently-wrong URL (each button press still pays one fetch
timeout, which is accepted — it's a config error the operator must fix).

## Testing

### Unit (vitest, in `companion/`)
- `api.ts` against a stub `node:http` server: header/base-URL construction, timeout,
  status→error-kind mapping for 200/401/409/500/network.
- `state.ts` pure functions: null-session sentinels, each feedback flag, variable
  formatting.
- category-refresh trigger: `show_id` change detection.

### E2E headless harness (Playwright, in `e2e/`)
Hermetic, opt-in (skips cleanly when Companion binary absent so CI elsewhere passes):
1. `npm run build -w companion` (produce `dist/`).
2. Start the **real server** on a test port with a **seeded studio/show/session** and a
   simulated browser-presence row so an active session resolves.
3. Launch **Companion 4.3.4 headless** from `/home/kalen/companion-x64` (`main.js`, wrapped
   by `companion_headless.sh`) with an **isolated config dir** (`--config-dir`), a
   **per-run admin port** (`--admin-port`, allocated dynamically — NOT the hardcoded 8000,
   to avoid colliding with the dev's running instance or a concurrent run), bound to
   `127.0.0.1`, and `--extra-module-path` pointing at this repo so the dev module loads.
   (Both `--extra-module-path` and the admin flags are empirically confirmed against the
   installed `main.js --help`.)
4. Drive the admin UI at the allocated port's `/connections` with Playwright: add the
   `autologger` connection, set server URL (+ token), save.
5. Assert the connection reaches **OK** status.
6. Fire actions (execute the transport/log actions) and **assert against the server**:
   take rolled (`GET /state` → `is_rolling`), event logged (session events include it).
7. Tear down: remove connection, stop Companion, stop server, clean config dir — with a
   **hard-kill fallback** (SIGKILL after a graceful-shutdown timeout, matching the
   documented `pkill -f "[n]ode main.js"` pattern) so a hung Companion never orphans.

Presence of the harness is gated on an env flag / binary existence check so
`npm run e2e` on machines without the Companion install is unaffected. It runs as a
**separate Playwright project** (not the default `chromium` smoke run), so only machines
with the binary execute it.

## Docs & versioning

- **README**: new "Companion module" section — dev-module loading (`--extra-module-path`),
  config fields, packaging to a `.tgz` via `companion-module-build`.
- **CHANGELOG**: new top section, `### Added` — Companion module. Bump root
  `package.json` `version` per repo convention.
- Module `manifest.json` / `companion/package.json` start at **`0.1.0`**.

## Open questions / risks

- **Base API version pin — resolved to a build blocker (see Base-API version pin above).**
  Pin `@companion-module/base` to `~2.0.0`; latest 2.1.1 is rejected by Companion 4.3.4.
- **Manifest `runtime.type` enum.** `node22` is expected (its runtime dir ships in the
  install); confirm against the pinned base version's manifest schema before writing the
  manifest. Low risk.
- **Category preset.** Companion presets can't enumerate server categories at drop time
  (dynamic); the log-event preset ships generic (category resolved to first available at
  press time). Accepted.

*(The headless module-path flag `--extra-module-path` and the admin-UI availability were
open questions in the draft; both are now empirically verified on the installed 4.3.4 —
folded into the E2E and version-pin sections.)*

## Panel & review log

- **2026-07-10 — Design drafted and approved in brainstorming.**
- **2026-07-10 — Adversarial spec panel (4 skeptical reviewers: requirements, assumptions,
  failure & abuse, scope/YAGNI). Dispositions:**

  *Blockers/majors fixed in place:*
  - **Base-API version must pin to `2.0.x`** (Companion 4.3.4 rejects npm-latest 2.1.1,
    per its own `ModuleApiVersionCheck`). → added "Base-API version pin" section + build check.
  - **`command` relay is fire-and-forget; `last_command` ack channel was dropped.** →
    added Trust boundaries; `command_delivered`/`command_error` variables consuming
    `state.last_command`.
  - **`is_playing` has no server self-correction** (unlike `is_recording` lease). →
    `playing` feedback labeled best-effort in Feedbacks + Trust boundaries.
  - **Poll/refresh/destroy concurrency** (overlap, stale-overwrite races, incomplete
    teardown). → added Concurrency invariants (single in-flight, sequence fencing,
    self-rescheduling timeout, single AbortController + `isDestroyed` guard).
  - **Silent wrong-session hazard** from 15 s presence resolution. → named in Trust
    boundaries; all presets now show `deck_title`/`show_code`.
  - **`400` unknown-category** (stale category after show switch) was in the generic bucket.
    → distinct `bad_category` error kind + error-table row + dropdown default-to-first.
  - **Repeated-auth/connection failures hammered the endpoint.** → added capped backoff.
  - **e2e port collision / orphaned Companion.** → per-run admin port + SIGKILL fallback +
    separate Playwright project.
  - **Env var naming** `API_TOKEN` (Node) vs `AUTOLOGGER_API_TOKEN` (Python). → noted in Auth.

  *Escalated to the gate — DECIDED 2026-07-10:*
  - **E1 — Full headless e2e harness vs. unit tests + manual smoke.** Scope reviewer flags
    it as real, disproportionate-feeling cost (driving a foreign product's UI, upstream-
    fragile) with a cheaper substitute; user explicitly mandated the harness. → **Gate
    decision: KEEP the full harness as specced** (binary-gated, per-run port, hard-kill
    teardown, separate Playwright project).
  - **E2 — "Expected session id" guard on actions.** A stronger mitigation for silent
    retargeting (abort if `active_session_id` ≠ operator's expected id). → **Gate decision:
    NOT adopted — label-only** (`deck_title`/`show_code` on every button) is the accepted
    mitigation for v0.1.0. The guard may be revisited if multi-station contention proves a
    real problem in use.

  *Minors accepted as residual:*
  - `upgrades.ts` as a one-line empty-array file (Companion convention; YAGNI-adjacent but
    idiomatic — kept).
  - Wrong-URL still pays one fetch-timeout per press (config error; backoff bounds poll cost).
  - `frame_rate`/`connected_clients` variables are low-value but near-zero cost — kept.
