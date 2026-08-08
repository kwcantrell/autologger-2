// youtube-audio-import (design D2/D3/D5/D9, task 3.1) — the yt-dlp spawn +
// lockdown + bounds module. Pure infrastructure: no HTTP, no hub/catalog
// access. Given an already-validated, already-normalized URL (`url.href`,
// checked against the exact-hostname allowlist by the caller — this module
// does NOT re-validate it) and a per-request temp directory the CALLER owns
// the lifecycle of (created before, removed in a `finally` after — this
// module writes only INTO that directory, never creates or removes it),
// spawns the operator-provided `yt-dlp` binary (the resolved absolute path
// from `Config.YTDLP_RESOLVED_PATH` — this module never re-resolves it) and
// returns `{ audioPath, contentType, uploadDate }` for the router (Phase 5)
// to ingest through the existing `addAudioSegment` → `ports.audio.put` path.
//
// Two-spawn shape (design D5 axis 2 — "a duration match-filter alone
// doesn't reliably reject a live stream, whose audio is effectively
// unbounded"): a metadata-only PROBE (`--skip-download --dump-json`) runs
// FIRST and is rejected before any bytes are fetched if the video is live or
// has no known duration or exceeds the 4-hour cap; only then does the actual
// DOWNLOAD spawn run, pinned to a supported-container format selector with a
// fixed output template, a `--max-filesize` byte cap, and (belt-and-suspenders
// alongside the JS-side probe check) a `--match-filter` duration bound. Both
// spawns share the same argv/env lockdown (D9) and the same wall-clock hang
// timeout (D5 axis 4).
//
// Security lockdown (design D9, modeled on `buildAiChatChildEnv` in
// `server/src/ai-runtime/aiChatRunner.ts`): `shell: false` with a discrete argv
// array and a `--` terminator before the positional URL (never shell- or
// option-interpreted); `--ignore-config` + `--no-plugin-dirs` so no ambient
// `yt-dlp` config file or plugin can inject flags (`--exec`,
// `--postprocessor-args`, …); `.netrc` is off by default and `--ignore-config`
// blocks any config from enabling it, so no `.netrc` credential is read either;
// a minimal, SCRUBBED child env — never inherited `process.env` — that
// carries only HOME (if the parent has one) + PATH pinned to the resolved
// binary's OWN directory (never the parent's real `PATH`, and never
// containing anything else — deliberately even MORE restrictive than
// `buildAiChatChildEnv`, since yt-dlp's ambient-config/plugin surface is the
// larger direct RCE risk here) + the same small proxy/TLS allowlist
// `buildAiChatChildEnv` forwards, added only when the parent actually has it.

import { type ChildProcess, spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** A typed failure from any stage of the fetch (probe spawn error/timeout,
 * a rejected bound, a failed download, or an unsupported produced
 * container). `message` is always a plain, non-sensitive summary — safe to
 * surface to the client as the `502 {detail}` body (spec "Failure codes").
 * A single class (not one subtype per bound) — every caller-visible
 * consequence is identical ("the request fails, no segment is attached"),
 * so callers branch on nothing but `instanceof YtDlpError`. */
export class YtDlpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YtDlpError';
  }
}

/** Design D5 axis 3: reject a *known*-duration video before fetching its
 * full audio if it is longer than this. */
export const MAX_DURATION_SECONDS = 4 * 60 * 60;

/** Design D5 axis 1: byte-size cap enforced *during* download via yt-dlp's
 * own `--max-filesize`, so an over-cap fetch aborts before it is buffered or
 * fills disk (load-bearing for RAM given `BlobStore.put`'s full-buffer
 * ingestion — design D5). Chosen to match DeepGram's own upload ceiling
 * downstream (`DEEPGRAM_MAX_GROUP_BYTES` in `routers/transcribe.ts`) — a
 * file this module would accept but transcription could never consume is a
 * pointless egress either way. `--max-filesize` alone is defense in depth,
 * not the authoritative check: yt-dlp cannot enforce it before download for
 * some streams (size-unknown DASH/chunked), so `fetchYoutubeAudio` also
 * `stat()`s the produced file after download and rejects it here — the
 * JS-side check is what's actually load-bearing, mirroring the
 * belt-and-suspenders shape the duration axis already has. */
