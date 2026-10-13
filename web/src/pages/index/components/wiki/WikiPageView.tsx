import {
  ArrowLeftIcon,
  GitMergeIcon,
  HistoryIcon,
  PencilIcon,
  ScissorsIcon,
  Trash2Icon,
} from 'lucide-react';
import { type MouseEvent, type ReactNode, useEffect, useState } from 'react';
import { ApiError } from '../../../../api/client';
import { useProfile } from '../../../../api/hooks/useProfile';
import {
  useDeleteWikiPage,
  useRestoreWikiPage,
  useUpdateWikiPage,
  useWikiPage,
  wikiVersionConflictOf,
} from '../../../../api/hooks/useWiki';
import type { WikiPage } from '../../../../api/types';
import { Alert, AlertDescription, AlertTitle } from '../../../../shared/components/ui/alert';
import { Badge } from '../../../../shared/components/ui/badge';
import { Button } from '../../../../shared/components/ui/button';
import { Spinner } from '../../../../shared/components/ui/spinner';
import { useConfirm } from '../../../../shared/ui/ConfirmDialog';
import { useSwitchActive } from '../../hooks/useSwitchActive';
import { navigate } from '../../navigation';
import { showToast } from '../../utils/toast';
import { type WikiDraft, WikiEditor } from './WikiEditor';
import { WikiHistorySheet } from './WikiHistorySheet';
import { WikiMarkdown, wikiPageHref } from './WikiMarkdown';
import { WikiMergeDialog } from './WikiMergeDialog';
import { WikiSplitDialog } from './WikiSplitDialog';
import { WIKI_KIND_LABEL } from './wikiKindLabels';

// --- `/wiki/:pageId`, one wiki page (show-wiki D7; show-wiki "Wiki screens") ---
//
// Reading: the rendered body, the aliases, and who changed the page last and when.
// Editing: the draft lives here, based on the revision the edit started from; Save sends a
// compare-and-set `PUT` with that `expected_revision`. A `409 Version conflict.` keeps the draft
// and shows a banner naming who saved; "Load the newer page" replaces the draft with the
// current page and rebases on its revision.
// A merged page replaces its URL with the page it was merged into. A page of a show other than
// the active one says so and offers the switch (`useSwitchActive`, as search results do).
// Delete confirms first (`useConfirm`); a deleted page reads as deleted and offers Restore.

interface Props {
  pageId: string;
  /** AppShell's close-session path, for a switch that changes the studio. On `/wiki` no session
   *  is open, so the default does nothing. */
  onCloseSession?: () => void;
  /** The open Settings view's discard guard, if any. */
  confirmSwitch?: () => true | Promise<boolean>;
}

interface EditState {
  /** The revision the draft is based on (`expected_revision`). */
  base: number;
  draft: WikiDraft;
  /** The newer page a save collided with. */
  conflict: WikiPage | null;
  error: string | null;
}

const noop = () => {};

function draftOf(page: WikiPage): WikiDraft {
  return { title: page.title, body: page.body_md, aliases: page.aliases };
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

function inAppClick(href: string) {
  return (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
  };
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div
      data-slot="wiki-page"
      className="mx-auto flex w-full max-w-[52rem] flex-col gap-5 px-4 py-6 max-md:px-3"
    >
      <Button asChild variant="link" size="xs" className="self-start px-0 text-si-dim">
        <a href="/wiki" onClick={inAppClick('/wiki')}>
          <ArrowLeftIcon aria-hidden="true" /> Wiki
        </a>
      </Button>
      {children}
    </div>
  );
}

