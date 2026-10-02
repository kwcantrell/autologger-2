# Login is always required: remove anonymous mode

Tier: 2
Tier reason: authentication (the login gate and every anonymous branch), boot-time refusal, compose posture pins, and removals from the frozen HTTP contract; touches `server/src/routers/**`.

Approved-by: Kalen 2026-10-01

## Why

ADR 0021 slice 5 removes anonymous mode. Slice 5a made Supabase Auth (GoTrue) the identity of
record. The server still has a `REQUIRE_LOGIN=0` mode, and dev runs in it. In that mode:
- every `/api/*` route serves `user === null` callers;
- those callers see every studio;
- they share one global active team and show.

Slice 6 bases RLS on `auth.uid()`, so it needs every request that reaches the catalog to come from
a signed-in user or from the Companion machine token. That's 5b. 5c (the owner role, the bootstrap
owner, dropping the built-in studios) comes next.

## What Changes

- **BREAKING: login is always required.** The `REQUIRE_LOGIN` setting is removed.
  - Every `/api/*` route answers a caller with no session cookie with `401 {"detail": "Login required."}`.
  - The existing exemptions are kept:
    - `GET /api/profile`, now also `HEAD` (Hono serves HEAD through the GET handler, so today
      it's a spurious 401);
    - `/api/admin/*`, which uses `ADMIN_TOKEN`;
    - `API_TOKEN` on `/api/companion/*`.
  - `/auth/*` is unchanged.
  - Routes that served anonymous callers in dev mode now return that 401:
    - `GET /api/studio`, `GET /api/shows`, `GET /api/shows/:id`;
    - `GET` and `POST /api/sessions`;
    - `PUT /api/profile`;
    - every session-scoped route.
- **The server refuses to boot (owner)** when either of these holds:
  - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` or `PUBLIC_BASE_URL` is blank (whitespace
    counts as blank), because no one could sign in;
  - `REQUIRE_LOGIN` is set to any value. A stale `REQUIRE_LOGIN=0` must fail loudly; it must not
    be ignored silently.

  `docker/scripts/compose-run.mjs` requires both Google values in every stack. Dev is no longer
  exempt.
- **BREAKING (contract): the open-network refusals are deleted (owner).** These features each had
  a `503` that fired only with login disabled, a non-loopback bind and no `IP_ALLOWLIST`:
  - AI chat;
  - AI v2;
  - topic generation;
  - event generation;
  - YouTube import;
  - Sheets log import.

  Those 503s can no longer happen. The predicate, the detail strings, the boot warning, the
  tests and the frozen rows are removed. AI v2's credentials rule (no key on a non-loopback bind
  → 503) is unchanged.
- **Anonymous branches are removed.**
  - The global anonymous active team and show (`SETTING_ACTIVE_SHOW`, `SETTING_ACTIVE_STUDIO`) are
    no longer read or written. Their stored rows are left in place.
  - These checks now always apply to the signed-in user:
    - the studio-membership checks in `requireSession`, shows and Sheets import;
    - the topics-generate busy-holder disclosure;
    - the Sheets job-creator check.
  - The only principal-less caller left is `API_TOKEN` on `/api/companion/*`. It keeps its frozen
    no-membership path.
- **`GET /api/profile` while signed out** keeps its frozen shape. `auth.oauth_configured` is now
  always `true`, because boot guarantees it.
- **Web.** Two anonymous-mode leftovers are removed:
  - the login gate shows whenever `auth.logged_in` is false;
  - the Teams page's "anonymous mode" panel is deleted.
- **Dev (owner).** Dev signs in with a real Google OAuth client. The owner creates the client
  (redirect `http://localhost:8787/auth/google/callback`) and puts `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET` and an `API_TOKEN` in Infisical dev. The dev Companion module is
  configured with that token.
- **Compose and checks.**
  - `REQUIRE_LOGIN` is removed from `compose.yaml` and `docker/compose.dev.yaml`.
  - `check-envs.sh` drops its `REQUIRE_LOGIN` pins. It doesn't assert that the variable is
    absent: the boot refusal is the guard, and Infisical can't inject the variable.
- **A repo test bans raw-path security decisions** in `server/src/middleware/**` and
  `server/src/routers/**` (AGENTS.md rule 8), so `gate-decoded-path` can't regress.
- **Docs:**
  - README;
  - the `.env` examples;
  - the Companion help;
  - `docs/supabase.md` and `docs/infisical-secrets.md` (dev needs a Google client and `API_TOKEN`);
  - ADR 0021 (the 5b entry).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `api-contract-freeze`:
  - the open-network `503` rows and scenarios are removed (YouTube import and topic generation;
    event generation's refusal lives only in `auto-event-generation`);
  - the anonymous-requester wording is replaced: busy-holder disclosure, Sheets job scope and
    `GET /api/shows/:id`;
  - "API_TOKEN is Companion-only" drops its `REQUIRE_LOGIN` modes;
  - login is required on every `/api/*` route outside the listed exemptions.
- `core-ports-architecture`: the login-check scenarios lose their `REQUIRE_LOGIN=1` qualifier.
- `web-login-experience`: the gate keys on `logged_in` alone, and the dev-anonymous scenario is
  removed.
- `web-frontend-platform`: "Single-process development" gains the boot refusals (blank Google
  client values, any `REQUIRE_LOGIN`).
- `team-management`: the dev-anonymous notes in "Membership roles" and "Teams management UI"
  are removed.
- `transcript-generation`: lock-holder identifiers are disclosed to members of the holder's
  studio only; the anonymous wording is removed.
- `ai-topics-chat`, `ai-v2-dashboards`, `topic-generation`, `auto-event-generation`,
  `youtube-audio-import`, `sheets-log-import`: the open-network refusal requirement or row is
  removed, along with the anonymous-requester wording.
- `container-deployment`: the `REQUIRE_LOGIN=1` posture pin becomes "no `REQUIRE_LOGIN`; boot
  refuses it".
- `local-container-environments`:
  - dev is no longer anonymous;
  - dev's pins drop `REQUIRE_LOGIN=0`;
  - stage drops its `REQUIRE_LOGIN=1` pin;
  - static invariant 7 changes.

## Non-goals

- **5c:** the `owner` role, `BOOTSTRAP_OWNER_EMAIL`, dropping the built-in studios, and
  first-sign-in team assignment (`NEW_USER_ALL_TEAMS` stays).
- **Removing `oauth_configured` or any field from a frozen JSON shape.** It stays, always `true`.
- **Deleting the stored anonymous settings rows.** Slice 11's import decides what to carry.
- **Companion credentials.** `API_TOKEN` is unchanged until slice 9.
- **`IP_ALLOWLIST`, `TRUST_PROXY`, the admin plane and AI v2's credentials rule.** All unchanged.
- **RLS.** That's slice 6.
- **Rebuilding browser e2e.**

## Impact

- **Server:**
  - `bootGuard.ts`, `env.ts`, `middleware/auth.ts`, `main.ts`, `node/config.ts`;
  - routers: `ai`, `aiV2`, `sessions`, `transcribe`, `events`, `logImport`, `shows`, `profile`,
    `_helpers`.
- **Packages:**
  - `ports` (`Config.REQUIRE_LOGIN` removed);
  - `catalog` (`profileAssembler` anonymous path removed);
  - `log-import` (`createdByUserId` becomes non-null).
- **Web:** `RootGate.tsx`, `TeamsRoute.tsx` and their tests.
- **Compose and tooling:**
  - `compose.yaml`, `docker/compose.dev.yaml`, and the header comment of
    `docker/compose.stage.yaml`;
  - `docker/scripts/compose-run.mjs`, `check-envs.sh`, `test_check_envs.sh`.
- **Tests:**
  - the integration harness signs in a default member, so existing suites keep exercising their
    routes;
  - the open-network suites are deleted.
- **Owner steps, before the dev live check:**
  - create the dev Google client;
  - add `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `API_TOKEN` to Infisical dev;
  - set the token in the dev Companion module.

  Until then `make dev-up` refuses, by design.
- **Size:** about 550–650 counted lines, mostly deletions. `README.md` and the deleted
  `profileAnonymous` capture are counted. The owner chose one PR with `size-override`.
