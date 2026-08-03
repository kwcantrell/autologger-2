import { afterEach, describe, expect, it } from 'vitest';
import {
  parseSessionLayoutPreference,
  readSessionLayoutPreference,
  SESSION_LAYOUT_PREFERENCE_KEY,
  writeSessionLayoutPreference,
} from './sessionLayoutPreference';

describe('sessionLayoutPreference', () => {
  afterEach(() => {
    window.localStorage.removeItem(SESSION_LAYOUT_PREFERENCE_KEY);
  });

  it('parseSessionLayoutPreference treats missing/invalid as default', () => {
    expect(parseSessionLayoutPreference(null)).toBe('default');
    expect(parseSessionLayoutPreference(undefined)).toBe('default');
    expect(parseSessionLayoutPreference('')).toBe('default');
    expect(parseSessionLayoutPreference('bogus')).toBe('default');
    expect(parseSessionLayoutPreference('default')).toBe('default');
  });

  it('parseSessionLayoutPreference accepts maximize-log', () => {
    expect(parseSessionLayoutPreference('maximize-log')).toBe('maximize-log');
  });

  it('read/write round-trips through localStorage', () => {
    expect(readSessionLayoutPreference()).toBe('default');
    writeSessionLayoutPreference('maximize-log');
    expect(window.localStorage.getItem(SESSION_LAYOUT_PREFERENCE_KEY)).toBe('maximize-log');
    expect(readSessionLayoutPreference()).toBe('maximize-log');
    writeSessionLayoutPreference('default');
    expect(readSessionLayoutPreference()).toBe('default');
  });
});
