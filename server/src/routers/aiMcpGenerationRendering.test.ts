// auto-generate-event-logs task 3.3 (design D5) — generation-density paged
// transcript rendering, PURE-FUNCTION tier.
//
// Spec anchors ("Generation-density transcript rendering"):
//   - a new anchored line at least at every speaker change AND whenever the
//     current line reaches a bounded word count (N);
//   - words without session-time anchors render without invented timestamps;
//   - bounded by RENDERED SIZE (topic-generate-paged-transcript D4): pages are
//     packed on line boundaries to a hard char cap that sits under the CLI's
//     stable 50,000-char always-accept threshold for MCP tool output, with the
//     word-count cap kept only as a SECONDARY bound. The cap is validated with
//     an ADVERSARIAL fixture (speaker change on every word ⇒ maximal anchored
//     lines per word), not merely a realistic one — rendered chars per word are
//     unbounded under diarization churn;
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
  GENERATION_PAGE_MAX_CHARS,
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
function renderAllPages(words: W[], pageSizeWords?: number, maxPageChars?: number): string[] {
  const first = renderGenerationTranscriptPage(words, 0, pageSizeWords, maxPageChars);
  if (!first.ok) throw new Error(first.error);
  const pages = [first.text];
  for (let p = 1; p < first.totalPages; p += 1) {
    const res = renderGenerationTranscriptPage(words, p, pageSizeWords, maxPageChars);
    if (!res.ok) throw new Error(res.error);
    pages.push(res.text);
  }
  return pages;
}

/** Render the whole transcript as ONE page (both caps lifted) — the reference
 * the paged renders must recompose to. */
