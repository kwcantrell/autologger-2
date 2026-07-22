# youtube-audio-import — tasks

> Plan of record — folded to the panel + owner gate (2026-07-21). Locate all `file`
> references by content — anchors drift. Every reshape commit is gated by `npm run typecheck`
> + `npm test`; keep pure renames separate from semantic reshapes. Phases touching the frozen
> contract surface (2, 5, 6) and the child-process/security seam (3) get a per-phase review
> at apply time.

## 1. Characterize the seam before reshaping it

- [x] 1.1 Add a characterization integration test pinning the **current** `youtube-import`
  behavior: `POST /api/sessions/:id/youtube-import` on an existing session returns
  `503 {detail}` with the current detail string, and the `requireSession` guard behavior for
  an unknown/inaccessible session is unchanged. (`routers/sessions.int.test.ts`; the route
  has no covering tests today.)

## 2. Configuration gate + open-network refusal

- [ ] 2.1 Add `yt-dlp` binary resolution to `server/src/env.ts`: resolve **once at startup**
  (explicit path var if set, else a `PATH` lookup) into an absolute path stored on `Config`;
  `ytDlpConfigured(env)` is a pure boolean read of that resolved value (D2 — not a
  per-request probe). Unit-test: explicit path set → configured; none set but `yt-dlp` on
  `PATH` → configured; neither → not configured.
- [ ] 2.2 Add a `youtubeImportOpenNetworkRefused(env)` predicate mirroring
  `aiChatOpenNetworkRefused`/`aiV2OpenNetworkRefused` (`REQUIRE_LOGIN` off + non-loopback +
  no `IP_ALLOWLIST`). Unit-test it against the same truth table those use.
- [ ] 2.3 Document the new var in `server/.env.example` (blank by default; a comment noting
  that an installed/`PATH`-resolvable `yt-dlp` is sufficient to enable import, that it makes
  outbound YouTube requests + downloads third-party audio to disk, and that import is refused
  in the open-network config).

## 3. yt-dlp download module (spawn hardening + bounds)

