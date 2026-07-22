// youtube-audio-import (tasks 6.1 + 6.2) — frozen-surface integration tests
// over POST /api/sessions/:sessionId/youtube-import's full status matrix
// (api-contract-freeze delta "YouTube import endpoint behavior" +
// youtube-audio-import spec), using the hermetic fake-yt-dlp fixture
// (`server/src/test/fixtures/fake-ytdlp.mjs`, Phase 3) exec'd through a REAL
// launcher binary. No real network, no real yt-dlp anywhere in this suite.
//
// Never `vi.mock('node:child_process')`: `ai.int.test.ts`'s "SPAWN
// OBSERVATION" note documents that harness.ts's module-level imports resolve
// (and sessions.ts's own `spawn` binding along with them) BEFORE a test
// file's hoisted `vi.mock` takes effect through this `setupFiles`-driven
// harness — such a mock would be silently vacuous here. Every "no spawn"
// assertion below is instead backed by a REAL launcher binary that records a
// marker file on every genuine invocation (mirrors `ai.int.test.ts`'s
// `neverSpawned`/fixture-recording idiom) — falsifiable, not a mock call count.
//
// Mode selection: the fixture's own header says its `.ytdlp-stub.json`
// control file must live in `process.cwd()` — but the route handler
// `mkdtemp()`s a FRESH, randomly-suffixed per-request temp dir INSIDE the
// handler itself, so the test never learns that path in advance (and can't
// intercept `mkdtemp` for the same reason `child_process` can't be mocked).
// Each test instead generates its OWN launcher script (a `#!/bin/sh` wrapper
// with the desired control JSON baked in at generation time) that WRITES
// `.ytdlp-stub.json` into `$(pwd)` — which, at the moment the launcher runs,
// already equals the route's per-request temp dir (`cwd` is a `spawn()`
// option applied before exec) — immediately before exec'ing the fixture via
// an absolute `node` path. This needs no knowledge of the generated temp-dir
// name and no fixture changes. The launcher deliberately uses ONLY shell
// builtins (`echo`, `exec`) plus absolute paths — never a bare external
// command like `cat` — because the child env `fetchYoutubeAudio` builds
// (design D9) pins `PATH` to the resolved binary's own directory only, with
// no `/bin`/`/usr/bin`, so any external command looked up via `PATH` would
// fail to launch.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveYtDlpPath } from '../env';
import { createBindings } from '../node/config';
import { YOUTUBE_IMPORT_MAX_CONCURRENT, youtubeImportGuard } from '../node/youtubeImportGuard';
import { YOUTUBE_IMPORT_TMP_PREFIX } from '../node/youtubeImportScratch';
import { app, env, envWith } from '../test/harness';
import { seedSession, seedShow, seedStudio } from '../test/helpers';
import type { Bindings } from '../types';

const FIXTURE_PATH = fileURLToPath(new URL('../test/fixtures/fake-ytdlp.mjs', import.meta.url));

// Detail strings copied verbatim from `server/src/routers/sessions.ts`'s own
// module-private constants (not exported) so these tests assert the EXACT
// response body, not just a status code or a loose substring match.
const NOT_CONFIGURED_DETAIL = 'YouTube import is unavailable on this deployment.';
const OPEN_NETWORK_DETAIL =
  'YouTube import is refused: the server is bound to a non-loopback address with REQUIRE_LOGIN disabled and no IP_ALLOWLIST. ' +
  'Enable login, set an IP_ALLOWLIST, or bind to loopback (HOST=127.0.0.1) before importing third-party audio.';
const BAD_BODY_DETAIL = 'Invalid youtube-import request body.';
const BAD_URL_DETAIL = 'url must be an http(s) link to youtube.com, youtu.be, or music.youtube.com.';
const SESSION_BUSY_DETAIL = 'An import is already in progress for this session.';
const AT_CAPACITY_DETAIL =
  'The server is already running the maximum number of concurrent YouTube imports; try again shortly.';
const TRANSCRIPTION_UNAVAILABLE_DETAIL = 'Transcription is unavailable on this deployment.';

const scratchDirs: string[] = [];
function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ytdlp-route-test-'));
  scratchDirs.push(dir);
  return dir;
}

