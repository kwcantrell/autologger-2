# maximize-log-view — tasks

## Phase 1 — Preference + layout selection

- [ ] 1.1 Add browser-local preference module/hook (`default` | `maximize-log`,
      localStorage; invalid/missing → default) with unit tests for read/write/invalid
- [ ] 1.2 In `SessionWorkspace`, derive `displayedMaximize` from preference ∧ ¬rolling ∧
      ¬recording-lease; wire so force-default never writes preference
- [ ] 1.3 Component tests: preference persists across sessionId change while idle; rolling
      or recording forces default without clearing preference; returning to idle restores
      maximize-log

## Phase 2 — Fused strip + toggle

- [ ] 2.1 Build maximize-log fused strip (height ≈ 80% of `#timeline-clips`): timeline
      scrub surface + TimecodeDisplay + TransportControls + shortcuts `?` button (same
      dialog as Controls panel); omit default panel heads / marker-nav / session ID chrome

- [ ] 2.2 Conditionally render fused strip vs default `v5-session-panels` twin deck
- [ ] 2.3 Add trailing labeled control on the Feed tabs row (**Maximize log** /
      **Default view**); while rolling/recording and preference is default, non-actionable
      with keyboard-reachable reason
- [ ] 2.4 Tests for toggle labels, preference updates, and disabled reason while
      rolling/recording

## Phase 3 — Final gates

- [ ] 3.1 `npm run typecheck` + scoped/web vitest for touched files
- [ ] 3.2 `npm run e2e` (chromium + login-gate) and `npm run e2e:visual` — re-bless
      baselines only if this change legitimately alters captured chrome
