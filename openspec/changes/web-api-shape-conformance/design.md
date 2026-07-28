# Design — web-api-shape-conformance

## Context

`web/src/api/client.ts` exposes a single fetch helper whose success path is
`return res.json() as Promise<T>` — `T` is an **assertion**, not a check. Every caller names
the shape it expects and TypeScript believes it.

The `/admin/users` crash is the first of these to surface in practice: the client declared
`AdminUser.memberships: string[]`, the server has always sent `studios: [{id, name}]`, and
`u.memberships.map(…)` threw, unmounting the page. Confirmed against the live server and
reproduced in-browser (React root collapsed to zero length,
`Uncaught TypeError: Cannot read properties of undefined (reading 'map')`).

It is the **second** instance of the class. Commit `2ca5b1d` ("round-trip show categories via
name key") fixed the first, and its message already records the remedy: wire-accurate fixtures,
"so a label-keyed fixture can't mask the bug."

Constraints that shape the solution:

- **The server contract is frozen and correct.** The client is the divergent side.
- **`apiFetch`'s success path is untested.** Its 5 existing tests cover header merging and the
  `ApiError` path.
- **`web/src` has JSON ingresses that are not `apiFetch` calls** — a local generic wrapper
  (`fetchAdmin<T>`) and several raw `fetch(…).json() as X` sites. Any enumeration keyed on the
  spelling `apiFetch<` misses them, including the crashing call itself.
- **The web test tier is mature** (`@testing-library/react` + jsdom, ~50 test files) and the
  server integration tier already has seeding helpers and issues `GET /api/admin/users` today.

## Goals / Non-Goals

**Goals:**

- Restore `/admin/users` to working order, with regression coverage where there was none.
- Make a client/server response mismatch fail **in CI**, attributably, rather than in an
  operator's browser.
- Leave a recorded, per-site conformance verdict — surviving archival — so "is this the only
  one?" has a durable answer.
- Prevent the *next* endpoint from re-entering the class.

**Non-Goals:** any server change; runtime response validation (D1); request-body or WebSocket
validation; OpenAPI/codegen; rewriting `react-query` hook structure.

## Decisions

### D1 — Build-time conformance against captured responses, over runtime validation

**Decision:** Verify client types against **captured real responses** in CI. Do **not** add
runtime schema validation to the browser client.

**Alternatives considered:**

- **(a) Runtime validation at the fetch seam (Zod).** Catches drift wherever it occurs,
  including production data no fixture models.
- **(b) Codegen from a server schema.** Structurally eliminates the class; far larger commitment.
- **(c) Captured-fixture contract checks + a repo-invariant guard.** Chosen.

**Rationale.** This reverses the pre-gate draft, which chose (a). The panel defeated that draft's
two rationales and supplied measurements:

1. The draft argued fixtures cannot help because "a fixture written from the same wrong belief
   would have passed." That refutes **hand-written** fixtures — but (c) captures fixtures by
   executing the handler, so they cannot encode the client's belief. The draft refuted a straw
   man.
2. **Runtime validation detects no earlier than the status quo.** The `memberships` bug would
   still surface only when an operator loads `/admin/users` — as a toast instead of a white
   screen. (c) fails in CI, strictly earlier.
3. Measured cost of (a): **+14,082 B gzip on a 123,176 B main chunk (+11.4%)**, paid by every
   user on every page, because the seam lives in shared `client.ts` — while `/admin/users`
   itself is a 2,131 B lazy chunk. The draft's named mitigation (`zod/mini`) does not exist at
   the available version and measured **3× worse** (44,744 B gzip).
4. The repo already answered this question once, in `2ca5b1d`, with wire-accurate fixtures.

**What (a) would have bought that (c) does not — recorded as a residual, not built:**
**production data variance.** A fixture captured from seeded test state cannot model a field
that is null only in real operator data. This is the one honest argument for runtime validation,
and it is not sufficient to justify the measured cost. If real drift of that kind appears, this
residual is where the reconsideration starts.

### D2 — Fixtures are captured by executing the handler, never hand-authored

**Decision:** Each payload-bearing endpoint gets a `server/` integration test that issues the
real request and writes/asserts the emitted body as a committed fixture.

**Rationale.** This is the whole load-bearing mechanism (see D1 rationale 1). A fixture typed
by hand from reading either the client type *or* the handler source reintroduces the
transcription step that caused the defect.

**Consequence a future reader might undo:** "tidying" a captured fixture by hand — trimming
fields, prettifying values, or regenerating it from the client type — silently destroys the
guarantee. Fixtures are outputs, not source.

### D3 — Fixtures are two-sided: the server asserts them, the client checks against them

**Decision:** The capture test asserts the **live** response still equals the committed fixture
(so it cannot go stale), and the web tier checks its client types against the same file.

**Rationale.** One side alone is insufficient. Capture-only lets the fixture drift from the
server; check-only lets a stale fixture certify a client type against a shape the server
abandoned. Both sides are cheap because both tiers already exist.

### D4 — Client types stay hand-written; the check is a TypeScript assignment

**Decision:** Keep the existing hand-written interfaces in `web/src/api/types.ts`. Verify them
with a type-level assignment against the imported fixture — `const _check: AdminUser =
fixture.users[0]` — in a build-checked module.

**Rationale.** `web/tsconfig.json` already sets `resolveJsonModule`. The assignment fails when
the client declares a field the fixture lacks (the `memberships` bug exactly) or mistypes one,
and **tolerates** fields the fixture has and the client does not, because excess-property
checking does not apply to non-fresh expressions — which is precisely the forward-compatibility
property required. No dependency, no runtime, no bundle.

The pre-gate draft proposed replacing these interfaces with `z.infer` on the grounds that "two
hand-maintained declarations is how the bug persisted." The panel established there was only
**one** declaration; the cause was a single hand-transcription never confronted with a real
response. `z.infer` would have preserved that transcription step while destroying
`types.ts`'s documentation value — the 10-line comment on `ShowCategory` encodes hard-won
knowledge about the name/label split that a schema cannot carry.

**Verified empirically (2026-07-27), not asserted.** Run against this repo's own TypeScript
with `strict` + `resolveJsonModule`:

| case | result |
|---|---|
| Correct type, fixture carries extra `picture_url`/`created_at_utc` | **passes** — additive tolerance holds |
| Type requires `memberships`, fixture lacks it (*the actual bug*) | **fails** — `TS2741: Property 'memberships' is missing` |
| Union field `session_status` vs `.json` fixture | **fails** — `TS2322: Type 'string' is not assignable to '"active" \| …'` |
| Same union vs `.ts` fixture with `as const` | **passes** |

**Known wrinkle, now quantified:** JSON imports widen literals, so a union-typed field produces
a *false positive* against a `.json` fixture (row 3). Affected fields in `types.ts`: `Category
.type` and `ShowCategory.type`, `Session.session_status`, seven `role: TeamRole` fields, and
`CompanionCommandType` — a minority of 47 exported interfaces, but not a rarity. Those fixtures
are emitted as `.ts` modules with `as const` instead of `.json`. `.json` stays the default;
`as const` is the documented exception, chosen per endpoint and recorded in the ledger.

### D5 — A repo-invariant guard, built now rather than deferred

**Decision:** Add `web/src/apiResponseShapes.repo.test.ts`, failing when a response-consuming
site has neither a conformance check nor a recorded exemption.

**Rationale.** The pre-gate draft deferred this to "a cheap follow-up if drift recurs." Drift
**has** recurred — `2ca5b1d` and now `memberships`. Without it, phases that fix today's sites
leave the next endpoint free to be hand-transcribed wrong. The repo already owns this idiom
twice (`queryKeyFactories.repo.test.ts`, `noAgentAuthoredMarkup.repo.test.ts`), one of which
exists verbatim so key shapes "cannot drift apart."

### D6 — The audit's enumeration is semantic, not textual

**Decision:** The audit universe is "every site where a JSON API response acquires a client
type." A grep count is never acceptance evidence.

**Rationale.** All four panel reviewers independently found that
`grep 'apiFetch<'` → 45 **excludes the call that caused this bug**:
`fetchAdmin<AdminDataResponse>('admin/users', token)` goes through a local generic wrapper whose
only `apiFetch<` occurrence is the unresolved `apiFetch<T>`. Also excluded: 6 untyped
`apiFetch(…)` calls and ~5 raw `fetch(…).json() as X` sites (AI-v2 dashboard persistence, SSE
frame parsing) — the most recently added endpoints, where transcription drift is most likely.

**Consequence a future reader might undo:** re-anchoring the audit on a tidy grep count. The
count is a starting point; the population is defined by behavior.

### D7 — The audit answers a property, following spreads to their producer

**Decision:** Each verdict answers *"the emitted key set and value types for endpoint E, under
every branch"* — established by following spreads and passthroughs to the function that produces
them, not by stopping at the router.

**Rationale.** Several shapes are not determinable from the route handler alone:
`transcribe.ts` emits `{...w, session_id}` (shape owned by the store); `showApiDict` passes
through `JSON.parse` of a DB column with no read-side validation; `profilePayload` has three
structurally distinct branches; `teams.ts` attaches `invites` only for admin callers. A verdict
that stops at "it returns the row" answers the wrong property — the repo's own fact-check rule
forbids confirming a pointer.

Where a shape is caller- or data-dependent, the verdict records the dependency rather than a
single shape.

### D8 — Membership chips show the team name

**Decision:** The chip renders `studio.name` (`My Crew`), not `studio.id`. The remove control's
accessible name is `Remove from <name>`; the request it issues is keyed by `id`.

**Rationale.** The name is already in the response. Owner-selected as part of this change's
scope, so it is specced rather than smuggled in. Its full cost is re-blessing two committed
visual baselines, done in the same phase that changes the pixels.

### D9 — The audit ledger is version-controlled

**Decision:** The verdict table lives in a **tracked** file in the change directory, not under
`.apply/`.

**Rationale.** `.gitignore` carries `openspec/changes/**/.apply/`. The pre-gate draft wrote the
spec's mandated durable record to a git-ignored path, so after archival the answer to "is this
the only one?" would have been gone and the next reviewer would re-derive every verdict.
`.apply/` is right for subagent reports and diffs; not for a deliverable.

### D10 — `SERVER-WRONG` is reachable only against a documented shape

**Decision:** State explicitly that the handler is the shape authority, and that `CONFORMS`
means "client matches emitted", not "emitted is intended".

**Rationale.** `api-contract-freeze` does not document `GET /api/admin/users`'s response shape,
and the README table is a **route** inventory, not a shape inventory. So for most endpoints a
handler cannot contradict itself and the escalation path has no trigger — which means the audit
silently **promotes current emissions to contract** unless it says otherwise. Saying so keeps
the ledger honest about what it establishes.

## Risks / Trade-offs

- **Captured fixtures reflect seeded state, not operator data** → The residual named in D1. A
  field null only in real data is not modelled. Accepted knowingly; the mitigation would be
  runtime validation, whose cost the gate rejected.
- **The `dropdown_options` finding needs a type split, not a field edit** — `Category` is shared
  between `/api/profile`'s `active_studio.categories` (server emits `string[]` via
  `studioToApiDict`) and `ShowCategoriesResponse` (server emits `{label, needs_context}` via
  `showCategoriesApiShape`). Consumers exist on both sides (`CategoryButtonStrip` reads
  `opt.label`; `EventButtonsTable` constructs `{label, needs_context}`) → Pre-decided as a split
  with the consumer list enumerated in tasks, so it is not discovered mid-implementation.
