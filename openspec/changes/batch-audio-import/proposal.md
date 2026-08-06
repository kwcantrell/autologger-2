# batch-audio-import — proposal

## Why

Operators already have episode audio on disk (often one file per episode, sometimes
split as `Name-1.mp3` / `Name-2.mp3`). Creating a session and attaching audio one-by-one
is slow. The rail already has a Batch Import chrome shell; this change fills it with a
show-scoped **local-folder** import that creates missing sessions, stitches multi-segment
clips in the browser, uploads audio onto each session timeline, and reports progress —
without navigating into those sessions during the run.

This is **not** YouTube import. No URLs, no yt-dlp. Local files only. (Server attach
reuses the same internal `anchorImportedTake` composite YouTube already uses, so the
timeline gets a proper Recording take — that is the only shared machinery.)

## What Changes

### Web (Batch Import modal + rail icon)

- Rail **Batch Import** control uses an **up-arrow** (upload) icon.
- `BatchImportModal` gains:
  - **Show** dropdown matching New Session's show picker.
  - **Import Audio** — directory picker; folder **name** shown under the button
    (browsers cannot expose `C:\…` absolute paths).
  - **Import Logs** — present, no-op.
  - **Start Import** — runs the audio batch against the selected show + folder.
  - **Progress panel** under Start Import; stays until the modal is closed.
- Closing the modal **resets UI state** and **aborts** remaining groups. Already
  committed sessions/audio remain. Never navigates to created sessions; invalidates
  the sessions list so the rail updates quietly.
- If the dropdown show ≠ profile active show, Start Import **switches active show**
  via existing profile PUT (same as New Session) before listing/matching.

### Import semantics (audio) — client orchestration

- Read audio files from the chosen folder (files from the directory picker).
- Supported extensions: `.mp3`, `.wav`, `.aiff`/`.aif`, `.m4a`, `.mp4`, `.ogg`,
  `.webm` (case-insensitive).
- Group by **base name**: strip extension, then strip trailing `-<digits>`
  (`YMH_001-1.mp3` + `YMH_001-2.mp3` → `YMH_001`).
- Match: any session for that show with `episode` **or** `title` equal to the base
  name → **skip**. Else create with `episode` and `title` = base name (fps/offset
  from profile defaults).
- **Stitch** multi-file groups in the **browser** (Web Audio decode → concatenate →
  WAV). No ffmpeg. Single-file groups upload as-is when the MIME is already
  attachable; otherwise decode→WAV as needed for a reliable attach.
  *(Amended 2026-08-03: as shipped, single-file groups ALWAYS pass the original
  bytes through — duration comes from media-element metadata, never a PCM
  decode, which OOMs on long MP3s — and multi-file stitching is pre-flight
  capped at 150 MB of summed input; see design.md Panel & review log.)*
- Upload the resulting blob to the new local-audio-import endpoint (attach + anchor
  one take).

### Server

- Expand blob extension mapping for mp3/mpeg and aiff/aif (do not false-map to
  `.webm`).
- Add `POST /api/sessions/:sessionId/local-audio-import`: **one** audio body (raw or
  single multipart part), probe/accept duration, `addAudioSegment` → put →
  `anchorImportedTake`, YouTube-style rollback. **No ffmpeg**, no multi-file server
  stitch.

## Capabilities

### New Capabilities

- `batch-audio-import`: Batch Import UI, folder selection, show-scoped match/create/
  skip, client-side multi-segment naming/stitch, progress/close semantics, and the
  local-audio single-blob attach+anchor path.

### Modified Capabilities

- `api-contract-freeze`: delta for `POST …/local-audio-import` (`200 { ok: true }` and
  failure `{ detail }` matrix). Existing create-session and raw segment POST shapes
  unchanged.

## Impact

- **Web**: modal, rail icon, client stitch/group helpers, progress runner, tests.
- **Server**: mime map; new local-audio-import router; README inventory; tests.
- **Contract**: yes — one new endpoint.
- **Ops**: none beyond existing Node deploy (no ffmpeg requirement).

## Non-Goals

- Import Logs behavior (button only).
- YouTube / URL / yt-dlp paths.
- ffmpeg (host or wasm).
- Opening created sessions during/after import.
- Mutating sessions that already match (skip only).
- Changing New Session modal behavior.
- New session-list-by-show API (use active-show switch instead).
