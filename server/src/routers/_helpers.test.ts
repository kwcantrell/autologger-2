// require-login D3: behind the login middleware a null user is an invariant violation, not a
// second login decision. The route helpers throw an internal error (the error handler answers 500
// and logs it), never an `ApiError(401)`; the 401 is decided once, in `authContext`.
import type { CatalogFacade } from '@autologger/catalog';
import type { BusMessage, SessionFrameBus } from '@autologger/session-core';
import type { Context } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../appEnv';
import { ApiError } from '../httpError';
import {
  ACCESS_LOST_CLOSE_CODE,
  MissingPrincipalError,
  publishAccessLossInTx,
  publishClosesInTx,
  requireSession,
  requireUser,
} from './_helpers';

/** A context with no user whose catalog would serve any session as a visible member's. */
function anonymousContext(): Context<AppEnv> {
  const catalog = {
    sessions: {
      getSessionIndexRow: async (id: string) => ({ id, title: 'T' }),
      getSessionStudioId: async () => 'studio-1',
    },
    auth: { authUserHasStudio: async () => true },
  };
  const vars: Record<string, unknown> = { user: null, catalog, apiTokenAuth: false };
  return { get: (k: string) => vars[k] } as unknown as Context<AppEnv>;
}

describe('route helpers assert a principal (require-login D3)', () => {
  it('requireUser with a null user throws the internal error, not an ApiError(401)', () => {
    let thrown: unknown;
    try {
      requireUser(anonymousContext());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(MissingPrincipalError);
    expect(thrown).not.toBeInstanceOf(ApiError);
  });

  it('requireSession with a null user throws the internal error instead of skipping membership', async () => {
    let thrown: unknown;
    try {
      await requireSession(anonymousContext(), 'session-1');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(MissingPrincipalError);
    expect(thrown).not.toBeInstanceOf(ApiError);
  });

  it('requireUser returns the signed-in user', () => {
    const user = { id: 'u1', email: 'a@example.com' };
    const c = { get: (k: string) => (k === 'user' ? user : null) } as unknown as Context<AppEnv>;
    expect(requireUser(c)).toBe(user);
  });
});

// session-frame-bus D5 (show-grants D20): the close is published inside the revoking
// transaction, on its own handle, so a failure fails the revoke (no fail-closed fallback any more);
// a revoke of many sessions publishes closes of at most 150 session ids each.
describe('publishAccessLossInTx publishes in the revoking transaction (session-frame-bus D5)', () => {
  /** A bus recording what is published and through which handle statement. */
  function recordingBus() {
    const published: BusMessage[][] = [];
    const statements: unknown[][] = [];
    const bus: SessionFrameBus = {
      publishInTx: async (t, msgs) => {
        published.push([...msgs]);
        for (const _ of msgs) statements.push(await t.all('select pg_notify(?, ?)', 'ch', 'p'));
      },
      afterCommit: () => {},
      publishNow: async () => {},
    };
    return { bus, published, statements };
  }
  function txCatalog(over: Record<string, unknown>) {
    const notified: string[][] = [];
    const cat = {
      notify: async (channel: string, payload: string) => void notified.push([channel, payload]),
      ...over,
    } as unknown as CatalogFacade;
    return { cat, notified };
  }
  const boom = () => {
    throw Object.assign(new Error('db down'), { code: '57P01' });
  };

  it('closes the lost shows’ sessions with 4403, through the transaction’s notify', async () => {
    const { bus, published } = recordingBus();
    const { cat, notified } = txCatalog({
      auth: { authCanAccessShow: async (_u: string, show: string) => show === 'kept' },
      sessions: {
        listSessionIdsForShows: async (shows: string[]) => shows.map((s) => `${s}-session`),
      },
    });
    const msgs = await publishAccessLossInTx(cat, bus, 'user-m', ['lost', 'kept']);
    expect(msgs).toEqual([
      { k: 'close', u: 'user-m', s: ['lost-session'], c: ACCESS_LOST_CLOSE_CODE },
    ]);
    expect(published).toEqual([msgs]);
    expect(notified).toEqual([['ch', 'p']]);
  });

  it('splits 300 lost sessions into closes of 150', async () => {
    const { bus } = recordingBus();
    const ids = Array.from({ length: 301 }, (_, i) => `s-${i}`);
    const { cat } = txCatalog({
      auth: { authCanAccessShow: async () => false },
      sessions: { listSessionIdsForShows: async () => ids },
    });
    const msgs = await publishAccessLossInTx(cat, bus, 'user-m', ['show-1']);
    expect(msgs.map((m) => (m.k === 'close' && m.s !== 'all' ? m.s.length : 0))).toEqual([
      150, 150, 1,
    ]);
    expect(msgs.flatMap((m) => (m.k === 'close' && m.s !== 'all' ? m.s : []))).toEqual(ids);
  });

  it('a show still accessible publishes nothing', async () => {
    const { bus, published } = recordingBus();
    const { cat } = txCatalog({
      auth: { authCanAccessShow: async () => true },
      sessions: { listSessionIdsForShows: async (s: string[]) => (s.length ? ['s-1'] : []) },
    });
    expect(await publishAccessLossInTx(cat, bus, 'user-m', ['show-1'])).toEqual([]);
    expect(published).toEqual([]);
  });

  it('a failing access check or publish rejects, so the revoke fails; nothing closes all', async () => {
    const { bus } = recordingBus();
    const { cat } = txCatalog({ auth: { authCanAccessShow: async () => boom() } });
    await expect(publishAccessLossInTx(cat, bus, 'user-m', ['show-1'])).rejects.toThrow('db down');
    const failing: SessionFrameBus = { ...bus, publishInTx: async () => boom() };
    const { cat: lost } = txCatalog({
      auth: { authCanAccessShow: async () => false },
      sessions: { listSessionIdsForShows: async () => ['s-1'] },
    });
    await expect(publishAccessLossInTx(lost, failing, 'user-m', ['show-1'])).rejects.toThrow(
      'db down',
    );
  });

  it('publishClosesInTx (leave) closes the pre-listed sessions without a re-check', async () => {
    const { bus, published } = recordingBus();
    const { cat } = txCatalog({});
    const msgs = await publishClosesInTx(cat, bus, 'user-m', ['s-1', 's-2']);
    expect(msgs).toEqual([
      { k: 'close', u: 'user-m', s: ['s-1', 's-2'], c: ACCESS_LOST_CLOSE_CODE },
    ]);
    expect(published).toEqual([msgs]);
    expect(await publishClosesInTx(cat, bus, 'user-m', [])).toEqual([]);
  });
});