- **Fixture capture could ossify an accidental emission** → D10 makes the ledger say that
  `CONFORMS` is descriptive, not ratifying.
- **JSON literal widening produces false negatives on unions** → D4's `.ts`-fixture escape
  hatch, chosen per endpoint and recorded.
- **The repo-invariant guard can produce false positives** on a legitimately exempt site →
  Exemptions are explicit and recorded, so the guard is arguable rather than absolute.
- **Server capture tests add runtime to the server tier** → Small; they reuse existing seeds and
  the tier already issues most of these requests.

## Migration Plan

Phased, each phase test-gated (see `tasks.md`). Phase 1 is standalone and shippable alone.
Later phases add tests and type corrections only — no runtime behavior change and no
operator-visible surface, so **no revert can regress the running application**.

Build integrity does impose one ordering constraint: phase 5's conformance checks consume the
fixtures phase 4 produces, and phase 4's fixture set is chosen from phase 3's audit. Reverting
4 while keeping 5 breaks the build. The revert boundaries are therefore: phase 1 alone; phase 2
alone; phase 3 alone; and phases 4+5 together as one unit.

## Open Questions

- **Fixture capture ergonomics:** write-on-miss (auto-create, assert thereafter) versus
  assert-only with manual regeneration. Proposed: assert-only, with an explicit update script —
  auto-write silently blesses drift, which is the failure mode being designed against.