export function WikiPageView({ pageId, onCloseSession = noop, confirmSwitch }: Props) {
  const { data: page, isPending, isError, error, refetch } = useWikiPage(pageId);
  const { data: profile } = useProfile();
  const { switchActive, isPending: switching } = useSwitchActive({
    onCloseSession,
    confirmSwitch,
  });
  const update = useUpdateWikiPage();
  const del = useDeleteWikiPage();
  const restore = useRestoreWikiPage();
  const { confirm, confirmElement } = useConfirm();
  const [edit, setEdit] = useState<EditState | null>(null);
  const [panel, setPanel] = useState<'history' | 'merge' | 'split' | null>(null);

  const mergedInto = page?.merged_into ?? null;
  useEffect(() => {
    if (mergedInto) navigate(wikiPageHref(mergedInto), { replace: true });
  }, [mergedInto]);

  // A different page id (a wiki link, a redirect) starts clean.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on page change only
  useEffect(() => {
    setEdit(null);
    setPanel(null);
  }, [pageId]);

  if (isPending) {
    return (
      <Frame>
        <div role="status" className="flex items-center gap-2 py-10 text-sm text-si-muted">
          <Spinner role="presentation" aria-hidden="true" className="size-4" /> Loading page…
        </div>
      </Frame>
    );
  }
  if (isError || !page) {
    const missing = error instanceof ApiError && error.status === 404;
    return (
      <Frame>
        <div role="alert" className="flex flex-col items-start gap-3 py-6 text-sm text-si-fg">
          <p className="m-0">
            {missing
              ? 'Page not found. It may be in a show you can’t open.'
              : errorText(error, 'The page could not be loaded.')}
          </p>
          {!missing && (
            <Button variant="outline" onClick={() => void refetch()}>
              Try again
            </Button>
          )}
        </div>
      </Frame>
    );
  }
  if (mergedInto) {
    return (
      <Frame>
        <p role="status" className="m-0 py-10 text-sm text-si-muted">
          This page was merged. Opening the page it was merged into…
        </p>
      </Frame>
    );
  }

  const activeShowId = profile?.active_show_id ?? '';
  const pageShow = profile?.shows.find((s) => s.id === page.show_id);
  const otherShow = Boolean(profile) && page.show_id !== activeShowId;
  const isSession = page.kind === 'session';
  const live = !page.deleted;

  const startEdit = () =>
    setEdit({ base: page.revision, draft: draftOf(page), conflict: null, error: null });

  const save = () => {
    if (!edit) return;
    const title = edit.draft.title.trim();
    if (!title) {
      setEdit({ ...edit, error: 'A page needs a title.' });
      return;
    }
    update.mutate(
      {
        pageId: page.id,
        body: {
          expected_revision: edit.base,
          title,
          body_md: edit.draft.body,
          ...(isSession ? {} : { aliases: edit.draft.aliases }),
        },
      },
      {
        onSuccess: () => setEdit(null),
        onError: (e) => {
          const conflict = wikiVersionConflictOf(e);
          setEdit((s) =>
            s && conflict
              ? { ...s, conflict: conflict.current, error: null }
              : s && { ...s, error: errorText(e, 'The page was not saved.') },
          );
        },
      },
    );
  };

  const loadNewer = () => {
    if (!edit?.conflict) return;
    const current = edit.conflict;
    setEdit({ base: current.revision, draft: draftOf(current), conflict: null, error: null });
  };

  const onDelete = async () => {
    const ok = await confirm({
      title: 'Delete this page?',
      message: `“${page.title}” leaves the wiki and frees its title and aliases. Its history is kept, and it can be restored from the Deleted list.`,
      confirmLabel: 'Delete page',
      danger: true,
    });
    if (!ok) return;
    del.mutate(
      { pageId: page.id, expectedRevision: page.revision },
      {
        onError: (e) =>
          showToast(
            wikiVersionConflictOf(e)
              ? 'This page changed since you opened it. Check it, then delete again.'
              : `Couldn't delete the page: ${errorText(e, 'unknown error')}`,
            true,
          ),
      },
    );
  };

  const onRestore = () =>
    restore.mutate(
      { pageId: page.id, expectedRevision: page.revision },
      {
        onError: (e) =>
          showToast(`Couldn't restore the page: ${errorText(e, 'unknown error')}`, true),
      },
    );

  return (
    <Frame>
      {otherShow && (
        <Alert>
          <AlertTitle>This page belongs to {pageShow?.name ?? 'another show'}</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span>It isn’t in your active show, so its links and new pages go there.</span>
            {pageShow && (
              <Button
                size="sm"
                variant="outline"
                disabled={switching}
                onClick={() =>
                  void switchActive({ studioId: pageShow.studio_id, showId: pageShow.id })
                }
              >
                Switch to {pageShow.name}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{WIKI_KIND_LABEL[page.kind]}</Badge>
          {page.deleted && <Badge variant="destructive">Deleted</Badge>}
        </div>
        <h1 className="m-0 text-[1.35rem] font-semibold break-words text-si-fg">{page.title}</h1>
        {page.aliases.length > 0 && (
          <ul aria-label="Aliases" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
            {page.aliases.map((a) => (
              <li key={a}>
                <Badge variant="outline" className="normal-case tracking-normal">
                  {a}
                </Badge>
              </li>
            ))}
          </ul>
        )}
        <p className="m-0 text-xs text-si-dim">
          Last changed by <span className="text-si-muted">{page.updated_by_name}</span>,{' '}
          <time dateTime={page.updated_at_utc}>{formatWhen(page.updated_at_utc)}</time> · r
          {page.revision}
        </p>
      </header>

      {!edit && (
        <div className="flex flex-wrap gap-2">
          {live && (
            <Button size="sm" onClick={startEdit}>
              <PencilIcon aria-hidden="true" /> Edit
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => setPanel('history')}>
            <HistoryIcon aria-hidden="true" /> History
          </Button>
          {live && !isSession && (
            <Button size="sm" variant="outline" onClick={() => setPanel('merge')}>
              <GitMergeIcon aria-hidden="true" /> Merge into…
            </Button>
          )}
          {live && (
            <Button size="sm" variant="outline" onClick={() => setPanel('split')}>
              <ScissorsIcon aria-hidden="true" /> Split
            </Button>
          )}
          {live && (
            <Button
              size="sm"
              variant="ghost"
              className="text-v5-danger"
              disabled={del.isPending}
              onClick={() => void onDelete()}
            >
              <Trash2Icon aria-hidden="true" /> Delete
            </Button>
          )}
        </div>
      )}

      {page.deleted && (
        <Alert>
          <AlertTitle>This page was deleted.</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span>Its history is kept. Restoring it brings back its title and aliases.</span>
            <Button size="sm" variant="outline" disabled={restore.isPending} onClick={onRestore}>
              Restore
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {edit ? (
        <section aria-label="Edit page" className="flex flex-col gap-4">
          {edit.conflict && (
            <Alert>
              <AlertTitle>
                {edit.conflict.updated_by_name} saved this page while you were editing
              </AlertTitle>
              <AlertDescription className="flex flex-col items-start gap-2">
                <span>
                  Your text is still here, and nothing was saved. Copy what you need, then load the
                  newer page (r{edit.conflict.revision}) and add your changes to it.
                </span>
                <Button size="sm" variant="outline" onClick={loadNewer}>
                  Load the newer page
                </Button>
              </AlertDescription>
            </Alert>
          )}
          <WikiEditor
            draft={edit.draft}
            onChange={(draft) => setEdit({ ...edit, draft, error: null })}
            showAliases={!isSession}
          />
          {edit.error && (
            <p role="alert" className="m-0 text-sm text-v5-danger">
              {edit.error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setEdit(null)} disabled={update.isPending}>
              Cancel
            </Button>
            <Button onClick={save} disabled={update.isPending}>
              {update.isPending && <Spinner role="presentation" aria-hidden="true" />}
              Save
            </Button>
          </div>
        </section>
      ) : page.body_md.trim() ? (
        <WikiMarkdown body={page.body_md} />
      ) : (
        <p className="m-0 text-sm text-si-muted">This page is empty.</p>
      )}

      <WikiHistorySheet
        page={page}
        open={panel === 'history'}
        onOpenChange={(o) => setPanel(o ? 'history' : null)}
      />
      {live && !isSession && panel === 'merge' && (
        <WikiMergeDialog page={page} open onOpenChange={(o) => setPanel(o ? 'merge' : null)} />
      )}
      {live && panel === 'split' && (
        <WikiSplitDialog page={page} open onOpenChange={(o) => setPanel(o ? 'split' : null)} />
      )}
      {confirmElement}
    </Frame>
  );
}
