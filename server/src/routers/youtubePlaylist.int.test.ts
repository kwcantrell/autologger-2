// youtube-playlist-import (tasks 5.1, 5.2) — POST /api/youtube/playlist-entries over its whole
// status table (api-contract-freeze "YouTube playlist listing endpoint", "Run features are
// limited to approved users"; youtube-audio-import "Playlist listing is gated, validated and
// bounded"), against the hermetic fake yt-dlp (`packages/media-import/fixtures/fake-ytdlp.mjs`)
// exec'd through a real launcher. No network, no real yt-dlp.
//
// The launcher pattern is `sessions.youtubeImport.int.test.ts`'s (see its header): each test
// writes a `#!/bin/sh` launcher that records an invocation marker at a fixed path (the "no
// spawn" proof, never a mock), drops the fixture's `.ytdlp-stub.json` control file into its own
// cwd (the route's per-request temp dir) and execs the fixture through an absolute `node`.

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEDIA_IMPORT_FIXTURES_DIR, playlistListingGuard } from '@autologger/media-import';
import { afterEach, describe, expect, it } from 'vitest';
import type { Bindings } from '../appEnv';
import { anonApp, app, env, envWith } from '../test/harness';
import { loginCookie, NOT_APPROVED_EMAIL, seedUser, testDb } from '../test/helpers';
import { playlistListingLimits } from './youtubePlaylist';

const FIXTURE_PATH = join(MEDIA_IMPORT_FIXTURES_DIR, 'fake-ytdlp.mjs');
const ROUTE = '/api/youtube/playlist-entries';
const TMP_PREFIX = 'youtube-import-playlist-';

const D = {
  notConfigured: 'YouTube import is unavailable on this deployment.',
  forbidden: 'This feature is limited to approved users on this server.',
  notPlaylist:
    'url must be a YouTube playlist link: youtube.com/playlist?list=… or youtube.com/watch?v=…&list=….',
  mix: "Mix and radio lists can't be imported; use a regular playlist link.",
  busy: 'Playlist listing is busy; try again.',
  privateOrMissing:
    'This playlist is private or does not exist. Only public and unlisted playlists can be imported.',
  timedOut: 'Listing the playlist timed out.',
  generic: 'Failed to list the playlist.',
};

const PLAYLIST_URL = 'https://www.youtube.com/playlist?list=PLBB231211A4F62143';
const ENTRY_KEYS = ['duration_s', 'importable', 'index', 'reason', 'title', 'url', 'video_id'];

const scratchDirs: string[] = [];
function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ytdlp-playlist-route-test-'));
  scratchDirs.push(dir);
  return dir;
}

function freshBinary(control: Record<string, unknown> = { mode: 'playlist' }): {
  binaryPath: string;
  markerPath: string;
} {
  const dir = scratchDir();
  const markerPath = join(dir, 'invoked.marker');
  const binaryPath = join(dir, 'yt-dlp');
  writeFileSync(
    binaryPath,
    '#!/bin/sh\n' +
      `echo invoked >> "${markerPath}"\n` +
      `echo '${JSON.stringify(control)}' > .ytdlp-stub.json\n` +
      `exec "${process.execPath}" "${FIXTURE_PATH}" "$@"\n`,
  );
  chmodSync(binaryPath, 0o755);
  return { binaryPath, markerPath };
}

function invocations(markerPath: string): number {
  return existsSync(markerPath)
    ? readFileSync(markerPath, 'utf8').split('\n').filter(Boolean).length
    : 0;
}

function configuredEnv(binaryPath: string, overrides: Record<string, unknown> = {}): Bindings {
  return envWith({
    YTDLP_RESOLVED_PATH: binaryPath,
    HOST: '127.0.0.1',
    IP_ALLOWLIST: '',
    ...overrides,
  });
}

async function post(
  body: unknown,
  bindings: Bindings,
  cookie?: string,
  raw = false,
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  return app.request(
    ROUTE,
    { method: 'POST', headers, body: raw ? (body as string) : JSON.stringify(body) },
    bindings,
  );
}

function playlistTempDirs(): string[] {
  return readdirSync(env.ports.audio.scratchRoot()).filter((n) => n.startsWith(TMP_PREFIX));
}

