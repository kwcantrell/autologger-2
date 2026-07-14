## Context

Teams ("studios") are currently support-managed objects: `user_studio_memberships` is
a bare `(user_id, studio_id)` table with no roles; team CRUD and membership
management exist only in the `ADMIN_TOKEN`-gated `/api/admin/*` family and its
unlinked `/admin/users` MPA page. The OAuth callback's new-user branch
(`server/src/routers/auth.ts`) seeds prefs from globals and — when
`NEW_USER_ALL_TEAMS` is set — grants membership of every team. Content authorization
is membership-based (`authUserHasStudio` via `requireSession` and the shows/profile
routers) and role-blind.

Facts the panel verified that shape this design: the callback never checks
`email_verified`; `users.email` is rewritten from Google claims on every sign-in and
has no uniqueness constraint; a disabled user signing in today 500s (the new-user
branch violates the unique `google_sub` constraint); `CatalogDb.tx` nests as
savepoints on the shipped better-sqlite3; the studio registry rebuilds from all of
`studio_definitions` on every request; the e2e hermetic servers cannot produce an
authenticated user.

The owner's explore rulings (2026-07-14, the mandate): role'd memberships
(`admin`|`member`), any user can create a team and becomes its admin, pending email
invites materialized at first sign-in exactly where `NEW_USER_ALL_TEAMS` dies,
`ADMIN_TOKEN`/`/admin/users` kept as the break-glass support plane, built-ins
untouched, everything contract-additive, and `requireSession` role-agnostic.
Post-panel gate rulings (2026-07-14) are recorded in the decisions below and the
Panel & review log.

Since session-deep-links (archived 2026-07-14), the web app is a routed SPA with
invariants this change must respect: `navigation.ts` is the only navigate caller;
the login gate sits above the router and covers every URL; the shared route module
(home of `isSessionRoutePathname`) is the single router-known predicate for its two
runtime consumers; the web vitest tier exists.

## Goals / Non-Goals

**Goals:**

- Team creation, membership, roles, and invites manageable by users in the product
  UI, with the support plane needed only for rescue.
- Invite-before-first-sign-in as the primary onboarding flow; a coherent
  zero-membership onboarding state for users with no teams.
- All server surface additive; hot-path authorization untouched.

**Non-Goals:** (see proposal) — no sent email/invite links, no roles beyond two, no
content-permission changes, no admin-plane rework, no built-in changes, no
ownership-transfer flows, no email canonicalization beyond lowercase/trim. No
product quotas/billing — the creation and invite caps below are DoS controls, not
product features.

## Decisions

### D1 — Role model: a column on memberships; backfill `admin` except built-ins

**Gate ruling (2026-07-14):** `ALTER TABLE user_studio_memberships ADD COLUMN role
TEXT NOT NULL DEFAULT 'member'`, then a one-time backfill `UPDATE ... SET
role='admin'` for pre-existing rows **excluding memberships of built-in studios**
(which stay `member` — the panel showed plain backfill would mint every legacy
`NEW_USER_ALL_TEAMS` user as an admin of `test-studios`/`test-studio-2`, and
built-ins are excluded from the management surface anyway). New grants default
`member` (invites, admin-plane adds); team creation inserts `admin`.

**Why backfill admin for real teams:** today every member is unconstrained, so
`admin` preserves manageability — every existing team stays self-manageable without
a support action. Backfilling `member` would orphan every existing team behind the
back door on day one.

**Alternatives considered:** backfill `member` + support-rescue each team (punishes
every existing team); "oldest membership becomes admin" heuristics (arbitrary);
admin-everywhere including built-ins (reads wrong in profiles, invites confusion).

### D2 — Invites: `team_invites` keyed on normalized email; verified-email materialization in one transaction

