import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PresenceRegistry } from './presence';

describe('PresenceRegistry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const meta = (sid: string, over: Partial<{ visible: boolean; is_playing: boolean }> = {}) => ({
    session_id: sid,
    visible: over.visible ?? true,
    is_playing: over.is_playing ?? false,
    updated: Date.now(),
  });

  it('lists fresh entries and drops stale ones after 15s', () => {
    const r = new PresenceRegistry();
    r.upsert('c1', meta('s1'));
    expect(r.list()).toHaveLength(1);
    vi.advanceTimersByTime(16_000);
    expect(r.list()).toHaveLength(0);
  });

  it('upsert refreshes an existing client; remove deletes it', () => {
    const r = new PresenceRegistry();
    r.upsert('c1', meta('s1'));
    vi.advanceTimersByTime(10_000);
    r.upsert('c1', meta('s2'));
    vi.advanceTimersByTime(10_000);
    expect(r.list()).toEqual([expect.objectContaining({ session_id: 's2' })]);
    r.remove('c1');
    expect(r.list()).toHaveLength(0);
  });
});
