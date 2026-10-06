import { describe, expect, it } from 'vitest';
import { resolveCategoryColor } from './categoryColor';

// shadcn-port-workspace D8: the API's category colour can name a legacy bare token (internal
// events arrive as var(--muted)); shadcn owns those names now, so they map to --legacy-*.
describe('resolveCategoryColor', () => {
  it('maps the legacy bare tokens to their --legacy-* names', () => {
    expect(resolveCategoryColor('var(--muted)')).toBe('var(--legacy-muted)');
    expect(resolveCategoryColor('var(--border)')).toBe('var(--legacy-border)');
    expect(resolveCategoryColor('var(--accent)')).toBe('var(--legacy-accent)');
  });

  it('tolerates surrounding and inner whitespace', () => {
    expect(resolveCategoryColor('  var( --muted )  ')).toBe('var(--legacy-muted)');
  });

  it('passes hex and every other var() through (trimmed)', () => {
    expect(resolveCategoryColor(' #4488ff ')).toBe('#4488ff');
    expect(resolveCategoryColor('var(--color-legacy-accent)')).toBe('var(--color-legacy-accent)');
    expect(resolveCategoryColor('var(--muted-foreground)')).toBe('var(--muted-foreground)');
    expect(resolveCategoryColor('var(--muted, #888)')).toBe('var(--muted, #888)');
  });

  it('returns undefined for empty or missing values so callers keep their fallbacks', () => {
    expect(resolveCategoryColor('')).toBeUndefined();
    expect(resolveCategoryColor('   ')).toBeUndefined();
    expect(resolveCategoryColor(null)).toBeUndefined();
    expect(resolveCategoryColor(undefined)).toBeUndefined();
  });
});