- **Guard breadth:** should the repo-invariant test cover raw `fetch(…).json()` ingresses from
  day one, or start at the `apiFetch`/wrapper family and widen? Proposed: cover all of them; the
  AI-v2 raw-`fetch` sites are exactly where the next instance is most likely.

## Panel & review log

### 2026-07-27 — Pre-panel fact-check pass (light tier)

Mechanical fetch-and-compare of the **stated checkable claims** in `proposal.md`, `design.md`,
and `tasks.md` against the live repo. Each claim was stated as a *property to verify* and
answered from the authoritative source (server route handler, package manifests, git history,
spec text) rather than by confirming a cited line. 17 properties checked.

**Claims CONFIRMED (16):** the `apiFetch` unchecked-cast success path (full function read);
45 call sites / 46 occurrences / 11 non-test files; the 16 `OkResponse` + 2 `void` + 27
payload-bearing split; `GET /api/admin/users` emitting `studios: [{id, name}]` and no
`memberships` key (full handler read); the current `AdminUser.memberships: string[]`
declaration; `memberships` present since `cc60162` with no `memberships` response field ever
emitted in the endpoint's tracked history; no test file under `web/src/pages/admin-users/`;
`client.test.ts` holding exactly 5 tests, none asserting a successful call's return value or
the non-JSON branch; zod 3.25.76 hoisted at root and absent from `web/package.json` with no
duplicate under `web/node_modules`; no validation-library import anywhere in `web/src`;
`loadAll`'s catch surfacing `err.message` via toast; the `e2e`/`e2e:visual` script and project
names; no existing spec covering admin-page behavior, with `web-ui-system`'s sole mention being
the no-`window.confirm` dialog policy; the README endpoint table as normative route inventory;
and one process serving both the API and `web/dist`.