**Decision:** `team_invites(studio_id, email_norm, invited_by_user_id,
invited_at_utc, PRIMARY KEY (studio_id, email_norm))` — the column name matches the
exposed field; `invited_by_user_id` is kept (not exposed in the API) as a support/
audit breadcrumb for abuse triage, nothing else reads it. Normalization =
JS `toLowerCase().trim()` applied identically at invite time and sign-in time —
never SQL `lower()`, whose ASCII-only folding diverges from JS on non-ASCII local
parts. Basic validation: plausible email shape, ≤254 chars.

**Invite-time matching (panel-reconciled):** match against the email of record of
existing user rows **including disabled accounts** — membership is inert while
disabled, and treating disabled users as "unknown" would create pending rows that
can never materialize (a re-enabled user never re-enters the new-user branch).
`users.email` is not unique, so a normalized match grants `member` membership to
**every** matching row. A match that already holds membership is a strict no-op
(role preserved — an invite can never demote, so it cannot interact with last-admin
protection). No match → pending row (idempotent upsert), subject to the 200-per-team
cap (D10).

**Materialization (sign-in):** in the callback's new-user branch, **only when the
id_token carries `email_verified: true`** — this change promotes the email claim
into an authorization join key, and unverified emails must not collect invites (the
classic OIDC footgun; verified by the panel as absent from today's code, which is
fine while email is cosmetic and stops being fine now). The whole branch — user
creation, pref seeding, invite materialization + consumed-row deletion — runs inside
one `ports.catalog.tx(...)` at the router level: the panel verified `CatalogDb.tx`
nests as savepoints, the branch is fully synchronous, and the async KV login-session
write stays outside the transaction. Unverified-email sign-ins still create the user
(email stays cosmetic there); their pending invites remain in the table — revocable,
and materializable by a later verified sign-in of that address.

