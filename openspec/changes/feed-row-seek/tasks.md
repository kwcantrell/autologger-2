# feed-row-seek — Tasks (plan of record)

> Gated 2026-07-26 across three rounds: adversarial panel (4 reviewers), post-gate consistency
> read, and focused review of D2 + D3 (2 reviewers). Eight gate decisions are recorded in
> `design.md` → Panel & review log — four from the panel round, four from the focused round, one of
> which reversed an earlier one. Both consistency reads have run and their outcomes are recorded.
>
> `file:line`-free by design — locate every quoted symbol by content before editing.
> Every task is gated by `npm run typecheck` + `npm test` before its commit.

## 1. Characterize the seam before reshaping it

- [x] 1.1 Add `MarkerNav.test.tsx` — characterization of the existing prev/next jump, no source
      change: each button issues `AutoLogger_setManualScrubSec`, `AutoLogger_scrollTimelineToSec`,
      and `AutoLogger_seekAudio` with the same grouped-marker second; it fires **while rolling**
      (ungated); it issues the audio seek **unconditionally**, with no clip-coverage check; it
      **never starts playback**; and the buttons are disabled when no markers exist. All four
      properties are normative in the spec — this is the baseline phase 9 must not move.

## 2. Frame-arithmetic session-time converter (the correctness core)

- [x] 2.1 Write failing tests for a new converter (design D3). Cover: at **23.976 fps**,
      `00:59:56:10` resolves to ≈3600.0 s and NOT ≈3596.4 s — assert the ~3.6 s divergence so a
      literal-seconds implementation fails; same at 29.97 and 59.94; integer rates where both agree;
      **a 119.88 fps frame field ≥ 100 (three digits) parses**; `ff >= Math.round(fps)` is
      **rejected** (`00:00:00:99` at 24 fps must NOT yield 4.125 s); minutes/seconds > 59 rejected;
      `H:MM:SS` accepted; **`MM:SS` rejected** (ambiguous with `HH:MM` — a 19,470 s error);
      `HH:MM:SS` parses with zero frames; empty/garbage yields "no position", never `0`.
- [x] 2.2 Add a round-trip test against `renderSmpte`'s construction
      (`formatSmpte(fromTotalFrames(round(sec*fps), fps))`) asserting recovery within half a frame,
      **including a case past 24 hours** — D3's correctness depends on `fromTotalFrames` continuing
      to wrap, so pin it; an innocuous future "don't wrap the hour field" fix would desynchronize
      strings from clips.
- [x] 2.3 Implement to green, mirroring `server/src/routers/events.ts`'s existing inverse
      expression exactly (`Math.round(Number(row.frame_rate))`, then
      `(hh*3600 + mm*60 + ss) * fps`). Add a source comment: **neither** `parseSmpteToSec` is
      correct here — both treat HH:MM:SS as literal seconds — so an import auto-fix cannot
      reintroduce the defect.

## 3. Shared jump module + feed hook

- [x] 3.1 Write failing tests for a plain `timelineJump` module: issues scrub → scroll → audio in
      order; no-ops without throwing when the globals are undefined; and is **ungated,
      uncoverage-checked, and non-playing** (design D8) — assert it performs none of those itself.
- [x] 3.2 Implement `timelineJump` as the one typed place the three global names live.
- [x] 3.3 Write failing tests for the feed-facing hook: unavailable while `is_rolling`; unavailable
      while status is **unresolved** (design D5 — `undefined` must not read as not-rolling);
      unavailable in batch-edit mode; available when loaded, not rolling, not batch; when the target
      is **not covered by a playable clip**, issues scrub + scroll but **no audio and no playback**
      (design D6); when covered, issues the jump **and starts playback** (design D1).
- [x] 3.4 Implement the hook to green, reading clips via `useAudioClips` (a hook — React Query
      dedupes; no new global).

## 4. Play-capable seek path

- [x] 4.1 Write failing tests: a play-capable path starts playback from the target on a **paused**
      player; a playing player continues from the new position without restarting; and the existing
      `seekToTimelineSec` path is **unchanged** (still only resumes when already playing) so marker
      navigation keeps its semantics.
- [x] 4.2 Implement in `AudioPlayer` + publish from `SessionWorkspace`. Keep the non-playing path
      intact and separately reachable — `MarkerNav` must not gain playback (design D1, D8).

## 5. The jump column and its control

