# API response conformance audit

Change: `web-api-shape-conformance` · spec: `web-api-response-conformance` · branch
`feat/web-api-shape-conformance` · dated 2026-07-27.

Method: design D6 (semantic enumeration — a grep count is a starting point, not acceptance
evidence) + D7 (answer the property "the emitted key set and value types for endpoint E, under
every branch", following spreads/passthroughs to the producing function, not stopping at the
router).

**This is the tracked deliverable required by D9.** It supersedes
`.apply/task-3.1-3.3-report.md`, which is a git-ignored scratch copy of the same content
produced while doing the enumeration. This file is the one that survives archival.

**Read-only audit.** No source or test file was modified to produce it; `git status --porcelain`
was empty throughout. Empirical observations came from three throwaway probe files kept
**outside** the repo (session scratchpad), run against the server's own integration harness
(`server/src/test/harness.ts` + `helpers.ts`) via a scratchpad vitest config. They are not
committed and are not part of the deliverable — the deliverable is this table plus the function
reads recorded in its "evidence read" column.

---

## 0. What a verdict means — read this before the table (D10)

- **`CONFORMS`** means **"the client type matches what the server actually emits."** It does
  **not** mean "what the server emits is intended, correct, or blessed." This audit is
  *descriptive* of the emission, not a ratification of it. A reader must not cite a `CONFORMS`
  row as evidence that the current shape is the right one to keep — only that the client
  currently agrees with it.
- **`CLIENT-WRONG`** means the client type contradicts the emission. The client is the side this
  change fixes (task 3.5); the server does not move.
