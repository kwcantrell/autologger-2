import { diffLines } from 'diff';
import { useMemo } from 'react';
import type { WikiPage, WikiRevision } from '../../../../api/types';
import { cn } from '../../../../shared/lib/utils';

// The wiki's line diff (show-wiki D5; show-wiki-ai D6), shared by the history sheet and the
// suggestion review sheet. `diff`'s `diffLines`, client only: `−` lines are only in `from`, `+`
// lines only in `to`.

export type DiffKind = 'added' | 'removed' | 'same';

const DIFF_LINE: Record<DiffKind, string> = {
  added: 'bg-(--si-primary-tint) text-si-fg',
  removed: 'bg-(--si-danger-line) text-si-fg',
  same: 'text-si-muted',
};
const DIFF_MARK: Record<DiffKind, string> = { added: '+', removed: '−', same: ' ' };
const DIFF_SR: Record<DiffKind, string> = { added: 'Added: ', removed: 'Removed: ', same: '' };

/** The line diff from `from` to `to`, one entry per line. */
export function lineDiff(from: string, to: string): { kind: DiffKind; text: string }[] {
  // A last line without its newline still matches the same line followed by one.
  const ended = (s: string) => (s === '' || s.endsWith('\n') ? s : `${s}\n`);
  const out: { kind: DiffKind; text: string }[] = [];
  for (const part of diffLines(ended(from), ended(to))) {
    const kind: DiffKind = part.added ? 'added' : part.removed ? 'removed' : 'same';
    const lines = part.value.split('\n');
    if (lines.at(-1) === '') lines.pop();
    for (const text of lines) out.push({ kind, text });
  }
  return out;
}

export function RevisionDiff({ revision, page }: { revision: WikiRevision; page: WikiPage }) {
  const lines = useMemo(() => lineDiff(revision.body_md, page.body_md), [revision, page]);
  const changed = lines.some((l) => l.kind !== 'same');
  const aliasesBefore = revision.aliases.join(', ');
  const aliasesNow = page.aliases.join(', ');
  return (
    <div className="flex flex-col gap-2">
      {revision.title !== page.title && (
        <p className="m-0 text-xs text-si-muted">
          Title then: <span className="text-si-fg">{revision.title}</span>
        </p>
      )}
      {aliasesBefore !== aliasesNow && (
        <p className="m-0 text-xs text-si-muted">
          Aliases then: <span className="text-si-fg">{aliasesBefore || 'none'}</span>
        </p>
      )}
      {changed ? (
        <figure
          aria-label={`Changes from r${revision.revision} to the current page`}
          className="m-0 overflow-x-auto rounded-ctl border border-v5-border py-1 font-mono text-[0.78rem] leading-relaxed"
        >
          {lines.map((l, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: a diff line has no identity but its position
              key={i}
              data-diff={l.kind}
              className={cn(
                // Hanging indent: a wrapped line continues under its text, not under the mark.
                'pr-2 pl-[1.75rem] -indent-[1.25rem] whitespace-pre-wrap break-words',
                DIFF_LINE[l.kind],
              )}
            >
              <span
                aria-hidden="true"
                className="mr-2 inline-block w-3 indent-0 select-none text-si-dim"
              >
                {DIFF_MARK[l.kind]}
              </span>
              {l.kind !== 'same' && <span className="sr-only">{DIFF_SR[l.kind]}</span>}
              {l.text}
            </div>
          ))}
        </figure>
      ) : (
        <p className="m-0 text-xs text-si-muted">The text is the same as the current page.</p>
      )}
    </div>
  );
}