async function userCookie(email: string): Promise<string> {
  return loginCookie(await seedUser({ email }));
}

async function counts(): Promise<{ sessions: number; segments: number }> {
  const s = await testDb().first<{ n: number }>('SELECT count(*)::int AS n FROM sessions');
  const a = await testDb().first<{ n: number }>(
    'SELECT count(*)::int AS n FROM session_audio_segments',
  );
  return { sessions: Number(s?.n ?? 0), segments: Number(a?.n ?? 0) };
}

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition not met');
}

const DEFAULT_TIMEOUT_MS = playlistListingLimits.timeoutMs;

afterEach(() => {
  playlistListingGuard.reset();
  playlistListingLimits.timeoutMs = DEFAULT_TIMEOUT_MS;
  while (scratchDirs.length) {
    const dir = scratchDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('playlist listing — refusals before any spawn', () => {
  it('401 signed out, with no spawn', async () => {
    const { binaryPath, markerPath } = freshBinary();
    const res = await anonApp.request(
      ROUTE,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: PLAYLIST_URL }),
      },
      configuredEnv(binaryPath),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ detail: 'Login required.' });
    expect(invocations(markerPath)).toBe(0);
  });

  it('503 with the import detail when no yt-dlp is resolved, for an approved and an unapproved user', async () => {
    const res = await post({ url: PLAYLIST_URL }, { ...env });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ detail: D.notConfigured });
    const unapproved = await post(
      { url: PLAYLIST_URL },
      { ...env },
      await userCookie(NOT_APPROVED_EMAIL),
    );
    expect(unapproved.status).toBe(503);
    expect(await unapproved.json()).toEqual({ detail: D.notConfigured });
  });

  it('403 for an unapproved user, before a malformed body 422, with no spawn', async () => {
    const { binaryPath, markerPath } = freshBinary();
    const cookie = await userCookie(NOT_APPROVED_EMAIL);
    for (const body of [{ url: PLAYLIST_URL }, {}]) {
      const res = await post(body, configuredEnv(binaryPath), cookie);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ detail: D.forbidden });
    }
    expect(invocations(markerPath)).toBe(0);
  });

  it('422 with zod issues for a body that is not JSON, {}, {url: 5} and a 2049-character url', async () => {
    const { binaryPath, markerPath } = freshBinary();
    const notJson = await post('{not json', configuredEnv(binaryPath), undefined, true);
    expect(notJson.status).toBe(422);
    const notJsonBody = (await notJson.json()) as { detail: Array<{ path: unknown[] }> };
    expect(Array.isArray(notJsonBody.detail)).toBe(true);
    expect(notJsonBody.detail).toHaveLength(1);
    expect(notJsonBody.detail[0]?.path).toEqual([]);
    for (const body of [
      {},
      { url: 5 },
      { url: `https://www.youtube.com/playlist?list=${'x'.repeat(2049)}` },
    ]) {
      const res = await post(body, configuredEnv(binaryPath));
      expect(res.status).toBe(422);
      const json = (await res.json()) as { detail: Array<{ path: unknown[] }> };
      expect(Array.isArray(json.detail)).toBe(true);
      expect(json.detail.map((i) => i.path)).toContainEqual(['url']);
    }
    expect(invocations(markerPath)).toBe(0);
  });

  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', D.notPlaylist],
    ['https://youtu.be/dQw4w9WgXcQ?list=PLx1', D.notPlaylist],
    ['https://www.youtube.com/@channel', D.notPlaylist],
    ['https://youtube.com.evil.com/playlist?list=PLx1', D.notPlaylist],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ', D.mix],
  ])('400 for %s, with no spawn', async (url, detail) => {
    const { binaryPath, markerPath } = freshBinary();
    const res = await post({ url }, configuredEnv(binaryPath));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail });
    expect(invocations(markerPath)).toBe(0);
  });
});

