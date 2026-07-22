# youtube-audio-import — design

## Context

The YouTube-import surface is fully built on the client and dead on the server. The New
Session modal collects a YouTube URL and a "use publish date" checkbox;
`handleSelectSession` (`web/src/pages/index/AppShell.tsx`) calls the `useYoutubeImport`
mutation (`web/src/api/hooks/useSessions.ts`), which POSTs `{ url, use_publish_date }` to
`POST /api/sessions/:sessionId/youtube-import`, awaits a single response, drives a
`ytImportPending` spinner, and on any rejection toasts `err.message` and renders
`YouTubeImportErrorModal` (retry a different link / continue without audio / delete the
session). The server route is an unconditional `503` stub in `server/src/routers/
sessions.ts` ("no import pipeline wired up", phase-6 decision; README "unavailable" row).

Everything downstream of a successful import already exists. Recorded audio lives as files
in the `BlobStore` (`DATA_DIR/blobs/audio/…`) with per-segment metadata in the session DB;
the recorder's own upload path (`server/src/routers/audio.ts`) is the template — a
synchronous `addAudioSegment` hub RPC returns a blob key, then the router `await`s
`ports.audio.put(key, bytes, {contentType})`. `audioStore`'s extension map already handles
`webm`/`ogg`/`wav`/`m4a`, which is exactly what YouTube `bestaudio` yields, so the player,
waveform, and DeepGram transcription all already consume it.

One notable current-state finding: `episode_date` is a **catalog-DB** column on the
`sessions` table (migration `0002_sessions_live_split.sql`, in the catalog migration set)
that is **only ever read** — served from a catalog join in `serializeSessionEntry`
(`sessions.ts:73`) and shown in the home/rail UI — with **no server-side write path**. The
client's "use publish date" checkbox therefore round-trips to a server that ignores it.
This change becomes the first writer of `episode_date`. It is written through the **catalog
layer** (`SessionIndexStore`, which already has single-column mutators
`setSessionArchived`/`setSessionUiHidden`), **not** the per-session hub — the per-session DB
has no such column (panel correction, 2026-07-21).

Constraints that shape everything below: single Node process, local disk, "runs anywhere
Node 22 runs" (no cloud account, no native deps added); SessionHub RPC bodies are
**synchronous** (async work belongs in the router layer); the HTTP contract is **frozen**
except where this change's `api-contract-freeze` delta authorizes it; DeepGram
transcription is the established precedent for an env-gated, off-by-default external
integration that egresses data and is disclosed in README + `.env.example`.

## Goals / Non-Goals

**Goals:**
- Make the shipped client flow real: fetch a YouTube video's audio and attach it as the
  session's audio through the existing ingestion path.
- Honor `use_publish_date` by writing `episode_date` from the video's upload date.
- Keep unconfigured deployments byte-for-byte unchanged (frozen `503`).
- Follow the DeepGram gate pattern: opt-in, disclosed egress, no default external reach.
- Keep the single process safe: bounded subprocess, no unbounded disk/time, no shell
  injection, no arbitrary-host fetch.

**Non-Goals:** setting the session title from the video; playlists/channels; any
async/job/progress protocol; transcoding on spec; bundling or auto-updating `yt-dlp`; a
pure-JS extractor (see proposal Non-Goals).

## Decisions

### D1 — Import pipeline runs in the router layer
The download, metadata read, blob write, segment record, and episode-date write are all
orchestrated in the `youtube-import` route handler. The audio-segment record goes through
the existing synchronous `addAudioSegment` **hub** RPC; the episode-date write goes through
a **catalog** mutator (D4, not a hub RPC); the subprocess spawn and the `ports.audio.put`
blob write are `await`ed in the router.
**Alternatives:** (a) run the download inside a SessionHub method — rejected: violates the
synchronous-RPC invariant (spawning/streaming are async); (b) client-side download +
upload — rejected: the browser can't run `yt-dlp`, and it would duplicate the ingestion
path. *Deliberate invariant a future reader must not "fix": no `await` may move into a hub
method. As with DeepGram, a hub reference must not be held across a long `await` — the
idle-hub sweeper may `close()` the session DB during a multi-minute download, so the
handler re-acquires the hub via `getSessionHub()` after the download completes rather than
capturing it before the await. (The catalog handle, unlike a hub, is process-lifetime, so
the episode-date write has no such re-acquire concern.)*

