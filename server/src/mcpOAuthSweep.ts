// The MCP OAuth cleanup loop (ADR 0035 decisions 16, 17; design
// docs/design/custom-session-dashboards.md section 4.9; mcp-authorization "Cleanup"). main.ts
// starts it only with `CUSTOM_DASHBOARDS_ENABLED` on, in every process, once a minute like the
// lease sweeper. Each tick runs `McpOAuthSweeper.sweepOnce` with the refresh grace window, which
// is the 30 s default until J3 adds `MCP_REFRESH_GRACE_SECONDS`. Warn-only: a failed tick logs its
// error kind and the next tick tries again.

import type { McpOAuthSweeper } from '@autologger/ports';
import { MCP_REFRESH_GRACE_DEFAULT_SECONDS } from '@autologger/storage';

export const MCP_SWEEP_INTERVAL_MS = 60_000;

const errorKind = (e: unknown): string => {
  const code = (e as { code?: unknown })?.code;
  return typeof code === 'string' ? code : e instanceof Error ? e.name : 'error';
};

/** One tick: never rejects. */
export async function sweepMcpOAuthOnce(
  sweeper: McpOAuthSweeper,
  warn: (msg: string) => void = console.warn,
  graceSeconds = MCP_REFRESH_GRACE_DEFAULT_SECONDS,
): Promise<void> {
  try {
    await sweeper.sweepOnce(graceSeconds);
  } catch (e) {
    warn(`autologger: mcp oauth sweep failed (${errorKind(e)})`);
  }
}

/** Starts the once-a-minute sweep; unref'd, and cleared by main.ts on shutdown. */
export function startMcpOAuthSweeper(
  sweeper: McpOAuthSweeper,
  warn: (msg: string) => void = console.warn,
  intervalMs = MCP_SWEEP_INTERVAL_MS,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    void sweepMcpOAuthOnce(sweeper, warn);
  }, intervalMs);
  timer.unref();
  return timer;
}
