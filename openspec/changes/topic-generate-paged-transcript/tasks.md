# tasks — topic-generate-paged-transcript

> Panel + fold complete (see design.md Panel & review log, 2026-07-29); apply was
> pre-authorized by the user in the same session.
> file:line anchors are orientation only — locate code by content before editing.

## 1. Shared pager: size-safe packing + marker neutralization (aiMcpServer.ts)

- [x] 1.1 Repack `renderGenerationTranscriptPage` by rendered size (D4): hard cap
      45,000 rendered chars per page, packed on line boundaries; keep
      `GENERATION_PAGE_SIZE_WORDS` (8000) as a secondary cap; split a single over-cap
      line hard at the cap. TDD in `aiMcpGenerationRendering.test.ts`: adversarial
      fixture (speaker change every word) asserts the cap INVARIANT (no page over
      45,000 rendered chars); determinism/marker/out-of-range pins carry over;
      supersede the exact 62,952-byte pin, the 80,000-byte safety bound, and the
      test's name (both numbers are hard-coded in it), demoting the "worst-case"
      wording to "this fixture's page". Update the `get_transcript_words` generation
      tool DESCRIPTION so it no longer promises fixed word-sized pages (size-capped
      pages; keep the marker/keep-paging protocol text — the topic-generation prompt
      scenario leans on it). Gate: `npm run typecheck` + `npm test`.
- [x] 1.2 Neutralize continuation-marker-shaped content in body lines (D5, mirroring
      `eventGeneratePrompt.ts`'s `neutralizeDelimiterTokens` discipline) so no
      transcript word can render a line matching the marker shape. Tests: a word
      carrying a byte-exact marker line renders neutralized; the tool's own trailing
      marker remains the only marker in the page. Gate: `npm run typecheck` +
      `npm test`.

## 2. Context field, keying, page tracking (aiMcpServer.ts, aiTurn.ts)

- [x] 2.1 Widen `AiMcpTurnContext` with `pagedWords?: readonly
      AiGenerationSnapshotWord[]` (D1 — flat, 3-field snapshot shape, ONLY words);
      rekey the `get_transcript_words` builder: paged (page-input) registration when
      `generation !== undefined` OR `pagedWords` present; page words sourced
      `generation?.words ?? pagedWords ?? live hub read`; memoize the paginated array
      lazily per registration (the snapshot is immutable — do not re-paginate the
      whole transcript on every page call). Track pages served per registration (D6):
      a `Set<number>` of served page indices + the snapshot's total page count,
      exposed on the registration like `createdEvents`. Tests in `aiMcpServer.test.ts`
      (KEYING only — the rendering suite owns paging/marker assertions): `pagedWords`
      registration exposes the `page` shape and sources the snapshot; chat
      registration (no context) byte-identical, existing pins unmodified; the one-shot
      tool pair registers no `create_event`/`list_topics`; pages-served tracking
      visible. Gate: `npm run typecheck` + `npm test`.
- [x] 2.2 Surface page coverage through `driveAiTurn` (`aiTurn.ts`) alongside
      `createdEvents` (D6), and gate the `topics/generate` swap in `transcribe.ts`:
      success requires `outcome.ok && newIds.length >= 1 &&` every page of the
      snapshot served; anything less takes the EXISTING restore + 502 path (status,
      shape, detail unchanged). Tests: partial coverage → prior topics byte-for-byte
      intact, fresh rows removed, 502; full coverage → replace; a registration with
      neither `generation` nor `pagedWords` (a chat turn) reports zero pages served;
      `events/generate` unaffected (it serves pages but has no topic swap to gate).
      Gate: `npm run typecheck` + `npm test`.

## 3. Topic one-shot turn (topicGenerate.ts) + bounds (env.ts)

- [x] 3.1 `generateTopicsTurn`: capture the word snapshot synchronously as the
      immediately-preceding statement before `driveAiTurn` (D2 — hub read projected to
      the 3-field shape; no `await` between read and turn registration, matching the
      `events.ts` precedent and its comment); pass as `mcpContext.pagedWords`;
      update `TOPIC_GENERATE_SYSTEM_PROMPT` with the explicit paging protocol +
      untrusted-data clause (D3). Tests in `topicGenerate.test.ts`: mcpContext carries
      `pagedWords` + exact two-tool set (NOTE: the existing `toEqual({ tools: [...] })`
      whole-object pin MUST be updated — expected churn, not a regression); argv
      `--allowedTools` unchanged (`list_topics` still withheld); prompt constant names
      the sequential-page protocol, the fetch-until-no-marker rule, and the
      untrusted-data clause (direct string assertions). Gate: `npm run typecheck` +
      `npm test`.
- [x] 3.2 Raise defaults (D7): `topicGenerateMaxBudgetUsd` 2.0 → 5.0,
      `topicGenerateTimeoutSec` 300 → 600 in `server/src/env.ts`, with a comment
      citing the same file's event-generate rationale (the paged full-transcript read
      is the workload those numbers were derived for); update `server/.env.example`
      and README knob docs, AND correct the now-false event-generate comparatives
      that assert `EVENT_GENERATE_*` is defaulted HIGHER than `TOPIC_GENERATE_*`
      (`env.ts` eventGenerate* JSDocs + the event-auto-generation block comment,
      `.env.example`'s event-generate block, README's event-generation spend
      paragraph) — the two are now equal. Tests: env default assertions updated.
      Gate: `npm run typecheck` + `npm test`.