### D2 — External `yt-dlp` binary, config-gated, spawned with an argument array
Audio is fetched by spawning an operator-provided `yt-dlp` binary. **Gate resolution
(2026-07-21): the gate is satisfied by either an explicit configured path (e.g. `YTDLP_PATH`)
OR a bare `yt-dlp` resolvable on the process `PATH`.** No `yt-dlp` available ⇒ the endpoint
keeps its frozen `503` with no spawn. The binary is invoked with a **discrete argument
array, never a shell-interpolated string**, so the user-supplied URL is a process argument
the shell never sees.

*Detection mechanism (panel correction, 2026-07-21):* unlike `deepgramConfigured(env)`,
which is a pure synchronous read of the injected `Config`, "resolvable on `PATH`" is
filesystem I/O and cannot be a pure `Config` predicate. The binary is therefore **resolved
once at startup** (explicit path if set, else a `PATH` lookup) and the resolved absolute
path (or `null`) is stored on `Config`; `ytDlpConfigured(env)` then stays a pure boolean
read of that resolved value, and the per-request handler uses the resolved absolute path
(not a re-probe). This keeps the gate unit-testable by passing a `Config` and avoids a
per-request filesystem walk whose result could differ from startup.

*Consequence (deliberate, owner-decided):* accepting a bare `PATH` binary means the import
surface **auto-enables from ambient machine state** rather than from an explicit opt-in
flag. So "byte-for-byte unchanged" is scoped to deployments where `yt-dlp` is genuinely
absent. The unauthenticated-reachability edge of this (a `REQUIRE_LOGIN=0` non-loopback
deploy) is closed by the open-network refusal in D9; the README/`.env.example` disclosure
must state that an installed `yt-dlp` is sufficient to turn the feature on.
**Alternatives:** (a) pure-JS extractor (`@distube/ytdl-core` et al.) — rejected: YouTube
breaks these constantly (PoToken/visitor-data churn, IP blocks); it would be the flakiest,
highest-maintenance surface in the app; (b) bundle/auto-download `yt-dlp` — rejected: cuts
against "runs anywhere Node runs, no external integration by default", and puts the app on
the hook for the binary's security/update posture. The env-gated external binary is the
DeepGram pattern applied to a binary instead of an API key: robust, off by default,
operator-owned. *Deliberate invariant: never build the argv by string
concatenation/`shell: true`.*

### D3 — Single-segment ingestion; pinned to a supported container, no transcode
The downloaded container is attached as exactly one audio segment, reusing the recorder
path: `addAudioSegment({ mimeType, … })` (sync hub RPC) → `ports.audio.put(seg.r2_key,
bytes, { contentType })` (router await). The bytes are stored as downloaded (no re-encode).
**Format is pinned, not assumed (panel correction, 2026-07-21):** the earlier draft leaned
on "YouTube bestaudio is always Opus/WebM or AAC/M4A", but `audioStore`'s ext inference is a
substring guess on the caller-supplied mime that **defaults anything unrecognized to
`.webm`**, and transcription's `classifyFamily` only handles opus/aac. So the fetch pins an
explicit format selector to the supported set (e.g.
`-f "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio"`), the stored ext/`Content-Type` is
derived from the **actually produced file** (probe/extension of what `yt-dlp` wrote, not a
guess), and if the produced container is not in the supported set the request **fails
cleanly (`502`)** rather than storing a mislabeled, undecodable blob.
**Alternatives:** (a) transcode/normalize with `mediabunny`/ffmpeg — rejected (YAGNI +
native dep / `--extract-audio` pulls ffmpeg); (b) split into multiple segments — rejected:
one import is one continuous recording. *The pin + probe + reject is the cheap enforcement
of the "already playable" guarantee the earlier draft only asserted.*

### D4 — `use_publish_date` writes `episode_date` through the catalog layer (panel-corrected)
`yt-dlp --dump-json` returns `upload_date` (a `YYYYMMDD` string) alongside the audio fetch.
When `use_publish_date` is true and a usable date is present, the handler writes the
session's `episode_date` via a **new catalog mutator** `SessionIndexStore.setSessionEpisodeDate(sessionId, iso)`,
called from the router as `c.get('catalog').sessions.setSessionEpisodeDate(...)` — the exact
shape of the existing `setSessionArchived`/`setSessionUiHidden` single-column catalog
updates. A single-column `UPDATE` is atomic on its own; there is no per-session hub RPC and
no re-acquire concern. When the flag is false or no date is available, the field is left
untouched — a missing date is a no-op, never a failure.