**Accepted residual (stranded invites):** an invite addressed to a person whose
existing account has a different email of record never converts (existing sign-ins
don't re-scan; the email of record is rewritten from Google claims each login). The
pending row stays visible and revocable; the admin remedy is re-inviting the address
the account actually uses. Re-scan-on-every-login was rejected: it reopens the
verified-email question on every request path and buys little.

**Response shape:** the invite endpoint returns a uniform `200` — valued as *shape
minimalism* (nothing to freeze beyond `ok`), NOT as enumeration hygiene: the panel
showed the inviting admin reads the outcome from the next `GET /api/teams/:id`
anyway, so no anti-oracle claim is made.

**Alternative considered:** invite tokens + acceptance URLs — rejected: no SMTP
exists to deliver them, and materialize-at-sign-in achieves the workflow with zero
new authentication surface.

### D3 — Authorization: two helpers local to the teams router; built-ins excluded wholesale

**Decision:** `requireTeamMember(c, teamId)` (401 if no user; masked 404 if not a
member — mirroring `requireSession`'s posture) and `requireTeamAdmin` (member check
first, then 403 if role isn't admin) live in `server/src/routers/teams.ts`. A
built-in-team guard runs before either: **every** `/api/teams/:id/*` operation on a
built-in id is rejected `400` (not three operations — all of them; built-ins remain
support-managed). Last-admin counting considers only **enabled** admins (a disabled
admin row must not satisfy the invariant). `requireSession`, `authUserHasStudio`
call sites, and every content router are untouched (mandate).

**Invariant a future reader might "helpfully" undo:** do NOT push role checks into
`requireSession` or the content routers — role-agnostic content access is a gate
ruling, and the per-session hot path stays as-is.

### D4 — Endpoint family shape and default behaviors

As enumerated in the api-contract-freeze delta table plus its default-behaviors
clause (unknown member target → 404; idempotent revoke and same-role change;
rename shares create's validation; `:email` decoded then normalized; caps → 400;
schema-rejected role values). Notables: rename is display-name-only (ids key
settings blobs, shows, sessions); slug validation reuses `STUDIO_ID_SLUG_RE`
verbatim (the Zod length bounds alone admit uppercase and `:` — the settings-blob
key namespace depends on the regex); delete reuses the existing blocks-on-shows
rule and cascades memberships + **invites** + definition + settings blob via a
shared store method used by BOTH the self-serve and admin paths (the admin path
today doesn't know about invites; the shared method is what keeps the planes
identical); last-admin count + mutation share one transaction (normative, not just
design); invite-of-existing-member is a no-op. `GET` detail carries
`enabled_admin_count` (phase-2 review finding: the members array deliberately
exposes no per-member disabled flag, so the orphaned-team UI state needs a
server-computed signal). Zod schemas alongside the existing ones in
`server/src/schemas.ts`.

### D5 — NEW_USER_ALL_TEAMS: ignored with a one-time startup warning

**Decision:** the config key stays parsed (no env-shape break), but the callback
branch no longer consults it; startup logs one deprecation warning when it is set
truthy. README + `.env.example` updated. Removing the key entirely would produce
silent ignoring — a warning beats silence for a behavior change this consequential
(a new-user-gets-nothing surprise deserves a log line).

### D6 — Route-definition extension, not duplication

**Decision:** the shared route module (home of `isSessionRoutePathname`) gains
`/teams` and exports the router-known predicate consumed by its two runtime
consumers — the stash write and the return-path validator. The three sanctioned
mirrors (AppShell's wouter patterns, the vite dev-middleware matcher, the server
serve block) are each extended in the same commit; they cannot mechanically share
one definition, so lockstep-by-review is the mechanism (the routing delta states
this honestly rather than overclaiming "one place"). Serve block:
`app.get('/teams', …serveHtml index…)` beside the session route.

### D7 — Teams UI: one `/teams` page; team list from profile, detail on demand

**Decision:** `/teams` renders from `profile.auth.user.teams[]` (now carrying
`role`) for the list + create affordance; expanding a team fetches
`GET /api/teams/:id` via a `useTeam(id)` hook (react-query; ordinary staleness is
fine here — no latching requirement, mutations invalidate both the detail key and
the profile). Management mutations are thin hooks over the endpoint family with
invalidation. Built-in memberships render read-only; a zero-enabled-admin team
renders the contact-support notice; dev-anonymous renders a signed-in-required
notice and issues no team fetches. UI composition follows the app's existing
glass-panel idioms; affordance layout is implementation freedom (behavioral
requirements only).

**Alternative considered:** `/teams/:id` param route per team — rejected for now:
team counts are small, one page keeps the route table minimal, and nothing needs a
per-team shareable URL yet (revisit if that changes; the route module makes adding
it cheap).

### D8 — Zero-membership onboarding at `/`

**Decision:** when the profile reports zero teams for a logged-in user, `AppShell`
renders an onboarding panel (create-your-first-team) instead of the rail+workspace
(which cannot function teamless). Successful creation invalidates the profile,
sets the new team active (server sets creator prefs if unset, mirroring
`authSeedPrefsFromGlobals`' spirit), and the normal shell takes over. Dev-anonymous
mode is unaffected (anonymous profile always reports the built-in studio).

**Alternative considered:** replace-navigate zero-team users to `/teams` and let
that page be the onboarding — rejected: data-driven navigation races profile
loading and violates the URL-derives-state cleanliness the deep-links change
bought; a conditional render at `/` has neither problem.

### D9 — Migration mechanics

One catalog migration in `server/src/db/migrations/`: the role column ADD +
built-in-aware backfill UPDATE + `team_invites` CREATE, in one migration file. The
migrator runs each file in its own transaction at boot before serving (panel-
verified, including `ADD COLUMN ... NOT NULL DEFAULT` on the shipped SQLite).
Rollback nit (accepted): memberships created by old code during a rollback window
arrive as `member` and stay that way on roll-forward (the backfill does not rerun);
a team created via the old admin plane in that window would need a support-plane
role rescue.

### D10 — DoS caps (gate ruling 2026-07-14)

**Decision:** two cheap caps, specced as DoS controls: a user already `admin` of
20+ non-built-in teams cannot create another (400), and a team holds at most 200
pending invites (400). Rationale: the registry rebuilds from all of
`studio_definitions` on every request and profile assembly lazily writes a settings
blob per readable team — unbounded self-serve creation taxes every request
globally. The support plane is uncapped. The proposal's no-quotas Non-Goal survives
in spirit: these are abuse ceilings, not product limits, and honest deployments
never see them.

### D11 — Disabled-account sign-in fix (gate ruling 2026-07-14, scope addition)

**Decision:** the callback resolves the Google `sub` against ALL user rows (not
just enabled ones); a disabled match redirects `302 /?login_error=account_disabled`
with no cookie and no writes — fixing the latent 500 (new-user branch UNIQUE
violation) in the exact branch this change rebuilds. `account_disabled` rides the
login-error code set's additive-open rule; the login page's unknown-code handling
already renders a generic failure, so no web change is strictly required (copy for
the code may be added while touching the error map).

## Risks / Trade-offs

- **[Email as an authorization key]** → `email_verified` gate on materialization
  (D2); invite-time matching against stored emails (which historically derive from
  unverified claims) accepted as residual — the attack requires an attacker-
  controlled Google account whose *stored-at-invite-time* email of record equals
  the victim's, which invite-time immediate grant makes visible in the members
  list.
- **[Stranded pending invites]** → accepted + documented (D2); visible and
  revocable; remedy is re-inviting the address in use.
- **[Create-collision existence oracle]** → accepted, recorded: `POST /api/teams`
  duplicate-id `400` necessarily confirms a slug exists, unlike the masked-404
  posture elsewhere; creation cannot both function and mask.
- **[Invite-list PII]** → pending-invite emails are visible to every current and
  future admin of the team (a promoted member sees the history). Accepted under
  the team trust model; recorded.
- **[Zero-admin orphan accumulation]** → support can strip the last admin (that's
  the rescue's dual); orphaned teams render a contact-support notice, and empty
  orphaned definitions are left for support cleanup (no auto-reap).
- **[Registry rebuild cost]** → bounded by D10's caps; a per-request rebuild of a
  few hundred rows is well within budget.
- **[Revocation latency]** → normative: next-authorization-check semantics; live
  connections not severed (consistent with the latched workspace).

## Migration Plan

Single deploy; the catalog migration runs at boot (existing migrator). Code-only
rollback is safe: old code ignores the unknown column/table. `NEW_USER_ALL_TEAMS`
behavior change takes effect immediately; operators keep the env var without
breakage (warning only). See D9 for the rollback-window role nit.

## Open Questions

- None. All four gate escalations were dispositioned 2026-07-14 (see log).

## Panel & review log

### 2026-07-14 — Adversarial panel (4 reviewers: requirements, assumptions, failure & abuse, scope) + gate

**Blockers/majors fixed in place:**

- **S1 (Blocker, req + abuse + assumptions independently):** invite lifecycle —
  spec/design contradiction on disabled users (spec's version manufactured
  unmaterializable pendings), `users.email` instability (rewritten each sign-in)
  and non-uniqueness unaddressed, latent disabled-sign-in 500 in the branch being
  rebuilt. Fixed: D2 reconciled (match any user row incl. disabled; multi-match
  grants all; already-member no-op), stranded-invite residual documented,
  disabled-500 fix escalated → gate ruled in-scope (D11).
- **S2 (Blocker, assumptions):** teams e2e smoke unimplementable in the hermetic
  servers (anonymous-only; `/api/teams` 401s; no login-seeding mechanism).
  Escalated → gate ruled: seeded-session fixture (recorded in the proposal's
  Impact and task 7.1; test-side only, no server surface — deliberately not a
  design decision since it changes no product code).
- **S3 (Major, abuse + assumptions + req):** `email_verified` never checked while
  this change promotes email to an authorization join key. Fixed: normative
  verified-email gate on materialization (spec + contract delta + D2).
- **S4 (Major, req):** invite-of-existing-member upsert hole could demote the sole
  admin around the closed-list last-admin protection. Fixed: invite is a strict
  no-op on existing memberships; last-admin restated as a global invariant over
  enabled admins with transactional count+mutate (also closes abuse's TOCTOU
  finding and req's disabled-admin-count gap).
- **S5 (Major, req):** built-ins excluded from only three of nine operations, and
  D1's backfill would mint built-in admins. Fixed: wholesale built-in exclusion
  (400 on every route), backfill excludes built-ins (gate-ruled D1), UI renders
  built-ins read-only.
- **S6 (Major, req):** support rescue would silently no-op on existing memberships
  (`INSERT OR IGNORE`). Fixed: admin add-membership specced as an upsert.
- **S7 (Major, req + scope + abuse):** frozen-family status-code gaps (unknown
  member, idempotent revoke/same-role, rename validation, `:email` decoding, email
  shape/length, out-of-enum roles). Fixed: default-behaviors clause in the
  contract delta.
- **S8 (Major, abuse):** unbounded creation/invites as a DoS surface conflicting
  with the no-quotas Non-Goal. Escalated → gate ruled: cheap caps (D10).
- **S9 (Major, assumptions):** "atomically with user creation" asserted without a
  design — no transaction exists in today's branch. Fixed: D2 specifies the
  router-level `catalog.tx` boundary (savepoint nesting panel-verified; KV write
  outside).
- Also fixed in place: dev-anonymous `/teams` render specified; zero-admin team
  member view specified; transport-stop baseline requirement MODIFIED to cover
  `/teams` departures; revocation-latency semantics made normative; admin-plane
  delete's invite cascade made normative via the shared store method; slug
  validation pinned to the shared regex (Zod bounds alone admit `:`/uppercase);
  JS-side normalization pinned (SQL `lower()` divergence); `invited_at_utc`
  naming unified; route-definition "one place" claim corrected to two consumers +
  three lockstep mirrors; uniform invite response re-justified as shape
  minimalism (enumeration-hygiene claim struck); `invited_by_user_id` kept with
  an explicit audit rationale, unexposed; D5's strawman sentence fixed; D8's
  rejected redirect-onboarding alternative recorded; built-in rejection and cap
  tests added to tasks; shell-reachability clause added for `/teams`.

**Escalated to the gate (owner decisions, 2026-07-14):**

- D1 backfill → **admin except built-ins** (over: admin everywhere; member +
  rescue).
- e2e auth harness → **seeded-session fixture** (over: descope to integration
  tier).
- DoS caps → **cheap caps** (20 owned teams/user, 200 pending invites/team; over:
  accept unbounded with note).
- Disabled-sign-in 500 → **fix in-scope** via additive `account_disabled` code
  (over: record as known defect).

**Minors accepted as residual:**

- Create-collision slug existence oracle (necessary for creation to function).
- Pending-invite emails visible to current and future team admins (PII under the
  team trust model).
- Stranded invites for accounts whose email of record differs (visible, revocable,
  re-invitable).
- Invite-time matching trusts stored emails that historically derive from
  unverified claims (materialization is gated; invite-time residual accepted).
- Rollback-window memberships arrive role `member` (D9).
- Homoglyph/unicode emails are distinct addresses (no folding) — a mistyped
  confusable simply never matches; documented, not defended.

**Verified defenses / non-issues (no action):** stash validator stays exact-match
(no prefix bypass from adding `/teams`); settings-key injection blocked by the
shared slug regex (now normative); no SMTP → no header injection; delete-team
transitively blocked by live sessions via shows; deleted-active-studio profile
fallback degrades gracefully; migration mechanics verified empirically on the
shipped SQLite (boot-time, per-file transactions, no backfill window); registry
freshness per-request; profile teams assembled in exactly one place; scope
reviewer: nine routes map one-to-one onto the mandate, no over-built structure.
