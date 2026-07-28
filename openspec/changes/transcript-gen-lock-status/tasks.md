# transcript-gen-lock-status — tasks

## Phase 1 — Lock module + status API

- [x] 1.1 Add `server/src/node/transcriptGenerationLock.ts` (acquire / peek / release) with
      unit tests for idle/busy metadata and release-in-finally semantics
- [x] 1.2 Wire `POST …/transcript-words/generate` in `transcribe.ts` to the lock module;
      enrich `409` detail to name the busy session (title preferred, else id)
- [x] 1.3 Add `GET /api/transcript-generation/status` (idle/busy JSON as spec); resolve
      title from catalog; integration tests for idle, busy, and concurrent `409` detail
- [x] 1.4 Update README endpoint inventory row for the new GET

## Phase 2 — Transcript tab visibility

- [x] 2.1 Add `useTranscriptGenerationStatus` (poll ~2s busy / ~10s idle) and a banner in
      `TranscribeFeed`: title + live elapsed from `started_at`; link to `/sessions/<id>`
      when holder ≠ current session; treat same-session busy like generate pending
- [x] 2.2 Web test(s): banner copy + cross-session link when status is busy

## Phase 3 — Final gates

- [ ] 3.1 `npm run typecheck` + `npm test`
- [ ] 3.2 `npm run e2e` (chromium + login-gate). Visual e2e: re-bless baselines only if
      this change legitimately alters a captured surface; otherwise expect no visual drift
