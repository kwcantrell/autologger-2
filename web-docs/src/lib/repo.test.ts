import { describe, expect, it } from 'vitest';
import { listTrackedFiles, matchesAnyGlob, matchesGlob, repoRoot } from './repo';

describe('matchesGlob', () => {
  it('matches an exact path', () => {
    expect(matchesGlob('server/src/app.ts', 'server/src/app.ts')).toBe(true);
    expect(matchesGlob('server/src/main.ts', 'server/src/app.ts')).toBe(false);
  });

  it('matches everything under a directory-recursive glob, not the directory itself', () => {
    expect(matchesGlob('server/src/db/catalog.ts', 'server/src/db/**')).toBe(true);
    expect(matchesGlob('server/src/db/nested/foo.ts', 'server/src/db/**')).toBe(true);
    expect(matchesGlob('server/src/db', 'server/src/db/**')).toBe(true);
    expect(matchesGlob('server/src/dbx/foo.ts', 'server/src/db/**')).toBe(false);
    expect(matchesGlob('server/src/other.ts', 'server/src/db/**')).toBe(false);
  });

  it('matches a single-segment wildcard without crossing directory boundaries', () => {
    expect(matchesGlob('web/src/queryKeyFactories.repo.test.ts', 'web/src/*.repo.test.ts')).toBe(
      true,
    );
    expect(matchesGlob('web/src/pages/index/foo.repo.test.ts', 'web/src/*.repo.test.ts')).toBe(
      false,
    );
  });
});

describe('matchesAnyGlob', () => {
  it('is true when any pattern matches', () => {
    expect(matchesAnyGlob('a/b.ts', ['x/**', 'a/b.ts'])).toBe(true);
  });

  it('is false when no pattern matches', () => {
    expect(matchesAnyGlob('a/b.ts', ['x/**', 'y/**'])).toBe(false);
  });
});

describe('repoRoot', () => {
  it('resolves an absolute path that is an ancestor of this file', () => {
    const root = repoRoot();
    expect(root.startsWith('/')).toBe(true);
  });
});

describe('listTrackedFiles', () => {
  it('returns a sorted, de-duplicated-by-construction list of tracked files', () => {
    const files = listTrackedFiles();
    const sorted = [...files].sort();
    expect(files).toEqual(sorted);
    expect(files.length).toBeGreaterThan(0);
  });

  it('includes a file already tracked in this workspace', () => {
    const files = listTrackedFiles();
    expect(files).toContain('web-docs/scripts/check.ts');
  });

  it('filters by extension when asked', () => {
    const files = listTrackedFiles({ extensions: ['.ts', '.tsx'] });
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.endsWith('.ts') || file.endsWith('.tsx')).toBe(true);
    }
    expect(files).toContain('web-docs/scripts/check.ts');
    expect(files.some((file) => file.endsWith('.json'))).toBe(false);
  });
});
