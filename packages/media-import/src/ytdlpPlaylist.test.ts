// youtube-playlist-import (design D3, task 2.2) — the bounded flat-playlist listing spawn,
// against the hermetic `fake-ytdlp.mjs` fixture (its `playlist*` control-file modes). The
// launcher pattern is the one `ytdlp.test.ts` documents: a `#!/bin/sh` file that execs the
// fixture through an absolute `node`, so the child's pinned PATH needs nothing on it.

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MEDIA_IMPORT_FIXTURES_DIR } from './fixturesDir';
import { YtDlpError } from './ytdlp';
import {
  listYoutubePlaylist,
  PLAYLIST_ERROR_DETAILS,
  PLAYLIST_FLAGS,
  PLAYLIST_MAX_ENTRIES,
} from './ytdlpPlaylist';

const FIXTURE_PATH = join(MEDIA_IMPORT_FIXTURES_DIR, 'fake-ytdlp.mjs');
const LIST_ID = 'PLBB231211A4F62143';
const HREF = `https://www.youtube.com/playlist?list=${LIST_ID}`;

const dirs: string[] = [];
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ytdlp-playlist-test-'));
  dirs.push(dir);
  return dir;
}
function makeBinary(dir: string): string {
  const binPath = join(dir, 'yt-dlp');
  writeFileSync(binPath, `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE_PATH}" "$@"\n`);
  chmodSync(binPath, 0o755);
  return binPath;
}
function stub(dir: string, control: Record<string, unknown>): void {
  writeFileSync(join(dir, '.ytdlp-stub.json'), JSON.stringify(control));
}
function argvLog(dir: string): string[][] {
  const path = join(dir, 'argv-log.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('PLAYLIST_FLAGS', () => {
  it('is the lockdown, flat-playlist mode, one JSON document and the 5000-entry end bound', () => {
    expect(PLAYLIST_FLAGS).toEqual([
      '--ignore-config',
      '--no-plugin-dirs',
      '--no-warnings',
      '--flat-playlist',
      '--dump-single-json',
      '--playlist-end',
      '5000',
    ]);
    expect(PLAYLIST_MAX_ENTRIES).toBe(5000);
  });
});

describe('listYoutubePlaylist — success', () => {
  it('spawns once with PLAYLIST_FLAGS, `--` and the canonical href, and returns the parsed playlist', async () => {
    const dir = makeDir();
    const binaryPath = makeBinary(dir);
    stub(dir, { mode: 'playlist' });

    const raw = await listYoutubePlaylist({
      listId: LIST_ID,
      href: HREF,
      tempDir: dir,
      binaryPath,
    });

    expect(argvLog(dir)).toEqual([[...PLAYLIST_FLAGS, '--', HREF]]);
    expect(raw).toMatchObject({ _type: 'playlist', id: LIST_ID });
    expect(Array.isArray((raw as { entries: unknown[] }).entries)).toBe(true);
  });

  it('gives the child a scrubbed env: no planted secret, PATH is the binary directory', async () => {
    const dir = makeDir();
    const binaryPath = makeBinary(dir);
    stub(dir, { mode: 'playlist' });

    await listYoutubePlaylist({
      listId: LIST_ID,
      href: HREF,
      tempDir: dir,
      binaryPath,
      procEnv: { HOME: '/home/op', PATH: '/usr/bin', PLANTED_SECRET_TOKEN: 'leak' },
    });

    const env = JSON.parse(readFileSync(join(dir, 'env-check-playlist.json'), 'utf8'));
    expect(env).toMatchObject({
      hasPlantedSecret: false,
      path: dir,
      hasIgnoreConfig: true,
      hasNoPluginDirs: true,
    });
  });

  it('lists an empty playlist', async () => {
    const dir = makeDir();
    const binaryPath = makeBinary(dir);
    stub(dir, { mode: 'playlist', fixture: 'playlist-empty.json' });

    const raw = await listYoutubePlaylist({
      listId: LIST_ID,
      href: HREF,
      tempDir: dir,
      binaryPath,
    });

    expect((raw as { entries: unknown[] }).entries).toEqual([]);
  });
});

describe('listYoutubePlaylist — failures', () => {
  const cases: Array<[string, string]> = [
    ['playlist-missing', PLAYLIST_ERROR_DETAILS.privateOrMissing],
    ['playlist-unviewable', PLAYLIST_ERROR_DETAILS.generic],
    ['playlist-not-playlist', PLAYLIST_ERROR_DETAILS.generic],
    ['playlist-garbage', PLAYLIST_ERROR_DETAILS.generic],
    ['playlist-fail', PLAYLIST_ERROR_DETAILS.generic],
  ];
  it.each(
    cases,
  )('%s raises YtDlpError with the fixed detail and no stderr text', async (mode, detail) => {
    const dir = makeDir();
    const binaryPath = makeBinary(dir);
    stub(dir, { mode });

    const err = await listYoutubePlaylist({
      listId: LIST_ID,
      href: HREF,
      tempDir: dir,
      binaryPath,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(YtDlpError);
    expect((err as Error).message).toBe(detail);
    expect((err as Error).message).not.toMatch(/ERROR|youtube:tab|unviewable/);
  });

  it('the fixed details are the contract strings', () => {
    expect(PLAYLIST_ERROR_DETAILS).toEqual({
      privateOrMissing:
        'This playlist is private or does not exist. Only public and unlisted playlists can be imported.',
      timedOut: 'Listing the playlist timed out.',
      generic: 'Failed to list the playlist.',
    });
  });

  it('a hang past timeoutMs is killed (group) and reported as timed out', async () => {
    const dir = makeDir();
    const binaryPath = makeBinary(dir);
    stub(dir, { mode: 'playlist-hang' });

    const started = Date.now();
    const err = await listYoutubePlaylist({
      listId: LIST_ID,
      href: HREF,
      tempDir: dir,
      binaryPath,
      timeoutMs: 500,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(YtDlpError);
    expect((err as Error).message).toBe(PLAYLIST_ERROR_DETAILS.timedOut);
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    const pid = Number(readFileSync(join(dir, 'child-pid.txt'), 'utf8'));
    expect(isAlive(pid)).toBe(false);
  }, 10_000);

  it('output past the 16 MiB default is killed (group) and reported as the generic failure', async () => {
    const dir = makeDir();
    const binaryPath = makeBinary(dir);
    stub(dir, { mode: 'playlist-flood' });

    const err = await listYoutubePlaylist({
      listId: LIST_ID,
      href: HREF,
      tempDir: dir,
      binaryPath,
      timeoutMs: 20_000,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(YtDlpError);
    expect((err as Error).message).toBe(PLAYLIST_ERROR_DETAILS.generic);
    const pid = Number(readFileSync(join(dir, 'child-pid.txt'), 'utf8'));
    expect(isAlive(pid)).toBe(false);
  }, 25_000);
});
