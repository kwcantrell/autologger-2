// require-login D3: behind the login middleware a null user is an invariant violation, not a
// second login decision. The route helpers throw an internal error (the error handler answers 500
// and logs it), never an `ApiError(401)`; the 401 is decided once, in `authContext`.
import type { Context } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../appEnv';
import { ApiError } from '../httpError';
import {
  ACCESS_LOST_CLOSE_CODE,
  closeSocketsAfterAccessLoss,
  MissingPrincipalError,
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

// show-grants D20: the close runs after a committed write, so it never fails that write, and a
// failure anywhere in it closes every socket of the user (fail closed; one with access reconnects).
describe('closeSocketsAfterAccessLoss fails closed (show-grants D20)', () => {
  function closeContext(catalog: unknown) {
    const calls: unknown[][] = [];
    const vars: Record<string, unknown> = { catalog };
    const c = {
      get: (k: string) => vars[k],
      env: { ports: { sessions: { closeUserSockets: (...a: unknown[]) => (calls.push(a), 0) } } },
    } as unknown as Context<AppEnv>;
    return { c, calls };
  }
  const boom = () => {
    throw Object.assign(new Error('db down'), { code: '57P01' });
  };

  it('a failing show-id read closes all of the user’s sockets and does not throw', async () => {
    const { c, calls } = closeContext({});
    await closeSocketsAfterAccessLoss(c, 'user-m', async () => boom());
    expect(calls).toEqual([['user-m', 'all', ACCESS_LOST_CLOSE_CODE]]);
  });

  it('a failing access check closes all of the user’s sockets and does not throw', async () => {
    const { c, calls } = closeContext({ auth: { authCanAccessShow: async () => boom() } });
    await closeSocketsAfterAccessLoss(c, 'user-m', ['show-1']);
    expect(calls).toEqual([['user-m', 'all', ACCESS_LOST_CLOSE_CODE]]);
  });

  it('a show still accessible closes nothing', async () => {
    const { c, calls } = closeContext({
      auth: { authCanAccessShow: async () => true },
      sessions: {
        listSessionIdsForShows: async (shows: string[]) => (shows.length ? ['s-1'] : []),
      },
    });
    await closeSocketsAfterAccessLoss(c, 'user-m', async () => ['show-1']);
    expect(calls).toEqual([]);
  });
});
