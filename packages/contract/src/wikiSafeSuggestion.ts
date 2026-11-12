// The safe-suggestion rule of a batch accept (OpenSpec change `batch-autogenerate`, design D12;
// show-wiki "A batch job accepts suggestions as its initiator"; owner decision 8a). Pure, so the
// worker and its tests share one definition. A batch job in `accept` mode accepts a suggestion only
// when this returns true; everything else stays pending for a person.

/** The page as it is at the suggestion's base revision. */
export interface SafeSuggestionPage {
  title: string;
  aliases: readonly string[];
  body_md: string;
}

/** The suggestion: `page_id` null for a new page. */
export interface SafeSuggestionProposal {
  page_id: string | null;
  title: string;
  aliases: readonly string[];
  body_md: string;
}

const linesOf = (body: string): string[] => {
  const lf = body.replaceAll('\r\n', '\n');
  return lf === '' ? [] : lf.split('\n');
};

/** `old` is an in-order subsequence of `next`, comparing whole lines byte for byte. */
function isSubsequence(old: readonly string[], next: readonly string[]): boolean {
  let i = 0;
  for (const line of next) {
    if (i < old.length && line === old[i]) i += 1;
  }
  return i === old.length;
}

/** True when the suggestion is a new page, or rewrites `page` by additions only: the title equal
 * after trimming, every old alias still present (exact), and every old body line kept, unchanged
 * and in order (CRLF read as LF). A changed line, even one that only grew, is a removal. */
export function isSafeSuggestion(
  page: SafeSuggestionPage | null,
  suggestion: SafeSuggestionProposal,
): boolean {
  if (suggestion.page_id === null) return true;
  if (page === null) return false;
  if (suggestion.title.trim() !== page.title.trim()) return false;
  const aliases = new Set(suggestion.aliases);
  if (!page.aliases.every((a) => aliases.has(a))) return false;
  return isSubsequence(linesOf(page.body_md), linesOf(suggestion.body_md));
}
