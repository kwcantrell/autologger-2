// src/node/nextFrontend.ts — wraps Next.js as the `frontend` seam the Hono
// bridge (app.ts) and the raw-server upgrade dispatcher (main.ts, task 3.3)
// consume (nextjs-frontend-migration, design D1). Boots `next({ dev, dir })`
// + `prepare()` once at startup; exposes `{ handle, upgradeHandler, close }`.
//
// Boot-ordering contract (design D1 "Boot ordering", spec "API-only fallback
// mode and boot ordering"):
//   - prod with no `web/.next` build present → `createNextFrontend` resolves
//     `null` (API-only mode); the caller never invokes the `next` factory at
//     all in this case.
//   - a `prepare()` REJECTION with the build directory PRESENT is NOT caught
//     here — it propagates to the caller so the boot fails loudly. A corrupt
//     or truncated build is a broken deploy, not a missing frontend, and
//     must never silently degrade to API-only.
//   - dev mode always prepares (no build-presence check — `next dev` builds
//     on demand).
//
// The `next` factory is injected (`nextFactory`) so unit tests can exercise
// the missing-build and corrupt-build decision paths against a fake without
// ever booting real Next (see nextFrontend.test.ts). The real factory is
// loaded via `createRequire`, never a static or dynamic `import` of the
// `next` package — deliberately, not just for laziness: `next`'s own type
// declarations (`next/types/global.d.ts`) globally augment
// `NodeJS.ProcessEnv` to make `NODE_ENV` a required member, which — because
// TS ambient augmentations are program-wide, not module-scoped — breaks
// `Record<string, string>`-typed `child_process.spawn` env objects
// elsewhere in this program (`@autologger/ai-runtime`,
// `@autologger/media-import`) the moment any file resolves `next`'s type
// declarations, even via `import type` or a type-only dynamic `import()`.
// `require()`'s return type is untyped (`any`), so it never resolves next's
// `.d.ts` at all. This module therefore defines its own structural
// `NextAppLike` shape instead of importing Next's `NextWrapperServer` type.

import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';

/** The subset of Next's `NextWrapperServer` (`next/dist/server/next.d.ts`)
 * this module depends on — kept structural (not imported from `next`) so
 * this file never triggers TS resolution of `next`'s ambient global
 * augmentations (see the module header). */