*Why not a hub RPC (panel correction, 2026-07-21):* the earlier draft proposed a
`setEpisodeDate` hub RPC, and its rejected-alternative text ("no such write path exists")
was factually wrong. `episode_date` lives on the **catalog** `sessions` table, which the
read path (`serializeSessionEntry`) serves from; a per-session hub write would target a DB
with no such column and nothing would propagate it to the catalog row the UI reads.

*Date format — timezone off-by-one (panel correction, 2026-07-21):* the UI's `fmtDateOnly`
does `new Date(iso).toLocaleDateString(...)`, and `new Date("2024-01-15")` parses as **UTC
midnight**, which renders as **the previous day** for every negative-UTC-offset viewer (all
of the Americas). Since `episode_date` is always `null` today, this change would *introduce*
that off-by-one. The stored value is therefore chosen so the UI renders the intended
calendar day — store `YYYY-MM-DD` **and** correct the display so it isn't UTC-shifted
(format the date parts directly without `new Date` zone conversion). The exact web-side
formatter fix, if `fmtDateOnly` must change, is a `web/` follow-up scoped alongside this
change; the server stores the un-shifted `YYYY-MM-DD`.

*Field choice:* `upload_date` (not `release_date`) — it's the field `--dump-json` always
carries and matches the common "when it went up" reading; premieres where `release_date`
differs are an accepted minor imprecision (they are rare, and `release_date` is often
absent). *The session JSON shape is unchanged (the field was already nullable) — only a
value where there was `null`.*

### D5 — Synchronous single-shot request, bounded on four axes (gate-revised)
The frozen client contract is one `POST` returning `{ok}` with no polling surface, so the
import completes within that request. Ingestion is **full-buffer** — `BlobStore.put` accepts
only an `ArrayBuffer`/`Uint8Array` (no streaming path), so the whole downloaded file is held
in RAM before the blob write, in a single Node process. The bounds must therefore protect
**RAM and disk**, not just wall-clock. **Gate resolution (2026-07-21, "all three guards"):**
1. **Byte-size cap** enforced *during* download (`yt-dlp --max-filesize`) so an over-cap
   fetch aborts before it fills disk or is buffered — this is load-bearing for RAM given
   full-buffer ingestion. (This **reverses** the earlier "no byte cap" call, which was made
   before the RAM/no-global-cap/live-bypass chain was on the table.)
2. **Reject live / unknown-duration** at the `--dump-json` metadata step (`is_live`, null
   `duration`) — a duration match-filter alone doesn't reliably reject a live stream, whose
   audio is effectively unbounded.
3. **4-hour video-duration cap** (`yt-dlp` duration match-filter) — rejects an over-long
   *known-duration* video before fetching its full audio.
4. **Wall-clock hang timeout** — kills a stuck subprocess.
A breach on any axis kills/aborts the subprocess and fails the request (`502`). Success is
`200 {ok:true}`. (The *global* concurrency ceiling that bounds aggregate load across
sessions is D8.)
**Alternatives:** (a) async job + status endpoint — rejected: the client is frozen and has
no polling surface to add one to; (b) unbounded synchronous download — rejected: a single
process can't afford an unbounded subprocess/disk/RAM. *Deliberate posture: the bounds are
the safety mechanism the frozen single-shot + full-buffer shape forces; don't "improve" this
into an unbounded await, and don't drop the byte cap on the theory that duration bounds
it — a live stream has no duration.*

### D6 — Exact-hostname URL allowlist + argv hardening + temp isolation (gate-tightened)
Before any spawn, the handler parses `url` with `new URL()` and rejects (`400`) anything
that isn't `http(s)` with `url.hostname` an **exact** member (lowercased) of an enumerated
allowlist: **`youtube.com`, `www.youtube.com`, `m.youtube.com`, `music.youtube.com`,
`youtu.be`, `youtube-nocookie.com`** (panel correction — a substring/`endsWith` match is
bypassable by `youtube.com.evil.com`; and `youtu.be`, the default share link, must be
included or the common paste `400`s). `new URL()` already lowercases the host, strips
userinfo (so `https://youtube.com@evil.com` resolves host `evil.com` and is rejected), and
punycode-normalizes IDN.

