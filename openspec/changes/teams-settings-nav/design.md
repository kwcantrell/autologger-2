# teams-settings-nav — design

## Context

Two client-side defects shipped with the teams work. (1) `AppShell` swaps `SessionRoute`
out for `TeamsRoute` on `/teams`, but `HomeSettingsModal` is mounted by
`SessionRoute`/`WorkspaceStatic` — so the rail's Settings button flips `showSettings`
state that nothing consumes; worse, the flag and the mount can desynchronize (open the
modal, Back to `/teams` → modal unmounts, flag stays `true`, button plays dead, modal
surprise-reopens on the next navigation to `/`). Nothing on `/teams` navigates to the
no-session home view. (2) Settings saves 400 with "Each category needs a name." — a
**two-sided** field mismatch: `profile.shows[].categories` is served as raw stored
`CategoryRecord`s (key `name`; `showApiDict` → `categoriesListFromShowRow` passthrough),
while the client hydrates drafts with `c.label ?? ''` (blank names — enshrined in the
blessed visual snapshot) and posts `label:` back to a validator that requires `name`.
The web `Category` type hard-requires `label`, so the payload fix alone fails typecheck.
All changes are in `web/`; the server is untouched.

## Goals / Non-Goals

**Goals:** Settings opens on every route with flag/mount permanently in sync; `/teams`
has an explicit way back to `/` in every rendered state; settings saves round-trip
correctly (hydrate and save); the un-deadened save path doesn't serve stale category
buttons; regression tests that would actually have caught each bug.

**Non-Goals:** server-side changes of any kind; rail redesign / Home rail item /
active-route highlighting; any settings-modal tab or save-semantics change beyond the
`activeTab` reset noted in D1.

## Decisions

