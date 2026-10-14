import { type MouseEvent, type ReactNode, useEffect, useState } from 'react';
import { ApiError } from '../../../../api/client';
import { useWikiPage, wikiVersionConflictOf } from '../../../../api/hooks/useWiki';
import {
  useAcceptWikiSuggestion,
  useDismissWikiSuggestion,
  useWikiSuggestion,
  wikiSuggestionResolvedOf,
} from '../../../../api/hooks/useWikiSuggestions';
import type { WikiPage, WikiSuggestionAcceptBody } from '../../../../api/types';
import { Alert, AlertDescription, AlertTitle } from '../../../../shared/components/ui/alert';
import { Badge } from '../../../../shared/components/ui/badge';
import { Button } from '../../../../shared/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '../../../../shared/components/ui/sheet';
import { Spinner } from '../../../../shared/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../../shared/components/ui/tabs';
import { navigate } from '../../navigation';
import { showToast } from '../../utils/toast';
import { sessionHref } from '../search/searchLinks';
import { type WikiDraft, WikiEditor } from './WikiEditor';
import { WikiMarkdown } from './WikiMarkdown';
import { ProposalDiff, type WikiTexts } from './wikiDiff';
import { WIKI_KIND_LABEL } from './wikiKindLabels';

// --- Reviewing one wiki suggestion (show-wiki-ai D6; show-wiki "Suggestions inbox", scenario
// "Review a stale suggestion") ---
//
// The sheet loads the suggestion and its target page. The diff is always from the page's CURRENT
// revision to the suggestion (a new page diffs against empty), and a stale suggestion says the
// page changed since the run. Accept sends the revision the diff was drawn against. "Edit, then
// accept" opens the page editor prefilled with the suggestion (the kind is fixed: accept can't
// change it) and accepts with the edited title, body and aliases. On `409 Version conflict.` the
// hooks put the newer page in the cache, so the diff redraws against it; any edited text stays.
// Model-written title, aliases and rationale are plain text; only the body renders as Markdown,
// under the wiki's safe rules (WikiMarkdown).

interface Props {
  suggestionId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** "From the session" — the session a suggestion came from, opened in place. */
export function SuggestionSessionLink({ sessionId }: { sessionId: string }) {
  const href = sessionHref(sessionId);
  return (
    <a
      href={href}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(href);
      }}
      className="text-si-muted underline decoration-v5-border-strong underline-offset-2 hover:text-si-fg"
    >
      From the session
    </a>
  );
}

function textsOf(page: WikiPage): WikiTexts {
  return { title: page.title, aliases: page.aliases, body: page.body_md };
}

function errorText(e: unknown, fallback: string): string {
  const resolved = wikiSuggestionResolvedOf(e);
  if (resolved) return `This suggestion was already ${resolved.status}.`;
  return e instanceof Error && e.message ? e.message : fallback;
}

