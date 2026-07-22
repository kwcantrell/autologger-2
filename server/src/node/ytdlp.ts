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
// `server/src/routers/aiChatRunner.ts`): `shell: false` with a discrete argv
// array and a `--` terminator before the positional URL (never shell- or
// option-interpreted); `--ignore-config` + `--no-plugins` + `--no-netrc` so
// no ambient `yt-dlp` config file, plugin, or `.netrc` credential can inject
// flags (`--exec`, `--postprocessor-args`, …) or leak credentials into the
// run; a minimal, SCRUBBED child env — never inherited `process.env` — that
// carries only HOME (if the parent has one) + PATH pinned to the resolved
// binary's OWN directory (never the parent's real `PATH`, and never
// containing anything else — deliberately even MORE restrictive than
// `buildAiChatChildEnv`, since yt-dlp's ambient-config/plugin surface is the
// larger direct RCE risk here) + the same small proxy/TLS allowlist
// `buildAiChatChildEnv` forwards, added only when the parent actually has it.

import { type ChildProcess, spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
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
 * pointless egress either way. */
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
 * reused across the node/routers layering split (`server/src/node/` is
 * lower-level infrastructure; `routers/aiChatRunner.ts` is router-layer). */
const OPTIONAL_ENV_PASSTHROUGH = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS'] as const;

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

/** Spawn one yt-dlp invocation with `shell: false` against the scrubbed env,
 * bounded by `timeoutMs` wall-clock (design D5 axis 4) — on expiry the
 * process is SIGKILLed (a hung process, by definition, isn't going to
 * respond to a gentler signal) and `timedOut: true` is reported. Never
 * throws: spawn failure surfaces as `exitCode: null` via the child's own
 * `error` event, uniformly with a non-zero exit for the caller's purposes. */
function runYtDlpProcess(
  binaryPath: string,
  argv: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number },
): Promise<RunResult> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawn(binaryPath, argv, { shell: false, cwd: opts.cwd, env: opts.env });
    } catch {
      resolve({ exitCode: null, stdout: '', timedOut: false });
      return;
    }

    let stdout = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
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
 * no plugins, no `.netrc` credential use, and quiet (no warning noise to
 * parse around). */
const LOCKDOWN_ARGV = ['--ignore-config', '--no-plugins', '--no-netrc', '--no-warnings'];

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
  const probeArgv = [...LOCKDOWN_ARGV, '--skip-download', '--dump-json', '--', opts.url];
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
  const uploadDate = typeof meta.upload_date === 'string' && meta.upload_date ? meta.upload_date : null;

  // ── Step 2: the actual download — pinned format, fixed output template,
  // byte-size cap, and a duration match-filter (belt-and-suspenders
  // alongside the JS-side check above; the JS-side check is the
  // authoritative enforcement — the match-filter is defense in depth in
  // case a future edit to this module's probe logic regresses). ──
  const downloadArgv = [
    ...LOCKDOWN_ARGV,
    '-f',
    AUDIO_FORMAT_SELECTOR,
    '-o',
    OUTPUT_TEMPLATE,
    '--max-filesize',
    String(maxFilesizeBytes),
    '--match-filter',
    `duration < ${MAX_DURATION_SECONDS}`,
    '--no-simulate',
    '--',
    opts.url,
  ];
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
  const contentType = contentTypeForExt(produced.ext);
  if (!contentType) {
    throw new YtDlpError(`Downloaded audio container ".${produced.ext}" is not supported.`);
  }

  return { audioPath: produced.path, contentType, uploadDate };
}
