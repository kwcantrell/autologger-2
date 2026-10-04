// async-session-hub core-ports "No obscure failure on a closed hub" (scenario "A closed hub
// rejects instead of failing obscurely", design D6): a request that reaches a hub after it closed
// (for example one whose ROLLBACK failed) gets the routes' existing generic server error, and the
// logged error names the closed hub rather than the raw better-sqlite3 TypeError (spike A7).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { app, env } from '../test/harness';
import { seededSession } from '../test/helpers';

afterEach(() => vi.restoreAllMocks());

describe('a request on a closed session hub', () => {
  it('answers the generic 500 and logs SessionHubClosedError', async () => {
    const { sessionId } = await seededSession();
    const hub = await env.ports.sessions.get(sessionId);
    await (hub as unknown as { close(): Promise<void> }).close();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await app.request(`/api/sessions/${sessionId}/events`, {}, { ...env });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ detail: 'Internal Server Error' });
    const logged = log.mock.calls.flat().map((x) => (x instanceof Error ? x.name : String(x)));
    expect(logged).toContain('SessionHubClosedError');
    expect(logged).not.toContain('TypeError');
  });
});
