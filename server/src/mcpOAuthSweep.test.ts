// The MCP OAuth cleanup loop (design section 4.9): each tick sweeps with the 30 s default grace
// window, and a failure only warns, by error kind.
import type { McpOAuthSweeper } from '@autologger/ports';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startMcpOAuthSweeper, sweepMcpOAuthOnce } from './mcpOAuthSweep';

const RESULT = {
  accessTokens: 0,
  refreshTokens: 0,
  sealsCleared: 0,
  grants: 0,
  clients: 0,
  rateWindows: 0,
};

afterEach(() => {
  vi.useRealTimers();
});

describe('MCP OAuth sweep loop', () => {
  it('sweeps with the default 30 s grace window', async () => {
    const sweepOnce = vi.fn(async () => RESULT);
    const warn = vi.fn();
    await sweepMcpOAuthOnce({ sweepOnce }, warn);
    expect(sweepOnce).toHaveBeenCalledWith(30);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a failed tick warns with the error code only and does not reject', async () => {
    const sweeper: McpOAuthSweeper = {
      sweepOnce: async () => {
        throw Object.assign(new Error('secret detail tok_123'), { code: '57014' });
      },
    };
    const warn = vi.fn();
    await expect(sweepMcpOAuthOnce(sweeper, warn)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('autologger: mcp oauth sweep failed (57014)');
  });

  it('runs once a minute', async () => {
    vi.useFakeTimers();
    const sweepOnce = vi.fn(async () => RESULT);
    const timer = startMcpOAuthSweeper({ sweepOnce }, vi.fn());
    await vi.advanceTimersByTimeAsync(59_999);
    expect(sweepOnce).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sweepOnce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sweepOnce).toHaveBeenCalledTimes(2);
    clearInterval(timer);
  });
});
