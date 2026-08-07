import type { CatalogDb } from '@autologger/ports';
import { describe, expect, it } from 'vitest';
import { Catalog } from './catalog';

// A stub CatalogDb — construction must not touch it (init() is never called here).
const stubDb = {} as unknown as CatalogDb;

describe('Catalog facade', () => {
  const catalog = new Catalog(stubDb);

  it('exposes the domain stores as readonly props (the sole API surface)', () => {
    for (const key of ['studios', 'auth', 'shows', 'sessions', 'profile'] as const) {
      expect(catalog[key]).toBeDefined();
    }
  });

  it('carries no flat delegate methods (the compat shim is gone)', () => {
    expect(Object.keys(catalog).sort()).toEqual([
      'auth',
      'profile',
      'sessions',
      'shows',
      'studios',
    ]);
    for (const legacy of [
      'getShowRow',
      'authGetUserById',
      'setSessionArchived',
      'profilePayload',
    ]) {
      expect((catalog as unknown as Record<string, unknown>)[legacy]).toBeUndefined();
    }
  });
});
