# sheets-log-import — design

## Context

Batch Import modal (batch-audio-import) can attach stitched audio. Operators also keep
logs in Google Sheets. Sheet clocks often drift from session audio; transcript text is
the alignment signal. Owner-approved Cursor plan (2026-07-28) locked decisions below.

## Goals / Non-Goals

**Goals:** public Sheets URL → server job → match tabs to `session.title` → ensure
transcript → scored per-seam sync → create events at corrected SMPTE → modal progress.

**Non-Goals:** Sheets OAuth; client sync; multi-blob playback; changing transcribe.csv.

## Decisions

### D1 — Public XLSX fetch (GATE)

Server fetches `https://docs.google.com/spreadsheets/d/{id}/export?format=xlsx` for
link-shared workbooks. Parse all sheets with `exceljs`. Fail clearly if not public /
unreachable. No new OAuth.

### D2 — Seam parts prerequisite (GATE)

`local-audio-import` persists `meta.audio_seam_parts_json`. Missing seams on a
multi-part mental model: single default part = full `duration_s`. Log import fails a
session when multi-offset sync is required but seams are absent/invalid (single-part
OK).

### D3 — Score-based sync (GATE)

Normalize tokens (lowercase, strip punctuation). Sliding window over transcript:

- Exact token +1.0; near (edit distance ≤1 or shared prefix ≥4) +0.7
- Keep candidates with ≥3 scored tokens
- Solid ≥ 4.5; Decent ≥ 2.5

Offset `O = transcript_time − sheet_time`. Sheet times parse as H:M:S or M:S at frame 0.

Part windows:

- `sheet_start_0 = 0`
- `sheet_end_i = sheet_start_i + D_i − O_i`
- `sheet_start_{i+1} = sheet_end_i + 1`

Part 0: require ≥1 solid; use earliest solid’s offset. Else fail.
Part i>0: decent+ candidates; if ≥2 and |ΔO| < 60s use earliest; if spread ≥60s fail;
if one solid use it; else fail.

### D4 — Event create-at-frames (contract)

New hub method `addEventAtTotalFrames` + job-internal use via
`POST /api/shows/:showId/log-import` (job) which creates events server-side.
Optional thin `POST …/events/import` bulk for the same shape if cleaner to test —
prefer **job-only creation** (no public create-at-time for arbitrary clients in v1)
to minimize frozen-surface growth: only job endpoints are published.

Published:

- `POST /api/shows/:showId/log-import` `{ spreadsheet_url }` → `{ job_id }`
- `GET /api/log-import/:jobId` → status + progress lines

### D5 — Category mapping (GATE)

OTHER required. Blank C → OTHER + message B. Unmatched → OTHER + `${B} - ${C}`.
DROPDOWN/ON_OFF match option labels; BUTTON/TEXT match category name; longest wins.
Message always full B (except unmatched append). Dropdown option → `metadata.import_option`.

### D6 — Duplicates (GATE)

Skip when existing non-internal event has same message and same `timecode_total_frames`
(exact frame match after import computation).

### D7 — Session match (GATE)

Show from Batch Import dropdown; `sheet.name.trim() === session.title.trim()`.
Unmatched sheets → progress skip, not whole-job fail.

### D8 — Transcript gate (GATE)

If words empty/untimed → call generate; on failure fail session. Do not sync without
timed words.

### D9 — Modal (GATE)

Import Logs → URL dialog. Start Import runs log job when URL set (and/or audio as today).
Poll job; progress + confidence; no navigation.

### D10 — Egress + spend gating (added 2026-08-03, PR #3 remediation)