- [ ] 3.1 Add `server/src/node/ytdlp.ts` (new): given a validated normalized URL and a
  per-request temp dir, spawn the resolved binary with a **discrete argument array** and a
  `--` terminator before the URL, a **fixed output template** (`-o audio.%(ext)s`),
  `--dump-json` for `upload_date`/`duration`/`is_live`, a **pinned audio format selector**
  to the supported containers (e.g. `bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio`), and
  the four bounds (D5): `--max-filesize` byte cap; reject `is_live`/null-duration; reject
  duration > 4h (`--match-filter`); wall-clock hang timeout. **Security lockdown (D9):**
  spawn with `--ignore-config` + plugins disabled and a **minimal scrubbed env** (no
  inherited `process.env`; HOME + resolved-binary-dir PATH + explicit allowlist), modeled on
  `buildAiChatChildEnv`. Return `{ audioPath, contentType, uploadDate | null }` with
  ext/`contentType` derived from the **produced file** (throw a typed error, not `.webm`
  default, if the produced container isn't supported). Temp cleanup is the caller's
  `finally`; module writes only under the passed temp dir.
- [ ] 3.2 Unit-test 3.1 against a **fake `yt-dlp` script** (stub on a temp path): argv is an
  array with `--` before a shell-metacharacter/leading-`-` URL (no shell/option
  interpretation); child env excludes a planted secret var and `--ignore-config` is passed;
  success yields the produced file + parsed `upload_date`; non-zero exit / no-output → typed
  error; a hanging stub is killed by the hang timeout; stubs reporting over-4h duration,
  `is_live`, over-`--max-filesize`, or an unsupported produced container each map to the
  typed error without a stored blob.

## 4. Episode-date write (catalog) + correct display

- [ ] 4.1 Add `SessionIndexStore.setSessionEpisodeDate(sessionId, iso)` (catalog layer,
  `server/src/db/sessionIndexStore.ts`), a sibling of `setSessionArchived`/`setSessionUiHidden`
  (single-column `UPDATE`), plus a `YYYYMMDD → YYYY-MM-DD` helper. **Not** a hub RPC (D4 —
  `episode_date` is catalog-side). Unit-test: setting a date is reflected in the catalog read
  path (`serializeSessionEntry`); the normalization is correct; a null/blank date is a no-op.
- [x] 4.2 Fix the publish-date **off-by-one display** (D4): `fmtDateOnly` (duplicated in
  `web/src/pages/index/components/HomeRoute.tsx` and `RecentSessionsList.tsx`) must render a
  bare `YYYY-MM-DD` on its literal calendar day (no `new Date()` UTC-midnight zone shift),
  while still handling the full-timestamp `created_at_utc` fallback. Add a web unit test
  asserting `2024-01-15` renders as Jan 15 under a negative-UTC-offset zone.

## 5. Route handler — replace the 503 stub

- [ ] 5.1 Add the `{ url, use_publish_date }` Zod body schema (`server/src/schemas.ts`) and
  an **exact-hostname** YouTube allowlist validator (`new URL()`, `http(s)`, lowercased
  `hostname` ∈ {`youtube.com`, `www.youtube.com`, `m.youtube.com`, `music.youtube.com`,
  `youtu.be`, `youtube-nocookie.com`}). Unit-test: accepts each allowlisted host incl.
  `youtu.be`; rejects `youtube.com.evil.com`, `evil-youtube.com`, userinfo
  `https://youtube.com@evil.com`, and non-`http(s)`/unparseable.
- [x] 5.2 Add the two concurrency guards (D8): a **per-session single-flight** `Set` (409 on
  a same-session in-flight run) and a **global concurrency ceiling** (409 when the aggregate
  in-flight count is at the cap). Acquire both as the statements directly before the
  `try{…}finally{release both}` (fidelity note — nothing throwable between add and try).
- [x] 5.3 Replace the `503` stub in `server/src/routers/sessions.ts` with the gated handler,
  ordered: `requireSession` → open-network refusal (`503`) + `ytDlpConfigured` gate (`503`)
  → body/allowlist validation (`400`) → per-session + global concurrency acquire (`409`) →
  download into a per-request temp dir under `blobStore.scratchRoot()` (`finally` cleanup) →
  `addAudioSegment` (sync hub RPC; re-acquire the hub after the download await) →
  `await ports.audio.put(seg.r2_key, bytes, {contentType})`, **and on `put` failure delete
  the segment row** (D7 atomic rollback, mirroring `audio.ts`) → if `use_publish_date` &&
  date present, catalog `setSessionEpisodeDate` → `200 {ok:true}`; any post-validation
  failure (download/extract, bound breach, unsupported container, `put` failure) →
  `502 {detail}`; both guards released on every exit path.
- [x] 5.4 Add a startup sweep of stale import temp dirs under `scratchRoot()` (D6 — covers
  `finally`-skipping crashes).

## 6. Contract + capability integration tests (frozen-surface phase)

- [ ] 6.1 Integration tests over the endpoint status matrix using the fake-binary harness:
  no `yt-dlp` → `503` byte-for-byte with the pre-change response; open-network config →
  `503`, no spawn; bare `yt-dlp` on `PATH` → treated as configured; non-allowlisted URL
  (incl. `youtube.com.evil.com`) → `400`, no spawn; `youtu.be` → accepted; concurrent
  same-session → `409`; global ceiling reached → `409`; success → `200 {ok:true}` with
  exactly one new audio segment retrievable/seekable via the blob route and (with
  `use_publish_date:true`) `episode_date` populated + rendered on the correct day;
  download-fail / unsupported-container / over-cap / live-stream → `502` with audio
  unchanged; `topics/generate` + `transcribe.csv` still `503`.
- [ ] 6.2 Assert the ingested segment is byte-identical to the produced file, and that a
  **blob-write (disk-full) failure leaves the audio-segment listing byte-for-byte
  unchanged** (no orphan metadata row) — the atomic-rollback assertion, not merely "no
  playable segment".

## 7. Docs

- [ ] 7.1 Update `README.md`: move `youtube-import` out of the unconditional-`503` rows into
  a configuration-gated row (like the DeepGram transcript-generation row), and add the
  egress/dependency disclosure (operator-provided `yt-dlp`, PATH auto-enable, outbound
  YouTube fetch + on-disk download, open-network refusal). Keep `topics/generate` +
  `transcribe.csv` in the `503` rows.

## 8. Final gates

- [ ] 8.1 `npm run typecheck` + `npm test` green.
- [ ] 8.2 `npm run e2e` (chromium + login-gate projects). This branch **does** carry a small
  web change (task 4.2, `fmtDateOnly` display). Run `npm run e2e:visual`; if the date-display
  fix alters any baseline, re-bless the affected baselines **in this branch's diff** (a
  legitimate UI correction), and note which — do not re-bless unrelated drift.
