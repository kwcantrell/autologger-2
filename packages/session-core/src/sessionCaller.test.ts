// session-content-policies design D2: who a session hub call runs for. Only `userCaller` and
// `systemCaller` make a `SessionCaller`; each validates as the adapter's `bindUser`/`bindSystem` do,
// so a bad caller fails where it is made, and an object literal is a type error where a caller is
// expected (the type case is checked by `tsc --noEmit -p packages/session-core`).
import { describe, expect, it } from 'vitest';
import { type SessionCaller, systemCaller, userCaller } from './sessionCaller';

describe('sessionCaller (session-content-policies D2)', () => {
  it('userCaller makes a user caller for a non-empty id', () => {
    expect(userCaller('u-1')).toEqual({ kind: 'user', userId: 'u-1' });
  });

  it('systemCaller makes a system caller for a reason matching [a-z][a-z0-9-]*', () => {
    expect(systemCaller('session-open')).toEqual({ kind: 'system', reason: 'session-open' });
    expect(systemCaller('a2')).toEqual({ kind: 'system', reason: 'a2' });
  });

  it("userCaller('') and a non-string id throw TypeError", () => {
    expect(() => userCaller('')).toThrow(TypeError);
    expect(() => userCaller(1 as never)).toThrow(TypeError);
  });

  it("systemCaller('Bad') and other malformed reasons throw TypeError", () => {
    for (const bad of ['Bad', '', '9-lives', 'has space', 'under_score']) {
      expect(() => systemCaller(bad), bad).toThrow(TypeError);
    }
  });

  it('a caller cannot be changed after it is made', () => {
    const c = userCaller('u-1') as { userId: string };
    expect(() => {
      c.userId = 'u-2';
    }).toThrow(TypeError);
  });

  it('an object literal is not a SessionCaller (a type error)', () => {
    const take = (c: SessionCaller) => c.kind;
    // @ts-expect-error -- only userCaller and systemCaller make a SessionCaller (the brand).
    expect(take({ kind: 'system', reason: 'forged' })).toBe('system');
    // @ts-expect-error -- the user form too.
    expect(take({ kind: 'user', userId: 'u-1' })).toBe('user');
  });
});
