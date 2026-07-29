// auto-generate-event-logs task 3.3 (design D5) — generation-density paged
// transcript rendering, PURE-FUNCTION tier.
//
// Spec anchors ("Generation-density transcript rendering"):
//   - a new anchored line at least at every speaker change AND whenever the
//     current line reaches a bounded word count (N);
//   - words without session-time anchors render without invented timestamps;
//   - bounded + measured: a realistic long-session fixture is rendered here
//     and its worst-case page byte-size pinned against the CLI tool-output
//     ceiling (25k tokens ≈ 100KB ASCII; the child env whitelist deliberately
//     prevents operators from raising it);
//   - oversized transcripts page deterministically with an explicit
//     continuation marker — never silent truncation.
//
// The chat rendering is a DIFFERENT function (`formatTranscriptForModel`,
// untouched) — its byte-identity is pinned by the pre-existing
// `aiMcpServer.test.ts` suite ("get_transcript_words returns COMPACT readable
// text" describe block), which this task must leave green and unedited.

import { describe, expect, it } from 'vitest';
import {
  GENERATION_LINE_MAX_WORDS,
  GENERATION_PAGE_SIZE_WORDS,
  renderGenerationTranscriptPage,
} from './aiMcpServer';

type W = { word: string; session_time: string; speaker: string };

/** Word helper — empty session_time means "unanchored". */
const w = (word: string, session_time = '', speaker = 'S1'): W => ({
  word,
  session_time,
  speaker,
});

/** HH:MM:SS timestamp for second `i` (fixture times stay < 1 minute). */
const ts = (i: number): string => `00:00:${String(i).padStart(2, '0')}`;

/** Render every page (real constants unless overridden); fails on error. */
function renderAllPages(words: W[], pageSizeWords?: number): string[] {
  const first = renderGenerationTranscriptPage(words, 0, pageSizeWords);
  if (!first.ok) throw new Error(first.error);
  const pages = [first.text];
  for (let p = 1; p < first.totalPages; p += 1) {
    const res = renderGenerationTranscriptPage(words, p, pageSizeWords);
    if (!res.ok) throw new Error(res.error);
    pages.push(res.text);
  }
  return pages;
}

/** Strip the trailing continuation-marker line, if present. */
const stripMarker = (page: string): string =>
  page.replace(
    /\n--- transcript continues: call get_transcript_words with page=\d+ of \d+ ---$/,
    '',
  );

describe('generation-density lines (D5)', () => {
  const N = GENERATION_LINE_MAX_WORDS;

  it(`single-speaker transcript gets a new anchored line every ≤ ${N} words, not one anchor`, () => {
    // 2.5·N anchored words, ONE speaker — the chat rendering collapses this to
    // a single line/anchor (the panel blocker); generation density must not.
    const count = Math.floor(2.5 * N);
    const words = Array.from({ length: count }, (_, i) => w(`w${i}`, ts(i)));
    const res = renderGenerationTranscriptPage(words, 0);
    if (!res.ok) throw new Error(res.error);
    const chunks: string[] = [];
    for (let start = 0; start < count; start += N) {
      const slice = words.slice(start, start + N);
      chunks.push(`[${ts(start)}] speaker S1: ${slice.map((x) => x.word).join(' ')}`);
    }
    expect(res.text).toBe(chunks.join('\n'));
  });

  it('flushes the line on every speaker change, even below N words', () => {
    const words = [
      w('a1', ts(1), 'S1'),
      w('a2', '', 'S1'),
      w('b1', ts(3), 'S2'),
      w('a3', ts(4), 'S1'),
    ];
    const res = renderGenerationTranscriptPage(words, 0);
    if (!res.ok) throw new Error(res.error);
    expect(res.text).toBe(
      `[${ts(1)}] speaker S1: a1 a2\n[${ts(3)}] speaker S2: b1\n[${ts(4)}] speaker S1: a3`,
    );
  });

  it('a line whose words are all unanchored renders un-prefixed (no invented timestamp)', () => {
    // First N words anchored, next N words unanchored (same speaker): the
    // second line has no anchored word and must carry NO [timestamp].
    const anchored = Array.from({ length: N }, (_, i) => w(`a${i}`, ts(i)));
    const unanchored = Array.from({ length: N }, (_, i) => w(`u${i}`));
    const res = renderGenerationTranscriptPage([...anchored, ...unanchored], 0);
    if (!res.ok) throw new Error(res.error);
    const lines = res.text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0].startsWith(`[${ts(0)}] `)).toBe(true);
    expect(lines[1]).toBe(`speaker S1: ${unanchored.map((x) => x.word).join(' ')}`);
  });

  it('the line timestamp is the FIRST anchored word in that line, not an earlier or invented one', () => {
    // Line starts unanchored; the third word carries the first anchor.
    const words = [w('u1'), w('u2'), w('x', ts(7)), w('y', ts(9))];
    const res = renderGenerationTranscriptPage(words, 0);
    if (!res.ok) throw new Error(res.error);
    expect(res.text).toBe(`[${ts(7)}] speaker S1: u1 u2 x y`);
  });

  it('omits the speaker prefix when the speaker field is blank (matching the chat rendering)', () => {
    const res = renderGenerationTranscriptPage([w('alpha', ts(1), ''), w('beta', '', '')], 0);
    if (!res.ok) throw new Error(res.error);
    expect(res.text).toBe(`[${ts(1)}] alpha beta`);
  });

  it('renders the no-transcript placeholder as the single page of an empty transcript', () => {
    const res = renderGenerationTranscriptPage([], 0);
    if (!res.ok) throw new Error(res.error);
    expect(res.text).toBe('(this session has no transcript)');
    expect(res.totalPages).toBe(1);
  });
});

