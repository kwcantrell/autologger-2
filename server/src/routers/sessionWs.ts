// Session WebSocket — browser tabs + Companion attach for live pushes. The
// login gate + requireSession run BEFORE the upgrade (same gate as the HTTP routes).

import type { Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import type { AppEnv } from '../types';
import { requireSession } from './_helpers';

export function mountSessionWs(app: Hono<AppEnv>, upgradeWebSocket: UpgradeWebSocket): void {
  app.get(
    '/api/sessions/:sessionId/ws',
    async (c, next) => {
      await requireSession(c, c.req.param('sessionId'), { includeHidden: true });
      await next();
    },
    upgradeWebSocket((c) => {
      const sessionId = c.req.param('sessionId');
      const role =
        new URL(c.req.url).searchParams.get('role') === 'companion' ? 'companion' : 'browser';
      const hub = c.env.ports.sessions.get(sessionId);
      return {
        onOpen(_evt, ws) {
          hub.attachSocket(ws, role);
        },
        onMessage(evt, _ws) {
          if (typeof evt.data === 'string') hub.handleSocketMessage(evt.data);
        },
        onClose(evt, ws) {
          hub.detachSocket(ws);
          try {
            ws.close(evt.code < 1000 || evt.code > 4999 ? 1000 : evt.code);
          } catch {
            // already closed
          }
        },
        onError(_evt, ws) {
          hub.detachSocket(ws);
        },
      };
    }),
  );
}