export interface NextAppLike {
  prepare(): Promise<void>;
  getRequestHandler(): (
    incoming: IncomingMessage,
    outgoing: ServerResponse,
  ) => Promise<void>;
  getUpgradeHandler(): (req: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>;
  close(): Promise<void>;
}

export type NextFactory = (opts: {
  dev: boolean;
  dir: string;
  /** See `noOpUpgradeServer` below — always passed by `createNextFrontend`. */
  httpServer?: unknown;
}) => NextAppLike;

/** A no-op stand-in for Next's `options.httpServer` constructor option
 * (drive-by fix, task 3.4's phase-gate e2e run — nextjs-frontend-migration).
 *
 * Symptom: every REAL browser WebSocket to `/api/sessions/:id/ws` failed
 * immediately with close code 1006 ("Live updates unavailable") once the
 * server ran with `NODE_ENV=production` (the correct prod posture — see
 * `server/package.json`'s `start` script, fixed alongside this). A raw `ws`
 * package script hitting the same URL in isolation usually succeeded, which
 * masked the bug in task 3.1-3.3's manual real-server probes.
 *
 * Root cause, traced via the real `next@15.5.23` CJS source
 * (`next/dist/server/next.js`, `NextCustomServer`): `getRequestHandler()`
 * returns a wrapper that, on its FIRST invocation, calls
 * `setupWebSocketHandler(this.options.httpServer, req)` as an undocumented
 * side effect. That method does `customServer.on('upgrade', (req, socket,
 * head) => this.upgradeHandler(req, socket, head))` — registering NEXT'S
 * OWN 'upgrade' listener — falling back to `req.socket.server` (the REAL
 * raw `http.Server` `main.ts`'s `installUpgradeDispatcher` already owns
 * exclusively) whenever `options.httpServer` is absent, which it always was
 * here. Since `frontend.handle()` (this module's HTTP bridge) calls exactly
 * that wrapper for every non-API GET the Hono catch-all forwards, the very
 * first shell/asset request served after boot silently attaches a SECOND,
 * independent 'upgrade' listener to the shared server. From then on, every
 * upgrade event fires BOTH listeners: ours (which correctly routes `/api/*`
 * to the captured Hono handler) AND Next's own
 * (`next/dist/server/lib/router-server.js`'s `upgradeHandler`), which knows
 * nothing about our `/api` convention — it resolves the request against
 * NEXT'S OWN route table, where the catch-all shell route (`app/(index)/
 * [[...path]]/page.page.tsx`) matches literally any unmatched path,
 * including `/api/sessions/:id/ws`. A truthy `matchedOutput` makes Next's
 * handler call `socket.end()` on OUR socket mid-handshake, racing the Hono
 * upgrade replay already in flight; `ws`'s own `completeUpgrade()` then
 * finds the now-non-writable socket and self-destroys it — the observed
 * 1006. This has nothing to do with `dev`/prod routing decisions in
 * `upgradeDispatch.ts`, which never calls `frontend.upgradeHandler` for an
 * `/api/*` path; Next attaches its interfering listener entirely on its
 * own, independently of anything this codebase's dispatcher decides.
 *
 * Fix: pass a stub here so Next's self-attach lands on this inert object
 * instead of falling back to the real server — the exact same "capture a
 * would-be listener on a throwaway object instead of letting it land on the
 * real server" technique `upgradeDispatch.ts`'s `captureHonoUpgradeHandler`
 * already uses for Hono's own would-be listener (same problem shape, two
 * independent libraries that both assume they may freely self-attach). */
interface NoOpUpgradeServer {
  on(event: string, listener: (...args: unknown[]) => void): void;
}
const noOpUpgradeServer: NoOpUpgradeServer = {
  on() {
    // Deliberately inert — see the doc comment above.
  },
};

export interface NextFrontend {
  /** Answers one HTTP request over the raw Node req/res pair — the bridge's
   * entire contract with app.ts: by the time this resolves, the response has
   * been fully written. */
  handle(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void>;
  /** Next's raw-socket upgrade handler, for the dev-HMR path of the
   * `server.on('upgrade')` dispatcher main.ts installs (task 3.3). Not used
   * by the HTTP bridge. */
  upgradeHandler(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>;
  close(): Promise<void>;
}

export interface CreateNextFrontendOpts {
  dev: boolean;
  /** The Next app directory (repo's `web/`) — its `.next/` subdirectory is
   * the prod build-presence check. */
  dir: string;
  /** Injected for tests; defaults to the real `next` package. */
  nextFactory?: NextFactory;
}

/** True when a production boot should skip Next entirely and run API-only:
 * no build output present under `<dir>/.next`. Dev mode is never API-only
 * (`next dev` compiles on demand). Exported standalone — and depending on
 * nothing but the filesystem — so the boot decision is unit-testable without
 * booting real Next or even touching the injected factory. */
export function isApiOnly(opts: { dev: boolean; dir: string }): boolean {
  if (opts.dev) return false;
  return !existsSync(join(opts.dir, '.next'));
}

// `require`'s type (`NodeRequire['(id: string) => any']`) is untyped, so
// this never asks TS to resolve `next`'s declaration files — see the module
// header for why that matters.
const nodeRequire = createRequire(import.meta.url);

let cachedRealFactory: NextFactory | undefined;
function loadRealNextFactory(): NextFactory {
  if (!cachedRealFactory) {
    // Bug found + fixed in task 3.3 (nextjs-frontend-migration), while
    // booting a real `next` package for this migration's required
    // post-`prepare()` global-`fetch` verification: the task 3.1 comment
    // this replaced claimed `next`'s CJS module exports `{ NextServer,
    // default: createServer }`, citing the `.d.ts`'s `export default`
    // syntax — but that TS declaration shape describes how an ESM
    // `import`/esModuleInterop-compiled consumer SEES the module, not what
    // the actual runtime `module.exports` value is. `next`'s real CJS
    // runtime (verified against the installed next@15.5.23
    // `dist/server/next.js`) does `module.exports = createServer` — a bare
    // function, no `NextServer` property, no `.default` wrapper. A raw
    // `require()` via `createRequire` (no esModuleInterop synthesis — that
    // only happens for `import`/TS-compiled ESM) therefore returns the
    // factory function itself. This was unreachable in task 3.1's own unit
    // tests (which always inject a fake `nextFactory`, per design, and never
    // exercise this real-package path) and broke every real Next boot
    // (`TypeError: factory is not a function`) until caught here. Handle
    // both shapes defensively — in case some other resolution path DOES
    // synthesize `.default` — rather than assuming either unconditionally.
    const mod = nodeRequire('next') as NextFactory | { default: NextFactory };
    cachedRealFactory = typeof mod === 'function' ? mod : mod.default;
  }
  return cachedRealFactory;
}

/** Boots the Next.js frontend, or decides API-only mode. See the module
 * header for the full boot-ordering contract. Callers (main.ts, task 3.3)
 * MUST await this before `serve()` starts accepting connections, and MUST
 * NOT catch a rejection here — it is the fail-loud path. */
export async function createNextFrontend(
  opts: CreateNextFrontendOpts,
): Promise<NextFrontend | null> {
  if (isApiOnly(opts)) return null;
  const factory = opts.nextFactory ?? loadRealNextFactory();
  const app: NextAppLike = factory({
    dev: opts.dev,
    dir: opts.dir,
    httpServer: noOpUpgradeServer,
  });
  await app.prepare(); // rejection propagates — fail the boot loudly (see header)
  const requestHandler = app.getRequestHandler();
  const upgradeHandler = app.getUpgradeHandler();
  return {
    handle: (incoming, outgoing) => requestHandler(incoming, outgoing),
    upgradeHandler: (req, socket, head) => upgradeHandler(req, socket, head),
    close: () => app.close(),
  };
}
