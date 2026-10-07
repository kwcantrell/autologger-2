// ai-v2-dashboards (tasks 3.1 + 3.3) — the pending-question registry.
// Hermetic: no live SDK turn, no Anthropic spend. Exercises the registry
// directly (register/resolveAnswer/abandonTurn) and the `onQuestion` seam
// (buildPendingQuestionOnQuestion) that wires it into `canUseTool`.
//
// 3.1 — keyed by (sessionId, turnId, requestId), NEVER a bare request id,
//        AND the initiating principal (design D7's post-gate correction): a
//        foreign session/turn/request id is rejected and the pending
//        question remains; a DIFFERENT principal is rejected too, even with
//        the correct ids and even with session access.
// 3.3 — abandonment (disconnect/timeout, spec "An unanswered question SHALL
//        NOT hold a turn open indefinitely"): every pending entry for a
//        turn is resolved with a deny and deleted, so a late answer has no
//        effect — the slot-leak hazard this closes, not hygiene.
//
// shared-request-state D2 (ADR 0021 slice 9b): each question is also a kv row, so an answer on any
// server process resolves it; the turn's process polls its rows every 500 ms. The registry is
// built over the in-package MemoryKv (D4); the cases above keep their assertions with async calls
// and `'accepted'` for `'ok'` (D4 category 4), and the last block adds the kv cases.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AiV2PendingQuestionRegistry,
  buildAnswerPermissionResult,
  buildPendingQuestionOnQuestion,
  generatePendingQuestionId,
  stripPreviewForRelay,
} from './aiV2PendingQuestions';
import { MemoryKv } from './test/memoryKv';

