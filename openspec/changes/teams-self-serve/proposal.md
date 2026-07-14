## Why

Users can create and manage shows *within* a team, but teams themselves are
support-only objects: creating a team, adding or removing members, and every other
membership operation lives exclusively behind the `ADMIN_TOKEN`-gated `/admin/users`
page — an operator back door, not a product surface. Onboarding a teammate today
requires a support action with a shared secret. The membership table has no roles, so
even if the UI existed there would be no way to distinguish who may manage a team from
who merely works in it. The owner's explore rulings (2026-07-14, recorded as the
mandate for this change) call for self-serve, role'd teams with email invites, with
the admin plane retained strictly as break-glass support.

## What Changes

- **Role'd memberships.** `user_studio_memberships` gains a `role` column
  (`admin` | `member`). Team-management operations are admin-gated; content
  operations (shows, sessions, settings) are unchanged and stay role-agnostic —
  `requireSession` and the hot per-session path are untouched. Migration backfill
  (gate ruling 2026-07-14): existing memberships become `admin`, except built-in
  studio memberships which stay `member` (design D1). Built-in teams are excluded
  from the entire self-serve surface.
- **Self-serve team lifecycle.** Any signed-in user can create a team (same slug
  rules as the admin path; built-in ids reserved) and becomes its `admin`. Team
  admins can rename the team, invite/remove members, promote/demote roles, and
  delete the team (delete keeps the existing blocks-on-shows rule). Members can
  leave. **Last-admin protection** is a global invariant: no operation on the
  surface — including invite-driven membership upserts — may reduce a team's count
  of *enabled* admins to zero.
- **Pending invites by email** (owner: "invite before first sign-in is the real
  workflow"). New `team_invites` table keyed on normalized lowercase email. Inviting
  an email that belongs to an existing user grants membership immediately (a no-op
  for existing members); otherwise a pending invite is stored and **materialized
  into membership at first Google sign-in** — gated on the id_token's
  `email_verified: true`, since this change promotes the email claim into an
  authorization join key — in the OAuth callback's new-user branch, atomically with
  user creation, exactly where `NEW_USER_ALL_TEAMS` dies. Admins can revoke pending
  invites. No email is sent (no SMTP in this deployment); the invited person simply
  signs in. Creation and pending-invite DoS caps apply (gate ruling; design D10).
- **Disabled-account sign-in fix (in-scope gate ruling).** The callback currently
  500s when a disabled user signs in (new-user branch hits the unique `google_sub`
  constraint) — the exact branch this change rebuilds. It now redirects
  `302 /?login_error=account_disabled` (the code set is contractually
  additive-open).
- **`NEW_USER_ALL_TEAMS` deprecated.** Incoherent once teams are owned spaces: the
  env var is ignored (with a boot-time warning when set) and new users start with
  exactly their materialized invites — or none, landing on the new zero-membership
  onboarding state with a create-your-first-team affordance.
- **Teams UI in the SPA.** A new `/teams` route (automatically covered by the
  login gate per the gate-above-router invariant) hosting team management: your
  teams with roles, create team, and per-team admin controls (rename, members,
  invites, promote/demote/remove, leave, delete). The shared route module extends
  for its two runtime consumers (stash write, return validator); its three
  sanctioned mirrors — AppShell's route patterns, the dev middleware, the server
  serve block — are extended in lockstep in the same change (see design D6).
- **Admin back door kept, minimally extended.** `ADMIN_TOKEN` + `/admin/users` stay
  as the unlinked "AutoLogger support" plane (account disable/enable, orphaned-team
  rescue). One additive change: the admin add-membership body accepts an optional
  `role` (default `member`) so support can rescue a team whose last admin is gone.

## Capabilities

### New Capabilities

- `team-management`: the self-serve team domain — membership roles and their
  authorization semantics, team lifecycle (create/rename/delete by team admins),
  email invites (pending storage, normalization, immediate-vs-materialized grant,
  revocation, last-admin protection), the deprecation of `NEW_USER_ALL_TEAMS`, the
  zero-membership onboarding state, and the `/teams` management UI states.

### Modified Capabilities

- `api-contract-freeze`: authorizes the additive server surface — the new
  `/api/teams` endpoint family (create/rename/delete team, invite/revoke, member
  role change/removal, leave, team detail, with a frozen default-behaviors clause),
  the `GET /teams` HTML page route, the additive `role` field on profile
  `auth.user.teams[]` entries, the optional `role` field on the admin
  add-membership body (upsert semantics — the rescue path), the behavior change
  that new users no longer receive all-team memberships regardless of
  `NEW_USER_ALL_TEAMS` (and only materialize invites on verified emails), and the
  disabled-account sign-in redirect (`account_disabled`, additive to the code set).
  All existing surface (including every `/api/admin/*` route) is otherwise
  unchanged.
- `web-session-routing`: the route table grows from exactly two app routes to
  three (`/`, `/sessions/:id`, `/teams`).
- `web-login-experience`: the post-login return validator's router-known set
  extends to include `/teams` (still via the single route-definition source, not a
  second regex).

## Impact

- **Contract impact:** additive only — new `/api/teams/*` routes + `GET /teams`
  HTML (endpoint table rows), one additive profile field, one additive optional
  admin body field, the additive `account_disabled` login-error redirect, plus the
  authorized `NEW_USER_ALL_TEAMS` behavior change. `requireSession`, all frozen
  `/api/admin/*` semantics, WS surface: unchanged.
- **Server:** catalog migration (role column + backfill, `team_invites` table);
  `authStore` role/invite operations; new `server/src/routers/teams.ts`; the OAuth
  callback new-user branch (invite materialization replacing the
  `NEW_USER_ALL_TEAMS` grant); profile assembler (role on teams entries); serve
  block `/teams` row; README endpoint table + env docs; `.env.example`.
- **Web:** `/teams` route + management page; zero-membership onboarding state at
  `/`; route-definition extension (`isSessionRoutePathname`'s module becomes the
  shared router-known source it was designed to be); dev-middleware matcher
  extension; api hooks + types for the teams family; web vitest coverage.
- **e2e:** a new seeded-session harness fixture (gate ruling 2026-07-14 — test-side
  only: seeds a user row + hashed session token into the hermetic server's catalog
  DB and injects the cookie; no server surface) enabling an authenticated teams
  smoke (create team → rename → invite flow visible); login-gate project gains the
  anonymous `/teams` URL-preserved coverage.
- **Untouched:** Companion module, session/event/audio surface, hub, blob store,
  built-in studios (`test-studios`, `test-studio-2` remain support-managed
  dev-anonymous anchors).

## Non-Goals

- **No sent email.** Invites are in-app records matched at sign-in; no SMTP, no
  invite links, no acceptance-token URLs (materialize-at-sign-in makes them
  unnecessary).
- **No roles beyond `admin` | `member`**, no per-show/per-session permissions, and
  no change to content authorization — any member keeps full content access to
  their teams; `requireSession` stays role-agnostic (owner mandate).
- **No admin-plane UI rework.** `/admin/users` keeps its token flow and frozen
  endpoints; at most page copy shifts toward "AutoLogger support" wording at
  implementation time.
- **No changes to built-in studios** — not creatable, not deletable, not role-
  managed; they remain the dev-anonymous anchor and legacy fixtures.
- **No team ownership transfer flows beyond promote/demote**, no team archiving,
  no product quotas or billing — the per-user creation cap and per-team
  pending-invite cap (design D10) are DoS abuse ceilings, not product limits.
- **No Gmail-style address canonicalization** — invite matching is
  lowercase/trimmed exact match only (dot- and plus-aliases are distinct
  addresses).
