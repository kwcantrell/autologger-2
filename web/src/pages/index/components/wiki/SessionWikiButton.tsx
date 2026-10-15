import { useQueryClient } from '@tanstack/react-query';
import { BookOpenIcon } from 'lucide-react';
import { useState } from 'react';
import { apiFetch } from '../../../../api/client';
import { type WikiPageFilters, wikiKeys, wikiPagesPath } from '../../../../api/hooks/useWiki';
import type { WikiPage, WikiPageCreateBody, WikiPageListResponse } from '../../../../api/types';
import { showToast } from '../../../../shared/components/Toast';
import { Button } from '../../../../shared/components/ui/button';
import { navigate } from '../../navigation';
import { conflictPageId } from './NewWikiPageDialog';
import { wikiPageHref } from './WikiPageLink';

// "Wiki page" at the end of the session workspace's feed-tab row, after "Update wiki", which
// pushes the pair to the row's end (show-wiki D7, show-wiki-ai D6; scenario
// "Session page from the workspace"). A press lists the session's page and opens it; with none,
// it creates a `session` page titled after the session and opens that. A `409 Session already
// has a page.` (someone made it meanwhile) opens the page the 409 names. Nothing is fetched
// before a press. The workspace calls no mutation hook (its tests stub the query client to
// `useQueryClient` alone), so the create goes through `apiFetch` and settles the cache as
// `useCreateWikiPage` does.

interface Props {
  sessionId: string;
  /** The session's show; the button is disabled without one. */
  showId: string | null;
  /** The session's title, which names a new page. */
  title: string;
}

export function SessionWikiButton({ sessionId, showId, title }: Props) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  const open = async () => {
    if (!showId || busy) return;
    setBusy(true);
    try {
      const filters: WikiPageFilters = { kind: 'session', sessionId };
      const { pages } = await qc.fetchQuery({
        queryKey: wikiKeys.list(showId, filters),
        queryFn: ({ signal }) =>
          apiFetch<WikiPageListResponse>(wikiPagesPath(showId, filters), { signal }),
      });
      const found = pages[0];
      if (found) {
        navigate(wikiPageHref(found.id));
        return;
      }
      try {
        const body: WikiPageCreateBody = {
          kind: 'session',
          title: title.trim() || 'Untitled session',
          session_id: sessionId,
        };
        const page = await apiFetch<WikiPage>(`shows/${showId}/wiki/pages`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        qc.setQueryData(wikiKeys.page(page.id), page);
        void qc.invalidateQueries({ queryKey: wikiKeys.list(showId) });
        navigate(wikiPageHref(page.id));
      } catch (e) {
        const existing = conflictPageId(e);
        if (!existing) throw e;
        navigate(wikiPageHref(existing));
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not open the wiki page.', true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      className="shrink-0 self-center text-si-muted hover:text-si-fg"
      disabled={!showId || busy}
      onClick={() => void open()}
    >
      <BookOpenIcon data-icon="inline-start" aria-hidden="true" />
      Wiki page
    </Button>
  );
}
