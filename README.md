# autologger

AutoLogger as a **portable Node server** — runs anywhere Node 22 runs, no cloud platform
required.

Originally a faithful TypeScript port of the Python AutoLogger backend — this repo is now
the canonical implementation. It authenticates
via Google OAuth, persists the global catalog (users/studios/shows/prefs) plus login sessions
and OAuth CSRF in a **SQLite catalog DB**, holds live per-session data (events, transport,
audio metadata, recording lease, transcript words, topics) in an **in-process SessionHub per
session** (embedded SQLite), keeps audio bytes on the **filesystem**, and pushes live updates
over a **WebSocket** — all with the **frozen JSON shapes** the React frontend and Companion
module consume (see Endpoints below; the contract is frozen).

## Stack

- **Hono** — routing + middleware (ported from `web/app.py` + routers)
- **Zod** — request validation at the route boundary (ported from `web/schemas.py`)
- **jose** — Google ID-token verification against Google's JWKS
- **better-sqlite3** — catalog DB + one DB file per session
- **filesystem blobs** — audio bytes (replaces R2)
- **in-process SessionHub per session** — replaces the Durable Object; live spine for events,
  transport, audio metadata, recording lease, transcript words, topics, and WebSocket fan-out
- **`@hono/node-ws`** — WebSocket upgrades, served by **`@hono/node-server`**

> Runs anywhere Node 22 runs. No Cloudflare account, no login, no remote provisioning. A
> single Node process serves HTTP + WebSocket; state lives under `DATA_DIR` on local disk.

## Architecture

Everything runs in **one Node process**; the browser and Companion are thin clients that
fetch over HTTP/WS and hold no session state. All storage lives on local disk under `DATA_DIR`;
the config-gated integrations (DeepGram, `yt-dlp`, the `claude` CLI, the Claude Agent SDK) are
spawned or called *by the server*, never by a client.

```
   CLIENTS                          SINGLE NODE PROCESS                        LOCAL DISK
┌──────────────┐            ┌──────────────────────────────────┐        ┌───────────────────┐
│ React web/   │  HTTP  ┌──▶│ Hono router + Zod + jose          │        │ DATA_DIR/         │
│ (SPA)        │───────▶│   │  ├─ auth / profile / shows        │──SQL──▶│  catalog.db       │
│              │◀── WS ─┤   │  ├─ sessions / events / audio     │        │  (global index,   │
├──────────────┤        │   │  ├─ transcribe / exports          │        │   kv, presence)   │
│ Companion    │  HTTP  │   │  └─ companion / admin             │        ├───────────────────┤
│ module       │───────▶│   │                                   │        │  sessions/<id>.db │
│              │◀── WS ─┤   │  SessionHubRegistry (in-memory)   │──SQL──▶│  (one per session:│
├──────────────┤        │   │   └─ SessionHub per session ──────┼───┐    │   events, topics, │
│ stale/ext.   │────────┘   │      (events, transport, lease,   │   │    │   transcript…)    │
│ clients      │            │       transcript, topics, WS fan) │   │    ├───────────────────┤
└──────────────┘            └─────────────┬────────────────────┘   └───▶│  blobs/audio/…    │
                                          │ spawn / fetch (server-side)  │  tmp/ (staging)   │
                       ┌──────────────────┼───────────────────┐         └───────────────────┘
                       ▼                  ▼                   ▼
              ┌─────────────────┐ ┌───────────────┐ ┌───────────────────────┐
              │ DeepGram cloud  │ │ yt-dlp child  │ │ claude CLI / Agent SDK │
              │ STT (fetch)     │ │ (audio dl)    │ │ child (AI chat/topics/ │
              │ DEEPGRAM_API_KEY│ │ YTDLP_PATH    │ │ v2)  CLAUDE_CLI_PATH   │
              └─────────────────┘ └───────────────┘ └───────────────────────┘
              config-gated: each returns a frozen 503 until its key/binary is present
```

**Why server-side.** This placement is deliberate, driven by three forces no browser can satisfy:

- **Subprocess execution.** The server spawns the `claude` CLI and `yt-dlp` directly with
  `child_process.spawn` (and `yt-dlp` may in turn spawn an `ffmpeg` postprocessor of its own) —
  native binaries a browser can't run: no process model, no `PATH`, no spawn. (The one integration that is *just* a `fetch`, DeepGram, could run in a
  browser, but see the next point.) The pure-TS `mediabunny` audio merge is the exception that
  proves the rule: it needs no binary, so it is the only piece that *could* run either side.
- **Secret custody.** `DEEPGRAM_API_KEY` and Anthropic credentials must never ship to a client
  — a browser bundle is world-readable, so client-side calls would leak billable keys to every
  user. The server holds them and is the only caller.
- **Shared live state.** One `SessionHub` per session with WebSocket fan-out is what lets the
  React SPA *and* the non-browser Companion hardware module see the same session in real time.
  Client-local storage would fork each device's copy and lock Companion out entirely. It would
  also change observable HTTP/WS behavior — frozen by the `api-contract-freeze` spec.

A browser-only build would therefore be a different, single-user, no-hardware product — not a
refactor of this one.

- **Catalog DB = global, cross-session, relational, not hot** (`DATA_DIR/catalog.db`). Also
  holds key/value rows (login sessions, OAuth CSRF, replacing KV) and a lightweight
  `sessions` index (metadata + a small live projection) so listing + status + cheap
  rolling-timecode never wake a session's hub.
- **One SessionHub per session** (in-process, keyed by session id) = the live spine: events,
  transport, audio-segment metadata, recording lease (in-hub state + a timer-driven
  auto-expiry), transcript words, topics, and the WebSocket fan-out. Single writer per
  session, so the Python `RLock` and `events_stream_revision` polling machinery disappear —
  the hub broadcasts instead. After each mutation the process mirrors a few live fields back
  to the catalog's sessions index (`projectSessionLive`).
- **Filesystem blobs** = audio bytes under `DATA_DIR/blobs/audio/<session_id>/<ordinal>_<uuid>.<ext>`;
  the hub holds only metadata + relative keys. Download streams bytes back with HTTP range
  support (416 on unsatisfiable ranges).
