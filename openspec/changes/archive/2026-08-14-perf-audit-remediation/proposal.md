# Proposal: perf-audit-remediation

> **Retroactive record.** The work described here was implemented and merged to `main` before
> this change existed (branch `perf-fixes`, 35 commits, merged at `64593f7` on 2026-08-14), at
> the repo owner's explicit direction to bypass OpenSpec for the duration of that session. This
> change is written *after* the fact. It has not been through the adversarial panel or the
> spec-review gate, and it must not be read as though it had. Its purpose is to make the
> baseline true again, to supply the authorizing delta the frozen contract requires, and to
> record — in the same place — what the shipped implementation did **not** close.

## Why

A measured performance audit of the production build found the session workspace shipping
~5.3 MB of API payload per open, a 0.123 CLS on every session load, ~937 KB of JavaScript on a
homepage that cannot reach most of it, and a render cascade that put the whole workspace subtree
on the animation-frame path during audio playback. Remediation shipped in two phases: an
**implementation phase** of five dispatch waves, then a **review phase** of seven `/code-review`
rounds, each round followed by its own fix wave. Findings by round: 10 → 10 → 10 → 3 → 3 → 2 → 2.

Measured outcomes on the production build, same session data before and after:

| | before | after |
| --- | --- | --- |
| Session-open API transfer | ~5.3 MB | 172 KB |
| `transcript-words` | 4.15 MB, fetched at open | deferred; 614 KB gzip when first needed |
| `GET /api/profile` | 52 KB | 1.4 KB on the wire |
| Session page CLS | 0.123 (one 0.122 shift ~600 ms in) | 0.001 |
| Homepage JS — island chunk set | 581,762 B | 218,401 B |
| Homepage JS — total (shell + island) | 936,699 B | 573,544 B |
| Event feed DOM rows (66-event session) | 66 | 18 |
| Long tasks during playback | cascade re-render each frame | 0 |
| Font transfer | 3 byte-identical Inter faces | 1 preloaded variable face (−94 KB) |

