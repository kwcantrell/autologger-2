import { type Query, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { toast } from '../../shared/components/Toast';
import { wsUrl } from '../client';
import type { CompanionCommandType } from '../types';
import { audioSegmentsKeys } from './useAudio';
import { eventsKeys } from './useEvents';
import { sessionStatusKeys } from './useSessionStatus';

interface Options {
  /** Invoked for `{type:'command'}` frames (Companion record/play relay). No WS ack. */
  executeCommand?: (cmd: CompanionCommandType) => unknown;
}

const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 8_000;
const PING_INTERVAL_MS = 25_000;
// A socket that closes within this window of opening is treated as a failed
// connect (e.g. a 401/403/404 from requireSession) rather than a healthy drop.
const MIN_HEALTHY_MS = 2_000;
// After this many consecutive immediate failures, stop spinning: cap the backoff
// and warn once. The slow status poll (useSessionStatus) keeps the session usable.
const MAX_IMMEDIATE_FAILURES = 4;
// Burst coalescing for `event.changed`-driven refetches (auto-generate-event-logs,
// design D9): the server broadcasts one frame per insert, and a bulk generation run
// (or any rapid event source) would otherwise trigger one full events refetch per
// frame on every connected client. The first frame of a burst refetches immediately
// (a single manual log stays instant); further frames within this window coalesce
// into one trailing refetch, so a quiet period always ends with a refetch that
// reflects final state. Server emission semantics are unchanged.
const EVENTS_COALESCE_MS = 1_000;

/**
 * Subscribes to the per-session Durable Object WebSocket and routes its discrete
 * change frames into React Query invalidations, replacing the deleted poll loops.
 * Reconnects with jittered backoff; re-syncs (status/events/audio) on every open
 * to catch up anything missed during a drop. `{type:'ping'}` keepalive every ~25s.
 * `event.changed` refetches are burst-coalesced (leading + ~1s trailing debounce,
 * see EVENTS_COALESCE_MS); all other frame types invalidate per frame.
 */
export function useSessionSocket(sessionId: string | null, opts: Options = {}): void {
  const qc = useQueryClient();
  const executeRef = useRef(opts.executeCommand);
  executeRef.current = opts.executeCommand;

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    // Leading+trailing debounce state for `event.changed` (EVENTS_COALESCE_MS).
    // Effect-scoped (not per-socket): a window spanning a reconnect still ends in
    // one trailing refetch, and the on-open resync() re-anchors regardless.
    let eventsWindowTimer: ReturnType<typeof setTimeout> | null = null;
    let eventsTrailingPending = false;
    let backoff = BACKOFF_START_MS;
    let immediateFailures = 0;
    let warned = false;
    let openedAt = 0;
    // Wall-clock instant the current connect attempt started (recorded just
    // before `new WebSocket(...)`). resync() compares the STATUS and AUDIO cache
    // timestamps against it, so an on-open resync only invalidates data that
    // could plausibly be stale relative to this attempt. Deliberately not used
    // for the events cache — see the long note above `isStaleForThisConnect`.
    let connectStartedAt = 0;

    const clearPing = () => {
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
    };

    const invalidateEvents = () => {
      qc.invalidateQueries({ queryKey: eventsKeys.all(sessionId) });
    };

    // Closes a coalescing window: if frames arrived while it was open, issue the
    // trailing refetch (final state) and open a fresh window so a continuing burst
    // keeps refetching about once per EVENTS_COALESCE_MS; otherwise go idle.
    const onEventsWindowEnd = () => {
      eventsWindowTimer = null;
      if (!eventsTrailingPending) return;
      eventsTrailingPending = false;
      invalidateEvents();
      eventsWindowTimer = setTimeout(onEventsWindowEnd, EVENTS_COALESCE_MS);
    };

    // `event.changed` entry point: leading edge fires immediately (single manual
    // log stays instant), frames inside an open window coalesce into the trailing
    // refetch. Scoped strictly to the events query — every other frame type keeps
    // its per-frame invalidation.
    const onEventChanged = () => {
      if (eventsWindowTimer === null) {
        invalidateEvents();
        eventsWindowTimer = setTimeout(onEventsWindowEnd, EVENTS_COALESCE_MS);
      } else {
        eventsTrailingPending = true;
      }
    };

    // Re-anchor every cache the deleted polls used to refresh — the catch-up for
    // any frames missed while the socket was down.
    //
    // WHY THE ANCHOR IS NOT AIRTIGHT, AND WHAT WE DO ABOUT IT
    //
    // The cheap gate below skips queries whose data landed at/after this connect
    // attempt started (`dataUpdatedAt >= connectStartedAt`). `dataUpdatedAt` is a
    // *resolution* time, and the response's server-side snapshot is strictly
    // earlier — so a change can land in the gap between that snapshot and
    // `onopen` and be lost in both directions at once:
    //
    //     t0        connect attempt starts (connectStartedAt)
    //     t0+100ms  server snapshots the fetch response
    //     t0+150ms  fetch resolves  -> dataUpdatedAt = t0+150 (>= t0, "fresh")
    //     t0+300ms  a row is inserted; the WS frame is broadcast NOW
    //     t0+800ms  onopen — too late to receive that frame
    //
    // The row is in neither the response nor the socket, and the gate marks the
    // cache permanently fresh. Only data produced by a fetch *initiated* after
    // `onopen` is provably complete — and React Query state exposes no
    // fetch-START time, only `dataUpdatedAt`. Worse, at the instant resync() runs
    // (synchronously inside `onopen`) NO cached data can satisfy that criterion,
    // because no post-open fetch has had time to start, let alone resolve. So a
    // *provably correct* gate degenerates to "invalidate everything, every open".
    //
    // That leaves a per-key correctness/cost trade, and the three keys sit in
    // genuinely different places:
    //
    //  - events   — an append-only feed. A missed insert is user-visible, and
    //               NOTHING re-anchors it: the events query has no poll, and on a
    //               session that then goes quiet no later frame arrives to heal
    //               it. The row is simply gone from the UI until a manual reload.
    //               => takes the provably-correct treatment: always invalidated
    //               on open, no freshness gate at all.
    //  - status   — a missed transport/lease change is healed by the next
    //               transport/lease/ROLLING-poll refresh, and those arrive
    //               continuously exactly when it matters (a rolling session emits
    //               lease + audio frames, and `useSessionStatus` polls at 1.2s
    //               whenever `is_rolling || lease_alive`). Residual accepted: a
    //               missed idle->rolling frame on a session with no audio can
    //               show a stale "idle" until the next transport frame.
    //  - audio    — segments are re-invalidated by every subsequent chunk upload
    //               (AudioRecorder), by sync-from-disk (useAudioClips), and by any
    //               later `audio.changed`; a recording session produces those by
    //               the second. Self-healing in practice.
    //
    // So: keep the cheap gate for status/audio (that is where the double-fetch
    // win on mount is retained), drop it for events. Reconnect catch-up is
    // unchanged for the gated pair — connectStartedAt is re-recorded per attempt,
    // so anything last updated before the drop still invalidates.
    //
    // Deliberately NOT skipped either way: fetches still in flight with no data
    // yet — see `isUnanchoredInFlight` below.
    //
    // A predicate (not a narrower queryKey) because eventsKeys.all()
    // prefix-matches every per-page limit/offset variant.
    const isStaleForThisConnect = (q: Query) => q.state.dataUpdatedAt < connectStartedAt;

    // …and invalidation alone does not restart such a fetch. React Query's
    // `cancelRefetch` (default true on invalidateQueries) only cancels a fetch
    // that ALREADY has data — query-core `Query#fetch` guards on
    // `state.data !== undefined && cancelRefetch`, otherwise it joins the
    // existing retryer promise. The pre-open fetch would then resolve normally
    // and its `success` state clears `isInvalidated`, so the stale snapshot
    // would stick. Cancelling it explicitly (reverting to idle) is what makes
    // the invalidateQueries below start a genuinely fresh fetch. Scoped to
    // `type: 'active'` so we only cancel fetches that same invalidation will
    // restart — never an observer-less prefetch nobody would re-drive.
    const isUnanchoredInFlight = (q: Query) =>
      q.state.fetchStatus === 'fetching' && q.state.dataUpdatedAt === 0;

    // `gated: false` means "always invalidate on open" — the provably-correct
    // treatment, reserved for the key where a missed frame never heals (events).
    const resyncTargets = (): { queryKey: readonly unknown[]; gated: boolean }[] => [
      { queryKey: sessionStatusKeys.bySession(sessionId), gated: true },
      { queryKey: eventsKeys.all(sessionId), gated: false },
      { queryKey: audioSegmentsKeys.bySession(sessionId), gated: true },
    ];
    const resync = () => {
      for (const { queryKey, gated } of resyncTargets()) {
        void qc.cancelQueries({ queryKey, type: 'active', predicate: isUnanchoredInFlight });
        qc.invalidateQueries(gated ? { queryKey, predicate: isStaleForThisConnect } : { queryKey });
      }
    };

    const scheduleReconnect = () => {
      if (cancelled) return;
      const healthy = openedAt > 0 && Date.now() - openedAt >= MIN_HEALTHY_MS;
      if (healthy) {
        backoff = BACKOFF_START_MS;
        immediateFailures = 0;
        warned = false;
      } else {
        immediateFailures += 1;
      }
      let delay = Math.min(BACKOFF_MAX_MS, backoff);
      if (immediateFailures >= MAX_IMMEDIATE_FAILURES) {
        delay = BACKOFF_MAX_MS;
        if (!warned) {
          warned = true;
          toast.error('Live updates unavailable');
        }
      }
      const wait = delay * (0.7 + Math.random() * 0.6);
      reconnectTimer = setTimeout(connect, wait);
      backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
    };

    const connect = () => {
      if (cancelled) return;
      openedAt = 0;
      connectStartedAt = Date.now();
      try {
        ws = new WebSocket(wsUrl(`sessions/${encodeURIComponent(sessionId)}/ws?role=browser`));
      } catch {
        scheduleReconnect();
        return;
      }
      ws.onopen = () => {
        openedAt = Date.now();
        resync();
        clearPing();
        pingTimer = setInterval(() => {
          try {
            ws?.send(JSON.stringify({ type: 'ping' }));
          } catch {
            /* socket going away; onclose drives reconnect */
          }
        }, PING_INTERVAL_MS);
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        let msg: { type?: string; command?: unknown };
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        switch (msg.type) {
          case 'event.changed':
            onEventChanged();
            break;
          case 'transport.changed':
            // Re-anchor the clock + take at the transition.
            qc.invalidateQueries({ queryKey: sessionStatusKeys.bySession(sessionId) });
            break;
          case 'audio.changed':
            qc.invalidateQueries({ queryKey: audioSegmentsKeys.bySession(sessionId) });
            break;
          case 'lease.changed':
            qc.invalidateQueries({ queryKey: sessionStatusKeys.bySession(sessionId) });
            break;
          case 'command':
            if (typeof msg.command === 'string') {
              void executeRef.current?.(msg.command as CompanionCommandType);
            }
            break;
        }
      };
      ws.onerror = () => {
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        clearPing();
        ws = null;
        scheduleReconnect();
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (eventsWindowTimer) clearTimeout(eventsWindowTimer);
      clearPing();
      if (ws) {
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    };
  }, [sessionId, qc]);
}