## 4. Real-CLI acceptance (primary behavioral evidence)

- [x] 4.1 Extend `topicGenerate.real.test.ts` (D8): multi-page fixture (exceeds one
      size-capped page) with INCREASING per-word timecodes (the current fixture
      anchors every word at `00:00:01`) and an unguessable content canary present only
      on the LAST page, asserted to reach a topic summary; run at PRODUCTION defaults
      (`topicGenerateMaxBudgetUsd({})` / `topicGenerateTimeoutSec({}) * 1000` —
      replace the hard-coded `maxBudgetUsd: 5` AND `timeoutMs: 300_000`), and raise
      the test's vitest timeout (currently `320_000`) above the 600s production
      timeout; record observed cost + wall time in the apply ledger. Gate documentation: skips unless `RUN_REAL_AI_TESTS=1` AND a claude CLI
      resolves via `CLAUDE_CLI_PATH` or `PATH`; run with `npm run test:real -w server`.

## 5. Docs, spec verification, final gates

- [ ] 5.1 Verify all three delta specs against the implementation. Docs sweep: add one
      sentence to README's topic-generation section stating the one-shot reads the
      transcript via the paged generation-density rendering (unconditional add — the
      section currently doesn't describe transcript delivery; README's "the chat
      rendering is unchanged" line stays true); document the raised defaults and the
      supported-ceiling residual (~50k+ words degrade via CLI auto-compaction).
      Update doc comments this change falsifies: `topicGenerate.ts` header;
      `aiMcpServer.ts` header ("each turn's registration carries its tool set
      (+ generation run snapshot)"), `AiMcpTurnContext.generation` sibling comment,
      the builder's "GENERATION turns" comment, `GENERATION_PAGE_SIZE_WORDS` doc
      ("worst-case" wording + the 4-chars/token derivation),
      `GENERATION_LINE_MAX_WORDS` JSDoc (same superseded 62,952-byte claim), the
      "For GENERATION turns" block comment above the rendering section, the
      `ToolBuildContext` JSDoc ("run snapshot on generation turns (undefined on chat
      turns)"), and the `registerTurn` JSDoc ("on generation turns — the run
      snapshot"); `aiTurn.ts` `mcpContext` JSDoc ("plus — on event-generation turns —
      the run snapshot"). Keep origin headers past-tense.
- [ ] 5.2 Final gates: `npm run typecheck`, `npm test`, `npm run lint`,
      `npm run e2e` (chromium + login-gate), `npm run e2e:visual`. No UI surface is
      touched, so visual diffs are unexpected — investigate as unrelated drift rather
      than re-blessing.
