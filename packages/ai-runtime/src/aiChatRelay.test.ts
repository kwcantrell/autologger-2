// ai-topics-chat (task 3.3, design D6) — the JSONL→SSE relay. PRIVACY/CONTRACT
// properties under test (gate-intent): thinking/signature content is NEVER
// relayed; the `--include-partial-messages` double-emit is deduped (only the
// full `assistant` message's text/tool_use, never the `stream_event` partial
// lines, become `delta`/`tool`); raw stdout/stderr/URLs never reach the
// client — only a fixed scrubbed `error.detail`; and every completed stream
// ends with exactly ONE terminal event (`done` XOR `error`).
//
// Two layers: (1) end-to-end against the REAL hermetic fake-claude fixture
// (task 3.1) via a real spawned process and a real pipe, covering the
// fixture's canned 2026-07-14-spike taxonomy; (2) a fake in-memory
// ChildProcess (real PassThrough streams, no real subprocess) for JSONL edge
// cases the fixture doesn't encode (unknown line types, multiple `result`
// lines, an `is_error:true` result).

import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AiChatSseEvent, relayAiChatTurn } from './aiChatRelay';
import { AI_RUNTIME_FIXTURES_DIR } from './fixturesDir';

const FIXTURE_PATH = join(AI_RUNTIME_FIXTURES_DIR, 'fake-claude.mjs');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ai-chat-relay-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Spawn the real fixture directly (bypassing spawnAiChatTurn's env/argv
 * lockdown — that's task 3.2's concern, not this relay's) so the relay is
 * exercised against a REAL pipe with the fixture's exact taxonomy. */
function spawnFixture(mode: string, argv: string[] = []): ChildProcess {
  const child = spawn(FIXTURE_PATH, argv, {
    cwd: dir,
    env: { ...process.env, FAKE_CLAUDE_MODE: mode },
  });
  child.stdin.write('relay test message');
  child.stdin.end();
  return child;
}

async function collect(
  child: ChildProcess,
): Promise<{ events: AiChatSseEvent[]; outcome: Awaited<ReturnType<typeof relayAiChatTurn>> }> {
  const events: AiChatSseEvent[] = [];
  const outcome = await relayAiChatTurn(child, (e) => {
    events.push(e);
  });
  return { events, outcome };
}

describe('relayAiChatTurn — end-to-end against the real fake-claude fixture', () => {
  it('success: relays tool then delta then done, deduped, no thinking, one terminal event', async () => {
    const { events, outcome } = await collect(spawnFixture('success'));

    expect(events).toEqual([
      { event: 'tool', data: { name: 'create_topic' } },
      { event: 'delta', data: { text: 'Created a fixture topic.' } },
      { event: 'done', data: { claude_session_id: 'fixture-cli-session-id' } },
    ]);
    expect(outcome).toEqual({ ok: true, claudeSessionId: 'fixture-cli-session-id' });

    // Dedup: exactly one delta despite the fixture's stream_event partial +
    // full-message double-emit of the identical text.
    expect(events.filter((e) => e.event === 'delta')).toHaveLength(1);
    // Privacy: no thinking/signature content anywhere in the relayed payload.
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('Checking existing topics');
    expect(serialized).not.toContain('fixture-signature');
    expect(serialized).not.toMatch(/thinking/i);
    // Exactly one terminal event.
    expect(events.filter((e) => e.event === 'done' || e.event === 'error')).toHaveLength(1);
  });

  it('honors --resume: the done event echoes the resumed id, not the fixture default', async () => {
    const { events, outcome } = await collect(
      spawnFixture('success', ['--resume', 'prior-turn-id']),
    );
    expect(outcome).toEqual({ ok: true, claudeSessionId: 'prior-turn-id' });
    expect(events.at(-1)).toEqual({ event: 'done', data: { claude_session_id: 'prior-turn-id' } });
  });

  it('exit-nonzero: exactly one scrubbed error event, no stdout to leak', async () => {
    const { events, outcome } = await collect(spawnFixture('exit-nonzero'));
    expect(events).toEqual([{ event: 'error', data: { detail: 'upstream-failed' } }]);
    expect(outcome).toEqual({ ok: false, detail: 'upstream-failed' });
  });

  it(
    'garbage: unparseable stdout lines never crash the relay; one scrubbed error, ' +
      'raw garbage text never relayed',
    async () => {
      const { events, outcome } = await collect(spawnFixture('garbage'));
      expect(events).toEqual([{ event: 'error', data: { detail: 'internal-error' } }]);
      expect(outcome).toEqual({ ok: false, detail: 'internal-error' });
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain('not json at all');
      expect(serialized).not.toContain('{{ this is not valid JSON');
    },
  );

  it(
    'not-logged-in: maps to the not-logged-in scrubbed detail, NEVER the raw stderr ' +
      'text or the device-login URL',
    async () => {
      const { events, outcome } = await collect(spawnFixture('not-logged-in'));
      expect(events).toEqual([{ event: 'error', data: { detail: 'not-logged-in' } }]);
      expect(outcome).toEqual({ ok: false, detail: 'not-logged-in' });
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain('claude.ai/login');
      expect(serialized).not.toContain('FIXTURE-DEVICE-CODE');
      expect(serialized).not.toContain('Invalid API key');
    },
  );

  it('every completed-stream scenario ends with exactly one terminal event (done XOR error)', async () => {
    for (const mode of ['success', 'exit-nonzero', 'garbage', 'not-logged-in']) {
      const { events } = await collect(spawnFixture(mode));
      const terminals = events.filter((e) => e.event === 'done' || e.event === 'error');
      expect(terminals).toHaveLength(1);
    }
  });
});

// ── Fake in-memory ChildProcess: JSONL edge cases the fixture doesn't encode ──

interface FakeChildOpts {
  exitCode?: number;
  stderr?: string;
  spawnError?: Error;
}

function fakeChild(lines: unknown[], opts: FakeChildOpts = {}): ChildProcess {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter() as unknown as ChildProcess & { exitCode: number | null };
  Object.assign(emitter, { stdout, stderr, exitCode: null });

  queueMicrotask(() => {
    if (opts.spawnError) {
      emitter.emit('error', opts.spawnError);
    }
    for (const l of lines) stdout.write(`${JSON.stringify(l)}\n`);
    stdout.end();
    if (opts.stderr) stderr.write(opts.stderr);
    stderr.end();
    emitter.exitCode = opts.exitCode ?? 0;
    emitter.emit('exit', opts.exitCode ?? 0);
  });

  return emitter;
}

const initLine = (sessionId = 's1') => ({ type: 'system', subtype: 'init', session_id: sessionId });
const resultLine = (overrides: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'ok',
  session_id: 's1',
  ...overrides,
});

