// Show wiki citations and page links (show-wiki design D4; show-wiki spec "Citations and page
// links"). Shared by the server (body checks on every write) and the web (react-markdown
// `urlTransform`), so it must stay browser-safe.
//
// A page body links to the transcript with `[quote](cite:<session_id>@<seconds>)` and to other
// pages with `[label](wiki:<page_id>)`. `parseWikiLinks` parses the body with
// `mdast-util-from-markdown` (the CommonMark parser react-markdown uses through remark-parse 11,
// no extensions), so the links it reports are exactly the links the page renders: inline links,
// reference definitions, angle-bracket destinations, autolinks, titles, padding, backslash escapes
// and entities are all decoded by the parser. Code spans and code blocks hold no link nodes, so
// links in code are skipped by construction. Images are not links (they render as alt text).
//
// A scheme is recognised case-insensitively, but only the exact lower-case grammar is valid:
//   cite:<[A-Za-z0-9_-]{1,64}>@<\d+(\.\d{1,3})?>
//   wiki:<[A-Za-z0-9_-]{1,64}>
// The parser does not percent-decode, so `cite:S%31@1` is reported as written (and invalid).

import { fromMarkdown } from 'mdast-util-from-markdown';

/** Most `cite:`/`wiki:` links a body may hold. `parseWikiLinks` returns them all and sets `tooMany`. */
export const WIKI_MAX_LINKS = 500;

export type WikiTarget =
  | { kind: 'cite'; sessionId: string; seconds: number }
  | { kind: 'wiki'; pageId: string };

export interface WikiLink {
  /** Scheme, matched case-insensitively. */
  kind: 'cite' | 'wiki';
  /** `link` covers inline, reference-resolved-by-definition and autolinks; `definition` is `[r]: url`. */
  source: 'link' | 'definition';
  /** The URL after the parser decoded escapes and entities. */
  url: string;
  /** Link text as plain text (the quote, for a citation); a definition's label. */
  label: string;
  /** Start of the node in the body (1-based line and column, 0-based offset). */
  position: { line: number; column: number; offset: number };
  /** Matches the exact lower-case grammar. */
  valid: boolean;
  /** Set when `valid` and `kind === 'cite'`. */
  sessionId?: string;
  seconds?: number;
  /** Set when `valid` and `kind === 'wiki'`. */
  pageId?: string;
}

export interface WikiLinksResult {
  /** Every `cite:`/`wiki:` link and definition, in document order. */
  links: WikiLink[];
  /** `links.length > WIKI_MAX_LINKS`. */
  tooMany: boolean;
}

const CITE_RE = /^cite:([A-Za-z0-9_-]{1,64})@(\d+(?:\.\d{1,3})?)$/;
const WIKI_RE = /^wiki:([A-Za-z0-9_-]{1,64})$/;
const SCHEME_RE = /^(cite|wiki):/i;

/** Parse a URL against the exact grammar; `null` for anything else (including upper-case schemes). */
export function classifyWikiUrl(url: string): WikiTarget | null {
  const cite = CITE_RE.exec(url);
  if (cite) return { kind: 'cite', sessionId: cite[1]!, seconds: Number(cite[2]) };
  const wiki = WIKI_RE.exec(url);
  if (wiki) return { kind: 'wiki', pageId: wiki[1]! };
  return null;
}

// Structural view of the mdast nodes we read, so no direct `@types/mdast` dependency is needed.
interface MdNode {
  type: string;
  url?: string;
  value?: string;
  alt?: string | null;
  label?: string | null;
  identifier?: string;
  children?: MdNode[];
  position?: { start: { line: number; column: number; offset?: number } };
}

function plainText(node: MdNode): string {
  if (typeof node.value === 'string') return node.value;
  if (node.type === 'image') return node.alt ?? '';
  return (node.children ?? []).map(plainText).join('');
}

/** Find every `cite:`/`wiki:` link and reference definition in a Markdown body. */
export function parseWikiLinks(body: string): WikiLinksResult {
  const links: WikiLink[] = [];
  const visit = (node: MdNode): void => {
    if ((node.type === 'link' || node.type === 'definition') && typeof node.url === 'string') {
      const scheme = SCHEME_RE.exec(node.url);
      if (scheme) {
        const target = classifyWikiUrl(node.url);
        const start = node.position?.start;
        const fields =
          target?.kind === 'cite'
            ? { sessionId: target.sessionId, seconds: target.seconds }
            : target?.kind === 'wiki'
              ? { pageId: target.pageId }
              : {};
        links.push({
          kind: scheme[1]!.toLowerCase() as 'cite' | 'wiki',
          source: node.type,
          url: node.url,
          label: node.type === 'definition' ? (node.label ?? node.identifier ?? '') : plainText(node),
          position: { line: start?.line ?? 0, column: start?.column ?? 0, offset: start?.offset ?? 0 },
          valid: target !== null,
          ...fields,
        });
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(fromMarkdown(body) as MdNode);
  return { links, tooMany: links.length > WIKI_MAX_LINKS };
}
