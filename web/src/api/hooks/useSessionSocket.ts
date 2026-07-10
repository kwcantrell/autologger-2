import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { toast } from '../../shared/components/Toast';
import { wsUrl } from '../client';
import type { CompanionCommandType } from '../types';
import { eventsKeys } from './useEvents';

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

/**
 * Subscribes to the per-session Durable Object WebSocket and routes its discrete
 * change frames into React Query invalidations, replacing the deleted poll loops.
 * Reconnects with jittered backoff; re-syncs (status/events/audio) on every open
 * to catch up anything missed during a drop. `{type:'ping'}` keepalive every ~25s.
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
    let backoff = BACKOFF_START_MS;
    let immediateFailures = 0;
    let warned = false;
    let openedAt = 0;

    const clearPing = () => {
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
    };

    // Re-anchor every cache the deleted polls used to refresh — the catch-up for
    // any frames missed while the socket was down.
    const resync = () => {
      qc.invalidateQueries({ queryKey: ['session-status', sessionId] });
      qc.invalidateQueries({ queryKey: eventsKeys.all(sessionId) });
      qc.invalidateQueries({ queryKey: ['audio-segments', sessionId] });
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
            qc.invalidateQueries({ queryKey: eventsKeys.all(sessionId) });
            break;
          case 'transport.changed':
            // Re-anchor the clock + take at the transition.
            qc.invalidateQueries({ queryKey: ['session-status', sessionId] });
            break;
          case 'audio.changed':
            qc.invalidateQueries({ queryKey: ['audio-segments', sessionId] });
            break;
          case 'lease.changed':
            qc.invalidateQueries({ queryKey: ['session-status', sessionId] });
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
