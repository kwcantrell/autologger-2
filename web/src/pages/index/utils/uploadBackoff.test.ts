import { describe, expect, it } from 'vitest';
import { BACKOFF_BASE_MS, BACKOFF_CAP_MS, backoffDelayMs, createBackoff } from './uploadBackoff';

// --- media-worker A.3: per-chunk retry schedule (design D11) ---
// delay(n) = min(300 s, 2 s × 2^(n−1)) × U(0.5, 1.5)

describe('backoffDelayMs', () => {
  it('doubles from 2 s and caps at 5 min (jitter centred)', () => {
    const mid = () => 0.5;
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20].map((n) => backoffDelayMs(n, mid))).toEqual([
      2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000, 300_000,
    ]);
    expect(BACKOFF_BASE_MS).toBe(2_000);
    expect(BACKOFF_CAP_MS).toBe(300_000);
  });

  it('jitter stays within ×0.5 … ×1.5', () => {
    expect(backoffDelayMs(1, () => 0)).toBe(1_000);
    expect(backoffDelayMs(1, () => 0.999_999)).toBeLessThan(3_000);
    expect(backoffDelayMs(1, () => 0.999_999)).toBeGreaterThanOrEqual(2_999);
    expect(backoffDelayMs(30, () => 0)).toBe(150_000);
    expect(backoffDelayMs(30, () => 0.999_999)).toBeLessThan(450_000);
    for (let i = 0; i < 200; i += 1) {
      const d = backoffDelayMs(3);
      expect(d).toBeGreaterThanOrEqual(4_000);
      expect(d).toBeLessThan(12_000);
    }
  });

  it('treats a non-positive or fractional attempt as the first', () => {
    expect(backoffDelayMs(0, () => 0.5)).toBe(2_000);
    expect(backoffDelayMs(-3, () => 0.5)).toBe(2_000);
    expect(backoffDelayMs(2.7, () => 0.5)).toBe(4_000);
  });
});

describe('createBackoff', () => {
  it('steps through the schedule and resets to the start', () => {
    const b = createBackoff(() => 0.5);
    expect([b.next(), b.next(), b.next()]).toEqual([2_000, 4_000, 8_000]);
    expect(b.attempt).toBe(3);
    b.reset();
    expect(b.attempt).toBe(0);
    expect(b.next()).toBe(2_000);
  });
});
