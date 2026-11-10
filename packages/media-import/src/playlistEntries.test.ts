// youtube-playlist-import (design D4, task 3.1) — projecting yt-dlp's flat-playlist JSON to
// the contract's entry shape, over the recorded fixtures (trimmed from real yt-dlp output,
// design A2/A8) plus synthetic edge cases.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MEDIA_IMPORT_FIXTURES_DIR } from './fixturesDir';
import { projectPlaylist } from './playlistEntries';

const LIST_ID = 'PLBB231211A4F62143';

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(MEDIA_IMPORT_FIXTURES_DIR, name), 'utf8'));
}

/** A one-entry playlist with the given entry fields over a valid id. */
function one(entry: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return projectPlaylist(
    {
      _type: 'playlist',
      id: LIST_ID,
      title: 'T',
      entries: [{ id: 'RlJy2Kt8Be0', title: 'A', duration: 60, ...entry }],
      ...extra,
    },
    LIST_ID,
  );
}

describe('projectPlaylist — recorded fixture', () => {
  const out = projectPlaylist(fixture('playlist-basic.json'), LIST_ID);

  it('keeps the playlist id, canonical url and title', () => {
    expect(out.playlist).toEqual({
      id: LIST_ID,
      title: 'Team Fortress 2 [2010 Version]',
      url: `https://www.youtube.com/playlist?list=${LIST_ID}`,
    });
    expect(out.truncated).toBe(false);
  });

  it('positions are 1-based and keep a gap where the malformed id was dropped', () => {
    expect(out.entries.map((e) => e.index)).toEqual([1, 2, 4, 5, 6, 7, 8]);
    expect(out.entries.find((e) => e.index === 3)).toBeUndefined();
  });

  it('entry url is the plain watch url and keys are exactly the contract seven', () => {
    for (const e of out.entries) {
      expect(e.url).toBe(`https://www.youtube.com/watch?v=${e.video_id}`);
      expect(Object.keys(e).sort()).toEqual(
        ['duration_s', 'importable', 'index', 'reason', 'title', 'url', 'video_id'].sort(),
      );
    }
  });

  it('classifies each entry', () => {
    expect(out.entries.map((e) => [e.index, e.reason, e.importable])).toEqual([
      [1, null, true],
      [2, null, true],
      [4, null, true],
      [5, 'unavailable', false],
      [6, 'live', false],
      [7, 'upcoming', false],
      [8, 'too_long', false],
    ]);
    expect(out.entries[0]).toMatchObject({ video_id: 'RlJy2Kt8Be0', duration_s: 629 });
    expect(out.entries[3]).toMatchObject({
      video_id: 'me4As6zyJk4',
      title: null,
      duration_s: null,
    });
  });

  it('an empty playlist gives no entries', () => {
    const empty = projectPlaylist(
      fixture('playlist-empty.json'),
      'PL4lCao7KL_QFVb7Iudeipvc2BCavECqzc',
    );
    expect(empty.entries).toEqual([]);
    expect(empty.truncated).toBe(false);
  });
});

describe('projectPlaylist — titles', () => {
  it('strips C0 and C1 control characters', () => {
    expect(one({ title: 'a\u0000b\nc\u0085d\u007fe' }).entries[0]?.title).toBe('abcde');
  });

  it('cuts a 600-character title to 500', () => {
    expect(one({ title: 'x'.repeat(600) }).entries[0]?.title).toBe('x'.repeat(500));
  });

  it('a missing playlist title is ""', () => {
    expect(one({}, { title: undefined }).playlist.title).toBe('');
    expect(one({}, { title: null }).playlist.title).toBe('');
  });
});

describe('projectPlaylist — reasons', () => {
  it.each([
    [{ title: null }, 'unavailable'],
    [{ title: '[Deleted video]', duration: null }, 'unavailable'],
    [{ title: '[Private video]', duration: null }, 'unavailable'],
    [{ title: '[MV] Song', duration: 200 }, null],
    [{ live_status: 'is_live', duration: null }, 'live'],
    [{ live_status: 'is_upcoming', duration: null }, 'upcoming'],
    [{ live_status: 'was_live', duration: 3000 }, null],
    [{ duration: 16606 }, 'too_long'],
    [{ duration: 14400 }, 'too_long'],
    [{ duration: 14399 }, null],
    [{ title: null, live_status: 'is_live' }, 'unavailable'],
  ])('%j → %s', (entry, reason) => {
    const e = one(entry).entries[0];
    expect(e?.reason).toBe(reason);
    expect(e?.importable).toBe(reason === null);
  });

  it('duration_s is a finite non-negative number or null', () => {
    expect(one({ duration: 12.5 }).entries[0]?.duration_s).toBe(12.5);
    expect(one({ duration: -1 }).entries[0]?.duration_s).toBeNull();
    expect(one({ duration: '60' }).entries[0]?.duration_s).toBeNull();
    expect(one({ duration: undefined }).entries[0]?.duration_s).toBeNull();
  });
});

describe('projectPlaylist — truncation', () => {
  const entries = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `v${String(i).padStart(10, '0')}`,
      title: `t${i}`,
      duration: 1,
    }));

  it('is true only for 5000 entries with a larger playlist_count', () => {
    const big = projectPlaylist(
      { _type: 'playlist', id: LIST_ID, entries: entries(5000), playlist_count: 7000 },
      LIST_ID,
    );
    expect(big.truncated).toBe(true);
    expect(big.entries).toHaveLength(5000);
    expect(
      projectPlaylist(
        { _type: 'playlist', id: LIST_ID, entries: entries(5000), playlist_count: 5000 },
        LIST_ID,
      ).truncated,
    ).toBe(false);
    expect(
      projectPlaylist(
        { _type: 'playlist', id: LIST_ID, entries: entries(29), playlist_count: 31 },
        LIST_ID,
      ).truncated,
    ).toBe(false);
  });

  it('never returns more than 5000 entries', () => {
    expect(
      projectPlaylist(
        { _type: 'playlist', id: LIST_ID, entries: entries(5001), playlist_count: 7000 },
        LIST_ID,
      ).entries,
    ).toHaveLength(5000);
  });
});