export const DEFAULT_MAX_FILESIZE_BYTES = 2_000_000_000;

/** Design D5 axis 4: wall-clock hang timeout applied to EACH spawn (probe
 * and download independently) — either can hang against a stalled network
 * peer or a misbehaving binary. 15 minutes comfortably covers a legitimate
 * near-cap (2GB) download over a slow link while still bounding a genuinely
 * stuck process. Overridable per call for tests. */
export const DEFAULT_HANG_TIMEOUT_MS = 15 * 60 * 1000;

/** Design D3: the pinned audio format selector — supported containers only,
 * preferring m4a then webm, falling back to whatever `bestaudio` resolves
 * to (still probed/rejected below if its produced container isn't
 * supported). Never a bare `bestaudio` alone (that could resolve to an
 * arbitrary, unlabeled container). */
export const AUDIO_FORMAT_SELECTOR = 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio';

/** Design D6: a fixed output template — no title/metadata drives the
 * filename, and it makes the single produced file deterministically
 * locatable (`audio.<ext>` in the per-request temp dir) regardless of what
 * format was actually resolved. */
export const OUTPUT_TEMPLATE = 'audio.%(ext)s';

const PRODUCED_FILE_PREFIX = 'audio.';

/** Design D3: the supported-container set, matching `AudioStore`'s own
 * extension→mime mapping (`server/src/session/audioStore.ts`) so a
 * downstream player/waveform/transcription consumer that already handles
 * the recorder's own containers can consume an imported one identically. A
 * produced extension outside this map throws `YtDlpError` — NEVER a
 * `.webm`-default guess (design D3's explicit correction). */
const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
};

/** Env vars whitelisted onto the child beyond HOME + the resolved-binary-dir
 * PATH (design D9), mirrored verbatim from `buildAiChatChildEnv`'s
 * `OPTIONAL_ENV_PASSTHROUGH` — only forwarded when actually present in the
 * parent's env, never fabricated. Duplicated here (not imported) rather than
 * reused across the node/ai-runtime layering split (`server/src/node/` is
 * lower-level, Node-platform infrastructure; `server/src/ai-runtime/` is the
 * sibling layer housing CLI/SDK turn orchestration, not infrastructure
 * `node/` depends on — importing one constant across that boundary would
 * create a cross-layer dependency for no reason the duplication doesn't
 * already serve just as well). */
const OPTIONAL_ENV_PASSTHROUGH = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
] as const;

/** Build the minimal, scrubbed child environment (design D9): HOME when the
 * parent has one (never fabricated), PATH pinned to the resolved binary's
 * OWN directory (never the parent's real `PATH` — unlike
 * `buildAiChatChildEnv`, which does forward the parent's PATH; yt-dlp's
 * config/plugin surface is the bigger risk here, so its child gets the
 * tighter bound), plus the same small optional proxy/TLS allowlist. Never
 * inherits `process.env` wholesale. */
export function buildYtDlpChildEnv(
  procEnv: NodeJS.ProcessEnv,
  binaryPath: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (procEnv.HOME) env.HOME = procEnv.HOME;
  env.PATH = dirname(binaryPath);
  for (const key of OPTIONAL_ENV_PASSTHROUGH) {
    const value = procEnv[key];
    if (value) env[key] = value;
  }
  return env;
}

interface YtDlpMetadata {
  is_live?: boolean;
  duration?: number | null;
  upload_date?: string | null;
}

/** yt-dlp's `--dump-json` prints one JSON object; tolerate any incidental
 * non-JSON lines (warnings that slipped past `--no-warnings`, etc.) by
 * scanning from the LAST line backward for the first one that parses. */
function parseMetadataJson(stdout: string): YtDlpMetadata | null {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') return parsed as YtDlpMetadata;
    } catch {
      // Not a JSON line — keep scanning backward.
    }
  }
  return null;
}

