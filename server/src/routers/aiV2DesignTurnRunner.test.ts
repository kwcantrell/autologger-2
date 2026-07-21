// ai-v2-dashboards (tasks 2.5 + 2.6) — the turn runner + SSE relay + lifecycle.
// Hermetic: fake async iterators for the relay/terminal/abort behavior, and
// real detached child processes for the no-orphan kill-ladder proof. No live
// SDK turn, no Anthropic spend.
//
// 2.5 — assistant text only (never reasoning/thinking/tool_use); exactly one
//        terminal event per completed stream; a client abort emits none.
// 2.6 — the timeout backstop is INDEPENDENT of the agent iterator (a turn that
//        never yields still ends and releases its slot); no orphan survives an
//        abort OR a timeout — the SIGKILL rung fires against a SIGTERM-ignoring
//        child, proven via a real process and its exit signal.

import { type ChildProcess, spawn } from 'node:child_process';
import type { SDKMessage, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { AGGREGATE_MCP_SERVER_NAME } from '../aiV2/mcpTools';
import {
  buildDesignTurnCanUseTool,
  createDesignTurnSpawner,
  designTurnGroupAlive,
  type DesignTurnSseEvent,
  killDesignTurnProcessGroup,
  runDesignTurn,
} from './aiV2SdkSpawn';

// ── helpers ────────────────────────────────────────────────────────────────

async function* fromMessages(messages: SDKMessage[]): AsyncGenerator<SDKMessage> {
  for (const m of messages) yield m;
}

/** An iterator whose `next()` never resolves — models a turn that never yields
 * and never terminates on its own (spec: "A turn that never yields still
 * ends"). It also ignores abort, which is the worst case the timeout backstop
 * must survive. */
function neverYieldingQuery(): AsyncIterable<SDKMessage> {
  return {
    [Symbol.asyncIterator]() {
      return { next: () => new Promise<IteratorResult<SDKMessage>>(() => {}) };
    },
  };
}

function assistant(...blocks: Array<Record<string, unknown>>): SDKMessage {
  return { type: 'assistant', message: { content: blocks } } as unknown as SDKMessage;
}
const resultSuccess = { type: 'result', subtype: 'success', is_error: false } as unknown as SDKMessage;
const resultError = { type: 'result', subtype: 'error', is_error: true } as unknown as SDKMessage;

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(msg)), ms)),
  ]);
}

const spawnedChildren: ChildProcess[] = [];

/** Wait until the child has printed its `ready` marker on stdout — i.e. its
 * inline script has actually executed (and, for IGNORE_SIGTERM, registered its
 * handler) — before any signal is sent. Without this, `node -e` startup races
 * the SIGTERM: the handler isn't installed yet, node's default disposition
 * kills the child on SIGTERM, and the SIGKILL rung never gets exercised. */
