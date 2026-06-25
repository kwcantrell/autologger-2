# Remaining-endpoint integration sweep — design

**Date:** 2026-06-25
**Status:** Approved (pending spec review)
**Scope:** Test-only. No production-code changes — characterizes current behavior. Reuses the hybrid harness + helpers from the prior specs.

## Background

The second of three deferred follow-up sub-projects. The comprehensive suite + OAuth work covered events, audio, exports, the auth gate, tenancy, the resource caps, and the OAuth routes. This sweep covers the **~30 remaining routes** across sessions, shows, profile/studio, admin, and transcribe/topics.

All remaining routes are ordinary request handlers — verified there are **no external-service calls**: `youtube-import`, `transcript-words/generate`, and `topics/generate` simply `throw ApiError(503)` after `requireSession`. So the sweep is mechanical (`app.request` + assertions), with no mocking and no design unknowns.

## Goals

1. Cover every remaining route with a **happy path** (expected status + a response assertion) plus **one meaningful branch** (tenancy 404, authz, or 422 validation) where such a branch exists.
2. One integration file per router group, mirroring the existing layout.
3. Reuse the established helpers and env-override conventions; add no production code.

## Non-goals

- Companion relay routes (`/api/companion/*`) — the third deferred sub-spec.
- WebSocket / long-poll routes (`/api/sessions/:id/ws`, `/api/companion/commands/wait`) — need socket/relay plumbing; deferred to the companion spec.
- Exhaustive per-branch coverage of each handler.
- Any production-code change. Status codes and response shapes are asserted as current behavior.

## Architecture — files & coverage

Four new `*.int.test.ts` files (workers project), each a plan task. All use `app.request(path, init, env)` with the existing helpers (`seedStudio/seedUser/seedShow/seedSession`, `loginCookie`, `adminHeader`) and the `envWith` cast for var overrides.

### 1. `src/routers/sessions.int.test.ts` (7 routes)
- `POST /api/sessions` — create via API (body: `show_id`, `episode`, `frame_rate`, `start_offset_frames`) → returns the session; assert 200 + an id.
- `GET /api/sessions` — list (scoped to active/owned shows); assert 200 + array shape.
- `PUT /api/sessions/:id` — rename / start-offset; assert 200 + persisted change.
- `POST /api/sessions/:id/archive` and `/restore` — assert 200 + visibility toggles via a follow-up list/get.
- `DELETE /api/sessions/:id` — assert 200/expected status + gone on re-fetch.
- `POST /api/sessions/:id/youtube-import` → **503**.
- **Branches:** `422` on an invalid create body (missing `show_id`/`episode`); tenancy `404` on `PUT`/`DELETE` for a logged-in non-member (`withLogin` + `loginCookie`).

### 2. `src/routers/shows-profile.int.test.ts` (5 routes)
- `GET /api/shows` (for the active/seeded studio) — assert 200 + array.
- `POST /api/shows` (body: `studio_id`, `name`, `show_code`) — assert 200 + created show; verify via `GET /api/shows` or the catalog.
- `GET /api/studio` — assert 200 + studio profile shape.
- `GET /api/profile` — assert 200 + the profile payload's top-level keys.
- `PUT /api/profile` — a valid partial update (e.g. `active_studio_id` or `given_name`); assert 200 + persisted.
- **Branch:** `422` on an invalid `PUT /api/profile` or `POST /api/shows` body.

### 3. `src/routers/admin.int.test.ts` (7 routes)
Driven with `adminHeader(TOKEN)` + `envWith({ ADMIN_TOKEN: TOKEN })`:
- `GET /api/admin/users` — happy (assert 200 + users array).
- `POST /api/admin/studios` (slug id + display name) and `DELETE /api/admin/studios/:id` — create then delete; assert success statuses + presence via catalog/`init()`.
- `POST /api/admin/users/:id/memberships` and `DELETE .../memberships/:studioId` — add/remove; assert via `authUserHasStudio`.
- `POST /api/admin/users/:id/disable` and `/enable` — assert via `authGetUserRowAny`.
- **Branch:** one `401` (wrong token) or a `422`/validation case (the 503-unconfigured path is already covered by the gate tests).

### 4. `src/routers/transcribe.int.test.ts` (11 routes)
- transcript-words: `POST` create (body: `session_time`, `speaker`, `word`) → `GET` list → `PATCH :wordId` → `DELETE :wordId`; `POST .../generate` → **503**.
- topics: `POST` create (body: `session_time`, `duration_sec`, `topic_level`, `summary`) → `GET` list → `PATCH :topicId` → `DELETE :topicId`; `POST .../generate` → **503**.
- `GET /api/sessions/:id/transcribe.csv` — assert 200 + CSV text.
- **Branch:** a `422` (invalid body) or tenancy `404` where cheap.

## Conventions

- **Anonymous happy paths:** session-scoped routes run with `{ ...env }` (no login) — `requireSession` skips the studio check when `user === null`, so a seeded session is directly reachable. Admin routes always need the bearer token.
- **Tenancy branches:** `withLogin = envWith({ REQUIRE_LOGIN: '1' })` + `loginCookie(nonMemberUserId)` → expect `404`.
- **Bodies** match the zod schemas in `src/schemas.ts`. **Exact response shapes** are reconciled against each router during implementation (the established "verify against source" step — CRUD handlers, low-risk).
- Each file is independently runnable: `npx vitest run --project workers src/routers/<file>`.

## Error handling & edge cases

Each file asserts at least one non-200 path (422 / 404 / 401 / 503) in addition to happy paths, so the sweep exercises both success and the most likely failure per group.

## Verification

- `npm run test` green across both projects (current 121 + the new sweep).
- `npm run typecheck` clean.

## Risks & rollback

- **Low risk** — mechanical CRUD tests, no external dependencies, no production changes. The only friction is response-shape/status reconciliation, handled per-route against the router source during implementation (same as prior plans).
- All additions are new files; revert is clean.

## Versioning

Test-only; no version bump; no new dependencies.
