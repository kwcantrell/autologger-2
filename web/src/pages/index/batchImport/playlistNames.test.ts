import { describe, expect, it } from 'vitest';
import type { YoutubePlaylistEntry } from '../../../api/types';
import { playlistSessionNames } from './playlistNames';

// youtube-playlist-import task 8.1 (batch-audio-import "YouTube playlist session naming", design
// D6): one name per titled entry, used as both `episode` and `title`.

function entry(index: number, title: string | null, videoId?: string): YoutubePlaylistEntry {
  const video_id = videoId ?? `vid${String(index).padStart(8, '0')}`;
  return {
    index,
    video_id,
    url: `https://www.youtube.com/watch?v=${video_id}`,
    title,
    duration_s: 60,
    importable: title !== null,
    reason: title === null ? 'unavailable' : null,
  };
}

/** The create schema's `episode` rule, `z.string().max(80)`: zod counts UTF-16 code units. */
function passesEpisodeRule(name: string): boolean {
  return name.length <= 80;
}

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const one = (title: string, id = 'aaaaaaaaaaa') =>
  playlistSessionNames([entry(1, title, id)]).get(1);

describe('playlistSessionNames', () => {
  it('cleans control characters and spacing', () => {
    expect(one('  Episode 12:\n  The\tReturn  ')).toBe('Episode 12: The Return');
    expect(one('a\u0000b\u0085c\u2028d\u2029e')).toBe('a b c d e');
  });

  it('normalizes to NFC', () => {
    expect(one('Café')).toBe('Café');
  });

  it('cuts 120 ASCII characters to the first 80, trailing spaces trimmed', () => {
    const title = `${'x'.repeat(79)} ${'y'.repeat(40)}`;
    expect(one('a'.repeat(120))).toBe('a'.repeat(80));
    expect(one(title)).toBe('x'.repeat(79));
  });

  it('cuts 80 emoji to 40 (80 UTF-16 units) with no lone surrogate', () => {
    const name = one('😀'.repeat(80)) ?? '';
    expect(name).toBe('😀'.repeat(40));
    expect(name.length).toBe(80);
    expect(hasLoneSurrogate(name)).toBe(false);
  });

  it('drops a pair that would straddle the limit: the 80th unit a high surrogate → 79 units', () => {
    const name = one(`${'a'.repeat(79)}😀tail`) ?? '';
    expect(name).toBe('a'.repeat(79));
    expect(name.length).toBe(79);
  });

  it('an all-whitespace title is named YouTube <video_id>', () => {
    expect(one(' \n\t ', 'dQw4w9WgXcQ')).toBe('YouTube dQw4w9WgXcQ');
  });

  it('untitled entries get no name', () => {
    const names = playlistSessionNames([entry(1, null), entry(2, 'Two')]);
    expect(names.has(1)).toBe(false);
    expect(names.get(2)).toBe('Two');
  });

  it('a unique title keeps no suffix', () => {
    const names = playlistSessionNames([entry(1, 'One'), entry(2, 'Two')]);
    expect([names.get(1), names.get(2)]).toEqual(['One', 'Two']);
  });

  it('duplicate titles at positions 2, 5 and 9 each carry their video id', () => {
    const entries = [
      entry(1, 'Intro'),
      entry(2, 'Q&A', 'aaaaaaaaaaa'),
      entry(5, 'Q&A', 'bbbbbbbbbbb'),
      entry(9, 'Q&A', 'ccccccccccc'),
    ];
    const names = playlistSessionNames(entries);
    expect([names.get(2), names.get(5), names.get(9)]).toEqual([
      'Q&A [aaaaaaaaaaa]',
      'Q&A [bbbbbbbbbbb]',
      'Q&A [ccccccccccc]',
    ]);
    expect(names.get(1)).toBe('Intro');
  });

  it('titles that become equal after cleaning count as shared', () => {
    const names = playlistSessionNames([
      entry(1, 'Q&A', 'aaaaaaaaaaa'),
      entry(2, ' Q&A\n', 'bbbbbbbbbbb'),
    ]);
    expect([names.get(1), names.get(2)]).toEqual(['Q&A [aaaaaaaaaaa]', 'Q&A [bbbbbbbbbbb]']);
  });

  it('a shared long plain name cuts the base to 66 units, total ≤ 80, no split pair', () => {
    const ascii = 'z'.repeat(100);
    const emoji = `${'b'.repeat(65)}😀${'c'.repeat(40)}`;
    const names = playlistSessionNames([
      entry(1, ascii, 'aaaaaaaaaaa'),
      entry(2, ascii, 'bbbbbbbbbbb'),
      entry(3, emoji, 'ccccccccccc'),
      entry(4, emoji, 'ddddddddddd'),
    ]);
    expect(names.get(1)).toBe(`${'z'.repeat(66)} [aaaaaaaaaaa]`);
    expect(names.get(1)?.length).toBe(80);
    expect(names.get(3)).toBe(`${'b'.repeat(65)} [ccccccccccc]`);
    for (const name of names.values()) {
      expect(passesEpisodeRule(name)).toBe(true);
      expect(hasLoneSurrogate(name)).toBe(false);
    }
  });

  it('names do not depend on the selection or on the listing order', () => {
    const entries = [
      entry(1, 'Q&A', 'aaaaaaaaaaa'),
      entry(2, 'Solo', 'bbbbbbbbbbb'),
      entry(3, 'Q&A', 'ccccccccccc'),
      entry(4, null, 'ddddddddddd'),
    ];
    const forward = playlistSessionNames(entries);
    const reversed = playlistSessionNames([...entries].reverse());
    expect([...reversed.entries()].sort()).toEqual([...forward.entries()].sort());
    // The name depends on the whole listing, never on which entries are checked: the function
    // takes no selection, and an unchecked entry still shares its title.
    expect(forward.get(1)).toBe('Q&A [aaaaaaaaaaa]');
  });

  it('every produced name passes the create schema episode rule', () => {
    const titles = [
      '😀'.repeat(200),
      'é'.repeat(300),
      '\u0000'.repeat(10),
      'x',
      'x',
      '🎉 '.repeat(50),
    ];
    const names = playlistSessionNames(titles.map((t, i) => entry(i + 1, t)));
    expect(names.size).toBe(titles.length);
    for (const name of names.values()) {
      expect(passesEpisodeRule(name)).toBe(true);
      expect(hasLoneSurrogate(name)).toBe(false);
      expect(name).toBe(name.trim());
      expect(name.length).toBeGreaterThan(0);
    }
  });
});
