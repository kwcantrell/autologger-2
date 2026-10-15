// Show wiki citations and page links (show-wiki task 3.1, design D4; show-wiki spec "Citations
// and page links"). `parseWikiLinks` parses a page body with the same CommonMark parser
// react-markdown renders with, and reports every `cite:`/`wiki:` link and reference definition
// with its decoded URL, label and position, and whether it matches the exact grammar.

import { describe, expect, it } from 'vitest';
import { WIKI_MAX_LINKS, citationsOf, classifyWikiUrl, parseWikiLinks } from './wikiLinks';

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

// show-wiki-ai task 4.2 (design D4 step 4; wiki-generation "Proposals are checked when they are
// made"): every RENDERED citation, keyed by its rendered text, so the quote check sees what a
// reader sees, including reference-style citations whose text `parseWikiLinks` never reports.
describe('citationsOf', () => {
  const cites = (body: string) =>
    citationsOf(body).map(({ sessionId, seconds, text }) => ({ sessionId, seconds, text }));

  it('finds inline, angle-bracket and autolinked cite: links with their rendered text', () => {
    expect(
      cites(
        'A [we start **Monday**](cite:S1@754), B [two](<cite:S2@1.5>), C <cite:S3@9> and ' +
          '[a page](wiki:p1).',
      ),
    ).toEqual([
      { sessionId: 'S1', seconds: 754, text: 'we start Monday' },
      { sessionId: 'S2', seconds: 1.5, text: 'two' },
      { sessionId: 'S3', seconds: 9, text: 'cite:S3@9' },
    ]);
  });

  it('a reference-style citation is checked by its text, for full, collapsed and shortcut references', () => {
    const body =
      'He said [we never said that][r], then [the quote][] and [the quote].\n\n' +
      '[r]: cite:S1@120\n[the quote]: cite:S1@200';
    expect(cites(body)).toEqual([
      { sessionId: 'S1', seconds: 120, text: 'we never said that' },
      { sessionId: 'S1', seconds: 200, text: 'the quote' },
      { sessionId: 'S1', seconds: 200, text: 'the quote' },
    ]);
    // The definition's label alone is all parseWikiLinks reports for the first one.
    expect(parseWikiLinks(body).links.map((l) => l.label)).toEqual(['r', 'the quote']);
  });

  it('matches reference labels case-insensitively, as CommonMark does, and the first definition wins', () => {
    const body = 'See [Words][MiXeD] and [mixed].\n\n[mixed]: cite:S1@5\n[MIXED]: cite:S9@9';
    expect(cites(body)).toEqual([
      { sessionId: 'S1', seconds: 5, text: 'Words' },
      { sessionId: 'S1', seconds: 5, text: 'mixed' },
    ]);
  });

  it('an unused definition renders nothing and is no citation', () => {
    expect(cites('Plain text.\n\n[unused]: cite:S1@120')).toEqual([]);
  });

  it('references to non-cite: definitions, and other links, are ignored', () => {
    expect(
      cites(
        '[a][w], [b][h], [c](https://x.test), [d](wiki:p1)\n\n[w]: wiki:p2\n[h]: https://y.test',
      ),
    ).toEqual([]);
  });

  it('the rendered text of a label with emphasis, code and escapes', () => {
    expect(cites('[*we* `start` \\*Monday\\* &amp; go](cite:S1@1)')).toEqual([
      { sessionId: 'S1', seconds: 1, text: 'we start *Monday* & go' },
    ]);
    expect(cites('[**bold** _it_][r]\n\n[r]: cite:S1@2')).toEqual([
      { sessionId: 'S1', seconds: 2, text: 'bold it' },
    ]);
  });

  it('citations in code are not rendered, and malformed cite: URLs are not citations', () => {
    expect(
      cites('`[x](cite:S1@1)`\n\n    [y](cite:S1@2)\n\n[z](cite:S1@x) [u](CITE:S1@3)'),
    ).toEqual([]);
  });

  it("reports each citation's source and position, in document order", () => {
    const got = citationsOf('[a](cite:S1@1)\n\n[b][r]\n\n[r]: cite:S1@2');
    expect(got.map((c) => [c.source, c.position.line])).toEqual([
      ['link', 1],
      ['reference', 3],
    ]);
  });
});
