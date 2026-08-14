import { useEffect, useRef } from 'react';
import { getClientInstanceId } from '../../shared/utils/clientId';
import { createWorkerInterval, type WorkerInterval } from '../../shared/utils/workerInterval';
import { apiFetch, apiUrl } from '../client';

const PRESENCE_INTERVAL_VISIBLE_MS = 5_000;
// A hidden tab keeps heartbeating, just half as often. It MUST stay under the server's
// PRESENCE_FRESH_MS = 15_000 (server/src/node/presence.ts): entries older than that are
// pruned, and Companion's primarySession()/requireActiveSession only see fresh entries —
// so a hidden tab that stopped posting would 409 ("No active session") every Companion
// command ~15s after backgrounding, even with the WS up and a recording rolling. 10s
// leaves 5s of margin for late/slipping ticks.
//
// 5s of margin is NOT enough against Chrome's *intensive* throttling, which is why the
// cadence runs on `createWorkerInterval` rather than a bare `setInterval`: after a tab has
// been hidden >5min, main-thread timers are coalesced to roughly one wake-up per MINUTE,
// so a nominal 10s heartbeat would post ~60s apart and blow straight past the 15s TTL —
// Companion would then 409 intermittently on a tab that looks perfectly healthy.
// Dedicated-worker timers are exempt from that clamp. See the fallback note on the hook.
const PRESENCE_INTERVAL_HIDDEN_MS = 10_000;

/**
 * Reports this tab's presence (open session, visibility, playback state) to the server so
 * Companion can resolve "the" active session and target record/play relay commands.
 * Posts immediately, then on a cadence — every 5s while the tab is visible, every 10s
 * while it is hidden — and on session/visibility/playback change; clears via sendBeacon
 * on pagehide. Failures are silent — presence is best-effort.
 *
 * A hidden tab still heartbeats, because the server prunes presence entries at
 * PRESENCE_FRESH_MS (15s) and Companion refuses commands without a fresh entry; the win
 * over the old unconditional 5s timer is *reduced* background traffic, not zero.
 *
 * How honest is "every 10s while hidden"? It holds **when the worker clock is available**
 * (`createWorkerInterval` → `kind: 'worker'`): worker timers are exempt from Chrome's
 * intensive background throttling, so hidden-tab gaps stay ~10s, comfortably under the
 * 15s TTL. On the **fallback** path — no `Worker` global (SSR/jsdom/tests), or a CSP that
 * forbids `blob:` workers — the cadence is a plain main-thread `setInterval` and the
 * guarantee does NOT hold: after ~5 minutes hidden the posts can land ~60s apart, the
 * server entry goes stale, and Companion commands 409 until the tab is foregrounded
 * again. That residual is accepted rather than papered over; the fake-timer tests below
 * exercise the fallback path (neither vitest environment provides `Worker`), so they
 * verify the cadence LOGIC, never the throttling immunity.
 *
 * The CSP case reaches that fallback ASYNCHRONOUSLY — `new Worker(blobUrl)` returns and
 * the refusal arrives as an `error` event — which `createWorkerInterval` now handles by
 * tearing the dead worker down and re-arming the main-thread interval. Worth stating
 * because the alternative was far worse than the throttled residual above: a clock that
 * never ticked at all, leaving this hook posting only on mount/visibility/playback
 * changes, so even a VISIBLE idle tab aged past the 15s TTL. This hook needs no code for
 * that transition — the handle keeps ticking and `stop()` stays the whole teardown.
 *
 * The
 * visibility transition itself is always reported immediately (so Companion learns
 * `visible: false` the instant it happens — that report is what lets it pick a different
 * tab). `isPlaying` is read through a render-updated ref rather than an effect dependency,
 * so a playback toggle no longer tears down and re-arms the interval; a second, small
 * effect posts once on the toggle without disturbing the cadence.
 */
export function useCompanionPresence(sessionId: string | null, isPlaying: boolean): void {
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  /** Assigned by the main effect so the toggle effect below can post without owning the closure. */
  const postRef = useRef<() => void>(() => {});

  useEffect(() => {
    const clientId = getClientInstanceId();
    const post = () => {
      apiFetch('companion/presence', {
        method: 'POST',
        body: JSON.stringify({
          client_id: clientId,
          session_id: sessionId,
          visible: document.visibilityState === 'visible',
          is_playing: isPlayingRef.current,
        }),
      }).catch(() => {});
    };
    postRef.current = post;

    // Off-main-thread clock (see PRESENCE_INTERVAL_HIDDEN_MS): the handle owns its
    // worker + blob URL and releases both on stop(), which the effect cleanup below
    // always reaches — so StrictMode's double-invoked mount leaks nothing.
    let timer: WorkerInterval | null = null;
    let timerPeriod = 0;
    const cadenceMs = () =>
      document.visibilityState === 'visible'
        ? PRESENCE_INTERVAL_VISIBLE_MS
        : PRESENCE_INTERVAL_HIDDEN_MS;
    const armTimer = () => {
      const period = cadenceMs();
      // Idempotent: a visibilitychange that does not actually change visibility
      // (or a re-fired one) must not stack a second interval, or reset the phase
      // of the one already running at the right period. Doubly worth keeping now
      // that a re-arm costs a worker teardown + spawn, not just a timer id.
      if (timer !== null && timerPeriod === period) return;
      timer?.stop();
      timerPeriod = period;
      timer = createWorkerInterval(period, post);
    };
    const stopTimer = () => {
      if (timer === null) return;
      timer.stop();
      timer = null;
      timerPeriod = 0;
    };

    post();
    armTimer();

    const onVisibility = () => {
      // Always report the transition immediately — hiding is exactly the moment
      // Companion needs to hear about, and it is also when the cadence changes.
      post();
      armTimer();
    };
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
      stopTimer();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [sessionId]);

  // Immediate report on a playback toggle (Companion UX: play/pause must not
  // wait out the cadence). Skip-first-run guard expressed as a value compare —
  // seeded with the initial `isPlaying`, so the mount pass is a no-op and
  // StrictMode's double-invoked mount effect cannot post a phantom second time.
  // Deliberately does NOT touch the interval, so the cadence stays where the
  // main effect put it.
  const lastPostedPlayingRef = useRef(isPlaying);
  useEffect(() => {
    if (lastPostedPlayingRef.current === isPlaying) return;
    lastPostedPlayingRef.current = isPlaying;
    postRef.current();
  }, [isPlaying]);
}
