// The web's copy of `classifyWikiUrl` from `packages/contract/src/wikiLinks.ts` (show-wiki D4, D5).
// Production web code may not import `packages/` (web-package-boundary,
// `webBoundaries.repo.test.ts`), so this is hand-mirrored like `aiV2/clientAggregates.ts`;
// `wikiUrl.pinning.test.ts` imports the contract's function and proves the two agree. Edit both
// together.
//
// Only the exact lower-case grammar is valid:
//   cite:<[A-Za-z0-9_-]{1,64}>@<\d+(\.\d{1,3})?>
//   wiki:<[A-Za-z0-9_-]{1,64}>

export type WikiTarget =
  | { kind: 'cite'; sessionId: string; seconds: number }
  | { kind: 'wiki'; pageId: string };

const CITE_RE = /^cite:([A-Za-z0-9_-]{1,64})@(\d+(?:\.\d{1,3})?)$/;
const WIKI_RE = /^wiki:([A-Za-z0-9_-]{1,64})$/;

/** Parse a URL against the exact grammar; `null` for anything else (including upper-case schemes). */
export function classifyWikiUrl(url: string): WikiTarget | null {
  const cite = CITE_RE.exec(url);
  if (cite?.[1] && cite[2]) return { kind: 'cite', sessionId: cite[1], seconds: Number(cite[2]) };
  const wiki = WIKI_RE.exec(url);
  if (wiki?.[1]) return { kind: 'wiki', pageId: wiki[1] };
  return null;
}

/** An `https:` URL (scheme matched case-insensitively, as the browser would). */
export function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}