/** Build a `yt-dlp` launcher: records an invocation marker at a FIXED path
 * (proves the real binary was or wasn't ever exec'd — see file header), then
 * drops the fixture's mode-select control file into its OWN cwd (which, at
 * spawn time, IS the route's per-request temp dir) before exec'ing the
 * fixture via an absolute `node` path — no PATH lookup anywhere in the
 * chain (mirrors `ytdlp.test.ts`'s `makeBinary`). Uses only shell builtins. */
function makeYtDlpBinary(dir: string, opts: { markerPath: string; control?: Record<string, unknown> }): string {
  const binPath = join(dir, 'yt-dlp');
  const controlJson = JSON.stringify(opts.control ?? {});
  const script =
    '#!/bin/sh\n' +
    `echo invoked >> "${opts.markerPath}"\n` +
    `echo '${controlJson}' > .ytdlp-stub.json\n` +
    `exec "${process.execPath}" "${FIXTURE_PATH}" "$@"\n`;
  writeFileSync(binPath, script);
  chmodSync(binPath, 0o755);
  return binPath;
}

/** A fresh binary + a marker path that does not yet exist — `existsSync` on
 * it afterward is the real "was the subprocess ever launched" proof. */
function freshBinary(control?: Record<string, unknown>): { binaryPath: string; markerPath: string } {
  const dir = scratchDir();
  const markerPath = join(dir, 'invoked.marker');
  const binaryPath = makeYtDlpBinary(dir, { markerPath, control });
  return { binaryPath, markerPath };
}

function neverSpawned(markerPath: string): boolean {
  return !existsSync(markerPath);
}

/** Configured + NOT open-network-refused (design D9): loopback bind, login
 * not required, no allowlist. Individual tests layer further overrides. */
function configuredEnv(binaryPath: string, overrides: Record<string, unknown> = {}): Bindings {
  return envWith({
    YTDLP_RESOLVED_PATH: binaryPath,
    HOST: '127.0.0.1',
    REQUIRE_LOGIN: '0',
    IP_ALLOWLIST: '',
    ...overrides,
  });
}

async function seededSession(): Promise<string> {
  const studio = await seedStudio();
  const show = await seedShow({ studioId: studio });
  return seedSession({ showId: show });
}

async function postImport(sessionId: string, body: unknown, bindings: Bindings): Promise<Response> {
  return app.request(
    `/api/sessions/${sessionId}/youtube-import`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    bindings,
  );
}

async function listSegmentsRaw(sessionId: string, bindings: Bindings): Promise<string> {
  const res = await app.request(`/api/sessions/${sessionId}/audio/segments`, { method: 'GET' }, bindings);
  expect(res.status).toBe(200);
  return res.text();
}

async function listSegments(
  sessionId: string,
  bindings: Bindings,
): Promise<{ segments: Array<Record<string, unknown>>; has_audio: boolean }> {
  return JSON.parse(await listSegmentsRaw(sessionId, bindings));
}

const VALID_BODY = { url: 'https://youtu.be/abc123', use_publish_date: false };

afterEach(() => {
  youtubeImportGuard.reset();
  while (scratchDirs.length) {
    const dir = scratchDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// ── Matrix row 1: unconfigured — byte-for-byte 503 ──────────────────────────

describe('unconfigured deployment — byte-for-byte 503 (matrix; spec "No yt-dlp available is unavailable")', () => {
  it('POST returns the exact pre-change 503 {detail} with no yt-dlp binary resolved', async () => {
    const session = await seededSession();
    // The base test env's YTDLP_RESOLVED_PATH is null: `resetTestEnv`'s
    // `createBindings` call never passes a PATH var, so `resolveYtDlpPath`
    // finds nothing — hermetic regardless of the actual test machine's PATH.
    const res = await postImport(session, VALID_BODY, { ...env });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ detail: NOT_CONFIGURED_DETAIL });
    // No binary is configured at all in this scenario, so there is
    // structurally nothing a marker file could observe (the gate throws
    // before any binary path is even referenced) — the open-network-refusal
    // and 400/409 tests below are where a REAL configured binary's silence
    // is the falsifiable "no spawn" proof.
  });
});

// ── Phase 5 review must-cover: 503-precedence ───────────────────────────────

describe('503-precedence — unconfigured wins over the open-network refusal (Phase 5 review must-cover)', () => {
  it('a deployment that is BOTH unconfigured AND open-network-refused returns the legacy NOT_CONFIGURED detail, not the open-network detail', async () => {
    const session = await seededSession();
    // REQUIRE_LOGIN off + non-loopback + no allowlist == open-network-refused
    // ...AND YTDLP_RESOLVED_PATH is left at its base-env default (null) ==
    // unconfigured — both conditions hold simultaneously.
    const bothConditions = envWith({ REQUIRE_LOGIN: '0', HOST: '0.0.0.0', IP_ALLOWLIST: '' });
    const res = await postImport(session, VALID_BODY, bothConditions);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ detail: NOT_CONFIGURED_DETAIL });
  });
});

