# Tasks: auto-generate-event-logs

> Plan of record per the 2026-07-28 panel + gate (see design.md Panel & review log).
> `file:line` anchors are orientation only — locate code by content before editing.
> Every task lands with `npm run typecheck` + `npm test` green.

## 1. Instruction fields (normalization + wire + settings UI)

- [x] 1.1 TDD: `auto_instruction` carry-through + bounds in `validateCategoriesList` /
      `normalizeDropdownOptionEntry` (`server/src/studio.ts`): trimmed, ≤ 2000 chars
      beside the existing label checks (`ValidationError` → 400), empty ⇒ omitted,
      dropped on ON_OFF categories (design D1); unit tests for accept / reject /
      absent / ON_OFF-drop / round-trip through the profile update path.
- [x] 1.2 TDD: `auto_instructions_present` boolean on `GET …/show-categories`
      (computed in the events router from the show's categories using the
      instruction-bearing definition; shared `showCategoriesApiShape` untouched);
      integration test: boolean true for option-only DROPDOWN, false otherwise;
      Companion categories response byte-shape unchanged; re-capture the
      show-categories response-conformance fixture and update hand-written web API
      types (`web/src/api/types.ts`).
- [x] 1.3 Web settings UI: `auto_instruction` on `EventButtonDraft` + option drafts;
      instruction editor per BUTTON/DROPDOWN/TEXT row (none for ON_OFF; type-switch
      to ON_OFF drops instructions); per-option + whole-button fields in
      `EventOptionsModal`; instruction-bearing indicator (single definition —
      option-only lights it); save mappings in `HomeSettingsModal`/`EventOptionsModal`
      carry the fields; copy-from-show carries them; component tests (edit arms Save
      via snapshot dirtiness, options round-trip, ON_OFF exclusion, indicator, copy).

## 2. Anchor interpolation + event insertion (server core)

- [x] 2.1 TDD: timecode→wall interpolation helper — piecewise-linear over existing
      event `(timecode_total_frames, wall_time_utc)` anchor pairs (incl. `Recording N
      Started` internal rows), clamped monotone; one-anchor offset and
      zero-anchor `started_at_utc` + offset fallbacks (design D4); property tests on a
      **multi-take/paused fixture**: generated timecode T sorts between bracketing
      manual events; generated events sort among themselves in timecode order.
- [x] 2.2 TDD: timecode-string parser accepting `HH:MM:SS`, `HH:MM:SS:FF`,
      `HH:MM:SS;FF` via the existing timecode helpers; bounds (non-negative, < 24h at
      session fps); 29.97 drop-frame round-trip test against `formatSmpte` output.
- [x] 2.3 TDD: `EventStore.addEvent` optional explicit-anchor parameter
      (`{timecodeTotalFrames, wallTimeUtc}` bypassing `timecodeForMark`; same
      transaction, broadcast, metadata handling); integration tests beside
      `eventStore.test.ts` asserting manual-path behavior is byte-identical when the
      parameter is absent.

## 3. MCP registration split + create_event + allowlist pin

- [x] 3.1 TDD: per-turn context on `AiMcpListener.registerTurn` (turn tool set + run
      snapshot: frame rate, offset, categories, run id, cap counter) and per-turn tool
      registration in `buildSessionMcpServer` (design D6); tests: a chat-turn
      registration's server does not register `create_event` (server-side denial),
      generation turn registers exactly its two tools.
- [x] 3.2 TDD: `create_event` tool — message bounds (mirror `logBodySchema`), timecode
      grammar/bounds via 2.2, snapshot category allowlist + `internal` denial
      (case-insensitive), per-run cap enforcement (tool error naming the cap),
      metadata composition (`auto_generated`, `auto_generate_run_id`, category
      label/color UI snapshots from the snapshot), insert via 2.3 + interpolation via
      2.1; tool-error paths never throw.
- [x] 3.3 TDD: generation-density paged `get_transcript_words` rendering (anchored
      line on speaker change AND every ≤ N words; unanchored words un-timestamped;
      deterministic sequential paging with continuation marker; chat rendering
      byte-identical via existing tests) (design D5). Includes the **measurement
      task**: render a realistic long-session fixture, record its size vs the CLI
      tool-output ceiling in the test, pin N and the page size from it.
- [x] 3.4 Pin chat's tool surface: explicit `AI_CHAT_ALLOWED_TOOLS` in `ai.ts`; tests
      pin chat argv `--allowedTools` to exactly the three chat tools and
      topics/generate's allowlist unchanged (design D7).

## 4. Generate route (server)

- [x] 4.1 Config accessors: `eventGenerateMaxBudgetUsd` (default 5.0),
      `eventGenerateTimeoutSec` (default 600), per-run cap (default 200), aggregate
      instruction bound (design D8) + `.env.example` notes; unit tests for
      defaults/overrides.
- [x] 4.2 Orchestrator prompts (design D3): system prompt constant + message builder —
      instruction-bearing enumeration (single definition), per-category embedded
      existing events (complete, compact, `(auto)` marker), untrusted-data delimiters,
      message conventions per button type; unit tests on serialization incl.
      option-only DROPDOWN and delimiter framing.
- [x] 4.3 TDD: `POST /api/sessions/:sessionId/events/generate` — full guard ladder in
      order (404-mask, CLI 503, open-network 503, anchored-transcript 400,
      no-instructions 400, aggregate-bound 400, slot 409 with reworded shared busy
      details), `driveAiTurn` with no abortSignal, `200 {created, cap_hit}`,
      opaque-502 failure mapping, post-run catalog `projectSessionLive` mirror;
      integration tests with a fake CLI (the `ai.int.test.ts` pattern) incl.
      partial-persist-on-failure and sessions-list freshness.
- [ ] 4.4 Gated real-CLI test (`topicGenerate.real.test.ts` pattern): SLATE-style
      instruction over a captured anchored-transcript fixture produces ≥ 1 event with
      a bracketing-correct timecode, manual-vocabulary message, and metadata marks;
      re-run over unchanged transcript with embedded prior events produces no
      duplicates (model-behavior check).

## 5. Feed UI (web)

- [ ] 5.1 AUTO GENERATE control: React Query mutation + `useGatedGenerate` /
      `GenerateToolbar` reuse — 503 latch, inline single-channel outcomes (created
      count / cap note / pre-spawn details / retryable unlatched 409),
      `auto_instructions_present`-gated non-actionable state, run state scoped to the
      starting session across the mounted-hidden panel; component tests mirroring
      `generateLatch.test.tsx` + session-switch scoping test.
- [ ] 5.2 Generated-row marker (`metadata_json.auto_generated` → compact accessible
      indicator on the feed row; editing/deletion/jump unchanged) + burst coalescing
      of `event.changed`-driven event refetches (~1s debounce, trailing refetch);
      component tests (marker accessibility; 60-frame burst → bounded refetches →
      final state correct).

## 6. Docs + final gates

- [ ] 6.1 README: endpoint table row for `events/generate`, feature section (egress +
      spend disclosure like topics, cap + marker semantics), CLAUDE.md
      project-overview gating sentence; note the reworded shared 409 details.
- [ ] 6.2 Final gates: `npm run typecheck`, `npm test`, `npm run lint`,
      `npm run e2e` (chromium + login-gate) AND `npm run e2e:visual` — settings-table
      and feed-toolbar/row-marker visual diffs are expected; re-bless those baselines
      in this branch's diff.
