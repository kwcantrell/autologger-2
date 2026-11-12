// The worker's production wiring (OpenSpec change `batch-autogenerate`, design D3-D5, D8): the
// store on the reviewed system binding, the initiator binder, the per-session gates as the
// initiator, the step operations over the shared runners, real timers and the app's Clock.

import { autogenerateWorkerCatalog, type CatalogFacade } from '@autologger/catalog';
import type { Bindings } from '../appEnv';
import { runFeatureAllowed } from '../env';
import { hubFor } from '../generation/principal';
import { initiatorBinder } from './principal';
import { workerSteps } from './steps';
import type { SessionGates, WorkerPorts } from './worker';

/** D5 steps 2-4 and D8's recording check, each as the initiator. */
export function workerGates(env: Bindings): SessionGates {
  return {
    async manages(p, teamId) {
      const role = await p.catalog.auth.authGetMembershipRole(p.user.id, teamId);
      return role === 'owner' || role === 'admin';
    },
    approved(p) {
      return runFeatureAllowed(env.config, p.user);
    },
    async session(p, sessionId, teamId) {
      // The same predicate as the session routes' masked 404 (`requireSession`), plus the team.
      const row = await p.catalog.sessions.getSessionIndexRow(sessionId, { includeHidden: true });
      if (row === null || Number(row.ui_hidden ?? 0) !== 0) return 'session-gone';
      const showId = row.show_id == null ? '' : String(row.show_id);
      if (!showId) return 'access-lost';
      const show = await p.catalog.shows.getShowRow(showId);
      if (show === null || String(show.studio_id) !== teamId) return 'access-lost';
      return (await p.catalog.auth.authCanAccessShow(p.user.id, showId)) ? 'ok' : 'access-lost';
    },
    async recording(p, sessionId) {
      return (await (await hubFor(p, sessionId)).leaseStatus()).lease_alive;
    },
  };
}

export interface WorkerPortOptions {
  env: Bindings;
  /** An unbound catalog from the composition root (`createCatalog`). */
  root: CatalogFacade;
  workerId: string;
  /** Test seams: the clock, the wait and the renewal timer. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  renewEvery?: WorkerPorts['renewEvery'];
}

export function createWorkerPorts(o: WorkerPortOptions): WorkerPorts {
  const binder = initiatorBinder(o.root, o.env);
  return {
    workerId: o.workerId,
    now: o.now ?? (() => o.env.ports.clock.now()),
    sleep:
      o.sleep ??
      ((ms) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms).unref?.();
        })),
    store: autogenerateWorkerCatalog(o.root).autogenerate,
    principal: (id) => binder.principal(id),
    bind: (id) => binder.bind(id),
    gates: workerGates(o.env),
    steps: workerSteps(),
    renewEvery:
      o.renewEvery ??
      ((ms, fn) => {
        const t = setInterval(() => {
          fn().catch((e: unknown) =>
            console.warn(`[autogenerate] lease renewal failed (${(e as Error)?.name ?? 'error'})`),
          );
        }, ms);
        t.unref?.();
        return () => clearInterval(t);
      }),
    log: (line) => console.info(line),
  };
}
