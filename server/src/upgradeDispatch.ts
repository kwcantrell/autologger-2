// src/upgradeDispatch.ts — the single `server.on('upgrade')` path dispatcher
// (nextjs-frontend-migration, design D1 "Upgrade dispatch"; spec "WebSocket
// upgrade dispatch"). Wired by main.ts (task 3.3). Root-level file, not
// `node/` — `server/src/node/`'s membership is name-pinned to exactly
// config.ts/systemClock.ts/presence.ts/nextFrontend.ts
// (`packageBoundaries.repo.test.ts`), and this file is dispatcher plumbing
// for main.ts, not composition-root construction; it lives alongside
// main.ts/app.ts/appEnv.ts, which that same test already treats as
// composition-root/test-infra root-level files, not graph nodes.
//
// Why a stub-capture instead of registering Hono's upgrade handler directly
// on the real server: `@hono/node-ws`'s `injectWebSocket(server)` (verified
// against the installed 1.3.1 dist source) does exactly one thing —
// `server.on('upgrade', handler)` — and touches no other property of
// `server`. Handing it a stub `{ on(event, handler) }` object instead of the
// real Node server captures that listener function without ever installing
// it, so main.ts can install exactly ONE real `upgrade` listener on the real
// server: this dispatcher, which routes by path (and, for non-`/api` paths,
// by the same IP-allowlist decision the HTTP middleware applies) to either
// the captured Hono handler or Next's upgrade handler, or destroys the
// socket.

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Config } from './appEnv';
import { isClientIpAllowed } from './middleware/ipAllowlist';
import type { NextFrontend } from './node/nextFrontend';

/** A server-like object exposing only what `@hono/node-ws`'s
 * `injectWebSocket` actually calls — used both to type the stub passed to
 * `injectWebSocket` (captures Hono's handler without installing it) and the
 * real server this module installs its own listener on. */
export interface UpgradeCapableServer {
  on(event: 'upgrade', handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): void;
}

/** Captures the `server.on('upgrade', handler)` listener `injectWebSocket`
 * would otherwise install on the real server, without installing it — see
 * the module header. Generic over `S` (the real `@hono/node-ws` signature is
 * `(server: Server | Http2Server | Http2SecureServer) => void`, none of
 * which `UpgradeCapableServer` is assignable FROM under TS's contravariant
 * function-parameter check) — the stub is cast to whatever `S` the caller's
 * `injectWebSocket` actually expects, rather than widening this module's own
 * `UpgradeCapableServer` shape to match `net`/`http2`'s much larger surface.
 * Returns the captured handler (or throws if `injectWebSocket` never called
 * `.on('upgrade', ...)`, which would itself be a signal something about the
 * installed `@hono/node-ws` version changed). */
export function captureHonoUpgradeHandler<S>(
  injectWebSocket: (server: S) => void,
): (req: IncomingMessage, socket: Duplex, head: Buffer) => void {
  let captured: ((req: IncomingMessage, socket: Duplex, head: Buffer) => void) | undefined;
  const stub: UpgradeCapableServer = {
    on(event, handler) {
      if (event === 'upgrade') captured = handler;
    },
  };
  injectWebSocket(stub as S);
  if (!captured) {
    throw new Error(
      'upgradeDispatch: injectWebSocket never registered an "upgrade" listener on the ' +
        'stub server — @hono/node-ws may have changed how it wires upgrades; see the ' +
        'module header for the verified 1.3.1 behavior this depends on.',
    );
  }
  return captured;
}

export type UpgradeRoute = 'api' | 'frontend' | 'destroy';

/** Pure routing decision — no I/O, no socket/server access. `allowed` is the
 * caller's already-computed IP-allowlist result for the socket's remote
 * address (see `isClientIpAllowed`); this function does not compute it, so
 * it stays testable with plain booleans. Mirrors design D1 exactly: `/api/*`
 * always goes to Hono (the allowlist decision is irrelevant there — Hono's
 * own middleware chain, unchanged, covers it); everything else is destroyed
 * unless the allowlist decision passes AND the server is in dev mode with a
 * live frontend upgrade handler available (prod always destroys non-`/api`
 * upgrades, regardless of the allowlist outcome, per design D1/D6.5). */
export function decideUpgradeRoute(opts: {
  path: string;
  dev: boolean;
  frontendAvailable: boolean;
  allowed: boolean;
}): UpgradeRoute {
  if (opts.path === '/api' || opts.path.startsWith('/api/')) return 'api';
  if (!opts.allowed) return 'destroy';
  if (opts.dev && opts.frontendAvailable) return 'frontend';
  return 'destroy';
}

function firstForwardedFor(req: IncomingMessage): string | undefined {
  const raw = req.headers['x-forwarded-for'];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

/** Installs the one real `server.on('upgrade', ...)` listener that
 * dispatches every upgrade request by path (spec "WebSocket upgrade
 * dispatch"). `honoUpgrade` is the handler `captureHonoUpgradeHandler`
 * captured; `frontend` is `null`/`undefined` in API-only mode or when no
 * frontend was constructed (e.g. HTTP-only test callers) — those upgrades
 * are destroyed exactly like a production non-`/api` upgrade, never thrown. */
export function installUpgradeDispatcher(opts: {
  server: UpgradeCapableServer;
  honoUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  frontend: NextFrontend | null | undefined;
  dev: boolean;
  config: Config;
}): void {
  opts.server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/api' || path.startsWith('/api/')) {
      opts.honoUpgrade(req, socket, head);
      return;
    }

    let allowed: boolean;
    try {
      allowed = isClientIpAllowed({
        config: opts.config,
        remoteAddress: req.socket?.remoteAddress,
        forwardedForHeader: firstForwardedFor(req),
      });
    } catch (err) {
      // Malformed IP_ALLOWLIST — the HTTP path surfaces this as a 500 via
      // Hono's onError; there is no response to compose on a raw upgrade
      // socket, so fail closed (destroy) and log, matching the "when in
      // doubt, destroy" posture of every other non-`/api` branch here.
      console.error('upgradeDispatch: IP_ALLOWLIST decision failed', err);
      socket.destroy();
      return;
    }

    const route = decideUpgradeRoute({
      path,
      dev: opts.dev,
      frontendAvailable: !!opts.frontend,
      allowed,
    });

    if (route === 'frontend' && opts.frontend) {
      opts.frontend.upgradeHandler(req, socket, head).catch((err) => {
        console.error('upgradeDispatch: frontend upgrade handler rejected', err);
        socket.destroy();
      });
      return;
    }
    socket.destroy();
  });
}
