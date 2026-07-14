# Task 6.1 — Post-login return-path validator

Branch: `session-deep-links`. Commit:
- `9940e6d` feat(web): login return-path validator (reject-by-default, router-known paths)

## Where it lives

`web/src/shared/utils/loginReturnPath.ts` — exports one function,
`validateLoginReturnPath(value: unknown): string | null`. Named to match sibling
utils in the directory (`clientId.ts`, `timecode.ts`, `waveformDecode.ts`, ...);
`loginReturnPath` mirrors the domain-noun naming already used there.

Scope note: this task is the validator only. The stash write (onClick on the three
LoginPage anchors) and the consume effect (keyed on `auth.logged_in === true`) are
tasks 6.2/6.3, not touched here — no `LoginPage.tsx`/`RootGate`/router wiring was
edited.

## Recipe implementation, in the mandated order

The design-D6 / spec recipe is order-sensitive (syntactic rejects before the URL
parse), implemented as four sequential early-returns:

1. **String shape** — `typeof value !== 'string'`, empty, or not starting with
   exactly one `/` (i.e. `startsWith('/') && !startsWith('//')`) → reject. This
   alone rejects every scheme-qualified value (`https://…`, `javascript:…`,
   `data:…`) since none start with `/`.
2. **`\` and ASCII control chars** — `value.includes('\\')` or a
   `/[\x00-\x1f\x7f]/` match → reject. Runs *before* the URL parse deliberately:
   WHATWG treats `\` as `/` for special schemes (so `/\evil.com` parses to host
   `evil.com` exactly like `//evil.com`), and the parser strips raw tab/newline
   from the input as a pre-processing step (so a literal tab embedded as
   `/\t/evil.com` collapses to the `//evil.com` protocol-relative form once
   parsed) — both bypasses only exist if this check is skipped or runs after the
   parse.
3. **Origin equality** — `new URL(value, window.location.origin)` (try/catch →
   reject on throw), then `url.origin !== window.location.origin` → reject.
4. **Router-known pathname** — `/^\/sessions\/([^/]+)$/` against `url.pathname`,
   requiring a non-empty single segment; on match, returns
   `` `${url.pathname}${url.search}` `` (query preserved, hash intentionally
   dropped — not mentioned in the spec's "query string preserved" clause and
   there is no defined router use for it).

Needed one Biome suppression: `noControlCharactersInRegex` on the
`[\x00-\x1f\x7f]` literal (matching control chars is the point of that regex);
verified the rule genuinely fires without the ignore comment (temporarily removed
it, reran `biome check`, saw 2 errors, restored it) rather than assuming it was
needed.

## Corpus coverage (44 tests, all passing)

`web/src/shared/utils/loginReturnPath.test.ts`, grouped by `describe`:

- **accepts** (4): `/sessions/abc`; `/sessions/abc?x=1` and a multi-param query,
  both with the query preserved verbatim in the return value; a session id with
  URL-safe punctuation (`abc-123_def`).
- **non-string / empty / structural** (11, via `it.each` + individual cases):
  `null`, `undefined`, number, plain object, array, boolean, empty string, `/`,
  `/admin/users`, `/sessions`, `/sessions/`, `/sessions/a/b`, a value not
  starting with `/` at all.
- **protocol-relative / scheme bypasses** (8): `//evil.com`,
  `//evil.com/sessions/abc`, `/\evil.com`, `/\/evil.com`, `https://evil.com/x`,
  `http://evil.com/sessions/abc` (see off-origin note below), `javascript:alert(1)`,
  `javascript:/sessions/abc`.
- **backslash / control-character variants** (7): trailing and mid-segment `\`,
  literal tab and newline between slashes (the `//` reassembly quirk), embedded
  NUL and DEL, embedded CR.
- **percent-encoded trickery** (3): `/%2F%2Fevil.com` rejected (verified via a
  direct `node -e` check of `new URL(...).pathname` before writing the
  assertion: it stays literally `/%2F%2Fevil.com`, never decodes into
  `//evil.com`, and is rejected only because that pathname isn't
  `/sessions/<segment>` — not because of any origin trickery); two accept cases
  documenting that percent-encoded `/` or `\` *inside* a session-id segment
  (`/sessions/%2Fabc`, `/sessions/%5C..%2Fevil.com`) stay inert encoded text and
  resolve to ordinary (if unusual-looking) same-origin session ids — asserted as
  accepted with a comment explaining why that's safe, per the task's explicit
  instruction to "assert whatever the recipe produces and comment why it's safe."
- **adversarial additions** (9): whitespace-only value; leading space before the
  slash; triple-slash (`///evil.com`); fragment dropped (not smuggled into the
  return value); query+fragment together (only query preserved); `/@evil.com`
  (userinfo-style bypass attempt — `@` has no authority meaning in a path); a
  router route nested under an extra unmatched prefix segment
  (`/foo/sessions/abc`); mixed-case scheme (`JavaScript:alert(1)`); `data:` URI.

**Off-origin case, explicitly reasoned about:** I could not construct an input
that clears steps 1-2 (single leading `/`, no `\`, no control chars) and is
*only then* rejected by the origin check (step 3) — WHATWG relative-URL
resolution guarantees a path-absolute reference inherits the base's origin, so
once a value passes 1-2 it cannot resolve off-origin. `http://evil.com/sessions/abc`
covers the spec's named "resolves off-origin" corpus item, but is actually
caught at step 1 (no leading `/`); the test comment documents this and notes
step 3 is kept anyway as an independent, non-bypassable gate rather than relying
on that invariant holding forever.

## Gates

- `npx biome check` on both new files: clean (after confirming the one ignore
  comment is load-bearing, not defensive clutter).
- `npm run typecheck` (root, all 4 projects: server/web/companion/e2e): clean.
- `npm test` (root): server 252 passed, web **94** passed (was 50 before this
  task; +44 new, all in `loginReturnPath.test.ts`, 10 files total), companion 20
  passed.
- `npm run lint` (web + e2e): clean for the two new files; the pre-existing
  `loadingVideo.ts` `useOptionalChain` warnings are unrelated (unsafe-fix-only,
  untouched, already noted in the 5.1/5.2 report).
- `git status` before commit: exactly the two new files, nothing else staged.

## Files touched

- `web/src/shared/utils/loginReturnPath.ts` (new)
- `web/src/shared/utils/loginReturnPath.test.ts` (new)
