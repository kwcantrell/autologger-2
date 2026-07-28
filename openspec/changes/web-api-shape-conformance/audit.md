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
`web/src` would assert an ownership that does not exist. Only the **web** `tsc` run reaches
them, by import resolution; the server never imports a fixture — `server/src/test/apiFixtures.ts`
reads them as text — so they are outside `server/tsconfig.json`'s `include` and are not
type-checked there. Neither biome scope covers them, which is correct for generated output.

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

---

## 10. Residual (recorded, not fixed) — `fixtures/api-responses/_mutable.ts` is an unverified hinge

Found by the phase-4 fix-2 re-review (2026-07-28), recorded here rather than fixed because it
is mitigated, not a blocker.

`_mutable.ts` supplies `Mutable<T>`, which every generated `.ts` fixture imports to strip the
`readonly` that `as const` adds back on (§9's rationale). The generated header pins the **import
specifier** (`import type { Mutable } from './_mutable';`) via the byte-identical header/footer
check in `readFixture` (`server/src/test/apiFixtures.ts`) — but nothing pins that file's
**content**, and the server-side capture suite never reads it (it only reads the `.ts` fixtures
it captured, as text, to reconstruct and compare header/payload/footer). A conditional type in
`_mutable.ts` can therefore be edited to quietly defeat a conformance check while leaving the
capture suite green.

**Demonstrated, not hypothetical.** The re-reviewer added a field to `Session` that the server
never emits, then edited `Mutable<T>` with a surgical conditional targeting that field's type,
and three of `web/src/api/types.conformance.test.ts`'s conformance assignments went silent — no
`@ts-expect-error` fired, no fixture check failed.

**Why this is a residual, not a fix task:**

- `_mutable.ts` is **declared hand-written source** under D4 (the file's own header says so) —
  it is deliberately outside the "captured, never hand-authored" guarantee D2 establishes for the
  fixtures it supports, the same way `types.ts`'s interfaces are hand-written and checked
  *against* captures rather than captured themselves.
- The blunt version of this attack — `export type Mutable<T> = any;` — **is** caught: an `any`
  hinge would make every conformance assignment in `types.conformance.test.ts` trivially pass,
  including ones with a deliberate `@ts-expect-error`, so those guards would start failing to
  fail, which is itself an observable, test-visible break. Only a *surgical*, type-specific
  conditional evades detection, which raises the bar from "one careless edit" to "a targeted one
  aimed at a specific field."

No mechanism in this change's scope pins `_mutable.ts`'s content (e.g., a checksum or a
dedicated repo-invariant test asserting its exact text). If a future change wants to close this,
that is where it starts — a small, targeted guard rather than a redesign, since the file is one
line of load-bearing logic.

---

## 11. The repo-invariant guard (phase 5) — population, exemptions, and residual

Added by tasks 5.1–5.4: a web-tier conformance module
(`web/src/api/types.conformance.test.ts`, extended) that checks every captured fixture against
its client type, and a repo-invariant guard (`web/src/apiResponseShapes.repo.test.ts`, new) that
fails when a `web/src` site acquires a client type without either a conformance check or a
recorded exemption. This section is the durable record §5.5 of the plan of record requires: a
future maintainer asking "what isn't covered, and why" should get the answer here, not by
re-deriving it from `.apply/task-5.3-5.4-report.md` (git-ignored, does not survive archival).

### 11.1 Population totals

**120 response-consuming sites — 68 covered, 52 exempted, 0 unverified.**

*(Was 117 / 65 / 52 as first delivered. The phase-5 review found the covered set was being read
off the conformance module's `import type { … }` list — see 11.7 — and correcting it revealed
that `Show`, `Category` and `ActiveStudioCategory` had never been assigned a captured value at
all. The three direct assignments added to close that are the three new sites.)*

A site is *covered* only when **both** of the following hold for every client type it acquires:

1. the conformance module contains a `const x: T = <fixture binding>` declaration — the bare type
   name (or an array of it), initialised from a binding imported from `fixtures/api-responses/`,
   and expected to COMPILE. A name that is merely imported, used only inside a helper type such
   as `ExpectUndeclared<T, K>`, reached only through an indexed slice, or assigned under a
   `@ts-expect-error` directive is **not** checked against a real response and does not count;
2. the name resolves to `api/types` **from the site's own file**, so a locally declared type can
   never inherit a checked type's coverage by sharing its spelling.

Everything else must carry an individually reasoned exemption; there is no third, silent state.
The guard proves this isn't vacuous by construction: population and per-detector floors are
asserted at run time (120 actual against a 100 floor; per-detector floors for each of the six
site-shaped detectors plus the conformance-module's own detector), five canary sites must be
found by name, and a surplus exemption entry — one with no matching site, or an Nth entry on a
key that only N-1 sites match — is itself a test failure (a stale exemption is as much a lie
about the tree as an uncovered site).

### 11.2 The 26/26 fixture conformance check (task 5.1) and additive tolerance (task 5.2)

Every one of the 26 fixtures captured in phase 4 now carries at least one type-level assignment
against the client type its real call site names — verified mechanically by
`tsc --listFiles`, which reaches 27 of 27 files under `fixtures/api-responses/` (the 27th being
the hand-written `_mutable.ts` support module, not a fixture — see §9/§10). The check was
demonstrated to actually catch the class of bug this change exists for: reintroducing
`memberships: string[]` on `AdminUser`, making `TeamDetail.invites` required, mistyping a scalar,
and adding a required field to `TranscriptWord` each independently failed `tsc`, and each was
reverted to a clean build.

Additive tolerance — a fixture may carry fields the client type does not declare, and this must
not fail — is asserted from both sides, not merely enjoyed for free: the assignment compiling is
the tolerance itself (`AdminUser` vs. the fixture's undeclared `picture_url`/`created_at_utc`;
`SessionStatus` vs. `audio_recording_lease_age_sec`), and a second, branded `ExpectUndeclared<T,
K>` conditional type pins each tolerated key as *currently undeclared*, so that a future edit
that declares the field on the client type turns the tolerance check itself into a compile error
naming the key — rather than the check quietly continuing to pass for a reason that has nothing
to do with tolerance. That helper is in turn guarded against being reduced to a no-op: a third,
`@ts-expect-error`-paired assignment against an already-declared key confirms `ExpectUndeclared`
still resolves to its message tuple rather than passing everything through.

### 11.3 The 52 exemptions, grouped by kind

**One entry always means one site** — no file-wide, type-wide, or category-wide exemptions. A
blanket rule would let a genuinely new unverified site hide behind an old one, which is the
class of failure this guard exists to prevent (fourteen separate `OkResponse` entries below pay
for exactly this: two of the audit's own `OkResponse` sites, per CW-1, turned out not to conform,
and a blanket exemption would have hidden that). Every entry's `reason` must be ≥40 characters and
cites the audit row backing its verdict; a bare path is rejected by the guard's own tests.

"One entry, one site" is **enforced**, not merely intended (phase-5 review fix, 11.7). Entries are
*consumed* one per matching site, so N sites sharing a key require N entries and a surplus entry is
reported as stale; and each site's key carries the literal HTTP method found in its arguments, so
`DELETE /api/sessions/:id` and a later `PUT` on the same path are two keys rather than one. Under
the first delivery neither held: a single entry was an unbounded licence for every future site that
normalised to the same string, which for `{ok}`-shaped mutation endpoints is the common case.

| kind | count | why these are exempt rather than covered |
|---|---:|---|
| Shared seam/wrapper plumbing | 6 | `client.ts`'s `apiFetch<T>` declaration, its `fetch(url)` call, its error-probe `.json()`, and its unchecked `res.json() as Promise<T>` cast; `AdminUsersPage`'s `fetchAdmin<T>` declaration and its forwarding `apiFetch<T>(path)` call. An **unresolved** type parameter acquires no concrete shape — there is nothing to check a fixture against at the seam itself, only at its call sites (which are separately covered or exempted). |
| `apiFetch<OkResponse>` | 14 | Population (a)/(b) sites typed `OkResponse` with **no captured fixture** — phase 4's inventory captured none, per D3's "no fixture, no check" rule. Each cites its audit §5 row and the emitted body (e.g. lease claim `{ok:true}`, archive's extra `archived` key). Kept as 14 separate entries specifically so a *new* `OkResponse` site starts unverified — see CW-1. |
| `apiFetch<void>` | 2 | 204 + empty body + no `content-type`, so `apiFetch` takes its `res.text()` branch (`''` cast to `void`): topic delete, transcript-word delete. Nothing is asserted about an empty body. |
| Untyped `apiFetch(…)` | 6 | Population (c): no type argument, response discarded (`.catch(() => {})` or unused `await`). Enumerated because the guard's detector must see them (D5/D6), not because any is a mismatch. |
| Untyped `fetchAdmin(…)` | 5 | Population (b) minus the one typed call: four admin mutation endpoints plus create-team, all inferred `unknown` and discarded. |
| Raw `fetch(` request-half sites | 7 | The **request** side of an ingress acquires no type by itself — its typing site (if any) is a separate, independently listed row. Covers the SSE POST, the AI-v2 answer POST, the permanent-503 `transcribe.csv` stub, `dashboardPersistence`'s GET and PUT requests, the audio-clip sync-from-disk POST, and the waveform blob fetch (`arrayBuffer()`, not JSON). |
| `Response.json()` outside `apiFetch` | 3 | `dashboardPersistence`'s error-probe `.json()`, and `useSseTurn.extractErrorDetail`'s `.json()` — both narrowed by a runtime guard, not trusted as a client type. The third is `dashboardPersistence`'s own `.json() as { config: DashboardConfig \| null }` **ingress** (row 41, `d1`) — the one raw-`fetch` site that *is* `CONFORMS`, verified against the handler and cross-checked element-by-element against the write-side schema; still an exemption because it sits outside the conformance module's fixture mechanism, not because it is unverified. |
| `JSON.parse(` sites | 5 | `useSseTurn.safeJsonParse` (returns `unknown`, every consumer runtime-guarded); the `TranscribeModal` error-body probe; `useSessionSocket`'s WebSocket frame parse (WebSocket validation is an explicit Non-Goal — see 11.4); `perfDebug`'s localStorage debug-flag record; and **`dashboardPersistence`'s `localStorage` `JSON.parse(raw) as unknown`** — the deliberate exclusion named in §8.8: the source is browser storage this client itself wrote, not the wire, so it sits outside this audit's universe even though it is the same assertion *class* as the one `CONFORMS` raw-fetch site above. |
| `navigator.sendBeacon(` | 2 | Fire-and-forget calls with no `Response` object to type: the audio-lease release beacon and the Companion-presence-clear beacon. |
| Conformance-module source-read literals | 2 | The two hand-written values already named in §9 (CW-4's unreachable `enrichEventRpc` orphan branch, CW-9's four `?? null` fields) — labelled as source-reads, not evidence about the wire, per D1's production-data-variance residual. Exempted at the *conformance-module* level (detector 7) rather than at an application-code call site. |

**Total: 52**, cross-checked against the guard's own count.

**Why 52, not the ~28 the brief estimated.** The brief's six categories totalled roughly 28–30
entries. The 24-entry gap is **not** new discoveries about the tree — every one of the 24 is a
site the guard legitimately detects that the brief's list simply didn't enumerate: the 14
`OkResponse` + 2 `void` sites (16), the 6 seam/wrapper-plumbing sites, and 2 of the 7 raw-fetch
request-half sites (the `dashboardPersistence` GET/PUT requests specifically) — 16 + 6 + 2 = 24.
Blanket-exempting the `OkResponse` class instead of listing it site-by-site was considered and
rejected: that is the exact shortcut that let the `transport/start`/`transport/stop` mismatch
(CW-1) go unnoticed once already.

### 11.4 `CompanionRemoteCommand` / `CompanionCommandsWaitResponse` are dead types, not exemptions

These two client types (§8.7, §9) have **zero call sites** in `web/src` — their real consumer is
the Companion module, which mirrors the shapes independently in `companion/src/state.ts`. They
are deliberately **not** entries in the exemption list. An exemption is a statement about a site
("this site is unverified, and here is why that's acceptable"); these have no site to make that
statement about. Had they been encoded as exemptions anyway, the guard's own stale-exemption
check — which fails the suite the moment an exemption matches zero sites in the tree — would trip
on them permanently, for a reason unrelated to what that check exists to catch. Instead they are
a named `DEAD_CLIENT_TYPES` constant plus a standing assertion that they still produce zero
sites: if a future change starts consuming either type, that assertion fails (flagging the
now-false "dead" claim) *and* the new call site shows up as unverified in its own right — two
independent signals instead of one silently-stale entry.

### 11.5 The guard's blind spots — read before trusting it

Recorded in the guard's own file header too, so a reader meets them before relying on a green run.
**Ordered by how reachable each is by an ordinary refactor, largest first** — the point of this
list is that a reader can trust its ranking, and the first delivery's ranking was wrong (11.7).

1. **Indirect type acquisition — the largest remaining hole.** A JSON value threaded through as
   `unknown` into a typed helper several modules downstream acquires its client type with no
   `fetch`/`.json()`/`JSON.parse`/wrapper token anywhere near it, so no detector fires (§8.3).
   This is a structural limit of matching on deserialization syntax, not a tuning gap: closing it
   needs type-level analysis, not another pattern.
2. **Coverage is keyed by client type *name*, not by (site, endpoint).** The guard answers "has
   this type ever been checked against a real response?", not "is it checked against *this*
   endpoint's response?" A type that is genuinely conformant on the endpoint it was captured from
   passes silently the moment it is reused as the return type of a brand-new endpoint. Only this
   audit's per-row verdict table (§5) answers the endpoint-specific question, and it is a
   snapshot, not a standing check.
3. **Two sites can still share one key when the method cannot separate them.** The descriptor
   carries the literal HTTP method, which splits the common `{ok}`-mutation collisions; it does
   not split two calls on the same path with the *same* method, nor a call whose method arrives
   through a variable. Those sites are no longer *absorbed* — exemptions are consumed one per
   site, so the second surfaces as unverified — but the two entries are told apart only by their
   `reason` prose.
4. **`apiFetch` reached other than through a named import.** A namespace import
   (`import * as api from './client'` … `api.apiFetch<T>(…)`) or a re-export under a new name in a
   third module is invisible to the callee scan. `import { apiFetch as request }` *is* covered.
5. **Test files are outside the scan.** `*.test.ts(x)` and `test/` under `web/src` are excluded
   from the application-code walk (per §8.1); the one deliberate exception is the conformance
   module itself, parsed for its `const x: T = <fixture>` declarations and its source-read
   literals.
6. **A re-assertion downstream of an already-flagged parse is not a separate site.** Only the
   deserialization token itself (`JSON.parse(...)`, `.json()`) is detected; a second, unrelated
   `as SomeOtherType` two lines later on the same parsed value is invisible to the scan.
7. **Data-dependent branches are uncovered.** CW-9's nullability (a session missing its joined
   show row) and CW-4's `enrichEventRpc` orphan branch are real, confirmed divergences that no
   captured fixture reaches, because seeded test state never produces the branch that triggers
   them (§8.4, D1's production-data-variance residual). A covered site is not a verified branch.
8. **WebSocket is an explicit Non-Goal.** The one `JSON.parse(ev.data)` WS-frame site is exempted
   as such; a *second* WS parse site introduced later would still surface as its own unverified
   site rather than being silently absorbed into the same exemption.
9. **An exemption is only as good as its reason.** The guard forces every unchecked site to carry
   a recorded, non-trivial-length justification; it has no way to verify that the justification is
   *correct*. A careless or dishonest exemption for a real defect still passes the suite — the
   reason field is written for the next reviewer to read, not for the guard to adjudicate.

Two smaller items are already recorded in §8 and are not repeated in full here: prose mentions
inside comments are deliberately not sites (§8, matching `noAgentAuthoredMarkup.repo.test.ts`'s
own concession — though string and template literals are now masked before that test, so a URL's
`//` no longer hides the rest of its line), and a dynamically constructed path is detected as a
site but cannot be attributed to a specific endpoint (§8.5).

### 11.6 Guard demonstrated in both failure directions (task 5.4)

Not merely asserted — run. A planted new typed `apiFetch` site, a planted new local generic
wrapper (undeclared to the guard) plus its call site, and a planted raw `fetch(...)` with a body
assertion were each caught and named individually by file, line, detector, and acquired type, then
removed. Separately, the guard was shown non-vacuous when its *own* scan is broken: pointing its
file walk at a nonexistent extension failed 12 of its 17 tests (floors, canaries, and the
stale-exemption check all fire), while the headline "no unverified site" assertion passed
vacuously on the dead scan — which is exactly the failure mode the floor/canary checks exist to
catch. Disabling only the wrapper detector failed 5 tests, naming the disabled detector, the
`AdminDataResponse` canary that stopped being found through it, and the 6 `fetchAdmin` exemptions
that went stale as a result. Both probes were reverted; the working tree carried nothing but the
new guard file when this unit closed.

### 11.7 Phase-5 review — five silent gaps found by planting, and what closed them

The phase-5 reviewer planted nine synthetic response sites against the guard as first delivered.
**Five passed a fully green suite.** A guard with a silent gap is indistinguishable from one that
works, so each is recorded here with the mechanism that let it through.

| # | what slipped through | why | fix |
|---|---|---|---|
| C1 | A generic wrapper exported from its own module (`fetchTyped<T>` in `api/typedFetchPlant.ts`), called as `fetchTyped<PlantBResponse>(…)` from another file. Only two sites appeared, **both inside the wrapper's own file**; the call site carrying the concrete hand-transcribed type never appeared at all — and the two that did appear closely resemble two recorded exemptions, so a maintainer following the file's own precedent would exempt them and ship a wholly un-enumerated population. | Wrapper discovery ran **per file**. It worked only because `fetchAdmin` happens to be declared and called in the same file. This is exactly the blind spot **D6** exists to close, and it contradicted the header's own claim that a second `fetchAdmin` would bring its call sites in automatically. | Wrapper discovery hoisted into a **tree-wide pre-pass**: the union of `discoverWrappers` over every application file is collected before any file is scanned, then passed into every file's scan as extra callees. |
| C2 | A brand-new, never-audited `apiFetch<OkResponse>` on `sessions/:id` with `{ method: 'PUT' }` added to `useSessions.ts`. Suite stayed 17/17 green — it silently inherited the audited **DELETE**'s exemption. | The descriptor captured only the first argument, so `DELETE` and `PUT` on one path produced an identical key; and matching was Set membership, so N sites sharing a key were all exempted by one entry. This falsified the file's own load-bearing claim that "a NEW `OkResponse` site is covered by none of them" — and `OkResponse` is the bucket CW-1 hid in. | The literal `method: '…'` is now part of the site key, and exemptions are **consumed one-for-one**: N sites need N entries, and surplus entries are reported as stale with their counts. |
| C3a | A new file declaring its **own** `interface Session` and calling `apiFetch<Session>(…)`. Green — a wholly hand-transcribed new response type read as covered because it shared a name with a checked one. | `covered` meant "the name appears in the conformance module's `import type` list". | Coverage is now derived from detector 7's own parse, **and** a site's type must be imported from `api/types` in the site's own file. |
| C3b | A type added to `api/types.ts` and to the conformance module's import list, used **only** in an `ExpectUndeclared<…>` position. Green, and it marked every site repo-wide naming that type as covered, with zero assertion against any captured response. | Same mechanism. `audit.md` §11.5 claimed the guard answers "has this type ever been checked against a real response?"; it answered "is this name imported?". | A name counts only when a `const x: T = <fixture binding>` declaration assigns it a capture — bare name or array of it, and **not** under a `@ts-expect-error` directive. |
| I6 | A raw `fetch('https://…')` followed by `.json() as X` on the same line: the **typed read** was discarded, because the `.json()` index sits after the `//` in `https://`. Combined with exemptions whose reason reads "the typed read of its body is the `.json()` site below", a maintainer could write that reason for a site where no `.json()` entry exists. | `isProse` treated any `//` earlier on the line as a comment opener. | String and template literals are masked (contents blanked, offsets preserved) before the prose test. Masking only ever removes apparent comment openers, so the failure direction is the cheap, visible one. |

Two further fragilities were fixed at the same time. Wrapper *forwarding* detection matched
`apiFetch<T>` exactly against a fixed 1500-character slice, so `apiFetch<T[]>`, `apiFetch<T | null>`
and `apiFetch<Envelope<T>>` were not recognised — a `fetchList<T>(): Promise<T[]>` helper is the
most natural next wrapper in this codebase — and a wrapper whose forwarding call sat past the
cutoff was missed entirely; it now matches `apiFetch<… T …>` and reads the declaration's balanced
body. And `import { apiFetch as request }` + `request<T>(…)` produced **zero** sites; the local
binding name is now read from the import statement.

**What correcting C3 exposed.** Three types the guard had been counting as covered had never been
assigned a captured value: `Show` (checked only through the inline `{ show: Show }` annotation),
and `Category` / `ActiveStudioCategory` (present only in `@ts-expect-error` assignments, whose
whole point is that the assignment does *not* compile — the negative half of the CW-2 split with
no positive half). This was papered over by neither exemption nor silence: three direct
assignments were added to `api/types.conformance.test.ts` — `const show: Show = showCreate.show`,
and the two positive-direction category assignments against the two captures. All 27 client types
the conformance module names are now genuinely fixture-checked.

**Regression coverage.** The original mutation-check block used only **single-file** synthetic
trees, which is precisely why C1 went unnoticed. The committed block now includes multi-file
cases: a wrapper declared in one file and called from another (three variants — plain, `T[]`
forwarding, and a forwarding call past the old window), two sites on one path differing only in
method, exemption consumption in both directions, a locally declared type shadowing a checked
name, an import-list-only "covered" type, a `@ts-expect-error` assignment, an aliased `apiFetch`,
and a URL literal beside a typed read. Each was verified to fail when its fix is reverted.