Two problems then compound: the baseline is now false in ~11 capabilities, and
`api-contract-freeze`'s own scenario "Contract-affecting diff carries an authorizing delta spec"
(`openspec/specs/api-contract-freeze/spec.md:35-39` — *"a diff without one is a contract
violation"*) is **currently failing**, not merely stale. This change cures both.

## What Changes

### Observable HTTP contract impact — six changes, all already shipped

The freeze requires these to be enumerated explicitly. Each is authorized by the
`api-contract-freeze` delta in this change:

1. **`Content-Encoding: gzip` on `/api/*`** for compressible types over 1 KB, plus
   **`Vary: Accept-Encoding` on every negotiation-eligible `/api/*` response** (including
   identity ones, so shared caches cannot serve gzip bytes to a non-gzip client). Audio byte
   serving, SSE, and WS upgrades are excluded structurally, not by enumeration.
2. **New route `GET /api/shows/:showId`** → `{ show }`, with unknown-id and not-a-member
   returning an identical `404` so the route is not an existence oracle.
3. **`transcript-words` wire shape trimmed** — every word loses `session_id` and
   `created_at_utc`; `start_sec`/`end_sec` round to 3 decimals. Applies to the GET list, the
   generate `200`, the create `201`, and the PATCH response.
4. **`GET /api/profile` `shows[]` slimmed** to `{id, studio_id, name, show_code, title_suffix}`.
   Full show config moved to `GET /api/shows?studio_id=` and the new by-id route.
5. **`POST …/audio/segments/sync-from-disk`** no longer returns `segments[]`; the body is now
   `{inserted, updated, scanned, has_audio}` (~349 KB → ~80 B).
6. **Audio `Content-Type` is clamped** on store and on serve: any type matching the `/api/*`
   compression filter degrades to `audio/webm`; everything else is stored and served verbatim.
   This is what makes exclusion (1) structural — a mislabelled segment cannot have its `206`
   range response gzipped out from under its `Content-Range`.

### Web behavior — new, previously unspecified

Route-splitting the client island behind `React.lazy` with a chunk-load error boundary; event-feed
virtualization; a shared inline-edit draft store spanning both virtualized feeds; a sticky
per-session gate deferring the transcript-words fetch; a memoization tier containing the playback
tick; queue-scoped `beforeunload` attachment (restoring bfcache eligibility); a Web Worker clock
for presence heartbeats; font consolidation and preload.

### Baseline corrections

Delta specs for: `api-contract-freeze`, `transcript-generation`, `auto-event-generation`,
`session-title-suffix`, `web-ui-system`, `web-coordination-seam`, `web-session-routing`,
`web-session-console`, `web-frontend-platform`, `live-recording-chunks`, `web-home-launch`.

### Supersedes `web-boot-split-boundaries`

That draft proposed exactly the bundle split that shipped — the same six boundaries, and it
predicted the `TeamsRoute`-pinning defect (`OnboardingPanel` statically importing `CreateTeamForm`
from `TeamsRoute`) that the implementation independently rediscovered and fixed. Its predicted
byte table was close on the "before" figure (578,258 B predicted vs 581,762 B measured, 0.6%) and
optimistic on the "after" (227,295 B predicted vs 218,401 B measured — the split did ~4% better
than the scratch build suggested). Its panel's risk list is carried forward here as verification evidence
rather than discarded. It is archived as superseded by this change.

## What shipped did NOT close

Recorded here rather than in a follow-up nobody reads. Verified against the shipped tree, not
assumed:

- **No busy affordance on an invoking control during a cold chunk fetch.** The panel prescribed
  "`null` fallback *plus* a busy affordance"; only the first half shipped. Clicking New Session or
  Batch Import on a cold chunk produces nothing on screen for the duration of the fetch — on
  mobile the rail closes first, so the tap reads as consumed and discarded. Only 2 of 6 boundaries
  are warmed (settings at 2.5 s idle, workspace on route entry).
- **No cancellation across the async gap.** A pending overlay can land after the user has
  navigated away. For the settings modal, surviving a route change is an asserted invariant; for
  the other three it is simply unhandled.
- **`WorkspaceStatic` still has no characterization test.** The seam was reshaped entirely from
  its consumer side, and every test that touches it mocks it away, so the real `memo()` is
  exercised nowhere. The rule this violates is the generic one in `openspec/config.yaml`'s
  `specs` rules ("Any seam without covering tests gets a characterization test before it is
  reshaped"), which the superseded draft's panel invoked for this exact component. It is *not* a
  violation of `core-ports-architecture`'s capability-level requirement of the same name — that
  one scopes characterization to server-contract output (status codes, JSON shapes, broadcast
  emission), so no baseline scenario is left failing by this gap.
- **The bundle measurement is not reproducible or guarded.** The number moved, which proves the
  blind instrument (Next's First Load JS table) was not the one used — but no script, artifact, or
  regression guard records the island chunk set.
- **`POST …/audio/segments/sync-from-disk` has no captured fixture** while the client now consumes
  its body with a typed `apiFetch`, carried by an exemption whose stated premise ("the shape lands
  in a parallel workstream") expired when that shape reached `main`.

## Non-Goals

- Fixing the five items above. They are recorded, tasked, and left for a follow-up change; this
  one is the record, not the remediation of the remediation.
- Retro-fitting a panel or gate onto work that shipped without one. The bypass was an explicit
  owner decision and is documented as such, not laundered.
- The three deferred refactors the review loop raised and the owner deferred: extracting a shared
  feed virtualizer, unifying the two hand-rolled sticky words latches, and moving the playback
  tick to an external store (measurement showed the last is unnecessary — zero long tasks
  without it).
- `useProfile` has no failure or paused branch in the settings modal, and react-query pauses
  *mutations* offline too, so Save can hang indefinitely on "Saving…". Both are pre-existing,
  both were surfaced during the review loop, and both are out of scope here.