describe('deterministic paging with continuation markers (D5)', () => {
  const N = GENERATION_LINE_MAX_WORDS;

  it('emits the EXACT continuation marker on every page except the last (page=2 of 5 form)', () => {
    // 5·N anchored single-speaker words with a page size of N words ⇒ exactly
    // one N-word line per page ⇒ 5 pages.
    const words = Array.from({ length: 5 * N }, (_, i) => w(`w${i}`, ts(i % 60)));
    const pages = renderAllPages(words, N);
    expect(pages).toHaveLength(5);
    for (let p = 0; p < 4; p += 1) {
      expect(
        pages[p].endsWith(
          `\n--- transcript continues: call get_transcript_words with page=${p + 1} of 5 ---`,
        ),
      ).toBe(true);
    }
    // The marker names the NEXT page: page 1's marker says page=2 of 5 —
    // the spec's example form, byte-exact.
    expect(pages[1].split('\n').at(-1)).toBe(
      '--- transcript continues: call get_transcript_words with page=2 of 5 ---',
    );
    // The last page carries NO marker.
    expect(pages[4]).not.toContain('transcript continues');
  });

  it('splits on line boundaries and recomposes to the unpaged rendering (never silently truncated)', () => {
    // Mixed speakers + unanchored stretches; page size big enough for the
    // single-page render but paged small to force many pages.
    const words: W[] = [];
    for (let i = 0; i < 8 * N; i += 1) {
      const speaker = i % 23 === 0 ? 'S2' : 'S1';
      words.push(w(`w${i}`, i % 3 === 0 ? ts(i % 60) : '', speaker));
    }
    const single = renderGenerationTranscriptPage(words, 0, 100_000);
    if (!single.ok) throw new Error(single.error);
    expect(single.totalPages).toBe(1);

    const paged = renderAllPages(words, 2 * N);
    // Rejoining the marker-stripped pages reproduces the unpaged rendering
    // byte-for-byte: no line is split across pages, nothing is dropped.
    expect(paged.map(stripMarker).join('\n')).toBe(single.text);

    // Deterministic: an identical second render yields identical pages.
    expect(renderAllPages(words, 2 * N)).toEqual(paged);
  });

  it('no rendered line ever exceeds N words', () => {
    const words: W[] = [];
    for (let i = 0; i < 7 * N + 3; i += 1) {
      words.push(w(`w${i}`, i % 5 === 0 ? ts(i % 60) : '', i % 31 === 0 ? 'S2' : 'S1'));
    }
    const single = renderGenerationTranscriptPage(words, 0, 1_000_000);
    if (!single.ok) throw new Error(single.error);
    for (const line of single.text.split('\n')) {
      const body = line.replace(/^\[[^\]]+\] /, '').replace(/^speaker \S+: /, '');
      expect(body.split(' ').length).toBeLessThanOrEqual(N);
    }
  });

  it('out-of-range page is an ERROR naming the range, never empty text', () => {
    const words = Array.from({ length: 2 * N }, (_, i) => w(`w${i}`, ts(i % 60)));
    const twoPages = renderGenerationTranscriptPage(words, 0, N);
    if (!twoPages.ok) throw new Error(twoPages.error);
    expect(twoPages.totalPages).toBe(2);

    const past = renderGenerationTranscriptPage(words, 2, N);
    expect(past.ok).toBe(false);
    if (!past.ok) expect(past.error).toMatch(/page 2 .*2 page/i);

    const negative = renderGenerationTranscriptPage(words, -1, N);
    expect(negative.ok).toBe(false);
    const fractional = renderGenerationTranscriptPage(words, 0.5, N);
    expect(fractional.ok).toBe(false);

    // Even the empty transcript has exactly one page — page 1 is out of range.
    const emptyPast = renderGenerationTranscriptPage([], 1);
    expect(emptyPast.ok).toBe(false);
  });
});

