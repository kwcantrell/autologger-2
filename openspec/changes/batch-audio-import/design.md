# batch-audio-import — design

## Context

Batch Import chrome exists. Local folder audio → create missing sessions → attach
timeline audio. **Not** YouTube URL import; only shared server piece is
`anchorImportedTake` (same composite the YouTube route already calls).

Gate 2026-07-27 confirmed: rail placement/icon intent, empty→full modal, UI rules,
match episode|title, active-show switch, folder **name** display, close=abort+keep
commits, Import Logs no-op. Owner also accepted **easier-than-ffmpeg**: client Web
Audio stitch → WAV; thin single-blob server attach+anchor.

## Goals / Non-Goals

**Goals:** show-scoped folder import; match/create/skip; client stitch of `-N`
parts; one anchored take per group; progress; close resets UI without undoing
commits; no session navigation.

**Non-Goals:** Import Logs; ffmpeg; YouTube; list-by-show API; mutating matches.

## Decisions

### D1 — Client orchestrates; server attaches one take

Browser groups files, skip/create via existing `POST /api/sessions`, stitches when
needed, then calls local-audio-import with **one** blob. Progress UI is modal-local.

### D2 — No ffmpeg; client stitch + single-blob import endpoint (GATE)

**Choice:** Multi-file groups are decoded/concatenated in the browser (Web Audio API)
into a WAV blob, then uploaded once. Server
`POST /api/sessions/:sessionId/local-audio-import` accepts a single audio body
(Content-Type + raw bytes, same posture as `POST …/audio/segments`), probes duration
(or uses `Content-Duration` / query `duration_s` if probing is awkward — prefer
query `duration_s` from the client who already decoded), runs
`addAudioSegment` → put → `anchorImportedTake`, rolls back on failure.

**Rejected:** host ffmpeg stitch (ops burden; owner OK without it). mediabunny
server merge for MP3 groups (mediabunny families are Opus/AAC/PCM only).

### D3 — Session identity = filename stem (GATE)

Stem after extension + optional `-<digits>`. Match `episode === stem || title ===
stem`. Create with both set to stem; fps/offset from `new_session_defaults`.

### D4 — Close = reset UI + abort remainder; keep commits (GATE)

AbortController cancels in-flight upload and further groups. Completed work stays.
Reopen = fresh modal.

### D5 — No navigation; soft list refresh (GATE)

Never `navigate(/sessions/…)`. Invalidate `['sessions']` after creates.

### D6 — Import Logs stub (GATE)

Button only; no-op.

### D7 — Mime / extension map expansion

Map mpeg/mp3 → `.mp3`, aiff/x-aiff/aif → `.aiff` in `audioStore`.

### D8 — Rail icon (GATE)

Up-arrow on `#v6-btn-batch-import` and matching modal header icon.

### D9 — Folder picker (GATE)

`<input type="file" webkitdirectory multiple>`; label = top-level directory name
from `webkitRelativePath`.

### D10 — Active show align (GATE)

On Start, if `active_show_id !== selected`, `PUT /api/profile` then refetch
sessions (New Session pattern). No new list API.

### D11 — duration_s query on local-audio-import

Client supplies `duration_s` (from decoded AudioBuffer or single-file metadata
estimate). Server uses it for segment end timestamps + `anchorImportedTake`,
avoiding a mandatory server-side decode dependency for v1. Reject non-finite /
non-positive duration with `400 { detail }`. Reject values above
`LOCAL_AUDIO_IMPORT_MAX_DURATION_S` (86_400 s / 24 h) with `400 { detail }` —
keeps `Date` ISO timestamps and frame math representable. Require a non-empty
`Content-Type` header (`400 { detail }` when missing/blank).

## Risks / Trade-offs

- Browser codec support varies (AIFF may fail decode → per-group error line).
- 50 MB upload cap still applies to the stitched WAV (large multi-part episodes may
  fail that group).
- Web Audio decode loads files into memory — acceptable for operator batch sizes;
  document soft expectation in README.

## Migration / rollback

Additive endpoint + UI. Revert UI and route independently.

## Panel & review log

### 2026-07-27 — Gate (owner)

Confirmed all six escalations; clarified product is local-files only (not YouTube);
accepted no-ffmpeg / easier stitch.

**Fixed in place after gate:**
- Dropped ffmpeg/PATH/`FFMPEG_PATH` from proposal, design, specs, tasks.
- D2 → client Web Audio stitch + single-blob `local-audio-import` with `duration_s`.
- Explicit Non-Goal: YouTube/URL/yt-dlp; note that `anchorImportedTake` reuse is
  internal only.

**Escalated → decided:**
1. Stitch without ffmpeg (client) — accepted.
2. Match episode|title — accepted.
3. Active-show switch — accepted.
4. Folder name only — accepted.
5. Close abort+keep — accepted.
6. Import Logs no-op — accepted.

**Residual minors:** AIFF decode depends on browser; 50 MB stitched WAV cap.

### 2026-07-27 — Phase-2 fix-wave (review)

**Fixed in place:**
- Require non-empty `Content-Type` (`400 { detail }`); no `application/octet-stream`
  fallback.
- Cap `duration_s` at 86_400 s (24 h); reject above with stable `400 { detail }`.
- Integration tests for late rolling 409 rollback, anchor throw rollback, and 413
  oversize body.
- README endpoint inventory lists 413.

### 2026-07-27 — Whole-branch fix-wave (P1 retryability)

**Fixed in place:** Runner stitches before session create; import failure best-effort
`DELETE /api/sessions/:id` so failed groups stay retryable (no permanent skip).

Read proposal.md, design.md, tasks.md, specs/batch-audio-import/spec.md,
specs/api-contract-freeze/spec.md after ffmpeg removal. **Clean** — no remaining
ffmpeg/multi-part-server-stitch language; YouTube limited to internal anchor reuse
wording.