interface RunResult {
  exitCode: number | null;
  stdout: string;
  timedOut: boolean;
}

/** Kill `child`'s entire process group (not just the one pid) — a hang-timeout
 * proof the same signal reaches a descendant (e.g. an ffmpeg postprocessor
 * yt-dlp spawned) that would otherwise orphan and keep running/writing past
 * the wall-clock bound. Requires `child` to have been spawned with
 * `detached: true` (its pid IS the process-group id, mirroring
 * `killAiChatProcessGroup` in `ai-runtime/aiChatRunner.ts`). Never throws:
 * `process.kill` on an already-gone group raises ESRCH — a race with the
 * child exiting on its own between the timer firing and this call — which is
 * swallowed since "already gone" is exactly the no-orphan outcome wanted. */
function killProcessGroup(child: ChildProcess): void {
  if (child.pid == null) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // ESRCH: the group already exited — nothing left to kill.
  }
}

/** Spawn one yt-dlp invocation with `shell: false` against the scrubbed env,
 * bounded by `timeoutMs` wall-clock (design D5 axis 4) — on expiry the
 * WHOLE PROCESS GROUP is SIGKILLed (a hung process, by definition, isn't
 * going to respond to a gentler signal), not just the direct pid, so a
 * descendant yt-dlp spawned (e.g. an ffmpeg postprocessor) can never outlive
 * the bound — and `timedOut: true` is reported. Spawned with `detached:
 * true` so the child is its own process-group leader; on POSIX this makes
 * `child.pid` double as the group id `killProcessGroup` signals (matching
 * `spawnAiChatTurn`'s posture in `ai-runtime/aiChatRunner.ts`) — no group is
 * left behind on the normal (non-timeout) exit path, since nothing here ever
 * calls `unref()` and the group's last member exiting on its own reaps it.
 * Never throws: spawn failure surfaces as `exitCode: null` via the child's
 * own `error` event, uniformly with a non-zero exit for the caller's
 * purposes. */
function runYtDlpProcess(
  binaryPath: string,
  argv: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number },
): Promise<RunResult> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawn(binaryPath, argv, {
        shell: false,
        cwd: opts.cwd,
        env: opts.env,
        detached: true,
      });
    } catch {
      resolve({ exitCode: null, stdout: '', timedOut: false });
      return;
    }

    let stdout = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child);
    }, opts.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    // Drain stderr so a chatty child can never stall on a full pipe buffer;
    // its content is never surfaced to the caller (no upstream-body-echo
    // posture, matching `DeepgramUpstreamError`'s discipline).
    child.stderr?.on('data', () => {});

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, timedOut });
    };
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
  });
}

function contentTypeForExt(ext: string): string | undefined {
  return CONTENT_TYPE_BY_EXT[ext.toLowerCase()];
}

/** Locate the single file the fixed `-o audio.%(ext)s` template produced in
 * `tempDir` — deterministic by construction (design D6), so this is a
 * directory listing + prefix match, not a guess. Returns `null` if the
 * download step produced no such file (e.g. a match-filter/max-filesize
 * abort that still exited 0). */
async function locateProducedFile(tempDir: string): Promise<{ path: string; ext: string } | null> {
  let entries: string[];
  try {
    entries = await readdir(tempDir);
  } catch {
    return null;
  }
  const hit = entries.find((name) => name.startsWith(PRODUCED_FILE_PREFIX));
  if (!hit) return null;
  return { path: join(tempDir, hit), ext: hit.slice(PRODUCED_FILE_PREFIX.length) };
}

/** Lockdown flags shared by BOTH spawns (design D9): no ambient config file,
 * no plugin directories, and quiet (no warning noise to parse around). These
 * are the REAL yt-dlp option spellings (verified against the binary): plugins
 * are cleared with `--no-plugin-dirs` (there is no `--no-plugins`), and
 * `.netrc` needs no flag — it is OFF by default and `--ignore-config` prevents
 * any config from turning it on with `--netrc`, so an explicit disable flag
 * (which yt-dlp does not have) is neither needed nor valid. */