describe('playlist listing — busy 503 (two per process)', () => {
  it('a third valid request while two hang is refused busy with no third spawn; afterwards one succeeds', async () => {
    const hang = freshBinary({ mode: 'playlist-hang' });
    const first = post({ url: PLAYLIST_URL }, configuredEnv(hang.binaryPath));
    const second = post({ url: PLAYLIST_URL }, configuredEnv(hang.binaryPath));
    await waitFor(() => invocations(hang.markerPath) === 2);

    const third = freshBinary();
    const busy = await post({ url: PLAYLIST_URL }, configuredEnv(third.binaryPath));
    expect(busy.status).toBe(503);
    expect(await busy.json()).toEqual({ detail: D.busy });
    expect(invocations(third.markerPath)).toBe(0);

    // End the two hung listings: kill each child (its pid file is in its temp dir).
    await waitFor(
      () =>
        playlistTempDirs().filter((d) =>
          existsSync(join(env.ports.audio.scratchRoot(), d, 'child-pid.txt')),
        ).length === 2,
    );
    for (const d of playlistTempDirs()) {
      const pid = Number(
        readFileSync(join(env.ports.audio.scratchRoot(), d, 'child-pid.txt'), 'utf8'),
      );
      process.kill(pid, 'SIGKILL');
    }
    for (const res of await Promise.all([first, second])) {
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ detail: D.generic });
    }

    const ok = await post({ url: PLAYLIST_URL }, configuredEnv(third.binaryPath));
    expect(ok.status).toBe(200);
    await ok.json();
    expect(invocations(third.markerPath)).toBe(1);
    expect(playlistTempDirs()).toEqual([]);
  }, 20_000);
});

describe('playlist listing — 502 rows', () => {
  it.each([
    ['playlist-missing', 'https://www.youtube.com/playlist?list=WL', D.privateOrMissing],
    ['playlist-unviewable', PLAYLIST_URL, D.generic],
    ['playlist-flood', PLAYLIST_URL, D.generic],
    ['playlist-not-playlist', PLAYLIST_URL, D.generic],
    ['playlist-garbage', PLAYLIST_URL, D.generic],
    ['playlist-fail', PLAYLIST_URL, D.generic],
  ])(
    '%s → 502 with its fixed detail, temp dir removed',
    async (mode, url, detail) => {
      const { binaryPath, markerPath } = freshBinary({ mode });
      const res = await post({ url }, configuredEnv(binaryPath));
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ detail });
      expect(invocations(markerPath)).toBe(1);
      expect(playlistTempDirs()).toEqual([]);
    },
    20_000,
  );

  it('a hang past the time bound → 502 timed out, temp dir removed', async () => {
    playlistListingLimits.timeoutMs = 500;
    const { binaryPath } = freshBinary({ mode: 'playlist-hang' });
    const res = await post({ url: PLAYLIST_URL }, configuredEnv(binaryPath));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ detail: D.timedOut });
    expect(playlistTempDirs()).toEqual([]);
  }, 10_000);
});

