# transcript-gen-lock-status — design

## Context

On `main`, process-wide single-flight lives as `generationInFlight: boolean` in
`server/src/routers/transcribe.ts` (design D9 from deepgram-transcription). The shared
`generateTranscriptWords` helper may exist on other feature branches; this change puts
lock state behind a small exported module so any future caller (HTTP generate, log import)
shares one source of truth.

## Decisions

### D1 — Dedicated lock module
**Choice:** `server/src/node/transcriptGenerationLock.ts` with acquire/tryPeek/release
(or set-on-acquire + clear-in-finally helpers) holding `{ sessionId, startedAtMs }`.
**Alternatives:** keep the boolean in `transcribe.ts` only — rejected (harder for other
callers; status route would reach into the router module). Module-level map per session —
rejected (spec remains process-wide single slot).

### D2 — Status endpoint path
**Choice:** `GET /api/transcript-generation/status` (deployment-scoped, not under
`:sessionId`).
**Alternatives:** piggyback on `GET …/transcript-words` — rejected (wrong shape; cannot
describe another session cleanly). Session-scoped status — rejected (operators need to
see the lock from *any* Transcript tab).

### D3 — Title resolution at read time
**Choice:** look up catalog session title when serving status / building `409` detail.
**Alternatives:** store title at acquire — rejected (stale if renamed mid-run; rare but
cheap to re-read).

### D4 — Elapsed time client-side
**Choice:** server returns `started_at` ISO; client formats elapsed with a 1s tick.
**Alternatives:** server returns `elapsed_sec` refreshed on poll only — rejected (banner
would jump every 2s).

### D5 — Cross-session link
**Choice:** when busy `session_id !==` current feed session, show a link to
`/sessions/<id>`.
**Alternatives:** title-only — weaker for navigation.

### D6 — Enrich `409` detail, keep string envelope
**Choice:** detail like
`A transcript generation run is already in progress for session “HD_384” (started …); try again once it completes.`
(title preferred; fall back to id). Status remains `409`, body remains `{detail}`.
**Alternatives:** structured JSON error body — rejected (frozen `{detail}` envelope;
clients read `err.message`).

## Implementation sketch

1. Lock module: `tryAcquire(sessionId) → boolean`, `getLock() → null | {sessionId,startedAtMs}`,
   `release()` (or acquire that throws / returns occupied holder).
2. `transcribe.ts` generate path uses the module; status GET mounted on same router
   (or tiny adjacent route file routed from `app.ts`).
3. Web: `useTranscriptGenerationStatus` query with dynamic `refetchInterval`; banner in
   `TranscribeFeed` toolbar region.

## Invariants (do not undo)

- Process-wide single slot (not per-session concurrency).
- Lock cleared in `finally` so it cannot wedge across requests.
- Hub RPCs stay synchronous; status read does not touch SessionHub for the busy session’s
  DB — catalog title only.

## Panel & review log

### 2026-07-28 — Pre-panel fact-check (light-tier)

| Claim | Property verified | Method / evidence | Verdict |
|---|---|---|---|
| Process-wide boolean lock in generate path | `generationInFlight` gates concurrent generate with `409` | Read `transcribe.ts` acquire/finally around POST generate | CONFIRMED |
| `409` detail is fixed generic string | Concurrent path throws `GENERATION_IN_FLIGHT_DETAIL` constant | Same file | CONFIRMED |
| No status endpoint today | No `transcript-generation/status` route | Grep `server/src` + README endpoint table | CONFIRMED |
| TranscribeFeed only learns lock via generate mutation error | `useGatedGenerate` sets `genError` from non-503 errors; no status poll | Read `useGatedGenerate.ts`, `TranscribeFeed.tsx`, `useTranscriptWords.ts` | CONFIRMED |
| DeepGram run can last ~11 min | `PROVIDER_TIMEOUT_MS = 11 * 60 * 1000` | Read `deepgram.ts` | CONFIRMED |

Judgment left unverified for panel: exact banner copy wording; poll intervals.

### 2026-07-28 — Gate

Owner approved Cursor plan “Transcript lock visibility” (approach locked: status GET,
enriched 409, TranscribeFeed banner with title + elapsed + cross-session link). Treated
as human gate for this change — panel mandates preserved for residual review at apply.

**Escalated → decided:**
- Cross-session link: **yes** (plan D / gate).
- Poll cadence: **~2s busy / ~10s idle** (plan).

**Blockers/majors fixed in place:** none (plan already matched codebase).

**Minors accepted as residual:** exact English for status line / 409 detail left to
implementer within the MUST-name-session rule.

### 2026-07-28 — Post-gate consistency read

Clean — `proposal.md`, `design.md`, `specs/transcript-generation/spec.md`,
`specs/api-contract-freeze/spec.md`, `tasks.md` agree on endpoint path, idle/busy shapes,
409 string enrichment (not structured body), and UI polling/banner behavior.

### 2026-08-03 — Adversarial multi-agent review + owner gate (PR #3 remediation)

This change shipped with a Cursor-plan gate standing in for the repo's
adversarial panel. A 25-agent adversarial review (6 dimensions, per-finding
adversarial verification) stood in for the skipped panel and found post-gate
behavior drift on the PR branch; the owner gated it with "fix all these
issues" — remediate on the PR branch. Dispositions in the three-bucket style:

**Blockers/majors fixed in place (this change):**
- Cross-tenant leak: the process-wide lock meant the status endpoint and the
  enriched 409 named a session (id + title) that could belong to a studio the
  requester is not a member of — the very existence/title oracle sibling
  routes close by 404ing non-members. Fixed by redaction
  (`requesterCanViewSession` in `server/src/routers/transcribe.ts`): busy
  status nulls `session_id`/`session_title` (same key set) for logged-in
  non-members, and the 409 falls back to the identifier-free
  `GENERATION_IN_FLIGHT_DETAIL` for non-members and the released-in-race case.
  Dev-anonymous (`user === null`) sees everything, sibling-route parity.
  Both delta specs amended to authorize the shipped shapes.
- Release-on-failure of the lock was asserted but unproven — now covered by
  tests (commit 0e600cc's "prove release-on-failure" wave).

**Escalated → decided (owner):** remediate on the PR branch rather than
revert — "fix all these issues".

**Residual minors accepted:**
- Process residual: the PR branch also carried an unspec'd client-side
  transcript-CSV-export feature on the Transcript tab (commit 9001ff9),
  accepted as shipped — client-only, not contract-bearing; recorded here
  because this change owns the Transcript-tab surface. Future feature work of
  that kind goes through OpenSpec.
- `openspec validate transcript-gen-lock-status --strict` passed before and
  after the remediation amendments (this was the one change of the three that
  did not fail strict validation).

### 2026-08-03 — Post-amendment consistency read: clean

Light-tier read over the final four artifacts of all three PR-3 changes
(proposal, spec deltas, design, tasks) after the remediation amendments: no
stale pre-decision language, no disposition-vs-normative contradictions, no
broken cross-references; cited commit hashes and load-bearing symbol/constant
claims spot-verified against the branch; strict validation passing for all
three changes.
