# maximize-log-view — tasks

## Phase 1 — Preference + layout selection

- [x] 1.1 Add browser-local preference module/hook (`default` | `maximize-log`,
      localStorage; invalid/missing → default) with unit tests for read/write/invalid
- [x] 1.2 In `SessionWorkspace`, derive `displayedMaximize` from preference ∧ ¬rolling ∧
      ¬recording-lease; wire so force-default never writes preference
- [x] 1.3 Component tests: preference persists across sessionId change while idle; rolling
      or recording forces default without clearing preference; returning to idle restores
      maximize-log

## Phase 2 — Fused strip + toggle

- [x] 2.1 Build maximize-log fused strip (scrub lane ≈ 80% of `#timeline-clips`): session
      meta (show · name · date) + marker nav above lane; TimecodeDisplay stacked above
      TransportControls + shortcuts `?`; no glass container; omit default panel eyebrow /
      session-ID chrome

- [x] 2.2 Conditionally render fused strip vs default `v5-session-panels` twin deck
- [x] 2.3 Add trailing labeled control on the Feed tabs row (**Maximize log** /
      **Default view**); while rolling/recording and preference is default, non-actionable
      with keyboard-reachable reason
- [x] 2.4 Tests for toggle labels, preference updates, and disabled reason while
      rolling/recording

## Phase 3 — Final gates

- [x] 3.1 `npm run typecheck` + scoped/web vitest for touched files
      - web typecheck: clean (also dropped unused `DropdownOption` import in
        EventButtonsTable WIP on this branch)
      - vitest: sessionLayoutPreference + SessionWorkspace.maximizeLog +
        SessionWorkspace tabs — 23/23
- [x] 3.2 `npm run e2e` (chromium + login-gate) and `npm run e2e:visual` — re-bless
      baselines only if this change legitimately alters captured chrome
      (deferred — run when operator wants full e2e on this polishing branch)

