import { useState } from 'react';
import {
  useMergeWikiPage,
  useWikiPages,
  wikiVersionConflictOf,
} from '../../../../api/hooks/useWiki';
import type { WikiPage, WikiPageListItem } from '../../../../api/types';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '../../../../shared/components/ui/command';
import { Spinner } from '../../../../shared/components/ui/spinner';
import { useConfirm } from '../../../../shared/ui/ConfirmDialog';
import { Dialog } from '../../../../shared/ui/Dialog';
import { navigate } from '../../navigation';
import { wikiPageHref } from './WikiMarkdown';
import { WIKI_KIND_LABEL } from './wikiKindLabels';

// --- "Merge into…" (show-wiki D7; show-wiki "Merge and split") ---
//
// Picks the target from the show's live pages (the default list holds no merged or deleted
// pages), leaving out this page and session pages, which can't merge. Confirms first, then
// merges with both pages' revisions; the merged page now redirects, so the target replaces it in
// history.

interface Props {
  page: WikiPage;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function WikiMergeDialog({ page, open, onOpenChange }: Props) {
  const list = useWikiPages(open ? page.show_id : null);
  const merge = useMergeWikiPage();
  const { confirm, confirmElement } = useConfirm();
  const [error, setError] = useState<string | null>(null);
  // The picker steps aside while its confirmation is open, so the two never stack.
  const [confirming, setConfirming] = useState(false);

  const targets = (list.data?.pages ?? []).filter((p) => p.id !== page.id && p.kind !== 'session');

  const choose = async (target: WikiPageListItem) => {
    setError(null);
    setConfirming(true);
    const ok = await confirm({
      title: `Merge into “${target.title}”?`,
      message: `“${page.title}” is added to the end of “${target.title}”, its title and aliases become aliases there, and it then redirects to “${target.title}”. History keeps both pages.`,
      confirmLabel: 'Merge',
    });
    setConfirming(false);
    if (!ok) return;
    merge.mutate(
      {
        pageId: page.id,
        body: {
          into_page_id: target.id,
          expected_revision: page.revision,
          into_expected_revision: target.revision,
        },
      },
      {
        onSuccess: ({ page: merged }) => {
          onOpenChange(false);
          navigate(wikiPageHref(merged.id), { replace: true });
        },
        onError: (e) =>
          setError(
            wikiVersionConflictOf(e)
              ? 'One of the pages changed since you opened this. Check them, then try again.'
              : e instanceof Error && e.message
                ? e.message
                : 'The pages were not merged.',
          ),
      },
    );
  };

  return (
    <>
      <Dialog
        open={open && !confirming}
        onOpenChange={onOpenChange}
        title="Merge into…"
        description={`Choose the page that takes in “${page.title}”.`}
      >
        <Command className="rounded-ctl border border-v5-border bg-transparent text-si-fg">
          <CommandInput
            placeholder="Filter pages…"
            aria-label="Filter pages"
            // The app's bare `input[type=text]` box would draw a second, taller field inside
            // the command row; the row is the field.
            className="h-9 rounded-none border-0 px-0 py-0 focus-visible:border-0"
          />
          <CommandList className="max-h-[min(50vh,22rem)]">
            {list.isPending ? (
              <div role="status" className="flex items-center gap-2 p-3 text-sm text-si-muted">
                <Spinner role="presentation" aria-hidden="true" className="size-4" /> Loading pages…
              </div>
            ) : list.isError ? (
              <p role="alert" className="m-0 p-3 text-sm text-si-fg">
                {list.error?.message || 'Pages could not be loaded.'}
              </p>
            ) : (
              <>
                <CommandEmpty>No other page to merge into.</CommandEmpty>
                {targets.map((t) => (
                  <CommandItem
                    key={t.id}
                    value={`${t.title} ${t.aliases.join(' ')} ${t.id}`}
                    disabled={merge.isPending}
                    onSelect={() => void choose(t)}
                    className="flex items-baseline gap-2"
                  >
                    <span className="min-w-0 flex-1 truncate">{t.title}</span>
                    <span className="shrink-0 text-xs text-si-dim">{WIKI_KIND_LABEL[t.kind]}</span>
                  </CommandItem>
                ))}
              </>
            )}
          </CommandList>
        </Command>
        {error && (
          <p role="alert" className="m-0 mt-3 text-sm text-v5-danger">
            {error}
          </p>
        )}
      </Dialog>
      {confirmElement}
    </>
  );
}