const LOCKDOWN_ARGV = ['--ignore-config', '--no-plugin-dirs', '--no-warnings'];

/** The flag portion of each spawn's argv (everything before the `--` URL
 * terminator), factored out so the real-binary flag-validity smoke test
 * (`ytdlp.realbinary.test.ts`) validates the EXACT flags this module spawns —
 * no re-typed copy that could share a typo. These are yt-dlp's real option
 * spellings; the fake-binary unit tests accept any flag, so a nonexistent one
 * (historically `--no-plugins`/`--no-netrc`) only surfaces against a real
 * binary. */
export const PROBE_FLAGS: readonly string[] = [...LOCKDOWN_ARGV, '--skip-download', '--dump-json'];

export function downloadFlags(maxFilesizeBytes: number): string[] {
  return [
    ...LOCKDOWN_ARGV,
    '-f',
    AUDIO_FORMAT_SELECTOR,
    '-o',
    OUTPUT_TEMPLATE,
    '--max-filesize',
    String(maxFilesizeBytes),
    '--match-filters',
    `duration < ${MAX_DURATION_SECONDS}`,
    '--no-simulate',
  ];
}

export interface YtDlpFetchOptions {
  /** The already-validated, already-normalized URL (`url.href`) — this
   * module does not re-validate the host allowlist (the caller does, before
   * calling this). Passed as a discrete argv element after a `--`
   * terminator, never shell-interpolated. */
  url: string;
  /** Per-request temp directory the CALLER created and will remove in its
   * own `finally` — this module writes only into it (via `-o`'s relative
   * output template + spawn `cwd`), never creates or removes it itself. */
  tempDir: string;
  /** The startup-resolved absolute binary path (`Config.YTDLP_RESOLVED_PATH`)
   * — never re-resolved here. */
  binaryPath: string;
  /** Override for tests; defaults to the real `process.env`. Only HOME +
   * the optional proxy/TLS allowlist are ever read from it — see
   * `buildYtDlpChildEnv`. */
  procEnv?: NodeJS.ProcessEnv;
  /** Override for tests; defaults to `DEFAULT_MAX_FILESIZE_BYTES`. */
  maxFilesizeBytes?: number;
  /** Override for tests; defaults to `DEFAULT_HANG_TIMEOUT_MS`. Applied
   * independently to the probe spawn and the download spawn. */
  hangTimeoutMs?: number;
}

export interface YtDlpFetchResult {
  /** Absolute path to the single produced file, inside `tempDir`. */
  audioPath: string;
  /** Derived from the PRODUCED file's extension (never assumed/defaulted —
   * design D3). */
  contentType: string;
  /** Raw `YYYYMMDD` string from `--dump-json`'s `upload_date`, or `null`
   * when absent — normalization to `YYYY-MM-DD` is the caller's job
   * (design D4, task 4.1's helper), not this module's. */
  uploadDate: string | null;
  /** The video's duration in seconds, as read from the probe's
   * `--dump-json` output (task 9.2, design D10 — the timeline-anchor
   * transport advance consumes this). Always a **finite, positive**
   * number: the probe already rejects null/non-finite/over-4h durations
   * above, and a non-positive duration (`<= 0`) is rejected the same way
   * (a zero-length take must never be produced) — so by the time this is
   * returned, `duration > 0` is guaranteed. */
  duration: number;
}

/**
 * Fetch one YouTube video's audio (design D2/D3/D5/D9). Runs a metadata-only
 * probe first (rejecting live/unknown-duration/over-4h videos before any
 * download), then a pinned-format download bounded by a byte-size cap and a
 * duration match-filter, then locates and validates the produced file's
 * container. Throws `YtDlpError` (never returns a partial/invalid result) on
 * any bound breach, spawn failure, non-zero exit, missing/unsupported
 * produced file, or hang-timeout kill.
 */
