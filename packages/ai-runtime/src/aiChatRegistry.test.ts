// run-status-and-sweeper (design D2) — unit tests for the AI turn registry with
// no process-wide ceiling: per-session single-flight is the only bound.

import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import { type AiChatAcquireResult, AiChatTurnRegistry } from './aiChatRegistry';

let registry: AiChatTurnRegistry;

beforeEach(() => {
  registry = new AiChatTurnRegistry();
});

describe('AiChatTurnRegistry — no ceiling (run-status-and-sweeper D2)', () => {
  it('three different sessions all acquire at once', () => {
    const a = registry.tryAcquire('session-a');
    const b = registry.tryAcquire('session-b');
    const c = registry.tryAcquire('session-c');
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(c.ok).toBe(true);
    expect(registry.activeCount).toBe(3);
    for (const r of [a, b, c]) if (r.ok) r.release();
    expect(registry.activeCount).toBe(0);
  });

  it('the same session is refused as session-busy while its turn is held', () => {
    const first = registry.tryAcquire('session-a');
    expect(first.ok).toBe(true);
    expect(registry.isSessionInFlight('session-a')).toBe(true);
    expect(registry.tryAcquire('session-a')).toEqual({ ok: false, reason: 'session-busy' });
    expect(registry.activeCount).toBe(1);
    if (first.ok) first.release();
  });

  it('release is idempotent and frees the session for a later turn', () => {
    const first = registry.tryAcquire('session-a');
    if (!first.ok) throw new Error('expected the first acquire to succeed');
    first.release();
    first.release();
    expect(registry.activeCount).toBe(0);
    expect(registry.isSessionInFlight('session-a')).toBe(false);
    const again = registry.tryAcquire('session-a');
    expect(again.ok).toBe(true);
    expect(registry.activeCount).toBe(1);
  });

  it('reset drops every slot', () => {
    registry.tryAcquire('session-a');
    registry.tryAcquire('session-b');
    registry.reset();
    expect(registry.activeCount).toBe(0);
    expect(registry.tryAcquire('session-a').ok).toBe(true);
  });

  it('the only refusal reason is session-busy', () => {
    expectTypeOf<
      Extract<AiChatAcquireResult, { ok: false }>['reason']
    >().toEqualTypeOf<'session-busy'>();
  });
});
