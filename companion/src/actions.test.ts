import { describe, expect, it, vi } from 'vitest';
import { type ActionHost, actionDefinitions } from './actions.js';
import { ApiError, type AutologgerApi } from './api.js';

function makeHost(api: Partial<AutologgerApi>): {
  host: ActionHost;
  logs: string[];
  refreshed: () => number;
} {
  const logs: string[] = [];
  let refreshed = 0;
  const host: ActionHost = {
    api: () => api as AutologgerApi,
    refreshNow: () => {
      refreshed++;
    },
    log: (level, msg) => logs.push(`${level}:${msg}`),
    parseVariablesInString: async (t) => t,
  };
  return { host, logs, refreshed: () => refreshed };
}

describe('transport action', () => {
  it('calls api.transport and refreshes on success', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const { host, refreshed } = makeHost({ transport });
    const defs = actionDefinitions(host, null);
    await defs.transport.callback({ options: { action: 'toggle' } } as never, {} as never);
    expect(transport).toHaveBeenCalledWith('toggle');
    expect(refreshed()).toBe(1);
  });

  it('logs a warn on 409 no_session and does not throw', async () => {
    const transport = vi.fn().mockRejectedValue(new ApiError('no_session', 'x', 409));
    const { host, logs } = makeHost({ transport });
    const defs = actionDefinitions(host, null);
    await defs.transport.callback({ options: { action: 'start' } } as never, {} as never);
    expect(logs.some((l) => l.startsWith('warn:'))).toBe(true);
  });
});

describe('log_event action', () => {
  it('logs a distinct warn on 400 bad_category', async () => {
    const log = vi.fn().mockRejectedValue(new ApiError('bad_category', 'x', 400));
    const { host, logs } = makeHost({ log });
    const defs = actionDefinitions(host, null);
    await defs.log_event.callback(
      { options: { category: 'c1', message: 'hi' } } as never,
      {} as never,
    );
    expect(logs.some((l) => l.startsWith('warn:') && /category/i.test(l))).toBe(true);
  });
});
