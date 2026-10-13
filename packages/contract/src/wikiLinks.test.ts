// Show wiki citations and page links (show-wiki task 3.1, design D4; show-wiki spec "Citations
// and page links"). `parseWikiLinks` parses a page body with the same CommonMark parser
// react-markdown renders with, and reports every `cite:`/`wiki:` link and reference definition
// with its decoded URL, label and position, and whether it matches the exact grammar.

import { describe, expect, it } from 'vitest';
import { WIKI_MAX_LINKS, classifyWikiUrl, parseWikiLinks } from './wikiLinks';

const urls = (body: string) => parseWikiLinks(body).links.map((l) => l.url);
const one = (body: string) => {
  const { links } = parseWikiLinks(body);
  expect(links).toHaveLength(1);
  return links[0]!;
};

describe('parseWikiLinks', () => {
  it('finds cite: and wiki: links with their label and position', () => {
    const body = 'Intro.\n\nWe said [we start **Monday**](cite:S1@754) and see [Budget](wiki:page_1).';
    const { links, tooMany } = parseWikiLinks(body);
    expect(tooMany).toBe(false);
    expect(links).toEqual([
      {
        kind: 'cite',
        source: 'link',
        url: 'cite:S1@754',
        label: 'we start Monday',
        position: { line: 3, column: 9, offset: 16 },
        valid: true,
        sessionId: 'S1',
        seconds: 754,
      },
      {
        kind: 'wiki',
        source: 'link',
        url: 'wiki:page_1',
        label: 'Budget',
        position: { line: 3, column: 52, offset: 59 },
        valid: true,
        pageId: 'page_1',
      },
    ]);
  });

  it('takes decimal seconds with up to 3 places, and refuses 4', () => {
    expect(one('[q](cite:S1@0)')).toMatchObject({ valid: true, seconds: 0 });
    expect(one('[q](cite:S1@12.5)')).toMatchObject({ valid: true, seconds: 12.5 });
    expect(one('[q](cite:S1@12.25)')).toMatchObject({ valid: true, seconds: 12.25 });
    expect(one('[q](cite:S1@12.125)')).toMatchObject({ valid: true, seconds: 12.125 });
    const four = one('[q](cite:S1@12.1255)');
    expect(four.valid).toBe(false);
    expect(four.seconds).toBeUndefined();
  });

  it('reports malformed targets as invalid', () => {
    for (const url of [
      'cite:S1',
      'cite:S1@',
      'cite:@12',
      'cite:S1@-1',
      'cite:S1@1.',
      'cite:S1@.5',
      'cite:S1@1e3',
      'cite:S1@12@3',
      'cite:S%31@1',
      'cite:S.1@1',
      `cite:${'a'.repeat(65)}@1`,
      'cite:',
      'wiki:',
      'wiki:a/b',
      'wiki:a@b',
      `wiki:${'a'.repeat(65)}`,
    ]) {
      const link = one(`[q](<${url}>)`);
      expect(link.url, url).toBe(url);
      expect(link.valid, url).toBe(false);
      expect(link.sessionId, url).toBeUndefined();
      expect(link.pageId, url).toBeUndefined();
    }
    expect(one(`[q](cite:${'a'.repeat(64)}@1)`).valid).toBe(true);
    expect(one(`[q](wiki:${'A-z_9'.repeat(12)}abcd)`).valid).toBe(true);
  });

  describe('every CommonMark form, with its decoded URL', () => {
    it('reference definitions, labelled with their label', () => {
      const { links } = parseWikiLinks('See [x][r].\n\n[r]: cite:S1@1');
      expect(links).toEqual([
        expect.objectContaining({
          kind: 'cite',
          source: 'definition',
          url: 'cite:S1@1',
          label: 'r',
          position: { line: 3, column: 1, offset: 13 },
          valid: true,
          sessionId: 'S1',
          seconds: 1,
        }),
      ]);
    });

    it('unused reference definitions too', () => {
      expect(one('[Unused Ref]: wiki:zz')).toMatchObject({ source: 'definition', label: 'Unused Ref', pageId: 'zz' });
    });

    it('angle-bracket destinations', () => {
      expect(one('[a](<cite:S1@2>)')).toMatchObject({ url: 'cite:S1@2', valid: true });
    });

    it('autolinks, labelled with their text', () => {
      expect(one('<cite:S1@3>')).toMatchObject({ source: 'link', url: 'cite:S1@3', label: 'cite:S1@3', valid: true });
    });

    it('links with titles', () => {
      expect(one('[a](cite:S1@4 "a title")')).toMatchObject({ url: 'cite:S1@4', valid: true });
    });

    it('padded destinations', () => {
      expect(one('[a](   cite:S1@5   )')).toMatchObject({ url: 'cite:S1@5', valid: true });
    });

    it('backslash escapes', () => {
      expect(one('[a](cite\\:S1@6)')).toMatchObject({ kind: 'cite', url: 'cite:S1@6', valid: true });
    });

    it('entities', () => {
      expect(one('[a](cite&#58;S1@7)')).toMatchObject({ kind: 'cite', url: 'cite:S1@7', valid: true });
      expect(one('[a](wiki&colon;p)')).toMatchObject({ kind: 'wiki', url: 'wiki:p', valid: true });
    });

    it('upper- and mixed-case schemes, reported invalid', () => {
      expect(one('[a](CITE:S1@8)')).toMatchObject({ kind: 'cite', url: 'CITE:S1@8', valid: false });
      expect(one('<Wiki:p>')).toMatchObject({ kind: 'wiki', url: 'Wiki:p', valid: false });
    });
  });

  it('ignores links inside code spans and fenced or indented code', () => {
    const body = [
      'Inline `[a](cite:S1@1)` span.',
      '',
      '```',
      '[b](cite:S1@2)',
      '<wiki:p>',
      '```',
      '',
      '    [c](cite:S1@3)',
      '',
      'Real [d](cite:S1@4).',
    ].join('\n');
    expect(urls(body)).toEqual(['cite:S1@4']);
  });

  it('ignores other schemes', () => {
    expect(
      urls('[a](https://x.test) [b](mailto:a@b.test) [c](javascript:alert(1)) <https://y.test> [d](/rel)\n\n[r]: http://z.test'),
    ).toEqual([]);
  });

  it(`returns every link and flags more than ${WIKI_MAX_LINKS}`, () => {
    expect(WIKI_MAX_LINKS).toBe(500);
    const body = (n: number) => Array.from({ length: n }, (_, i) => `[q${i}](cite:S1@${i})`).join(' ');
    const atLimit = parseWikiLinks(body(500));
    expect(atLimit.links).toHaveLength(500);
    expect(atLimit.tooMany).toBe(false);
    const over = parseWikiLinks(`${body(500)}\n\n[r]: wiki:p`);
    expect(over.links).toHaveLength(501);
    expect(over.tooMany).toBe(true);
    // Other schemes don't count.
    expect(parseWikiLinks(`${body(500)} [x](https://x.test)`).tooMany).toBe(false);
  });

  it('finds nothing in an empty body', () => {
    expect(parseWikiLinks('')).toEqual({ links: [], tooMany: false });
  });
});

describe('classifyWikiUrl', () => {
  it('parses exact-grammar cite: and wiki: URLs', () => {
    expect(classifyWikiUrl('cite:S1@754')).toEqual({ kind: 'cite', sessionId: 'S1', seconds: 754 });
    expect(classifyWikiUrl('cite:a-B_9@1.125')).toEqual({ kind: 'cite', sessionId: 'a-B_9', seconds: 1.125 });
    expect(classifyWikiUrl('wiki:abc')).toEqual({ kind: 'wiki', pageId: 'abc' });
  });

  it('returns null for anything else', () => {
    for (const url of [
      'CITE:S1@1',
      'Wiki:abc',
      'cite:S1@1.1234',
      'cite:S1',
      'wiki:a b',
      ' wiki:abc',
      'wiki:abc ',
      'https://x.test',
      'javascript:alert(1)',
      '',
    ]) {
      expect(classifyWikiUrl(url), url).toBeNull();
    }
  });
});