- **Transcript generation, YouTube audio import, Google Sheets log import, topic generation,
  and event auto-generation are configuration-gated; `transcribe.csv` stays unavailable.**
  `POST …/transcript-words/generate`
  returns a clean `503 {detail}` (the frontend toasts it) unless `DEEPGRAM_API_KEY` is set, in
  which case it combines the session's recorded audio and returns `200 {words}` from
  DeepGram's speech-to-text API — see "Transcript generation (DeepGram)" below.
  `POST …/youtube-import` returns the same frozen `503 {detail}` unless an operator-provided
  `yt-dlp` binary is configured (or resolvable on `PATH`), in which case it downloads a
  video's audio and attaches it to the session — see "YouTube audio import" below.
  `POST …/log-import` returns the same `503 {detail}` unless the operator explicitly sets
  `SHEETS_LOG_IMPORT_ENABLED=1`, in which case it downloads a public Google Sheets workbook
  and imports its log rows into the show's sessions as events — see "Google Sheets log
  import" below.
  `POST …/topics/generate` returns the same frozen `503 {detail}` unless `CLAUDE_CLI_PATH`
  is set (the AI chat's gate), in which case it runs a single, non-conversational `claude`
  CLI turn against the session's transcript and returns `200 {topics}` — a crash-safe
  replace-all of the session's topics — see "AI chat (Claude CLI)" below.
  `POST …/events/generate` shares that `CLAUDE_CLI_PATH` gate: configured, it runs a single
  orchestrator CLI turn that appends transcript-derived log events per user-authored
  per-button instructions and returns `200 {created, cap_hit}` — see "Event auto-generation
  (AUTO GENERATE)" below. `transcribe.csv`
  remains unconditional `503 {detail}` (no external integration wired up). Manual
  transcript-word/topic CRUD still works.

### Transcript generation (DeepGram)

`POST …/transcript-words/generate` is gated by `DEEPGRAM_API_KEY` (see
`server/.env.example`): unset/blank keeps the endpoint's frozen `503`. When set, the server
groups the session's recorded audio segments by probed codec (Opus/AAC/PCM), concatenates
each group without re-encoding, sends each group to DeepGram's pre-recorded speech-to-text
API (`DEEPGRAM_MODEL`, default `nova-3`), and — only once every group succeeds — replaces the
session's transcript words with the result (`200 {words}`). Failure modes: no recorded audio
or no readable segments (`400`, distinct details), a run that succeeds upstream but finds no
speech (`400`, existing transcript untouched), the request aborted before any provider call
(`400`, no spend), a concurrent run already in flight (`409`, no spend), and upstream
failure/timeout or a group over DeepGram's 2 GB upload limit (`502`). At most one generation
run is in flight per process at a time.

**Setting `DEEPGRAM_API_KEY` sends recorded session audio to DeepGram's cloud API and enables
billed, metered calls — every generate request is a paid request.** Under `REQUIRE_LOGIN=0`
(open LAN-studio box) any client that can reach the server can trigger those calls; there is
no additional auth gate beyond `REQUIRE_LOGIN`. Only set the key on a box you operate and are
prepared to pay for.

### YouTube audio import

`POST …/sessions/:id/youtube-import` keeps its frozen `503 {detail}` unless a `yt-dlp` binary
is available (see `server/.env.example`): the gate is satisfied by either an explicit
`YTDLP_PATH` **or** a bare `yt-dlp` resolvable on the server process's `PATH` — unlike
`DEEPGRAM_API_KEY`/`CLAUDE_CLI_PATH`, **an already-installed `yt-dlp` on `PATH` is sufficient
to auto-enable import**, with no separate opt-in flag. When configured, the endpoint validates
the request `url` against an exact-hostname YouTube allowlist, spawns `yt-dlp` to fetch the
video's best supported-container audio into an isolated temp dir, attaches it as a new audio
segment on the session (rolling back the metadata row if the blob write fails), and — when
`use_publish_date` is set and the video reports an upload date — writes the session's
`episode_date`. Responses: `400 {detail}` for a malformed or non-allowlisted URL (no spawn);
`409 {detail}` when another import for the same session is already running or the global
concurrency ceiling is reached (no spawn); `502 {detail}` for a download/extraction failure,
hang timeout, over the byte-size or 4-hour duration cap, a live/unknown-duration stream, or an
unsupported produced container (no segment attached); `200 {ok: true}` on success.

**Egress and spend disclosure.** Enabling this (by either route — configured path or bare
`PATH`) makes the server issue outbound HTTP requests to YouTube and download third-party
audio to local disk for every import — there is no metered API cost, but it is real network
egress on the operator's behalf. As with `DEEPGRAM_API_KEY`, the endpoint additionally refuses
(`503`, no subprocess spawned) in the open-network configuration — `REQUIRE_LOGIN` disabled,
a non-loopback bind, and no `IP_ALLOWLIST` — mirroring the AI chat / AI v2 refusal, so this is
never left reachable to an anonymous LAN client. Only run this on a box you operate and are
prepared to have make YouTube requests on your behalf.

**`ffmpeg` note.** The spawned `yt-dlp` child's `PATH` is pinned to the resolved binary's own
directory only (config/plugin/secret-exfil lockdown — no inherited `process.env`), so `yt-dlp`
cannot discover an `ffmpeg` installed elsewhere on the host's normal `PATH`. If a given video
needs `ffmpeg` for post-processing (format merging/remuxing), `ffmpeg` must be co-located next
to the resolved `yt-dlp` binary or that import fails (`502`) for that video.

### Google Sheets log import

`POST /api/shows/:showId/log-import` returns `503 {detail}` unless the operator explicitly
sets `SHEETS_LOG_IMPORT_ENABLED=1` (see `server/.env.example`) — public sheets need no API
key, so the gate is an explicit boolean opt-in (the `AI_V2_ENABLED` style) rather than a
key's presence. When enabled, the endpoint starts a detached job that downloads the public
Google Sheets workbook named in the request, matches each sheet's name against the show's
session titles, aligns each sheet's log rows to the matched session's transcript (generating
a transcript first when the session has none — billed DeepGram spend when `DEEPGRAM_API_KEY`
is set), and writes the resulting events into those sessions. The POST is scoped to members
of the show's studio (a non-member gets the same `404` as a nonexistent show). `GET
/api/log-import/:jobId` polls the job (`{status, lines, error}`); it is **not** egress-gated
(it only reads local in-process state) and answers only the job's creator — any other
authenticated requester gets the same `404` as an unknown id. Terminal jobs are pruned from
memory about an hour after finishing.

**Egress disclosure.** What leaves the machine: outbound HTTPS requests to `docs.google.com`
only (the workbook-export endpoint); the downloaded workbook is processed locally. When: only
when an operator has set `SHEETS_LOG_IMPORT_ENABLED` **and** a user starts an import — an
unconfigured deployment never contacts Google. Note the DeepGram interaction above: on a
deployment with `DEEPGRAM_API_KEY` set, an import over sessions without transcripts triggers
billed transcript generation. Only enable this on a box you operate and are prepared to have
make Google requests on your behalf. Like the other spend-per-request features (YouTube
import, AI chat), the POST also refuses with `503` on an open-network deployment
(`REQUIRE_LOGIN` disabled + non-loopback bind + no `IP_ALLOWLIST`), even when enabled.

### AI chat (Claude CLI)

`POST /api/sessions/:sessionId/ai/chat` turns a session's transcript into topics
conversationally. A chat panel in the session workspace drives the operator's local `claude`
CLI, which reads the session's transcript and creates topics through a locked-down,
session-scoped toolset.

**Topic generation (`…/topics/generate`), the one-shot sibling.** The "Generate topics"
button is a separate, **non-conversational** consumer of the same CLI/MCP machinery: gated on
the same `CLAUDE_CLI_PATH` (unset/blank keeps the endpoint's frozen `503`, byte-for-byte
unchanged for unconfigured deployments), the same open-network refusal below, and the same
per-session single-flight / process-wide concurrency ceiling (`AI_CHAT_MAX_CONCURRENT`) as
the chat — a generate and a chat turn on the same session are mutually exclusive, since both
spend the operator's Anthropic budget on that session. Unlike the chat — whose toolset has no
delete tool, so it can only append topics — a generate **replaces the session's topics
wholesale**: it runs one fixed turn ("generate a fresh complete set of topics for this
transcript") with the `list_topics` tool withheld (so the model can't dedup against the
topics it's about to replace), then swaps in the fresh set. The swap is **crash-safe**: the
prior topics are never deleted until the fresh set exists, so a failed or crashed run leaves
the session's topics untouched, byte-for-byte. The endpoint requires an existing transcript
(`400 {detail}` if the session has no transcript words — a generate never creates a
transcript itself) and returns `200 {topics}` on success, in the same shape `GET …/topics`
returns, or `502 {detail}` if the CLI turn fails or produces zero topics (again leaving the
prior topics untouched). The transcript reaches the model **paged**: the one-shot's
`get_transcript_words` serves the generation-density rendering in deterministic sequential
pages under a hard per-page size cap, each page but the last ending in an explicit
continuation marker, computed from a word snapshot taken once at run start — so no single
tool result can overflow the CLI's tool-output ceiling (the failure that let a run replace a
good topic set with a "transcript unavailable" placeholder), and a mid-run transcript edit
cannot shift the run's pages. A run that creates topics without fetching **every** page takes
the same `502` restore path as a failed run rather than replacing the prior set. Because a
one-shot reads the **entire** transcript in a single turn —
delivered as multiple sequential pages at generation density, a much bigger workload than an
incremental chat message — it is bounded by its own spend/time ceilings rather than the chat's
(both defaulted well above the chat's), so large sessions don't deterministically fail:
`TOPIC_GENERATE_MAX_BUDGET_USD` (default `5.0`, the per-turn CLI cost ceiling) and
`TOPIC_GENERATE_TIMEOUT_SEC` (default `600`, the server-side timeout backstop) — the same
defaults as the event-generation knobs below, which the repo sizes for that same
full-transcript-at-generation-density read — see `server/.env.example`. **Supported ceiling:**
paging bounds each tool result, not the model's context window, so on very long sessions
(roughly 50k+ words) the accumulated pages exceed that window and the CLI's own
auto-compaction summarizes the earliest pages — the run still fetches every page and still
succeeds, but topics for the early part of the session come out coarser. That is graceful
degradation, not data loss, and it is not enforced by a new error status. The AI chat tab
remains the conversational path; `transcribe.csv` keeps its own, unrelated, unconditional
`503`.

Gated by `CLAUDE_CLI_PATH` (see `server/.env.example`): unset/blank/whitespace-only keeps
the endpoint's frozen `503 {detail}` and leaves unconfigured deployments byte-for-byte
unchanged. When set, the endpoint spawns `claude -p --output-format stream-json` per turn
and responds `200 Content-Type: text/event-stream`, relaying the CLI's reply as SSE events:
`delta {text}` (assistant text fragments only — model reasoning/thinking is never relayed),
`tool {name}` (an MCP tool invocation, short name only — one of `get_transcript_words`,
`list_topics`, `create_topic`), and exactly one terminal event per server-completed
stream — `done {claude_session_id}` (echo this back as `claude_session_id` on the next turn
to resume the conversation) or `error {detail}`, where `detail` is one of a fixed,
secret-free set (`upstream-failed`, `not-logged-in`, `timeout`, `internal-error`) — never
raw CLI stdout/stderr, environment values, credentials, or device-login URLs. The event
vocabulary is additive-open: new event types or payload fields may appear without a further
delta spec; clients ignore event types and fields they don't recognize.

**Egress and spend disclosure.** Enabling this feature sends the session's transcript and
topic content to Anthropic, over the operator's own `claude login` credentials — every chat
turn is a real, billed Anthropic API call against the operator's account/quota. Spend is
bounded three ways: at most one turn in flight per autologger session (a second concurrent
request for the same session gets `409`, spawning nothing), a process-wide ceiling on
concurrent turns across all sessions (`AI_CHAT_MAX_CONCURRENT`, default `2` — turns beyond
the ceiling are rejected with `409` and never spawned), and a per-turn CLI cost ceiling
(`AI_CHAT_MAX_BUDGET_USD`, default `0.5`, passed to the CLI as `--max-budget-usd`). A turn
that runs long is killed after `AI_CHAT_TIMEOUT_SEC` (default `300` seconds) — the
guaranteed backstop; a client disconnect (Stop button or closed tab) also kills the
subprocess but is best-effort only.

**Open-network refusal.** Because a turn spends the operator's Anthropic credentials, the
endpoint additionally refuses to serve turns (`503`, independent of the general auth gate)
when `REQUIRE_LOGIN` is disabled **and** the server is bound to a non-loopback address **and**
no `IP_ALLOWLIST` is set — the same "open LAN-studio box" scenario the DeepGram warning
above calls out, closed off specifically for this paid endpoint. A loopback-bound anonymous
dev server is unaffected.

**Security posture.** The spawned CLI is locked down to exactly the autologger toolset and
nothing else:

- `--setting-sources ""` — no operator hooks, plugins, or user/project/local
  `CLAUDE.md`/`settings.json` load in the child. This is the primary control: lifecycle
  hooks run shell commands unconditionally on events and are not governed by tool
  allow/deny lists. `claude login` credentials still work under this flag.
- `--strict-mcp-config` with a generated, per-turn `--mcp-config` — only the autologger MCP
  server (an in-process, loopback-only listener) loads; any MCP servers configured in the
  operator's own `~/.claude` are ignored.
- `--tools ""` (deny every built-in tool) plus `--allowedTools` naming exactly the three MCP
  tools (`mcp__autologger__get_transcript_words`, `mcp__autologger__list_topics`,
  `mcp__autologger__create_topic`) — positive denial plus an explicit allowlist, not a
  name-keyed denylist that would drift as the CLI's built-in tool inventory grows.
- `shell: false` with an argument array; the chat message is delivered on **stdin**, never
  as an argv positional, so a message starting with `-` can never be parsed as a CLI flag.
- No host shell, filesystem, or general web access is reachable from a chat turn — the MCP
  toolset is session-scoped (`get_transcript_words`/`list_topics`/`create_topic`, each
  hard-bound to the requesting `:sessionId` by the turn's own registration, not by a tool
  parameter) and is the CLI's only capability in the child.

**Operational notes.** Run the server process as the operator account that ran
`claude login` — the child inherits only `HOME` and `PATH` from the server's environment
(plus `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`/`NODE_EXTRA_CA_CERTS` when the parent process
actually has them set). If `claude` is installed as an npm-global rather than a native
binary, make sure `node` is on the service's `PATH` too, or the spawn will fail. Networks
behind a proxy or a custom TLS root need the relevant proxy/TLS vars set in the server's own
environment so they pass through to the child. Minimum tested CLI version: **2.1.202** (the
version the lockdown flag set and the JSONL stream taxonomy were empirically verified
against, 2026-07-14 spike). An older or different CLI is not blocked at startup — the gate
is configuration presence, not a version probe — but may fail per-turn with a scrubbed
`error` event.

**Chat history is ephemeral.** The server persists no chat conversation content: no chat
tables in the catalog or session DBs, no chat blobs under `DATA_DIR`, and no history-read
endpoint — conversation state lives only in the browser tab's page state, so a refresh
clears it. The `claude` CLI keeps its own per-session files outside `DATA_DIR`, under the
operator's `~/.claude`; those accumulate across turns independent of this server-side
ephemerality, the same as any local `claude` usage.

### Event auto-generation (AUTO GENERATE)

`POST /api/sessions/:sessionId/events/generate` turns user-authored per-button
instructions into appended log events. Event buttons of type BUTTON, DROPDOWN, and TEXT
carry an optional `auto_instruction` field in Settings (DROPDOWN options additionally carry
their own, alongside the whole-button instruction; ON_OFF buttons are excluded — their
on/off phase lives in client-held toggle state a generated insert would corrupt). The
instructions are written through `PUT /api/profile` `show_updates[*].categories` and persist
on the show's categories, but profile is **not** the read path back: profile `shows[]` is the
brief shape `{id, studio_id, name, show_code, title_suffix}` and carries no `categories` at
all. They round-trip verbatim on the full show reads — `GET /api/shows?studio_id=…` and
`GET /api/shows/{showId}` — and on the session-scoped `GET …/show-categories`, which gains one
additive top-level boolean, `auto_instructions_present` (its `categories` projection is
otherwise unchanged, and Companion's `categories` response is untouched). These additive
shapes — the boolean plus the `auto_instruction` fields on the full show serializer's
`categories[*]` and their `dropdown_options[*]` — are authorized by the `auto-event-generation`
delta.

The feed tab's AUTO GENERATE button starts one **synchronous** run: gated on the same
`CLAUDE_CLI_PATH` as the AI chat (unset/blank keeps the endpoint's frozen `503`), the same
open-network refusal, and the same per-session single-flight / process-wide ceiling
(`AI_CHAT_MAX_CONCURRENT`). The server snapshots the session's frame rate, transcript, and
instruction-bearing categories at run start (mid-run edits affect the next run, not this
one), then drives a **single orchestrator CLI turn** through the same locked-down one-shot
machinery as `topics/generate` — no built-in tools, strict per-turn MCP config, loopback +
bearer, and **no abort signal**, so a run always completes server-side regardless of the
initiating client's connection. The prompt enumerates every instruction-bearing button and
option (instruction text rendered as clearly-delimited untrusted data that cannot alter the
tool contract) and embeds those categories' complete existing events as the dedup basis —
the model is directed to log only moments not already logged. The turn's tool allowlist is
exactly two tools: `get_transcript_words` in a generation-density rendering (periodic
timecode anchors, deterministic sequential paging with a continuation marker, never silent
truncation; the chat rendering is unchanged) and a new `create_event` tool that validates
the category against the run snapshot (`internal` denied in any casing), the message
against the manual log path's bounds, and the timecode grammar (`HH:MM:SS`, `HH:MM:SS:FF`,
drop-frame `HH:MM:SS;FF`), then inserts through the same transactional hub path as a manual
log — same `event.changed` broadcast per insert, same category UI snapshots in metadata,
same catalog live projection, so `GET /api/sessions` stays truthful.

**Append-only, bounded, attributable.** A run never modifies or deletes an existing
event, with one authorized exception (`event-generate-menu` delta, hardened by
`event-generate-hardening`): the request accepts an optional JSON body
`{regenerate?, selection?}` — `regenerate: true` snapshots the ids of the session's current
`auto_generated` rows after the guard ladder and AI-slot acquire but before the CLI spawn,
excludes that snapshot from the run's existing-events dedup basis and anchor-interpolation
basis, and leaves the snapshotted rows readable for the whole run (including any mid-run
`GET …/events`). The snapshot is **deleted only after the CLI turn succeeds with at least
one created event** — transactionally, in one `event.changed` broadcast when at least one
row was removed and none otherwise — right before the `200` response is built; a
zero-created success or a `502` leaves the prior rows untouched, and the `200` body then
adds `deleted: number` (`0` on zero-created success). `selection` (mutually exclusive with
regenerate — the combo is `400`) restricts the run to the named categories/options, with
only matching instruction-bearing entries participating (a selection that matches none is
`400`). Malformed bodies are `400`. An empty/absent body stays exactly the prior Generate
All behavior.
Each run enforces a per-run created-events cap (`EVENT_GENERATE_MAX_CREATED_EVENTS`,
default `200`): at the cap, further `create_event` calls return a tool error and the
response reports `cap_hit: true`. Each generated row carries `auto_generated: true` plus a
per-run `auto_generate_run_id` in `metadata_json` and renders with a compact "auto" marker
in the feed. Timecodes are transcript-derived, never the run-time clock: the stored
`wall_time_utc` is interpolated (piecewise-linear, clamped monotone) over the session's
existing timecode↔wall anchor pairs, so a generated event at timecode T sorts between the
manual events that bracket T even across recording pauses.

**Statuses.** `503 {detail}` unconfigured or open-network (nothing spawned); `400 {detail}`
pre-spawn when the session has no transcript words, no words with session-time anchors, no
instruction-bearing button, or the instructions exceed the aggregate pre-spawn bound
(`EVENT_GENERATE_MAX_INSTRUCTION_BYTES`, default `24576` total instruction bytes /
`EVENT_GENERATE_MAX_INSTRUCTION_ENTRIES`, default `50` instruction-bearing entries);
`409 {detail}` when the shared AI slot or process-wide ceiling is held; `200 {created,
cap_hit}` on success; `502 {detail}` for a CLI-turn failure after spawn — a fixed opaque
detail carrying no raw subprocess output, with events inserted before the failure remaining
persisted (and reported nowhere in the error body). **The shared AI-slot `409` busy details
are reworded** (authorized by the same delta) to name event generation among the possible
holders — the `ai/chat`, AI v2, and `topics/generate` busy/at-capacity strings now all read
"AI chat, AI v2, topic generation, or event generation".

**Egress and spend disclosure.** Like `topics/generate`, a run is a real, billed Anthropic
API call over the operator's own `claude login` credentials — the transcript and the
configured instructions are sent to Anthropic. Its workload is likewise far past what the chat
ceilings are sized for (full transcript at generation density, a sweep per instruction, a
`create_event` round trip per hit), so it gets its own ceilings — separately tunable from the
topic-generation knobs, but defaulted to the same values, since topic generation pages that
same full transcript at generation density:
`EVENT_GENERATE_MAX_BUDGET_USD` (default `5.0`, the per-turn CLI cost ceiling, passed as
`--max-budget-usd`) and `EVENT_GENERATE_TIMEOUT_SEC` (default `600`, the server-side
timeout backstop) — see `server/.env.example`. Concurrency exposure is bounded together
with the other paid AI features by the shared slot and `AI_CHAT_MAX_CONCURRENT`.

### AI v2 dashboards

`POST /api/sessions/:sessionId/ai/v2/design` (+ `.../ai/v2/answer` for its question round trip,
+ `GET|PUT|DELETE .../ai/v2/dashboard` for persistence) is a second, independent AI feature: a
Dashboards tab where the operator designs a dashboard conversationally rather than assembling one by
hand. A design turn proposes a **starting** dashboard — the agent reads the session's aggregates,
asks the user catalog-widget questions (with real previews) through the same interactive-question
mechanism as the round trip below, then commits its proposal by calling an in-process
`propose_dashboard` tool, which validates the whole config and streams it to the browser as the
turn's own `dashboard` SSE event. Every edit after that is **direct manipulation** in the UI, not
further conversation. Rendered widgets get their data by the browser aggregating the session's own
transcript-words/topics/events data client-side — there is no new aggregate HTTP endpoint — and a
saved dashboard's config persists in the **session's own SQLite DB** (one dashboard per session,
`{config}` / `{config: null}`), not the catalog DB. Widgets whose inputs the current schema can't
yet compute (e.g. certain sentiment/utterance stats) render an honest "unavailable" state rather
than a fabricated zero.

Gated by `AI_V2_ENABLED` (see `server/.env.example`) — unlike the AI chat's implicit
`CLAUDE_CLI_PATH` gate, this is an **explicit** opt-in flag: unset/off keeps every `ai/v2` route,
including dashboard persistence, at the endpoint's frozen `503 {detail}`.

**Egress and spend disclosure.** A design turn sends the session's computed aggregates, plus
bounded transcript-word excerpts when the agent calls its `transcript_excerpt` tool (never whole
raw transcript tables), to Anthropic through the Claude Agent SDK, and is a real, billed API call. If
`AI_V2_API_KEY` is set, that workspace-scoped key pays for it; otherwise the turn falls back to the
operator's interactive `claude login` session — spending the **operator's personal** subscription —
and that fallback is permitted only on a loopback bind (`HOST=127.0.0.1`), logged loudly at
startup; a non-loopback bind with no configured key refuses (`503`) to serve design turns at all.
Spend is bounded per turn (`AI_V2_MAX_BUDGET_USD`, default `0.5`) and turns share the **same**
per-session single-flight slot and process-wide concurrency ceiling as the AI chat
(`AI_CHAT_MAX_CONCURRENT`) — the two paid features bound the operator's exposure together, not
separately.

**Configuration gating and the open-network refusal — CRUD is deliberately different.** The design
and answer routes carry the full guard chain: config gate (`503`), the open-network refusal
(`503`, same "REQUIRE_LOGIN disabled + non-loopback + no IP_ALLOWLIST" check the AI chat uses,
since a turn spends money), and the agent-credentials refusal (`503`, no key and no loopback
fallback available). Anonymous access on a reachable, non-loopback network is refused for **turns**
specifically. The dashboard **CRUD** routes (`GET|PUT|DELETE .../ai/v2/dashboard`) are gated on
`AI_V2_ENABLED` (`503`) and on the same device-token/principal-less refusal (masked `404`), but are
**deliberately not** gated on the open-network refusal or the credentials refusal — a dashboard
read/write/delete spawns no subprocess and spends nothing, so it follows the app's ordinary auth
posture instead of the paid-endpoint one. This is a considered design decision (recorded in the
`ai-v2-dashboards` OpenSpec change), not an oversight — a future change should not "fix" it by
adding those gates to CRUD.

**Sandboxing.** The design turn runs the Claude Agent SDK locked down to a closed world: the
built-in tool set is exactly the one interactive question tool (`AskUserQuestion`) plus an explicit
`disallowedTools` belt-and-braces on the built-in write/exec set — no `Bash`, `Read`, `Write`,
`Edit`, or general web access is ever reachable from a turn. `settingSources: []` suppresses every
operator hook/plugin/`CLAUDE.md`/`settings.json` load (the primary control — hooks run shell
commands unconditionally and aren't governed by tool allow/deny lists), `strictMcpConfig` loads
only the turn's own in-process aggregate MCP server, and the turn runs from a fresh, isolated
working directory and `CLAUDE_CONFIG_DIR` outside both the repo checkout and `DATA_DIR` (so
`server/.env` and session data are never in the child's reach). The child process group is
terminated on every exit path — completion, error, timeout, client disconnect — so no process ever
survives to keep spending the operator's credentials after the request that started it is gone.
As with the AI chat, no agent-authored markup is ever rendered anywhere in this feature; a proposed
dashboard is validated against the same whole-config schema a user's own PUT is held to before it
is ever shown.

`restart_supported` is unaffected by this feature (still `false`); the `CLAUDE_CLI_PATH` gate
on `…/topics/generate` and `…/events/generate` (see "AI chat (Claude CLI)" and "Event
auto-generation" above) and `transcribe.csv`'s unconditional
`503` are all unaffected by `AI_V2_ENABLED`; `…/youtube-import` is likewise unaffected by
`AI_V2_ENABLED` — it has its own `yt-dlp` configuration gate (see "YouTube audio import"
above).

### Storage map

```
DATA_DIR/
  catalog.db           Catalog + kv (users/studios/shows/prefs, login sessions, OAuth CSRF,
                        Companion presence, sessions index + live projection)
  sessions/<id>.db      One SQLite file per session — events, transport, audio metadata,
                        recording lease, transcript words, topics
  blobs/audio/…         Audio bytes (r2_key-shaped relative paths)
  tmp/                  Atomic-put staging (outside blobs/, so listings never see partials)
```

### Invariants (spec)

- **Single Node process** — no clustering, no multi-worker fan-out.
- **SessionHub RPC bodies are synchronous** — zero `await`s inside a hub method; all async
  work (fetch, streaming, etc.) lives in the router layer, not the hub.
- **Hub mutations are transactional** — every mutating RPC runs inside a
  `better-sqlite3` transaction.
- **Idle hubs close their DB handles and reopen lazily** — a hub with no attached sockets and
  no armed lease timer is evicted after an idle window; `SessionHubRegistry#get()` reopens the
  session's DB file on next access. `expireIfStale()` re-checks the recording lease on reopen.

## Source layout

Persistence lives in three L1 source-only sibling packages under `packages/` (extracted
from `server/src/session|db/` and part of `server/src/node/` by `persistence-package-extraction`);
`server/src/` keeps the composition root, routers, auth, and app wiring, reaching persistence
only through the packages' exported facade interfaces (`appEnv.ts` names zero concrete
persistence classes — `server/src/node/config.ts` is the sole production module that
constructs the concretes; `middleware/auth.ts` constructs the per-request `Catalog` via the
package's `createCatalog` factory). Above L1 sits a flat L2 **service** layer — four more
source-only packages: three (`feature-service-packages`) extracted out of `server/src/node/`'s
feature files and the retired `server/src/logImport/` — `@autologger/transcription`,
`@autologger/media-import`, and `@autologger/log-import` — and a fourth (`ai-runtime-package`)
extracted from the retired `server/src/ai-runtime/` and `server/src/aiV2/` pair —
`@autologger/ai-runtime`. A service package may import L0 and L1 but never another service
package; `server/src/node/` itself now holds exactly `config.ts`, `systemClock.ts`,
`presence.ts`, and `nextFrontend.ts` (the Next.js frontend bridge wrapper, added by
`nextjs-frontend-migration`) — matching its documented composition-root-wiring role, and
pinned by a recursive name check rather than left to drift again. Cross-package boundaries at every
layer are enforced by `server/src/packageBoundaries.repo.test.ts`, not the compiler.

```
server/src/
  main.ts                Node entry: env config → bindings → app → listen
  app.ts                 Hono app wiring: middleware chain + router mounts + the frontend
                          bridge (GET-only catch-all → nextFrontend.handle(), RESPONSE_ALREADY_SENT);
                          also carries the ORDER-SENSITIVE /api/* compression pair —
                          compress() outermost, measureCompressibleBody inside it (stamps the
                          Content-Length compress()'s 1 KB threshold needs, and Vary: Accept-Encoding)
                          (← web/app.py)
  compressibleTypes.ts   isCompressibleResponseType — the single definition of which responses
                          the /api/* compression acts on (hono's COMPRESSIBLE_CONTENT_TYPE_REGEX
                          + application/x-ndjson); shared by compress(), measureCompressibleBody,
                          and routers/audio.ts's mime clamp so the three can't disagree
  upgradeDispatch.ts     The single server.on('upgrade') path dispatcher, wired by main.ts:
                          captures @hono/node-ws's handler off a stub server, then routes each
                          upgrade by path (non-/api paths through the same IP-allowlist decision)
                          to Hono, to Next's HMR, or to a destroyed socket
                          (nextjs-frontend-migration D1)
  env.ts                 Typed env accessors                           (← auth_identity.py getters)
  appEnv.ts              Composition root's Hono generics: Ports + Config + Variables (AppEnv) —
                          types Ports.sessions/Variables.catalog with the session-core/catalog
                          packages' facade interfaces and names ZERO concrete persistence class
                          (port interfaces + Config live in packages/ports)
  httpError.ts           ApiError — app-level HTTP error class (status + detail), thrown by
                          every router and mapped to `{detail}` by app.onError; lives at app
                          root rather than under routers/ because it is composition-root/
                          app-shell plumbing, not a layer (router-directory-decomposition D3)
  node/
    config.ts            Composition root: Ports + Config from process env (DATA_DIR layout,
                          wiring) — the sole production module naming the concrete
                          SessionHubRegistry/Catalog(Db)/KvStore/BlobStore classes, all imported
                          from the packages below
    systemClock.ts        Clock port implementation — the sole sanctioned Date.now() call site
                           (interface lives in packages/ports; moved from the former clock.ts)
    presence.ts           In-memory Companion presence registry (stays in server — not persistence)
    nextFrontend.ts        Wraps next({ dev, dir: web/ }) + prepare(); exposes
                           { handle, upgradeHandler, close }; returns null (API-only
                           mode) when web/.next is missing in prod (nextjs-frontend-migration)
  auth/
    oauth_google.ts        IdentityVerifier port: authorize URL, code exchange, ID-token verify (← oauth_google.py)
    identity.ts             Login sessions + CSRF, bearer compare, gate rule (← auth_identity.py)
  middleware/
    auth.ts                 Per-request context + REQUIRE_LOGIN gate      (← app.py auth_identity_and_gate);
                             constructs the per-request Catalog via @autologger/catalog's createCatalog
    ipAllowlist.ts           CIDR allowlist on client IP                   (← app.py ip_allowlist_middleware)
  routers/
    _helpers.ts              session access gate, hub lookup, timecode context, marked-at
                              parsing (ApiError moved to httpError.ts at app root)
    auth.ts                  /auth/google/start|callback, /auth/logout
    profile.ts               GET /api/studio, GET|PUT /api/profile
    shows.ts                 GET|POST /api/shows, GET /api/shows/:showId (full show shape)
    sessions.ts              list/create/update/archive/restore/delete; local-audio-import; youtube-import (config-gated)
    events.ts                events CRUD, transport, status, lease, WebSocket upgrade
    audio.ts                 upload/list/range-download, waveform, sync-from-disk
    companion.ts             Companion presence + state + log/transport/command (WS relay)
    transcribe.ts             transcript-words + topics CRUD; generate/csv (503)
    exports.ts                export.csv / export.jsonl (← export.py)
    admin.ts                  ADMIN_TOKEN-gated users + studio-definitions admin

packages/                 Source-only npm workspace packages (no build step; server's tsx and
                           the root tsc --noEmit resolve them straight from src/); boundaries
                           between them are enforced by server/src/packageBoundaries.repo.test.ts,
                           not the compiler. L0 (domain/contract/ports) ships no runtime
                           persistence; L1 (session-core/catalog/storage) are dependency-free
                           siblings of each other — no L1→L1 edges — each depending only on L0;
                           L2 (transcription/media-import/log-import/ai-runtime) are service
                           packages that may depend on L0/L1 but never on each other — no L2→L2
                           edges, and no L1→L2 edges either (feature-service-packages design D1)
                           — enforced by four checks: the direct sibling rule, a no-L1-imports-L2
                           rule (closes an L1-re-export launder route), transitive reachability,
                           and a file walk widened to .mts/.cts.
  domain/src/              @autologger/domain — pure, dependency-free domain modules (L0)
    studio.ts                Studios + palette/category + event enrichment (← studio.py)
    timecode.ts              SMPTE timecode math + UTC helpers             (← models.py)
    dbShared.ts              Shared catalog-layer row types (AuthUser, …), dependency-free
                              (← former server/src/db/shared.ts)
    isAutoGeneratedMetadataJson()  Writer/reader agreement predicate shared by routers/events.ts
                                   and the session-core eventStore SQL predicate — the only
                                   session→server edge, killed by the move (← former
                                   routers/events.ts; persistence-package-extraction D4)
  contract/src/            @autologger/contract — wire schemas + dashboard catalog (L0; zod
                           declared as a peerDependency so the app's instanceof ZodError → 422
                           mapping can never see a second zod copy)
    schemas.ts               Zod request schemas                           (← web/schemas.py)
    aiV2Catalog.ts            Dashboard widget catalog + layout/interaction schema
                               (← former server/src/aiV2/catalog.ts)
  ports/src/               @autologger/ports — interface-only port types + Config (L0; no
                           runtime implementations — systemClock stays with the composition root)
    clock.ts / blobStore.ts / kvStore.ts / presenceRegistry.ts / catalogDb.ts /
    identityVerifier.ts / config.ts / ports.ts
                              Clock, BlobStore, KvStore, PresenceRegistry, CatalogDb,
                              IdentityVerifier interfaces + the Config type + the base Ports shape
  session-core/src/        @autologger/session-core — the in-process per-session live spine
                           (L1; deps: domain, contract, ports; better-sqlite3 peerDependency)
                           moved from server/src/session/ (persistence-package-extraction task 4.3)
    SessionHub.ts            In-process per-session hub: registry, idle eviction, RPC surface;
                             exports the SessionHubFacade/SessionHubRegistryFacade property-style
                             interfaces (facade membership = reached through Ports.sessions by an
                             outside consumer) and DashboardValidationError/DashboardBoundsError
                             (mapped to 422 by instanceof at routers/aiV2.ts)
    sessionCore.ts           Shared substrate: SQLite handle, WS fan-out, events_stream_revision,
                             lease, the SessionRuntime port
    eventStore.ts / transportStore.ts / audioStore.ts / leaseStore.ts / transcriptStore.ts /
    topicStore.ts / dashboardStore.ts / eventAnchors.ts / audioSeamParts.ts / storeHelpers.ts
                            Domain stores built on SessionCore                (← storage/db.py)
  catalog/src/             @autologger/catalog — the global catalog query layer (L1; deps:
                           domain, ports only — no better-sqlite3, speaks the CatalogDb port)
                           moved from server/src/db/ (persistence-package-extraction task 3.2)
    catalog.ts              Catalog facade + profile + sessions index + admin (← storage/db.py,
                            deps.py); exports the CatalogFacade property-style interface, the
                            five store facade interfaces, and the createCatalog(db) factory (the
                            sanctioned non-composition-root construction path for
                            middleware/auth.ts's per-request construct-then-init() lifecycle)
    authStore.ts / profileAssembler.ts / sessionIndexStore.ts / showsStore.ts / studioRegistry.ts /
    sessionTitleDerivation.ts
    index.ts                 Exports CATALOG_MIGRATIONS_DIR (resolved via import.meta.url) —
                             the package owns migrations/*.sql (schema and stores evolve
                             together, design D7); the directory-generic migrator that applies
                             them stays in @autologger/storage
  catalog/migrations/       Catalog DDL, filename-ordered (0001_init.sql through
                           0005_show_title_suffix.sql: init + seeded built-in shows, sessions
                           index + live projection, kv table, team roles/invites, title suffix)
  storage/src/             @autologger/storage — the SQLite/filesystem persistence adapters
                           (L1; deps: ports only; better-sqlite3 peerDependency) moved from
                           server/src/node/ (persistence-package-extraction task 2.2)
    migrate.ts               openCatalogDb + the directory-generic applyMigrations (filename-
                             ordered .sql, transactional) — takes any migrations dir, wired to
                             the catalog package's CATALOG_MIGRATIONS_DIR by node/config.ts
    catalogStore.ts          CatalogDb — better-sqlite3-backed catalog query layer (the port
                             implementation catalog/ speaks to, never imports)
    kvStore.ts               KV replacement (login sessions, OAuth CSRF, Companion presence) on
                             the catalog DB; clock is a required constructor parameter
    blobStore.ts             Filesystem blob store: atomic put, range get, list, traversal
                             guard; exports InvalidRangeError, mapped to 416 by instanceof at
                             app.ts and routers/audio.ts
  transcription/src/      @autologger/transcription — DeepGram transcription (L2; deps:
                           domain, ports, session-core — never contract) moved from
                           server/src/node/ (feature-service-packages task 4.1)
    deepgram.ts              DeepGram provider HTTP client (undici)
    audioMerge.ts            mediabunny packet-copy concat of recorded audio segments
    transcriptRemap.ts       Timeline remap of words + enrichment onto the session's SMPTE
                             timeline
    transcriptGenerationLock.ts  Process-wide generation lock (singleton); its tryAcquire
                             Date.now() default formats the frozen GET
                             /api/transcript-generation/status started_at field — nothing
                             branches, expires, orders, or persists on the value, but it is
                             contract-bearing, so it stays a display timestamp, not a Clock read
    generateTranscript.ts    Orchestrating entry point both the HTTP generate route and
                             log-import's ensureTimedTranscript coordinator call; imports
                             BlobStore directly from @autologger/ports (no appEnv/Bindings escape)
    deepgramConfig.ts        deepgramConfigured/deepgramModel, moved out of server/src/env.ts
                             (design D5 — the package reads its own config predicates)
    index.ts                 Package barrel; exports TRANSCRIPTION_FIXTURES_DIR
  transcription/fixtures/  audio/ (10 files) + deepgram-enrichment-response.json, moved from
                             server/src/test/fixtures/ (design D4)
  media-import/src/       @autologger/media-import — YouTube audio import (L2; imports no
                           workspace package at all, by role rather than by need) moved from
                           server/src/node/ (feature-service-packages task 3.1)
    ytdlp.ts                 yt-dlp spawn + lockdown + bounds; exports YtDlpError, matched by
                             instanceof at routers/sessions.ts
    youtubeImportGuard.ts    Per-session + global concurrency guard (singleton)
    youtubeImportScratch.ts  Startup sweep of stale per-request temp dirs
    index.ts                 Package barrel; exports MEDIA_IMPORT_FIXTURES_DIR
  media-import/fixtures/   fake-ytdlp.mjs, moved from server/src/test/fixtures/ (design D4).
                             resolveYtDlpPath deliberately stays in server/src/env.ts (gate
                             ruling E2) — PATH-probing at boot is composition-root work, not a
                             service's
  log-import/src/         @autologger/log-import — Google Sheets batch log-import domain logic
                           (L2; deps: domain, ports, session-core; exceljs declared here AND by
                           server/package.json — gate ruling E1, since
                           routers/logImport.int.test.ts imports it directly and stays in the
                           app) moved from server/src/logImport/ (feature-service-packages
                           task 5.3)
    categoryMatch.ts         Fuzzy category-name matching
    jobStore.ts              In-memory job-status store; Clock-parameterized (design D3) —
                             createLogImportJob/getLogImportJob/setLogImportStatus take a Clock,
                             appendLogImportLine/clearLogImportJobs don't read time
    runSessionLogImport.ts   Sync scoring + event creation against one matched session — the
                             service proper, taking `transcript` pre-resolved. Its
                             ensureTimedTranscript coordinator (the one production edge into
                             transcription) relocated to routers/logImport.ts instead (design
                             D2 — a non-Hono routers/coordinators/*.ts module would fail the
                             router-membership check, so the coordinator landed inside the
                             already-Hono-importing router file instead)
    sheetsFetch.ts           Public workbook fetch + row parse, via exceljs
    sheetTimecode.ts         SMPTE timecode parsing for sheet rows
    syncScore.ts             Log-row-to-transcript-seam sync scoring
    index.ts                 Package barrel
  ai-runtime/src/          @autologger/ai-runtime — the AI runtime as an L2 service package
                           (L2; deps: domain, contract, ports, session-core;
                           @anthropic-ai/claude-agent-sdk, @modelcontextprotocol/sdk) moved
                           from server/src/ai-runtime/ and the retired server/src/aiV2/
                           (ai-runtime-package task 3.1, design D1/D9): the MCP tool server,
                           CLI/Agent-SDK subprocess runners, turn orchestration, one-shot
                           generate-turn drivers, and the session aggregate computations the
                           design-turn toolset exposes. Hono-free and injection-fed (no
                           `Context`, no `AppEnv` — registry/cliPath/budget/timeout/clock
                           arrive as constructor args); imports no route module and no
                           `_helpers`. Boundary-enforced: packageBoundaries.repo.test.ts fails
                           the build if a `hono`/`appEnv`/relative reach into `server/src/`
                           lands here, or if one of these basenames reappears under routers/.
                           Consumed through the `"./*"` subpath export
                           (`@autologger/ai-runtime/<module>`), never a barrel re-export — four
                           server integration suites `vi.spyOn` a module namespace, which
                           requires both sides to resolve the identical module record (gate
                           ruling E4).
    aiMcpServer.ts            In-process, loopback-only MCP tool-server listener — registers
                               the session-scoped toolset the CLI/Agent-SDK turn calls into
                               (ai-topics-chat design D3)
    aiChatRunner.ts           Claude CLI subprocess runner: locked-down argv builder + spawn
                               (shell:false, message via stdin, never argv)
    aiV2SdkSpawn.ts           Agent SDK subprocess runner: the one call site that reaches the
                               Agent SDK's query() for AI v2 design turns
    processGroupKill.ts       Shared process-group kill ladder (SIGTERM → grace → SIGKILL,
                               group-liveness gated) used by both runners; clock is a required
                               leading parameter (design D3), and the function stays total
    aiTurnOrchestrator.ts     Shared outer turn scaffolding (timeout/abort/race/kill/finally)
                               for both the chat and v2 design turn paths
    aiTurn.ts                 driveAiTurn — shared no-orphan turn-run helper (acquire the MCP
                               listener, spawn, run to outcome, always clean up); used by
                               ai/chat and topics/generate
    aiChatRelay.ts            JSONL→SSE stream relay: maps the CLI's stream-json stdout to the
                               frozen delta/tool/done/error SSE vocabulary
    aiChatRegistry.ts         Shared per-session AI turn registry: per-session single-flight +
                               process-wide concurrency ceiling (the aiChatTurns singleton)
    aiV2PendingQuestions.ts   Pending-question registry for the AskUserQuestion round trip on
                               v2 design turns, keyed and principal-bound
    topicGenerate.ts          One-shot topics/generate turn driver (crash-safe replace-all)
    eventGeneratePrompt.ts    events/generate's generation prompt builder: dedicated one-shot
                               system prompt + the run-snapshot user-message builder
    mcpTools.ts               buildAggregateMcpServer — per-turn factory for the design-turn's
                               session-scoped aggregate MCP tools; session id is closure-bound,
                               never a tool parameter (← former server/src/aiV2/mcpTools.ts)
    aggregates.ts             Pure session-aggregate computations (duration, talk time,
                               utterance/filler/question counts, topic timeline, event
                               density/counts) over already-read hub rows; degraded timing
                               surfaces as `available: false`, never a fabricated zero (← former
                               server/src/aiV2/aggregates.ts)
    fixturesDir.ts            Exports AI_RUNTIME_FIXTURES_DIR, re-exported from index.ts
    index.ts                  Package barrel — exports ONLY AI_RUNTIME_FIXTURES_DIR, no
                               production module re-exports; this deliberate emptiness is what
                               makes the subpath-only consumption above structurally enforced
                               rather than merely conventional (a barrel re-export would open a
                               second route to the same module, undermining gate ruling E4)
  ai-runtime/fixtures/     fake-claude.mjs (shared: three in-package tests + four app-side
                           integration suites, one at two sites, + playwright.config.ts),
                           fake-claude-error.mjs,
                           fake-claude-exit-before-stdin.mjs, ai-v2-sdk-spawn-recorder.mjs —
                           moved from server/src/test/fixtures/ (ai-runtime-package task 3.3)
```

## Endpoints

This surface is **frozen** (capability spec `api-contract-freeze`): the route column below
is the normative inventory, and every route's observable behavior — JSON response shapes,
status codes, export bodies (CSV/JSONL), header/range semantics, and the WebSocket messages
listed after the table (their shapes *and* when they fire) — changes only with an
authorizing OpenSpec delta spec. The origin column records which Python module each route
was ported from: historical provenance, not a live parity claim.

**Content-encoding negotiation.** Responses under `/api/*` — and only there — are
content-encoding negotiated. A compressible body over the middleware's 1024-byte threshold
ships `Content-Encoding: gzip` when the request's `Accept-Encoding` permits it, and identity
otherwise; every negotiation-eligible response carries `Vary: Accept-Encoding` whether or not
it ended up encoded (appended to a `Vary` the route already set, never clobbering it), so a
shared cache can't hand gzip bytes to a client that never asked for them. "Compressible" is one
shared predicate — `server/src/compressibleTypes.ts`: hono's `COMPRESSIBLE_CONTENT_TYPE_REGEX`
plus `application/x-ndjson`, which that regex omits and `export.jsonl` emits. Four surfaces are
excluded **structurally** — by a property of the response or of the mount, not by an exception
list a future route could fall out of:

- **Audio byte serving** — the segment `Content-Type` is clamped on store *and* on serve (any
  value the shared predicate matches, and any blank one, degrades to `audio/webm`; everything
  else round-trips verbatim, parameters and case intact), so the filter can never select it and
  a `206`'s hand-set `Content-Range`/`Content-Length` survive untouched. Outside negotiation
  entirely, these responses also get no `Vary`.
- **SSE** — `streamSSE` sets both `Transfer-Encoding: chunked` and `text/event-stream`, each of
  which independently skips; the `Transfer-Encoding` guard runs before the `Vary` step, so an
  SSE stream is neither buffered nor `Vary`-stamped.
- **WebSocket upgrades** — no compressible body exists, and the compression middleware never
  touches `c.env`, so the `@hono/node-ws` env-identity handshake is unaffected.
- **The Next frontend bridge and `/auth/*`** — outside the `/api/*` mount scope altogether;
  Next compresses its own responses.

Content-coding is transport applied above the frozen representation: the decoded bytes of
`export.csv` / `export.jsonl` are byte-for-byte the export bodies this table freezes.

| Route | Origin (historical) |
|-------|---------------------|
| `GET /auth/google/start` · `/callback` · `GET\|POST /auth/logout` | `routers/auth.py` |
| `GET /api/studio` · `GET\|PUT /api/profile` (profile `shows[]` is the **brief** shape `{id, studio_id, name, show_code, title_suffix}` — no `categories`, no palette fields) · `GET\|POST /api/shows` · `GET /api/shows/{showId}` → **200** `{show}` in the full show shape (the brief five plus `categories`, `event_palette`, `event_palette_preset`, `event_palette_custom`); an unknown id and a non-member of the show's studio both get an identical **404** `{detail}`, so the route is no existence oracle | `routers/profile.py`, `shows.py` |
| `GET\|POST /api/sessions` · `GET\|PUT\|DELETE /api/sessions/{id}` · `…/archive\|restore` | `routers/sessions.py` |
| `GET\|POST /api/sessions/{id}/events` (GET adds `has_auto_generated`, whole-session; POST silently strips the reserved `auto_generated`/`auto_generate_run_id` metadata keys from client input) · `PUT\|DELETE …/events/{eid}` | `routers/events.py` |
| `GET …/status` · `POST …/transport/start\|stop` · `GET …/show-categories` | `routers/events.py` |
| `…/audio-recording-lease` (claim/heartbeat/release) · `GET …/ws` | `routers/events.py` |
| `POST …/events/generate` → **503** unconfigured/open-network · **409** concurrent-turn/at-capacity · **400** no-transcript/no-anchors/no-instructions/over-instruction-bound/malformed-body/`regenerate`+`selection` combo/selection-matches-no-instructions · **200** `{created, cap_hit}` configured success, plus `deleted` when `regenerate:true` (append-only; regenerate deletes the prior `auto_generated` snapshot only after a successful run creates ≥1 event — zero-created success and `502` leave prior rows intact, `deleted` reflects the post-success removal) · **502** CLI-turn-failure (already-inserted events persist) (see "Event auto-generation" above) | `routers/events.ts` (new, auto-generate-event-logs + event-generate-menu) |
| `GET\|POST …/audio/segments` · `POST …/segments/sync-from-disk` · range `GET …/segments/{id}` · `PUT …/waveform` | `routers/audio.py` |
| `GET\|POST\|PATCH\|DELETE …/transcript-words` · `…/topics` | `routers/transcribe.py` |
| `GET /api/transcript-generation/status` → **200** `{in_flight:false}` idle · **200** busy fields when held (`session_id`, `session_title`, `started_at`) | `routers/transcribe.py` |
| `…/transcript-words/generate` → **503** unconfigured · **200** `{words}` configured (see "Transcript generation" above) | `routers/transcribe.py` |
| `POST …/topics/generate` → **503** unconfigured/open-network · **409** concurrent-turn/at-capacity · **400** no-transcript · **200** `{topics}` configured success (crash-safe replace-all) · **502** CLI-turn-failure/zero-topics (prior topics unchanged) (see "AI chat (Claude CLI)" below) | `routers/transcribe.py` |
| `…/transcribe.csv` → **503** | (unavailable) |
| `POST …/local-audio-import` → **400** missing/invalid `duration_s`/empty body/missing Content-Type · **404** session · **409** rolling · **413** oversize body · **200** `{ok: true}` success (local file attach+anchor; requires `duration_s`; optional `X-Audio-Seam-Parts`; not YouTube) | `routers/sessions.py` |
| `POST /api/shows/:showId/log-import` → **404** show/non-member · **503** unconfigured/open-network · **400** bad body · **200** `{ job_id }` configured success (public Sheets log import job; see "Google Sheets log import" above) | — |
| `GET /api/log-import/:jobId` → **404** unknown/not-creator · **200** `{ status, lines, error }` | — |
| `POST …/youtube-import` → **503** unconfigured/open-network · **400** bad/non-allowlisted url · **409** concurrent-session/at-capacity · **200** `{ok: true}` configured success · **502** download/extract/bound/container/blob-write failure (see "YouTube audio import" above) | `routers/sessions.py` |
| `POST …/ai/chat` → **503** unconfigured/open-network · **200** `text/event-stream` configured (see "AI chat" below) | `routers/ai.ts` (new, ai-topics-chat) |
| `POST …/ai/v2/design` → **503** unconfigured/open-network/credentials · **200** `text/event-stream` configured (SSE: `delta`\|`question`\|`dashboard`\|`done`\|`error`) · `POST …/ai/v2/answer` → answer round trip, **200** `{ok:true}` (see "AI v2 dashboards" below) | `routers/aiV2.ts` (new, ai-v2-dashboards) |
| `GET\|PUT\|DELETE …/ai/v2/dashboard` → dashboard persistence: **200** `{config}` (GET: `{config:null}` if none) \| `{ok:true}` (DELETE), **422** invalid/bounds-exceeded, **400** malformed | `routers/aiV2.ts` (new, ai-v2-dashboards) |
| `GET …/export.csv` · `…/export.jsonl` | `routers/exports.py` / `export.py` |
| `/api/companion/presence\|state\|log\|transport\|command\|categories\|commands/*` | `routers/companion.py` |
| `/api/admin/users` · `/api/admin/studios` · `…/users/{id}/memberships\|disable\|enable` | `routers/admin.py` |
| `POST /api/teams` · `GET\|PATCH\|DELETE /api/teams/{id}` | `routers/teams.ts` (new, teams-self-serve) |
| `POST …/invites` · `DELETE …/invites/{email}` · `POST …/members/{userId}/role` · `DELETE …/members/{userId}` · `POST …/leave` | `routers/teams.ts` (new, teams-self-serve) |
| `GET /sessions/:id` (SPA shell) | (app.ts frontend bridge) |
| `GET /teams` (SPA shell) | (app.ts frontend bridge) |

**Auth callback failure redirects:** `GET /auth/google/callback` failure responses are `302` redirects to `/?login_error=<code>` where `<code>` is one of: `provider_error`, `oauth_not_configured`, `missing_params`, `state_invalid`, `exchange_failed`, `token_invalid`, `account_disabled`. The code set is additive-open. Success path unchanged: `302 /` with session cookie.

WebSocket messages broadcast by the SessionHub: `event.changed` · `transport.changed` ·
`audio.changed` · `lease.changed` · `command` (Companion → browser). The frontend consumes
these directly (`frontend/src/api/hooks/useSessionSocket.ts`): the fast status poll, the
`events_stream_revision` watcher, the `EventLogSheet` 3 s poll, and the `/companion/commands/wait`
long-poll are deleted. A single slow status poll (~1.2 s) runs **only while rolling/recording**
to advance the live timecode; the WS drives every discrete change. The `commands/wait` endpoint
still returns an immediate empty list so any stale client degrades to a slow poll instead of a
tight loop.

## Security notes

- **Client IP** is the raw socket address unless `TRUST_PROXY=1`, in which case the first hop
  of `X-Forwarded-For` (and `X-Forwarded-Proto` for cookie-secure decisions) is trusted
  instead — there is no cloud edge to pre-validate those headers, so leave `TRUST_PROXY=0`
  unless this process sits behind a proxy you control.
- **`REQUIRE_LOGIN` defaults ON** (gate decision E1) — every `/api` route requires a session
  or bearer token unless you explicitly set `REQUIRE_LOGIN=0`.
- **`NEW_USER_ALL_TEAMS` is deprecated and ignored** (teams-self-serve) — a new user's Google
  sign-in receives exactly the memberships materialized from pending email invites (possibly
  none), never a blanket grant. The key stays parsed (no env-shape break); a truthy value logs
  one deprecation warning at startup and otherwise changes nothing.
- **Startup warning on open binds** — if the process binds to a non-loopback host with
  `REQUIRE_LOGIN=0` and no `IP_ALLOWLIST`, `main.ts` prints a loud warning: every `/api` route
  is reachable from the network.
- **Google ID-token verification** fetches Google's JWKS via the global `fetch` and
  `jose`'s `createLocalJWKSet` (10-minute in-memory cache, one refetch on an unrecognized
  `kid` to ride out key rotation) — `jose`'s `node:https`-based remote-JWKS helper is not
  used, since this process may run without direct outbound HTTPS in some sandboxes and the
  manual fetch+cache path is uniform across environments.
