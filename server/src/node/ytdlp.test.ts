// youtube-audio-import (task 3.2) — unit tests for the yt-dlp spawn +
// lockdown + bounds module, against the hermetic `fake-ytdlp.mjs` fixture.
// No real network, no real `yt-dlp` binary anywhere in this suite.
//
// The fixture is a `#!/usr/bin/env node` script, but it is never exec'd via
// its own shebang here: `ytdlp.ts`'s child env pins `PATH` to the resolved
// binary's OWN directory (design D9) — NOT the real PATH `env`/`node` would
// need to resolve via a shebang lookup. So each test generates a tiny
// `#!/bin/sh` launcher (in the same per-test temp dir used as `tempDir`)
// that execs the fixture via `process.execPath` — an ABSOLUTE path baked in
// at generation time, needing no PATH lookup at all. This both sidesteps
// the mismatch AND is itself evidence the module's minimal env genuinely
// works end to end (a real yt-dlp standalone binary needs no PATH either).

import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIO_FORMAT_SELECTOR,
  buildYtDlpChildEnv,
  fetchYoutubeAudio,
  MAX_DURATION_SECONDS,
  OUTPUT_TEMPLATE,
  YtDlpError,
} from './ytdlp';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const spawnSpy = vi.mocked(spawn);

const FIXTURE_PATH = fileURLToPath(new URL('../test/fixtures/fake-ytdlp.mjs', import.meta.url));

/** A URL that is SIMULTANEOUSLY a leading-`-` string (would be parsed as a
 * flag by an option parser) and laced with shell metacharacters (would be
 * expanded/executed by a shell) — the exact shape the `--` terminator +
 * `shell: false` + discrete argv array together must neutralize. */
const HOSTILE_URL = '-rf; $(id) > /tmp/pwned #http://evil';

const tempDirs: string[] = [];

/** Fresh per-request temp dir (the module writes only into this — matches
 * production's per-request temp-dir contract) that ALSO doubles as the
 * launcher's home directory, so `dirname(binaryPath)` (the module's PATH
 * pin) is this same throwaway dir — proof the child needs nothing else on
 * PATH to run. */
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ytdlp-test-'));
  tempDirs.push(dir);
  return dir;
}

/** Writes a `#!/bin/sh` launcher at `<dir>/yt-dlp` that execs the fixture
 * via an absolute `node` path — no PATH lookup anywhere in the exec chain. */
function makeBinary(dir: string): string {
  const binPath = join(dir, 'yt-dlp');
  writeFileSync(binPath, `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE_PATH}" "$@"\n`);
  chmodSync(binPath, 0o755);
  return binPath;
}