**Argv hardening (panel):** a `--` argv terminator precedes the positional URL (so nothing
`yt-dlp`-side can reinterpret it as an option); the value passed is the **normalized
`url.href`** that was validated, not the raw request string; a **fixed output template**
(`-o audio.%(ext)s`) is used so the module locates the single produced file deterministically
and no title drives the filename.

The download target is a per-request temp directory under the blob store's **scratch root**
(`blobStore.scratchRoot()`, *outside* the blob prefix — matching DeepGram), removed in a
`finally` on every exit path. Placing it outside the blob prefix ensures a partial/failed
download can never be picked up as a segment by the `syncAudioFromBlobs` reconciliation
path. A startup sweep of stale import temp dirs covers `finally`-skipping crashes/OOM
(orphan cleanup).
**Alternatives:** (a) trust `yt-dlp` to only accept YouTube — rejected: its extractor set is
broad, so an unvalidated URL is an SSRF/arbitrary-download surface; (b) download straight
into the blob store — rejected: a partial/failed download must never become a segment.
*Residual: `yt-dlp` may follow redirects; the exact-allowlist bounds the entry point, and
the YouTube extractor only talks to YouTube/googlevideo endpoints.*

### D7 — Failure codes + atomic segment write (rollback on `put` failure)
Unconfigured stays `503` (unchanged). A validated request that fails to download/extract,
times out, breaches a bound, or produces an unsupported container returns `502 {detail}`; a
malformed/non-allowlisted URL returns `400 {detail}`. The client treats every non-2xx
identically (toast + retry modal), so these codes are a server-side clarity choice within
the existing `{detail}` envelope.

**Atomicity (panel correction, 2026-07-21):** the recorder path writes the segment metadata
row *before* the blob `put`, and on a `put` failure it **rolls the row back** via
`deleteAudioSegment` (`audio.ts:71-77`). Import must replicate that: if `ports.audio.put`
throws (disk-full is directly reachable), the just-inserted segment row is deleted, so a
failure can never leave an **orphaned metadata row pointing at a missing blob**. "No segment
attached on failure" is thus a *mechanism* (insert→put→rollback-on-throw), not just an
asserted outcome; the integration test asserts the audio-segment listing is byte-for-byte
unchanged after a `put`/disk-full failure.

### D8 — Per-session single-flight AND a global concurrency ceiling (gate-revised)
Two distinct bounds:
- **Per-session single-flight (owner, 2026-07-21):** one import run per session at a time; a
  concurrent same-session request returns `409 {detail}` with no spawn. Keyed by session id
  (an in-process `Set`), released in a `finally` when the run finishes. This bounds the
  dropped-connection re-import case (a client that gives up can't stack a second concurrent
  download for the same session). It does **not** make import idempotent across *sequential*
  retries — a completed import + retry adds a second segment (accepted; the error modal only
  shows on failure). *Implementation-fidelity constraint (panel MINOR): the `Set.add` must
  be the statement directly before the `try{…}finally{release}` — nothing throwable between
  add and try — or a session id can wedge in the `Set` until restart (a permanent per-session
  `409`).*
- **Global concurrency ceiling (gate, 2026-07-21, "all three guards"):** an aggregate cap on
  concurrent import runs across *all* sessions, mirroring the existing `aiChatMaxConcurrent`
  (default 2) precedent; a request that would exceed it returns `409 {detail}` with no spawn.
  Without this, an actor opening N sessions and firing N imports spawns N concurrent
  `yt-dlp` processes + N large RAM buffers → OOM/disk-fill of the single process.
**Alternatives:** (a) no guards — rejected: trivial resource-exhaustion surface; (b) only a
process-wide boolean like DeepGram's `generationInFlight` — rejected: too coarse (blocks
independent sessions entirely); the per-session `Set` + a small global ceiling gives
parallelism *and* an aggregate bound. *Note: this is a deliberate divergence from DeepGram's
single global boolean, not a copy of it — earlier "mirrors DeepGram" wording was wrong.*