- **Per-request bindings injection is a mutation, not a copy.** `wireApp()` in `server/src/app.ts`
  mutates the Hono context's `env` object in place rather than replacing it, because
  `@hono/node-ws`'s upgrade handshake stashes internal state on that exact object and later
  compares object identity to decide whether to complete the upgrade. Callers (including test
  harnesses) must pass a **fresh env per request** — reusing one env object across concurrent
  requests will cross-contaminate bindings.

### Environment variable reference

The deployment / auth / network knobs, consolidated. `server/.env.example` is the
authoritative, fully-commented list (including the config-gate keys below); copy it to
`server/.env` (gitignored) and fill in what you need.

| Var | Default | What it does |
|-----|---------|--------------|
| `DATA_DIR` | `./data` | Root for all state — `catalog.db`, per-session DBs, audio blobs, temp staging. |
| `HOST` | `0.0.0.0` | Network **interface to bind**. `127.0.0.1` = loopback-only (reachable only on-box / via a local reverse proxy); `0.0.0.0` = all interfaces (LAN/internet). |
| `PORT` | `8787` | TCP port to listen on. |
| `PUBLIC_BASE_URL` | *(empty; `.env.example` ships `http://127.0.0.1:8787`)* | Externally-visible origin the server **advertises** — used to build the Google OAuth callback (`…/auth/google/callback`). Must match the browser URL *and* the redirect URI registered in Google Cloud. Behind a proxy this differs from `HOST` (e.g. `https://autologger.example.com`). |
| `REQUIRE_LOGIN` | `1` | When on, every `/api` route needs a session **or** a bearer token. Set `0` only for an open, trusted LAN box (triggers the open-bind startup warning). |
| `IP_ALLOWLIST` | *(empty = off)* | CSV of allowed IPs/CIDRs (v4 + v6), enforced **before** auth. Empty disables it; a non-matching client gets `403`. A network-origin gate, orthogonal to `REQUIRE_LOGIN`. |
| `TRUST_PROXY` | `0` | When `1`, read the client IP from the first `X-Forwarded-For` hop (and `X-Forwarded-Proto` for secure-cookie decisions) instead of the raw socket. Enable **only** behind a proxy you control that overwrites `X-Forwarded-For` — otherwise the header is spoofable and can bypass `IP_ALLOWLIST`. |
| `COOKIE_SECURE` | *(auto)* | Force the session cookie's `Secure` flag on/off. Blank = auto: secure when the request itself arrived over HTTPS, **or** when `TRUST_PROXY=1` and the proxy set `X-Forwarded-Proto: https`. |
| `API_TOKEN` | *(empty)* | Companion machine bearer token. A request with `Authorization: Bearer <API_TOKEN>` passes the login gate **only on `/api/companion/*`**; everywhere else (other `/api/*` routes, the session WebSocket, `/auth/*`, `/api/admin/*`) it is ignored and the request is handled as if it carried no credential (`/api/admin/*` keeps its own `ADMIN_TOKEN`). The Companion module uses it. |
| `ADMIN_TOKEN` | *(empty)* | Bearer token gating the `/api/admin/*` routes (user + studio-definition admin). |
| `SESSION_COOKIE` / `SESSION_DAYS` | `autologger_sid` / `14` | Session cookie name and lifetime (days). |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | *(empty)* | Google OAuth credentials. OAuth is available only when both are set **and** `PUBLIC_BASE_URL` is set. |