function spawnDetachedReady(script: string): { child: ChildProcess; ready: Promise<void> } {
  const child = spawn(process.execPath, ['-e', script], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  spawnedChildren.push(child);
  const ready = new Promise<void>((resolve) => {
    child.stdout?.on('data', (buf: Buffer) => {
      if (buf.toString().includes('ready')) resolve();
    });
  });
  return { child, ready };
}
// Registers a no-op SIGTERM handler, THEN announces readiness — so a SIGTERM
// arriving after `ready` is genuinely ignored, forcing the SIGKILL rung.
const IGNORE_SIGTERM = "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1e9);";
const OBEY_SIGTERM = "console.log('ready'); setInterval(()=>{},1e9);";

afterEach(() => {
  // Belt-and-braces: SIGKILL any child a failing test left alive.
  for (const child of spawnedChildren.splice(0)) {
    if (child.pid != null) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
});

const NOOP_TERMINATE = async (): Promise<void> => {};
const NOOP_RELEASE = (): void => {};

// ── 2.5 — SSE relay ─────────────────────────────────────────────────────────

describe('runDesignTurn — SSE relay (task 2.5)', () => {
  it('relays assistant TEXT only — never thinking/tool_use — and emits exactly one done', async () => {
    const events: DesignTurnSseEvent[] = [];
    const outcome = await runDesignTurn({
      query: fromMessages([
        assistant(
          { type: 'thinking', thinking: 'SECRET model reasoning' },
          { type: 'text', text: 'Hello' },
          { type: 'tool_use', name: 'mcp__autologger-aggregates__speaker_stats', input: {} },
          { type: 'text', text: 'world' },
        ),
        resultSuccess,
      ]),
      emit: (e) => {
        events.push(e);
      },
      timeoutMs: 60_000,
      abortController: new AbortController(),
      terminate: NOOP_TERMINATE,
      release: NOOP_RELEASE,
    });

    expect(outcome).toEqual({ ok: true });
    expect(events.filter((e) => e.event === 'delta').map((e) => e.data.text)).toEqual(['Hello', 'world']);
    expect(events.filter((e) => e.event === 'done')).toHaveLength(1);
    expect(events.filter((e) => e.event === 'error')).toHaveLength(0);
    // No reasoning or tool metadata leaked to the client.
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('SECRET model reasoning');
    expect(serialized).not.toContain('speaker_stats');
  });

  it('maps a CLI-signaled result error to exactly one scrubbed error event', async () => {
    const events: DesignTurnSseEvent[] = [];
    const outcome = await runDesignTurn({
      query: fromMessages([assistant({ type: 'text', text: 'partial' }), resultError]),
      emit: (e) => {
        events.push(e);
      },
      timeoutMs: 60_000,
      abortController: new AbortController(),
      terminate: NOOP_TERMINATE,
      release: NOOP_RELEASE,
    });
    expect(outcome).toEqual({ ok: false, detail: 'upstream-failed' });
    const terminals = events.filter((e) => e.event === 'done' || e.event === 'error');
    expect(terminals).toEqual([{ event: 'error', data: { detail: 'upstream-failed' } }]);
  });

  it('a relay terminal arriving AFTER a timeout is suppressed — exactly one terminal', async () => {
    const events: DesignTurnSseEvent[] = [];
    // Yields its success result only after a delay longer than the timeout, so
    // the timeout wins first and the late `done` must be dropped.
    async function* slowQuery(): AsyncGenerator<SDKMessage> {
      await new Promise((r) => setTimeout(r, 200));
      yield resultSuccess;
    }
    const outcome = await runDesignTurn({
      query: slowQuery(),
      emit: (e) => {
        events.push(e);
      },
      timeoutMs: 30,
      abortController: new AbortController(),
      terminate: NOOP_TERMINATE,
      release: NOOP_RELEASE,
      killGraceMs: 10,
    });
    expect(outcome).toEqual({ ok: false, detail: 'timeout' });
    // Give the slow relay time to (try to) emit its late done.
    await new Promise((r) => setTimeout(r, 250));
    const terminals = events.filter((e) => e.event === 'done' || e.event === 'error');
    expect(terminals).toEqual([{ event: 'error', data: { detail: 'timeout' } }]);
  });

  it('a client abort emits NO terminal event', async () => {
    const events: DesignTurnSseEvent[] = [];
    const abortController = new AbortController();
    const outcome = await runDesignTurn({
      query: neverYieldingQuery(),
      emit: (e) => {
        events.push(e);
      },
      timeoutMs: 5_000,
      abortController,
      terminate: NOOP_TERMINATE,
      release: NOOP_RELEASE,
      abortSignal: AbortSignal.abort(), // already-disconnected client
    });
    expect(outcome).toEqual({ ok: false, detail: 'aborted' });
    expect(events).toHaveLength(0);
    expect(abortController.signal.aborted).toBe(true);
  });
});

// ── 2.6 — lifecycle ─────────────────────────────────────────────────────────

describe('runDesignTurn — lifecycle (task 2.6)', () => {
  it('a never-yielding iterator still ends: timeout fires, child terminated, slot released', async () => {
    const events: DesignTurnSseEvent[] = [];
    let released = false;
    let terminated = false;
    const abortController = new AbortController();

    const outcome = await withTimeout(
      runDesignTurn({
        query: neverYieldingQuery(),
        emit: (e) => {
          events.push(e);
        },
        timeoutMs: 30,
        abortController,
        terminate: async () => {
          terminated = true;
        },
        release: () => {
          released = true;
        },
        killGraceMs: 10,
      }),
      3000,
      'runDesignTurn never ended for a never-yielding iterator',
    );

    expect(outcome).toEqual({ ok: false, detail: 'timeout' });
    expect(released).toBe(true); // slot released on the finally path
    expect(terminated).toBe(true); // child group terminated
    expect(abortController.signal.aborted).toBe(true); // the turn was aborted
    expect(events).toEqual([{ event: 'error', data: { detail: 'timeout' } }]);
  });

  it('releases the slot on a clean completion too (finally on every path)', async () => {
    let released = false;
    await runDesignTurn({
      query: fromMessages([assistant({ type: 'text', text: 'ok' }), resultSuccess]),
      emit: () => {},
      timeoutMs: 60_000,
      abortController: new AbortController(),
      terminate: NOOP_TERMINATE,
      release: () => {
        released = true;
      },
    });
    expect(released).toBe(true);
  });

  it('no orphan: the SIGKILL rung fires against a SIGTERM-ignoring child', async () => {
    const { child, ready } = spawnDetachedReady(IGNORE_SIGTERM);
    await ready;
    const pgid = child.pid;
    if (pgid == null) throw new Error('child has no pid');
    const exitSignal = new Promise<NodeJS.Signals | null>((res) => child.once('exit', (_c, s) => res(s)));

    expect(designTurnGroupAlive(pgid)).toBe(true);
    await killDesignTurnProcessGroup(pgid, 150);

    const signal = await withTimeout(exitSignal, 5000, 'SIGTERM-ignoring child never exited');
    expect(signal).toBe('SIGKILL'); // SIGTERM was ignored → the SIGKILL rung fired
    expect(designTurnGroupAlive(pgid)).toBe(false); // ps-independent: no survivor
  });

  it('no over-kill: a well-behaved child dies at the SIGTERM rung, SIGKILL never sent', async () => {
    const { child, ready } = spawnDetachedReady(OBEY_SIGTERM);
    await ready;
    const pgid = child.pid;
    if (pgid == null) throw new Error('child has no pid');
    const exitSignal = new Promise<NodeJS.Signals | null>((res) => child.once('exit', (_c, s) => res(s)));

    await killDesignTurnProcessGroup(pgid, 3000);
    const signal = await withTimeout(exitSignal, 5000, 'child never exited');
    expect(signal).toBe('SIGTERM');
  });

  it('createDesignTurnSpawner.terminate kills the detached group it spawned (end-to-end, no orphan)', async () => {
    const spawner = createDesignTurnSpawner();
    const proc = spawner.spawnClaudeCodeProcess({
      command: process.execPath,
      args: ['-e', IGNORE_SIGTERM],
      env: { PATH: process.env.PATH ?? '' },
      signal: new AbortController().signal,
    } as SpawnOptions);
    // The returned SpawnedProcess is a real ChildProcess.
    const child = proc as unknown as ChildProcess;
    spawnedChildren.push(child);
    // Wait for the child's `ready` marker so its SIGTERM handler is installed
    // before terminate() signals (see spawnDetachedReady's note on the race).
    await new Promise<void>((res) => {
      child.stdout?.on('data', (buf: Buffer) => {
        if (buf.toString().includes('ready')) res();
      });
    });
    const pgid = spawner.getPgid();
    if (pgid == null) throw new Error('spawner captured no pgid');
    const exitSignal = new Promise<NodeJS.Signals | null>((res) => child.once('exit', (_c, s) => res(s)));

    expect(designTurnGroupAlive(pgid)).toBe(true);
    await spawner.terminate(150);

    const signal = await withTimeout(exitSignal, 5000, 'spawned child never exited');
    expect(signal).toBe('SIGKILL');
    expect(designTurnGroupAlive(pgid)).toBe(false);
    // terminate is idempotent — a second call is a harmless no-op.
    await spawner.terminate(150);
  });
});

// ── canUseTool (design D7; the callback the 'plan' permission mode routes to) ─

describe('buildDesignTurnCanUseTool — the design turn permission callback', () => {
  const opts = {} as Parameters<ReturnType<typeof buildDesignTurnCanUseTool>>[2];

  it('allows the session-scoped aggregate MCP tools', async () => {
    const canUseTool = buildDesignTurnCanUseTool();
    for (const name of ['speaker_stats', 'transcript_excerpt', 'event_stats']) {
      const result = await canUseTool(`mcp__${AGGREGATE_MCP_SERVER_NAME}__${name}`, { x: 1 }, opts);
      expect(result).toMatchObject({ behavior: 'allow' });
    }
  });

  it('denies the write/exec built-ins (default-deny, in addition to their absence from `tools`)', async () => {
    const canUseTool = buildDesignTurnCanUseTool();
    for (const name of ['Bash', 'Write', 'Read', 'WebFetch']) {
      expect(await canUseTool(name, {}, opts)).toMatchObject({ behavior: 'deny' });
    }
  });

  it('denies AskUserQuestion until Phase 3 injects the pending-question relay', async () => {
    const canUseTool = buildDesignTurnCanUseTool();
    expect(await canUseTool('AskUserQuestion', {}, opts)).toMatchObject({ behavior: 'deny' });
  });

  it('delegates AskUserQuestion to the injected handler when present (Phase 3 seam)', async () => {
    let seen: Record<string, unknown> | null = null;
    const canUseTool = buildDesignTurnCanUseTool({
      onQuestion: async (input) => {
        seen = input;
        return { behavior: 'allow', updatedInput: input };
      },
    });
    const result = await canUseTool('AskUserQuestion', { question: 'q' }, opts);
    expect(result).toMatchObject({ behavior: 'allow' });
    expect(seen).toEqual({ question: 'q' });
  });

  it('passes ToolSearch/ExitPlanMode through as a NAMED allowance (defensive; not required to fire)', async () => {
    const canUseTool = buildDesignTurnCanUseTool();
    expect(await canUseTool('ToolSearch', {}, opts)).toMatchObject({ behavior: 'allow' });
    expect(await canUseTool('ExitPlanMode', {}, opts)).toMatchObject({ behavior: 'allow' });
  });
});
