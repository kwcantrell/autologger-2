import { useEffect, useState } from 'react';
import {
  useUpdateWikiPage,
  useWikiRevision,
  useWikiRevisions,
  wikiVersionConflictOf,
} from '../../../../api/hooks/useWiki';
import type { WikiPage, WikiRevision } from '../../../../api/types';
import { Button } from '../../../../shared/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '../../../../shared/components/ui/sheet';
import { Spinner } from '../../../../shared/components/ui/spinner';
import { cn } from '../../../../shared/lib/utils';
import { showToast } from '../../utils/toast';
import { RevisionDiff } from './wikiDiff';

// --- A page's history (show-wiki D5, D7; show-wiki "Wiki screens", "Every change appends an
// immutable revision") ---
//
// Revisions newest first, "Load older" following `next_before`. Choosing one shows a line diff
// (`diff`'s `diffLines`, client only) from that revision to the current page: `−` lines are only
// in the revision, `+` lines only in the current page. Restoring is an edit: a compare-and-set
// `PUT` with the revision's title, kind, body and aliases and `restored_from`, which appends a new
// revision (nothing is rewritten).

interface Props {
  page: WikiPage;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function WikiHistorySheet({ page, open, onOpenChange }: Props) {
  const revisions = useWikiRevisions(open ? page.id : null);
  const [chosen, setChosen] = useState<number | null>(null);
  const isCurrent = chosen === page.revision;
  const revision = useWikiRevision(open && !isCurrent ? page.id : null, chosen);
  const update = useUpdateWikiPage();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setChosen(null);
      setError(null);
    }
  }, [open]);

  const rows = revisions.data?.pages.flatMap((p) => p.revisions) ?? [];

  const restoreChosen = (r: WikiRevision) => {
    setError(null);
    update.mutate(
      {
        pageId: page.id,
        body: {
          expected_revision: page.revision,
          title: r.title,
          kind: r.kind,
          body_md: r.body_md,
          aliases: r.aliases,
          restored_from: r.revision,
        },
      },
      {
        onSuccess: () => {
          showToast(`Restored r${r.revision}.`);
          onOpenChange(false);
        },
        onError: (e) =>
          setError(
            wikiVersionConflictOf(e)
              ? 'The page changed while you were looking. Check the diff again, then restore.'
              : e instanceof Error && e.message
                ? e.message
                : 'The revision was not restored.',
          ),
      },
    );
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-3 overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>History</SheetTitle>
          <SheetDescription>
            {page.title}, now at r{page.revision}. Choose a revision to compare it with the current
            page.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-4 px-4 pb-6">
          {revisions.isPending ? (
            <div role="status" className="flex items-center gap-2 text-sm text-si-muted">
              <Spinner role="presentation" aria-hidden="true" className="size-4" /> Loading history…
            </div>
          ) : revisions.isError ? (
            <div role="alert" className="flex items-center gap-2 text-sm text-si-fg">
              <span>{revisions.error?.message || 'History could not be loaded.'}</span>
              <Button variant="link" size="xs" onClick={() => void revisions.refetch()}>
                Try again
              </Button>
            </div>
          ) : (
            <ol className="m-0 flex list-none flex-col p-0">
              {rows.map((r) => (
                <li key={r.revision}>
                  <button
                    type="button"
                    data-revision={r.revision}
                    aria-pressed={chosen === r.revision}
                    onClick={() => setChosen(r.revision)}
                    className={cn(
                      'flex w-full min-w-0 items-baseline gap-2 rounded-ctl px-2 py-2 text-left text-sm outline-none transition-colors hover:bg-si-panel-2 focus-visible:ring-[3px] focus-visible:ring-ring/50',
                      chosen === r.revision && 'bg-si-panel-2',
                    )}
                  >
                    <span className="shrink-0 font-mono text-xs text-si-dim tabular-nums">
                      r{r.revision}
                    </span>{' '}
                    <span className="min-w-0 flex-1 truncate text-si-fg">{r.note}</span>{' '}
                    <span className="shrink-0 text-xs text-si-muted">{r.author_name}</span>{' '}
                    <time dateTime={r.at_utc} className="shrink-0 text-xs text-si-dim">
                      {formatWhen(r.at_utc)}
                    </time>
                  </button>
                </li>
              ))}
            </ol>
          )}
          {revisions.hasNextPage && (
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              disabled={revisions.isFetchingNextPage}
              onClick={() => void revisions.fetchNextPage()}
            >
              {revisions.isFetchingNextPage && <Spinner role="presentation" aria-hidden="true" />}
              Load older
            </Button>
          )}

          {chosen != null && (
            <section aria-label={`Revision r${chosen}`} className="flex flex-col gap-3">
              <h3 className="m-0 text-sm font-semibold text-si-fg">r{chosen} → current page</h3>
              {isCurrent ? (
                <p className="m-0 text-xs text-si-muted">This is the current revision.</p>
              ) : revision.isPending ? (
                <div role="status" className="flex items-center gap-2 text-sm text-si-muted">
                  <Spinner role="presentation" aria-hidden="true" className="size-4" /> Loading r
                  {chosen}…
                </div>
              ) : revision.isError || !revision.data ? (
                <p role="alert" className="m-0 text-sm text-si-fg">
                  {revision.error?.message || 'That revision could not be loaded.'}
                </p>
              ) : (
                <>
                  <RevisionDiff revision={revision.data} page={page} />
                  {!page.deleted && (
                    <Button
                      size="sm"
                      className="self-start"
                      disabled={update.isPending}
                      onClick={() => revision.data && restoreChosen(revision.data)}
                    >
                      Restore r{chosen}
                    </Button>
                  )}
                </>
              )}
              {error && (
                <p role="alert" className="m-0 text-sm text-v5-danger">
                  {error}
                </p>
              )}
            </section>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