**Config-gated feature keys** (each endpoint returns a frozen `503` until its key/binary is
present — see the linked sections above): `DEEPGRAM_API_KEY` (+ `DEEPGRAM_MODEL`) for
transcript generation, `YTDLP_PATH` (or a `yt-dlp` on `PATH`) for YouTube import,
`SHEETS_LOG_IMPORT_ENABLED` for the Google Sheets log import, and
`CLAUDE_CLI_PATH` for AI chat / topics / event generation / v2 dashboards.

**Typical public HTTPS-behind-a-proxy setup:** `HOST=127.0.0.1` (Node reachable only via the
proxy), `PUBLIC_BASE_URL=https://your.domain`, `TRUST_PROXY=1`, `REQUIRE_LOGIN=1`, and an
`API_TOKEN` for the Companion module (scoped to `/api/companion/*`) — optionally an `IP_ALLOWLIST` to further restrict access.

## Known parity windows (spec)

These are accepted operational tradeoffs, not bugs to "fix" with a cross-DB transaction:

- The catalog's sessions-index projection can be **momentarily stale** after a crash between
  a session mutation and its `projectSessionLive` mirror write — the session DB itself is
  always authoritative; the index just lags until the next mutation.
- **Ghost metadata rows** are possible: an audio-segment metadata row can exist whose blob
  bytes never landed (crash between the DB insert and the blob write, or vice versa). There is
  no background reaper for these.