### D9 — Child-process lockdown + open-network refusal (panel BLOCKER + gate)
"Arg array, not a shell string" (D2) stops shell injection but **not** `yt-dlp`'s own
ambient code-execution surface. Two additions close it:
- **Config/plugin lockdown:** spawn with `--ignore-config` and plugins disabled (empty
  plugin dirs / `--no-plugins`-equivalent) so **no ambient `~/.config/yt-dlp/config`,
  `/etc/yt-dlp.conf`, cwd config, or plugin can inject flags** (`--exec`,
  `--postprocessor-args`, `--paths`, `--load-info-json`) into the run. Without this, any
  planted/careless config on the host turns a download into arbitrary command execution — and
  the PATH-inclusive gate (D2) makes a machine with `yt-dlp` + a stray config auto-vulnerable.
- **Scrubbed child env:** spawn with a **minimal env** (HOME + the resolved binary dir on
  PATH + an explicit allowlist), **never inherited `process.env`**, modeled on the repo's
  `buildAiChatChildEnv` (`aiChatRunner.ts`). Otherwise the child (and any postprocessor it
  runs) sees `DEEPGRAM_API_KEY`, `GOOGLE_CLIENT_SECRET`, `AI_V2_API_KEY`, `ADMIN_TOKEN` — an
  exfil vector. Also suppress `.netrc` use.

**Open-network refusal (gate, 2026-07-21, "mirror the refusal"):** the endpoint additionally
refuses (`503`) in the exact `REQUIRE_LOGIN` disabled + non-loopback bind + no `IP_ALLOWLIST`
configuration, mirroring `aiChatOpenNetworkRefused`/`aiV2OpenNetworkRefused`
(`env.ts:110-121,162-172`). A download spends bandwidth/disk and hits a third party on the
operator's IP — the same "outbound + costs a resource" class those sibling features refuse
to serve open to the network. This neutralizes the unauthenticated-reachability edge of the
PATH auto-enable (D2). Ordering: the open-network refusal is checked alongside the config
gate, before any validation/spawn.
**Alternatives:** (a) rely on arg-array alone — rejected (panel BLOCKER): ambient config +
inherited env are live RCE/exfil vectors independent of the URL; (b) no open-network refusal
— rejected at the gate: the two sibling outbound features already refuse, and the PATH gate
makes an unauthenticated surface the default-risk case.

## Risks / Trade-offs

- **`yt-dlp` breaks against YouTube changes** → Mitigation: the binary is operator-provided
  and operator-updated (not bundled/pinned by us); off by default, so breakage can never
  affect a deployment that didn't opt in. This is the accepted cost of not shipping a
  fragile in-process extractor.
- **Ambient-`PATH` auto-enable** → With the PATH-inclusive gate (D2), a deployment that
  installs `yt-dlp` silently makes import available. Mitigation: the open-network refusal
  (D9) closes the unauthenticated-reachability edge (503 in `REQUIRE_LOGIN`-off + non-loopback
  + no-allowlist); the config lockdown (D9) neutralizes the "ambient config = RCE" angle; the
  README/`.env.example` disclosure states an installed `yt-dlp` is sufficient to enable it.
  Residual (owner-accepted): a loopback/authed deployment with `yt-dlp` present has import on
  with no separate opt-out flag — acceptable given the refusal + lockdown.
- **DoS via full-buffer ingestion** → `BlobStore.put` is buffer-only, so a downloaded file
  is held whole in RAM. Mitigation (D5 all-three-guards + D8 global ceiling): `--max-filesize`
  byte cap aborts an over-cap fetch before RAM/disk pressure; live/unknown-duration rejected;
  4h duration cap; global concurrency ceiling bounds aggregate runs. Residual: a legitimate
  large import still buffers its (capped) size in RAM — bounded by the byte cap × the global
  ceiling.
- **RCE / secret exfil via the child process** → Mitigation (D9): `--ignore-config`, no
  plugins, scrubbed minimal env (no server secrets), `--` argv terminator. Residual: none
  known beyond trusting the operator-provided binary itself.
- **Long synchronous download drops connection after the segment is written** → Residual: the
  segment persists server-side (same "completed work persists" behavior as DeepGram) and the
  client shows the retry modal — a *sequential* re-import adds a second segment. Per-session
  single-flight (D8) bounds *concurrent* stacking, not this sequential case (accepted).
- **Arbitrary-host / SSRF** → Mitigation: exact-hostname allowlist before spawn (D6) +
  arg-array + config lockdown (D9). Residual: `yt-dlp` may follow redirects; the exact
  allowlist bounds the entry point and the YouTube extractor only talks to YouTube/googlevideo.