describe('measurement — realistic long-session fixture vs the CLI tool-output ceiling (task 3.3)', () => {
  // Realistic fixture: ~27k words ≈ 3h at 150 wpm, three rotating speakers,
  // EVERY word anchored with a 12-char HH:MM:SS:FF session_time (worst case
  // for rendered bytes — DeepGram anchors every word). Deterministic: no RNG.
  function buildLongFixture(): W[] {
    const vocab = [
      'okay',
      'so',
      'we',
      'are',
      'rolling',
      'on',
      'the',
      'next',
      'setup',
      'and',
      'i',
      'need',
      'everybody',
      'back',
      'to',
      'first',
      'positions',
      'please',
      'quiet',
      'on',
      'set',
      'sound',
      'speed',
      'camera',
      'marker',
      'scene',
      'fourteen',
      'take',
      'three',
      'action',
      'that',
      'was',
      'great',
      'but',
      'lets',
      'go',
      'again',
      'with',
      'a',
      'little',
      'more',
      'energy',
      'watch',
      'your',
      'eyeline',
      'and',
      'hold',
      'the',
      'prop',
      'steady',
    ];
    const words: W[] = [];
    for (let i = 0; i < 27_000; i += 1) {
      const totalSec = i * 0.4; // 150 wpm
      const hh = Math.floor(totalSec / 3600);
      const mm = Math.floor((totalSec % 3600) / 60);
      const ss = Math.floor(totalSec % 60);
      const ff = i % 24;
      const pad = (n: number): string => String(n).padStart(2, '0');
      words.push({
        word: vocab[i % vocab.length],
        session_time: `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`,
        speaker: String((Math.floor(i / 150) % 3) + 1), // speaker turn ~every 150 words
      });
    }
    return words;
  }

  it(
    'worst-case fixture page measures 62952 bytes — under the 80000-byte bound ' +
      '(safety margin below the CLI 25k-token ≈ 100KB tool-output ceiling)',
    () => {
      const words = buildLongFixture();
      const pages = renderAllPages(words); // REAL constants: GENERATION_PAGE_SIZE_WORDS
      let maxBytes = 0;
      for (const page of pages) {
        maxBytes = Math.max(maxBytes, Buffer.byteLength(page, 'utf8'));
      }
      // Every page except the last states its continuation — never silent cut.
      for (const page of pages.slice(0, -1)) {
        expect(page).toMatch(
          /--- transcript continues: call get_transcript_words with page=\d+ of \d+ ---$/,
        );
      }
      expect(pages.at(-1)).not.toContain('transcript continues');
      // 27k words at PAGE_SIZE_WORDS=8000 ⇒ 4 pages.
      expect(pages).toHaveLength(Math.ceil(27_000 / GENERATION_PAGE_SIZE_WORDS));
      // THE MEASUREMENT (durable): the worst-case rendered page of this fixture.
      // Pinned exactly — the fixture and renderer are deterministic; re-measure
      // and re-pin if N / PAGE_SIZE_WORDS / the rendering ever change.
      expect(maxBytes, `measured worst-case page bytes = ${maxBytes}`).toBe(62952);
      expect(maxBytes).toBeLessThan(80_000);
    },
  );
});