describe('playlist listing — 200', () => {
  it('returns exactly playlist, entries and truncated, with the contract entry keys; no cookie, no writes', async () => {
    const { binaryPath, markerPath } = freshBinary();
    const before = await counts();
    const res = await post({ url: PLAYLIST_URL }, configuredEnv(binaryPath));
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    const body = (await res.json()) as {
      playlist: Record<string, unknown>;
      entries: Array<Record<string, unknown>>;
      truncated: boolean;
    };
    expect(Object.keys(body).sort()).toEqual(['entries', 'playlist', 'truncated']);
    expect(body.playlist).toEqual({
      id: 'PLBB231211A4F62143',
      title: 'Team Fortress 2 [2010 Version]',
      url: PLAYLIST_URL,
    });
    expect(body.truncated).toBe(false);
    expect(body.entries.map((e) => e.index)).toEqual([1, 2, 4, 5, 6, 7, 8]);
    for (const e of body.entries) {
      expect(Object.keys(e).sort()).toEqual(ENTRY_KEYS);
      expect(e.url).toBe(`https://www.youtube.com/watch?v=${e.video_id}`);
    }
    expect(body.entries.map((e) => e.reason)).toEqual([
      null,
      null,
      null,
      'unavailable',
      'live',
      'upcoming',
      'too_long',
    ]);
    expect(invocations(markerPath)).toBe(1);
    expect(await counts()).toEqual(before);
    expect(playlistTempDirs()).toEqual([]);
  });

  it('spawns with the canonical href: a watch link with a list lists the playlist', async () => {
    const { binaryPath } = freshBinary();
    // Keep the temp dir's argv log: snapshot it from the launcher before exec.
    const res = await post(
      { url: 'https://www.youtube.com/watch?v=RlJy2Kt8Be0&list=PLBB231211A4F62143&t=5' },
      configuredEnv(binaryPath),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { playlist: { id: string; url: string } };
    expect(body.playlist).toMatchObject({ id: 'PLBB231211A4F62143', url: PLAYLIST_URL });
  });

  it('passes the canonical href after `--` (argv recorded by the launcher)', async () => {
    const dir = scratchDir();
    const argvPath = join(dir, 'argv.txt');
    const binaryPath = join(dir, 'yt-dlp');
    writeFileSync(
      binaryPath,
      '#!/bin/sh\n' +
        `for a in "$@"; do echo "$a" >> "${argvPath}"; done\n` +
        `echo '{"mode":"playlist"}' > .ytdlp-stub.json\n` +
        `exec "${process.execPath}" "${FIXTURE_PATH}" "$@"\n`,
    );
    chmodSync(binaryPath, 0o755);
    const res = await post(
      { url: 'https://music.youtube.com/watch?v=RlJy2Kt8Be0&list=PLBB231211A4F62143' },
      configuredEnv(binaryPath),
    );
    expect(res.status).toBe(200);
    await res.json();
    const argv = readFileSync(argvPath, 'utf8').trim().split('\n');
    expect(argv.slice(-2)).toEqual(['--', PLAYLIST_URL]);
    expect(argv).toEqual(
      expect.arrayContaining(['--ignore-config', '--no-plugin-dirs', '--flat-playlist']),
    );
  });

  it('an empty playlist gives entries []', async () => {
    const { binaryPath } = freshBinary({ mode: 'playlist', fixture: 'playlist-empty.json' });
    const res = await post({ url: PLAYLIST_URL }, configuredEnv(binaryPath));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { entries: unknown[] }).entries).toEqual([]);
  });
});

// run-status-and-sweeper D9 as amended by youtube-playlist-import: the listing is the seventh
// run-feature route. There is no shared run-feature test; each route carries its own cases.
describe('playlist listing — approved users only', () => {
  const OWNER = 'test-owner@example.com';

  it('RUN_FEATURE_EMAILS unset: the bootstrap owner proceeds', async () => {
    const { binaryPath } = freshBinary();
    const cookie = await userCookie(OWNER);
    const res = await post(
      { url: PLAYLIST_URL },
      configuredEnv(binaryPath, { BOOTSTRAP_OWNER_EMAIL: OWNER, RUN_FEATURE_EMAILS: '' }),
      cookie,
    );
    expect(res.status).toBe(200);
    await res.json();
  });

  it('RUN_FEATURE_EMAILS "," admits the owner and refuses another member', async () => {
    const { binaryPath } = freshBinary();
    const bindings = configuredEnv(binaryPath, {
      BOOTSTRAP_OWNER_EMAIL: OWNER,
      RUN_FEATURE_EMAILS: ',',
    });
    const ok = await post({ url: PLAYLIST_URL }, bindings, await userCookie(OWNER));
    expect(ok.status).toBe(200);
    await ok.json();
    const refused = await post(
      { url: PLAYLIST_URL },
      bindings,
      await userCookie('seeded-user@example.com'),
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ detail: D.forbidden });
  });

  it('only another member listed: both the owner and that member proceed', async () => {
    const { binaryPath } = freshBinary();
    const bindings = configuredEnv(binaryPath, {
      BOOTSTRAP_OWNER_EMAIL: OWNER,
      RUN_FEATURE_EMAILS: 'approved.member@example.com',
    });
    for (const email of [OWNER, 'approved.member@example.com']) {
      const res = await post({ url: PLAYLIST_URL }, bindings, await userCookie(email));
      expect(res.status).toBe(200);
      await res.json();
    }
  });

  it('unconfigured: 503 for an unapproved user', async () => {
    const res = await post({ url: 5 }, { ...env }, await userCookie(NOT_APPROVED_EMAIL));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ detail: D.notConfigured });
  });
});