- [ ] 5.1 Write failing tests for the column + control: `FeedTable` renders a header that is
      visually hidden but carries an accessible label via `ColumnDef.ariaLabel` (this is that
      field's first consumer); the control is a real `<button>` whose accessible name identifies the
      time **as the row displays it**; it activates by pointer and by Enter/Space; a row with no
      resolvable position renders **no control at all** (assert absence, not `aria-disabled`); in
      the rolling state controls are `aria-disabled` and reference **one shared reason node per
      feed**, never one per row, and never the native `disabled` attribute.
- [ ] 5.2 Implement the column and control.

## 6. Event Feed wiring

- [x] 6.1 Write failing tests: an event row resolves from `timecode_total_frames / frame_rate`
      **directly** — an event with an absent frame count renders no control rather than resolving
      to `0` via `eventTimelineSec`'s fallback (design D4); unavailable while rolling and in
      batch-edit mode; activation jumps **and starts playback**. In **wall-clock display mode** the
      control's accessible name names the wall-clock time the row shows. Assert
      `EventLogSheet.test.tsx` still passes unchanged — it renders real `EventLogRow`s.
- [x] 6.2 Implement: `EventLogSheet` owns the hook and passes a stable handler plus each row's
      resolved state as a **prop** (design D7); `EventLogRow` renders the jump cell. Reconcile the
      timecode cell's `!cursor-pointer [&_*]:!cursor-pointer` lock — it emits `!important` on every
      descendant and would defeat an unavailable-state cursor; the required outcome is that the
      cell no longer asserts a pointer cursor it cannot honor.

## 7. Transcript feed wiring

- [x] 7.1 Write failing tests in a new `TranscribeRow.test.tsx`: a row resolves from its **stored**
      `session_time` via the D3 converter (not the uncommitted edit buffer); **an edited row
      resolves to the edited time, not its stale `start_sec`**; **a hand-inserted row
      (`start_sec === 0`, real typed time) resolves to the typed time and does not drive the
      playhead to `0`**; an anchorless row renders **no control**; fields still focus and still
      commit on blur, untouched; and activating the control focuses no field and begins no edit.
- [x] 7.2 Implement: `TranscribeFeed` owns the hook and passes a stable handler mirroring its
      existing `handleUpdate` `useCallback`; seekability arrives as a prop so `memo` re-renders when
      the gate flips.
- [x] 7.3 Re-measure the rendered row height and reconcile `TranscribeFeed`'s hard-coded
      `ROW_HEIGHT` (currently `34`; measured actual today ≈29.4px) or switch to `measureElement`.
      The virtualizer has no measurement pass, so a row exceeding the estimate drifts every
      subsequent offset. Update the constant's comment.

## 8. Topics feed wiring

- [ ] 8.1 Write failing tests in a new `TopicsRow.test.tsx`: a parseable stored `session_time`
      resolves via the D3 converter; empty and unparseable values render **no control**; all four
      fields still focus and commit on blur. **Setup:** jsdom has no `ResizeObserver` and
      `TopicsRow` constructs one unconditionally in a `useLayoutEffect`, so stub it; `TopicsRow`
      calls `useUpdateTopic` internally, so wrap in a `QueryClientProvider`.
- [ ] 8.2 Implement: `TopicsFeed` owns the hook, `TopicsRow` renders the jump cell.
- [ ] 8.3 Mark topic jumps unavailable when the session's transcript is **wholly anchorless**
      (spec: "Topic jumps require an anchored transcript")
      (every word's `session_time` empty). With no `[HH:MM:SS]` prefixes to copy, the generator
      invents elapsed-from-zero times that parse perfectly — so the worst case is not an unseekable
      feed but one silently seekable to a *wrong* second, which under D1 now plays. Same predicate
      shape as `ai-v2-dashboards`' `wordTimingsAreDegenerate`.

## 9. Cross-cutting behavior

- [ ] 9.1 Write failing tests for the rolling→not-rolling **transition**: controls flip from
      unavailable to available without a remount, in all three feeds. A ref-stabilized gate passes
      the static tests and fails this one.
- [ ] 9.2 Add a dirty check to `TranscribeRow`/`TopicsRow` `commitField` so blurring an unchanged
      field issues no `PATCH`. Today every blur writes; jumping mid-edit therefore writes an
      unchanged value and invalidates the query under a virtualized list. `EventLogRow.handleBlur`
      already has this check — mirror it. Test: focus a field, change nothing, activate the jump →
      no mutation fires.

## 10. Collapse the duplicate jump

- [ ] 10.1 Refactor `MarkerNav.handleJump` onto `timelineJump` — the **ungated,
      uncoverage-checked, non-playing** module (design D8). Task 1.1's characterization test MUST
      pass unchanged on all four properties. Pure reshape, its own commit.
- [ ] 10.2 Confirm `MarkerNav`'s in-file comment about the coordinate-space bug still describes the
      code after the move; relocate or restate it if the reshape orphaned it. Do not convert its
      past-tense provenance into a present-tense obligation.

## 11. Final gates

- [ ] 11.1 `npm run typecheck` (server + web + companion + e2e) and `npm test` clean.
- [ ] 11.2 `npm run lint` clean. The design deliberately avoids a bare `<tr onClick>`, so no
      `biome-ignore` for `a11y/useKeyWithClickEvents` or `noStaticElementInteractions` should be
      needed — if one becomes necessary, the control has regressed to a non-interactive element.
- [ ] 11.3 `npm run e2e` (which runs the `chromium` project only) **plus**
      `npx playwright test --project=login-gate`, which the npm script omits.
- [ ] 11.4 Seed rows into the transcript and topics **visual** fixtures before running
      `npm run e2e:visual`. Both currently screenshot empty feeds ("No transcript yet" / "No topics
      yet"), so a new column and any column-width regression would be invisible to the visual gate.
      Baselines are expected to move; re-bless in this change's own diff (current as of 2026-07-14).
- [ ] 11.5 Confirm zero files under `server/` and `companion/` are touched by the branch diff — the
      contract-impact-none claim is mechanically checkable, so check it.
- [ ] 11.6 Drive the real app once, against a session with **two recordings and a gap** at a
      **non-integer frame rate**, plus a **topic set generated from an anchorless transcript**:
      jump into the gap (playhead moves, nothing plays, no take switch); jump from a row an hour in
      (lands where the timeline shows it, not seconds early); jump from a covered row (plays from
      that point); confirm no column truncates an `HH:MM:SS:FF` value in any feed. Fixture-based
      tests cannot catch a generator-format or coordinate-space regression — the archived
      `topic-generation` change recorded this same lesson.
