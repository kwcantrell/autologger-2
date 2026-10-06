// session-edit-conflicts D2: the version guard helpers and the version-conflict 409 matcher.

import { describe, expect, it } from 'vitest';
import { ApiError } from './client';
import type { EventVersionConflict } from './types';
import { guardBody, versionConflictOf, versionQuery } from './versionConflict';

describe('guardBody', () => {
  it('returns nothing for no guard or a guard without a version', () => {
    expect(guardBody()).toEqual({});
    expect(guardBody(undefined)).toEqual({});
    expect(guardBody({})).toEqual({});
  });

  it('returns the version only', () => {
    expect(guardBody({ version: 3 })).toEqual({ version: 3 });
    expect(guardBody({ version: 3, overwrite: false })).toEqual({ version: 3 });
  });

  it('returns the version plus overwrite', () => {
    expect(guardBody({ version: 4, overwrite: true })).toEqual({ version: 4, overwrite: true });
  });

  it('spreads into a body byte-identical to today when there is no guard', () => {
    const body = { category: 'c', message: 'm' };
    expect(JSON.stringify({ ...body, ...guardBody() })).toBe(JSON.stringify(body));
  });

  it('throws on overwrite without a version', () => {
    expect(() => guardBody({ overwrite: true })).toThrow(/version/);
  });
});

describe('versionQuery', () => {
  it("returns '' for no guard or a guard without a version", () => {
    expect(versionQuery()).toBe('');
    expect(versionQuery({})).toBe('');
  });

  it('returns ?version=N', () => {
    expect(versionQuery({ version: 2 })).toBe('?version=2');
    expect(versionQuery({ version: 2, overwrite: false })).toBe('?version=2');
  });

  it('returns ?version=N&overwrite=1', () => {
    expect(versionQuery({ version: 5, overwrite: true })).toBe('?version=5&overwrite=1');
  });

  it('throws on overwrite without a version', () => {
    expect(() => versionQuery({ overwrite: true })).toThrow(/version/);
  });
});

describe('versionConflictOf', () => {
  const current = { event_id: 'e1', message: 'theirs', version: 2 };
  const conflict = (body: unknown, status = 409) => new ApiError(status, 'x', body);

  it('matches the version-conflict 409 and returns its body', () => {
    const body = { detail: 'Version conflict.', current };
    const hit = versionConflictOf<EventVersionConflict>(conflict(body));
    expect(hit).toEqual(body);
    expect(hit?.current.version).toBe(2);
  });

  it('rejects a different 409 detail', () => {
    expect(versionConflictOf(conflict({ detail: 'Already exists.', current }))).toBeNull();
  });

  it('rejects another status with the same body', () => {
    expect(versionConflictOf(conflict({ detail: 'Version conflict.', current }, 422))).toBeNull();
  });

  it('rejects a non-ApiError', () => {
    expect(versionConflictOf(new Error('Version conflict.'))).toBeNull();
    expect(
      versionConflictOf({ status: 409, body: { detail: 'Version conflict.', current } }),
    ).toBeNull();
    expect(versionConflictOf(null)).toBeNull();
    expect(versionConflictOf(undefined)).toBeNull();
  });

  it('rejects a missing body or a missing or non-object current', () => {
    expect(versionConflictOf(new ApiError(409, 'Version conflict.'))).toBeNull();
    expect(versionConflictOf(conflict({ detail: 'Version conflict.' }))).toBeNull();
    expect(versionConflictOf(conflict({ detail: 'Version conflict.', current: null }))).toBeNull();
    expect(versionConflictOf(conflict({ detail: 'Version conflict.', current: 'x' }))).toBeNull();
    expect(versionConflictOf(conflict({ detail: 'Version conflict.', current: 2 }))).toBeNull();
    expect(versionConflictOf(conflict('Version conflict.'))).toBeNull();
  });

  it('rejects a non-numeric version', () => {
    for (const version of [undefined, '2', null, Number.NaN]) {
      expect(
        versionConflictOf(
          conflict({ detail: 'Version conflict.', current: { ...current, version } }),
        ),
      ).toBeNull();
    }
  });
});