- **Uploads buffer the full request body in one heap allocation**, up to 50 MB per request —
  there is no request-body streaming and no connection cap. This is an operational limit for
  single-box deployments, not a hardened multi-tenant upload path.

## Quick start (local)

```bash
npm install
cp server/.env.example server/.env # fill GOOGLE_CLIENT_ID/SECRET for real OAuth
# upgrading an existing checkout? your state moved: mv .env data server/

npm run typecheck                  # server + web + e2e
npm run dev                        # single process (tsx watch), :8787 — Next-served frontend
npm test                           # server vitest (unit + integration projects)
```

### Verify the contract

```bash
B=http://127.0.0.1:8787

# Login gate (REQUIRE_LOGIN defaults to 1 — see server/.env.example):
curl -o /dev/null -w '%{http_code}\n' $B/api/sessions                    # 401
curl -o /dev/null -w '%{http_code}\n' $B/api/profile                     # 200 (always anonymous-safe)
curl -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer <API_TOKEN>' $B/api/sessions   # 401 (API_TOKEN is honoured only under /api/companion/)
curl -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer <API_TOKEN>' $B/api/companion/state   # 200

# Anonymous parity (set REQUIRE_LOGIN=0 in server/.env): profile + shows both answer.
curl $B/api/profile
curl $B/api/shows

# OAuth round-trip needs real Google creds (GOOGLE_CLIENT_ID/SECRET in server/.env) and
# PUBLIC_BASE_URL registered as an authorized callback URI.
```

## Container deployment

The single-process path above (`npm run build && npm run start`) is unchanged. In addition the
repo builds **two independent images from one multistage `docker/Dockerfile`** and runs them
behind a small internal router (OpenSpec change `containerize-split-images`; specs
`container-deployment` and `api-contract-freeze`). Everything is driven from the repo root by
`compose.yaml`, `docker-bake.hcl`, `docker/Dockerfile`, `docker/Caddyfile` and
`docker/.env.example`.

### Topology

```
 browser / Companion
        │ HTTPS
        ▼
 Pangolin (SSO, TLS)  ── Bypass Auth: the 5 exact Companion paths only
        │
        ▼
 Newt tunnel (on the deploy host)
        │ http://127.0.0.1:${ROUTER_PORT:-8080}      ← the ONLY host port, loopback-bound
        ▼
 ┌──────────── router (Caddy, non-root, read-only rootfs) ────────────┐
 │ network `front` 172.28.10.0/24        network `back` 172.28.11.0/24 │
 └────────┬───────────────────────────────────────────┬───────────────┘
          ▼ everything not below                       ▼ /api*, /auth*, non-GET/HEAD,
   web  (Next standalone, :3000)                        trailing-slash paths, traversal rejects
   no API code, no SQLite, no binaries                 api (server API-only, :8787, single replica)
                                                        volumes: /data (DATA_DIR), /home/node
```

- **`web`** runs Next's standalone server (`output: 'standalone'`); **`api`** is the unchanged
  server booted in its API-only mode (no `web/.next`, so the bridge answers `404` for
  non-API paths). `npm run dev` / `npm run start` keep the in-process bridge.
- **`web` and `api` sit on separate networks** and only `router` joins both, so `web` cannot
  reach `api`. `api` has a fixed `container_name: autologger-api`, so
  `docker compose up --scale api=2` is refused (the SessionHub is single-process).
