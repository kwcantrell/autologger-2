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
instructions persist on the show's categories and round-trip through profile reads;
`GET …/show-categories` gains one additive top-level boolean, `auto_instructions_present`
(its `categories` projection is otherwise unchanged, and Companion's `categories` response
is untouched). These additive shapes — the boolean plus the `auto_instruction` fields on
`profile.shows[].categories[*]` and their `dropdown_options[*]` — are authorized by the
`auto-event-generation` delta.

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

```
server/src/
  main.ts                Node entry: env config → bindings → app → listen
  app.ts                 Hono app wiring: middleware chain + router mounts + static (← web/app.py)
  env.ts                 Typed env accessors                           (← auth_identity.py getters)
  schemas.ts             Zod request schemas                           (← web/schemas.py)
  studio.ts              Studios + palette/category + event enrichment (← studio.py)
  timecode.ts            SMPTE timecode math + UTC helpers             (← models.py)
  clock.ts               Clock port — the single injected time source (leases, TTLs, timecodes)
  types.ts               Shared Hono generics (Ports + Config + Variables)
  node/
    config.ts            Composition root: Ports + Config from process env (DATA_DIR layout, wiring)
    migrate.ts            Startup migrator for the catalog DB (filename-ordered .sql, transactional)
    catalogStore.ts       CatalogDb — better-sqlite3-backed catalog query layer
    kvStore.ts            KV replacement (login sessions, OAuth CSRF, Companion presence) on the catalog DB
    blobStore.ts          Filesystem blob store: atomic put, range get, list, traversal guard
    presence.ts           In-memory Companion presence registry
  session/
    SessionHub.ts          In-process per-session hub: registry, idle eviction, RPC surface
    sessionCore.ts          Shared substrate: SQLite handle, WS fan-out, events_stream_revision, lease
    eventStore.ts / transportStore.ts / audioStore.ts / leaseStore.ts / transcriptStore.ts / topicStore.ts
                            Domain stores built on SessionCore                (← storage/db.py)
  db/
    catalog.ts             Catalog query layer + profile + sessions index + admin (← storage/db.py, deps.py)
    authStore.ts / profileAssembler.ts / sessionIndexStore.ts / showsStore.ts / studioRegistry.ts
    migrations/0001_init.sql                  Catalog DDL + seeded built-in shows
    migrations/0002_sessions_live_split.sql   Sessions index metadata + live projection
  auth/
    oauth_google.ts        IdentityVerifier port: authorize URL, code exchange, ID-token verify (← oauth_google.py)
    identity.ts             Login sessions + CSRF, bearer compare, gate rule (← auth_identity.py)
  middleware/
    auth.ts                 Per-request context + REQUIRE_LOGIN gate      (← app.py auth_identity_and_gate)
    ipAllowlist.ts           CIDR allowlist on client IP                   (← app.py ip_allowlist_middleware)
  routers/
    _helpers.ts              ApiError, session access gate, hub lookup, marked-at parsing
    auth.ts                  /auth/google/start|callback, /auth/logout
    profile.ts               GET /api/studio, GET|PUT /api/profile
    shows.ts                 GET|POST /api/shows
    sessions.ts              list/create/update/archive/restore/delete; local-audio-import; youtube-import (config-gated)
    events.ts                events CRUD, transport, status, lease, WebSocket upgrade
    audio.ts                 upload/list/range-download, waveform, sync-from-disk
    companion.ts             Companion presence + state + log/transport/command (WS relay)
    transcribe.ts             transcript-words + topics CRUD; generate/csv (503)
    exports.ts                export.csv / export.jsonl (← export.py)
    admin.ts                  ADMIN_TOKEN-gated users + studio-definitions admin
```

## Endpoints

This surface is **frozen** (capability spec `api-contract-freeze`): the route column below
is the normative inventory, and every route's observable behavior — JSON response shapes,
status codes, export bodies (CSV/JSONL), header/range semantics, and the WebSocket messages
listed after the table (their shapes *and* when they fire) — changes only with an
authorizing OpenSpec delta spec. The origin column records which Python module each route
was ported from: historical provenance, not a live parity claim.

| Route | Origin (historical) |
|-------|---------------------|
| `GET /auth/google/start` · `/callback` · `GET\|POST /auth/logout` | `routers/auth.py` |
| `GET /api/studio` · `GET\|PUT /api/profile` · `GET\|POST /api/shows` | `routers/profile.py`, `shows.py` |
| `GET\|POST /api/sessions` · `GET\|PUT\|DELETE /api/sessions/{id}` · `…/archive\|restore` | `routers/sessions.py` |
| `GET\|POST /api/sessions/{id}/events` (GET adds `has_auto_generated`, whole-session) · `PUT\|DELETE …/events/{eid}` | `routers/events.py` |
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
| `GET /sessions/:id` (SPA shell) | (app.ts page route) |
| `GET /teams` (SPA shell) | (app.ts page route) |

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
| `API_TOKEN` | *(empty)* | Device/machine bearer token. A request with `Authorization: Bearer <API_TOKEN>` passes the login gate — this is what the Companion module and other headless clients use. |
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
`API_TOKEN` for headless clients — optionally an `IP_ALLOWLIST` to further restrict access.

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
npm run dev                        # server (tsx watch, :8787) + Vite (:5173), concurrently
npm test                           # server vitest (unit + integration projects)
```

### Verify the contract

```bash
B=http://127.0.0.1:8787