describe('relayAiChatTurn — JSONL edge cases (fake in-memory child)', () => {
  it('ignores unrecognized top-level types (forward-compat with future CLI versions)', async () => {
    const { events, outcome } = await collect(
      fakeChild([
        initLine(),
        { type: 'a_brand_new_event_type_from_the_future', payload: 'whatever' },
        resultLine(),
      ]),
    );
    expect(events).toEqual([{ event: 'done', data: { claude_session_id: 's1' } }]);
    expect(outcome).toEqual({ ok: true, claudeSessionId: 's1' });
  });

  it('a thinking-only assistant message emits nothing (no delta, no tool)', async () => {
    const { events } = await collect(
      fakeChild([
        initLine(),
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: 'secret reasoning', signature: 'sig' }],
          },
        },
        resultLine(),
      ]),
    );
    expect(events).toEqual([{ event: 'done', data: { claude_session_id: 's1' } }]);
    expect(JSON.stringify(events)).not.toContain('secret reasoning');
  });

  it('a result with is_error:true maps to a scrubbed error, never a done event', async () => {
    const { events, outcome } = await collect(
      fakeChild([initLine(), resultLine({ is_error: true, result: 'internal CLI failure text' })]),
    );
    expect(events).toEqual([{ event: 'error', data: { detail: 'upstream-failed' } }]);
    expect(outcome).toEqual({ ok: false, detail: 'upstream-failed' });
    expect(JSON.stringify(events)).not.toContain('internal CLI failure text');
  });

  it('multiple terminal-triggering lines still produce exactly one terminal event', async () => {
    const { events } = await collect(
      fakeChild([initLine(), resultLine(), resultLine({ session_id: 's1-again' })]),
    );
    const terminals = events.filter((e) => e.event === 'done' || e.event === 'error');
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toEqual({ event: 'done', data: { claude_session_id: 's1' } });
  });

  it('a tool_use name without the mcp__autologger__ prefix is passed through unstripped', async () => {
    const { events } = await collect(
      fakeChild([
        initLine(),
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 't1', name: 'some_other_tool', input: {} }],
          },
        },
        resultLine(),
      ]),
    );
    expect(events[0]).toEqual({ event: 'tool', data: { name: 'some_other_tool' } });
  });

  it('a spawn error (e.g. ENOENT) maps to internal-error, never the raw error message', async () => {
    const { events, outcome } = await collect(
      fakeChild([], {
        spawnError: new Error('spawn /nonexistent ENOENT'),
        exitCode: null as unknown as number,
      }),
    );
    expect(events).toEqual([{ event: 'error', data: { detail: 'internal-error' } }]);
    expect(outcome).toEqual({ ok: false, detail: 'internal-error' });
    expect(JSON.stringify(events)).not.toContain('ENOENT');
  });

  it('a result missing any session id falls back to a scrubbed internal-error, never an empty done', async () => {
    const { events, outcome } = await collect(fakeChild([resultLine({ session_id: undefined })]));
    expect(events).toEqual([{ event: 'error', data: { detail: 'internal-error' } }]);
    expect(outcome).toEqual({ ok: false, detail: 'internal-error' });
  });

  it('stream_event lines are always dropped, even ones the fixture never emits (e.g. a lone text_delta)', async () => {
    const { events } = await collect(
      fakeChild([
        initLine(),
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'should never appear' },
          },
        },
        resultLine(),
      ]),
    );
    expect(events).toEqual([{ event: 'done', data: { claude_session_id: 's1' } }]);
  });
});