export function WikiSuggestionSheet({ suggestionId, open, onOpenChange }: Props) {
  const suggestion = useWikiSuggestion(open ? suggestionId : null);
  const s = suggestion.data;
  const target = useWikiPage(open && s?.page_id ? s.page_id : null);
  const accept = useAcceptWikiSuggestion();
  const dismiss = useDismissWikiSuggestion();
  const [draft, setDraft] = useState<WikiDraft | null>(null);
  /** The revision a 409 moved the diff to. */
  const [conflictAt, setConflictAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A different suggestion, or closing, starts clean.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on suggestion or open change
  useEffect(() => {
    setDraft(null);
    setConflictAt(null);
    setError(null);
  }, [suggestionId, open]);

  const page = s?.page_id ? (target.data ?? null) : null;
  const isNew = Boolean(s) && !s?.page_id;
  const isSession = s?.kind === 'session';
  const pageGone = Boolean(page && (page.deleted || page.merged_into));
  const pending = s?.status === 'pending';
  const ready = Boolean(s) && (isNew || Boolean(page));
  const busy = accept.isPending || dismiss.isPending;

  const proposed: WikiTexts | null = s
    ? draft
      ? { title: draft.title, aliases: isSession ? [] : draft.aliases, body: draft.body }
      : { title: s.title, aliases: s.aliases, body: s.body_md }
    : null;

  const doAccept = () => {
    if (!s || !suggestionId) return;
    setError(null);
    let body: WikiSuggestionAcceptBody = page ? { expected_revision: page.revision } : {};
    if (draft) {
      const title = draft.title.trim();
      if (!title) {
        setError('A page needs a title.');
        return;
      }
      body = {
        ...body,
        title,
        body_md: draft.body,
        ...(isSession ? {} : { aliases: draft.aliases }),
      };
    }
    accept.mutate(
      { suggestionId, body },
      {
        onSuccess: () => {
          showToast(isNew ? 'Page created from the suggestion.' : 'Suggestion accepted.');
          onOpenChange(false);
        },
        onError: (e) => {
          const conflict = wikiVersionConflictOf(e);
          if (conflict) {
            setConflictAt(conflict.current.revision);
            return;
          }
          setError(errorText(e, 'The suggestion was not accepted.'));
        },
      },
    );
  };

  const doDismiss = () => {
    if (!suggestionId) return;
    setError(null);
    dismiss.mutate(
      { suggestionId },
      {
        onSuccess: () => {
          showToast('Suggestion dismissed.');
          onOpenChange(false);
        },
        onError: (e) => setError(errorText(e, 'The suggestion was not dismissed.')),
      },
    );
  };

  let body: ReactNode;
  if (suggestion.isPending) {
    body = (
      <div role="status" className="flex items-center gap-2 text-sm text-si-muted">
        <Spinner role="presentation" aria-hidden="true" className="size-4" /> Loading suggestion…
      </div>
    );
  } else if (suggestion.isError || !s || !proposed) {
    const missing = suggestion.error instanceof ApiError && suggestion.error.status === 404;
    body = (
      <p role="alert" className="m-0 text-sm text-si-fg">
        {missing
          ? 'Suggestion not found.'
          : errorText(suggestion.error, 'The suggestion could not be loaded.')}
      </p>
    );
  } else {
    const stale = Boolean(page && s.base_revision != null && page.revision !== s.base_revision);
    const diff = !ready ? (
      target.isError ? (
        <p role="alert" className="m-0 text-sm text-si-fg">
          {errorText(target.error, 'The page could not be loaded.')}
        </p>
      ) : (
        <div role="status" className="flex items-center gap-2 text-sm text-si-muted">
          <Spinner role="presentation" aria-hidden="true" className="size-4" /> Loading the page…
        </div>
      )
    ) : (
      <ProposalDiff
        base={page ? textsOf(page) : null}
        proposed={proposed}
        baseRevision={page?.revision}
      />
    );

    body = (
      <>
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{WIKI_KIND_LABEL[s.kind]}</Badge>
            {stale && <Badge variant="secondary">Stale</Badge>}
            {!pending && <Badge variant="outline">{s.status}</Badge>}
          </div>
          <h3 className="m-0 text-base font-semibold break-words text-si-fg">{s.title}</h3>
          {s.rationale && <p className="m-0 text-sm text-si-muted break-words">{s.rationale}</p>}
          <p className="m-0 text-xs text-si-dim">
            <SuggestionSessionLink sessionId={s.session_id} /> · run by {s.created_by_name}
          </p>
        </div>

        {stale && page && (
          <Alert>
            <AlertTitle>The page changed since this suggestion</AlertTitle>
            <AlertDescription>
              It was made from r{s.base_revision}; the page is now at r{page.revision}. The changes
              below are against the current page.
            </AlertDescription>
          </Alert>
        )}
        {conflictAt != null && (
          <Alert>
            <AlertTitle>The page changed while you were reviewing</AlertTitle>
            <AlertDescription>
              The changes below are now against r{conflictAt}.{draft ? ' Your edits are kept.' : ''}{' '}
              Check them, then accept again.
            </AlertDescription>
          </Alert>
        )}
        {pageGone && page && (
          <Alert>
            <AlertTitle>
              {page.merged_into ? 'This page was merged' : 'This page was deleted'}
            </AlertTitle>
            <AlertDescription>
              The suggestion can’t be accepted. You can dismiss it.
            </AlertDescription>
          </Alert>
        )}

        {draft ? (
          <section aria-label="Edit suggestion" className="flex flex-col gap-4">
            {diff}
            <p className="m-0 text-xs text-si-muted">Kind: {WIKI_KIND_LABEL[s.kind]}</p>
            <WikiEditor draft={draft} onChange={setDraft} showAliases={!isSession} />
          </section>
        ) : (
          <Tabs defaultValue="changes" className="gap-2">
            <TabsList variant="line" aria-label="Suggestion view">
              <TabsTrigger value="changes">Changes</TabsTrigger>
              <TabsTrigger value="preview">Preview</TabsTrigger>
            </TabsList>
            <TabsContent value="changes">{diff}</TabsContent>
            <TabsContent value="preview">
              <div className="rounded-ctl border border-v5-border px-4 py-2">
                {s.body_md.trim() ? (
                  <WikiMarkdown body={s.body_md} />
                ) : (
                  <p className="m-0 py-2 text-sm text-si-muted">The suggested page is empty.</p>
                )}
              </div>
            </TabsContent>
          </Tabs>
        )}

        {error && (
          <p role="alert" className="m-0 text-sm text-v5-danger">
            {error}
          </p>
        )}

        {/* The actions wait for the page: Accept sends the revision the diff is drawn against. */}
        {pending && ready && (
          <div className="flex flex-wrap justify-end gap-2">
            {draft ? (
              <>
                <Button variant="outline" disabled={busy} onClick={() => setDraft(null)}>
                  Cancel
                </Button>
                <Button disabled={busy || pageGone} onClick={doAccept}>
                  {accept.isPending && <Spinner role="presentation" aria-hidden="true" />}
                  Accept with edits
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" disabled={busy} onClick={doDismiss}>
                  Dismiss
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || pageGone}
                  onClick={() =>
                    setDraft({ title: s.title, body: s.body_md, aliases: [...s.aliases] })
                  }
                >
                  Edit, then accept
                </Button>
                <Button disabled={busy || pageGone} onClick={doAccept}>
                  {accept.isPending && <Spinner role="presentation" aria-hidden="true" />}
                  Accept
                </Button>
              </>
            )}
          </div>
        )}
      </>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-3 overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Review suggestion</SheetTitle>
          <SheetDescription>
            {!s
              ? 'A suggested wiki change.'
              : s.page_id
                ? `A suggested update to ${s.page?.title ?? 'a page'}.`
                : `New page · ${WIKI_KIND_LABEL[s.kind]}`}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-6">{body}</div>
      </SheetContent>
    </Sheet>
  );
}
