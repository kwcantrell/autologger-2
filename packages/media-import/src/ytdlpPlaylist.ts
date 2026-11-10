// youtube-playlist-import (design D3, task 2.3) — the metadata-only playlist listing spawn.
// One flat-playlist `yt-dlp` call (no video page fetched, no media downloaded) with the
// import spawn's lockdown (`LOCKDOWN_ARGV`, discrete argv, `--` terminator, `shell: false`,
// the scrubbed `buildYtDlpChildEnv`) and four bounds: 5000 entries (`--playlist-end`),
// 16 MiB of stdout, 60 s of wall clock (both kill the whole process group) and, in the
// route, two listings per process (`playlistListingGuard`). Stderr is read up to 64 KiB
// only to tell a private or nonexistent playlist from other failures; it is never echoed.
//
// Like `fetchYoutubeAudio`, this module neither validates the URL (the caller passes the
// canonical href built from `validateYoutubePlaylistUrl`'s list id) nor owns the temp dir
// (the caller creates it and removes it in a `finally`).

import { buildYtDlpChildEnv, LOCKDOWN_ARGV, runYtDlpProcess, YtDlpError } from './ytdlp';

/** YouTube's own playlist cap; a longer list (a large channel's uploads) comes back
 * truncated (design D3, A7). */
export const PLAYLIST_MAX_ENTRIES = 5000;
/** ~1.36 KB per flat entry (A2, A6) → 5000 entries ≈ 6.8 MB; 2.3× headroom. */
export const PLAYLIST_MAX_STDOUT_BYTES = 16 * 1024 * 1024;
/** yt-dlp's error lines are under 200 bytes (A4). */
export const PLAYLIST_MAX_STDERR_BYTES = 64 * 1024;
/** 1702 entries took 9.4 s (A6) → 5000 ≈ 28 s; under Cloudflare's 100 s proxy limit. */
export const PLAYLIST_TIMEOUT_MS = 60_000;

/** The flag portion of the listing argv (everything before `--`), exported so the
 * real-binary smoke test validates exactly these spellings. */
export const PLAYLIST_FLAGS: readonly string[] = [
  ...LOCKDOWN_ARGV,
  '--flat-playlist',
  '--dump-single-json',
  '--playlist-end',
  String(PLAYLIST_MAX_ENTRIES),
];

/** The contract's fixed `502` details (api-contract-freeze "YouTube playlist listing
 * endpoint"); a `YtDlpError` from this module always carries one of them. */
export const PLAYLIST_ERROR_DETAILS = {
  privateOrMissing:
    'This playlist is private or does not exist. Only public and unlisted playlists can be imported.',
  timedOut: 'Listing the playlist timed out.',
  generic: 'Failed to list the playlist.',
} as const;

const PRIVATE_OR_MISSING = /does not exist|is private|private playlist/i;

export interface ListYoutubePlaylistOptions {
  /** The validated list id (`validateYoutubePlaylistUrl`). */
  listId: string;
  /** `https://www.youtube.com/playlist?list=<listId>`, built by the validator. */
  href: string;
  /** Per-request directory the caller created and removes; the spawn's cwd. */
  tempDir: string;
  /** The startup-resolved binary (`Config.YTDLP_RESOLVED_PATH`). */
  binaryPath: string;
  /** Override for tests; defaults to `process.env` (only HOME and the proxy/TLS allowlist
   * are read, see `buildYtDlpChildEnv`). */
  procEnv?: NodeJS.ProcessEnv;
  /** Override for tests; defaults to `PLAYLIST_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Override for tests; defaults to `PLAYLIST_MAX_STDOUT_BYTES`. */
  maxStdoutBytes?: number;
}

/**
 * List one playlist's entries (flat metadata). Resolves with yt-dlp's parsed
 * `--dump-single-json` object (a `_type: 'playlist'` object; `projectPlaylist` maps it to
 * the contract shape). Throws `YtDlpError` with one of `PLAYLIST_ERROR_DETAILS` on every
 * failure: private-or-missing (classified from stderr), timed out, or generic (output
 * overflow, another non-zero exit, unparseable output, a non-playlist object).
 */
export async function listYoutubePlaylist(
  opts: ListYoutubePlaylistOptions,
): Promise<Record<string, unknown>> {
  const env = buildYtDlpChildEnv(opts.procEnv ?? process.env, opts.binaryPath);
  const result = await runYtDlpProcess(opts.binaryPath, [...PLAYLIST_FLAGS, '--', opts.href], {
    cwd: opts.tempDir,
    env,
    timeoutMs: opts.timeoutMs ?? PLAYLIST_TIMEOUT_MS,
    maxStdoutBytes: opts.maxStdoutBytes ?? PLAYLIST_MAX_STDOUT_BYTES,
    maxStderrBytes: PLAYLIST_MAX_STDERR_BYTES,
  });
  if (result.timedOut) throw new YtDlpError(PLAYLIST_ERROR_DETAILS.timedOut);
  if (result.overflow) throw new YtDlpError(PLAYLIST_ERROR_DETAILS.generic);
  if (result.exitCode !== 0) {
    throw new YtDlpError(
      PRIVATE_OR_MISSING.test(result.stderr)
        ? PLAYLIST_ERROR_DETAILS.privateOrMissing
        : PLAYLIST_ERROR_DETAILS.generic,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    throw new YtDlpError(PLAYLIST_ERROR_DETAILS.generic);
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    (parsed as { _type?: unknown })._type !== 'playlist'
  ) {
    throw new YtDlpError(PLAYLIST_ERROR_DETAILS.generic);
  }
  return parsed as Record<string, unknown>;
}
