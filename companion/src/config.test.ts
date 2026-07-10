import { describe, expect, it } from 'vitest';
import { clampPollMs, normalizeBaseUrl } from './config.js';

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes and trims', () => {
    expect(normalizeBaseUrl('  http://x:8787/  ')).toBe('http://x:8787');
    expect(normalizeBaseUrl('http://x:8787')).toBe('http://x:8787');
    expect(normalizeBaseUrl('http://x:8787///')).toBe('http://x:8787');
  });
});

describe('clampPollMs', () => {
  it('clamps to [250, 10000] and defaults non-finite to 1000', () => {
    expect(clampPollMs(1000)).toBe(1000);
    expect(clampPollMs(10)).toBe(250);
    expect(clampPollMs(99999)).toBe(10000);
    expect(clampPollMs(Number.NaN)).toBe(1000);
  });
});
