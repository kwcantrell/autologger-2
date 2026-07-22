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
import { describe, expect, it } from 'vitest';
import { downloadFlags, PROBE_FLAGS } from './ytdlp';

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
});