// ── Matrix row 2: open-network refusal ──────────────────────────────────────

describe('open-network refusal — 503, no spawn even though yt-dlp IS configured (spec D9)', () => {
  it('REQUIRE_LOGIN disabled + non-loopback bind + no IP_ALLOWLIST refuses even a configured deployment', async () => {
    const session = await seededSession();
    const { binaryPath, markerPath } = freshBinary();
    const res = await postImport(
      session,
      VALID_BODY,
      envWith({ YTDLP_RESOLVED_PATH: binaryPath, REQUIRE_LOGIN: '0', HOST: '0.0.0.0', IP_ALLOWLIST: '' }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ detail: OPEN_NETWORK_DETAIL });
    expect(neverSpawned(markerPath)).toBe(true);
  });
});

// ── Matrix row 3: body/URL validation ───────────────────────────────────────

describe('body/URL validation — 400, no spawn', () => {
  it('malformed body (missing url) → 400 {detail}, no spawn', async () => {
    const session = await seededSession();
    const { binaryPath, markerPath } = freshBinary();
    const res = await postImport(session, { use_publish_date: true }, configuredEnv(binaryPath));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail: BAD_BODY_DETAIL });
    expect(neverSpawned(markerPath)).toBe(true);
  });

  it.each([
    'https://youtube.com.evil.com/watch?v=x',
    'https://evil-youtube.com/watch?v=x',
    'https://youtube.com@evil.com/watch?v=x',
  ])('non-allowlisted/look-alike host %s → 400 {detail}, no spawn', async (url) => {
    const session = await seededSession();
    const { binaryPath, markerPath } = freshBinary();
    const res = await postImport(session, { url, use_publish_date: false }, configuredEnv(binaryPath));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail: BAD_URL_DETAIL });
    expect(neverSpawned(markerPath)).toBe(true);
  });
});

// ── Matrix row 4/6: youtu.be accepted, success, single segment, byte-
// identical, seekable, episode_date (tasks 6.1 + 6.2) ───────────────────────

