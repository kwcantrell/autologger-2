// Session WebSocket — browser tabs + Companion attach for live pushes. The
// login gate + requireSession run BEFORE the upgrade (same gate as the HTTP routes):
// a caller without access to the session's show gets the masked 404 (show-grants D3). Each socket
// records its user; when that user loses access, the write that removed it closes the socket with
// 4403 after it commits (show-grants D20).

import type { Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import type { AppEnv } from '../appEnv';
import { requireSession, requireUser } from './_helpers';

export function mountSessionWs(app: Hono<AppEnv>, upgradeWebSocket: UpgradeWebSocket): void {
  app.get(
    '/api/sessions/:sessionId/ws',
    async (c, next) => {
      await requireSession(c, c.req.param('sessionId'), { includeHidden: true });
      await next();
    },
    // Hono awaits an async `createEvents` before upgrading, so the hub is opened first
    // (async-session-hub design D7); the socket callbacks below stay synchronous.
    upgradeWebSocket(async (c) => {
      const sessionId = c.req.param('sessionId');
      const role =
        new URL(c.req.url).searchParams.get('role') === 'companion' ? 'companion' : 'browser';
      const hub = await c.env.ports.sessions.get(sessionId);
      // The admitted user, recorded per socket so losing access closes it (show-grants D20).
      const userId = requireUser(c).id;
      return {
        onOpen(_evt, ws) {
          hub.attachSocket(ws, role, userId);
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
