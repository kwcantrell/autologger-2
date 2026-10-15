// show-wiki task 5.3 — pinning test: `wikiUrl.ts` is the web's hand-mirrored copy of
// `classifyWikiUrl` from `packages/contract/src/wikiLinks.ts` (production web code may not import
// `packages/`, web-package-boundary in `webBoundaries.repo.test.ts`; the precedent is
// `aiV2/clientAggregates.pinning.test.ts`). This test-only import proves the two agree, so what
// the web makes clickable is exactly what the server's body check accepts.

import { describe, expect, it } from 'vitest';
import { classifyWikiUrl } from './wikiUrl';

const contract = await import('../../../../../../packages/contract/src/wikiLinks.ts');

const CASES = [
  'cite:S1@754',
  'cite:S1@0',
  'cite:S1@1.5',
  'cite:S1@1.25',
  'cite:S1@1.234',
  'cite:S1@1.2345',
  'cite:S1@1.',
  'cite:S1@.5',
  'cite:S1@-1',
  'cite:S1@1e3',
  'cite:S1',
  'cite:@1',
  'cite:S 1@1',
  'cite:S%31@1',
  'cite:a_b-C9@12',
  `cite:${'a'.repeat(64)}@1`,
  `cite:${'a'.repeat(65)}@1`,
  'CITE:S1@1',
  'Cite:S1@1',
  'cite:S1@1 ',
  ' cite:S1@1',
  'cite:S1@1\n',
  'wiki:P1',
  'wiki:a_b-C9',
  `wiki:${'p'.repeat(64)}`,
  `wiki:${'p'.repeat(65)}`,
  'wiki:',
  'wiki:a/b',
  'wiki:a b',
  'WIKI:P1',
  'wiki:P1\n',
  'https://example.com',
  'javascript:alert(1)',
  '',
];

describe('wikiUrl.classifyWikiUrl mirrors @autologger/contract', () => {
  it.each(CASES.map((c) => [JSON.stringify(c), c]))('%s', (_label, url) => {
    expect(classifyWikiUrl(url)).toEqual(contract.classifyWikiUrl(url));
  });
});