export async function fetchYoutubeAudio(opts: YtDlpFetchOptions): Promise<YtDlpFetchResult> {
  const procEnv = opts.procEnv ?? process.env;
  const env = buildYtDlpChildEnv(procEnv, opts.binaryPath);
  const hangTimeoutMs = opts.hangTimeoutMs ?? DEFAULT_HANG_TIMEOUT_MS;
  const maxFilesizeBytes = opts.maxFilesizeBytes ?? DEFAULT_MAX_FILESIZE_BYTES;
  const runOpts = { cwd: opts.tempDir, env, timeoutMs: hangTimeoutMs };

  // ── Step 1: metadata-only probe — no bytes fetched yet (design D5 axis 2:
  // a live stream must be rejected here, BEFORE any download attempt, since
  // its audio is otherwise effectively unbounded). ──
  const probeArgv = [...PROBE_FLAGS, '--', opts.url];
  const probe = await runYtDlpProcess(opts.binaryPath, probeArgv, runOpts);
  if (probe.timedOut) {
    throw new YtDlpError('Reading video metadata timed out.');
  }
  const meta = probe.exitCode === 0 ? parseMetadataJson(probe.stdout) : null;
  if (!meta) {
    throw new YtDlpError('Failed to read video metadata.');
  }
  if (meta.is_live) {
    throw new YtDlpError('This video is a live stream, which is not supported.');
  }
  const duration = meta.duration;
  if (duration === null || duration === undefined || !Number.isFinite(duration)) {
    throw new YtDlpError('This video has no known duration, which is not supported.');
  }
  if (duration > MAX_DURATION_SECONDS) {
    throw new YtDlpError(
      `This video is longer than the ${MAX_DURATION_SECONDS / 3600}-hour import limit.`,
    );
  }
  if (duration <= 0) {
    // Design D10: a zero-length (or negative, malformed-metadata) take must
    // never be produced — the timeline-anchor transport advance (task 9.4)
    // depends on a strictly positive duration to place `Recording N Stopped`
    // after `Started`.
    throw new YtDlpError('This video has a non-positive duration, which is not supported.');
  }
  const uploadDate =
    typeof meta.upload_date === 'string' && meta.upload_date ? meta.upload_date : null;

  // ── Step 2: the actual download — pinned format, fixed output template,
  // byte-size cap, and a duration match-filter (belt-and-suspenders
  // alongside the JS-side check above; the JS-side check is the
  // authoritative enforcement — the match-filter is defense in depth in
  // case a future edit to this module's probe logic regresses). ──
  const downloadArgv = [...downloadFlags(maxFilesizeBytes), '--', opts.url];
  const download = await runYtDlpProcess(opts.binaryPath, downloadArgv, runOpts);
  if (download.timedOut) {
    throw new YtDlpError('Downloading audio timed out.');
  }
  if (download.exitCode !== 0) {
    throw new YtDlpError('Failed to download audio.');
  }

  const produced = await locateProducedFile(opts.tempDir);
  if (!produced) {
    throw new YtDlpError('Download did not produce an audio file.');
  }

  // JS-side byte-size backstop (design D5 axis 1, this module's own
  // authoritative check — mirrors the JS-side duration check above):
  // `--max-filesize` is enforced by yt-dlp itself DURING download, but for
  // some streams (size-unknown DASH/chunked) yt-dlp cannot know the final
  // size in advance and can exit 0 having written an over-cap file anyway.
  // Since D5 makes this cap load-bearing for RAM (Phase 5 buffers the
  // produced file whole), trusting the flag alone is not enough — `stat()`
  // the produced file and reject it here, same as any other bound breach
  // (never return `audioPath` for an over-cap file).
  const producedStat = await stat(produced.path);
  if (producedStat.size > maxFilesizeBytes) {
    throw new YtDlpError(
      `Downloaded audio exceeds the ${maxFilesizeBytes}-byte import limit (yt-dlp did not enforce --max-filesize for this stream).`,
    );
  }

  const contentType = contentTypeForExt(produced.ext);
  if (!contentType) {
    throw new YtDlpError(`Downloaded audio container ".${produced.ext}" is not supported.`);
  }

  return { audioPath: produced.path, contentType, uploadDate, duration };
}