- **Unsupported container stored mislabeled** → Mitigation (D3): pinned format selector +
  mime derived from the produced file + `502` if not in the supported set. Residual: none —
  the earlier "stored but might not play" residual is closed by the reject.
- **Publish-date off-by-one** → Mitigation (D4): store an un-shifted `YYYY-MM-DD` and correct
  the display so a UTC-midnight parse can't shift it a day back for Americas viewers.

## Migration Plan

- Purely additive to server behavior and gated: with no `yt-dlp` available (no configured
  path and none on `PATH`), the endpoint is byte-for-byte its current `503`, so shipping is
  safe on any deployment that hasn't installed `yt-dlp`.
- No DB migration: `episode_date` already exists; this only adds a writer. No new npm
  dependency.
- Enabling in a deployment: operator installs `yt-dlp`, sets the config, and accepts the
  disclosed YouTube egress (README + `.env.example`, per the DeepGram-style gate).
- Rollback: remove `yt-dlp` (or unset the configured path if that was the only source) ⇒
  the endpoint reverts to `503`; already-imported segments and episode dates are ordinary
  session data and remain valid.

## Open Questions

_All pre-panel and panel-raised questions are resolved (owner, 2026-07-21):_

- ~~**Config surface**~~ → **D2:** bare `yt-dlp` on `PATH` counts; detection resolved once at
  startup (not a per-request I/O probe); auto-enable edge closed by the D9 open-network refusal.
- ~~**Concurrency bound**~~ → **D8:** per-session single-flight **and** a global concurrency
  ceiling (gate "all three guards").
- ~~**Resource bounds**~~ → **D5:** byte cap (`--max-filesize`) + reject live/unknown-duration
  + 4h duration cap + hang timeout (gate reversed the earlier "no byte cap").
- ~~**`episode_date` format**~~ → **D4:** store un-shifted `YYYY-MM-DD`; correct the display
  so a UTC-midnight `new Date` parse doesn't shift Americas viewers back a day (the earlier
  "timezone irrelevant" claim was wrong).
- ~~**`episode_date` write seam**~~ → **D4:** catalog `SessionIndexStore.setSessionEpisodeDate`,
  not a hub RPC (panel correction — the column is catalog-side).
- ~~**Open-network posture**~~ → **D9:** mirror the AI endpoints' refusal (gate).

No open questions remain.

## Panel & review log

> Per the repo SDLC, `tasks.md` is provisional until the adversarial panel + owner gate
> run on this `proposal.md` + `spec.md` + `design.md`. The entries below are scaffolded and
> filled as those steps happen.

- **Pre-panel fact-check pass** — _2026-07-21, light-tier (Explore/sonnet)._ Ten checkable
  claims verified against live source; **all CONFIRMED, zero corrections needed**: (1) the
  endpoint is an unconditional `503` stub (`sessions.ts:222-226`); (2) client posts
  `{url, use_publish_date}` and reads only `{ok}` (`useSessions.ts:134-136`); (3) **`episode_date`
  has no server write path** — grep of all `server/src` finds only the migration
  (`0002:12`) and one read (`sessions.ts:73`); (4) recorder ingestion template =
  `addAudioSegment` + `ports.audio.put(seg.r2_key, payload, {contentType})`
  (`audio.ts:64-75`); (5) `audioStore` maps webm/ogg/wav/m4a (`audioStore.ts:58-62`); (6)
  `deepgramConfigured` gate (`env.ts:71`) + DeepGram single-flight is **process-wide**
  (`generationInFlight` module-level, `transcribe.ts:71,89-99`) — note: our D8 chooses
  *per-session*, a deliberate divergence, not a copy; (7) deps have `mediabunny`/`undici`,
  none of yt-dlp/ytdl-core/ffmpeg; (8) idle-hub sweeper closes handles
  (`SessionHubRegistry.evictIdle`) — "re-acquire after await" is a design implication, not a
  single-site fact (left unverified as a *practice*); (9) `requireSession` exists
  (`_helpers.ts:41`); (10) the only in-repo caller is the web client. Left unverified
  (judgment-laden, for the panel): all design-quality calls.
