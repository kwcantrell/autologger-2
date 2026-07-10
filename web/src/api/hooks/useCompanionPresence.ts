import { useEffect } from 'react';
import { getClientInstanceId } from '../../shared/utils/clientId';
import { apiFetch, apiUrl } from '../client';

const PRESENCE_INTERVAL_MS = 5_000;

/**
 * Reports this tab's presence (open session, visibility, playback state) to the server so
 * Companion can resolve "the" active session and target record/play relay commands.
 * Posts immediately, every 5s, and on session/visibility change; clears via sendBeacon on
 * pagehide. Failures are silent — presence is best-effort.
 */
export function useCompanionPresence(sessionId: string | null, isPlaying: boolean): void {
  useEffect(() => {
    const clientId = getClientInstanceId();
    const post = () => {
      apiFetch('companion/presence', {
        method: 'POST',
        body: JSON.stringify({
          client_id: clientId,
          session_id: sessionId,
          visible: document.visibilityState === 'visible',
          is_playing: isPlaying,
        }),
      }).catch(() => {});
    };
    post();
    const timer = setInterval(post, PRESENCE_INTERVAL_MS);
    const onVisibility = () => post();
    document.addEventListener('visibilitychange', onVisibility);
    const onPageHide = () => {
      if (typeof navigator.sendBeacon !== 'function') return;
      try {
        const b = new Blob(
          [JSON.stringify({ client_id: clientId, session_id: null, closing: true })],
          { type: 'application/json' },
        );
        navigator.sendBeacon(apiUrl('companion/presence'), b);
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [sessionId, isPlaying]);
}
