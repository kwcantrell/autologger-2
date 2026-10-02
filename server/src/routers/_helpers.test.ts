// require-login D3: behind the login middleware a null user is an invariant violation, not a
// second login decision. The route helpers throw an internal error (the error handler answers 500
// and logs it), never an `ApiError(401)`; the 401 is decided once, in `authContext`.
import type { Context } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../appEnv';
import { ApiError } from '../httpError';
import { MissingPrincipalError, requireSession, requireUser } from './_helpers';

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
