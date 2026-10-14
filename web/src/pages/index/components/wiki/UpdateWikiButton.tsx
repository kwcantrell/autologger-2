import { useQueryClient } from '@tanstack/react-query';
import { SparklesIcon } from 'lucide-react';
import { useState } from 'react';
import { ApiError } from '../../../../api/client';
import { generateWiki } from '../../../../api/hooks/useWikiSuggestions';
import { showToast } from '../../../../shared/components/Toast';
import { Button } from '../../../../shared/components/ui/button';
import { Spinner } from '../../../../shared/components/ui/spinner';
import { navigate } from '../../navigation';

// "Update wiki" in the session workspace's feed-tab row, immediately before "Wiki page"
// (show-wiki-ai D6; show-wiki "Suggestions inbox", scenario "Update wiki from the session
// page"). A press runs the session's wiki update; the run stores suggestions for review, never
// pages. While it runs the button reads "Updating wiki…" and can't be pressed again. The
// workspace calls no mutation hook (its tests stub the query client to `useQueryClient` alone,
// as for `SessionWikiButton`), so this uses `generateWiki`, the form `useGenerateWiki` wraps.

export const SUGGESTIONS_HREF = '/wiki?tab=suggestions';

const NO_MODEL = 'Add a language model in Settings → Advanced to update the wiki.';

export function UpdateWikiButton({ sessionId }: { sessionId: string }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { suggestions } = await generateWiki(qc, sessionId);
      const n = suggestions.length;
      if (n === 0) {
        showToast('No suggestions this time');
      } else {
        showToast(`${n} ${n === 1 ? 'suggestion' : 'suggestions'} ready`, false, {
          action: { label: 'Review', onClick: () => navigate(SUGGESTIONS_HREF) },
        });
      }
    } catch (e) {
      showToast(
        e instanceof ApiError && e.status === 503
          ? NO_MODEL
          : e instanceof Error && e.message
            ? e.message
            : 'Wiki update failed.',
        true,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      className="ml-auto shrink-0 self-center text-si-muted hover:text-si-fg"
      disabled={busy}
      onClick={() => void run()}
    >
      {busy ? (
        <Spinner role="presentation" aria-hidden="true" data-icon="inline-start" />
      ) : (
        <SparklesIcon data-icon="inline-start" aria-hidden="true" />
      )}
      {busy ? 'Updating wiki…' : 'Update wiki'}
    </Button>
  );
}
