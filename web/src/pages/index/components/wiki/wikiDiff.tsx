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
export interface DiffLine {
  kind: DiffKind;
  text: string;
}

export function lineDiff(from: string, to: string): DiffLine[] {
  // A last line without its newline still matches the same line followed by one.
  const ended = (s: string) => (s === '' || s.endsWith('\n') ? s : `${s}\n`);
  const out: DiffLine[] = [];
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
        <DiffFigure
          lines={lines}
          label={`Changes from r${revision.revision} to the current page`}
        />
      ) : (
        <p className="m-0 text-xs text-si-muted">The text is the same as the current page.</p>
      )}
    </div>
  );
}

/** The line-by-line diff figure: `−` lines only in the old text, `+` lines only in the new. */
export function DiffFigure({ lines, label }: { lines: DiffLine[]; label: string }) {
  return (
    <figure
      aria-label={label}
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
  );
}

/** A page's title, aliases and body: what a suggestion proposes, or the page it would change. */
export interface WikiTexts {
  title: string;
  aliases: string[];
  body: string;
}

/**
 * The diff a suggestion review shows (show-wiki-ai D6): from the page's current revision (`base`)
 * to the proposal. A new page (`base` null) diffs against empty, so every line is added.
 */
export function ProposalDiff({
  base,
  proposed,
  baseRevision,
}: {
  base: WikiTexts | null;
  proposed: WikiTexts;
  /** The revision `base` is, for the figure's label. */
  baseRevision?: number;
}) {
  const lines = useMemo(() => lineDiff(base?.body ?? '', proposed.body), [base, proposed]);
  const changed = lines.some((l) => l.kind !== 'same');
  const aliasesNow = base?.aliases.join(', ') ?? '';
  const aliasesSuggested = proposed.aliases.join(', ');
  return (
    <div className="flex flex-col gap-2">
      {base && base.title !== proposed.title && (
        <p className="m-0 text-xs text-si-muted">
          Title now: <span className="text-si-fg">{base.title}</span>
        </p>
      )}
      {base
        ? aliasesNow !== aliasesSuggested && (
            <p className="m-0 text-xs text-si-muted">
              Aliases now: <span className="text-si-fg">{aliasesNow || 'none'}</span> · suggested:{' '}
              <span className="text-si-fg">{aliasesSuggested || 'none'}</span>
            </p>
          )
        : proposed.aliases.length > 0 && (
            <p className="m-0 text-xs text-si-muted">
              Aliases: <span className="text-si-fg">{aliasesSuggested}</span>
            </p>
          )}
      {changed ? (
        <DiffFigure
          lines={lines}
          label={
            !base
              ? 'The suggested page'
              : baseRevision
                ? `Changes from r${baseRevision} to the suggestion`
                : 'Changes to the suggestion'
          }
        />
      ) : (
        <p className="m-0 text-xs text-si-muted">The text is the same as the current page.</p>
      )}
    </div>
  );
}