describe('configured success (matrix: youtu.be accepted + success + episode_date; task 6.2 byte-identical/seekable)', () => {
  it('200 {ok:true}; exactly one new segment, byte-identical to the produced file, retrievable/seekable via the blob route; use_publish_date writes the un-shifted episode_date', async () => {
    const session = await seededSession();
    const { binaryPath, markerPath } = freshBinary(); // default success mode: ext m4a, upload_date "20240115"
    const testEnv = configuredEnv(binaryPath);

    const before = await listSegments(session, testEnv);
    expect(before.segments).toEqual([]);

    const res = await postImport(session, { url: 'https://youtu.be/abc123', use_publish_date: true }, testEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(existsSync(markerPath)).toBe(true); // sanity: the binary WAS invoked here, contrasting every no-spawn test above

    const after = await listSegments(session, testEnv);
    expect(after.segments).toHaveLength(1); // exactly one NEW segment
    expect(after.has_audio).toBe(true);
    const seg = after.segments[0] as { id: string; mime_type: string; url: string };
    expect(seg.mime_type).toBe('audio/mp4'); // produced .m4a → audio/mp4, derived from the PRODUCED file (design D3)

    // Byte-identical to what the fixture actually produced (task 6.2) — its
    // success mode always writes the literal string 'fake-audio-bytes'.
    const blobRes = await app.request(seg.url, { method: 'GET' }, testEnv);
    expect(blobRes.status).toBe(200);
    expect(new Uint8Array(await blobRes.arrayBuffer())).toEqual(new TextEncoder().encode('fake-audio-bytes'));

    // Seekable: a byte-range request against the SAME segment returns 206
    // with the exact sliced bytes — round-trips through the real blob
    // store's range path, not just a full-body fetch.
    const rangeRes = await app.request(seg.url, { method: 'GET', headers: { range: 'bytes=5-' } }, testEnv);
    expect(rangeRes.status).toBe(206);
    expect(new TextDecoder().decode(await rangeRes.arrayBuffer())).toBe('audio-bytes');

    // episode_date (design D4): un-shifted YYYY-MM-DD from upload_date 20240115,
    // served back through the session detail route (the read path the web
    // formatter renders from — day-rendering correctness itself is the
    // web-side task 4.2 test; this asserts the server stores/serves the
    // un-shifted value it's contracted to).
    const detailRes = await app.request(`/api/sessions/${session}`, { method: 'GET' }, testEnv);
    expect(((await detailRes.json()) as { episode_date: string | null }).episode_date).toBe('2024-01-15');
  });

  it('use_publish_date:false leaves episode_date untouched (spec: opt-out is a no-op)', async () => {
    const session = await seededSession();
    const { binaryPath } = freshBinary();
    const res = await postImport(
      session,
      { url: 'https://youtu.be/xyz789', use_publish_date: false },
      configuredEnv(binaryPath),
    );
    expect(res.status).toBe(200);
    const detailRes = await app.request(`/api/sessions/${session}`, { method: 'GET' }, { ...env });
    expect(((await detailRes.json()) as { episode_date: string | null }).episode_date).toBeNull();
  });
});

// ── Matrix row: bare yt-dlp on PATH counts as configured ────────────────────

describe('bare yt-dlp on PATH counts as configured (matrix; spec "Bare yt-dlp on PATH counts as configured")', () => {
  it('resolveYtDlpPath (the real startup PATH-lookup) finds a bare binary with no explicit path var, and the route treats it as configured', async () => {
    const session = await seededSession();
    const { binaryPath, markerPath } = freshBinary();
    const dir = dirname(binaryPath);

    // The real production function (server/src/env.ts), given a PATH that
    // contains the bare `yt-dlp` binary and NO explicit path var — exactly
    // the startup-resolution scenario, not a re-implementation of it.
    const resolved = resolveYtDlpPath({ PATH: dir });
    expect(resolved).toBe(binaryPath);

    const res = await postImport(
      session,
      { url: 'https://youtu.be/abc123', use_publish_date: false },
      envWith({ YTDLP_RESOLVED_PATH: resolved, HOST: '127.0.0.1', REQUIRE_LOGIN: '0', IP_ALLOWLIST: '' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(existsSync(markerPath)).toBe(true);
  });
});

// ── Matrix rows: both 409 causes, through the real route ────────────────────

describe('concurrency guards through the real route (matrix: both 409 causes; Phase 5 review must-cover)', () => {
  it('409 session-busy when the SAME session already has an import in flight, no spawn', async () => {
    const session = await seededSession();
    const { binaryPath, markerPath } = freshBinary();
    const lease = youtubeImportGuard.tryAcquire(session);
    expect(lease).not.toBeNull();
    try {
      const res = await postImport(session, VALID_BODY, configuredEnv(binaryPath));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ detail: SESSION_BUSY_DETAIL });
      expect(neverSpawned(markerPath)).toBe(true);
    } finally {
      lease?.release();
    }
  });

  it('409 at-capacity when the GLOBAL ceiling is reached by OTHER (distinct) sessions, no spawn', async () => {
    const session = await seededSession();
    const { binaryPath, markerPath } = freshBinary();
    const held = Array.from({ length: YOUTUBE_IMPORT_MAX_CONCURRENT }, (_, i) =>
      youtubeImportGuard.tryAcquire(`ceiling-other-${i}`),
    );
    expect(held.every((l) => l !== null)).toBe(true);
    try {
      const res = await postImport(session, VALID_BODY, configuredEnv(binaryPath));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ detail: AT_CAPACITY_DETAIL });
      expect(neverSpawned(markerPath)).toBe(true);
    } finally {
      for (const l of held) l?.release();
    }
  });
});

// ── Matrix row: post-validation failures → 502, audio unchanged ────────────

describe('post-validation failures — 502, audio unchanged (matrix: download-fail / unsupported-container / over-cap / live-stream)', () => {
  const cases: Array<[string, RegExp]> = [
    ['download-fail', /Failed to download/],
    ['unsupported-container', /not supported/],
    ['oversize', /Failed to download/],
    ['live', /live stream/],
  ];

  it.each(cases)('mode=%s → 502 {detail}, audio-segment listing byte-for-byte unchanged', async (mode, expectedDetail) => {
    const session = await seededSession();
    const { binaryPath } = freshBinary({ mode });
    const testEnv = configuredEnv(binaryPath);

    const before = await listSegmentsRaw(session, testEnv);
    const res = await postImport(session, VALID_BODY, testEnv);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { detail: string }).detail).toMatch(expectedDetail);

    const after = await listSegmentsRaw(session, testEnv);
    expect(after).toBe(before); // byte-for-byte unchanged — no orphan row, not merely "no playable segment"
  });
});

