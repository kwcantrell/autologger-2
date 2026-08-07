# recent-sessions-single-poll — tasks

> PROVISIONAL until panel + gate.

## 1. Web

- [ ] 1.1 RecentSessionsList SessionCard: status-query gate `isActive ? s.id :
      null`; badge/timecode derivation per design D2 (background cards from
      row fields only). Update the file's comment block to the new rationale.
- [ ] 1.2 Tests (RecentSessionsList.test.tsx): background rolling card shows
      live badge + list-derived `HH:MM:SS` timecode with the hook receiving
      `null` (query disabled — no fetch of the background session's status
      URL; the hook itself is always called per rules-of-hooks); zero-open-
      session case (`activeSessionId: ''`, rolling cards → no status
      subscription anywhere); open rolling card still uses the shared status
      query; non-rolling cards unchanged.

## 2. Final gates

- [ ] 2.1 `npm run typecheck`, `npm test`, `npm run lint`, `npm run e2e`;
      run `npm run e2e:visual` — any diff other than a background rolling
      card's timecode format is a defect, not a re-bless (no current visual
      fixture shows a background rolling card, so expect zero diffs).
- [ ] 2.2 At archive: touch the web-home-launch Purpose line to cover rail
      session cards so the ADDED requirement sits inside its capability
      header.
