import { describe, expect, it } from 'vitest';
import { validateLoginReturnPath } from './loginReturnPath';

// The recipe (design D6 / spec web-login-experience) is order-sensitive:
// syntactic rejects (string shape, `\`, control chars) run BEFORE the URL
// parse, then origin equality, then the router-known-route pathname check.
// These tests exercise the full bypass corpus from the spec plus adversarial
// additions, and note (in comments) which step of the recipe catches each
// rejection where it isn't obvious.

describe('validateLoginReturnPath', () => {
  describe('accepts', () => {
    it('a bare sessions path', () => {
      expect(validateLoginReturnPath('/sessions/abc')).toBe('/sessions/abc');
    });

    it('a sessions path with a query string, preserving it', () => {
      expect(validateLoginReturnPath('/sessions/abc?x=1')).toBe('/sessions/abc?x=1');
    });

    it('a sessions path with a multi-param query string', () => {
      expect(validateLoginReturnPath('/sessions/abc?x=1&y=2')).toBe('/sessions/abc?x=1&y=2');
    });

    it('a session id containing URL-safe punctuation', () => {
      expect(validateLoginReturnPath('/sessions/abc-123_def')).toBe('/sessions/abc-123_def');
    });
  });

  describe('rejects: non-string / empty / structural', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['a number', 42],
      ['a plain object', { path: '/sessions/abc' }],
      ['an array', ['/sessions/abc']],
      ['a boolean', true],
      ['empty string', ''],
    ])('%s', (_label, value) => {
      expect(validateLoginReturnPath(value)).toBeNull();
    });

    it('the root path (no router route)', () => {
      expect(validateLoginReturnPath('/')).toBeNull();
    });

    it('a same-origin non-router path (/admin/users)', () => {
      expect(validateLoginReturnPath('/admin/users')).toBeNull();
    });

    it('/sessions with no id segment', () => {
      expect(validateLoginReturnPath('/sessions')).toBeNull();
    });

    it('/sessions/ with a trailing slash and empty segment', () => {
      expect(validateLoginReturnPath('/sessions/')).toBeNull();
    });

    it('/sessions/a/b — nested segments are not a router-known route', () => {
      expect(validateLoginReturnPath('/sessions/a/b')).toBeNull();
    });

    it('a path not starting with a slash', () => {
      expect(validateLoginReturnPath('sessions/abc')).toBeNull();
    });
  });

  describe('rejects: protocol-relative / scheme bypasses', () => {
    it('//evil.com (protocol-relative, rejected at the leading-slash check)', () => {
      expect(validateLoginReturnPath('//evil.com')).toBeNull();
    });

    it('//evil.com/sessions/abc (protocol-relative with a router-shaped tail)', () => {
      expect(validateLoginReturnPath('//evil.com/sessions/abc')).toBeNull();
    });

    it('/\\evil.com (backslash treated as `/` by WHATWG for special schemes)', () => {
      expect(validateLoginReturnPath('/\\evil.com')).toBeNull();
    });

    it('/\\/evil.com (backslash immediately followed by a real slash)', () => {
      expect(validateLoginReturnPath('/\\/evil.com')).toBeNull();
    });

    it('https://evil.com/x (fully qualified, off-origin)', () => {
      expect(validateLoginReturnPath('https://evil.com/x')).toBeNull();
    });

    it('http://evil.com/sessions/abc — off-origin even with a router-shaped path', () => {
      // Rejected at step 1 (does not start with a single `/`); included to
      // cover the spec's explicit "resolves off-origin" case. Because a
      // value that clears steps 1-2 (single leading `/`, no `\`, no control
      // chars) can never actually resolve off-origin under WHATWG relative
      // resolution, there is no reachable input that is accepted by steps
      // 1-2 and only then rejected by the origin check (step 3) — step 3
      // is deliberately kept anyway as an independent, non-bypassable gate
      // rather than relying on that invariant holding forever.
      expect(validateLoginReturnPath('http://evil.com/sessions/abc')).toBeNull();
    });

    it('javascript:alert(1)', () => {
      expect(validateLoginReturnPath('javascript:alert(1)')).toBeNull();
    });

    it('javascript:/sessions/abc — scheme prefix disguised as a path', () => {
      expect(validateLoginReturnPath('javascript:/sessions/abc')).toBeNull();
    });
  });

  describe('rejects: backslash and control-character variants', () => {
    it('/sessions/abc\\ (trailing backslash)', () => {
      expect(validateLoginReturnPath('/sessions/abc\\')).toBeNull();
    });

    it('/sessions/ab\\c (embedded backslash mid-segment)', () => {
      expect(validateLoginReturnPath('/sessions/ab\\c')).toBeNull();
    });

    it('/\\t/evil.com (literal tab between slashes reassembles into //evil.com)', () => {
      expect(validateLoginReturnPath('/\t/evil.com')).toBeNull();
    });

    it('/\\n/evil.com (literal newline, same stripping quirk as tab)', () => {
      expect(validateLoginReturnPath('/\n/evil.com')).toBeNull();
    });

    it('/sessions/ab\\x00c (embedded NUL control character)', () => {
      expect(validateLoginReturnPath('/sessions/ab\x00c')).toBeNull();
    });

    it('/sessions/ab\\x7fc (DEL control character)', () => {
      expect(validateLoginReturnPath('/sessions/ab\x7fc')).toBeNull();
    });

    it('/sessions/abc\\r (carriage return)', () => {
      expect(validateLoginReturnPath('/sessions/abc\r')).toBeNull();
    });
  });

  describe('rejects: percent-encoded trickery', () => {
    it('/%2F%2Fevil.com — percent-encoded slashes are never decoded back into `/`', () => {
      // `URL#pathname` keeps `%2F` percent-encoded rather than decoding it
      // into a literal `/`, so this parses to a same-origin URL whose
      // pathname is literally "/%2F%2Fevil.com" — it does not become
      // "//evil.com" and does not smuggle a second path segment. It's safe
      // to reject here purely because that pathname doesn't match the
      // `/sessions/<segment>` router route, not because of any origin
      // trickery.
      expect(validateLoginReturnPath('/%2F%2Fevil.com')).toBeNull();
    });

    it('/sessions/%2Fabc — a percent-encoded slash inside the id segment stays encoded text', () => {
      // Decodes to "/sessions//abc" only if something later percent-decodes
      // the pathname; `URL#pathname` doesn't, so this is literally the
      // single segment "%2Fabc" and is accepted as an (unusual but inert)
      // session id — documenting the disposition rather than asserting null.
      expect(validateLoginReturnPath('/sessions/%2Fabc')).toBe('/sessions/%2Fabc');
    });

    it('/sessions/%5C..%2Fevil.com — percent-encoded backslash does not trigger the `\\` rule', () => {
      // The raw string contains no literal `\`, so step 2 doesn't fire; the
      // encoded bytes stay inert text in a single path segment and the
      // result is same-origin and still under /sessions/, so it resolves to
      // a normal (if odd-looking) session id — same reasoning as above.
      expect(validateLoginReturnPath('/sessions/%5C..%2Fevil.com')).toBe(
        '/sessions/%5C..%2Fevil.com',
      );
    });
  });

  describe('adversarial additions', () => {
    it('a value that is only whitespace', () => {
      expect(validateLoginReturnPath('   ')).toBeNull();
    });

    it('a value with a leading space before the slash', () => {
      expect(validateLoginReturnPath(' /sessions/abc')).toBeNull();
    });

    it('triple-slash protocol-relative variant', () => {
      expect(validateLoginReturnPath('///evil.com')).toBeNull();
    });

    it('a sessions path with a fragment (hash is dropped, not smuggled)', () => {
      expect(validateLoginReturnPath('/sessions/abc#frag')).toBe('/sessions/abc');
    });

    it('a sessions path with both query and fragment preserves only the query', () => {
      expect(validateLoginReturnPath('/sessions/abc?x=1#frag')).toBe('/sessions/abc?x=1');
    });

    it('userinfo-style bypass attempt (@ has no special meaning in a path)', () => {
      expect(validateLoginReturnPath('/@evil.com')).toBeNull();
    });

    it('a router-known route nested under an extra unmatched segment', () => {
      expect(validateLoginReturnPath('/foo/sessions/abc')).toBeNull();
    });

    it('mixed-case scheme bypass attempt', () => {
      expect(validateLoginReturnPath('JavaScript:alert(1)')).toBeNull();
    });

    it('data: URI bypass attempt', () => {
      expect(validateLoginReturnPath('data:text/html,<script>alert(1)</script>')).toBeNull();
    });
  });
});