### D1 — Lift `HomeSettingsModal` to `AppShell`
The modal is profile-scoped (verified: props are exactly `isOpen/onClose/onCloseSession`;
hooks are profile/global; the `Home_reloadSessionList` global it calls is set by AppShell
itself; the debug-tab perf mount is already inert). `AppShell` renders it once beside the
route switch; `SessionRoute`/`WorkspaceStatic` drop the mount and the full dead prop set
(`showSettings`, `onCloseSettings`, **and `onCloseSession`** — its only consumer there is
the modal). `WorkspaceStatic` then reduces to a `memo` wrapper over `SessionWorkspace`;
it is deliberately kept (render-isolation memo) — recorded deferral, not an oversight.
**Rationale:** a route-branch-coupled mount is the bug class itself — every future route
branch would have to remember to replicate it — and the lift is net-negative LOC while
making flag/mount desync structurally impossible.
**Alternatives:** (a) also mount inside `TeamsRoute` — rejected: perpetuates the
route-coupled-mount bug class (the panel corrected an earlier draft's wrong
"double-render/focus-trap" rationale: the route switch is exclusive, so simultaneous
mounts can't occur — the real defect is the pattern); (b) navigate to `/` before opening
settings — rejected: surprising context loss.
**Behavior deltas owned deliberately:** the modal now survives route changes while open
(spec scenario pins it); the reset-on-open effect still fires (keyed on `isOpen`, not
mount) so drafts reset per open, and `activeTab` is added to that reset so reopens start
on General as before (previously guaranteed by unmount). The modal also mounts (closed)
during the brief profile-loading window before `needsOnboarding` resolves — harmless
(`isOpen` false, handlers guard `!profile`), pinned by test.
**Test-mock rework this forces (not additive assertions):** `AppShell.test.tsx` mocks the
profile-hooks module with only `useProfile` — post-lift the real modal renders and pulls
`useProfileMutation`/`useCreateShow` from that module, so AppShell tests must either mock
`HomeSettingsModal` or extend the module mock; and the studio-switch pin currently runs
through a fake button in a mocked `SessionRoute` and must be rewired to the AppShell-level
modal without weakening the `web-session-routing` "Studio-switch close path" scenario.

### D2 — Page-level "Back to sessions" affordance on `/teams`
One shared control inside the stable `#teams-route-placeholder` container (not one per
branch), present in both the signed-in and signed-in-required states, calling
`navigate('/')` via the shared navigation wrapper — the idiom `SessionRoute`'s
not-found/error states already use. Rapid double-clicks are safe by construction (the
first navigate unmounts the control), matching the existing pattern.
**Alternatives:** (a) Home item in the rail — more surface, duplicates what session links
already do, higher blast radius in shared chrome; (b) make the rail's Teams button a
toggle — hidden, undiscoverable. **Gate decision 2026-07-14:** the rail's Teams button stacks duplicate `/teams` history
entries when clicked while already on `/teams` (deadening browser Back); the one-line
same-route guard rides along in this change — same idiom as the session-select dedupe.

### D3 — Fix the category round-trip client-side, both directions
The frozen wire truth (verbatim Python-ported behavior): `showApiDict` serves
`shows[].categories` as stored `name`-keyed records; the update validator requires
`name`; only the events/Companion/`active_studio` shapes serve `label`. Fix: hydrate with
`c.name ?? c.label ?? ''` in `showToShowDraft` **and** `EventButtonsTable.copyFromShow`
(both currently read `label` from a `name`-keyed payload); send `name:` in `handleSave`;
split the request/`shows[].categories` category type from the `label`-keyed read type in
`web/src/api/types.ts` (typecheck otherwise rejects the fix, and "fixing" the shared
`Category` type would mis-type the legitimate `label` read sites). The `label` fallback in
hydration is deliberate: it keeps the modal correct even against the `label`-keyed shapes
should they ever feed it.
**Test-fixture rule (how this bug survived):** regression fixtures MUST mirror the real
`name`-keyed wire shape — the existing type-derived `label` fixtures pass against broken
code; an e2e save round-trip through the real server is required; the blessed visual
snapshot (which currently enshrines blank name inputs) is re-blessed.
**Alternative:** server accepts `label ?? name`, or `showApiDict` shapes to `label` —
rejected: both widen/change the frozen contract (needs a delta) to preserve a client bug.

### D4 — Invalidate `['show-categories']` on save
`handleSave` invalidates `['events']`/`['session-status']`/sessions but not
`['show-categories', sessionId]` (staleTime 30 s; nothing in `web/src` ever invalidates
it) — unobservable while saves always failed, user-visible the moment they succeed
(deleted/renamed buttons keep rendering; pressing a deleted one logs against an orphaned
category id). One `invalidateQueries({ queryKey: ['show-categories'] })` plus a test pin.

## Risks / Trade-offs

- [Un-deadened write paths resurface long-dead behaviors] → accepted at gate 2026-07-14
  (see Gate decisions 2): active-show flip on save ("Show to edit" selector doubles as
  active-show setter), settings-blob-persists-before-show_updates ordering on validation
  failure, stale-draft last-write-wins between concurrent editors. All pre-existing
  frozen semantics; none newly built here.
- [AppShell test rework could silently weaken the studio-switch pin] → named explicitly
  in D1 and tasks; the pin must assert the same observable (save with studio change on
  `/sessions/:id` → navigate `/`).
- [Visual snapshot re-bless could mask other drift] → re-bless is scoped to the settings
  modal snapshot, reviewed in the diff.

## Migration Plan

None — client-only bug fixes; ship together on one branch.

## Gate decisions

1. **Rail Teams-button same-route guard** (D2): DECIDED 2026-07-14 — include the
   one-line guard.
2. **Accepted resurrected behaviors** (Risks): DECIDED 2026-07-14, after a detailed
   walkthrough — all three pre-existing save behaviors are accepted as-is, no code:
   active-show flip on save (the "Show to edit" selector doubles as the active-show
   picker; the cheap conditional-send guard was considered and declined to keep this
   change scoped to the two reported bugs), settings-blob-before-shows persist ordering
   on validation failure (rare post-fix; all-or-nothing needs a freeze delta), and
   stale-draft last-write-wins between concurrent editors (inherent to the versionless
   PUT-whole-show contract; mostly single-operator deployments).

## Panel & review log

**2026-07-14 — adversarial panel (4 reviewers: requirements, assumptions,
failure & abuse, scope) over proposal + spec + design.**

*Blockers/majors fixed in place:*
- Root cause was incomplete (outbound-key-only): `shows[].categories` is served
  `name`-keyed verbatim, so hydration blanks every existing category name (proven by the
  blessed visual snapshot) and the one-word fix would re-ship the same 400; the web
  `Category` type would also reject the fix at typecheck → D3 rewritten to fix both
  directions + type split + wire-accurate fixtures + e2e round-trip + snapshot re-bless.
  (One reviewer's contrary claim that `showApiDict` shapes via `showCategoriesApiShape`
  was checked against source and is wrong — `showsStore.ts` passes stored JSON through.)
- `['show-categories']` never invalidated — stale/deleted buttons once saves work → D4
  added.
- Back affordance normatively covered only the signed-in state (the "no open session"
  scenario qualifier was vacuous) → spec scenario now enumerates both states.
- Modal-lifecycle change ("survives route change") contradicted the proposal's
  "semantics unchanged" claim and was unpinned; `activeTab` never resets once the
  component stops unmounting → proposal/design own the delta; spec scenario pins it;
  `activeTab` added to the reset-on-open effect. (Bonus: the lift *fixes* the latent
  flag/mount desync — recorded as rationale.)
- D1's rejection rationale for the double-mount alternative was factually wrong
  (exclusive route switch → no double-render possible) → rewritten to the real reason
  (route-coupled mount is the bug class; net-deletes code).
- Deletion scope under-counted (`onCloseSession` threading also dies; `WorkspaceStatic`
  reduces to a bare memo wrapper) → D1 scopes the full deletion; wrapper kept as a
  recorded deferral.
- "Existing tests run as the gate" understated: `AppShell.test.tsx`'s module mock breaks
  under the lift and the studio-switch pin runs through a mocked SessionRoute → rework
  named in D1/tasks.
- Spec leaked mount topology into normative text → parenthetical removed; observable
  behavior only.

*Escalated to the gate (decided 2026-07-14 — see "Gate decisions" above):* rail
Teams-button same-route guard (included); the three resurrected save behaviors
(all accepted as-is after walkthrough, including declining the conditional
`active_show_id` send).

*Minors accepted as residual:* "Saved." toast is the only feedback for a studio switch
performed from `/teams` (no navigation by design); dropdown *options* accept
`label ?? name` server-side so only the top-level key changes; proposal's "dead end"
framing softened (session links do leave `/teams`; the home view was the unreachable
part); modal mounts closed during the profile-loading window (guarded, test-pinned).