- **Adversarial panel** — _2026-07-21, four skeptical reviewers (opus)._ Findings (deduped,
  ranked): **(BLOCKER) `episode_date` wrong DB/seam** — targeted a per-session hub RPC but
  the column is catalog-side; the rejected-alternative text was factually wrong (Requirements
  + Scope, independently). **(BLOCKER) DoS chain** — full-buffer ingestion × no byte cap × no
  global cap × live-stream duration bypass = single-process OOM/disk-fill by an anonymous LAN
  client (Failure; Assumptions corroborated the RAM angle). **(BLOCKER) RCE/exfil** — arg-array
  doesn't stop ambient `yt-dlp` config/plugins/`--exec` or inherited-env secret exposure
  (Failure). **(MAJOR) date off-by-one** — `new Date("YYYY-MM-DD")` is UTC midnight → prior
  day in the Americas; the "timezone irrelevant" claim was wrong (Assumptions). **(MAJOR)
  bestaudio unpinned** → mislabeled/undecodable container (Assumptions + Failure + Scope).
  **(MAJOR) `ytDlpConfigured` can't be a pure `Config` read** — PATH resolution is I/O
  (Assumptions). **(MAJOR) open-network refusal precedent not mirrored** (Failure). **(MAJOR)
  host allowlist unenumerated / substring-bypassable; `youtu.be` would 400** (Requirements +
  Failure). **(MAJOR) orphaned-metadata-row on `put` failure** — recorder rolls back; import
  didn't (Failure). **(MINORs)** single-flight `Set.add`-before-`try`; `upload_date` vs
  `release_date`; `--` argv terminator / normalized href / fixed `-o`; temp dir under
  `scratchRoot` + startup sweep. **Cleared (non-findings):** new capability spec + separate
  `ytdlp.ts` module proportionate; re-acquire-hub-after-await sound; range/seek playback
  sound; **imported audio waveform is NOT broken** (client-side decode); 8-phase TDD + 4h
  duration cap proportionate.
- **Spec-review gate (owner)** — _2026-07-21._
  - **Fixed in place (blockers/majors, no mandate conflict):** episode_date → catalog
    `setSessionEpisodeDate` seam + wrong rejected-alt text corrected (D1/D4); child-process
    lockdown `--ignore-config`/no-plugins/scrubbed-env (D9); date off-by-one — store
    un-shifted, correct display (D4); pin `-f` format + probe mime + `502` on unsupported
    (D3); exact-hostname allowlist incl. `youtu.be` (D6); atomic segment rollback on `put`
    failure (D7); `ytDlpConfigured` detection resolved at startup, "mirrors deepgram" wording
    dropped (D2); argv hardening + temp under `scratchRoot` + startup sweep (D6);
    single-flight `Set.add`-before-`try` fidelity note + "mirrors DeepGram" wording fixed (D8).
  - **Escalated to the gate (owner decisions):** **(1) resource bounds** — owner chose "all
    three guards" → byte cap + reject-live + global concurrency ceiling, **reversing the
    earlier "no byte cap"** (D5/D8). **(2) open-network refusal** — owner chose to **mirror
    the refusal** (D9). **(3) `upload_date` vs `release_date`** — owner default `upload_date`
    (D4). **(4) per-session vs process-wide single-flight** — owner keeps per-session, adds a
    global ceiling (D8).
  - **Accepted as residual (minors):** open session-detail view not refetched post-import
    (`sessionKeys.detail` not invalidated) — a `web/` concern, out of server scope; imported
    audio transcribes "anchorless" (no recording-start anchor) — out of scope (DeepGram is
    separately gated); `release_date` premiere imprecision.
- **Post-gate consistency read** — _2026-07-21, light-tier (Explore/sonnet)._ Read all four
  final artifacts. `design.md`, both `spec.md` files, and `tasks.md` **clean** (status-code
  matrix agrees across all four; D1–D9 sequential and correctly cross-referenced; every
  normative requirement maps to a task; no stale pre-decision phrasing). Two stale spots
  found in `proposal.md` and **fixed**: (1) a Non-Goals bullet still said `mediabunny` stays
  "in reserve" for an unsupported container — corrected to "fails `502`, mediabunny not
  invoked" (matches D3); (2) the Modified-Capabilities matrix omitted the blob-write (`put`)
  failure from the `502` list and conflated the two `503` branches under "(unchanged)" —
  split into "`503` byte-for-byte unchanged (no binary)" vs "`503` new (open-network
  refusal)" and added the `put`-failure `502` trigger. Re-validated `--strict` after the
  fixes.
