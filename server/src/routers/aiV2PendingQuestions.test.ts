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

import { describe, expect, it } from 'vitest';
import {
  AiV2PendingQuestionRegistry,
  buildAnswerPermissionResult,
  buildPendingQuestionOnQuestion,
  generatePendingQuestionId,
  stripPreviewForRelay,
} from './aiV2PendingQuestions';

describe('generatePendingQuestionId — ≥128-bit CSPRNG (design D7, matches the aiMcpServer.ts bearer-token precedent)', () => {
  it('produces a 32-hex-char (128-bit) id, and two calls never collide', () => {
    const a = generatePendingQuestionId();
    const b = generatePendingQuestionId();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(b).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

// ── 3.1 — key binding + principal binding ───────────────────────────────────

describe('AiV2PendingQuestionRegistry — keyed by (sessionId, turnId, requestId) AND the initiating principal (task 3.1)', () => {
  it('resolves the pending promise when session, turn, request, and principal all match', async () => {
    const registry = new AiV2PendingQuestionRegistry();
    const key = { sessionId: 's1', turnId: 't1', requestId: 'r1' };
    const promise = registry.register(key, 'user-a', { questions: [{ question: 'Q?' }] });
    expect(registry.has(key)).toBe(true);

    const outcome = registry.resolveAnswer(key, 'user-a', [{ kind: 'text', text: 'hi' }]);

    expect(outcome).toBe('ok');
    expect(registry.has(key)).toBe(false); // consumed, not left pending
    await expect(promise).resolves.toMatchObject({ behavior: 'allow' });
  });

  it('rejects an answer carrying a foreign SESSION id — the pending question remains pending', () => {
    const registry = new AiV2PendingQuestionRegistry();
    const key = { sessionId: 's1', turnId: 't1', requestId: 'r1' };
    registry.register(key, 'user-a', { questions: [] });

    const outcome = registry.resolveAnswer({ ...key, sessionId: 'foreign-session' }, 'user-a', [
      { kind: 'text', text: 'x' },
    ]);

    expect(outcome).toBe('not-found');
    expect(registry.has(key)).toBe(true);
  });

  it('rejects an answer carrying a foreign TURN id — the pending question remains pending', () => {
    const registry = new AiV2PendingQuestionRegistry();
    const key = { sessionId: 's1', turnId: 't1', requestId: 'r1' };
    registry.register(key, 'user-a', { questions: [] });

    const outcome = registry.resolveAnswer({ ...key, turnId: 'foreign-turn' }, 'user-a', [
      { kind: 'text', text: 'x' },
    ]);

    expect(outcome).toBe('not-found');
    expect(registry.has(key)).toBe(true);
  });

  it('rejects an answer carrying a foreign REQUEST id — the pending question remains pending', () => {
    const registry = new AiV2PendingQuestionRegistry();
    const key = { sessionId: 's1', turnId: 't1', requestId: 'r1' };
    registry.register(key, 'user-a', { questions: [] });

    const outcome = registry.resolveAnswer({ ...key, requestId: 'foreign-request' }, 'user-a', [
      { kind: 'text', text: 'x' },
    ]);

    expect(outcome).toBe('not-found');
    expect(registry.has(key)).toBe(true);
  });

  it('D7 — rejects an answer from a DIFFERENT principal than the one who initiated the turn, even with every id correct; the question remains pending', async () => {
    const registry = new AiV2PendingQuestionRegistry();
    const key = { sessionId: 's1', turnId: 't1', requestId: 'r1' };
    const promise = registry.register(key, 'user-a', { questions: [] });

    const outcome = registry.resolveAnswer(key, 'user-b', [{ kind: 'text', text: 'x' }]);

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

  it('a turn initiated by a principal-less auth mechanism (principalUserId=null, e.g. an API_TOKEN device token) can never be answered — null never equals any real user id', () => {
    const registry = new AiV2PendingQuestionRegistry();
    const key = { sessionId: 's1', turnId: 't1', requestId: 'r1' };
    registry.register(key, null, { questions: [] });

    // Even the empty string — the "obvious" foot-gun of a loose `== null`
    // check — must not match.
    const outcome = registry.resolveAnswer(key, '', [{ kind: 'text', text: 'x' }]);

    expect(outcome).toBe('not-found');
    expect(registry.has(key)).toBe(true);
  });

  it('Phase-3 fix wave (Fix 3, defensive) — rejects an answer with FEWER entries than pending questions; the question remains pending', () => {
    const registry = new AiV2PendingQuestionRegistry();
    const key = { sessionId: 's1', turnId: 't1', requestId: 'r1' };
    registry.register(key, 'user-a', { questions: [{ question: 'Q1?' }, { question: 'Q2?' }] });

    const outcome = registry.resolveAnswer(key, 'user-a', [
      { kind: 'text', text: 'only one answer' },
    ]);

    expect(outcome).toBe('not-found');
    expect(registry.has(key)).toBe(true);
  });

  it('Phase-3 fix wave (Fix 3, defensive) — rejects an answer with MORE entries than pending questions; the question remains pending', () => {
    const registry = new AiV2PendingQuestionRegistry();
    const key = { sessionId: 's1', turnId: 't1', requestId: 'r1' };
    registry.register(key, 'user-a', { questions: [{ question: 'Q1?' }] });

    const outcome = registry.resolveAnswer(key, 'user-a', [
      { kind: 'text', text: 'a' },
      { kind: 'text', text: 'b' },
    ]);

    expect(outcome).toBe('not-found');
    expect(registry.has(key)).toBe(true);
  });

  it('a crafted sessionId embedding a would-be delimiter cannot collide two different pending entries onto the same key', () => {
    const registry = new AiV2PendingQuestionRegistry();
    const legit = { sessionId: 's1', turnId: 't1', requestId: 'r1' };
    // If keys were joined with e.g. a space delimiter, this crafted id could
    // collide with { sessionId: 's1 t1 r1', turnId: '', requestId: '' }.
    const crafted = { sessionId: 's1 t1 r1', turnId: '', requestId: '' };
    registry.register(legit, 'user-a', { questions: [] });

    const outcome = registry.resolveAnswer(crafted, 'user-a', [{ kind: 'text', text: 'x' }]);

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
    const registry = new AiV2PendingQuestionRegistry();
    const emitted: Array<{ requestId: string; turnId: string; questions: unknown }> = [];
    const onQuestion = buildPendingQuestionOnQuestion({
      sessionId: 's1',
      turnId: 't1',
      principalUserId: 'user-a',
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

    const outcome = registry.resolveAnswer(
      { sessionId: 's1', turnId: 't1', requestId: payload.requestId },
      'user-a',
      [{ kind: 'text', text: 'answer' }],
    );

    expect(outcome).toBe('ok');
    await expect(resultPromise).resolves.toMatchObject({ behavior: 'allow' });
  });

  it('a different answering principal is rejected via the SAME seam — the registered principal, not session access, gates the answer', async () => {
    const registry = new AiV2PendingQuestionRegistry();
    let captured: { requestId: string } | null = null;
    const onQuestion = buildPendingQuestionOnQuestion({
      sessionId: 's1',
      turnId: 't1',
      principalUserId: 'user-a',
      registry,
      emitQuestion: (payload) => {
        captured = payload;
      },
    });
    void onQuestion({ questions: [] });
    const requestId = captured!.requestId;

    const outcome = registry.resolveAnswer({ sessionId: 's1', turnId: 't1', requestId }, 'user-b', [
      { kind: 'text', text: 'x' },
    ]);

    expect(outcome).toBe('not-found');
    expect(registry.has({ sessionId: 's1', turnId: 't1', requestId })).toBe(true);
  });
});

// ── 3.3 — abandonment (the slot-leak-hazard backstop) ───────────────────────

describe('AiV2PendingQuestionRegistry.abandonTurn — client disconnect / turn timeout backstop (spec "Design question round trip", task 3.3)', () => {
  it('resolves every pending question for the given (sessionId, turnId) with a deny, and deletes them', async () => {
    const registry = new AiV2PendingQuestionRegistry();
    const key1 = { sessionId: 's1', turnId: 't1', requestId: 'r1' };
    const key2 = { sessionId: 's1', turnId: 't1', requestId: 'r2' };
    const p1 = registry.register(key1, 'user-a', { questions: [] });
    const p2 = registry.register(key2, 'user-a', { questions: [] });
    expect(registry.size()).toBe(2);

    registry.abandonTurn('s1', 't1');

    expect(registry.size()).toBe(0);
    expect(registry.has(key1)).toBe(false);
    expect(registry.has(key2)).toBe(false);
    await expect(p1).resolves.toMatchObject({ behavior: 'deny' });
    await expect(p2).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('does not touch a pending question belonging to a DIFFERENT turn on the SAME session', () => {
    const registry = new AiV2PendingQuestionRegistry();
    const otherTurnKey = { sessionId: 's1', turnId: 'other-turn', requestId: 'r1' };
    registry.register(otherTurnKey, 'user-a', { questions: [] });

    registry.abandonTurn('s1', 't1');

    expect(registry.has(otherTurnKey)).toBe(true);
  });

  it('does not touch a pending question on a DIFFERENT session with the same turn id', () => {
    const registry = new AiV2PendingQuestionRegistry();
    const otherSessionKey = { sessionId: 'other-session', turnId: 't1', requestId: 'r1' };
    registry.register(otherSessionKey, 'user-a', { questions: [] });

    registry.abandonTurn('s1', 't1');

    expect(registry.has(otherSessionKey)).toBe(true);
  });

  it('a late answer after abandonment has no effect (spec: "An answer for a turn that is no longer in flight SHALL be rejected without effect")', () => {
    const registry = new AiV2PendingQuestionRegistry();
    const key = { sessionId: 's1', turnId: 't1', requestId: 'r1' };
    registry.register(key, 'user-a', { questions: [] });
    registry.abandonTurn('s1', 't1');

    const outcome = registry.resolveAnswer(key, 'user-a', [{ kind: 'text', text: 'too late' }]);

    expect(outcome).toBe('not-found');
  });

  it('abandoning a turn with nothing pending is a harmless no-op', () => {
    const registry = new AiV2PendingQuestionRegistry();
    expect(() => registry.abandonTurn('s1', 'no-such-turn')).not.toThrow();
    expect(registry.size()).toBe(0);
  });
});