function renderUnpaged(words: W[]): string {
  const res = renderGenerationTranscriptPage(words, 0, Number.MAX_SAFE_INTEGER, 100_000_000);
  if (!res.ok) throw new Error(res.error);
  if (res.totalPages !== 1) throw new Error(`expected 1 page, got ${res.totalPages}`);
  return res.text;
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

// ── topic-generate-paged-transcript task 1.1 (design D4) — the page bound is
// a RENDERED-SIZE cap, validated adversarially.
//
// The superseded task-3.3 test pinned ONE realistic fixture's page at 62,952
// bytes against an 80,000-byte "safety bound" and called it worst-case. It was
// not: rendered chars per word are set by diarization churn (a new anchored
// line — with its fixed-size `[time] speaker S: ` prefix — at every speaker
// change), so a crosstalk-heavy page is unbounded in size at any fixed word
// count. The durable assertion is therefore the INVARIANT (no page over the
// cap, marker included), exercised by a fixture that MAXIMIZES lines per word.

describe('page packing is bounded by rendered SIZE, not word count (D4)', () => {
  /** ADVERSARIAL fixture: the speaker changes on EVERY word, so every word
   * flushes its own anchored line — the maximum possible rendered chars per
   * word this renderer can produce (the `GENERATION_LINE_MAX_WORDS` flush can
   * only ever make lines LONGER per line-prefix). Every word carries a 12-char
   * `HH:MM:SS:FF` anchor, as DeepGram writes them. Deterministic: no RNG. */
  function buildAdversarialFixture(count: number): W[] {
    const words: W[] = [];
    for (let i = 0; i < count; i += 1) {
      const totalSec = i * 0.4;
      const pad = (n: number): string => String(n).padStart(2, '0');
      words.push({
        word: 'crosstalk',
        session_time: `${pad(Math.floor(totalSec / 3600))}:${pad(
          Math.floor((totalSec % 3600) / 60),
        )}:${pad(Math.floor(totalSec % 60))}:${pad(i % 24)}`,
        // Speaker flips on every word ⇒ one rendered line per word.
        speaker: String((i % 13) + 1),
      });
    }
    return words;
  }

  it('the adversarial fixture really is maximal: it renders ONE anchored line per word', () => {
    // Guards the guard — if a future edit made this fixture merely realistic,
    // the cap invariant below would stop testing the case it exists for.
    const words = buildAdversarialFixture(500);
    const lines = renderUnpaged(words).split('\n');
    expect(lines).toHaveLength(500);
    for (const line of lines) expect(line).toMatch(/^\[\d\d:\d\d:\d\d:\d\d\] speaker \d+: /);
  });

  it('no page exceeds the hard char cap under the adversarial fixture — the WORD cap alone would not page it at all', () => {
    // Exactly GENERATION_PAGE_SIZE_WORDS words: the secondary word cap permits
    // this whole transcript in ONE page. The char cap must still split it.
    const words = buildAdversarialFixture(GENERATION_PAGE_SIZE_WORDS);
    const pages = renderAllPages(words); // REAL constants, both caps
    expect(pages.length).toBeGreaterThan(1);
    for (const [i, page] of pages.entries()) {
      // THE INVARIANT: the cap covers the page as the model receives it —
      // body PLUS the trailing continuation-marker line on every non-final
      // page (the renderer reserves the marker's width out of the body cap).
      expect(page.length, `page ${i} rendered chars = ${page.length}`).toBeLessThanOrEqual(
        GENERATION_PAGE_MAX_CHARS,
      );
    }
    expect(pages[0]).toMatch(
      /\n--- transcript continues: call get_transcript_words with page=1 of \d+ ---$/,
    );
    expect(pages.at(-1)).not.toContain('transcript continues');
    // Nothing lost or reordered by the size-driven split…
    expect(pages.map(stripMarker).join('\n')).toBe(renderUnpaged(words));
    // …and identical input renders identical pages (deterministic boundaries).
    expect(renderAllPages(words)).toEqual(pages);
  });

  it('a single over-cap line is split hard at the cap, never emitted oversized', () => {
    // One pathological 100k-char "word" (transcript text is untrusted input:
    // the word CRUD routes impose no charset or word-shape restriction).
    const giant = 'x'.repeat(100_000);
    const pages = renderAllPages([w(giant, ts(1))]);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(page.length).toBeLessThanOrEqual(GENERATION_PAGE_MAX_CHARS);
    // Hard-split INSIDE one line ⇒ the chunks recompose with no separator, and
    // every character survives (split, never truncated).
    const recomposed = pages.map(stripMarker).join('');
    expect(recomposed).toBe(renderUnpaged([w(giant, ts(1))]));
    expect(recomposed).toContain(giant);
  });

  it('the secondary word cap still bounds a page of short lines', () => {
    // Single speaker, 1-char words (~3.2 rendered chars/word): the char cap is
    // nowhere near binding at 8000 words, so the retained word cap is what
    // pages this transcript — exactly two full pages.
    const words = Array.from({ length: 2 * GENERATION_PAGE_SIZE_WORDS }, (_, i) =>
      w('a', i % 1000 === 0 ? ts(i % 60) : ''),
    );
    const pages = renderAllPages(words);
    expect(pages).toHaveLength(2);
    for (const page of pages) expect(page.length).toBeLessThan(GENERATION_PAGE_MAX_CHARS);
  });
});

describe('measurement — realistic long-session fixture vs the CLI tool-output ceiling', () => {
  // Realistic fixture: ~27k words ≈ 3h at 150 wpm, three rotating speakers,
  // EVERY word anchored with a 12-char HH:MM:SS:FF session_time (DeepGram
  // anchors every word). Deterministic: no RNG. This is a PLAUSIBLE session,
  // not a bound — the bound lives in the adversarial suite above.
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

  it("this fixture's largest page fits the hard char cap, and the fixture pages by SIZE", () => {
    const words = buildLongFixture();
    const pages = renderAllPages(words); // REAL constants: both caps
    let maxChars = 0;
    let maxBytes = 0;
    for (const page of pages) {
      maxChars = Math.max(maxChars, page.length);
      maxBytes = Math.max(maxBytes, Buffer.byteLength(page, 'utf8'));
    }
    // Every page except the last states its continuation — never silent cut.
    for (const page of pages.slice(0, -1)) {
      expect(page).toMatch(
        /--- transcript continues: call get_transcript_words with page=\d+ of \d+ ---$/,
      );
    }
    expect(pages.at(-1)).not.toContain('transcript continues');
    // The char cap binds well before the word cap on realistic dictation: this
    // fixture needs MORE pages than 27k/8000 words alone would give.
    expect(pages.length).toBeGreaterThan(Math.ceil(27_000 / GENERATION_PAGE_SIZE_WORDS));
    // The assertion is the invariant, not a pinned byte count (the superseded
    // 62,952/80,000 pins described one fixture as "worst-case"; real production
    // data already measured above them).
    expect(maxChars, `this fixture's largest page = ${maxChars} chars`).toBeLessThanOrEqual(
      GENERATION_PAGE_MAX_CHARS,
    );
    // ASCII fixture ⇒ chars and bytes coincide; the cap itself is in CHARS
    // (the CLI's always-accept short-circuit estimates from string length).
    expect(maxBytes).toBe(maxChars);
    expect(pages.map(stripMarker).join('\n')).toBe(renderUnpaged(words));
  });
});