function readArgvLog(tempDir: string): string[][] {
  const path = join(tempDir, 'argv-log.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readEnvCheck(tempDir: string, kind: 'probe' | 'download'): Record<string, unknown> | null {
  const path = join(tempDir, `env-check-${kind}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Drops the fixture's behavior-select control file into `tempDir` (its
 * `process.cwd()`) — NOT an env var: `fetchYoutubeAudio`'s child env is
 * deliberately scrubbed (design D9), so an arbitrary `YTDLP_STUB_MODE`-style
 * var could never reach the child through the real code path being tested. */
function writeStubControl(
  tempDir: string,
  control: {
    mode?: string;
    ext?: string;
    uploadDate?: string | null;
    descendantDelayMs?: number;
    duration?: number;
  },
): void {
  writeFileSync(join(tempDir, '.ytdlp-stub.json'), JSON.stringify(control));
}

afterEach(() => {
  spawnSpy.mockClear();
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// ── buildYtDlpChildEnv — pure minimal-env builder ───────────────────────────

describe('buildYtDlpChildEnv — minimal scrubbed env', () => {
  it('carries HOME (when present) and PATH pinned to the binary dir — never the real PATH', () => {
    const env = buildYtDlpChildEnv(
      {
        HOME: '/home/op',
        PATH: '/usr/bin:/bin',
        PLANTED_SECRET_TOKEN: 'do-not-leak',
      } as NodeJS.ProcessEnv,
      '/opt/ytdlp/bin/yt-dlp',
    );
    expect(env).toEqual({ HOME: '/home/op', PATH: '/opt/ytdlp/bin' });
  });

  it('omits HOME when absent from the source env (never fabricated)', () => {
    const env = buildYtDlpChildEnv({} as NodeJS.ProcessEnv, '/opt/ytdlp/bin/yt-dlp');
    expect(env).toEqual({ PATH: '/opt/ytdlp/bin' });
  });

  it('adds proxy/TLS vars only when present, never inventing them', () => {
    const env = buildYtDlpChildEnv(
      { HTTPS_PROXY: 'http://proxy:8080', NODE_EXTRA_CA_CERTS: '/etc/ca.pem' } as NodeJS.ProcessEnv,
      '/opt/ytdlp/bin/yt-dlp',
    );
    expect(env).toEqual({
      PATH: '/opt/ytdlp/bin',
      HTTPS_PROXY: 'http://proxy:8080',
      NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
    });
  });
});

// ── fetchYoutubeAudio — success path ────────────────────────────────────────

describe('fetchYoutubeAudio — success', () => {
  it('returns the produced file path, derived contentType, and parsed uploadDate', async () => {
    const tempDir = makeTempDir();
    const binaryPath = makeBinary(tempDir);

    const result = await fetchYoutubeAudio({ url: 'https://youtu.be/abc123', tempDir, binaryPath });

    expect(result).toEqual({
      audioPath: join(tempDir, 'audio.m4a'),
      contentType: 'audio/mp4',
      uploadDate: '20240115',
      duration: 125,
    });
    expect(existsSync(result.audioPath)).toBe(true);
  });

  it('uploadDate is null when yt-dlp reports none', async () => {
    const tempDir = makeTempDir();
    const binaryPath = makeBinary(tempDir);
    writeStubControl(tempDir, { uploadDate: null });

    const result = await fetchYoutubeAudio({ url: 'https://youtu.be/abc123', tempDir, binaryPath });

    expect(result.uploadDate).toBeNull();
  });

  it.each([
    ['webm', 'audio/webm'],
    ['ogg', 'audio/ogg'],
    ['wav', 'audio/wav'],
    ['m4a', 'audio/mp4'],
  ])('maps a produced .%s file to contentType %s', async (ext, contentType) => {
    const tempDir = makeTempDir();
    const binaryPath = makeBinary(tempDir);
    writeStubControl(tempDir, { ext });

    const result = await fetchYoutubeAudio({ url: 'https://youtu.be/abc123', tempDir, binaryPath });

    expect(result.contentType).toBe(contentType);
    expect(result.audioPath).toBe(join(tempDir, `audio.${ext}`));
  });
});

// ── Argv hardening: `--` terminator, discrete array, no shell/option
// interpretation (gate-intent target) ───────────────────────────────────────

describe('fetchYoutubeAudio — argv hardening', () => {
  it('passes a hostile URL as a discrete argv element after `--`, on BOTH the probe and download spawns', async () => {
    const tempDir = makeTempDir();
    const binaryPath = makeBinary(tempDir);

    await fetchYoutubeAudio({ url: HOSTILE_URL, tempDir, binaryPath });

    const invocations = readArgvLog(tempDir);
    expect(invocations).toHaveLength(2); // probe + download
    for (const argv of invocations) {
      // The literal hostile string arrives byte-for-byte as the LAST argv
      // element, immediately preceded by a bare `--` — proof it was never
      // shell-expanded (no shell was ever involved: `spawn(..., {shell:
      // false})`) and never option-parsed (nothing upstream of `--` could
      // mistake it for a flag).
      expect(argv.at(-1)).toBe(HOSTILE_URL);
      expect(argv.at(-2)).toBe('--');
    }
  });

  it('includes the lockdown flags and the pinned format/output template on the download spawn', async () => {
    const tempDir = makeTempDir();
    const binaryPath = makeBinary(tempDir);

    await fetchYoutubeAudio({ url: 'https://youtu.be/abc123', tempDir, binaryPath });

    const [probeArgv, downloadArgv] = readArgvLog(tempDir);
    for (const argv of [probeArgv, downloadArgv]) {
      expect(argv).toContain('--ignore-config');
      expect(argv).toContain('--no-plugin-dirs');
    }
    expect(probeArgv).toContain('--skip-download');
    expect(downloadArgv).not.toContain('--skip-download');
    expect(downloadArgv).toEqual(
      expect.arrayContaining([
        '-f',
        AUDIO_FORMAT_SELECTOR,
        '-o',
        OUTPUT_TEMPLATE,
        '--max-filesize',
      ]),
    );
  });
});

