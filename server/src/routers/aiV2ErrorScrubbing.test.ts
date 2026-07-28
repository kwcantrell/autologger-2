// ai-v2-dashboards (task 2.8) — terminal-`error` scrubbing. `guardedEmit`
// (aiV2SdkSpawn.ts's `runDesignTurn`) is the single choke point every
// client-visible SSE event passes through; `scrubDesignTurnEvent` is its
// enforcement. Raw exception text, subprocess stderr, and an agent's own
// `errors: string[]` array (SDKResultError) must NEVER reach `{ detail }` —
// only the fixed four-literal allow-list may. This is a structural
// guarantee (an allow-list rebuild of the event), not merely a hope that
// every call site stays careful.
//
// TDD: written against a checkout with NO `scrubDesignTurnEvent` export and
// NO scrubbing wired into `guardedEmit` — every test below failed RED
// (either a missing-export TypeScript/runtime error, or a leaked raw string
// making it into the emitted event) before the choke point was added; see
// the task report for the exact RED transcript.

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { type DesignTurnSseEvent, runDesignTurn, scrubDesignTurnEvent } from './aiV2SdkSpawn';

const NOOP_TERMINATE = async (): Promise<void> => {};
const NOOP_RELEASE = (): void => {};

// A secret-shaped needle that must never appear in anything emitted to the
// client, however it's smuggled in (exception message, stderr text, or an
// agent error array entry).
const SECRET = 'ANTHROPIC_API_KEY=sk-ant-leaked-1234 at /home/kalen/.ssh/id_rsa';

describe('scrubDesignTurnEvent — the allow-list enforcement (task 2.8)', () => {
  it('passes non-error events through unchanged', () => {
    const delta: DesignTurnSseEvent = { event: 'delta', data: { text: 'hello' } };
    expect(scrubDesignTurnEvent(delta)).toEqual(delta);
    const done: DesignTurnSseEvent = { event: 'done', data: {} };
    expect(scrubDesignTurnEvent(done)).toEqual(done);
  });

  it('passes an error event whose detail is already one of the four allowed literals through unchanged', () => {
    for (const detail of ['timeout', 'upstream-failed', 'internal-error', 'aborted']) {
      const event: DesignTurnSseEvent = { event: 'error', data: { detail } };
      expect(scrubDesignTurnEvent(event)).toEqual(event);
    }
  });

  it('replaces raw exception/stderr-shaped text with internal-error', () => {
    const event: DesignTurnSseEvent = { event: 'error', data: { detail: SECRET } };
    const safe = scrubDesignTurnEvent(event);
    expect(safe).toEqual({ event: 'error', data: { detail: 'internal-error' } });
    expect(JSON.stringify(safe)).not.toContain('sk-ant-leaked');
    expect(JSON.stringify(safe)).not.toContain('id_rsa');
  });

  it('replaces a non-string detail (e.g. an agent errors array assigned directly) with internal-error', () => {
    const event = {
      event: 'error',
      data: { detail: ['error_during_execution', SECRET] },
    } as unknown as DesignTurnSseEvent;
    expect(scrubDesignTurnEvent(event)).toEqual({
      event: 'error',
      data: { detail: 'internal-error' },
    });
  });

  it('replaces a missing detail with internal-error', () => {
    const event: DesignTurnSseEvent = { event: 'error', data: {} };
    expect(scrubDesignTurnEvent(event)).toEqual({
      event: 'error',
      data: { detail: 'internal-error' },
    });
  });

  it('drops accidental extra fields riding alongside an otherwise-valid detail (rebuilt wholesale)', () => {
    const event = {
      event: 'error',
      data: { detail: 'upstream-failed', stderr: SECRET, raw: SECRET },
    } as unknown as DesignTurnSseEvent;
    const safe = scrubDesignTurnEvent(event);
    expect(safe).toEqual({ event: 'error', data: { detail: 'upstream-failed' } });
    expect(Object.keys(safe.data)).toEqual(['detail']);
  });
});

describe('runDesignTurn — terminal errors never leak raw content (task 2.8, gate-intent verification)', () => {
  it('a thrown exception whose message carries sensitive/raw content never reaches the emitted detail', async () => {
    const events: DesignTurnSseEvent[] = [];
    // Models a genuine SDK-transport failure whose Error.message might embed
    // a file path or credential fragment (the exact hazard the design's
    // Risks section calls out for subprocess stderr / exception text).
    const throwingQuery: AsyncIterable<SDKMessage> = {
      [Symbol.asyncIterator]() {
        return {
          next: (): Promise<IteratorResult<SDKMessage>> => Promise.reject(new Error(SECRET)),
        };
      },
    };
    const outcome = await runDesignTurn({
      query: throwingQuery,
      emit: (e) => {
        events.push(e);
      },
      timeoutMs: 60_000,
      abortController: new AbortController(),
      terminate: NOOP_TERMINATE,
      release: NOOP_RELEASE,
    });
    expect(outcome).toEqual({ ok: false, detail: 'internal-error' });
    expect(events).toEqual([{ event: 'error', data: { detail: 'internal-error' } }]);
    expect(JSON.stringify(events)).not.toContain('sk-ant-leaked');
    expect(JSON.stringify(events)).not.toContain('id_rsa');
  });

  it('an SDKResultError whose agent errors[] array carries sensitive/raw content never reaches the emitted detail', async () => {
    const events: DesignTurnSseEvent[] = [];
    async function* resultErrorWithSensitiveArray(): AsyncGenerator<SDKMessage> {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: [SECRET, 'a second raw agent error'],
      } as unknown as SDKMessage;
    }
    const outcome = await runDesignTurn({
      query: resultErrorWithSensitiveArray(),
      emit: (e) => {
        events.push(e);
      },
      timeoutMs: 60_000,
      abortController: new AbortController(),
      terminate: NOOP_TERMINATE,
      release: NOOP_RELEASE,
    });
    expect(outcome).toEqual({ ok: false, detail: 'upstream-failed' });
    expect(events).toEqual([{ event: 'error', data: { detail: 'upstream-failed' } }]);
    expect(JSON.stringify(events)).not.toContain('sk-ant-leaked');
    expect(JSON.stringify(events)).not.toContain('a second raw agent error');
  });

  it('a hypothetical future caller that forwards raw stderr as the detail is still scrubbed at the choke point', async () => {
    // Simulates the exact regression the choke point guards against: some
    // future code path that (mistakenly) tries to surface subprocess stderr
    // via a `result`-shaped message whose own `result` text leaks through if
    // ever read directly. runDesignTurn never reads `message.result`/`errors`
    // into `detail` today; this locks that in by construction as well as by
    // convention — a value-level guarantee, not just an absence-of-code one.
    const events: DesignTurnSseEvent[] = [];
    async function* resultSuccessWithSensitiveResultField(): AsyncGenerator<SDKMessage> {
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: SECRET,
      } as unknown as SDKMessage;
    }
    const outcome = await runDesignTurn({
      query: resultSuccessWithSensitiveResultField(),
      emit: (e) => {
        events.push(e);
      },
      timeoutMs: 60_000,
      abortController: new AbortController(),
      terminate: NOOP_TERMINATE,
      release: NOOP_RELEASE,
    });
    expect(outcome).toEqual({ ok: true });
    expect(events).toEqual([{ event: 'done', data: {} }]);
    expect(JSON.stringify(events)).not.toContain('sk-ant-leaked');
  });
});
