import { cn } from '../../../../shared/lib/utils';

// --- Search snippet (catalog-search D8; catalog-search "Snippets are plain text with sentinel
// highlights") ---
//
// The server marks each hit with U+E000 … U+E001 (forged sentinels are stripped from the source
// first). Each highlighted run becomes a `<mark>` TEXT element; the snippet is never handed to
// the DOM as HTML, so markup in a transcript or note shows as the characters it is.

const OPEN = '';
const CLOSE = '';

export interface SnippetPart {
  text: string;
  hit: boolean;
}

/** Plain and highlighted runs, in order. An unclosed highlight runs to the end; a stray close
 * is dropped. Adjacent runs of the same kind are merged and empty runs left out. */
export function snippetParts(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let hit = false;
  let run = '';
  const flush = () => {
    if (!run) return;
    const last = parts[parts.length - 1];
    if (last && last.hit === hit) last.text += run;
    else parts.push({ text: run, hit });
    run = '';
  };
  for (const ch of snippet) {
    if (ch === OPEN || ch === CLOSE) {
      flush();
      hit = ch === OPEN;
    } else run += ch;
  }
  flush();
  return parts;
}

export function SearchSnippet({ text, className }: { text: string; className?: string }) {
  return (
    <span data-slot="search-snippet" className={cn('text-si-muted', className)}>
      {snippetParts(text).map((part, i) =>
        part.hit ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: runs have no identity beyond position
          <mark key={i} className="rounded-[2px] bg-si-accent/20 px-0.5 font-medium text-si-fg">
            {part.text}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: runs have no identity beyond position
          <span key={i}>{part.text}</span>
        ),
      )}
    </span>
  );
}