// ── Security lockdown intent: a planted secret genuinely does not reach the
// child (gate-intent target) ────────────────────────────────────────────────

describe('fetchYoutubeAudio — child env exclusion', () => {
  it('never forwards a planted secret env var to either spawn, and always sets --ignore-config', async () => {
    const tempDir = makeTempDir();
    const binaryPath = makeBinary(tempDir);

    await fetchYoutubeAudio({
      url: 'https://youtu.be/abc123',
      tempDir,
      binaryPath,
      procEnv: {
        HOME: '/home/tester',
        PLANTED_SECRET_TOKEN: 'do-not-leak',
      } as unknown as NodeJS.ProcessEnv,
    });

    const probeCheck = readEnvCheck(tempDir, 'probe');
    const downloadCheck = readEnvCheck(tempDir, 'download');
    expect(probeCheck).toEqual({
      hasPlantedSecret: false,
      hasHome: true,
      path: dirname(binaryPath),
      hasIgnoreConfig: true,
      hasNoPluginDirs: true,
    });
    expect(downloadCheck).toEqual(probeCheck);
  });
});

// ── Bound enforcement: each axis maps to the typed error, no result ever
// returned (so no caller could ever store a blob) ───────────────────────────

describe('fetchYoutubeAudio — bound enforcement', () => {
  const cases: Array<[string, string]> = [
    ['live', 'live stream'],
    ['null-duration', 'no known duration'],
    ['long-duration', 'longer than the'],
    ['oversize', 'Failed to download'],
    ['unsupported-container', 'is not supported'],
    ['probe-fail', 'Failed to read video metadata'],
    ['download-fail', 'Failed to download'],
  ];

  it.each(
    cases,
  )('mode=%s rejects with YtDlpError (%s) and produces no usable result', async (mode, expectedSubstring) => {
    const tempDir = makeTempDir();
    const binaryPath = makeBinary(tempDir);
    writeStubControl(tempDir, { mode });

    const promise = fetchYoutubeAudio({ url: 'https://youtu.be/abc123', tempDir, binaryPath });

    await expect(promise).rejects.toBeInstanceOf(YtDlpError);
    await expect(promise).rejects.toThrow(expectedSubstring);
    // A supported-container audio.m4a is never left behind for any bound or
    // format rejection — nothing a caller could ever pick up as a blob.
    expect(existsSync(join(tempDir, 'audio.m4a'))).toBe(false);
  });

  it('the 4-hour cap boundary matches MAX_DURATION_SECONDS', () => {
    expect(MAX_DURATION_SECONDS).toBe(4 * 60 * 60);
  });

  // Task 9.2 / design D10: a zero-length take must never be produced — a
  // non-positive reported duration is rejected at the metadata-probe step,
  // same as live/null/over-4h, and the download spawn never runs.
  it.each([
    0, -5,
  ])('rejects a non-positive duration (%i) with YtDlpError, no download spawn', async (duration) => {
    const tempDir = makeTempDir();
    const binaryPath = makeBinary(tempDir);
    writeStubControl(tempDir, { duration });

    const promise = fetchYoutubeAudio({ url: 'https://youtu.be/abc123', tempDir, binaryPath });

    await expect(promise).rejects.toBeInstanceOf(YtDlpError);
    await expect(promise).rejects.toThrow('non-positive duration');
    expect(existsSync(join(tempDir, 'audio.m4a'))).toBe(false);
    // Only the probe ran — the download step is never reached once the
    // probe itself rejects the duration.
    expect(readArgvLog(tempDir)).toHaveLength(1);
  });
});

// ── Hang timeout: a stuck subprocess is killed, not awaited forever ────────