- **The router never authors a response** (except `abort`, which writes nothing): every
  `404`/status the single-process server pins is still produced by the server. Rules, in
  order, on the *raw, escaped, case-sensitive* request path: (1) traversal-shaped targets
  (`.`/`..` segments in any encoding, empty segments, encoded `/` or `\` under `/api`/`/auth`)
  are rewritten to the non-inventory path `/__autologger_rejected` so the server's own `404`
  answers; (2) an upgrade request (`Upgrade` + `Connection: upgrade`) outside literal `/api` is
  aborted (connection closed, no bytes); (3) `/api*` and `/auth*` (prefix letters may be
  percent-encoded, as Hono decodes them) go to `api`; (4) non-GET/HEAD go to `api`; (5) any
  other path ending in `/` goes to `api`; (6) the rest goes to `web`. The header comments in
  `docker/Caddyfile` list the invariants not to undo: no `encode` directive, no Caddy
  `path`/`path_regexp` matcher (they decode and ignore case), `transport http { compression
  off }` on every proxy, and `-Server -Via` at site level.
- **Known router edges** (fail closed, accepted): a literal `\` in the path (server serves
  `/api\profile`, the router sends it to `web` → `404`); `OPTIONS *` gets Caddy's empty `200`
  (the server returns `400`); a ~60k-character `/api` path yields an empty reply instead of the
  server's `431`; an Upgrade on `/api/x/../y` is rejected (`502`) where the server would admit
  it.
- **Caddy admin API** listens on `127.0.0.1:2019` *inside* the router container and exists only
  for its healthcheck; it is unreachable from either compose network.

### Build, push, and pin images

Images are named `ghcr.io/kwcantrell/autologger-web` and `…/autologger-api`, tagged with a git
SHA (never `latest`), in a **private** GHCR namespace. `docker-bake.hcl` builds both targets
for `linux/amd64` and `linux/arm64`.

```bash
# One-time on the build host: a docker-container builder + QEMU/binfmt for the non-native arch
# (a privileged host change; amd64 on an arm64 host, or vice versa, runs under QEMU).
docker run --privileged --rm tonistiigi/binfmt --install all
docker buildx create --name autologger-multi --driver docker-container
docker buildx inspect --builder autologger-multi --bootstrap

# Log in to GHCR with a PAT that has write:packages (classic PAT; keep it out of shell history).
docker login ghcr.io -u <github-user>

# Build + push both images, both architectures. The tag is what compose will pin.
# (-f is required: bare `bake` auto-loads compose.yaml first and fails on its required variables.)
GIT_SHA=$(git rev-parse --short=12 HEAD) docker buildx bake -f docker-bake.hcl --builder autologger-multi --push
```

- Bake tags with `GIT_SHA` only, so a dirty working tree still gets a clean-looking SHA: build
  from a clean checkout. The QEMU-emulated build is slow; `better-sqlite3` uses prebuilds. The `web` build stage runs on the
  build host's native platform (`next build`'s SWC crashes under QEMU amd64); only the `api` stage
  is emulated for the non-native architecture.
- **Deploy host:** `docker login ghcr.io` with a PAT that has **`read:packages`** only. An
  anonymous pull of the private images must be refused.
- `docker compose build` builds the images for the *native* architecture only (local runs,
  `npm run e2e:container`); it does not push.
- **Pin the tags** in the compose `.env` (`WEB_TAG=<sha>`, `API_TAG=<sha>`). The compose
  interpolation (`${WEB_TAG:?…}`) refuses an *unset* tag but does **not** reject the literal
  value `latest`; the operator must not use it.
- **Build-time egress:** the Docker build downloads from Docker Hub (base images, Caddy),
  the npm registry (`npm ci`, the pinned `@anthropic-ai/claude-code`), and GitHub releases
  (the pinned `yt-dlp` and `deno` binaries).
- **Rebuilding when `yt-dlp` / `deno` go stale.** YouTube changes break pinned extractors. In
  `docker/Dockerfile` bump `YTDLP_VERSION` together with **both** `YTDLP_SHA256_AMD64` /
  `YTDLP_SHA256_ARM64` (from the release's `SHA2-256SUMS`), and `DENO_VERSION` together with
  `DENO_SHA256_AMD64` / `DENO_SHA256_ARM64` (the release's `.zip.sha256sum` files). A version
  without its matching sums fails the build's `sha256sum -c`. Then bake with a new `GIT_SHA`,
  push, and roll out per *Update order* below. `CLAUDE_CODE_VERSION` is pinned the same way.
- **Image sizes.** `web` is ~300 MB. `api` is ~1.29 GB because it carries the Node runtime with
  the server's production dependencies (including `next`, which the server requires lazily for
  the bridge and which the API-only mode never loads), the pinned `claude` CLI and Agent SDK
  platform binaries, and `yt-dlp` + `deno` in `/opt/ytdlp`. It carries no `ffmpeg` (the server
  selects a single `bestaudio` format and never merges).

### Configuration

```bash
cp docker/.env.example .env        # repo root; gitignored — never commit it
$EDITOR .env
docker compose up -d
```

Compose reads `.env` for interpolation and passes it to `api` as `env_file`. It is separate
from `server/.env` (single-process runs); `compose.yaml` is authoritative for containers.

| Var | Required | Why |
|-----|----------|-----|
| `WEB_TAG`, `API_TAG` | yes | Git-SHA image tags (see above). Compose refuses to start without them. |
| `PUBLIC_BASE_URL` | yes | The public HTTPS origin (e.g. `https://autologger.nrvo.ai`). Builds the OAuth redirect `${PUBLIC_BASE_URL}/auth/google/callback`. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | yes | Google sign-in; with `REQUIRE_LOGIN=1` there is no other way in for people. |
| `API_TOKEN` | if Companion is used | Companion bearer token, **≥ 32 random bytes**. Authenticates **only** `/api/companion/*`. |
| `ADMIN_TOKEN` | yes for cutover | Gates `/api/admin/*` (membership bootstrap). |
| `ROUTER_PORT` | no (`8080`) | Host loopback port the router publishes; the Newt target. |
| `DEEPGRAM_API_KEY` | optional | Enables transcript generation (else `503`). **Sends recorded audio to DeepGram's cloud STT and spends money.** |
| `AI_V2_API_KEY` | leave unset | AI v2 stays **off**; see security notes. |

The compose `environment` block fixes `REQUIRE_LOGIN=1`, `TRUST_PROXY=1`, `COOKIE_SECURE=1` and
`PUBLIC_BASE_URL` — values there take precedence over `env_file`, so the env file cannot switch
login off. The image itself sets `NODE_ENV=production`, `DATA_DIR=/data`, `HOST=0.0.0.0`,
`PORT=8787`, `YTDLP_PATH=/opt/ytdlp/yt-dlp` and `CLAUDE_CLI_PATH`, so YouTube import and the
Claude-CLI features (AI chat, topics, event generation) are *available*; `REQUIRE_LOGIN=1` is what
satisfies their open-network refusal. `IP_ALLOWLIST` is not set by default.

Every service has `restart: unless-stopped`, `init: true`, json-file log rotation (10 MB × 5)
and a healthcheck that needs no extra tools (`api`: `GET /api/profile`, `web`: `GET /`, `router`:
the loopback Caddy admin endpoint). Both bridge subnets are pinned in `compose.yaml`
(`172.28.10.0/24` front, `172.28.11.0/24` back) and their gateways (`172.28.10.1`,
`172.28.11.1`) appear in `docker/Caddyfile` `trusted_proxies`: **if you must change a subnet,
change it in both files together.**

**Runtime egress** from `api`: DeepGram (audio, if configured), YouTube and the media hosts
`yt-dlp` fetches (import), Anthropic (the `claude` CLI), Google (JWKS, OAuth, Sheets import).
The image fetches nothing else at runtime; the Claude CLI auto-updater is disabled.

### Volumes

| Volume (compose name) | Mount in `api` | Holds |
|-----------------------|----------------|-------|
| `autologger_autologger-data` | `/data` (`DATA_DIR`) | `catalog.db`, `sessions/*.db`, `blobs/`, `tmp/` |
| `autologger_autologger-home` | `/home/node` | `~/.claude/` **and** `~/.claude.json` (subscription credentials and CLI config) |

Both are owned by uid 1000 (`node`); a fresh named volume inherits that from the image. State
survives `docker compose up -d` recreation onto a new image tag.

**Auto-updater on a pre-existing home volume.** The image bakes `~/.claude/settings.json`
with `{"env":{"DISABLE_AUTOUPDATER":"1"}}`, but a volume that already has content shadows the
baked file. When you seed or reuse a `/home/node` volume, create (or merge into) that file
yourself, owned by uid 1000:

```json
{ "env": { "DISABLE_AUTOUPDATER": "1" } }
```

(The server strips unlisted variables from the CLI child's environment, so the setting must
live in `settings.json`, not the container env.)

### Pangolin target and the Companion bypass

1. In Pangolin, point the resource's target at the host's **Newt** and from there to
   `http://127.0.0.1:${ROUTER_PORT}` (default `127.0.0.1:8080`). Use a **single** target for
   the domain: Pangolin issue fosrl/pangolin#2294 makes multiple targets on one domain
   load-balance and ignore path rules, and all routing lives in the repo's router anyway.
2. Keep SSO on the resource, and add **Bypass Auth** (Accept) rules for **exactly these five
   paths**, no wildcards:

   ```
   /api/companion/state
   /api/companion/categories
   /api/companion/log
   /api/companion/transport
   /api/companion/command
   ```

   These are the only routes the Companion module calls. **Do not use `/api/companion/*`.**
   Two reasons: (a) a wildcard lets a crafted target such as
   `/api/companion/%2e%2e/sessions/x` slip through the proxy's SSO wall and be normalized to
   `/api/sessions/x` by the server's URL parser — the router rewrites dot-segment and
   encoded-slash targets to a `404`, but the proxy rule should not rely on that alone; and (b)
   the token scope is enforced server-side (`API_TOKEN` is honoured only under
   `/api/companion/*`), but the extra routes under that prefix (`commands/wait`,
   `commands/:commandId/ack`) are not used by the module and need no anonymous exposure.
3. Reconfigure each Companion install with the server URL and the new `API_TOKEN`.

### Google OAuth client

In Google Cloud Console → *APIs & Services* → *Credentials* → *Create credentials* → *OAuth
client ID* → application type **Web application**. Add the **authorized redirect URI**
`${PUBLIC_BASE_URL}/auth/google/callback` (e.g. `https://autologger.nrvo.ai/auth/google/callback`).
If the OAuth consent screen is in **Testing** mode, add every intended user's Google account
under *Test users* — anyone else is refused by Google. Put the client ID/secret in `.env`. The OAuth client must exist and be ready *before* cutover.
Note that the redirect URI is always `${PUBLIC_BASE_URL}/auth/google/callback`: a sign-in
started on the loopback pre-flight port is sent back to the **public** origin by Google, so the
full round trip (and the `Secure` session cookie) can only be proven end to end once Pangolin
points at the stack. The loopback pre-flight proves the sign-in start and the stack's health;
the post-repoint "verify from outside" list proves the callback.

### Security notes for this topology

- **`API_TOKEN` is not a general credential.** It authenticates only `/api/companion/*`
  (the session WebSocket, other `/api/*`, `/auth/*`, `/api/admin/*` ignore it). Use a token of
  ≥ 32 random bytes and rotate it by editing `.env`, recreating `api`, and updating the
  Companion installs. Any external script that used it against `/api/sessions` etc. must use a
  real login session instead.
- **Subscription credentials (accepted risk, owner ruling G5).** AI chat, topics and event
  generation run the `claude` CLI with the *mounted* `~/.claude` subscription login, so every
  signed-in user's AI turns spend the owner's personal claude.ai subscription; the codebase
  itself flags this as a policy problem. The refresh token also lives in the same container
  that runs `yt-dlp` on user-chosen media. This is accepted for this deployment.
- **AI v2 is off.** Its non-interactive path needs `AI_V2_API_KEY` (a login-fallback is
  loopback-only). Do not set it unless you intend to enable AI v2 and accept the cost.
- **Shell and asset requests are not guaranteed `IP_ALLOWLIST` coverage.** In this topology
  requests routed to `web` (HTML shells, `/_next/*`, `public/`) never reach the server's
  allowlist middleware; only `api` traffic does. They carry no data and sit behind SSO. Do not
  rely on `IP_ALLOWLIST` to hide the frontend.
- **Host-local reach.** Any process on the deploy host can reach `127.0.0.1:${ROUTER_PORT}`
  without going through Pangolin/SSO (Docker blocks LAN access to loopback-published ports).
  The host is assumed single-tenant. A host-local caller that sends its own
  `X-Forwarded-For` is also trusted by the router (the host arrives as the trusted bridge
  gateway) — a documented limitation, not reachable from outside.
- **Forwarded headers.** The router trusts `X-Forwarded-For` only from the pinned gateways,
  resolves the client as the rightmost untrusted address, and sends `api` exactly one value
  (`TRUST_PROXY=1`). This only protects you if **your reverse proxy overwrites or appends** to
  `X-Forwarded-For` rather than passing the client's header through untouched. Verify against
  your Pangolin: from outside send `curl -H 'X-Forwarded-For: 1.2.3.4' …` to an endpoint that
  reports the client IP (or check server logs) and confirm `1.2.3.4` is **not** what `api`
  sees.
- **Anonymous-era data.** Moving from `REQUIRE_LOGIN=0` to `1` means existing sessions and
  teams become visible to a signed-in user only after memberships are granted (below).
- **Registry credentials.** Never commit `.env`, PATs, or tokens; the images are built with a
  root `.dockerignore` that excludes `**/data`, `**/.env*` and other secret-shaped files.

### Blob sync guard (used by every `rsync --delete` below)

Every blob mirror below uses `rsync --delete`. A missing or accidentally empty source (a
mistyped path, an unmounted disk, a failed earlier hop) would otherwise wipe the destination.
`BLOBSYNC` refuses that: the source directory must exist, and an **empty source is refused
whenever the destination has files**. An empty source onto an empty destination is allowed, so a
brand-new install with no blobs still works. To empty a populated destination deliberately, run
`rsync` by hand. Define it once in the shell you run the blocks below from (the cutover block
checks it is set):

```bash
BLOBSYNC='set -eu
src=$1; dst=$2; own=${3:-}
[ -d "$src" ] || { echo "blob source $src missing - refusing --delete" >&2; exit 1; }
if [ -z "$(ls -A "$src")" ] && [ -n "$(ls -A "$dst" 2>/dev/null)" ]; then
  echo "blob source $src is empty but $dst has files - refusing --delete" >&2; exit 1; fi
mkdir -p "$dst"
rsync -a --delete ${own:+--chown="$own"} "$src"/ "$dst"/'
# usage: sudo bash -c "$BLOBSYNC" _ <src-dir> <dst-dir> [uid:gid]
```

### Backup

Use the WAL-safe copier from a repo checkout on the host (it needs `tsx` and `better-sqlite3`,
which the checkout has; it is not in the image). It opens every `*.db` read-only, copies a
single consistent snapshot with SQLite's online-backup API, then runs `PRAGMA integrity_check`
and a per-table row-count comparison on the copy, and swaps it in atomically.

```bash
VOL=$(docker volume inspect -f '{{.Mountpoint}}' autologger_autologger-data)   # root-only path
BK=/backups/autologger-$(date +%F)
# $VOL is unreadable to your user, so the copier runs as root; root's PATH usually lacks node
sudo env "PATH=$PATH" npx tsx server/scripts/copyDataDir.ts "$VOL" "$BK" [--overwrite] [--dry-run]
sudo bash -c "$BLOBSYNC" _ "$VOL/blobs" "$BK/blobs"    # blobs are plain files; guarded (above)
```

Run it from the repo checkout (`sudo` there needs the checkout's `node_modules` readable, which
it is). The backup does **not** need `api` stopped: the source is opened read-only through the
online-backup API, so a live server is fine. Only `--overwrite` onto a *destination* that a
process has open needs that process stopped (see below). Files the copier writes are owned by
root; that is fine for a backup.

Exit codes: `0` ok, `1` copy or verification failure (integrity, row counts, corrupt DB), `2`
usage error or a refused unsafe invocation (destination equals/nests with the source, missing
source, existing destination DBs without `--overwrite`, or `--overwrite` onto a destination DB
that another process still has open). It never writes to the source, so it is safe against a
running server. With `--overwrite` it deletes the destination DB's stale `-wal`/`-shm`/`-journal`
files after the new copy is verified and before the atomic rename (a leftover `-wal` next to a
replaced `.db` could otherwise be replayed onto it); **stop the `api` before replacing DB
files** — the copier refuses if it detects the destination open, but that check is a
safeguard, not a substitute for stopping the service. Also back up the `/home/node` volume (`~/.claude*`) if the
credentials matter.

### Migrating an existing deployment (minimal downtime)

The goal is to seed the volume while the old server keeps running and do only the final
database copy and a blob delta inside the maintenance window. Below, `OLD` is the old host and
`OLD_DATA` its `DATA_DIR`; `VOL` is the `autologger_autologger-data` mountpoint (as above).

**Preconditions.** The OAuth client exists and is verified (see above); `.env` is filled in
(Google credentials, `API_TOKEN` ≥ 32 bytes, `ADMIN_TOKEN`, `DEEPGRAM_API_KEY`; no
`AI_V2_API_KEY`); the images are pushed with pinned tags; this host has run `docker login
ghcr.io` with a `read:packages` PAT; `docker compose up --no-start` has created the volumes.

**1. Pre-seed (no downtime; api stopped on this host, old server still running elsewhere).**
Take a WAL-safe copy of a point-in-time `DATA_DIR` snapshot into a staging directory and load it
into the volume, blobs included, home directory included:

```bash
npx tsx server/scripts/copyDataDir.ts /path/to/snapshot/data /srv/stage      # DBs only; prints the blobs rsync
#   (re-running into a populated /srv/stage needs --overwrite; the api must be stopped)
sudo rsync -a --chown=1000:1000 --exclude /blobs /srv/stage/ "$VOL/"
# Blobs: as YOUR user (ssh agent intact) into a persistent user-owned mirror, then root copies
# locally. Keep the mirror: the cutover delta (step 3d) reuses it, so it stays small.
BMIRROR=$HOME/autologger-blob-mirror; mkdir -p "$BMIRROR"
rsync -a --delete OLDHOST:/path/to/DATA_DIR/blobs/ "$BMIRROR"/     # or a local snapshot's blobs/
sudo bash -c "$BLOBSYNC" _ "$BMIRROR" "$VOL/blobs" 1000:1000
# ~/.claude and ~/.claude.json -> the home volume, then create/merge settings.json (see Volumes)
HOMEVOL=$(docker volume inspect -f '{{.Mountpoint}}' autologger_autologger-home)
sudo rsync -a --chown=1000:1000 ~/.claude ~/.claude.json "$HOMEVOL/"
```

**2. Pre-flight on loopback.** `docker compose up -d`, then on `127.0.0.1:${ROUTER_PORT}` run
your own probes. **Do not run `npm run e2e:container` now:** it uses the same compose file, so
the fixed `autologger-api` container name and the pinned `172.28.10.0/24`/`172.28.11.0/24`
subnets clash with the running production stack. Run it on another host, or before you bring
production up (`docker compose down` first if it is up). **Do not attempt a
Google sign-in on loopback:** the OAuth callback always returns to `PUBLIC_BASE_URL`, so it can
only complete through the public origin. The sign-in and `Secure` session-cookie check happens
only in the outside verification after the Pangolin repoint. Rehearse the membership bootstrap
(below); users who have never signed in do not exist in the catalog yet and are reported
`PENDING` (exit `3`), so the bootstrap is re-run after their first sign-in. Then
`docker compose stop api` before the window and keep it stopped until step 3e: a running `api`
leaves `-wal`/`-shm` files that must not sit next to a replaced `.db`.

**3. Cutover window (downtime starts).**

```bash
# a. stop the old server on OLD; api here is already stopped (docker compose stop api)
: "${BLOBSYNC:?define BLOBSYNC first (Blob sync guard section)}" &&
BMIRROR=${BMIRROR:-$HOME/autologger-blob-mirror} &&
# b. on OLD, from its checkout, WAL-safe copy of every DB into a FRESH staging directory
STAGE=$(ssh OLDHOST 'mktemp -d') &&       # fresh and empty: never reuse a previous stage
ssh OLDHOST "cd /path/to/autologger && npx tsx server/scripts/copyDataDir.ts /path/to/DATA_DIR $STAGE" &&
# c. bring the stage here as your user (no root ssh agent needed), into a fresh local dir, then
#    let the copier replace the volume's DBs. It refuses an in-use destination DB, verifies
#    integrity + row counts, and removes each replaced DB's stale -wal/-shm/-journal.
LSTAGE=$(mktemp -d) &&
rsync -a OLDHOST:"$STAGE"/ "$LSTAGE"/ &&
#    Steps b through e (old-host copy, stage rsync, copy, prune, chown, blob delta, integrity check, api start) are ONE
#    `&&` chain: paste it as a single block; each command runs only if the previous exited 0,
#    so a failed stage copy never reaches the prune and a failed integrity check never starts api.
sudo env "PATH=$PATH" npx tsx server/scripts/copyDataDir.ts "$LSTAGE" "$VOL" --overwrite &&
#    the copier never deletes: drop volume DBs (and sidecars) for sessions deleted since the
#    pre-seed, i.e. present in the volume but absent from the stage. Reached ONLY after the
#    copier exited 0; it refuses (deletes nothing, exits 1) if the stage is missing or has no
#    catalog.db, so an empty or mistyped $LSTAGE can never wipe the volume.
sudo env VOL="$VOL" LSTAGE="$LSTAGE" bash -c 'set -euo pipefail
  [ -f "${LSTAGE:?}/catalog.db" ] || { echo "stage has no catalog.db - refusing to prune" >&2; exit 1; }
  want=$(cd "$LSTAGE" && find . -name "*.db" | sort)
  have=$(cd "${VOL:?}" && find . -name "*.db" -not -path "./blobs/*" | sort)
  comm -13 <(printf "%s\n" "$want") <(printf "%s\n" "$have") |
  while IFS= read -r f; do [ -n "$f" ] || continue; echo "removing stale $f"
    rm -f "$VOL/$f" "$VOL/$f-wal" "$VOL/$f-shm" "$VOL/$f-journal"; done' &&
#    the copier ran as root: give the DB files back to uid 1000 (blobs/ untouched here)
sudo find "$VOL" -path "$VOL/blobs" -prune -o -exec chown -h 1000:1000 {} + &&
# d. blob delta, mirroring deletions: rsync from OLD as YOUR user (ssh agent and ~/.ssh/config
#    intact) into the user-owned mirror seeded in step 1, then root copies locally, guarded
#    against an empty/missing source (see Blob sync guard).
mkdir -p "$BMIRROR" &&
rsync -a --delete OLDHOST:/path/to/DATA_DIR/blobs/ "$BMIRROR"/ &&
sudo bash -c "$BLOBSYNC" _ "$BMIRROR" "$VOL/blobs" 1000:1000 &&
# e. integrity: the copier already ran integrity_check + per-table row counts (copy vs source)
#    before exiting 0. Re-check the shipped files, entirely as root (needs the sqlite3 CLI);
#    prints "<result>  <file>" per DB and exits non-zero if any is not "ok":
sudo sh -c 'rc=0; for f in "$1"/catalog.db "$1"/sessions/*.db; do
    r=$(sqlite3 "file:$f?mode=ro" "PRAGMA integrity_check" 2>&1 | head -1)
    echo "$r  $f"; [ "$r" = ok ] || rc=1; done; exit $rc' _ "$VOL" &&
docker compose up -d api ||
  echo "CUTOVER STEP FAILED (see output above) - stop here; do not continue past the failed command"
# f. re-run the membership bootstrap (below)
# g. repoint the Pangolin target at Newt -> 127.0.0.1:${ROUTER_PORT}
# h. add the 5 exact-path Companion bypass rules
# i. reconfigure the Companion installs with API_TOKEN
```

Notes on step 3c:

- **Why not `rsync --delete` onto `$VOL`?** A `--delete` on the volume root can delete anything
  the exclude list forgets (`tmp/`, `blobs/`, future top-level entries). The copier only ever
  writes `*.db` files, and the explicit prune above removes only `*.db` (plus their sidecars)
  that the stage lacks, so nothing else in the volume can be touched. Starting from a fresh
  `mktemp -d` stage matters: a leftover stage would resurrect sessions deleted since.
- **A multi-DB run is not atomic.** Each DB is swapped in individually; if one fails
  verification the run exits `1` with the earlier DBs already replaced. Fix the cause and re-run
  the same command with `--overwrite` (it is idempotent); do not start `api` until it exits `0`
  and the prune and the integrity check in step 3e have run.
- **`sudo rsync … OLDHOST:` may not carry your ssh agent.** Under `sudo` `SSH_AUTH_SOCK` is
  dropped by default; either `sudo -E` (or `sudo env SSH_AUTH_SOCK="$SSH_AUTH_SOCK" …`), or, as
  above, rsync as your own user into a user-owned directory and let root copy locally. The blob
  delta in step 3d does exactly that: `rsync` from `OLDHOST` as your user into `$BMIRROR`, then
  a local guarded `sudo` copy into `$VOL/blobs`. Never put `sudo` in front of an `OLDHOST:` rsync.

Downtime ends after (i). **Verify from outside:** the OAuth round trip; Companion `state`,
`log`, `command`; traversal through a bypass path (`/api/companion/%2e%2e/sessions/x`) returns
`404`; a non-Companion `/api` path returns the Pangolin SSO `302`; a live session WebSocket
connects; a forged `X-Forwarded-For` is not adopted; and a **Google sign-in through the public
origin** (the first place the callback and the `Secure` session cookie can be proven). Users
who have not signed in yet are `PENDING`; re-run the membership bootstrap after they do.

### Membership bootstrap (re-runnable)

`server/scripts/bootstrapMemberships.example.ts` is a **template**: copy it, and write a
memberships JSON file (`{ "teams": [{id, display_name}], "memberships": [{email, team,
role?}] }`; not committed). It drives only the existing `ADMIN_TOKEN` endpoints and is
idempotent: existing teams are skipped, a member already in a team with no `role` given is a
no-op, a given `role` is re-applied (re-POSTed, so it **overrides a role changed in the UI**
since the last run; omit `role` for members whose role should be left alone).

```bash
ADMIN_TOKEN=<from .env> npx tsx server/scripts/bootstrapMemberships.example.ts memberships.json \
    [--base-url http://127.0.0.1:8080] [--dry-run]
```

The token comes only from the `ADMIN_TOKEN` environment variable and is never printed. Users
exist only after their first Google sign-in, so an unknown email is reported `PENDING`
(exit `3`); re-run after they sign in. Exit codes: `0` done, `1` error, `2` usage, `3` pending.
Because the cutover replaces `catalog.db`, run it again in the window (step 3f).

### Update order and rollback

- **Update order: `api` first, then `web`.** Set the new `API_TAG` in `.env`, then
  `docker compose pull api && docker compose up -d api`, wait for `healthy`; then the same
  for `WEB_TAG`/`web`. The HTTP/WS contract is frozen, so a new `api` under an old `web` is
  safe. Volumes carry state across recreation.
- **Rollback is forward-only for data.** Re-pinning an older tag is safe only if no database
  migration ran in between (migrations are forward-only, `packages/storage/src/migrate.ts`);
  otherwise restore a backup taken before the upgrade. Repointing Pangolin at the *old host*
  drops every write made since cutover (they exist only in the volume) — take a final backup
  first if you might want them.
- **One host, two stacks.** `api` has a fixed `container_name`, so `npm run e2e:container` (compose
  project `alg-e2e`) and a production stack cannot coexist on the same Docker host; the e2e
  script refuses to run if its project already has containers, and will fail on the name
  clash while production is up. Run it elsewhere or stop production first.

### Verifying the container topology

`npm run e2e:container` builds the web bundle and both images from the current tree, starts a
single-process reference server and the compose stack (test-only `e2e/container/compose.e2e.yaml`,
random throwaway secrets), runs the Playwright `container` project (a differential matrix
between the router and the single-process server, raw-socket upgrade checks, traversal,
encoding parity, session WebSocket, token scope, plus `serving-contract.spec.ts`), and tears
everything down. It is excluded from the default `npm run e2e`. Not covered locally and owed at
cutover: the forged-`X-Forwarded-For` check through your real Pangolin, and the amd64 image's
behaviour under QEMU.

## Frontend (web/ workspace)

The React frontend lives in `web/` (Next.js 15 App Router + React 19, Tailwind v4) and is
canonical for this app. `npm run build` runs `next build`, emitting `web/.next/`; the server
bridges unmatched GET requests to Next (`server/src/node/nextFrontend.ts`, mounted from a Hono
catch-all — `frontend.handle(...)`) rather than serving prebuilt static files. `GET /`,
`GET /sessions/:id`, `GET /teams`, and `GET /admin/users` all render through the shell (the API
root is hardcoded same-origin `/api`; the two route groups share page identity per path, but
responses are no longer byte-identical — Next embeds the requested route's serialized URL data).
Hashed bundles are served at `/_next/static/*` (was `/assets/*` under Vite); `/static/*` is
served straight from `web/public/static/` — the favicon logos, plus the two preloaded font files
under `static/fonts/` (see **Styling** below). The `/_next/image` optimizer is disabled (`images: { unoptimized: true }` in `web/next.config.ts`) — the app uses
plain `<img>` throughout, and the optimizer is an unauthenticated compute endpoint this repo
declines to expose. Heavy app trees are mounted as client-only (`ssr: false`) islands inside a
server-rendered shell (layout chrome, fonts, a static loading skeleton) — the shell reads no
cookies and embeds no session- or catalog-derived data.

### Client island

The `ssr: false` island is **route-split behind `React.lazy`**, not one bundle: six surfaces
load on demand — the session workspace (`WorkspaceStatic`, mounted by `SessionRoute`), the teams
route, and four modals (New Session, Batch Import, YouTube Import Error, Home Settings).
Everything on the very first homepage paint — the rail, home route, login page, root gate, and
`SessionRoute` itself — stays statically imported, since splitting it would only buy a
waterfall. Every boundary goes through `LazyChunk`
(`web/src/pages/index/components/ChunkLoadBoundary.tsx`): the island has no error boundary above
it (the `pageExtensions` pin means no `error.page.tsx`), so a rejected chunk import — routine,
because a redeploy rewrites content-hashed chunk URLs under any open tab — would otherwise
unmount the whole app to a blank page. Its Retry **rebuilds the `lazy()` instance**, since
`React.lazy` memoizes rejections and a module-scope instance that has failed re-throws forever.
Route boundaries fall back to the same `RouteLoadingState` frame the pending route already
renders; overlay boundaries fall back to `null`. Only two of the six are warmed — settings on a
2.5 s idle prefetch, the workspace on session-route entry — and a cold chunk fetch shows no busy
affordance on the control that invoked it.

Four things keep the session page inside its render and transfer budget. The **event feed is
virtualized** (`@tanstack/react-virtual`, using the two-spacer-`<tr>` idiom `TranscribeFeed`
established — the real `<table>`, its `colgroup`, and the sheet chrome are untouched), so a
66-event session mounts ~18 rows rather than 66. Because inline edits in both feeds are
uncontrolled, a shared **draft store** (`web/src/pages/index/utils/draftStore.ts`) backs them:
text typed into a row the virtualizer then unmounts is re-seeded on remount instead of silently
discarded, and a draft is cleared only once its save has round-tripped. The **transcript-words
fetch is deferred** behind a sticky per-session gate (`TranscriptWordsGateContext`) that opens on
the first activation of Transcript, Topics, or Export and resets on session change — opening a
session on the Event Feed transfers 172 KB of API payload instead of ~5.3 MB, with the word
payload (614 KB gzip) fetched only when first needed. And the **Companion presence heartbeat runs
off a Web Worker clock** (`web/src/shared/utils/workerInterval.ts`), because Chrome coalesces a
long-hidden tab's main-thread timers to roughly one wakeup a minute — four times the server's 15 s
presence freshness window — which would drop a backgrounded tab as a Companion target; where a
worker can't be created (no `Worker`, or a CSP denying `blob:` workers) it falls back to a
main-thread timer and that guarantee does not hold.

The page-leave warning is **queue-scoped**: `beforeunload` is registered only while the chunk
rescue queue is non-empty or an upload is in flight — and, in `AudioRecorder`, only for the span
of an actual recording — because a registered listener disqualifies the page from the
back/forward cache on its mere presence, whether or not it would ever warn. With nothing to lose,
the app stays bfcache-eligible.

### Styling (Tailwind v4)

All styling lives in one entry, `web/src/shared/theme/tailwind.css`, side-effect imported
(before `overlayscrollbars/overlayscrollbars.css`, pinned order) from each route group's root
layout (`web/src/app/(index)/layout.page.tsx`, `web/src/app/(admin)/layout.page.tsx`). No CSS
Modules, no per-component `*.css` files. Layers, declared in order:

- **`theme`** — two `@theme` blocks emit the design-token scale. `@theme inline` holds
  tokens whose only job is generating utilities (`--color-*`, `--radius-*`); `@theme
  static` unconditionally emits a few tokens (`--color-text`, `--color-accent`,
  `--font-mono`, …) into `:root` because TSX inline styles and arbitrary-value utilities
  (`font-[family-name:var(--font-mono)]`) read them as raw `var()` strings the Tailwind
  scanner can't see as utility candidates otherwise.
- **non-namespace `:root` block** — tokens with no Tailwind theme category (the `--v4-*`
  pixel-matched layout values, `--z-*` z-index scale, compound gradient/shadow stacks,
  alpha-composited colors used only as gradient ingredients) plus **preserved legacy
  names** (`--bg`, `--accent`, `--v5-primary`, …) kept byte-identical so the handful of
  TSX inline-style `var()` consumers (Timeline, TimelineMarkers, NewSessionModal,
  EventLogRow) keep resolving without a rename sweep through JSX.
- **`base`** — body baseline, fonts, resets (formerly `baseline.css`).
- **`components`** — chrome families ported as named `@utility` / `@layer components`
  rules (`.btn`, `.field`, `.glass-panel`, …), multi-consumer classes, exotic-selector
  rules Tailwind can't express inline (`::-webkit-scrollbar`, keyframes), and
  `perfDebug`'s cross-component `body.perf-dbg--*` escape hatches.
- **`utilities`** — Tailwind's generated utility set, used inline in JSX composed with
  `clsx` at the existing call sites (exclusive branches per state, not toggled overrides).

Two conventions worth knowing before touching component styles:

- **`hover-always`** — a `@custom-variant hover-always (&:hover)` for the repo's dominant
  hover flavor (fires on touch-tap too). Tailwind's stock `hover:` is gated behind
  `@media (hover: hover)` in v4, which only three chrome `.btn` hovers actually want.
- **Ancestor-scoped overrides** convert as arbitrary variants keyed off ancestor DOM,
  e.g. `[#v4-log-session_&]:...`, rather than living in the ancestor's own file — this
  keeps a component's look-changing rules with the component they change.

Stable ID/data-attribute hooks (`#v4-log-sheet`, `tr[data-event-id]`, `#v3-session-grid`,
`#btn-ctl-*`, `[data-category-id]`, `body[data-v4-transport]`, …) are untouched by the
migration — e2e and Companion selectors keep working. `body[data-v4-transport]` is set
dynamically at runtime (`SessionWorkspace.tsx`), so its `@layer components` block in
`tailwind.css` is live styling, not dead code — the file carries a parity comment at that
rule.

Fonts are vendored locally — no CDN requests at runtime, and the visual harness (below) is
network-independent as a result. Four families ship: **Inter**, **Roboto**, **Poppins**, and
**League Gothic** (the Oswald and Chivo Mono faces and files were deleted — nothing in
`web/src` referenced them; an unreferenced `@font-face` never downloads, so what that removed
is source and build size, not transfer). Inter is **one** `@font-face` with a `font-weight`
*range* of `400 600`, not three per-weight faces: those were byte-identical copies of the same
variable font, so the browser fetched the same ~48 KB file three times to render one typeface.
The two faces on the critical path — the deduplicated Inter latin subset and the League Gothic
latin subset the boot loading skeleton renders in — are served from
`web/public/static/fonts/{inter-latin-var,league-gothic-latin}.woff2` at stable, deliberately
**non-content-hashed** URLs, so the index route group's `<link rel="preload" as="font"
crossorigin>` and the stylesheet's `src:` name the same URL and share one request (a mismatch
would fetch the font twice, and `crossorigin` is mandatory even same-origin because fonts are
always fetched in CORS mode). Everything else — Roboto, Poppins, and League Gothic's latin-ext
and vietnamese subsets — stays a bundler-emitted asset import under `web/src/assets/fonts/`.

### Dev flow

```bash
npm run dev        # single process (tsx watch), :8787 — Next dev-serves the frontend
```

Browse `http://127.0.0.1:8787/`. Deep links (`/sessions/<id>`, `/teams`, `/admin/users`) work
natively — the Next App Router catch-all renders the shell for every router-known path, so no
dev-only shell middleware is needed (the retired `web/vite.config.ts`'s `sessionDeepLinkDevShell`
plugin and its `/api`+`/auth` proxy are gone; dev and prod now share one origin and one port).
Editing a web-source file triggers Next's webpack-pipeline dev HMR (Turbopack is unavailable
under a custom server) with no server restart; editing a server-source file restarts the `tsx
watch` process, which re-`prepare()`s Next (amortized by the on-disk `.next` cache — `tsx watch`
excludes `web/**` so Next's own build-output churn under `web/.next/**` can't trigger spurious
restarts). The session WebSocket (`/api/sessions/:id/ws`) and Next's dev HMR socket
(`/_next/webpack-hmr`) coexist on the same upgrade path, dispatched by path prefix
(`server/src/upgradeDispatch.ts`).

**`web/next.config.ts` edits need a manual restart** — Next reads its config only at
`prepare()`, and (per the exclusion above) a config-only edit under `web/**` doesn't trigger
one; `Ctrl-C` and re-run `npm run dev`. Every other `web/src/**` edit gets normal HMR.

**Dev auth is anonymous by design**: set `REQUIRE_LOGIN=0` in `server/.env`. Dev OAuth now
round-trips same-origin at `:8787` for the first time (the retired Vite proxy could never carry
the Google callback) — set real `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` and a `:8787`
`PUBLIC_BASE_URL` to verify it directly against `npm run dev`. The production serve path still
works too, and remains the only way to test from a LAN device (see below):

```bash
npm run build && npm run start   # everything on :8787
```

If dev auth is misconfigured (login required but no session), the first symptom is an
opaque WebSocket drop — the 401 fires before the upgrade, so the browser sees a bare
close with no status.

**Keep dev loopback-bound.** The `dev` script defaults `HOST=127.0.0.1` (overridable) — the
successor to the retired Vite `server.host` pin, same rationale: exposing the dev frontend
(source modules, the HMR socket, Next's `/__nextjs_*` dev endpoints) to the LAN would let peers
reach the API *as* 127.0.0.1, bypassing `IP_ALLOWLIST`, and the HMR socket sits on the raw
upgrade path outside Hono's middleware so a configured `IP_ALLOWLIST` alone wouldn't cover it.
Test LAN devices against the production serve path (`npm run build && npm run start`, which
defaults `HOST=0.0.0.0`) instead.

### e2e smoke

```bash
npx playwright install chromium   # one-time
npm run e2e                       # builds web/, boots a hermetic server on :8791
```

The Playwright `webServer` runs with `REQUIRE_LOGIN=0`, loopback bind, a wiped
`e2e/.data/` DATA_DIR, and explicitly blanked OAuth/token env — your real `server/.env`
never leaks into the suite. The wipe happens in the `webServer.command` itself, in the
same shell invocation that starts the server, so it always runs before boot.

### Visual regression harness

```bash
npm run e2e:visual          # 44 screenshots, two viewports (desktop 1280×720, mobile 390×844)
npm run e2e:visual:update   # re-capture baselines after a reviewed, intentional UI change
```

`e2e/visual.spec.ts` is a separate Playwright **project**, excluded from default
`npm run e2e` (gate decision E-1 from the Tailwind migration) — it's a standing opt-in
safety net against pixel drift, not a per-PR gate. Baselines are committed PNGs, chromium
only, masked for time-driven regions (playhead, rolling shimmer) and autoplaying video.
**Re-baseline policy:** the "frozen for the whole campaign" rule was migration-specific
and no longer applies — re-capture the affected shots freely for any legitimate UI
change, with a human-reviewed before/after diff confirming only the intended change
moved. A future Playwright/Chromium version bump will shift anti-aliasing across most
shots and likely needs a full re-capture; that's expected and no longer gated behind an
exact-pin policy (`@playwright/test` is back to a caret range).

## Companion module (`companion/`)

A Bitfocus Companion (Stream Deck) module — an npm workspace that controls the active
AutoLogger session over the existing `/api/companion/*` HTTP endpoints (log events,
roll/stop takes, record/play), with live feedbacks and variables.

```bash
npm run build -w companion      # check base-version pin + tsc -> companion/dist/
npm run test -w companion       # vitest unit tests
npm run package -w companion    # produce a distributable .tgz module package
```

**Loading in Companion 4.3.x:** you must load the **packaged** module, not the raw `tsc`
output — under Companion's per-module Node permission sandbox the plain `companion/dist/`
build cannot read the workspace-hoisted dependencies and fails to start. Run
`npm run package -w companion` to produce `autologger-0.1.0.tgz` (a self-contained,
dependency-free esbuild bundle with a correct `runtime.apiVersion`), then either import it
via Companion's **"Import module package"**, or extract it into a directory you pass to
`--extra-module-path`. Configure the connection with the **Server URL**
(e.g. `http://127.0.0.1:8787`) and, only if the server runs with the `API_TOKEN` env var set
(`REQUIRE_LOGIN=1`), the **API token**.

> `@companion-module/base` is pinned to `~1.14.0` (stable 1.x). Companion 4.3.4 rejects the
> newer 2.1.x line, and its 2.0.x alpha removed the `runEntrypoint` API this module uses. A
> root `package.json` `overrides` keeps `@companion-module/tools` on the same 1.14.x base so
> the packaged manifest's `apiVersion` is correct.

### Connecting Bitfocus Companion to a server

The module is **not published to the Bitfocus registry** (`"private": true`) — searching a
stock Companion install won't find "AutoLogger". You load the packaged build (above) and point
it at any reachable server, local or remote (e.g. a public `https://…` deployment behind a
reverse proxy — the module polls the `/api/companion/*` REST endpoints over `fetch`, no
WebSocket, so HTTPS works with no extra setup).

1. **Package + load the module** — `npm run package -w companion`, then import the
   `.tgz` via Companion's **"Import module package"** (see the loading note above).
2. **Add the connection** — Companion GUI → **Connections → Add connection →** search
   **AutoLogger**, then fill the three config fields (`companion/src/config.ts`):
   - **AutoLogger server URL** — the server's base URL, e.g.
     `https://autologger.example.com` (a trailing slash is stripped automatically).
   - **API token** — see step 3.
   - **Poll interval (ms)** — default `1000` (clamped to 250–10000).
3. **Authenticate (public / `REQUIRE_LOGIN=1` servers)** — the module authenticates by
   sending `Authorization: Bearer <token>`, which the server accepts only when it equals its
   **`API_TOKEN`** env var. So set `API_TOKEN=<a-long-random-secret>` in the server's
   `server/.env`, restart, and paste the **same** secret into the connection's **API token**
   field. Leave it blank only on an open LAN box running `REQUIRE_LOGIN=0` (never a
   public one). If the server is behind a proxy and uses `IP_ALLOWLIST`, set `TRUST_PROXY=1`
   so the client IP is read from the forwarded header.
4. **Open a browser on a session** — the module acts on **whichever session an open browser
   reports as active** (via presence); it does not pick a session itself. Load the server in a
   browser and enter/start a session, then check the session/show name shown on the Companion
   buttons before pressing — with multiple tabs open the active session can change.

**Sanity check** the URL + token before wiring buttons — a `200` with JSON means you're set;
`401` is a token mismatch, and a `409`/empty session means no browser is on a session yet:

```bash
curl -H "Authorization: Bearer <your-API_TOKEN>" \
  https://autologger.example.com/api/companion/state
```

> **`/api/companion/*` responses are content-encoding negotiated** like the rest of `/api/*`
> (see **Endpoints** above). The `curl` as written sends no `Accept-Encoding` and therefore gets
> identity bytes; add `--compressed` to exercise the gzip path. What this costs a proxy operator:
> a caching layer in front of the server must honour `Vary: Accept-Encoding` and must not strip
> it, and must not re-encode a response that already carries `Content-Encoding`.

**Behind an authenticating proxy (Pangolin / SSO / any identity-aware gateway).** A *plain*
reverse proxy (nginx/Caddy just terminating TLS) is transparent to Companion. An
**authenticating** proxy is not: it intercepts every request and `302`-redirects unauthenticated
ones to an SSO login page *before they reach the Node server*, so the `curl` above (or the
module) sees a redirect to the proxy's auth portal, not AutoLogger — and the request's
`Authorization: Bearer` header is never evaluated by AutoLogger at all. A human browser gets
past it by completing SSO once and holding the proxy's session cookie; the headless module
can't do that (it only sends the one static bearer token and can't complete an interactive
login), so it fails with a generic network error. The tell is a `302` whose `location` points
at the proxy's auth host:

```bash
curl -sSi https://autologger.example.com/api/companion/state | grep -i '^location'
# location: https://<proxy-auth-host>/auth/resource/...?redirect=...   ← proxy SSO wall
```

**Fix it at the proxy, not in AutoLogger:** add proxy rules that let **exactly the five paths
the module calls** bypass the proxy's SSO — `/api/companion/state`, `/api/companion/categories`,
`/api/companion/log`, `/api/companion/transport`, `/api/companion/command` — then rely on
AutoLogger's own `API_TOKEN` (+ optionally `IP_ALLOWLIST`) to secure them, which is exactly the
auth model the module is built for. Keep the rest of the app behind SSO. (In Pangolin: the
resource's **Rules** tab → one **Accept** rule per path above.) **Do not use a wildcard such as
`/api/companion/*`**: a proxy that matches the raw path lets a crafted target like
`/api/companion/%2e%2e/sessions/x` past the SSO wall, and the server's URL parser then
normalizes it to `/api/sessions/x`; exact paths cannot be traversed into, and the token is
in any case honoured only under `/api/companion/*`. See **Container deployment** for the router
that also rejects such targets. Making the whole resource public also works for Companion, but drops
SSO from the browser flow too — and `API_TOKEN` no longer authenticates anything outside
`/api/companion/*`, so the rest of the app still needs a real login. Header/resource-token auth on
the proxy generally won't work: the module sends only `Authorization: Bearer <API_TOKEN>` and
can't add a second custom header, so a proxy that also wants `Authorization` collides with
AutoLogger's token.

The headless-Companion Playwright project is binary-gated and excluded from the default
`npm run e2e` run. To run it where a Companion install is present, use
`npm run e2e -- --project=companion --workers=1` (it must not share workers with the
`chromium` project — resource contention makes a shared multi-worker run flaky).
