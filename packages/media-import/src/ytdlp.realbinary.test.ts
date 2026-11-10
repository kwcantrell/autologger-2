// Real-binary flag-validity smoke test.
//
// The hermetic unit tests (`ytdlp.test.ts`) drive a FAKE yt-dlp that accepts
// any flag, so a nonexistent yt-dlp option (historically `--no-plugins` /
// `--no-netrc`) passes CI while breaking every real invocation with
// "no such option" — which surfaced only as an opaque "Failed to read video
// metadata." in production. This test runs the ACTUAL yt-dlp binary (when one
// is available via `YTDLP_PATH` or on `PATH`) with the EXACT flag sets this
// module spawns — imported `PROBE_FLAGS` / `downloadFlags`, never re-typed, so
// the test cannot share a typo with the code — and asserts yt-dlp rejects none
// of them.
//
// It is network-INDEPENDENT: yt-dlp parses options BEFORE any fetch, so an
// invalid flag prints "no such option" regardless of connectivity, while valid
// flags proceed to fail on the bogus, 1s-timeout URL with a different error.
// It skips deterministically when no yt-dlp is installed (e.g. CI without one).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { downloadFlags, PROBE_FLAGS } from './ytdlp';
import { listYoutubePlaylist, PLAYLIST_ERROR_DETAILS, PLAYLIST_FLAGS } from './ytdlpPlaylist';

function resolveYtDlp(): string | null {
  const candidate = (process.env.YTDLP_PATH || '').trim() || 'yt-dlp';
  const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
  return probe.status === 0 ? candidate : null;
}

const binary = resolveYtDlp();

// Validate a flag set without doing real work: append `--simulate` (so nothing
// is downloaded/written even with `-o` set), a fast socket timeout, and a bogus
// URL. We assert only the ABSENCE of an option-parse error.
function optionParseOutput(flags: readonly string[]): string {
  const res = spawnSync(
    binary as string,
    [...flags, '--simulate', '--socket-timeout', '1', '--', 'https://example.com/notavideo'],
    { encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL' },
  );
  return `${res.stdout ?? ''}${res.stderr ?? ''}`;
}

describe('yt-dlp real-binary flag validity', () => {
  it.skipIf(!binary)('every PROBE_FLAGS option is a real yt-dlp option', () => {
    expect(optionParseOutput(PROBE_FLAGS)).not.toMatch(/no such option/i);
  });

  it.skipIf(!binary)('every downloadFlags option is a real yt-dlp option', () => {
    expect(optionParseOutput(downloadFlags(1))).not.toMatch(/no such option/i);
  });

  // youtube-playlist-import task 2.4: the listing spawn's flags.
  it.skipIf(!binary)('every PLAYLIST_FLAGS option is a real yt-dlp option', () => {
    expect(optionParseOutput(PLAYLIST_FLAGS)).not.toMatch(/no such option/i);
  });
});

// youtube-playlist-import (design Risks "[Stderr classification is text-matching]"): the
// private-or-nonexistent 502 depends on yt-dlp's stderr wording, so a real yt-dlp must still
// classify a missing list that way. Needs network: runs only with YTDLP_NETWORK_TESTS=1.
const network = process.env.YTDLP_NETWORK_TESTS === '1';

describe('yt-dlp real-binary playlist classification (network)', () => {
  it.skipIf(!binary || !network)(
    'a nonexistent PL list is classified private-or-nonexistent',
    async () => {
      const listId = `PL${'a'.repeat(32)}`;
      const tempDir = mkdtempSync(join(tmpdir(), 'ytdlp-real-playlist-'));
      try {
        const err = await listYoutubePlaylist({
          listId,
          href: `https://www.youtube.com/playlist?list=${listId}`,
          tempDir,
          binaryPath: binary as string,
        }).catch((e: unknown) => e);
        expect((err as Error).message).toBe(PLAYLIST_ERROR_DETAILS.privateOrMissing);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
