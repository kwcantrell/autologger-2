# Full-repo code-health review — 2026-07-27

Six parallel skeptical reviewers (one per repo slice: routers, session hub, db+node infra,
web pages/index, web-rest, companion/e2e/cross-cutting), each briefed on the frozen
HTTP/WS contract and the repo's deliberate patterns, followed by an orchestrator
synthesis pass with spot-verification of the top findings.

**Verification status legend** — per the SDLC rule that research artifacts feeding specs
need fact-verification before they count as spec input:

- **[V]** verified by the orchestrator (code read/grepped directly in the main session).
- **[A]** agent-reported at high confidence, not independently re-verified. A change
  consuming an [A] finding normatively should re-verify it in its fact-check pass.
- **[A?]** agent-reported at medium/low confidence, or consequence not reproduced
  (e.g. traced but not executed).

**Disposition** (decided in-session 2026-07-27):

- **QF** — quick-fix track: small, obvious fix; no OpenSpec change required; branch
  `quick-fixes-2026-07`.
- **OS** — design-bearing: goes through the `code-health-consolidation` OpenSpec change
  (propose → fact-check → panel → gate → apply).
- **OS-delta** — additionally touches observable contract semantics; requires an
  authorizing delta spec against `api-contract-freeze`.
- **OBS** — observation only / accepted residual; no action planned.

Invariant compliance was explicitly checked and is **clean**: zero `async`/`await` in
SessionHub RPC bodies, every mutating hub RPC transactional, lazy DB reopen/evict correct,
no frozen-contract violations found anywhere.

---

## 1. Bugs and correctness hazards