- **`SERVER-WRONG`** means the emission contradicts a **documented statement** about that
  endpoint's response shape. **This verdict was reachable for almost none of this repo's
  endpoints, and the audit found zero instances of it** — see §7 for why, in full, and do not
  read "zero findings" as "the server was checked and found correct." It means the check had
  nothing to check against: `api-contract-freeze` (this repo's frozen-surface spec) documents the
  **route inventory** (the README endpoint table) and status-code/header semantics — it does not
  document response *shapes*. A handler therefore has nothing to contradict. The only in-repo
  shape *declarations* found were (a) the frozen Companion wire payload in
  `server/src/routers/companion.ts` (no web consumer — Companion is its own client) and (b) doc
  comments in `web/src/api/types.ts`, which describe the server's observed behavior from the
  client side and do not constrain the server. Neither gives `SERVER-WRONG` anything to fire on
  for the endpoints this audit actually covers.
- Where an emission depends on the **caller**, on **stored data**, or on a **branch**, the row
  records the dependency instead of asserting a single invariant shape (per the "shape authority"
  requirement in `specs/web-api-response-conformance/spec.md`).

---

## 1. Population (a) — direct `apiFetch<T>` calls

**Count: 44 sites** across 10 files (all under `web/src/api/hooks/`).

Enumeration method: `grep -rn "apiFetch" web/src --include=*.ts --include=*.tsx`, minus test
files, minus the definition in `client.ts`, minus the *unresolved* `apiFetch<T>` inside
`fetchAdmin` (that occurrence is the wrapper, not a site — it is counted in population (b)). Each
hit was then opened and read to confirm it is a real call with a concrete type argument. The grep
was the *starting point*, not the acceptance evidence: every row in §5 was verified by reading the
producing server function end-to-end (column "evidence read").

Reconciliation with `design.md`'s "45 call sites / 46 occurrences": 44 concrete sites + the
wrapper's unresolved `apiFetch<T>` = 45; +1 for the `client.ts` definition = 46. Consistent.

| file | sites |
|---|---|
| `web/src/api/hooks/useAudio.ts` | 6 |
| `web/src/api/hooks/useEvents.ts` | 4 |
| `web/src/api/hooks/useProfile.ts` | 3 |
| `web/src/api/hooks/useSessionStatus.ts` | 1 |
| `web/src/api/hooks/useSessions.ts` | 8 |
| `web/src/api/hooks/useShowCategories.ts` | 1 |
| `web/src/api/hooks/useTeams.ts` | 9 |
| `web/src/api/hooks/useTopics.ts` | 5 |
| `web/src/api/hooks/useTranscriptWords.ts` | 5 |
| `web/src/api/hooks/useTransport.ts` | 2 |

## 2. Population (b) — assertions through the local generic wrapper `fetchAdmin<T>`

**Count: 6 call sites** (1 with an explicit type argument, 5 with none), all in
`web/src/pages/admin-users/AdminUsersPage.tsx`. The wrapper is defined at lines 14–22 and forwards
to `apiFetch<T>`; `grep 'apiFetch<'` sees only the unresolved `apiFetch<T>` inside it, which is
exactly why the `memberships` crash (this change's origin) was invisible to a textual count (D6).

Enumeration method: read `AdminUsersPage.tsx` in full and listed every `fetchAdmin(` call.

| site | endpoint | explicit type |
|---|---|---|
| `AdminUsersPage.tsx:45` (`loadAll`) | `GET /api/admin/users` | `AdminDataResponse` |
| `AdminUsersPage.tsx:61` (`createTeam`) | `POST /api/admin/studios` | none (inferred `unknown`) |
| `AdminUsersPage.tsx:83` (`deleteTeam`) | `DELETE /api/admin/studios/:id` | none |
| `AdminUsersPage.tsx:95` (`addMembership`) | `POST /api/admin/users/:id/memberships` | none |
| `AdminUsersPage.tsx:107` (`removeMembership`) | `DELETE /api/admin/users/:id/memberships/:sid` | none |
| `AdminUsersPage.tsx:121` (`toggleDisabled`) | `POST /api/admin/users/:id/{disable,enable}` | none |

## 3. Population (c) — untyped `apiFetch(…)` calls (no type argument)

**Count: 6 sites.** Enumeration method: the same full grep, filtered to calls with no `<…>`. All
six discard the response entirely (`.catch(() => {})` / `await` with the value unused), so the
inferred `unknown` never reaches a consumer. They are enumerated for phase 5's repo-invariant
guard, not because any of them is a mismatch.

| site | endpoint | response use |
|---|---|---|
| `api/hooks/useCompanionPresence.ts:17` | `POST /api/companion/presence` | discarded |
| `pages/index/components/NewSessionModal.tsx:141` | `PUT /api/profile` | discarded |
| `pages/index/components/SessionWorkspace.tsx:226` | `POST …/transport/stop` | discarded (fire-and-forget) |
| `pages/index/components/YouTubeImportErrorModal.tsx:28` | `POST …/archive` | discarded |
| `pages/index/components/YouTubeImportErrorModal.tsx:29` | `DELETE /api/sessions/:id` | discarded |
| `pages/index/hooks/useRecoveryStopWarning.ts:75` | `POST …/events` | discarded |

## 4. Population (d) — raw `fetch(…)` / `JSON.parse` ingresses

Enumeration method: `grep -rn "fetch(" web/src` minus `apiFetch`, plus `grep -rn "\.json()"`, plus
`grep -rn "JSON.parse"`, plus `grep -rn "EventSource\|sendBeacon\|XMLHttpRequest"`; each hit opened
and read. **Count: 16 ingresses, of which exactly 1 gives a payload a client type by unchecked
assertion.** (Corrected from an initial count of 13 — three raw-network sites the same grep
spellings surface were originally omitted from this table; see d14–d16.)

| # | site | endpoint / source | how a type is acquired | in scope? |
|---|---|---|---|---|
| d1 | `aiV2/dashboardPersistence.ts:74` (`load`) | `GET …/ai/v2/dashboard` | `(await res.json()) as { config: DashboardConfig \| null }` — **unchecked assertion** | **YES — the only one** |
| d2 | `aiV2/dashboardPersistence.ts:53` (`readDetail`) | any non-2xx body | `as { detail?: unknown }` then `typeof === 'string'` guard | error probe, defensively narrowed |
| d3 | `aiV2/dashboardPersistence.ts:79` (`save`) | `PUT …/ai/v2/dashboard` | success body never read | no |
| d4 | `useSseTurn.tsx:77` (`extractErrorDetail`) | non-2xx of `…/ai/chat`, `…/ai/v2/design`, `…/ai/v2/answer` | `as { detail?: unknown }` + guard | error probe |
| d5 | `useSseTurn.tsx:201` (`delta` frame) | SSE frame | `as { text?: unknown }` + `typeof === 'string'` guard | runtime-guarded |
| d6 | `AiChat.tsx:80,93,101` (`tool`/`done`/`error` frames) | SSE frames | `as {…?: unknown}` + guards | runtime-guarded |
| d7 | `AiV2Design.tsx` `question`/`dashboard` frames | SSE frames | `parsePendingQuestion` / `parseProposedDashboardConfig` — full field-by-field runtime parsers (lines 137–225) | runtime-validated |
| d8 | `AiV2Design.tsx:288` (`error` frame) | SSE frame | `as { detail?: unknown }` + guard | runtime-guarded |
| d9 | `AiV2Design.tsx:324` (`submitAnswers`) | `POST …/ai/v2/answer` | success body never read | no |
| d10 | `TranscribeModal.tsx:21` | `GET …/transcribe.csv` | success → `res.blob()`; error → `JSON.parse(text) as { detail?: string }` | non-JSON success; error probe. **Endpoint is a permanent 503** (`transcribe.ts:88`) |
| d11 | `useAudioClips.ts:66` | `POST …/audio/segments/sync-from-disk` | response fully discarded | no |
| d12 | `shared/utils/waveformDecode.ts:35` | segment blob URL | `res.arrayBuffer()` | non-JSON |
| d13 | `useSessionSocket.ts:110` | WebSocket frames | `JSON.parse(ev.data)` | **WebSocket — explicit Non-Goal of this change** |
| d14 | `useSseTurn.tsx:165` (the `fetch` call site itself) | `POST …/ai/chat`, `…/ai/v2/design`, `…/ai/v2/answer` | **no type acquired at this site** — the raw `Response` is only branched on `res.status`/`res.ok`/`res.body`; its JSON body is read (and typed) downstream at d4 (error) and d5 (`delta` frame), not here | no verdict — nothing to type-check at the call site |
| d15 | `AudioRecorder.tsx:117` (`navigator.sendBeacon`) | `POST …/audio-recording-lease/release` | **no type acquired** — `sendBeacon` is fire-and-forget; there is no `Response` object and no return value to type | no verdict — nothing to type-check |
| d16 | `useCompanionPresence.ts:38` (`navigator.sendBeacon`) | `POST /api/companion/presence` | **no type acquired** — same as d15, fire-and-forget with no response handle | no verdict — nothing to type-check |
| — | `api/client.ts:29` | any non-2xx body | `as { detail?: unknown }` | the shared error probe itself |

---

## 5. Verdict table

Legend for "consumed vs declared": whether any component actually *reads* the declared-but-
divergent field — this is what separates a latent type lie from a live runtime bug.

| # | site (file) | endpoint | client shape | emitted shape | branch conditions | consumed vs declared | verdict | evidence read (functions read in full) |
|---|---|---|---|---|---|---|---|---|
| 1 | `useProfile.ts:8`, `:17` | `GET`/`PUT /api/profile` | `ProfilePayload` | 9 keys: `active_studio_id, active_show_id, active_studio{id,name,categories[]}, studios[], studio_settings, shows[], new_session_defaults, admin, auth` | **3 structurally distinct branches**: (i) `user===null && oauthConfigured` → empty studio, `studios:[]`, `shows:[]`; (ii) `user===null` → anonymous active studio; (iii) logged-in, itself sub-branching on `active===null` (no memberships) → `emptyActiveStudioApiDict()`. **All three emit the same key set**; only values differ. | key set conforms; see #2 for the one type defect inside it | **CLIENT-WRONG** (via #2 only) | `profileAssembler.profilePayload` (all 3 branches), `authSection`, `profileStudioForUser`, `studioToApiDict`, `emptyActiveStudioApiDict`, `showApiDict`, `allStudioSettingsForAllowedStudios`, `adminMeta`. Probed all 3 branches. |
| 2 | `useProfile.ts` → `ProfilePayload.active_studio.categories[]` | `GET /api/profile` | `Category` — `dropdown_options: DropdownOption[]` (`{label, needs_context}`) | `dropdown_options: string[]` | unconditional on this path; `[]` for non-DROPDOWN categories, so the defect is only *visible* when a DROPDOWN category exists | **NOT consumed** — nothing in `web/src` reads `profile.active_studio` beyond `active_studio_id`. Latent. | **CLIENT-WRONG** | `studioToApiDict` (`studio.ts:365`) → `CategoryDef.dropdown_options: string[]` (`studio.ts:16`) → `blobToProfile`'s `optLabels: string[]` (`studio.ts:326`). Probed: `"dropdown_options":["Lav","Boom"]`. |
| 3 | `useShowCategories.ts:8` | `GET /api/sessions/:id/show-categories` | `ShowCategoriesResponse` = `{categories: Category[], show_name, show_code}` | `{categories: [{id,label,color,type,dropdown_options,on_label,off_label}], show_name, show_code}` — `dropdown_options` is `{label,needs_context}[]` **only when `type === 'DROPDOWN'`**, else `[]` | **stored-data dependent**: `getSessionShowCategories` returns an unvalidated `JSON.parse` of `shows.categories_json`; `showCategoriesApiShape` then coerces every field (`String(...)`, `?? ''`), so a malformed stored row degrades rather than breaking the shape. `type` is `String(o.type).toUpperCase()` — **not constrained to the 4-member union at read time**; it is constrained at every *write* (`validateCategoriesList`). | `dropdown_options[].label` **IS consumed** (`CategoryButtonStrip.tsx:162`) and is correct here | **CONFORMS** (with the stored-data caveat above) | `showCategoriesApiShape` + `dropdownOptionsApiShape` (`showsStore.ts:57–93`), `getSessionShowCategories` (`sessionIndexStore.ts:205`), `validateCategoriesList` (`studio.ts:214–288`), all `categories_json` write paths (`profile.ts:82`, `shows.ts:67`, `showsStore.updateShowFields`). Probed. |
| 4 | `useProfile.ts:31` | `POST /api/shows` | `{ show: Show }`, `Show.categories: ShowCategory[]` | `{show: showApiDict(row)}` — `categories` is the **verbatim `JSON.parse` of the DB column**, no read-side validation | **stored-data dependent** (D7's named case). Every write path funnels through `validateCategoriesList`, whose output is exactly `{id,name,color,type,dropdown_options:{label,needs_context}[],on_label,off_label}` — matching `ShowCategory` (whose `label` is optional and is *not* emitted). A row written outside those paths would pass through unchecked. | `Show.categories` consumed by `HomeSettingsModal:99` and `EventButtonsTable:223`, both via `c.name ?? c.label ?? ''` | **CONFORMS** (branch: only for rows written through `validateCategoriesList`) | `showApiDict` + `categoriesListFromShowRow` (`showsStore.ts:9–54`), `validateCategoriesList`, `createShow`, `updateShowFields`. Probed. |
| 5 | `useSessions.ts:16` | `GET /api/sessions` | `SessionsResponse {active: Session[], archived: Session[]}` | `{active:[…], archived:[…]}`, entries from `serializeSessionEntry` (19 keys) | partition by `row.archived`; `{active:[],archived:[]}` short-circuit when no effective studio / no active show | see #7 for the nullability defect | **CLIENT-WRONG** (via #7) | `serializeSessionEntry`, `sessionStatusUi`, `listRuntimeTotalFrames`, `transportTimecode`, `formatRuntimeHms`, `sessionDeckDisplayTitle`. Probed. |
| 6 | `useSessions.ts:64` | `GET /api/sessions/:id` | `Session` | same 19 keys (shared `serializeSessionEntry` — the single builder, by design) | none beyond #7 | see #7 | **CLIENT-WRONG** (via #7) | as #5. Probed: all 19 keys present. |
| 7 | `Session` nullability (`useSessions.ts:16,64,83,92`) | `GET /api/sessions`, `GET /api/sessions/:id` | `show_id: string`, `show_code: string`, `show_name: string`, `created_at_utc: string` | `(s.show_id as string\|null) ?? null`, `?? null`, `?? null`, `s.created_at_utc ? isoZ(…) : null` | **data dependent** — nulls come from the LEFT-JOINed show row / an absent `created_at_utc` | `created_at_utc` **IS consumed** (`RecentSessionsList.tsx:162`, `HomeRoute.tsx:85`, both via `s.episode_date ?? s.created_at_utc` → `fmtDateOnly`); `show_code`/`show_name`/`show_id` not read off `Session` | **CLIENT-WRONG** (nullability) | `serializeSessionEntry` + `getSessionJoinedRow`/`listSessionsForShow` column list |
| 8 | `useSessions.ts:83` | `POST /api/sessions` | `Session` (19 required keys) | **7 keys only**: `{id, title, frame_rate, start_offset_frames, show_id, episode, notes}` | none | only `created.id` is read (`NewSessionModal.tsx:164`) — which *is* emitted. Latent. | **CLIENT-WRONG** | `sessions.ts` POST handler read in full. Probed: `{"id":…,"title":"ATS - 2","frame_rate":24,"start_offset_frames":0,"show_id":…,"episode":"2","notes":""}` |
| 9 | `useSessions.ts:92` | `PUT /api/sessions/:id` | `Session` | **4 keys only**: `{id, title, frame_rate, start_offset_frames}` | none | nothing read (`RecentSessionsList.tsx:239` ignores the result). Latent. | **CLIENT-WRONG** | `sessions.ts` PUT handler + `updateSessionIndex`. Probed. |
| 10 | `useSessionStatus.ts:26` | `GET /api/sessions/:id/status` | `SessionStatus` (23 fields) | 21 keys — **missing `timecode_total_frames`, `start_offset_frames`, `audio_segment_count`**; adds `audio_recording_lease_age_sec` (undeclared, tolerated) | none | none of the three missing fields is read anywhere in `web/src`. Latent. | **CLIENT-WRONG** | `events.ts` `/status` handler, `TransportStore.statusLive`, `LeaseStore.leaseStatus`, `transportStateDict`. Probed. |
| 11 | `useEvents.ts:34` | `GET /api/sessions/:id/events` | `EventsResponse {events, total, logged_event_count, offset, limit}` | exactly those 5 keys | `maybeRelinkOrphans` runs only at `offset===0` (affects values, not shape) | conforms at the envelope level | **CONFORMS** | `events.ts` GET handler, `hub.listEvents`, `relinkMaps`. Probed. |
| 12 | `useEvents.ts:34,46,58` → `LogEvent` | `GET`/`POST /events`, `PUT /events/:id` | `LogEvent` (12 fields) | 10 keys — **missing `session_id` and `timecode_hms`** | `category_label`/`category_color` have **3 branches** in `enrichEventRpc`: `internal` → `('Internal','var(--muted)')`; category found in profile → `(cat.label, cat.color)`; **orphan** → `(snapshot-label ?? category, colSnap)` where `colSnap` is `string \| null` | `timecode_hms` NOT read (EventLogRow derives its own from `event.timecode`); `session_id` NOT read; `category_color` IS read but always coerced (`\|\| undefined`, `String(… \|\| '')`) | **CLIENT-WRONG** (2 missing keys + `category_color: string` vs emitted `string\|null` + `timecode: string` vs emitted `string\|null`) | `enrichEventRpc` (`studio.ts:459–496`) in full incl. all 3 branches; `eventRowToRpc` (`eventStore.ts:16–29`) for the `timecode`/`frame_rate`/`timecode_total_frames` nulls. Probed. |
| 13 | `useTransport.ts:15` | `POST /api/sessions/:id/transport/start` | `OkResponse {ok: boolean}` | `{is_rolling, current_take, roll_started_at_utc, elapsed_frames, timecode, timecode_total_frames, started}` — **no `ok` key at all** | `started: true` when the transport was stopped, `started: false` (early return, no DB write) when already rolling — both include the same 6 base keys | `ok` is never read: `TransportControls.tsx:337` calls `start.mutateAsync()` and discards the value | **CLIENT-WRONG** (known finding 1 — **CONFIRMED**) | `events.ts` transport/start handler, `SessionHub.startTake`, `TransportStore.startTake` + `transportStateDict`, `TransportState` (`sessionCore.ts:56`). Probed: `{"is_rolling":true,…,"started":true}`. Corroborated by the repo's own `SessionHub.int.test.ts:36–38`, which asserts `startBody.started === true`. |
| 14 | `useTransport.ts:20` | `POST /api/sessions/:id/transport/stop` | `OkResponse` | same 6 base keys + `stopped` (`true` when it was rolling, `false` early-return otherwise) — **no `ok`** | as above | not read (hook result discarded; `SessionWorkspace.tsx:226` also discards) | **CLIENT-WRONG** (known finding 1 — **CONFIRMED**) | `TransportStore.stopTake` in full. Probed: `{"is_rolling":false,…,"stopped":true}` |
| 15 | `useAudio.ts:25` | `GET /api/sessions/:id/audio/segments` | `AudioSegmentsResponse {segments: AudioSegment[], has_audio}` | `{segments:[…], has_audio}` | none | envelope conforms; see #16 | **CLIENT-WRONG** (via #16) | `audio.ts` GET handler, `AudioStore.listAudioSegments`, `audioRowToMeta`, `segmentApiDict`. Probed. |
| 16 | `useAudio.ts:25,105` → `AudioSegment` | `GET`/`POST …/audio/segments` | `AudioSegment` (12 fields) | 9 keys — **missing `session_id`, `duration_sec`, `file_path`**. `AudioSegmentMeta` has no `duration_sec`/`file_path` at all; `r2_key` exists but is deliberately not emitted | none | **`duration_sec` IS consumed** — `useAudioClips.ts:93` does `Number(s.duration_sec)`, which is always `NaN`, so the `Number.isFinite && >0` guard always fails and every segment falls through to the `HTMLAudioElement` probe. The "server-provided duration wins" fast path is **dead code today**. `session_id`/`file_path` unread. | **CLIENT-WRONG** (live, but degrades gracefully) | `segmentApiDict` (`audio.ts:16–28`), `AudioSegmentMeta` (`audioStore.ts:8`), `audioRowToMeta`, `useAudioClips` effect (`useAudioClips.ts:85–125`). Probed both GET and POST. |
| 17 | `useAudio.ts:34` | `POST …/audio-recording-lease` | `OkResponse` | `{ok: true}` (409 on conflict) | none | not read | **CONFORMS** | `events.ts` handler, `LeaseStore.claimLease` |
| 18 | `useAudio.ts:57` | `POST …/audio-recording-lease/heartbeat` | `OkResponse` | `{ok}` — **`ok` can be `false`** (200, not an error) when the caller doesn't hold the lease | boolean depends on lease holder | not read — **so a lost lease is silently ignored by the client** (behavioural note, not a shape defect) | **CONFORMS** | `events.ts` handler, `LeaseStore.heartbeatLease` |
| 19 | `useAudio.ts:67` | `POST …/audio-recording-lease/release` | `OkResponse` | `{ok: true}` | none | not read | **CONFORMS** | `events.ts` handler |
| 20 | `useAudio.ts:78` | `PUT …/audio/segments/:id/waveform` | `OkResponse` | `{ok: true}` (404 if unknown segment) | none | not read | **CONFORMS** | `audio.ts` PUT handler |
| 21 | `useEvents.ts:70` | `DELETE …/events/:id` | `OkResponse` | `{ok: true}` (404 if missing) | none | not read | **CONFORMS** | `events.ts` DELETE handler. Probed the 404 path. |
| 22 | `useSessions.ts:101` | `POST …/archive` | `OkResponse` | `{ok: true, archived: true}` — extra key, additively tolerated | none | not read | **CONFORMS** | `sessions.ts` handler. Probed. |
| 23 | `useSessions.ts:110` | `POST …/restore` | `OkResponse` | `{ok: true, archived: false}` | none | not read | **CONFORMS** | as above. Probed. |
| 24 | `useSessions.ts:124` | `DELETE /api/sessions/:id` | `OkResponse` | `{ok: true, hidden: true}` | none | not read | **CONFORMS** | `sessions.ts` handler |
| 25 | `useSessions.ts:141` | `POST …/youtube-import` | `OkResponse` | `{ok: true}` on success; 503/400/409/502 otherwise | success only after the whole import composite | not read | **CONFORMS** | `sessions.ts` youtube-import handler read in full (all guard/rollback paths) |
| 26 | `useTeams.ts:42` | `GET /api/teams/:id` | `TeamDetail` with `invites?: TeamInvite[]` | `{id, name, role, enabled_admin_count, members[]}` **plus `invites[]` iff `role === 'admin'`** | **caller-dependent** (D7's named case) — the field is attached only inside `if (role === 'admin')` | `invites` read by `TeamCard`; the optional marker is correct | **CONFORMS** (caller-dependent, correctly modelled) | `teams.ts` GET handler, `authListTeamMembers` (`authStore.ts:265–284`), `authListInvitesForTeam`, `requireTeamMember`. Probed **both** branches: admin body has `"invites":[]`, member body has no `invites` key. |
| 27 | `useTeams.ts:56` | `POST /api/teams` | `TeamCreateResponse {id,name,role}` | `{id, name, role:'admin'}` | none | consumed | **CONFORMS** | `teams.ts` POST handler. Probed. |
| 28 | `useTeams.ts:67` | `PATCH /api/teams/:id` | `TeamRenameResponse {id,name}` | `{id, name}` | none | consumed | **CONFORMS** | `teams.ts` PATCH handler. Probed. |
| 29 | `useTeams.ts:113` | `POST …/members/:uid/role` | `TeamRoleChangeResponse {ok, role}` | `{ok:true, role}` — same shape on the idempotent early return and the real mutation | 2 paths, identical shape | consumed | **CONFORMS** | `teams.ts` role handler, `guardedAgainstLastAdmin`, `wouldStripLastEnabledAdmin`. Probed. |
| 30 | `useTeams.ts:78,90,102,125,135` | `DELETE /api/teams/:id`, `POST …/invites`, `DELETE …/invites/:email`, `DELETE …/members/:uid`, `POST …/leave` | `OkResponse` ×5 | `{ok: true}` ×5 | invite POST is deliberately uniform across the "existing user → membership" and "no user → pending invite" branches | not read | **CONFORMS** ×5 | all five `teams.ts` handlers read in full |
| 31 | `useTopics.ts:17` | `GET …/topics` | `{topics: SessionTopic[]}` | `{topics: […]}` | none | envelope conforms; see #33 | **CLIENT-WRONG** (via #33) | `transcribe.ts` GET handler, `TopicStore.listTopics`, `topicRow` |
| 32 | `useTopics.ts:28` | `POST …/topics/generate` | `{topics: SessionTopic[]}` | `{topics: hub.listTopics()}` on success; 503 unconfigured / 400 no-transcript / 409 busy / 502 failure otherwise | success requires `outcome.ok && newIds.length >= 1`; the failure path deletes only this run's topics and throws | see #33 | **CLIENT-WRONG** (via #33) | `transcribe.ts` topics/generate handler read in full incl. the crash-safe swap |
| 33 | `useTopics.ts:17,28,44,67` → `SessionTopic` | all topics endpoints | `SessionTopic` — 8 fields incl. `session_id: string` | 7 keys: `{id, session_time, duration_sec, topic_level, summary, ordinal, created_at_utc}` — **no `session_id`**. Unlike transcript-words, the topics routes return the store row *verbatim* with no `{...row, session_id}` spread | none | `session_id` not read anywhere. Latent. | **CLIENT-WRONG** | `Topic` (`topicStore.ts:8`), `topicRow`, `listTopics`, and all four `transcribe.ts` topic handlers (`c.json(topic)` / `c.json(row)` / `c.json({topics: …})`). Probed: `POST /topics` → no `session_id`. |
| 34 | `useTopics.ts:79` | `DELETE …/topics/:id` | `void` | HTTP **204, empty body, no `content-type`** → `apiFetch` takes the `res.text()` branch and returns `''` cast to `void` | 404 if missing | not read | **CONFORMS** | `transcribe.ts` DELETE handler + `apiFetch`'s content-type branch (`client.ts:37–39`) |
| 35 | `useTranscriptWords.ts:11,23` | `GET`/`POST …/transcript-words[/generate]` | `{words: TranscriptWord[]}` | `{words: words.map(w => ({...w, session_id}))}` | generate: 503 unconfigured, 409 in-flight, 400/502 failure paths — success shape identical to GET | consumed (`start_sec`, `word`, `speaker`, …) | **CONFORMS** | `transcribe.ts` GET + generate handlers, `TranscriptStore.listTranscriptWords`, `wordRow`, `TranscriptWord` (`transcriptStore.ts:8`) — the spread's source shape confirmed at the producer, per D7. Probed. |
| 36 | `useTranscriptWords.ts:34,52` | `POST`/`PATCH …/transcript-words[/:id]` | `TranscriptWord` (9 fields) | `{...word, session_id}` = exactly those 9 | POST returns 201 | consumed | **CONFORMS** | as #35. Probed: 201 body has all 9 incl. `session_id`. |
| 37 | `useTranscriptWords.ts:64` | `DELETE …/transcript-words/:id` | `void` | 204, empty body | 404 if missing | not read | **CONFORMS** | `transcribe.ts` DELETE handler |
| 38 | `AdminUsersPage.tsx:45` (pop. b) | `GET /api/admin/users` | `AdminDataResponse {studios_catalog: AdminStudio[], users: AdminUser[]}` | `{studios_catalog:[{id,name,builtin}], users:[{id,email,given_name,family_name,picture_url,created_at_utc,disabled,studios:[{id,name}]}]}` — `picture_url`/`created_at_utc` undeclared, additively tolerated | none | `studios`, `email`, `given_name`, `family_name`, `disabled`, `id` all consumed | **CONFORMS** (after the phase-1 fix; this is the site the change exists for) | `admin.ts` GET handler in full, `studioNamesDict`, `studioOrderTuple`, `authListUsersAdmin`, `authListStudioIdsForUser`. Probed with 2 seeded users. |
| 39 | `AdminUsersPage.tsx:61,83,95,107,121` (pop. b) | 5 admin mutation endpoints | none (inferred `unknown`) | `{studio: {id,name,builtin}}` for `POST /admin/studios`; `{ok:true}` for the other four | none | all five discard the response | **CONFORMS** (vacuously — no type is asserted) | `admin.ts` handlers read in full |
| 40 | pop. (c) ×6 | see §3 | none | see the handlers above | — | all discard | **CONFORMS** (vacuously) | the six call sites read in context |
| 41 | `dashboardPersistence.ts:74` (pop. d1) | `GET /api/sessions/:id/ai/v2/dashboard` | `{ config: DashboardConfig \| null }` | `{config: stored ? stored.config : null}` | `null` iff no dashboard row exists for `PRIMARY_DASHBOARD_ID`; 503 when AI v2 unconfigured; 404 masked for unauthorized/device-token callers | `config.widgets` / `config.interactions` consumed by the editor | **CONFORMS** | `aiV2.ts` GET handler, `DashboardStore.getDashboard`/`dashboardRow`, `dashboardConfigSchema`+`widgetLayoutSchema`+`dashboardInteractionSchema` (`aiV2/catalog.ts`), web `widgetTypes.ts` — `WIDGET_TYPES` and `INTERACTION_KINDS` compared element-by-element and are **identical**; the config is schema-validated on every write path, so the read-side assertion is backed by a write-side check |
| 42 | `TranscribeModal.tsx:21` (pop. d10) | `GET …/transcribe.csv` | none (blob) | **always 503 `{detail}`** — the handler is a deliberate permanent stub | unconditional | error text rendered | **CONFORMS** (no shape asserted) | `transcribe.ts:88–91` |

### `OkResponse` and `void` sites, explicitly enumerated (task 3.3)

**18 sites: 16 `OkResponse` + 2 `void`.** Verdicts as in §5 above; summarized here because the
task asked for an explicit per-site verdict and because the pre-gate draft's claim that they are
"trivially safe" was false.

| # | site | verdict |
|---|---|---|
| 1 | `useAudio.ts:34` lease claim | CONFORMS |
| 2 | `useAudio.ts:57` lease heartbeat | CONFORMS (note: `ok` can legitimately be `false`) |
| 3 | `useAudio.ts:67` lease release | CONFORMS |
| 4 | `useAudio.ts:78` waveform PUT | CONFORMS |
| 5 | `useEvents.ts:70` delete event | CONFORMS |
| 6 | `useSessions.ts:101` archive | CONFORMS (extra `archived` tolerated) |
| 7 | `useSessions.ts:110` restore | CONFORMS (extra `archived`) |
| 8 | `useSessions.ts:124` delete session | CONFORMS (extra `hidden`) |
| 9 | `useSessions.ts:141` youtube-import | CONFORMS |
| 10 | `useTeams.ts:78` delete team | CONFORMS |
| 11 | `useTeams.ts:90` invite | CONFORMS |
| 12 | `useTeams.ts:102` revoke invite | CONFORMS |
| 13 | `useTeams.ts:125` remove member | CONFORMS |
| 14 | `useTeams.ts:135` leave team | CONFORMS |
| 15 | **`useTransport.ts:15` transport/start** | **CLIENT-WRONG** |
| 16 | **`useTransport.ts:20` transport/stop** | **CLIENT-WRONG** |
| 17 | `useTopics.ts:79` delete topic (`void`) | CONFORMS — 204 + empty body + no `content-type` takes `apiFetch`'s `res.text()` branch, returning `''` as `void`; nothing reads it |
| 18 | `useTranscriptWords.ts:64` delete word (`void`) | CONFORMS — same |

---

## 6. `CLIENT-WRONG` findings — implementer's list (task 3.5 fixes these)

Nine findings. Two are the pre-declared ones (CW-1, CW-2), both **independently confirmed**, not
taken on trust. Seven are new.

### CW-1 — `transport/start` / `transport/stop` are not `OkResponse` *(known finding 1 — CONFIRMED)*

- **Sites:** `web/src/api/hooks/useTransport.ts:15` and `:20`.
- **Emitted:** `{is_rolling: boolean, current_take: number, roll_started_at_utc: string|null,
  elapsed_frames: number, timecode: string, timecode_total_frames: number}` plus `started: boolean`
  (start) or `stopped: boolean` (stop). No `ok` key on any path.
- **Fix:** replace `OkResponse` with two response types mirroring `TransportState` +
  the branch flag, e.g. `TransportStartResponse` (`… & {started: boolean}`) and
  `TransportStopResponse` (`… & {stopped: boolean}`). Do **not** collapse them into one type with
  both flags optional unless the fixture check is written to tolerate that.
- **Consumers needing updates: none.** `TransportControls.tsx:337` awaits `start.mutateAsync()` and
  discards the value; `SessionWorkspace.tsx:226`'s stop is untyped and fire-and-forget. This is a
  pure type correction — no component logic changes.

### CW-2 — `Category.dropdown_options` is two different shapes *(known finding 2 — CONFIRMED)*

- **Sites:** `ProfilePayload.active_studio.categories: Category[]` (`useProfile.ts:8,17`) vs
  `ShowCategoriesResponse.categories: Category[]` (`useShowCategories.ts:8`).
- **Emitted:** `/api/profile` → `dropdown_options: string[]` (`studioToApiDict` copies
  `CategoryDef.dropdown_options`, which `blobToProfile` builds as bare label strings).
  `/show-categories` → `dropdown_options: {label, needs_context}[]` (`showCategoriesApiShape` →
  `dropdownOptionsApiShape`), and `[]` for any non-DROPDOWN category.
  `GET /api/studio` (`studioToApiDict`, no web caller) emits the `string[]` form too.
- **Fix (per tasks 3.5):** split the type. Keep `Category` (with `DropdownOption[]`) for
  `ShowCategoriesResponse`; introduce a distinct type for `ProfilePayload.active_studio.categories`
  whose `dropdown_options` is `string[]`.
- **Consumers to update:** `CategoryButtonStrip.tsx:162` reads `opt.label` — it is fed by
  `useShowCategories`, so it stays on the `DropdownOption[]` type and needs **no** change beyond
  whatever the renamed type requires. `EventButtonsTable.tsx` constructs `{label, needs_context}`
  but operates on `ShowCategory`/`EventButtonDraft`, not on `active_studio.categories` — verify, do
  not assume, when applying. Plus their tests.
- **Live/latent:** latent on the profile side — **nothing in `web/src` reads
  `profile.active_studio` beyond `active_studio_id`**, which is why a fresh install never sees it.
  This is also why the rejected runtime-validation design would have 503'd the whole SPA on an
  invisible field (panel finding, `design.md`).

### CW-3 — `SessionStatus` declares three fields the server never emits

- **Site:** `web/src/api/hooks/useSessionStatus.ts:26`.
- **Missing:** `timecode_total_frames`, `start_offset_frames`, `audio_segment_count`.
  (The response also carries an undeclared `audio_recording_lease_age_sec`, which is fine.)
- **Fix:** delete the three fields from `SessionStatus`.
- **Consumers to update: none** — no component reads any of the three. Latent.

### CW-4 — `LogEvent` declares two unemitted fields and two over-narrow types

- **Sites:** `useEvents.ts:34, 46, 58` (and every `LogEvent` reader downstream).
- **Missing:** `session_id`, `timecode_hms`.
- **Over-narrow:** `category_color: string` — `enrichEventRpc`'s orphan branch emits `null` when
  the event's category is absent from the profile and its `al_category_color_snapshot` is missing
  or not `#RRGGBB`. `timecode: string` — `eventRowToRpc` emits `null` when
  `timecode_total_frames` is NULL (`frame_rate` is already correctly `number | null` for the same
  reason).
- **Fix:** drop `session_id` and `timecode_hms`; widen `category_color` and `timecode` to
  `| null`.
- **Consumers to update:** widening `category_color` should typecheck unchanged — every reader
  already coerces (`EventLogRow.tsx:133` `event.category_color || undefined`;
  `Timeline.tsx:474,744,805`, `TimelineMarkers.tsx:60`, `MarkerNav.tsx:93` all `String(… || '')`).
  Widening `timecode` will surface at `EventLogRow.tsx:192,216,267`
  (`formatTimecodeHMS(event.timecode)`) and `EventLogSheet` — check `formatTimecodeHMS`'s parameter
  type before widening.

### CW-5 — `AudioSegment` declares three unemitted fields, one of which is actually read

- **Sites:** `useAudio.ts:25` (list) and `:105` (upload).
- **Missing:** `session_id`, `duration_sec`, `file_path`. `AudioSegmentMeta` has no `duration_sec`
  or `file_path` field at all; `r2_key` exists but `segmentApiDict` deliberately does not emit it.
- **Live consequence:** `useAudioClips.ts:93` reads `Number(s.duration_sec)` → always `NaN` → the
  "server-provided duration wins, skip the probe" fast path never fires, and every segment is
  probed via `HTMLAudioElement`. Correct output, wasted work, and a dead branch that reads as
  intentional.
- **Fix:** delete all three fields from `AudioSegment`.
- **Consumers to update:** `useAudioClips.ts:88–100` — removing `duration_sec` makes the
  `ingestedServerDurations` branch unreachable-by-type. Deleting that branch is a behaviour-
  preserving simplification, but it is a judgement call: **flag it rather than silently removing
  it**, since a future server change could legitimately start emitting a duration.

### CW-6 — `SessionTopic.session_id` is never emitted

- **Sites:** `useTopics.ts:17` (GET), `:28` (generate), `:44` (insert), `:67` (update).
- **Why:** the transcript-words routes spread `{...w, session_id: sessionId}`; the **topics
  routes do not** — they return the store row verbatim, and `Topic` (`topicStore.ts:8`) has no
  `session_id`.
- **Fix:** delete `session_id` from `SessionTopic`.
- **Consumers to update: none.** Latent.

### CW-7 — `POST /api/sessions` is typed `Session` but emits 7 of its 19 keys

- **Site:** `useSessions.ts:83`.
- **Emitted:** `{id, title, frame_rate, start_offset_frames, show_id, episode, notes}`.
- **Fix:** introduce a `SessionCreateResponse` for exactly those seven keys.
- **Consumers to update:** `NewSessionModal.tsx:164` reads `created.id` only — no change needed.

### CW-8 — `PUT /api/sessions/:id` is typed `Session` but emits 4 keys

- **Site:** `useSessions.ts:92`. **Emitted:** `{id, title, frame_rate, start_offset_frames}`.
- **Fix:** a `SessionUpdateResponse` of those four keys.
- **Consumers to update: none** — `RecentSessionsList.tsx:239` ignores the result.

### CW-9 — `Session` nullability on four fields

- **Sites:** `useSessions.ts:16` (list) and `:64` (detail) — both fed by `serializeSessionEntry`.
- **Over-narrow:** `show_id`, `show_code`, `show_name`, `created_at_utc` are all declared `string`
  while the serializer emits `null` for each (`?? null`, and
  `created_at_utc ? isoZ(new Date(...)) : null`).
- **Fix:** widen all four to `| null`.
- **Consumers to update:** `created_at_utc` is read at `RecentSessionsList.tsx:162` and
  `HomeRoute.tsx:85` via `s.episode_date ?? s.created_at_utc` handed to `fmtDateOnly` — check
  `fmtDateOnly`'s signature accepts `null` (it already receives `episode_date: string | null`, so
  it probably does). The other three are not read off `Session`.
- **Caveat for the fixture work (phase 4) — read this before assuming fixtures cover it:** a
  fixture captured from **seeded** test state will show non-null values for all four (a seeded
  session always has a joined show row and a `created_at_utc`), so a `.json`/`.ts` fixture check
  is **structurally unable to catch this class** — the nullable branch never fires against seeded
  data, regardless of how carefully the fixture is captured. This is a concrete instance of D1's
  named "production data variance" residual, not a gap in how phase 4 executes; phase 4 must not
  treat a passing fixture check as proof this nullability is covered.

---

## 7. `SERVER-WRONG` findings

**Zero.** This is a "the verdict was unreachable" outcome, not a "the server was checked and
passed" outcome — see §0 for the distinction and do not conflate the two. Per the spec's shape-
authority requirement and D10, `SERVER-WRONG` requires a **documented statement** about a response
shape for the emission to contradict, and this audit found no such document for any endpoint a web
client consumes: `api-contract-freeze` is a route inventory plus status-code/header semantics, and
the README table lists routes, not shapes. The only in-repo shape *declarations* are
`server/src/routers/companion.ts`'s frozen `/api/companion/state` payload (no web consumer — the
Companion module is the client) and doc comments in `web/src/api/types.ts`, which describe server
behaviour rather than constrain it. Neither endpoint intersects the 42-row verdict table above, so
the escalation path in task 3.6 has nothing to fire on for any of this audit's findings.

Two emissions are worth recording as **escalation-adjacent observations**, not verdicts, because a
future change may want to revisit them and this audit is where the next reader will look:

1. `/api/profile`'s `active_studio.categories[].dropdown_options` (`string[]`) and
   `/show-categories`'s (`{label, needs_context}[]`) are genuinely different shapes for the same
   conceptual field, produced by two different shapers. Nothing documents that this is intended.
   Under D10 the audit records the divergence and fixes the *client*; it does not assert the
   server is wrong.
2. `showApiDict` and `showCategoriesApiShape` both read `shows.categories_json` with **no read-side
   validation** (`JSON.parse` → `Array.isArray` at best). The shape only holds because every write
   path funnels through `validateCategoriesList`. That is an invariant maintained by convention,
   not by the read path.

---

## 8. What this enumeration might still miss

Stated deliberately, because the spec forbids treating a count as completeness evidence.

1. **Test files were excluded.** Sites inside `*.test.ts(x)` under `web/src` were not enumerated,
   on the reading that the audit universe is application code. Mocked fixtures in tests can still
   encode a wrong belief — that is precisely the failure `2ca5b1d` fixed — but they are covered by
   phase 4's fixture swap, not by this enumeration.
2. **WebSocket frames are out of scope by design.** `useSessionSocket.ts:110` `JSON.parse`s every
   WS message and the resulting union is asserted, not checked. WebSocket validation is an
   explicit Non-Goal, so no verdict was issued. If the class recurs, this is a likely site.
3. **Indirect type acquisition through helper signatures.** A JSON value can also acquire a type
   by being passed into a typed helper without any cast at the fetch seam. The enumeration searched
   for `fetch`/`apiFetch`/`.json()`/`JSON.parse`/`sendBeacon`/`EventSource`; a response threaded
   through a `Record<string, unknown>` into a typed function some modules later would not appear.
4. **Data-dependent nulls are under-covered.** Verdicts CW-4 and CW-9 turn on branches
   (`enrichEventRpc`'s orphan path, a session whose show row is gone) that seeded state does not
   produce. Those were established by reading the producing function, not by observation, and the
   phase-4 fixtures will not exercise them either.
5. **Dynamically constructed paths.** All enumerated endpoints use template literals with a
   literal prefix. A path assembled from a variable would not be attributable to an endpoint by
   reading.
6. **New-since-this-read code.** The enumeration reflects the tree at the time of this unit.
   Phase 5's repo-invariant guard (D5) exists precisely because a snapshot cannot bind the future.
7. **`CompanionRemoteCommand` / `CompanionCommandsWaitResponse`** are declared in
   `web/src/api/types.ts` but have **zero call sites in `web/src`** — dead client types (the real
   consumer is the Companion module, which mirrors the shapes in `companion/src/state.ts`). They
   are not response-consuming sites and carry no verdict; noted so phase 5's guard does not trip
   on them and so a later reader does not mistake their absence for an enumeration gap.
8. **`dashboardPersistence.ts:119,125` (`localStorageDashboardPersistence.load`) is a deliberate
   exclusion, not an oversight.** It does `JSON.parse(raw) as unknown` then, after an
   `Array.isArray((parsed as DashboardConfig).widgets)` narrowing check, `return parsed as
   DashboardConfig` — applying a `DashboardConfig` belief to unvalidated JSON, the same defect
   *class* as d1 (`dashboardPersistence.ts:74`, the only in-scope `CLIENT-WRONG`-eligible
   assertion in §4). It is excluded from §4's population because the source is **`localStorage`,
   not an API response** — this audit's universe is the server↔client wire, not browser-storage
   round-trips the client itself wrote. The exclusion is recorded here because phase 5's guard
   (matching `JSON.parse … as`) will hit this line: when it does, the guard needs a named
   exemption for it, not a surprise finding.

---

## 9. Captured fixtures — inventory and the `.json` vs `.ts as const` choice (phase 4)

Added by tasks 4.1–4.3. Recorded here rather than only in `.apply/` because D9's
reasoning applies unchanged: the per-endpoint format decision is a deliverable a future
reader will need, and `.apply/` does not survive archival.

Fixtures live at repo-root **`fixtures/api-responses/`** — outside both workspaces, because
the server captures them and the web tier consumes them, so a path under `server/src` or
`web/src` would assert an ownership that does not exist. Both `tsc` runs reach them by import
resolution; neither biome scope covers them, which is correct for generated output.

Captured by `server/src/routers/apiResponseFixtures.int.test.ts` (one dedicated suite, so
regeneration is one command over one file and the inventory is reviewable in one place) via
`npm run fixtures:capture -w server`. **Assert-only otherwise:** a missing or mismatched
fixture fails, is never written on the fly, and regeneration is refused outright under `CI`.

`.json` is the default. `.ts` + `as const` is the exception, taken **only** where the client
type reachable from the response contains a string-literal union, because a JSON import widens
the literal and produces a false positive (D4's verified wrinkle).

| fixture | endpoint / branch | format | reason |
|---|---|---|---|
| `adminUsers.json` | `GET /api/admin/users` | `.json` | `AdminDataResponse`/`AdminUser`/`AdminStudio`/`StudioBrief` — no union |
| `profileAnonymous.ts` | `GET /api/profile`, anonymous + oauth unconfigured | `.ts` | `ActiveStudioCategory.type`, `ShowCategory.type` (in `shows[]`) |
| `profileAuthenticated.ts` | `GET /api/profile`, logged in, two memberships | `.ts` | as above + `TeamMembershipBrief.role: TeamRole` |
| `profileLoggedOutOauth.ts` | `GET /api/profile`, logged out + oauth configured | `.ts` | same type, third branch of `profilePayload` |
| `showCreate.ts` | `POST /api/shows` | `.ts` | `Show.categories[].type` (`ShowCategory`) |
| `showCategories.ts` | `GET /api/sessions/:id/show-categories` | `.ts` | `Category.type` |
| `sessionsList.ts` | `GET /api/sessions` (active + archived) | `.ts` | `Session.session_status` |
| `sessionDetail.ts` | `GET /api/sessions/:id` | `.ts` | `Session.session_status` |
| `sessionCreate.json` | `POST /api/sessions` | `.json` | `SessionCreateResponse` — 7 keys, no union |
| `sessionUpdate.json` | `PUT /api/sessions/:id` | `.json` | `SessionUpdateResponse` — 4 keys, no union |
| `sessionStatus.json` | `GET /api/sessions/:id/status` | `.json` | `SessionStatus` — no union |
| `eventCreate.json` | `POST /api/sessions/:id/events` | `.json` | `LogEvent` — no union |
| `eventsList.json` | `GET /api/sessions/:id/events` | `.json` | `EventsResponse` — no union |
| `transportStart.json` | `POST …/transport/start` | `.json` | `TransportStartResponse` — no union |
| `transportStop.json` | `POST …/transport/stop` | `.json` | `TransportStopResponse` — no union |
| `audioSegmentCreate.json` | `POST …/audio/segments` | `.json` | `AudioSegment` — no union |
| `audioSegmentsList.json` | `GET …/audio/segments` | `.json` | `AudioSegmentsResponse` — no union |
| `transcriptWordCreate.json` | `POST …/transcript-words` (201) | `.json` | `TranscriptWord` — no union |
| `transcriptWordsList.json` | `GET …/transcript-words` | `.json` | `{words: TranscriptWord[]}` — no union |
| `topicCreate.json` | `POST …/topics` (201) | `.json` | `SessionTopic` — no union |
| `topicsList.json` | `GET …/topics` | `.json` | `{topics: SessionTopic[]}` — no union |
| `teamCreate.ts` | `POST /api/teams` | `.ts` | `TeamCreateResponse.role: TeamRole` |
| `teamDetailAdmin.ts` | `GET /api/teams/:id`, caller is a team **admin** | `.ts` | `TeamDetail.role` + `TeamMember.role`; this branch carries `invites` |
| `teamDetailMember.ts` | `GET /api/teams/:id`, caller is a plain **member** | `.ts` | same types; this branch has **no** `invites` key |
| `teamRename.json` | `PATCH /api/teams/:id` | `.json` | `TeamRenameResponse {id, name}` — no union |
| `teamRoleChange.ts` | `POST …/members/:uid/role` | `.ts` | `TeamRoleChangeResponse.role: TeamRole` |

Branch coverage taken deliberately, per task 4.2 and the "shape authority" requirement:
`/api/profile` all **three** branches of `profilePayload` (audit row 1), `/api/teams/:id` **both**
caller roles (row 26), `GET /api/sessions` both partitions, transport start **and** stop as two
separate types (so neither can pass by omitting the other's flag), and `enrichEventRpc`'s
resolved and `internal` category branches inside `eventsList.json`.

**Unions from task 4.3's list with no fixture, and why.**

- `CompanionCommandType` — `CompanionRemoteCommand` / `CompanionCommandsWaitResponse` have
  **zero** call sites in `web/src` (§8.7). They are not response-consuming sites; the real
  consumer is the Companion module, which mirrors the shapes in `companion/src/state.ts`. No
  fixture is captured, and phase 5's guard should treat them as dead client types, not as an
  unverified site.
- `ActiveStudioCategory.type` — a fourth `'BUTTON'|'DROPDOWN'|'TEXT'|'ON_OFF'` union created by
  phase 3's CW-2 split; not in 4.3's original list. Covered by the three `profile*.ts` fixtures.

**What these fixtures still cannot establish** (unchanged from §6 CW-9 and §8.4, restated here
because a green fixture check invites the opposite conclusion): the nullability class. A seeded
session always has a joined show row and a `created_at_utc`, and a seeded event always logs
against a category that exists, so `serializeSessionEntry`'s four `?? null` branches and
`enrichEventRpc`'s orphan branch never fire against any capture. Those two shapes remain
established by reading the producing function; the corresponding literals in
`web/src/api/types.conformance.test.ts` are labelled as source-reads rather than captures, and
they are the only hand-written values left in that file. This is D1's named production-data-
variance residual, not a defect in the capture.
