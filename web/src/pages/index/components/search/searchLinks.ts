import { useCallback, useRef } from 'react';
import { useLocation, useRoute } from 'wouter';
import type {
  SearchMoment,
  SearchSessionHit,
  SearchShowHit,
  SearchStudioHit,
} from '../../../../api/types';
import { useSwitchActive } from '../../hooks/useSwitchActive';
import { navigate } from '../../navigation';

// --- Where a search result leads (catalog-search D8, D9; catalog-search "Command palette and
// results page", web-session-routing "Moment deep links") ---

export const MOMENT_KIND_LABEL: Record<SearchMoment['kind'], string> = {
  transcript: 'Transcript',
  topic: 'Topic',
  event: 'Event',
};

export function sessionHref(sessionId: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}`;
}

/** A moment's deep link: `?t=` for a timed transcript passage, `?topic=` / `?event=` for a feed
 * row (placed by the workspace with the feed's own rules), the bare session otherwise. */
export function momentHref(m: SearchMoment): string {
  const base = sessionHref(m.session_id);
  if (m.kind === 'transcript') return m.sec == null ? base : `${base}?t=${m.sec}`;
  return `${base}?${m.kind}=${encodeURIComponent(m.id)}`;
}

export function searchPageHref(q: string): string {
  return `/search?q=${encodeURIComponent(q.trim())}`;
}

interface Options {
  /** AppShell's close-session path. */
  onCloseSession: () => void;
  /** The open Settings view's discard guard. */
  confirmSwitch?: () => true | Promise<boolean>;
}

/**
 * The choose handlers shared by the palette and the results page. Sessions and moments navigate
 * (a link into the session already open replaces rather than stacking history); a show or studio
 * switches through `useSwitchActive` — the top bar's guard and close-session path — and then opens
 * the home view. Each resolves once its navigation (if any) has been issued.
 */
export function useSearchChoose({ onCloseSession, confirmSwitch }: Options) {
  const [location] = useLocation();
  const [onSessionRoute, params] = useRoute('/sessions/:id');
  const activeSessionId = onSessionRoute ? (params?.id ?? '') : '';
  // Whether the close-session path ran during this switch: it navigates home itself when a
  // session is open, so a second `/` would stack a duplicate entry.
  const closedSession = useRef(false);
  const handleCloseSession = useCallback(() => {
    closedSession.current = true;
    onCloseSession();
  }, [onCloseSession]);
  const { switchActive } = useSwitchActive({ onCloseSession: handleCloseSession, confirmSwitch });

  const openPath = useCallback(
    (sessionId: string, href: string) => {
      if (sessionId !== activeSessionId) navigate(href);
      else if (href !== sessionHref(sessionId)) navigate(href, { replace: true });
    },
    [activeSessionId],
  );

  const chooseSession = useCallback(
    (hit: SearchSessionHit) => openPath(hit.id, sessionHref(hit.id)),
    [openPath],
  );

  const chooseMoment = useCallback(
    (m: SearchMoment) => openPath(m.session_id, momentHref(m)),
    [openPath],
  );

  const switchThenHome = useCallback(
    async (target: { studioId: string; showId?: string }) => {
      closedSession.current = false;
      const ok = await switchActive(target);
      if (!ok) return;
      const wentHome = closedSession.current && Boolean(activeSessionId);
      if (!wentHome && location !== '/') navigate('/');
    },
    [switchActive, activeSessionId, location],
  );

  const chooseShow = useCallback(
    (hit: SearchShowHit) => switchThenHome({ studioId: hit.studio_id, showId: hit.id }),
    [switchThenHome],
  );

  const chooseStudio = useCallback(
    (hit: SearchStudioHit) => switchThenHome({ studioId: hit.id }),
    [switchThenHome],
  );

  return { chooseSession, chooseMoment, chooseShow, chooseStudio };
}
