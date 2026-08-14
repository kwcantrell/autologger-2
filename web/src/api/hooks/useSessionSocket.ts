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
    // before `new WebSocket(...)`). resync() compares cache timestamps against
    // it so an on-open resync only invalidates data that could actually be
    // stale relative to this attempt.
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
    // any frames missed while the socket was down. Gated on freshness: skip
    // queries whose data is already proven fresher than this connect attempt
    // (`dataUpdatedAt >= connectStartedAt` — on first mount that is the just-
    // landed initial fetch), and skip mount fetches still in flight
    // (fetching with no data yet — invalidation would restart them). Reconnect
    // catch-up is preserved: connectStartedAt is re-recorded per attempt, so
    // anything last updated before the drop still invalidates. A predicate
    // (not a narrower queryKey) because eventsKeys.all() prefix-matches every
    // per-page limit/offset variant.
    const isStaleForThisConnect = (q: Query) => {
      if (q.state.dataUpdatedAt >= connectStartedAt) return false;
      if (q.state.fetchStatus === 'fetching' && q.state.dataUpdatedAt === 0) return false;
      return true;
    };
    const resync = () => {
      qc.invalidateQueries({
        queryKey: sessionStatusKeys.bySession(sessionId),
        predicate: isStaleForThisConnect,
      });
      qc.invalidateQueries({
        queryKey: eventsKeys.all(sessionId),
        predicate: isStaleForThisConnect,
      });
      qc.invalidateQueries({
        queryKey: audioSegmentsKeys.bySession(sessionId),
        predicate: isStaleForThisConnect,
      });
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
