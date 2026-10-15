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

/** Seconds as `h:mm:ss` (whole seconds, rounded down): 4323.49 -> `1:12:03`. */
export function formatMomentTime(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * A moment's label (D11.4; spec "A transcript moment's label"). A transcript moment reads
 * `Speaker <n> · <h:mm:ss>`: "Speaker n" for a bare-number speaker, the name otherwise, left out
 * when empty; the time left out when `sec` is null (and "Transcript" when both are). Topics and
 * events read their kind.
 */
export function momentLabel(m: SearchMoment): string {
  if (m.kind !== 'transcript') return MOMENT_KIND_LABEL[m.kind];
  const speaker = m.speaker.trim();
  const parts = [
    /^\d+$/.test(speaker) ? `Speaker ${speaker}` : speaker,
    m.sec == null ? '' : formatMomentTime(m.sec),
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : MOMENT_KIND_LABEL.transcript;
}

export function sessionHref(sessionId: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}`;
}

/** A timed deep link into a session: `/sessions/<id>?t=<sec>` (show-wiki D7 "Moment links"; used by
 * `momentHref` for transcript moments and by `WikiMarkdown` for `cite:` links). */
export function secondsHref(sessionId: string, sec: number): string {
  return `${sessionHref(sessionId)}?t=${sec}`;
}

/** A moment's deep link: `?t=` for a timed transcript passage, `?topic=` / `?event=` for a feed
 * row (placed by the workspace with the feed's own rules), the bare session otherwise. */
export function momentHref(m: SearchMoment): string {
  const base = sessionHref(m.session_id);
  if (m.kind === 'transcript') return m.sec == null ? base : secondsHref(m.session_id, m.sec);
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
