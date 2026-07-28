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