describe('generatePendingQuestionId — ≥128-bit CSPRNG (design D7, matches the aiMcpServer.ts bearer-token precedent)', () => {
  it('produces a 32-hex-char (128-bit) id, and two calls never collide', () => {
    const a = generatePendingQuestionId();
    const b = generatePendingQuestionId();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(b).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

// ── kv-backed registry fixture (shared-request-state D2, D4 category 4) ─────
// The registry is built over the in-package MemoryKv and a fake clock. Questions resolve on the
// turn's 500 ms poll, so the cases that expect a resolution advance vitest's fake timers.

const POLL_MS = 500;
const TIMEOUT_MS = 60_000;

let now = 1_750_000_000_000;
const clock = { now: () => now };

function makeRegistry(kv = new MemoryKv(clock)) {
  return { kv, registry: new AiV2PendingQuestionRegistry(kv, clock) };
}

/** Registers; `result` is the blocking promise (the turn's deadline is now + TIMEOUT_MS). It stays
 * wrapped, since an async function returning a promise would adopt it. */
function register(
  registry: AiV2PendingQuestionRegistry,
  key: { sessionId: string; turnId: string; requestId: string },
  principalUserId: string | null,
  input: Record<string, unknown>,
) {
  return registry.register(key, principalUserId, input, now + TIMEOUT_MS);
}

/** One poll tick of every registry's poller. */
const poll = () => vi.advanceTimersByTimeAsync(POLL_MS);

beforeEach(() => {
  vi.useFakeTimers();
  now = 1_750_000_000_000;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── 3.1 — key binding + principal binding ───────────────────────────────────

describe('AiV2PendingQuestionRegistry — keyed by (sessionId, turnId, requestId) AND the initiating principal (task 3.1)', () => {
  it('resolves the pending promise when session, turn, request, and principal all match', async () => {
    const { registry } = makeRegistry();
    const key = { sessionId: 's1', turnId: 't1', requestId: 'r1' };
    const { result: promise } = await register(registry, key, 'user-a', {
      questions: [{ question: 'Q?' }],
    });
    expect(registry.has(key)).toBe(true);

    const outcome = await registry.resolveAnswer(key, 'user-a', [{ kind: 'text', text: 'hi' }]);
    await poll();

    expect(outcome).toBe('accepted');
    expect(registry.has(key)).toBe(false); // consumed, not left pending
    await expect(promise).resolves.toMatchObject({ behavior: 'allow' });
  });

  it('rejects an answer carrying a foreign SESSION id — the pending question remains pending', async () => {
    const { registry } = makeRegistry();
    const key = { sessionId: 's1', turnId: 't1', requestId: 'r1' };
    await register(registry, key, 'user-a', { questions: [] });

    const outcome = await registry.resolveAnswer(
      { ...key, sessionId: 'foreign-session' },
      'user-a',
      [{ kind: 'text', text: 'x' }],
    );

    expect(outcome).toBe('not-found');
    expect(registry.has(key)).toBe(true);
  });

  it('rejects an answer carrying a foreign TURN id — the pending question remains pending', async () => {
    const { registry } = makeRegistry();
    const key = { sessionId: 's1', turnId: 't1', requestId: 'r1' };
    await register(registry, key, 'user-a', { questions: [] });

    const outcome = await registry.resolveAnswer({ ...key, turnId: 'foreign-turn' }, 'user-a', [
      { kind: 'text', text: 'x' },
    ]);

    expect(outcome).toBe('not-found');
    expect(registry.has(key)).toBe(true);
  });

  it('rejects an answer carrying a foreign REQUEST id — the pending question remains pending', async () => {
    const { registry } = makeRegistry();
    const key = { sessionId: 's1', turnId: 't1', requestId: 'r1' };
    await register(registry, key, 'user-a', { questions: [] });

    const outcome = await registry.resolveAnswer(
      { ...key, requestId: 'foreign-request' },
      'user-a',
      [{ kind: 'text', text: 'x' }],
    );

    expect(outcome).toBe('not-found');
    expect(registry.has(key)).toBe(true);
  });

  it('D7 — rejects an answer from a DIFFERENT principal than the one who initiated the turn, even with every id correct; the question remains pending', async () => {
    const { registry } = makeRegistry();
    const key = { sessionId: 's1', turnId: 't1', requestId: 'r1' };
    const { result: promise } = await register(registry, key, 'user-a', { questions: [] });

    const outcome = await registry.resolveAnswer(key, 'user-b', [{ kind: 'text', text: 'x' }]);
    await poll();

    expect(outcome).toBe('not-found');
    expect(registry.has(key)).toBe(true);
    // The promise must still be unresolved — race it against an
    // already-resolved sentinel; if `promise` had (wrongly) resolved, this
    // race would be non-deterministic instead of always picking the sentinel.
    const raced = await Promise.race([
      promise.then(() => 'wrongly-resolved'),
      Promise.resolve('still-pending'),
    ]);
    expect(raced).toBe('still-pending');
  });

  it('a turn initiated by a principal-less auth mechanism (principalUserId=null, e.g. an API_TOKEN device token) can never be answered — null never equals any real user id', async () => {
    const { registry } = makeRegistry();
    const key = { sessionId: 's1', turnId: 't1', requestId: 'r1' };
    await register(registry, key, null, { questions: [] });

    // Even the empty string — the "obvious" foot-gun of a loose `== null`
    // check — must not match.
    const outcome = await registry.resolveAnswer(key, '', [{ kind: 'text', text: 'x' }]);

    expect(outcome).toBe('not-found');
    expect(registry.has(key)).toBe(true);
  });

  it('Phase-3 fix wave (Fix 3, defensive) — rejects an answer with FEWER entries than pending questions; the question remains pending', async () => {
    const { registry } = makeRegistry();
    const key = { sessionId: 's1', turnId: 't1', requestId: 'r1' };
    await register(registry, key, 'user-a', {
      questions: [{ question: 'Q1?' }, { question: 'Q2?' }],
    });

    const outcome = await registry.resolveAnswer(key, 'user-a', [
      { kind: 'text', text: 'only one answer' },
    ]);

    expect(outcome).toBe('not-found');
    expect(registry.has(key)).toBe(true);
  });

  it('Phase-3 fix wave (Fix 3, defensive) — rejects an answer with MORE entries than pending questions; the question remains pending', async () => {
    const { registry } = makeRegistry();
    const key = { sessionId: 's1', turnId: 't1', requestId: 'r1' };
    await register(registry, key, 'user-a', { questions: [{ question: 'Q1?' }] });

    const outcome = await registry.resolveAnswer(key, 'user-a', [
      { kind: 'text', text: 'a' },
      { kind: 'text', text: 'b' },
    ]);

    expect(outcome).toBe('not-found');
    expect(registry.has(key)).toBe(true);
  });

  it('a crafted sessionId embedding a would-be delimiter cannot collide two different pending entries onto the same key', async () => {
    const { registry } = makeRegistry();
    const legit = { sessionId: 's1', turnId: 't1', requestId: 'r1' };
    // If keys were joined with e.g. a space delimiter, this crafted id could
    // collide with { sessionId: 's1 t1 r1', turnId: '', requestId: '' }.
    const crafted = { sessionId: 's1 t1 r1', turnId: '', requestId: '' };
    await register(registry, legit, 'user-a', { questions: [] });

    const outcome = await registry.resolveAnswer(crafted, 'user-a', [{ kind: 'text', text: 'x' }]);

    expect(outcome).toBe('not-found');
    expect(registry.has(legit)).toBe(true);
  });
});

describe('buildAnswerPermissionResult — option vs free-text answer shapes (spec "Previews reflect the rendered result")', () => {
  const input = {
    questions: [{ question: 'Which widget?', header: 'Widget', multiSelect: false, options: [] }],
  };

  it('maps a catalog-option answer to the widget-type id itself, keyed by question text', () => {
    const result = buildAnswerPermissionResult(input, [
      { kind: 'option', widgetType: 'session_duration' },
    ]);

    expect(result).toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: { 'Which widget?': 'session_duration' } },
    });
    const updatedInput = (result as { updatedInput?: Record<string, unknown> }).updatedInput;
    expect(updatedInput?.response).toBeUndefined();
  });

  it('maps a free-text fallback answer to a DIFFERENT shape — the answer value AND a top-level response field', () => {
    const result = buildAnswerPermissionResult(input, [{ kind: 'text', text: 'something custom' }]);

    expect(result).toMatchObject({
      behavior: 'allow',
      updatedInput: {
        answers: { 'Which widget?': 'something custom' },
        response: 'something custom',
      },
    });
  });
});

describe('stripPreviewForRelay — agent-supplied preview content is discarded before relay (spec "Subprocess security lockdown")', () => {
  it(
    'drops the preview field from every option, keeping label/description, and returns the FLATTENED array directly ' +
      '(Phase-3 fix wave, Fix 2 — not wrapped in another { questions } object)',
    () => {
      const input = {
        questions: [
          {
            question: 'Pick one',
            header: 'Pick',
            multiSelect: false,
            options: [
              { label: 'A', description: 'desc a', preview: '<b>evil-markup</b>' },
              { label: 'B', description: 'desc b', preview: 'also-evil' },
            ],
          },
        ],
      };

      const relayed = stripPreviewForRelay(input);

      expect(Array.isArray(relayed)).toBe(true);
      expect(JSON.stringify(relayed)).not.toMatch(/evil/);
      expect(relayed[0].options).toEqual([
        { label: 'A', description: 'desc a' },
        { label: 'B', description: 'desc b' },
      ]);
    },
  );

  it('is defensive against a malformed input shape — never throws, returning an empty array (not { questions: [] })', () => {
    expect(() => stripPreviewForRelay({})).not.toThrow();
    expect(stripPreviewForRelay({})).toEqual([]);
  });
});

describe('buildPendingQuestionOnQuestion — the onQuestion seam (registers, relays, returns the blocking promise)', () => {
  it('registers a pending entry, relays a preview-stripped payload carrying the turn/request ids, and resolves once answered', async () => {
    const { registry } = makeRegistry();
    const emitted: Array<{ requestId: string; turnId: string; questions: unknown }> = [];
    const onQuestion = buildPendingQuestionOnQuestion({
      sessionId: 's1',
      turnId: 't1',
      principalUserId: 'user-a',
      turnDeadlineMs: now + TIMEOUT_MS,
      registry,
      emitQuestion: (payload) => {
        emitted.push(payload);
      },
    });

    const resultPromise = onQuestion({
      questions: [
        {
          question: 'Q?',
          header: 'H',
          multiSelect: false,
          options: [{ label: 'A', description: 'd', preview: 'SECRET' }],
        },
      ],
    });
    await vi.waitFor(() => expect(emitted).toHaveLength(1));

    expect(emitted).toHaveLength(1);
    const payload = emitted[0];
    expect(payload.turnId).toBe('t1');
    expect(payload.requestId).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(payload.questions)).not.toMatch(/SECRET/);
    // Phase-3 fix wave (Fix 2): the emitted payload's `questions` is the
    // flattened array itself, not `{ questions: [...] }` one level deeper.
    expect(Array.isArray(payload.questions)).toBe(true);
    expect(payload.questions).toHaveLength(1);
    expect((payload.questions as Array<{ question: string }>)[0].question).toBe('Q?');
    expect(registry.has({ sessionId: 's1', turnId: 't1', requestId: payload.requestId })).toBe(
      true,
    );

    const outcome = await registry.resolveAnswer(
      { sessionId: 's1', turnId: 't1', requestId: payload.requestId },
      'user-a',
      [{ kind: 'text', text: 'answer' }],
    );
    await poll();

    expect(outcome).toBe('accepted');
    await expect(resultPromise).resolves.toMatchObject({ behavior: 'allow' });
  });

  it('a different answering principal is rejected via the SAME seam — the registered principal, not session access, gates the answer', async () => {
    const { registry } = makeRegistry();
    let captured: { requestId: string } | null = null;
    const onQuestion = buildPendingQuestionOnQuestion({
      sessionId: 's1',
      turnId: 't1',
      principalUserId: 'user-a',
      turnDeadlineMs: now + TIMEOUT_MS,
      registry,
      emitQuestion: (payload) => {
        captured = payload;
      },
    });
    void onQuestion({ questions: [] });
    await vi.waitFor(() => expect(captured).not.toBeNull());
    // Re-widened: TS's control-flow analysis doesn't see the assignment inside
    // the emitQuestion callback, so `captured` reads as the initial `null`.
    const emitted = captured as { requestId: string } | null;
    if (emitted === null) throw new Error('emitQuestion was never called');
    const requestId = emitted.requestId;

    const outcome = await registry.resolveAnswer(
      { sessionId: 's1', turnId: 't1', requestId },
      'user-b',
      [{ kind: 'text', text: 'x' }],
    );

    expect(outcome).toBe('not-found');
    expect(registry.has({ sessionId: 's1', turnId: 't1', requestId })).toBe(true);
  });
});

// ── 3.3 — abandonment (the slot-leak-hazard backstop) ───────────────────────

describe('AiV2PendingQuestionRegistry.abandonTurn — client disconnect / turn timeout backstop (spec "Design question round trip", task 3.3)', () => {
  it('resolves every pending question for the given (sessionId, turnId) with a deny, and deletes them', async () => {
    const { registry } = makeRegistry();
    const key1 = { sessionId: 's1', turnId: 't1', requestId: 'r1' };
    const key2 = { sessionId: 's1', turnId: 't1', requestId: 'r2' };
    const { result: p1 } = await register(registry, key1, 'user-a', { questions: [] });
    const { result: p2 } = await register(registry, key2, 'user-a', { questions: [] });
    expect(registry.size()).toBe(2);

    registry.abandonTurn('s1', 't1');

    expect(registry.size()).toBe(0);
    expect(registry.has(key1)).toBe(false);
    expect(registry.has(key2)).toBe(false);
    await expect(p1).resolves.toMatchObject({ behavior: 'deny' });
    await expect(p2).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('does not touch a pending question belonging to a DIFFERENT turn on the SAME session', async () => {
    const { registry } = makeRegistry();
    const otherTurnKey = { sessionId: 's1', turnId: 'other-turn', requestId: 'r1' };
    await register(registry, otherTurnKey, 'user-a', { questions: [] });

    registry.abandonTurn('s1', 't1');

    expect(registry.has(otherTurnKey)).toBe(true);
  });

  it('does not touch a pending question on a DIFFERENT session with the same turn id', async () => {
    const { registry } = makeRegistry();
    const otherSessionKey = { sessionId: 'other-session', turnId: 't1', requestId: 'r1' };
    await register(registry, otherSessionKey, 'user-a', { questions: [] });

    registry.abandonTurn('s1', 't1');

    expect(registry.has(otherSessionKey)).toBe(true);
  });

  it('a late answer after abandonment has no effect (spec: "An answer for a turn that is no longer in flight SHALL be rejected without effect")', async () => {
    const { registry } = makeRegistry();
    const key = { sessionId: 's1', turnId: 't1', requestId: 'r1' };
    await register(registry, key, 'user-a', { questions: [] });
    registry.abandonTurn('s1', 't1');
    await vi.waitFor(async () => expect(await registry.rowState(key)).toBeNull());

    const outcome = await registry.resolveAnswer(key, 'user-a', [
      { kind: 'text', text: 'too late' },
    ]);

    expect(outcome).toBe('not-found');
  });

  it('abandoning a turn with nothing pending is a harmless no-op', () => {
    const { registry } = makeRegistry();
    expect(() => registry.abandonTurn('s1', 'no-such-turn')).not.toThrow();
    expect(registry.size()).toBe(0);
  });
});

// ── shared-request-state D2: the kv row, the poller, the CAS answer ─────────

describe('pending questions live in kv (shared-request-state D2)', () => {
  const key = { sessionId: 's1', turnId: 't1', requestId: 'r1' };
  const rowKey = `ai-v2-question:${JSON.stringify(['s1', 't1', 'r1'])}`;
  const input = { questions: [{ question: 'Q?' }, { question: 'Q2?' }] };
  const answers = [
    { kind: 'text' as const, text: 'a' },
    { kind: 'option' as const, widgetType: 'session_duration' as const },
  ];

  it('stores the row before the question is emitted, expiring at the turn deadline plus 5 s', async () => {
    const { kv, registry } = makeRegistry();
    let rowAtEmit: string | null | undefined;
    let requestId = '';
    const onQuestion = buildPendingQuestionOnQuestion({
      sessionId: 's1',
      turnId: 't1',
      principalUserId: 'user-a',
      turnDeadlineMs: now + TIMEOUT_MS,
      registry,
      emitQuestion: async (payload) => {
        requestId = payload.requestId;
        rowAtEmit = await kv.get(
          `ai-v2-question:${JSON.stringify(['s1', 't1', payload.requestId])}`,
        );
      },
    });
    void onQuestion(input);
    await vi.waitFor(() => expect(rowAtEmit).toBeDefined());
    expect(JSON.parse(rowAtEmit as string)).toEqual({
      v: 1,
      state: 'pending',
      principalUserId: 'user-a',
      questionCount: 2,
    });
    const row = kv.rows.get(`ai-v2-question:${JSON.stringify(['s1', 't1', requestId])}`);
    expect(row?.expiresAt).toBe(now + TIMEOUT_MS + 5_000);
  });

  it('a failed put denies the question without emitting it, and logs', async () => {
    const { kv, registry } = makeRegistry();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    kv.before = (op) => {
      if (op === 'put') throw new Error('kv down');
    };
    const emit = vi.fn();
    const onQuestion = buildPendingQuestionOnQuestion({
      sessionId: 's1',
      turnId: 't1',
      principalUserId: 'user-a',
      turnDeadlineMs: now + TIMEOUT_MS,
      registry,
      emitQuestion: emit,
    });
    await expect(onQuestion(input)).resolves.toMatchObject({ behavior: 'deny' });
    expect(emit).not.toHaveBeenCalled();
    expect(registry.size()).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it('an answer through a second registry over the same kv resolves the first one’s turn on its next poll', async () => {
    const { kv, registry: a } = makeRegistry();
    const b = new AiV2PendingQuestionRegistry(kv, clock);
    const { result: promise } = await register(a, key, 'user-a', input);
    expect(await b.resolveAnswer(key, 'user-a', answers)).toBe('accepted');
    expect(b.size()).toBe(0); // B never held a local entry
    expect(a.has(key)).toBe(true); // resolved only on A's poll
    await poll();
    expect(a.has(key)).toBe(false);
    await expect(promise).resolves.toEqual(buildAnswerPermissionResult(input, answers));
    expect(kv.rows.has(rowKey)).toBe(false); // A took the answered row
  });

  it('a wrong principal or a wrong count is not-found and leaves the row pending', async () => {
    const { registry } = makeRegistry();
    await register(registry, key, 'user-a', input);
    expect(await registry.resolveAnswer(key, 'user-b', answers)).toBe('not-found');
    expect(await registry.resolveAnswer(key, 'user-a', answers.slice(0, 1))).toBe('not-found');
    expect(await registry.rowState(key)).toBe('pending');
  });

  it('of two concurrent answers, exactly one is accepted', async () => {
    const { kv, registry: a } = makeRegistry();
    const b = new AiV2PendingQuestionRegistry(kv, clock);
    const c = new AiV2PendingQuestionRegistry(kv, clock);
    await register(a, key, 'user-a', input);
    const outcomes = await Promise.all([
      b.resolveAnswer(key, 'user-a', answers),
      c.resolveAnswer(key, 'user-a', answers),
    ]);
    expect(outcomes.sort()).toEqual(['accepted', 'not-found']);
  });

  it('an already-answered row is not-found to a second answer', async () => {
    const { registry } = makeRegistry();
    await register(registry, key, 'user-a', input);
    expect(await registry.resolveAnswer(key, 'user-a', answers)).toBe('accepted');
    expect(await registry.resolveAnswer(key, 'user-a', answers)).toBe('not-found');
  });

  it('a poll whose read throws retries next tick rather than denying', async () => {
    const { kv, registry } = makeRegistry();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result: promise } = await register(registry, key, 'user-a', input);
    let failing = true;
    kv.before = (op) => {
      if (op === 'get' && failing) throw new Error('kv blip');
    };
    await poll();
    expect(registry.has(key)).toBe(true);
    expect(warn).toHaveBeenCalled();
    failing = false;
    expect(await registry.resolveAnswer(key, 'user-a', answers)).toBe('accepted');
    await poll();
    await expect(promise).resolves.toMatchObject({ behavior: 'allow' });
  });

  it('a vanished row (expired or deleted) is denied on the next poll', async () => {
    const { kv, registry } = makeRegistry();
    const { result: promise } = await register(registry, key, 'user-a', input);
    await kv.delete(rowKey);
    await poll();
    expect(registry.has(key)).toBe(false);
    await expect(promise).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('abandon denies at once and deletes the row; a failed delete is only logged', async () => {
    const { kv, registry } = makeRegistry();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result: promise } = await register(registry, key, 'user-a', input);
    kv.before = (op) => {
      if (op === 'delete') throw new Error('kv down');
    };
    expect(registry.abandonTurn('s1', 't1')).toBeUndefined();
    await expect(promise).resolves.toMatchObject({ behavior: 'deny' });
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(kv.rows.has(rowKey)).toBe(true); // it expires at the deadline instead
    kv.before = null;
    const { result: p2 } = await register(registry, { ...key, requestId: 'r2' }, 'user-a', input);
    registry.abandonTurn('s1', 't1');
    await expect(p2).resolves.toMatchObject({ behavior: 'deny' });
    await vi.waitFor(() =>
      expect(kv.rows.has(`ai-v2-question:${JSON.stringify(['s1', 't1', 'r2'])}`)).toBe(false),
    );
  });

  it('the poller stops once the turn has nothing pending', async () => {
    const { kv, registry } = makeRegistry();
    await register(registry, key, 'user-a', input);
    registry.abandonTurn('s1', 't1');
    const get = vi.spyOn(kv, 'get');
    await poll();
    await poll();
    expect(get).not.toHaveBeenCalled();
  });
});