# Login gate (REQUIRE_LOGIN defaults to 1 — see server/.env.example):
curl -o /dev/null -w '%{http_code}\n' $B/api/sessions                    # 401
curl -o /dev/null -w '%{http_code}\n' $B/api/profile                     # 200 (always anonymous-safe)
curl -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer <API_TOKEN>' $B/api/sessions   # 200

# Anonymous parity (set REQUIRE_LOGIN=0 in server/.env): profile + shows both answer.
curl $B/api/profile
curl $B/api/shows

# OAuth round-trip needs real Google creds (GOOGLE_CLIENT_ID/SECRET in server/.env) and
# PUBLIC_BASE_URL registered as an authorized callback URI.
```

## Frontend (web/ workspace)

The React frontend lives in `web/` (Vite 8 + React 19, Tailwind v4) and is canonical for
this app. `npm run build` emits `web/dist/`; the server serves it directly — `GET /`,
`GET /sessions/:id`, and `GET /admin/users` return the built page HTML verbatim (no serve-time rewriting; the API
root is hardcoded same-origin `/api`), and a static catch-all serves hashed `/assets/*`
plus `/static/*` (favicon logos ship from `web/public/static/`).

### Styling (Tailwind v4)

All styling lives in one entry, `web/src/shared/theme/tailwind.css`, side-effect imported
from each page's `main.tsx`. No CSS Modules, no per-component `*.css` files. Layers,
declared in order:

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

Fonts (Inter/Oswald/Roboto/Poppins/League Gothic/Chivo Mono) and `animate.css` are
vendored locally under `web/src/assets/` — no CDN requests at runtime, and the visual
harness (below) is network-independent as a result.

### Dev flow

```bash
npm run dev        # concurrently: server (tsx watch, :8787) + Vite (:5173)
```

Browse `http://127.0.0.1:5173/`. Deep links (`/sessions/<id>`) also work in dev — a small
Vite dev-only middleware (`web/vite.config.ts`) serves the transformed index shell for `/`
and `/sessions/<id>`, mirroring the production serve block. The raw entry path
(`http://127.0.0.1:5173/src/pages/index/index.html`) still works too. Vite proxies `/api`
(incl. the session WebSocket) and `/auth` to :8787. The admin page keeps its own dev URL:
`http://127.0.0.1:5173/src/pages/admin-users/index.html`.

**Dev auth is anonymous by design**: set `REQUIRE_LOGIN=0` and `HOST=127.0.0.1` in
`server/.env`. Google OAuth cannot round-trip through the Vite proxy (the callback
redirects to `PUBLIC_BASE_URL` on :8787 and the cookie lands on that origin) — verify
OAuth against the production serve path instead:

```bash
npm run build && npm run start   # everything on :8787
```

If dev auth is misconfigured (login required but no session), the first symptom is an
opaque WebSocket drop — the 401 fires before the upgrade, so the browser sees a bare
close with no status.

**Keep Vite on loopback.** `server.host` is pinned to `127.0.0.1` in `web/vite.config.ts`;
exposing Vite to the LAN would let peers reach the API *as* 127.0.0.1, bypassing
`IP_ALLOWLIST`. Test LAN devices against :8787.

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

**Fix it at the proxy, not in AutoLogger:** add a rule that lets the `/api/companion/*` paths
**bypass the proxy's SSO**, then rely on AutoLogger's own `API_TOKEN` (+ optionally
`IP_ALLOWLIST`) to secure them — that is exactly the auth model the module is built for. Keep
the rest of the app behind SSO. (In Pangolin: the resource's **Rules** tab → match path
`/api/companion/*` → **Accept**.) Making the whole resource public and leaning entirely on
`API_TOKEN` also works but drops SSO from the browser flow too. Header/resource-token auth on
the proxy generally won't work: the module sends only `Authorization: Bearer <API_TOKEN>` and
can't add a second custom header, so a proxy that also wants `Authorization` collides with
AutoLogger's token.

The headless-Companion Playwright project is binary-gated and excluded from the default
`npm run e2e` run. To run it where a Companion install is present, use
`npm run e2e -- --project=companion --workers=1` (it must not share workers with the
`chromium` project — resource contention makes a shared multi-worker run flaky).