// ── Task 6.2: atomic rollback on blob-write (disk-full) failure ────────────

describe('atomic rollback on blob-write failure (task 6.2, design D7)', () => {
  it('a disk-full put() failure rolls back the inserted segment row: 502, and the audio-segment listing is byte-for-byte unchanged', async () => {
    const session = await seededSession();
    const { binaryPath } = freshBinary();
    const testEnv = configuredEnv(binaryPath);

    const before = await listSegmentsRaw(session, testEnv);

    const putSpy = vi.spyOn(env.ports.audio, 'put').mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));
    try {
      const res = await postImport(session, VALID_BODY, testEnv);
      expect(res.status).toBe(502);
      expect(((await res.json()) as { detail: string }).detail).toBe('Failed to import audio from YouTube.');
    } finally {
      putSpy.mockRestore();
    }

    const after = await listSegmentsRaw(session, testEnv);
    expect(after).toBe(before); // no orphan metadata row — byte-for-byte unchanged listing (the rollback-mechanism assertion)
  });
});

// ── Sibling stubs stay frozen ────────────────────────────────────────────────

describe('sibling stubs stay frozen even with yt-dlp configured', () => {
  it('topics/generate and transcribe.csv still respond 503, unaffected by youtube-import configuration', async () => {
    const session = await seededSession();
    const { binaryPath } = freshBinary();
    const testEnv = configuredEnv(binaryPath);

    const topics = await app.request(`/api/sessions/${session}/topics/generate`, { method: 'POST' }, testEnv);
    expect(topics.status).toBe(503);
    expect(await topics.json()).toEqual({ detail: TRANSCRIPTION_UNAVAILABLE_DETAIL });

    const csv = await app.request(`/api/sessions/${session}/transcribe.csv`, { method: 'GET' }, testEnv);
    expect(csv.status).toBe(503);
    expect(await csv.json()).toEqual({ detail: TRANSCRIPTION_UNAVAILABLE_DETAIL });
  });
});

// ── Phase 5 review must-cover: crash-orphan scratch-dir sweep ───────────────

describe('crash-orphan scratch-dir sweep (design D6, re-run of the startup wiring; Phase 5 review must-cover)', () => {
  it('createBindings removes a stray youtube-import-* scratch dir and leaves a differently-prefixed dir alone', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'autologger-sweep-'));
    try {
      const boot = createBindings({
        DATA_DIR: dataDir,
        PUBLIC_BASE_URL: 'https://example.com',
        GOOGLE_CLIENT_SECRET: 'test-secret',
        REQUIRE_LOGIN: '0',
      });
      const scratchRoot = boot.bindings.ports.audio.scratchRoot();
      boot.close();

      const strayDir = join(scratchRoot, `${YOUTUBE_IMPORT_TMP_PREFIX}stray-session-orphan`);
      mkdirSync(strayDir, { recursive: true });
      writeFileSync(join(strayDir, 'audio.m4a'), 'orphaned-partial-download');

      const survivorDir = join(scratchRoot, 'transcript-generation-unrelated-prefix');
      mkdirSync(survivorDir, { recursive: true });
      writeFileSync(join(survivorDir, 'keep.txt'), 'not a youtube-import dir');

      expect(existsSync(strayDir)).toBe(true);
      expect(existsSync(survivorDir)).toBe(true);

      // Re-run the startup wiring — THIS is what sweeps stray import temp dirs.
      const reboot = createBindings({
        DATA_DIR: dataDir,
        PUBLIC_BASE_URL: 'https://example.com',
        GOOGLE_CLIENT_SECRET: 'test-secret',
        REQUIRE_LOGIN: '0',
      });
      try {
        expect(existsSync(strayDir)).toBe(false); // swept
        expect(existsSync(survivorDir)).toBe(true); // untouched — different prefix
        expect(existsSync(join(survivorDir, 'keep.txt'))).toBe(true);
      } finally {
        reboot.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