**Claims CORRECTED (1):** *"Three consumers of the memberships field."* Textually there are
**two** direct reads — the chip-list `.map` and the add-membership `.filter(…includes…)`. The
remove call is nested **inside** the chip-list consumer and receives its argument from that
map's parameter. Corrected in `proposal.md` and `tasks.md`.

**Material finding folded in:** `tasks.md` had asked implementers to *check whether* a visual
baseline covers `/admin/users`. It does — `e2e/visual.spec.ts` has an `admin-users` test with
`admin-users-visual-{desktop,mobile}-linux.png` committed — so D8's label change requires
re-blessing both.

**Left UNVERIFIED:** none of the 17 required judgment-only adjudication. Design judgments —
notably D1's weighing of runtime validation against contract tests, and the bundle-cost risk —
were out of scope for this pass and reached the panel un-vouched. That turned out to be exactly
where the draft was wrong.

_This pass is an aid, not a warrant. It checked only claims the drafts state; implicit premises
are structurally outside what it can enumerate._

### 2026-07-27 — Adversarial panel (4 reviewers, skeptical calibration)

Four reviewers with distinct mandates — requirements, assumptions, failure & abuse, scope &
simpler design — run in parallel over `proposal.md` + `design.md` + both delta specs +
`tasks.md`. The panel prompt pointed at the fact-check log and explicitly preserved full
skeptical mandate, including re-verifying CONFIRMED items.

**Blockers/majors FIXED IN PLACE:**

- **The audit enumeration missed the bug it was fixing** (all four reviewers, independently).
  `grep 'apiFetch<'` → 45 excludes `fetchAdmin<AdminDataResponse>('admin/users', …)`, the
  crashing call, plus 6 untyped `apiFetch(…)` calls and ~5 raw `fetch(…).json() as X` sites.
  → D6 rewrites the universe as semantic; the spec forbids treating a count as completeness
  evidence.
- **Zod's default is *strip*, not passthrough** (assumptions + failure, both by executing
  zod 3.25.76). `.parse({a, extra})` → `{a}`. The draft's D4 forward-compatibility rationale
  was factually wrong, and `HomeSettingsModal.handleSave` round-trips fetched
  `studio_settings` into a replace-all `PUT` — so stripped fields would have been **destroyed
  server-side** on next save. → Moot under the gate ruling; recorded because it was a genuine
  data-loss path in the rejected design.
- **Schemas from the "emitted shape" would have killed the whole SPA.**
  `active_studio.categories[].dropdown_options` is emitted `string[]` but typed
  `DropdownOption[]` — true on a fresh install — and nothing reads it, so it is invisible today.
  A schema would reject `/api/profile`, and `RootGate` renders *"Couldn't reach the server"* on
  every route, misattributing a schema bug to the network. No error boundary exists anywhere in
  `web/src` (zero hits) and no kill switch was designed. → Moot under the ruling; the underlying
  **type mismatch is real** and is now a named expected audit finding requiring a type split.
- **The spec promised a build-time guarantee the design declined to buy** — `web-admin-users`
  said a mismatch "SHALL be a typecheck failure" while nothing delivered that. → Under the
  ruling the guarantee is now actually built (D3/D4); the requirement was still rewritten to
  state the property and delegate the mechanism.