| # | Finding | Anchor | Sev | Ver | Disp |
|---|---------|--------|-----|-----|------|
| 1.1 | AI-chat kill ladder gates SIGKILL on the *tracked child's* exit, not group liveness; a SIGTERM-ignoring group member is orphaned when the leader exits promptly. AI-v2 fixed this exact hazard (`designTurnGroupAlive`, `process.kill(-pgid, 0)` at `aiV2SdkSpawn.ts:286-343`) after spike 0.5 proved it; the chat/topic-generate path retains the flawed pattern. | `server/src/routers/aiChatRunner.ts:316-347` | high | [V] | OS |
| 1.2 | `apiFetch` merges default `Content-Type` into `headers` *before* `...opts` is spread, so caller-supplied `opts.headers` replaces the merged object wholesale. Same pattern in `AdminUsersPage.fetchAdmin` where caller headers would drop the `Authorization` bearer. | `web/src/api/client.ts:15-22`; `web/src/pages/admin-users/AdminUsersPage.tsx:16-21` | med | [V] | QF |
| 1.3 | Store-level WS broadcasts execute inside `inTxn` (before commit); a commit-time failure (e.g. SQLITE_FULL at WAL commit) sends clients `*.changed` for a rolled-back write. Repo previously diagnosed this (Phase-9 finding, `SessionHub.ts:222-231`) but patched only two methods via `suppressBroadcast` flags. Proper fix: post-commit broadcast queue flushed by `inTxn`, deleting both flags. Failure-path emission is technically observable WS semantics. | `server/src/session/eventStore.ts:71,132,142`; `transportStore.ts:42,67`; `audioStore.ts:86,125`; `leaseStore.ts:29,51,81` | med | [A] | OS-delta |
| 1.4 | `getAiMcpListener` first-use race: `singleton` assigned synchronously before `await singleton.start()`; a second concurrent caller returns an unstarted listener whose `port` getter throws (`'AiMcpListener not started'` → scrubbed internal-error turn failure). Fix: cache the start promise (`singletonPromise ??= …`). | `server/src/routers/aiMcpServer.ts:357-363,250-254` | med | [A] | QF |
| 1.5 | `SESSION_DAYS=0` bypasses expiry: `sessionTtlDays` is the only numeric env getter missing the `n > 0` guard; `0` is falsy in `KvStore.put` → `expires_at = NULL` → immortal server-side login session (paired with a `maxAge: 0` cookie). | `server/src/env.ts:47-50`; `server/src/node/kvStore.ts:28` | med | [A] | QF |
| 1.6 | `BlobStore.put()` failure orphans its temp file (the `finally` only closes the handle) and no sweeper covers the `put-*` prefix (`youtubeImportScratch` sweeps only `youtube-import-*`) — unbounded tmp accumulation on exactly the flaky-disk boxes where writes fail. | `server/src/node/blobStore.ts:65-73` | med | [A] | QF |
| 1.7 | Suffix `Range` against a zero-byte blob computes `{start: 0, end: -1}` → `createReadStream` throws `ERR_OUT_OF_RANGE` → 500, where the contract's range semantics imply 416 (`InvalidRangeError`). Traced, not executed. Changing 500→416 is a status-code change on an error path. | `server/src/node/blobStore.ts:89-92,101-103` | low-med | [A?] | OS-delta |
| 1.8 | MarkerNav fetches events with `{limit: 1000}` vs SessionWorkspace/Timeline's `{limit: 2000}`: a second full fetch under a different React Query key, and on >1000-event sessions the timeline shows markers prev/next can't reach. | `web/src/pages/index/components/MarkerNav.tsx:85` vs `SessionWorkspace.tsx:56` | med | [A] | QF |
| 1.9 | `HomeSettingsModal` Event Buttons tab: `aria-controls` points at `v6-settings-section-event-buttons`, panel id is `v6-settings-section-events` — dangling reference (other three tabs match). | `web/src/pages/index/components/HomeSettingsModal.tsx:721,536` | med | [A] | QF |
| 1.10 | `V6Rail` collapse: `aria-expanded` hardcoded `"true"` on the toggle button while the imperative code updates the attribute on the `<aside>` — announced state never changes. | `web/src/pages/index/components/V6Rail.tsx:146-151,178` | med | [A] | QF |
| 1.11 | `EventLogSheet` Escape-to-cancel `useEffect` has no dependency array — document listener removed/re-added every render, undeclared as intentional (unlike the repo's biome-ignored effects). | `web/src/pages/index/components/EventLogSheet.tsx:288-303` | med | [A] | QF |
| 1.12 | `hideToast` fallback clears the entire queue when no persistent toast exists (can wipe unrelated error toasts from its one caller `AudioSaveOverlay.tsx:48`), and double-emits when a persistent toast is found. | `web/src/shared/components/Toast.tsx:44-49` | low-med | [A] | QF |
| 1.13 | `issuedClaudeSessionIds` grows without bound (every successful chat turn adds an entry; nothing evicts; entries survive session deletion). | `server/src/routers/ai.ts:67` | low-med | [A] | OS |
| 1.14 | `runAiChatTurn`'s `guardedEmit` does not swallow emit throws (v2's does): a throwing `stream.writeSSE` propagates into `relayAiChatTurn`'s emit path, piercing `driveAiTurn`'s "never throws" contract at `aiTurn.ts:105` (catch clause itself awaits `opts.emit`). Route `finally` still releases the slot. | `server/src/routers/aiChatRunner.ts:386-390` vs `aiV2SdkSpawn.ts:514-518` | med-low | [A?] | OS |
| 1.15 | `createSessionIndex` runs the session INSERT and the show `next_episode` bump as two bare statements with no `tx()` (caller doesn't wrap either) — the one multi-statement catalog mutation not atomic. | `server/src/db/sessionIndexStore.ts:85-102`; caller `routers/sessions.ts:152` | low-med | [A] | QF |
| 1.16 | `ytdlp` stdout accumulated via per-chunk `toString('utf8')` — multibyte sequences straddling chunk boundaries decode to U+FFFD. Harmless today (only `is_live`/`duration`/`upload_date` read); latent if string fields are ever consumed. `string_decoder` is the fix. | `server/src/node/ytdlp.ts:224-226` | low | [A] | OBS |
| 1.17 | `locateProducedFile` takes the first `readdir` entry with the `audio.` prefix; a stale `audio.m4a.part` alongside the final file can win, fs-order-dependently. Needs an unusual exit-0-with-part-file state. | `server/src/node/ytdlp.ts:259` | low | [A?] | OBS |
| 1.18 | `releaseLease` never cancels the armed alarm: after explicit release, `hasArmedAlarm` stays true up to ~40s, blocking `evictIdle` and firing a no-op `expireIfStale`. | `server/src/session/leaseStore.ts:45-52`; `SessionHub.ts:108-118` | low | [A] | OBS |
| 1.19 | `startSweeper` overwrites `this.sweeper` without clearing an existing interval (timer leak if ever called twice; single call site today). | `server/src/session/SessionHub.ts:418-421` | low | [A] | OBS |
| 1.20 | `maybeRelinkOrphans` bumps revision without broadcasting `event.changed` (possibly deliberate — runs inside list-events which returns fresh data); its self-bump defeats its own once-per-revision guard (guaranteed extra full rescan next call); relink filtering done in JS not SQL. | `server/src/session/eventStore.ts:150-195` | low | [A] | OBS |
| 1.21 | `deleteAudioSegment` emits no `audio.changed` while add/waveform-set do; router rollback paths rely on that silence, but a client refetching on the add broadcast can hold a phantom segment. Frozen contract — observation only. | `server/src/session/audioStore.ts:105-107` | low | [A] | OBS |

## 2. Duplication and drift (design-bearing consolidations → OS unless noted)

| # | Finding | Anchor | Sev | Ver | Disp |
|---|---------|--------|-----|-----|------|
| 2.1 | AiChat ↔ AiV2Design: `safeJsonParse`/`extractErrorDetail` verbatim; SSE read loop, delta-append reducer, abort-vs-connection-lost catch, notConfigured 503 branch, textarea+Stop/Send footer near-verbatim (~150 lines). Shared `useSseTurn` hook + composer component. | `web/src/pages/index/components/AiChat.tsx:89-105,182-188` vs `AiV2Design.tsx:133-149,329-335` | med-high | [A] | OS |
| 2.2 | `runAiChatTurn` ↔ `runDesignTurn`: ~80-line near-clones of guardedEmit/timeout/abort/`Promise.race` orchestration with two observed drifts (emit-throw swallowing — see 1.14; terminal-detail scrubbing v2-only). Shared orchestrator parameterized by scrubber/cleanup. | `server/src/routers/aiChatRunner.ts:384-447`; `aiV2SdkSpawn.ts:505-614` | med | [A] | OS |
| 2.3 | Internal-audio message grammar duplicated: `recording.ts:4-40` re-implements `audioClips.ts:48-77` (legacy markers, ordinal parsing, predicates, sort; only `?? ''` vs `\|\| ''` differs). recording.ts already imports from audioClips — no cycle. | `web/src/shared/utils/recording.ts:4-40` | med-high | [A] | OS |
| 2.4 | Deck-title rule in three copies: `sessionDeckDisplayTitle` (shared helper, used once) re-derived in `events.ts` and `companion.ts`. User-visible string. | `server/src/routers/studio.ts:399-409`; `events.ts:260-269`; `companion.ts:219-224` | med | [A] | OS |
| 2.5 | Generate-503-latch handler + toolbar block near-verbatim between TranscribeFeed and TopicsFeed (latch is deliberate; its double implementation is not). `useGatedGenerate` hook + shared fragment. | `TranscribeFeed.tsx:79-95,152-187` vs `TopicsFeed.tsx:110-122,148-182` | med | [A] | OS |
| 2.6 | Same-second marker grouping implemented twice (Map on `sec.toFixed(3)`, internal-loses preference); drift silently desyncs MarkerNav from Timeline navigation. | `MarkerNav.tsx:36-51` vs `Timeline.tsx:468-497` | med | [A] | OS |
| 2.7 | `normalizePalette9` + 9-color `DEFAULT_PALETTE` duplicated (slightly different implementations of the same function). | `HomeSettingsModal.tsx:79-97` vs `EventButtonsTable.tsx:106-126` | med | [A] | OS |
| 2.8 | Query-key split-brain: factories exist (`eventsKeys` etc., with rationale comment) but `['session-status', id]` is a bare literal in 4 files and `['audio-segments', id]` in 3+ — cross-file cache-coupling strings the factories were built to prevent. | `useSessionStatus.ts:12`; `useTransport.ts:8`; `useAudio.ts:13,30,71,100`; `useSessionSocket.ts:55,57,118,121,124`; `useSessions.ts:140` | med | [A] | OS |
| 2.9 | `SessionCard` vs `ArchivedSessionCard` duplicate card layout, verbatim `handleDelete`, meta/runtime derivation, Popover scaffolding; only menu items differ. | `web/src/pages/index/components/RecentSessionsList.tsx:133-298` vs `300-391` | med | [A] | OS |
| 2.10 | Event-count SQL (incl. the subtle `lower(trim(category)) != 'internal'` filter) duplicated verbatim across stores; `TransportStore.statusLive` is a cross-domain read contradicting sessionCore's stated "stores never depend on each other" design. `core.eventCounts()` helper. | `server/src/session/transportStore.ts:116-119` vs `eventStore.ts:88-91`; `sessionCore.ts:4-5` | med | [A] | OS |
| 2.11 | AI-v2 route guard prologue (requireSession → requireIndividualPrincipal → 503 gates) copy-pasted across five routes; a `guardAiV2Route` helper makes "routes cannot drift" structural. | `server/src/routers/aiV2.ts:184-192,374-382,459-465,473-479,513-519` | med-low | [A] | OS |
| 2.12 | Patch-builder + ordinal-seed insert patterns duplicated between topicStore and transcriptStore (~40 lines); lease free-path triple duplicated in `releaseLease`/`expireIfStale`; mime↔ext hand-maintained inverse tables in audioStore. | `topicStore.ts:61-83`/`transcriptStore.ts:143-167`; `leaseStore.ts:49-51,79-81`; `audioStore.ts:58-62,141-152` | low-med | [A] | OS |
| 2.13 | `TranscribeRow` ↔ `TopicsRow` identical edit-buffer pattern maintained in parallel (their own comments cross-reference "identical defect" class). | `TranscribeRow.tsx:115-138` vs `TopicsRow.tsx:92-126` | low-med | [A?] | OS |
| 2.14 | Companion wire shape: `ServerStatePayload` hand-duplicates what `companion.ts` builds as an *untyped* inline literal — server not typed against its own payload; typo caught only by companion at runtime. | `companion/src/state.ts:1-33`; `server/src/routers/companion.ts:~75-95` | low-med | [A] | OS |
| 2.15 | Small verbatim copies: `isTypingTarget` (CategoryButtonStrip vs ShortcutsDialog export); `fmtHmsFromSec` (recording.ts vs timecode.ts); `safeTimelineSec` third copy (waveformSvg.ts); loopback predicate (main.ts vs env.ts `loopbackHostname`); show-initials computed twice in HomeSettingsModal. | `CategoryButtonStrip.tsx:205-209`; `recording.ts:53-59`; `waveformSvg.ts:6-9`; `server/src/main.ts:16,27` vs `env.ts:97-100`; `HomeSettingsModal.tsx:412-416,613-617` | low | [A] | QF |
| 2.16 | `fetchAdmin` re-implements `apiFetch` incl. identical detail-extraction; composable onto `apiFetch` **only after 1.2 is fixed** (spread order currently drops merged headers). | `web/src/pages/admin-users/AdminUsersPage.tsx:12-34` | med | [V] | QF (after 1.2) |

## 3. Dead code

| # | Finding | Anchor | Sev | Ver | Disp |
|---|---------|--------|-----|-----|------|
| 3.1 | `animate.min.css` (vendored animate.css v4.1.1, ~72KB) imported app-wide; zero `animate__*` class usage anywhere (all animation is Tailwind utilities). Delete import + vendor file. | `web/src/pages/index/main.tsx:8`; `web/src/shared/theme/vendor/animate.min.css` | high | [V] | QF |
| 3.2 | `waveformMerge.ts:134-166` SVG block (`waveformPeakToSvgY`, `WaveformSvgSpec`, `waveformSvgSpec`, exported `WF_SVG_PEAK_SPAN`) is dead — sole consumer imports the `waveformSvg.ts` copies. | `web/src/shared/utils/waveformMerge.ts:134-166` | med | [A] | QF |
| 3.3 | `loadingVideo.ts`: 6 of 8 exports dead (incl. `autologgerLoadingVideoHTML`, a vanilla-port vestige returning raw HTML). | `web/src/shared/utils/loadingVideo.ts:5,7,45,49,61,73` | med | [A] | QF |
| 3.4 | Dead `parseSmpteToSec` in timecode.ts (zero importers; same-named different-behavior sibling in audioClips.ts is the live one) — deletion also removes the auto-import footgun `timelineSec.ts:8-28` explicitly warns about. | `web/src/shared/utils/timecode.ts:3` | med | [A] | QF |
| 3.5 | Dead window globals: `AutoLogger_getManualScrubSec`, `AutoLogger_getSelectedEventId` (comment claiming MarkerNav reads them is stale — it uses the CustomEvent), `AutoLogger_resetZoom`. | `Timeline.tsx:517-518`; `useZoomRail.ts:714` | med | [A] | QF |
| 3.6 | Dead state/refs: `TranscribeFeed.errorRef`; `useZoomRail.lastZoomRangeWidthRef` (assigned never read) + `resizeFlushRafRef` (cancelled never assigned); `AudioPlayer.clipIndex` state (`void clipIndex`; ref is the real state, component renders null). | `TranscribeFeed.tsx:64`; `useZoomRail.ts:102,124`; `AudioPlayer.tsx:103,387` | low | [A] | QF |
| 3.7 | ThemeProvider context machinery dead (`useTheme`/`ThemeVariant`/`variant` prop unconsumed; used only for glow divs); `cx`/`ClassValue` re-exports unused; `DialogClose` unused; `BP`/`useMediaQuery` intra-module only; `getPerfDebugState` no callers; assorted intra-module-only exports. | `ThemeProvider.tsx:39`; `classnames.ts:1-2`; `Dialog.tsx:177`; `breakpoints.ts:3,16`; `perfDebug.ts:136` | low | [A] | QF |
| 3.8 | `events.ts` PUT: `internal`-category branch (`stripCategoryUiSnapshots`) unreachable unless a profile defines an `internal` category id — PUT 400s non-profile categories while POST admits `internal` explicitly; dead branch or ported drift. Do not change the 400 (frozen). | `server/src/routers/events.ts:196-228` | med | [A] | OS |
| 3.9 | Dead index `idx_users_email` (no SQL query filters users by email; JS-normalize scan is the documented design); missing index for `authConsumeInvitesForEmail`'s `email_norm` lookup (full scan on every OAuth sign-in; bounded by 200-per-team cap). | `server/src/db/migrations/0001_init.sql:17`; `authStore.ts:325-331` | low | [A] | OBS |
| 3.10 | `poller.test.ts` dead scaffolding (`calls` array never populated, kept via `void calls`). | `companion/src/poller.test.ts:9,31` | low | [A] | QF |

## 4. Stale docs / comments

| # | Finding | Anchor | Sev | Ver | Disp |
|---|---------|--------|-----|-----|------|
| 4.1 | `AUTH-API.md` badly stale as an auth/API reference: zero teams/invite routes, zero AI chat/v2/dashboard routes, marks `youtube-import` + `transcript-words/generate` + `topics/generate` as flat 503s though all are live config-gated features. Regenerate or delete. | `AUTH-API.md:82,129,144` | high | [V] | QF (disposition decided at fix time) |
| 4.2 | `transcribe.ts` module header claims `topics/generate` "remains intentionally unavailable … always 503" — false since the topic-generation change (live implementation at lines 257-335, paid-spend endpoint). | `server/src/routers/transcribe.ts:1-5` | med | [A] | QF |
| 4.3 | `CHANGELOG.md` stopped at 0.7.0 / 2026-07-10; ~9 shipped campaigns unrecorded. Maintain or drop. | `CHANGELOG.md` | med | [A] | QF (decision at fix time) |
| 4.4 | Stale comments: `useTimelineSeek.ts:8-12` ("later unit … phase 4" — landed); `MarkerNav.tsx:88` + `useZoomRail.ts:709` reference deleted `session.js`; `stopTakeWithDuration` doc comment misdescribes semantics (never checks `is_rolling`; sole caller invokes when not rolling). | various; `transportStore.ts:76-82` | low | [A] | QF |

## 5. Consistency / hygiene

| # | Finding | Anchor | Sev | Ver | Disp |
|---|---------|--------|-----|-----|------|
| 5.1 | 44 spurious `await`s on synchronous SessionHub RPCs across transcribe/events/audio/companion/exports/sessions routers, inconsistently applied (aiV2 dashboard routes don't await the same methods; two sites wrap sync calls in `Promise.all`). Seeded by `requireSession` being needlessly `async` (`_helpers.ts:41-57`). Test helpers `seedStudio`/`seedUser`/`seedShow`/`seedSession` likewise async with zero awaits. | e.g. `transcribe.ts:95`; `events.ts:67,135`; `companion.ts:75-78`; `server/src/test/helpers.ts:13-68` | med | [A] | OS |
| 5.2 | `login-gate` Playwright project not run by any npm script (`e2e` pins `--project=chromium`; no CI) — auth-boundary suite silently outside the scripted run. `scripts/teardown.mjs` omits its :8792 port. | `package.json:23`; `scripts/teardown.mjs:9-13` | med | [V] | QF |
| 5.3 | `@tanstack/react-query-devtools` unused dependency (grep-verified no import). | `web/package.json:22` | med | [A] | QF |
| 5.4 | TypeScript major drift: web pins `^6.0.0` (6.0.3 installed) vs root/server/companion `^5.7.2` (5.9.3); `@types/node ^26` vs `engines.node >=22.12` (types two majors ahead of runtime floor). | `web/package.json:39`; root `package.json` | low-med | [A] | QF (align decision at fix time) |
| 5.5 | Machine-specific `/home/kalen/companion-x64/companion_headless.sh` hardcoded in two tracked files (config re-declares instead of importing `companionAvailable()`); env var would single-source. | `playwright.config.ts:11`; `e2e/companion-harness.ts:34` | low-med | [A] | QF |
| 5.6 | `companion.ts` handlers re-fetch + non-null-cast the session row `requireActiveSession` already validated (double fetch + casts papering a delete-race window); returning the row fixes both. | `server/src/routers/companion.ts:38-44,107-141,178-184` | med-low | [A] | OS |
| 5.7 | Catalog smells: `authSetPrefs` three statements where one upsert would do (pattern exists in-file); `authUpdateUserProfile`/`updateShowFields` untransacted read-modify-write pairs; `getStudioSettingsBlob` triple-repeated default-fallback + getter-that-writes; `profilePayload` duplicate assembly branches + `listShowsForStudio` up to 3× per request; `CatalogDb` re-prepares statements per call (no cache); KvStore bypasses the CatalogDb seam (two access idioms, undocumented). | `authStore.ts:129-147,58-77`; `showsStore.ts:135-182`; `studioRegistry.ts:83-110`; `profileAssembler.ts:111-178`; `catalogStore.ts:12-22`; `kvStore.ts:10-13` | low-med | [A] | OS |
| 5.8 | Path-segment encoding inconsistent: 3 sites carefully `encodeURIComponent` with load-bearing comments; ~10 hooks interpolate ids raw (benign with server-generated ids; discipline asserted then ignored). Inline `{ok: boolean}` ~10× despite `OkResponse` in `api/types.ts:129`. Toast has two parallel public APIs (legacy `showToast`/`hideToast` 11 files vs `toast.*` 6 files). | `web/src/api/hooks/*` | low | [A] | OS |
| 5.9 | Misc web: tab panels repeat identical wrapper 5× (`SessionWorkspace.tsx:650-716`); spacer `colSpan={4}` hardcoded vs `COLUMNS.length` (`TranscribeFeed.tsx:237,258`, `EventLogSheet.tsx:579`); unmemoized filter+sort of up to 2000 events every render in EventLogSheet (`:244-247`, re-renders on every status poll); `categories.indexOf` inside map (`CategoryButtonStrip.tsx:366`); `useZoomRail` 880 lines of `useRef(fn)` idiom + unreachable safety-net effect; `useAudioClips` unconditional `durationsTick` bump; `AiV2Design.isSelected` matches on non-unique widgetType; RecentSessionsList pointless return / dead-looking active-title click; NewSessionModal un-annotated inline styles; `audio.ts:164-167` waveform bound check accepts [-0.02,1.02] while the (frozen) message says [0,1]; `app.ts:69` `as 400` cast; `aiV2SdkSpawn` redundant `terminateOnce` + `cleaned=true`-before-rmSync ordering. | various | low | [A] | OS (batched) or OBS |
| 5.10 | Test smells: `parseSse` duplicated verbatim in 2 int-tests (self-annotated); `seededSession()` re-implemented in 8 int-test files despite shared helpers; two different `configuredEnv` fns in one file (`transcribe.int.test.ts:133,446`); transportStore fake dispatches on SQL string-sniffing (real-SQLite coverage mitigates); three hand-rolled fake cores with `as unknown as` casts; hub atomicity test reaches into private field; fakeClock tests for `node/` modules live under `session/`; web hook-test mock idiom duplicated with citation-instead-of-sharing; e2e create-session boilerplate ~8× across 5 specs (helper exists in visual.spec only). | various | low-med | [A] | OS (batched) |

## 6. Explicitly clean (verified no-findings areas)

Hub invariants (all three, grep+read verified); auth/teams/admin/shows/profile/exports/
sessionWs/sessions routers; aiTurn/aiChatRegistry/aiChatRelay/aiV2PendingQuestions;
migrate.ts + migration files; presence, youtubeImportGuard/Scratch, deepgram.ts (key
hygiene), audioMerge, transcriptRemap, config.ts, main.ts shutdown; catch-and-scrub sites
are deliberate confidentiality chokepoints; no unused router exports; `api/types.ts`
mirroring documented-deliberate; useSessionSocket reconnect; loginReturnPath/Stash;
UI primitives (Dialog/Popover/Tooltip/RadioGroup); vite/vitest configs (documented
lockstep mirrors); companion unit tests + harness; e2e sleeps all documented-deliberate;
`seededSession.ts` server-constant duplication documented-deliberate; biome config split;
no other unused deps. Deliberate patterns excluded by brief: mounted-hidden latch panels,
AiV2Panel session key, Escape defaultPrevented, global-key guard set, 503 latch,
Python-origin provenance headers, companion defensiveness, Tailwind cascade-archaeology
constants, three sanctioned lockstep mirrors.

---

## Disposition summary

- **Quick-fix track** (branch `quick-fixes-2026-07`, no OpenSpec): 1.2, 1.4–1.6, 1.8–1.12,
  1.15, 2.15, 2.16, 3.1–3.7, 3.10, 4.1–4.4, 5.2–5.5.
- **OpenSpec change `code-health-consolidation`**: 1.1, 1.3 (delta), 1.7 (delta), 1.13,
  1.14, 2.1–2.14, 3.8, 5.1, 5.6–5.10.
- **Accepted residual (OBS)**: 1.16–1.21, 3.9.

Raw per-slice agent reports are not retained; this document is the durable record.
Anchors follow the repo rule: **locate quoted code by content before editing — line
numbers go stale.**

---

## Gate addendum (2026-07-27, after fact-check + adversarial panel)

The `code-health-consolidation` gate re-dispositioned some of the above:

- The OS bucket was **split into two changes**: `code-health-consolidation` (head:
  1.1, 1.3, 1.7, 1.14, 2.2) and `code-health-tail` (everything else OS-dispositioned).
- **1.13 → OBS/roadmap** (gate ruling 2): the drafted cap would have violated the
  `ai-topics-chat` resume SHALL; any future cap needs a delta + touch-refresh.
- **3.8 reclassified**: the PUT `internal` branch is REACHABLE, not dead (a profile can
  define category id `internal` — validator reserves no ids); kept and pinned via a
  `code-health-tail` delta.
- **2.13 → OBS** (panel de-scope); **5.8's toast-API + path-encoding convergence →
  OBS** (gate ruling 3; `OkResponse` adoption kept); 5.9's unlisted leftovers recorded
  as OBS in `code-health-tail`'s design.
- Fact-check count corrections: the seed-chain duplication (5.10) spans ~9–12 files;
  the S14 companion casts are 2 of 3 sites; `authSetPrefs` is 2–3 statements.