describe('fetchYoutubeAudio — hang timeout', () => {
  it('kills a hanging probe and rejects within the configured timeout', async () => {
    const tempDir = makeTempDir();
    const binaryPath = makeBinary(tempDir);
    const hangTimeoutMs = 200;
    writeStubControl(tempDir, { mode: 'hang' });

    const started = Date.now();
    await expect(
      fetchYoutubeAudio({ url: 'https://youtu.be/abc123', tempDir, binaryPath, hangTimeoutMs }),
    ).rejects.toThrow(/timed out/i);
    const elapsed = Date.now() - started;
    // Bounded well under the test's own timeout, and not suspiciously
    // instantaneous either (proves it actually waited for the timer, not a
    // coincidental early exit).
    expect(elapsed).toBeGreaterThanOrEqual(hangTimeoutMs);
    expect(elapsed).toBeLessThan(hangTimeoutMs + 5000);
  }, 10000);

  // Fix wave 1 (Phase 3 review, Finding 2): the hang-timeout kill must reach
  // the WHOLE process group, not just the direct yt-dlp pid — a descendant
  // (e.g. an ffmpeg postprocessor) must never outlive the bound. The fixture
  // forks a grandchild (inheriting its own process group, unrelated to
  // `detached`) that would write a marker file after a delay LONGER than the
  // hang timeout; if the caller's kill only signaled the direct pid, that
  // grandchild would survive and eventually write its marker.
  it('kills a hanging download AND its descendant (process-group kill, not just the direct pid)', async () => {
    const tempDir = makeTempDir();
    const binaryPath = makeBinary(tempDir);
    const hangTimeoutMs = 200;
    const descendantDelayMs = 1500;
    writeStubControl(tempDir, { mode: 'hang-with-descendant', descendantDelayMs });

    await expect(
      fetchYoutubeAudio({ url: 'https://youtu.be/abc123', tempDir, binaryPath, hangTimeoutMs }),
    ).rejects.toThrow(/timed out/i);

    // Wait past the descendant's own delay window. If the group kill
    // failed and only the direct pid died, the still-alive grandchild's
    // timer would fire during this wait and the marker would appear.
    await new Promise((resolve) => setTimeout(resolve, descendantDelayMs + 500));
    expect(existsSync(join(tempDir, 'descendant-marker.txt'))).toBe(false);
  }, 10000);
});

// ── Byte-size backstop: the JS-side check is authoritative, not just the
// `--max-filesize` flag (Fix wave 1, Phase 3 review Finding 1) ─────────────

describe('fetchYoutubeAudio — byte-size backstop (independent of --max-filesize)', () => {
  it(
    'rejects a produced file that exceeds maxFilesizeBytes even though yt-dlp exited 0 ' +
      '(simulates a size-unknown stream the flag could not enforce in advance)',
    async () => {
      const tempDir = makeTempDir();
      const binaryPath = makeBinary(tempDir);
      writeStubControl(tempDir, { mode: 'oversize-bypass' });

      const promise = fetchYoutubeAudio({
        url: 'https://youtu.be/abc123',
        tempDir,
        binaryPath,
        maxFilesizeBytes: 100,
      });

      await expect(promise).rejects.toBeInstanceOf(YtDlpError);
      await expect(promise).rejects.toThrow(/exceeds the 100-byte import limit/);
    },
  );
});

// ── spawn() call contract: real node:child_process.spawn, wrapped only to
// assert the exact options object (never shell:true, discrete argv, scoped
// cwd) — the fixture IS the subprocess boundary under test throughout this
// suite; nothing here is faked. ──────────────────────────────────────────

describe('fetchYoutubeAudio — spawn contract', () => {
  it('spawns both the probe and download with shell:false and cwd pinned to tempDir', async () => {
    const tempDir = makeTempDir();
    const binaryPath = makeBinary(tempDir);

    await fetchYoutubeAudio({ url: HOSTILE_URL, tempDir, binaryPath });

    expect(spawnSpy).toHaveBeenCalledTimes(2);
    for (const call of spawnSpy.mock.calls) {
      const [cmd, argv, options] = call;
      expect(cmd).toBe(binaryPath);
      expect(Array.isArray(argv)).toBe(true);
      expect(options).toMatchObject({ shell: false, cwd: tempDir });
    }
    // The hostile string never reached a real shell: no stray file at the
    // path its `$(...)`/`>` payload names.
    expect(existsSync(join(tempDir, 'pwned'))).toBe(false);
    expect(existsSync('/tmp/pwned')).toBe(false);
  });
});