The original artifacts specified an egress-bearing endpoint (docs.google.com
fetch, plus paid DeepGram generation when a transcript is missing) with no
configuration gate — a decision the delta silently omitted. Remediation aligns
the endpoint with the repo's sibling spend-per-request features
(youtube-import, topics/generate): POST is `503` unless
`SHEETS_LOG_IMPORT_ENABLED` is `1`/`true`/`yes`; when configured, the shared
open-network refusal predicate applies (`sheetsLogImportOpenNetworkRefused`,
`server/src/env.ts`), in the youtube-import ordering (membership 404 → config
gate → open-network refusal → body validation). The status GET stays ungated —
it reads only local in-process job state. POST is studio-membership-scoped
(uniform "Show not found." 404); GET is creator-scoped (uniform "Log import
job not found." 404); the job store prunes terminal jobs ~1h after finishing
and caps the map at 200 with running jobs never evicted.

## Risks

- Google export URL fragility
- Score threshold calibration (golden HD_385 tests)
- DeepGram cost/latency
- Dropdown option only in metadata (Event column shows category name)

## Panel & review log

### 2026-07-28 — Owner gate (Cursor plan approval)

Owner answered decision questionnaire and approved the scored-sync plan document
`sheets_log_import_fe78189b.plan.md`. Decisions D1–D9 match those answers.

**Escalated → decided:** public Sheets (A); seam metadata with stitch (B); score-based
sync; fail on no sync / ≥60s disagreement; offset sign confirmed; 0 frames; title match
from rail; skip duplicates; OTHER + append; type match rules; full col B; transcript
required; same modal; progress yes; separate OpenSpec; server-side.

**Residual minors accepted:** dropdown sub-option visibility via metadata only; score
thresholds tunable via golden tests.

### 2026-08-03 — Adversarial multi-agent review + owner gate (PR #3 remediation)

This change shipped on an owner-approved Cursor plan without the repo's
adversarial panel. A 25-agent adversarial review (6 dimensions, per-finding
adversarial verification) stood in for the skipped panel and found
strict-validation failures and post-gate behavior drift; the owner gated it
with "fix all these issues" — remediate on the PR branch. Dispositions in the
three-bucket style:

**Blockers/majors fixed in place (this change):**
- The POST endpoint had no egress/spend gate and no tenancy scope — added the
  `SHEETS_LOG_IMPORT_ENABLED` configuration gate (503 with an operator-actionable
  detail), the shared open-network refusal (503, youtube-import ordering), the
  uniform studio-membership 404 ("Show not found.") on POST, and creator
  scoping on the status GET (uniform "Log import job not found." 404) — see
  D10 and `server/src/routers/logImport.ts`.
- The in-memory job map grew without bound — terminal jobs now prune ~1h after
  finishing and the map is capped at 200 entries, evicting oldest terminal
  first and never evicting queued/running jobs
  (`server/src/logImport/jobStore.ts`).
- The delta specs omitted all of the above, and two ADDED requirements
  ("Transcript required before sync", "Duplicate skip") had no scenarios, so
  `openspec validate sheets-log-import --strict` failed — scenarios written
  from the shipped behavior (`runSessionLogImport.ts`) and the gating/scope/
  lifecycle requirements added in this remediation; strict validation now
  passes.

**Escalated → decided (owner):** remediate everything on the PR branch rather
than revert — "fix all these issues".

**Residual minors accepted:**
- `exceljs`'s transitive `unzipper`/`fstream` chain parses the downloaded
  workbook bytes. Mitigations in place: the fetch is host-pinned to
  `docs.google.com` export URLs, HTML interstitials are rejected, and the
  buffer must carry the XLSX PK zip magic before parsing
  (`server/src/logImport/sheetsFetch.ts`). A parser swap is a roadmap
  candidate.

### 2026-08-03 — Post-amendment consistency read: clean

Light-tier read over the final four artifacts of all three PR-3 changes
(proposal, spec deltas, design, tasks) after the remediation amendments: no
stale pre-decision language, no disposition-vs-normative contradictions, no
broken cross-references; cited commit hashes and load-bearing symbol/constant
claims spot-verified against the branch; strict validation passing for all
three changes.