- **"16 `OkResponse` sites are trivially safe" was false.** `transport/start` and
  `transport/stop` both `return c.json(state)`. → Claim deleted; recorded as an expected audit
  finding.
- **The mandated durable ledger was written to a git-ignored path.** → D9; ledger is tracked.
- **Unfalsifiable spec scenarios** (a `typecheck fails` scenario inexpressible under `z.infer`;
  an "optional field is tolerated" scenario that only asserted Zod implements `.optional()`;
  an anti-regression scenario defeated by the repo's own mocking idiom). → Removed or replaced
  with mechanically checkable properties.
- **Phase 1 declared "standalone shippable" while deferring its visual re-bless to phase 6**,
  leaving the branch red for four phases. → Re-bless moved into phase 1.
- **`StudioBrief {id, name}` already existed**; the draft invented `AdminUserStudio`. → Reuse.
- **Browser verification could pass vacuously** on a dev DB with no OAuth users (dev auth is
  anonymous; the crash needs ≥1 user). → Precondition stated in the task.
- **`SERVER-WRONG` was unreachable**, so the audit would have silently promoted emissions to
  contract. → D10.

**Escalated to the gate (owner decision):**

- **The scope itself.** The scope reviewer's bottom line: *"the chosen scope is wrong as
  currently justified"* — runtime validation detects no earlier than the status quo, both stated
  rationales are unsound, measured cost is +11.4% gzip on the shared main chunk, and it does not
  close the class it claims to. Per the disposition rule this conflicted with the owner's
  explicit selection of the largest scope option, so it was escalated rather than adopted or
  dismissed. **Gate decision (2026-07-27): ACCEPTED — swap the runtime-validation phases to
  captured-fixture contract checks plus a repo-invariant guard.** (Those were phases 2/4/5 in
  the *pre-gate* draft numbering; the rewritten plan of record numbers the replacement work as
  phases 3/4/5, with phase 2 retained as characterization tests.) D1 rewritten; D2–D5 replaced;
  the production-data-variance argument recorded as a named residual rather than built.

**Minors accepted as residual:**

- Runtime validation's one genuine advantage — production data variance — is not covered by any
  mechanism in this change. Recorded in D1 and the risk table.
- Mutation-response shape failures, react-query retry storms, unbounded `ZodError.message`
  (measured 908,892 chars on 5,000 issues), and Zod embedding received values in enum errors:
  all real findings against the rejected design, moot under the ruling. Recorded here so a
  future change that revisits runtime validation inherits them rather than rediscovering them.
- The `Category` type split (D-risk table) is real work whose consumer list is enumerated in
  tasks rather than discovered during implementation.
- `web/src/api/types.ts` remains a zero-runtime module under D4 — an incidental benefit of
  keeping hand-written interfaces that the `z.infer` design would have lost.

### 2026-07-27 — Post-gate consistency read (light tier)

One light-tier reviewer over all four artifacts after the gate reversal was folded back:
`proposal.md`, `design.md`, `specs/web-admin-users/spec.md`,
`specs/web-api-response-conformance/spec.md`, `tasks.md`.

**Not clean — three coherence findings, all fixed:**

1. **Migration Plan contradicted the tasks' phase dependencies.** It claimed per-phase revert
   "with no ordering constraint", but phase 5 consumes phase 4's fixtures and phase 4's set is
   chosen from phase 3's audit — reverting 4 alone breaks the build. Rewritten to separate the
   *operator-visible* claim (no revert regresses the running app — still true) from *build
   integrity*, and to state the real revert boundaries: 1 | 2 | 3 | 4+5.
2. **The gate-log entry said "swap phases 2/4/5"**, which no longer maps onto the rewritten plan
   (phase 2 is now characterization; the replacement work is 3/4/5). Annotated as pre-gate draft
   numbering with the final mapping stated.
3. **Phase 2 was the only phase with no anchor** to a decision or requirement. Anchored to D5,
   with its independent justification kept.

**Verified as correct, not findings:** stale Zod/`z.infer`/`apiJson`/`ApiShapeError` language
appears only in D1's alternatives, the Context, and this log — i.e. as recorded history of a
rejected option, never as forward-looking direction. The old capability name
`web-api-client-validation` appears nowhere. Requirement↔task coverage is complete in both
directions. Call-site counts re-checked against the live repo. Scenario headers all use exactly
four hashtags; every requirement carries ≥1 scenario; no should/may in normative text.
