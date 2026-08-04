/// <reference types="node" />
// Like noAgentAuthoredMarkup.repo.test.ts and queryKeyFactories.repo.test.ts,
// this file needs Node's filesystem APIs (walking web/src from disk); the
// directive scopes the Node global-module types to this file alone rather than
// widening web/tsconfig.json's `types` for the whole workspace.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// --- Repo-invariant guard: no response-consuming site skips verification ---
// (openspec/changes/web-api-shape-conformance, design D5; spec requirement
// "New response-consuming sites cannot silently skip verification"; task 5.3)
//
// WHAT THIS EXISTS FOR. `apiFetch<T>`'s success path is `res.json() as
// Promise<T>` — an ASSERTION, not a check. Every call site hand-names the shape
// it expects and TypeScript believes it. Twice now a hand-transcribed shape has
// been wrong on the wire (commit 2ca5b1d's show categories; `AdminUser
// .memberships`, which unmounted /admin/users). Every other phase of this
// change fixes what exists TODAY. This file is the only forward-looking
// mechanism: it fails when a NEW site gives a client type to a JSON response
// with neither a conformance check nor a recorded, deliberate exemption.
//
// A GUARD WITH A SILENT GAP LOOKS EXACTLY LIKE A GUARD THAT WORKS. The failure
// mode designed against here is the false NEGATIVE — a new hand-transcribed
// response type the scan never sees. A false positive is cheap and visible; a
// false negative is how the original bug shipped. Five structural choices
// follow from that:
//
//   1. The population is the union of SIX detectors over application code,
//      deliberately over-broad: every `apiFetch` call (typed or not, under its
//      imported name, under an import alias, or under a namespace qualifier
//      from `import * as api`), every call to a generic wrapper over `apiFetch`
//      THIS SCANNER CAN NAME (DISCOVERED tree-wide, not hardcoded and not
//      per-file, and iterated to a FIXED POINT so that a wrapper over a wrapper
//      is a wrapper — this is the population `grep 'apiFetch<'` missed and the
//      `memberships` crash lived in; five spellings it cannot name are listed
//      below and are the third-ranked residual), every UNQUALIFIED global
//      `fetch(`, every `Response.json()`, every
//      `JSON.parse(`, and every raw network primitive (`navigator.sendBeacon`,
//      `new EventSource`, `new XMLHttpRequest`).
//      Detector 7 additionally scans the conformance module itself. Anything a
//      JSON payload can enter web/src through is a site whether or not it looks
//      like a mistake. Over-matching costs a one-line exemption; under-matching
//      costs the next outage.
//   2. Nothing is covered by being ignored. A site is COVERED only when every
//      client type it acquires is (i) assigned a CAPTURED fixture by a
//      `const x: T = <fixture>` declaration in `api/types.conformance.test.ts`
//      — read out of detector 7's own parse of that module, so adding a real
//      check is what makes a site pass, and importing a name is not a check;
//      (ii) fed by an import whose SPECIFIER'S SPELLING names a fixture the
//      server declares it captures — the basename after `fixtures/api-responses/`
//      is cross-checked against the `CaptureSpec` names in
//      `server/src/routers/apiResponseFixtures.int.test.ts`. This repairs the
//      original bug ("the specifier contains `fixtures/api-responses/`", a path
//      substring over a directory OUTSIDE this scan's root, which on its own let
//      a hand-authored module dropped in beside the captures confer full
//      coverage) but the specifier is still matched by SPELLING, never RESOLVED
//      to a file: a hand-authored module of the same name sitting in a PARALLEL
//      directory (e.g. `web/fixtures/api-responses/`) matches the same pattern
//      and confers the same full coverage. Recorded, not closed — see the
//      residual below and audit.md §11.5; (iii) assigned by a
//      declaration that actually ASSERTS something, i.e. one that neither sits
//      under a `@ts-expect-error` nor casts its initializer
//      (`fixture as unknown as T` compiles whatever the capture's shape is);
//      and (iv) in scope in the SITE'S OWN FILE via an import whose specifier
//      RESOLVES — relative to that file, not merely spelled `types` — to the
//      canonical `api/types` module, under the export name that was checked.
//      Clause (iv) is what stops a locally declared type, or one imported from
//      a sibling per-feature `types.ts`, or one aliased onto a checked name,
//      from inheriting coverage by sharing a spelling; a specifier that does not
//      resolve inside the tree contributes no coverage at all, so its sites
//      surface. Alias resolution runs on BOTH sides — the conformance module
//      records its check under the ORIGINAL export name, so
//      `import type { Session as LogEvent }` there checks `Session` and lends
//      `LogEvent` nothing. Everything else must be exempted BY SITE, with a reason,
//      in EXEMPTIONS below — never by file, never by glob, never by a type-wide
//      or category-wide rule that a future site could fall into unnoticed.
//      `apiFetch<OkResponse>` is the cautionary case: it reads as trivially
//      safe, and audit finding CW-1 proved it was not (transport start/stop
//      emit the transport state and no `ok` key at all). So each of those
//      sites carries its own exemption naming its audit row, and a NEW
//      `OkResponse` site is covered by none of them: the site descriptor
//      carries the literal HTTP method, and exemptions are CONSUMED one entry
//      per site, so a second site cannot shelter under the first's entry.
//   3. The scan is asserted to SEE things. A regex that matches zero files
//      passes forever. `POPULATION_FLOOR`, the per-detector minimums, and
//      CANARY_SITES all fail loudly if the walk or a pattern is over-narrowed,
//      so an empty scan cannot masquerade as a clean repo. Surplus exemption
//      entries (more entries than matching sites) are also an error — the same
//      vacuity check from the other direction. Floors sit a few sites under
//      today's counts, and how much slack each allows is written next to it: a
//      floor far below its count is itself a way to lose sites silently.
//   4. NOTHING IS EVER DROPPED FOR BEING UNPARSEABLE. A call whose type-argument
//      list this scanner cannot take apart is recorded with an unparsed type
//      expression and no acquired names, which makes it uncovered and forces a
//      decision. It used to `continue`, so `apiFetch<{ ok: boolean; detail:
//      string }>(…)` — the spelling `npx biome format` writes, since it rewrites
//      the comma form into it — produced no site AT ALL. "I could not parse
//      this" and "there is nothing here" must never be the same outcome.
//   5. The detectors are mutation-checked, over MULTI-FILE synthetic trees as
//      well as single-file ones. The first describe block runs the real scanner
//      over trees carrying a planted unverified site of each shape — including
//      a wrapper declared in one file and called from another, a wrapper over a
//      wrapper (twice: once ORDERED so a single discovery round provably cannot
//      suffice), a wrapper with an object return-type annotation and one with an
//      object type-parameter constraint, a namespace-qualified `api.apiFetch<T>`,
//      a semicolon-separated and an arrow-typed inline type argument, an
//      unparseable one, two sites on one path differing only in method, a
//      locally declared type shadowing a checked name, a sibling `types.ts`
//      shadowing one, an import alias in both directions on both sides, a
//      cast-defeated conformance assignment, and a hand-authored module sitting
//      in the fixture directory — and over a clean tree, so "the guard fires"
//      and "the guard does not just always-fire" are both demonstrated rather
//      than assumed. Single-file fixtures alone hid three gaps for a whole
//      review cycle; a second adversarial round found three more, and a third
//      found three more again. Every case below is a former false negative.
//      Non-vacuity — reverting one fix and confirming that its own test, and
//      only its own test, goes red — was RUN for each of the nine fixes added in
//      the branch-audit round, and audit §11.9 tabulates those nine runs. It is
//      NOT re-asserted for the earlier rounds' tests: the third round claimed
//      exactly that check without performing it, and one of those tests turned
//      out to pass with its fix reverted. Treat "verified" as covering the nine
//      tabulated runs and nothing else.
//
// WHAT IT CANNOT SEE — stated, not glossed (audit.md §8 records the same list
// for the one-time enumeration, §11.5 the ranked version). Ordered by how
// reachable each is by an ordinary refactor, largest first; where two are
// equally reachable, the one that fails SILENTLY ranks higher. Nothing here is
// stated as absolute unless the code enforces it. The item immediately below
// is ranked TOP as of this documentation wave: an UNDISCLOSED hole that
// outranks the two structural ones that follow because it fails silently on
// ordinary new code, not on an unusual shape or an architectural choice:
//   - An INLINE OBJECT type argument inherits coverage from a member's name.
//     `isCovered` reduces a type expression to the PascalCase names inside it
//     (`typeNamesIn`), so `apiFetch<{ hand_transcribed_wrong_key: SessionTopic[];
//     total: number }>(…)` is reported COVERED — solely because `SessionTopic`
//     is covered — with NO exemption, even though the ENVELOPE (the object
//     shape wrapping it, e.g. a brand-new endpoint's whole response body) was
//     never checked against any captured fixture. This is exactly the class of
//     bug this guard exists to catch, undetected by it. The tree already
//     carries five such inline-envelope call sites (two on
//     `{ words: TranscriptWord[] }`, two on `{ topics: SessionTopic[] }`, one
//     on `{ show: Show }`); only the `{ show: Show }` site's shape has a
//     matching whole-annotation assertion in the conformance module
//     (`const check: { show: Show } = showCreate`), and even that one
//     contributes nothing to `covered` status — detector 7 turns a bare type
//     name (or an array of it) into a `headType`, never an inline object, so
//     deleting that assertion would not change any site's covered status.
//     Reachable by writing an ordinary new endpoint call with no refactor or
//     unusual code shape, which is why it outranks the two items below.
//     Closing it needs a detector change — treat a type expression containing
//     `{` as uncovered unless the conformance module carries a matching
//     whole-annotation assertion (the `inlineObject` branch already parses
//     those; it just never exports them as coverage) — deliberately deferred
//     to its own review pass rather than folded into this documentation wave.
//   - Indirect type acquisition. A JSON value passed as `unknown` into a typed
//     helper several modules away acquires its type at no `fetch`/`.json()`/
//     `JSON.parse` token, so no detector fires (audit §8.3). This is the
//     largest REMAINING structural hole: it is a limit of matching on
//     deserialization syntax, not a tuning gap.
//   - A CALLEE THIS SCANNER CANNOT NAME. The scan resolves `apiFetch` through a
//     named import (including `import { apiFetch as x }`) and through a
//     namespace qualifier (`import * as api` … `api.apiFetch<T>(…)`), and it
//     resolves wrappers by matching two declaration forms — `function name<T>(…)`
//     and `const name = <T>(…)` / `const name = async <T>(…)` — and then by that
//     DECLARED name anywhere in the tree. Five spellings defeat that, EACH
//     VERIFIED BY PLANTING against this code; under every one the call site is
//     invisible, not merely mis-keyed:
//       (a) an in-file rebinding — `const call = apiFetch;` then `call<T>(p)`
//           produces ZERO sites, not even the rebinding;
//       (b) a re-export that renames, `export { apiFetch as request } from
//           './client'` in a third module;
//       (c) a wrapper imported under an alias, `import { fetchTyped as ft }`;
//       (d) a CLASS-METHOD wrapper — `class Api { async get<T>(p): Promise<T>
//           { return apiFetch<T>(p) } }`; only the forwarding `apiFetch<T>(p)`
//           plumbing site appears, and `api.get<Thing>(…)` does not;
//       (e) an ANNOTATED arrow const — `const f: <T>(p: string) => Promise<T> =
//           <T>(p) => apiFetch<T>(p)`; the annotation's `:` defeats the `const
//           name =` form, with the same result as (d).
//     Left as a documented residual rather than widened: (d) and (e) need a
//     declaration matcher broad enough to also match ordinary generic CALLS,
//     which is a detector change this round did not review. One token of
//     refactor away, and the same class as the three wrapper-discovery false
//     negatives already found, which is why this ranks third.
//     The same shape one detector over: `fetch(` is matched only UNQUALIFIED.
//     `window.fetch(…)` and `globalThis.fetch(…)` produce no rawFetch site
//     (verified by planting) — the `(?<![.\w$])` lookbehind that stops
//     `foo.fetch(` from matching rejects them too. A typed `.json()` on the
//     result is still a site, so this loses the REQUEST half only.
//   - Whether a COVERED type is checked against the RIGHT endpoint's fixture.
//     Coverage is per type NAME, not per (site, endpoint) pair: reusing an
//     already-checked type on a new endpoint passes silently. The same
//     looseness sits inside the conformance module — a `const x: T = <binding>`
//     counts when the binding is ANY declared capture, so a slice of an
//     unrelated one (`const s: Session = adminUsers.users[0]`) would count as
//     `Session`'s check. The fixture must now BE a declared capture, which is a
//     different and weaker property than being the RIGHT one. Deciding which
//     fixture belongs to which type is the audit's per-row verdict table (§5),
//     which is a snapshot, not a standing check; the guard cannot derive that
//     mapping and does not pretend to.
//   - A hand-authored module in a PARALLEL fixture directory still confers full
//     coverage. `capturedFixtureName` matches an import specifier by SPELLING —
//     it accepts anything ending in `fixtures/api-responses/<declared name>`,
//     wherever that path sits — and never resolves the specifier to a real file
//     under this repo's actual `fixtures/api-responses/`. A hand-authored
//     `adminUsers.json` dropped in a PARALLEL directory (e.g.
//     `web/fixtures/api-responses/`, or nested anywhere under `web/src`, such as
//     `web/src/api/plantfix/fixtures/api-responses/`) matches the pattern and
//     confers coverage on a brand-new, wholly hand-transcribed type, verified by
//     planting (43/43 green). The directory/inventory equality assertion (see
//     `declaredCaptureNames`) only checks the REAL `FIXTURE_DIR`, so it cannot
//     see a parallel one. Recorded rather than closed: the fix is roughly three
//     lines (resolve the specifier relative to the conformance module and
//     require the result to be a file under `FIXTURE_DIR`) but is a detector
//     change deliberately deferred to its own review pass.
//   - Sites whose collision the method cannot break. Two calls on one path
//     with the same literal method — or with the method threaded in through a
//     variable — still normalise to one key. They are not absorbed (exemptions
//     are consumed one-for-one, so the second surfaces), but the two entries
//     are told apart only by their `reason` text.
//   - Test files. `*.test.ts(x)` and `test/` under web/src are outside the
//     application-code scan. Detector 7 is the one deliberate exception and it
//     covers only the conformance module.
//   - A re-assertion downstream of an already-flagged parse. Only the
//     deserialization token is a site; a later `x as SomeType` on the same
//     value is not separately detected (see the `dashboardPersistence` local-
//     storage exemption, whose reason names both lines).
//   - Data-dependent branches no captured fixture reaches (audit CW-9).
//   - WebSocket frames, an explicit Non-Goal of this change — the one
//     `JSON.parse(ev.data)` site is exempted as such, so a SECOND one would
//     still surface.
//   - Prose. Detectors skip matches inside comments (see `isProse`), the same
//     concession noAgentAuthoredMarkup.repo.test.ts makes; a real call written
//     after a `//` on the same line would be missed. String and template
//     literals are masked before that test, so a URL's `//` no longer hides
//     the rest of its line.
//   - Whether an exemption's `reason` is TRUE, or even what it CONTAINS. The
//     only mechanical requirement is length: `reason.trim().length >= 40`.
//     Most entries additionally cite the audit row backing their verdict, but
//     that is a convention the entries keep, not a rule the guard enforces —
//     five of the fifty-two cite no row, three of those five naming no anchor
//     at all, and a forty-character sentence of nothing would pass. The
//     reason field is written for the next reviewer to read, not for the
//     guard to adjudicate.
//   - A declaration's BODY is located by a hand-rolled scanner, not a parser.
//     It skips strings and comments and balances parens, angles and braces, and
//     it distinguishes a body's `{` from an object type's by what precedes it
//     (see `opensDeclarationBody`) — a heuristic, not a grammar. A declaration
//     shaped so that heuristic misreads it would un-discover the wrapper
//     silently. Ranked last of the reachable items because every spelling this
//     tree and its plausible refactors produce is covered by a test below, but
//     recorded because "no counter-example found" is not "none exists". No
//     test PINS `opensDeclarationBody` itself, either: neutering it to always
//     return `true` (keeping the `angleDepth === 0` guard that calls it) leaves
//     every test in this file green, because every case below that reaches the
//     `angleDepth === 0` branch already has a `prev` character the un-neutered
//     function also treats as opening a body.

const CODE_EXTENSIONS = new Set(['.ts', '.tsx']);
const EXCLUDED_DIR_NAMES = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);

/** This file's own directory (`web/src`), and the repo root above it. The
 * capture-spec inventory the fixture cross-check reads (see
 * `declaredCaptureNames`) lives outside both workspaces. */
const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..', '..');
const FIXTURE_DIR = path.join(REPO_ROOT, 'fixtures', 'api-responses');
const CAPTURE_SPEC_SOURCE = path.join(
  REPO_ROOT,
  'server',
  'src',
  'routers',
  'apiResponseFixtures.int.test.ts',
);
/** The one file under `fixtures/api-responses/` that is NOT a capture: the
 * hand-written `Mutable<T>` support type the generated `.ts` fixtures import
 * (audit §9, and the residual in §10). */
const FIXTURE_SUPPORT_MODULES = new Set(['_mutable.ts']);

/** The conformance module — the sole authority on which client types are
 * checked against a captured response, and the target of detector 7. */
const CONFORMANCE_MODULE = 'api/types.conformance.test.ts';

/** The canonical client response-type module, as a path relative to the scan
 * root. A type name only inherits a conformance check when the site's own file
 * imports it from THIS module — resolved, not merely spelled. */
const CLIENT_TYPES_MODULE = 'api/types';

// ---------------------------------------------------------------------------
// Filesystem walk
// ---------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  // SORTED, so the walk order — and therefore the order wrapper discovery
  // visits files in — is a property of the tree rather than of the filesystem.
  // A fixed-point test that only converges because the declaring file happens
  // to be read first is a test that proves nothing (audit §11.9, I3).
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (CODE_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

function isTestFile(rel: string): boolean {
  return /\.test\.tsx?$/.test(rel) || rel.startsWith('test/');
}

function relOf(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

/** Resolves an import specifier written inside `rel` to a scan-root-relative
 * module path, or `null` when it does not resolve inside the tree (a bare
 * package name, a tsconfig path alias).
 *
 * Exists because "the specifier is spelled `types`" is not the same question as
 * "the specifier IS the client response-type module". `src/pages/x/types.ts` is
 * an ordinary per-feature module in a React tree, and the names it would
 * plausibly redeclare — `Session`, `Category`, `LogEvent`, `AudioSegment` — are
 * exactly the checked ones. Matching on the basename let such a module lend its
 * locally declared shapes the coverage of the real `api/types`.
 *
 * Returning `null` for a non-relative specifier is the SAFE direction: an
 * unresolvable import contributes no covered names, so its sites surface as
 * unverified rather than silently passing. */
function resolveSpecifier(rel: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
  if (joined.startsWith('..')) return null; // escapes the scan root
  return joined.replace(/\.(tsx?|jsx?)$/, '').replace(/\/index$/, '');
}

// ---------------------------------------------------------------------------
// Source scanning primitives
// ---------------------------------------------------------------------------

/** Collapses whitespace so a site key survives reformatting and line moves. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Replaces `${…}` interpolations with a placeholder so that renaming a
 * variable does not churn every exemption key that mentions the endpoint.
 * The placeholder is the literal text `<var>`, which also keeps the keys below
 * plain strings with no interpolation syntax of their own — an exemption key is
 * data, not a template. */
function normalizeArg(text: string): string {
  return collapse(text).replace(/\$\{[^}]*\}/g, '<var>');
}

function lineStartOf(content: string, index: number): number {
  return content.lastIndexOf('\n', index) + 1;
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content[i] === '\n') line++;
  return line;
}

function lineTextAt(content: string, index: number): string {
  const start = lineStartOf(content, index);
  let end = content.indexOf('\n', index);
  if (end === -1) end = content.length;
  return collapse(content.slice(start, end));
}

/** Blanks out the CONTENTS of every string and template literal, preserving
 * offsets and line structure. Comments are left untouched.
 *
 * This exists for `isProse` alone. A naive "is there a `//` earlier on this
 * line" test treats the `//` in `fetch('https://host/x')` as a comment opener
 * and silently discards everything after it — including, in the real tree, the
 * `.json() as X` typed read on the same line. Discarding a TYPED read is the
 * exact false negative this guard is built against, so the prose test runs
 * against the masked copy, where a URL's `//` no longer exists.
 *
 * Masking only ever REMOVES apparent comment openers, never adds one, so the
 * worst case is that a token inside a string is treated as a real site — the
 * cheap, visible direction. */
function maskLiterals(content: string): string {
  const out = content.split('');
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    if (ch === '/' && content[i + 1] === '/') {
      const nl = content.indexOf('\n', i);
      i = nl === -1 ? content.length : nl;
      continue;
    }
    if (ch === '/' && content[i + 1] === '*') {
      const end = content.indexOf('*/', i + 2);
      i = end === -1 ? content.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      for (; j < content.length; j++) {
        const c = content[j];
        if (c === '\\') {
          out[j] = ' ';
          if (j + 1 < content.length && content[j + 1] !== '\n') out[j + 1] = ' ';
          j++;
          continue;
        }
        if (c === ch) break;
        if (ch !== '`' && c === '\n') break; // unterminated: not a literal, bail
        if (c !== '\n') out[j] = ' ';
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}

/** True when the match at `index` sits inside a comment — a `//` earlier on the
 * line, or a JSDoc/block-comment continuation line. Prose naming `sendBeacon`
 * or `EventSource` is common in this codebase's module headers and must not
 * masquerade as a call site; the same concession the repo's other repo-guards
 * make for comments that document an invariant.
 *
 * `masked` MUST be `maskLiterals(content)`, not the raw source — see there. */
function isProse(masked: string, index: number): boolean {
  const start = lineStartOf(masked, index);
  const before = masked.slice(start, index);
  if (before.includes('//')) return true;
  const trimmed = before.trimStart();
  return trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/** Reads a balanced `<…>` starting at `open` (which must index a `<`).
 * Returns the inner text and the index just past the closing `>`, or null when
 * the list cannot be parsed — in which case the CALLER still records the site
 * (see `scanFile`), because dropping one is the single direction this guard
 * must never fail in.
 *
 * Two things a type-argument list does that a naive angle-balancer gets wrong,
 * both of which silently deleted real sites (audit §11.9, I1):
 *
 *   - `;` separates the MEMBERS of an inline object type. Treating every `;` as
 *     a statement break made `apiFetch<{ ok: boolean; detail: string }>` — the
 *     only spelling `npx biome format` produces, since it rewrites the comma
 *     form into it — unparseable, and therefore invisible. A `;` is a statement
 *     break only outside `{…}`; inside one it is ordinary punctuation.
 *   - The `>` of an arrow type (`{ cb: () => void }`) is not a closer. Counting
 *     it as one closed the list early, after which the next character was not
 *     `(` and the whole call was discarded as "a reference, not a call".
 *
 * The `;`-outside-braces bail is kept so that a stray `<` cannot swallow the
 * rest of the file, but it is no longer a silent drop. */
function readAngles(content: string, open: number): { inner: string; end: number } | null {
  if (content[open] !== '<') return null;
  let depth = 0;
  let braceDepth = 0;
  for (let i = open; i < content.length; i++) {
    const ch = content[i];
    if (ch === '<') depth++;
    else if (ch === '>') {
      if (content[i - 1] === '=') continue; // the `>` of `() => T`, not a closer
      depth--;
      if (depth === 0) return { inner: content.slice(open + 1, i), end: i + 1 };
    } else if (ch === '{') braceDepth++;
    else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
    else if (ch === ';' && braceDepth === 0) {
      return null;
    }
  }
  return null;
}

/** Reads the top-level arguments of a call whose `(` is at `open`, honouring
 * nested brackets, quotes, and template interpolations. */
function readArgs(content: string, open: number): string[] {
  if (content[open] !== '(') return [];
  const args: string[] = [];
  let start = open + 1;
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < content.length; i++) {
    const ch = content[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (ch === ')' && depth === 0) {
        args.push(content.slice(start, i));
        return args;
      }
      depth--;
    } else if (ch === ',' && depth === 0) {
      args.push(content.slice(start, i));
      start = i + 1;
    }
  }
  args.push(content.slice(start));
  return args;
}

/** The HTTP method a request site names literally in its init argument.
 *
 * Part of the site's IDENTITY, not decoration. Without it `apiFetch<OkResponse>
 * (\`sessions/<var>\`, {method:'DELETE'})` and the same path with `'PUT'`
 * collapse to one key, and the PUT — a different endpoint, with a different
 * body, never audited — inherits the DELETE's exemption. For `{ok}`-shaped
 * mutation endpoints that collision is the COMMON case, and `OkResponse` is the
 * bucket audit finding CW-1 hid in.
 *
 * Read from ANY argument after the first, not positionally: `fetchAdmin(path,
 * token, {method})` puts its init third, and a wrapper is free to put it
 * anywhere. Only a literal `method: '…'` counts — a method threaded in through
 * a variable yields no suffix and therefore still collides, which is why
 * exemptions are additionally consumed one-for-one (see `scanTree`). */
function literalMethodOf(args: readonly string[]): string | null {
  const m = args
    .slice(1)
    .join(',')
    .match(/\bmethod\s*:\s*['"]([A-Za-z]+)['"]/);
  return m ? m[1].toUpperCase() : null;
}

/** True when a `{` at this position OPENS A BODY rather than an object type.
 *
 * `prev` is the last non-whitespace character before it. Inside a type
 * annotation a `{` can only follow an operator that is still expecting a type
 * (`:`, `|`, `&`, `<`, `,`, `(`, `=`, `?`, `[`, `extends`… ), whereas a body's
 * `{` always follows a COMPLETED thing — the parameter list's `)`, the `>` of
 * `Promise<…>` or of `=>`, a closing `}`/`]`, or the last character of a type
 * name. That distinction is the whole of the I2 fix: `function f<T>(p):
 * Promise<{ data: T; total: number }> { … }` opens two top-level-looking braces
 * and only the second is the body. */
function opensDeclarationBody(prev: string): boolean {
  return prev === ')' || prev === '}' || prev === ']' || prev === '>' || /[A-Za-z0-9_$]/.test(prev);
}

/** The index just past a comment starting at `i`, or `i` when none starts
 * there. Braces and semicolons inside a comment are not syntax, and a
 * declaration scanner that counted them could mis-place a body and thereby
 * un-discover a wrapper — a silent false negative. */
function skipComment(content: string, i: number): number {
  if (content[i] === '/' && content[i + 1] === '/') {
    const nl = content.indexOf('\n', i);
    return nl === -1 ? content.length : nl;
  }
  if (content[i] === '/' && content[i + 1] === '*') {
    const end = content.indexOf('*/', i + 2);
    return end === -1 ? content.length : end + 2;
  }
  return i;
}

/** Skips a balanced `{…}` starting at `open`, returning the index of its
 * closing `}` (or the end of input). Quote- and comment-aware, so a brace
 * inside either does not unbalance it. */
function skipBalancedBraces(content: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < content.length; i++) {
    const ch = content[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    const past = skipComment(content, i);
    if (past !== i) {
      i = past - 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return content.length - 1;
}

/** The source text of a function declaration starting at `start`, read to its
 * BALANCED closing brace (or, for a concise arrow body, its terminating `;`).
 *
 * A fixed-size window would silently stop looking partway through a long
 * function, so a wrapper whose forwarding call sits past the cutoff would be
 * laundered out of the population — the same class of miss this guard exists
 * to prevent.
 *
 * TWO KINDS OF `{` ARE NOT THE BODY, and returning at either of them ends the
 * read before the forwarding call, which un-discovers the wrapper and deletes
 * every one of its call sites from the population — the C1/NEW-1 class, found a
 * third time as I2 (audit §11.9). Braces in the PARAMETER list (destructuring,
 * inline parameter types) are skipped by paren depth, as before. Braces in the
 * TYPE-PARAMETER list (`<T extends { id: string }>`) and in a RETURN-TYPE
 * annotation (`: Promise<{ data: T }>`, `: { data: T }`) are skipped by angle
 * depth plus `opensDeclarationBody`, and are balanced past rather than
 * returned at. */
function readDeclarationBody(content: string, start: number): string {
  let parenDepth = 0;
  let angleDepth = 0;
  let quote: string | null = null;
  let prev = '';
  let bodyOpen = -1;
  for (let i = start; i < content.length; i++) {
    const ch = content[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    const past = skipComment(content, i);
    if (past !== i) {
      i = past - 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      prev = ch;
      continue;
    }
    if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (parenDepth === 0 && ch === '<') angleDepth++;
    else if (parenDepth === 0 && ch === '>' && prev !== '=') {
      angleDepth = Math.max(0, angleDepth - 1);
    } else if (parenDepth === 0 && ch === '{') {
      if (angleDepth === 0 && opensDeclarationBody(prev)) {
        bodyOpen = i;
        break;
      }
      i = skipBalancedBraces(content, i);
      prev = '}';
      continue;
    } else if (ch === ';' && parenDepth === 0 && angleDepth === 0) {
      return content.slice(start, i + 1); // a concise arrow body, or a bare signature
    }
    if (!/\s/.test(ch)) prev = ch;
  }
  if (bodyOpen === -1) return content.slice(start);
  return content.slice(start, skipBalancedBraces(content, bodyOpen) + 1);
}

/** The PascalCase type names mentioned anywhere in a type expression. */
function typeNamesIn(typeExpr: string): string[] {
  return [...new Set(typeExpr.match(/\b[A-Z][A-Za-z0-9_]*\b/g) ?? [])];
}

/** The `as <type>` assertion applied at or after `from`, within the same line. */
function assertionAfter(content: string, from: number): string | null {
  let end = content.indexOf('\n', from);
  if (end === -1) end = content.length;
  const tail = content.slice(from, end);
  const m = tail.match(/\bas\s+([^;]+?)\s*(?:;|\)\s*$|$)/);
  return m ? collapse(m[1]) : null;
}

// ---------------------------------------------------------------------------
// The detectors
// ---------------------------------------------------------------------------

type Detector =
  | 'apiFetch' // populations (a)+(c) — the shared client helper, typed or not
  | 'wrapper' // population (b) — a LOCAL generic function forwarding to apiFetch<T>
  | 'rawFetch' // population (d) — global fetch(), bypassing the shared helper
  | 'jsonBody' // population (d) — Response.json(), wherever it happens
  | 'jsonParse' // population (d) — JSON.parse, incl. SSE frames and WS messages
  | 'beacon' // population (d) — sendBeacon / EventSource / XMLHttpRequest
  | 'conformanceAssertion'; // the conformance module's own inputs

interface Site {
  detector: Detector;
  file: string;
  line: number;
  /** Stable identity: `<file> :: <descriptor>`. Line-independent on purpose. */
  key: string;
  descriptor: string;
  /** Client type names this site applies to a payload, if any. */
  typeNames: string[];
  /** True when every acquired type name is checked against a captured fixture. */
  covered: boolean;
  /** Detector 7 only: the annotation's type name, when the declaration is a
   * plain `const x: T = …` / `const x: T[] = …` that is expected to COMPILE.
   * This is what makes a type name count as fixture-checked. */
  headType?: string;
}

/** Every local binding in this file that IS `apiFetch`, alias included.
 *
 * `import { apiFetch as request }` followed by `request<T>(…)` is `apiFetch`
 * under another name; matching the literal identifier alone makes the whole
 * file's population vanish. Aliasing is a one-token refactor, so the base name
 * is read from the import statement rather than assumed. */
function apiFetchBindings(content: string): string[] {
  const names = new Set<string>(['apiFetch']);
  const imports = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"][^'"]*['"]/g;
  for (let m = imports.exec(content); m !== null; m = imports.exec(content)) {
    for (const part of m[1].split(',')) {
      const [original, alias] = part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/);
      if (original?.trim() === 'apiFetch') names.add((alias ?? original).trim());
    }
  }
  return [...names];
}

/** Local names bound by a NAMESPACE import (`import * as api from './client'`).
 *
 * `api.apiFetch<T>(…)` is `apiFetch` under a qualifier, and the callee scan's
 * `(?<![.\w$])` lookbehind — which exists to stop `foo.fetch(` from matching the
 * global `fetch` — rejects it. `import * as` is a live idiom in this tree (five
 * Radix modules and a test), so the qualified form is one refactor away. */
function namespaceBindings(content: string): string[] {
  const out = new Set<string>();
  const re = /import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*['"][^'"]*['"]/g;
  for (let m = re.exec(content); m !== null; m = re.exec(content)) out.add(m[1]);
  return [...out];
}

/** A regex source matching `callee` either bare or qualified by one of this
 * file's namespace-import bindings. The match ENDS at the callee name, so a
 * caller advances its cursor by the whole match, not by the callee's length.
 *
 * The lookbehind sits before the optional qualifier, so `api.apiFetch` matches
 * once (at `api`) rather than twice, and a bare `apiFetch` in the same file
 * still matches — `api` is a prefix of `apiFetch`, but the qualifier alternative
 * requires a following `.` and backtracks out. */
function calleePattern(callee: string, nsNames: readonly string[]): string {
  const qualifier = nsNames.length > 0 ? `(?:(?:${nsNames.join('|')})\\s*\\.\\s*)?` : '';
  return `(?<![.\\w$])${qualifier}${callee}`;
}

/** Maps each type name this file has in scope from the CANONICAL client
 * response-type module (`api/types`) to the name it is exported under there.
 *
 * A site's type only counts as COVERED when its name resolves HERE, so a file
 * declaring its own `interface Session` — or importing one from a sibling
 * `types.ts` — cannot borrow the coverage of the checked `Session` merely by
 * sharing its spelling. The specifier is RESOLVED against the importing file
 * (see `resolveSpecifier`); matching its basename would readmit every
 * per-feature `types.ts` in the tree.
 *
 * The value is the ORIGINAL export name, not the local one, because an import
 * alias moves coverage in both directions: `import type { Session as S }` must
 * let `apiFetch<S>` inherit `Session`'s check, and `import type { BrandNew as
 * Session }` must NOT let `apiFetch<Session>` inherit it. */
function clientTypeImports(rel: string, content: string): Map<string, string> {
  const out = new Map<string, string>();
  const imports = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]*)['"]/g;
  for (let m = imports.exec(content); m !== null; m = imports.exec(content)) {
    if (resolveSpecifier(rel, m[2]) !== CLIENT_TYPES_MODULE) continue;
    for (const part of m[1].split(',')) {
      const [original, alias] = part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
        .map((s) => s.trim());
      const local = alias ?? original ?? '';
      if (/^[A-Za-z_$][\w$]*$/.test(local) && /^[A-Za-z_$][\w$]*$/.test(original ?? ''))
        out.set(local, original);
    }
  }
  return out;
}

/** Names of local generic wrappers over `apiFetch<T>` (population (b)).
 * DISCOVERED, not hardcoded: any generic function whose body forwards one of
 * its own type parameters to `apiFetch<…>` is a wrapper.
 *
 * `baseNames` is this file's set of `apiFetch` bindings (see
 * `apiFetchBindings`). The forwarding test matches `apiFetch<… T …>` rather
 * than `apiFetch<T>` exactly, so `apiFetch<T[]>`, `apiFetch<T | null>` and
 * `apiFetch<Envelope<T>>` all count — a `fetchList<T>(): Promise<T[]>` helper
 * is the most natural next wrapper in this codebase, and the exact-match test
 * would have laundered every one of its call sites.
 *
 * The RESULT of this function is unioned across the whole tree AND ITERATED TO A
 * FIXED POINT before any file is scanned (see `scanTree`). Per-file discovery
 * only worked because `fetchAdmin` happens to be declared and called in the same
 * file; a wrapper exported from its own module would contribute nothing but its
 * own plumbing, and the call site carrying the concrete hand-transcribed type —
 * the one that matters, the one the `memberships` crash lived at — would never
 * appear. Anchoring `baseNames` to `apiFetch` alone had the same shape one level
 * up: `fetchOuter<T>` forwarding to `fetchInner<T>` forwarding to `apiFetch<T>`
 * is still a wrapper, and its call sites are still hand-transcribed types. */
function discoverWrappers(content: string, baseNames: readonly string[]): string[] {
  const found: string[] = [];
  const base = new Set(baseNames);
  const nsNames = namespaceBindings(content);
  const decl =
    /(?:function\s+([A-Za-z_$][\w$]*)\s*<([^>]*)>|const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?<([^>]*)>)/g;
  for (let m = decl.exec(content); m !== null; m = decl.exec(content)) {
    const name = m[1] ?? m[3];
    if (base.has(name)) continue; // the helper itself, not a wrapper of it
    const params = (m[2] ?? m[4])
      .split(',')
      .map((p) => p.trim().split(/[\s=]/)[0])
      .filter((p) => /^[A-Za-z_$][\w$]*$/.test(p));
    const body = readDeclarationBody(content, m.index);
    const forwards = params.some((p) =>
      baseNames.some((b) =>
        new RegExp(`${calleePattern(b, nsNames)}\\s*<[^>]*\\b${p}\\b`).test(body),
      ),
    );
    if (forwards) found.push(name);
  }
  return [...new Set(found)];
}

function scanFile(
  rel: string,
  content: string,
  coveredTypes: Set<string>,
  treeWrappers: ReadonlySet<string>,
): Site[] {
  const sites: Site[] = [];
  const masked = maskLiterals(content);
  const typeImports = clientTypeImports(rel, content);
  /** A type name counts only when it resolves to the canonical `api/types` from
   * this file AND the name it resolves to is fixture-checked there. */
  const isCovered = (names: string[]) =>
    names.length > 0 &&
    names.every((n) => {
      const original = typeImports.get(n);
      return original !== undefined && coveredTypes.has(original);
    });
  const push = (
    detector: Detector,
    index: number,
    descriptor: string,
    typeNames: string[],
    covered: boolean,
  ) => {
    sites.push({
      detector,
      file: rel,
      line: lineOf(content, index),
      key: `${rel} :: ${descriptor}`,
      descriptor,
      typeNames,
      covered,
    });
  };

  // Detectors 1 + 2 — every `apiFetch` binding (alias included) and every
  // wrapper discovered ANYWHERE in the tree, not just in this file.
  const baseNames = apiFetchBindings(content);
  const nsNames = namespaceBindings(content);
  const callees = [...new Set([...baseNames, ...treeWrappers])];
  for (const callee of callees) {
    const detector: Detector = baseNames.includes(callee) ? 'apiFetch' : 'wrapper';
    const re = new RegExp(`${calleePattern(callee, nsNames)}\\s*(?=[<(])`, 'g');
    for (let m = re.exec(content); m !== null; m = re.exec(content)) {
      if (isProse(masked, m.index)) continue;
      // The match may carry a namespace qualifier (`api.apiFetch`), so advance
      // by the matched text, not by the callee's own length.
      let cursor = m.index + m[0].length;
      while (/\s/.test(content[cursor] ?? '')) cursor++;
      // The callee as WRITTEN (qualifier included), so `api.apiFetch<T>(…)` and
      // a bare `apiFetch<T>(…)` in the same file are two distinct keys.
      const written = collapse(m[0]).replace(/\s/g, '');
      /** A call this scanner could not take apart. It is STILL A SITE.
       *
       * The pre-I1 code did `continue` here, which deleted the occurrence
       * entirely — not even recorded as an untyped call — so an unparseable
       * type argument was the cheapest possible hiding place for a new
       * hand-transcribed shape. Recording it with no acquired type names makes
       * it uncovered by construction, so it must be looked at. Over-reporting
       * costs a one-line exemption; under-reporting costs the next outage. */
      const pushUnparsed = () => {
        push(
          detector,
          m.index,
          `${written}<unparsed> ${normalizeArg(lineTextAt(content, m.index))}`,
          [],
          false,
        );
      };
      let typeExpr = '';
      if (content[cursor] === '<') {
        const angles = readAngles(content, cursor);
        if (!angles) {
          pushUnparsed();
          continue;
        }
        typeExpr = collapse(angles.inner);
        cursor = angles.end;
        while (/\s/.test(content[cursor] ?? '')) cursor++;
      }
      if (content[cursor] !== '(') {
        // Not a call as this scanner reads it. Recorded rather than dropped,
        // for the same reason as above: "I could not parse this" and "there is
        // nothing here" must not be the same observable outcome.
        pushUnparsed();
        continue;
      }
      const args = readArgs(content, cursor);
      const names = typeNamesIn(typeExpr);
      const call = `${written}<${typeExpr}>(${normalizeArg(args[0] ?? '')})`;
      push(detector, m.index, withMethod(call, literalMethodOf(args)), names, isCovered(names));
    }
  }

  // Detector 3 — the global `fetch(`, i.e. a request that bypasses the helper.
  const rawFetch = /(?<![.\w$])fetch\s*\(/g;
  for (let m = rawFetch.exec(content); m !== null; m = rawFetch.exec(content)) {
    if (isProse(masked, m.index)) continue;
    const paren = content.indexOf('(', m.index);
    const args = readArgs(content, paren);
    const call = `fetch(${normalizeArg(args[0] ?? '')})`;
    push('rawFetch', m.index, withMethod(call, literalMethodOf(args)), [], false);
  }

  // Detector 4 — `Response.json()`, the deserialization point of every JSON
  // body that did not go through `apiFetch`.
  const jsonBody = /\.json\s*\(\s*\)/g;
  for (let m = jsonBody.exec(content); m !== null; m = jsonBody.exec(content)) {
    if (isProse(masked, m.index)) continue;
    const names = typeNamesIn(assertionAfter(content, m.index) ?? '');
    push('jsonBody', m.index, normalizeArg(lineTextAt(content, m.index)), names, isCovered(names));
  }

  // Detector 5 — `JSON.parse`, which is how SSE frames and WS messages enter.
  const jsonParse = /\bJSON\.parse\s*\(/g;
  for (let m = jsonParse.exec(content); m !== null; m = jsonParse.exec(content)) {
    if (isProse(masked, m.index)) continue;
    const names = typeNamesIn(assertionAfter(content, m.index) ?? '');
    push('jsonParse', m.index, normalizeArg(lineTextAt(content, m.index)), names, isCovered(names));
  }

  // Detector 6 — the remaining raw-network primitives. Call-shaped on purpose
  // (`navigator.sendBeacon(`, `new EventSource(`), so a `typeof
  // navigator.sendBeacon !== 'function'` availability guard is not a site.
  const beacon = /(?:\bnavigator\.sendBeacon\s*\(|\bnew\s+(?:EventSource|XMLHttpRequest)\s*\()/g;
  for (let m = beacon.exec(content); m !== null; m = beacon.exec(content)) {
    if (isProse(masked, m.index)) continue;
    push('beacon', m.index, normalizeArg(lineTextAt(content, m.index)), [], false);
  }

  return sites;
}

/** Appends the literal HTTP method to a call descriptor. A site with no
 * literal method keeps its bare descriptor, so read-only `GET` call sites are
 * spelled exactly as before. */
function withMethod(call: string, method: string | null): string {
  return method === null ? call : `${call} [${method}]`;
}

/** Fixture names the SERVER declares it captures — the `name` of every
 * `CaptureSpec` passed to `expectCapturedResponse` in
 * `server/src/routers/apiResponseFixtures.int.test.ts`.
 *
 * WHY A CROSS-TIER READ. Detector 7's job is to keep design D2 ("fixtures are
 * captured by executing the handler, never hand-authored") from being undone.
 * Until this existed it enforced only "the specifier contains
 * `fixtures/api-responses/`" — a PATH SUBSTRING, over a directory that sits
 * OUTSIDE this scan's root (`web/src`), so a hand-authored module dropped in
 * beside the captures was indistinguishable from one and conferred full
 * `covered` status on every type assigned out of it. The capture inventory is
 * the only in-repo statement of which of those files a handler actually
 * produced, so the guard reads it (audit §11.9, I4).
 *
 * Throws rather than degrading: if this file moves or its call shape changes,
 * a loud failure naming the path is correct, and silently trusting every
 * fixture-directory import again is not. */
let declaredCaptureNamesCache: Set<string> | null = null;
const DECLARED_CAPTURE_FLOOR = 20;
function declaredCaptureNames(): Set<string> {
  if (declaredCaptureNamesCache) return declaredCaptureNamesCache;
  let source: string;
  try {
    source = fs.readFileSync(CAPTURE_SPEC_SOURCE, 'utf8');
  } catch {
    throw new Error(
      `apiResponseShapes.repo.test.ts: cannot read the capture-spec inventory at ` +
        `${CAPTURE_SPEC_SOURCE}. Detector 7 needs it to tell a CAPTURED fixture from a ` +
        `hand-authored module sitting in the same directory. If that suite moved, update ` +
        `CAPTURE_SPEC_SOURCE here.`,
    );
  }
  const names = new Set<string>();
  const re = /expectCapturedResponse\(\s*\{\s*(?:\/\/[^\n]*\n\s*)*name:\s*'([A-Za-z_$][\w$]*)'/g;
  for (let m = re.exec(source); m !== null; m = re.exec(source)) names.add(m[1]);
  if (names.size < DECLARED_CAPTURE_FLOOR) {
    throw new Error(
      `apiResponseShapes.repo.test.ts: read only ${names.size} CaptureSpec name(s) from ` +
        `${CAPTURE_SPEC_SOURCE} (floor ${DECLARED_CAPTURE_FLOOR}). A pattern that stops ` +
        `matching would silently shrink the set of fixtures that count as captured.`,
    );
  }
  declaredCaptureNamesCache = names;
  return names;
}

/** The DECLARED capture an import specifier names, or null when the specifier
 * is not a fixture import at all — or is one the server never declared it
 * captures, which is the case this exists to reject. */
function capturedFixtureName(spec: string, declared: ReadonlySet<string>): string | null {
  const m = spec.match(/(?:^|\/)fixtures\/api-responses\/([A-Za-z_$][\w$]*)(?:\.(?:json|ts))?$/);
  if (!m) return null;
  return declared.has(m[1]) ? m[1] : null;
}

/** Detector 7 — the conformance module's own inputs, scanned only there.
 * Every `const x: <ClientType> = <expr>` in that module must be fed by a
 * binding imported from a DECLARED CAPTURE under `fixtures/api-responses/`.
 * This is what keeps design D2 — "fixtures are captured by executing the
 * handler, never hand-authored" — from being quietly undone by someone adding a
 * hand-written literal back into the checks, which is precisely the
 * transcription step that caused the bug. */
function scanConformanceModule(
  rel: string,
  content: string,
  vocabulary: Set<string>,
  declaredCaptures: ReadonlySet<string>,
): Site[] {
  const fixtureBindings = new Set<string>();
  const imports = /import\s+(?:type\s+)?(?:(\w+)|\{([^}]*)\})\s+from\s+'([^']*)'/g;
  for (let m = imports.exec(content); m !== null; m = imports.exec(content)) {
    if (capturedFixtureName(m[3], declaredCaptures) === null) continue;
    if (m[1]) fixtureBindings.add(m[1]);
    for (const part of (m[2] ?? '').split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name) fixtureBindings.add(name);
    }
  }

  /** Alias map for THIS module's own `api/types` imports. Coverage is recorded
   * under the ORIGINAL export name, symmetrically with the call-site side: an
   * `import type { Session as LogEvent }` here checks `Session`, and recording
   * `LogEvent` would hand every `LogEvent` site in the tree a check that was
   * never performed. */
  const typeAliases = clientTypeImports(rel, content);
  const masked = maskLiterals(content);
  const sites: Site[] = [];
  const decl = /\bconst\s+[A-Za-z_$][\w$]*\s*:\s*([^=]+?)\s*=\s*([^;]+);/g;
  for (let m = decl.exec(content); m !== null; m = decl.exec(content)) {
    if (isProse(masked, m.index)) continue;
    const annotation = collapse(m[1]);
    const init = collapse(m[2]);
    // Only annotations that ARE a client response type (possibly indexed or
    // arrayed) or an inline object type mentioning one. A helper type such as
    // `ExpectUndeclared<AdminUser, 'picture_url'>` is not a conformance
    // assertion about a response and is not a site.
    const head = annotation.match(/^[A-Za-z_$][\w$]*/)?.[0] ?? '';
    const headOriginal = typeAliases.get(head) ?? head;
    const inlineObject =
      annotation.startsWith('{') && typeNamesIn(annotation).some((n) => vocabulary.has(n));
    if (!vocabulary.has(headOriginal) && !inlineObject) continue;
    const root = init.match(/^[A-Za-z_$][\w$]*/)?.[0] ?? '';
    // A type name is FIXTURE-CHECKED only by a declaration that (i) annotates
    // the bare type (or an array of it) — not an indexed slice, not an inline
    // object mentioning it, not a helper-type position — (ii) is initialised
    // from a fixture binding, and (iii) is expected to COMPILE. Clause (iii)
    // matters: this module deliberately contains `@ts-expect-error` assignments
    // whose whole point is that the fixture is NOT assignable to that type.
    const bare = annotation.match(/^(?:readonly\s+)?([A-Za-z_$][\w$]*)(?:\[\])*$/)?.[1];
    // Clause (iv): the initializer must not contain a type ASSERTION. `const x:
    // T = fixture as unknown as T` is a bare annotation fed by a fixture binding
    // with no `@ts-expect-error` above it — it satisfies (i)-(iii) exactly — and
    // asserts NOTHING: the cast makes the declaration compile whatever the
    // capture's real shape is. That is the same class of defeat as the
    // `@ts-expect-error` case, so it is rejected the same way, and it also costs
    // the declaration its `covered` status so it must be exempted rather than
    // sit in the module looking like a check.
    const cast = containsTypeAssertion(init);
    // Clause (v): the annotated name must resolve, through this module's own
    // imports, to an export of the canonical `api/types` — and the check is
    // recorded under that ORIGINAL name, not the local spelling.
    const bareOriginal = bare === undefined ? undefined : typeAliases.get(bare);
    const asserted =
      bareOriginal !== undefined &&
      fixtureBindings.has(root) &&
      !precededByTsExpectError(content, m.index) &&
      !cast;
    sites.push({
      detector: 'conformanceAssertion',
      file: rel,
      line: lineOf(content, m.index),
      key: `${rel} :: const ${annotation} = ${root}`,
      descriptor: `const ${annotation} = ${root}`,
      typeNames: typeNamesIn(annotation),
      covered: fixtureBindings.has(root) && !cast,
      ...(asserted ? { headType: bareOriginal } : {}),
    });
  }
  return sites;
}

/** True when a declaration's initializer contains a TYPE ASSERTION — `as X`,
 * `as unknown as X`, `as const`, or the prefix form `<X>expr`.
 *
 * An assertion in the initializer of a conformance assignment defeats the
 * assignment: `const check: T = fixture as unknown as T` compiles no matter what
 * shape the capture really has, so it is evidence about nothing. Rejecting `as
 * const` too is deliberate — the fixtures that need it already carry it in their
 * own module (audit §9), so an `as const` at the assignment is either redundant
 * or is doing narrowing work the check should not depend on. */
function containsTypeAssertion(init: string): boolean {
  if (/\bas\s+[A-Za-z_$({[<]/.test(init)) return true;
  return /^<[^<>]+>\s*\S/.test(init.trim());
}

/** True when the nearest preceding non-blank line carries `@ts-expect-error` —
 * i.e. the declaration at `index` is asserted NOT to compile. */
function precededByTsExpectError(content: string, index: number): boolean {
  const before = content.slice(0, lineStartOf(content, index));
  const lines = before.split('\n').filter((l) => l.trim() !== '');
  return (lines[lines.length - 1] ?? '').includes('@ts-expect-error');
}

// ---------------------------------------------------------------------------
// The conformance-check vocabulary
// ---------------------------------------------------------------------------

/** Type names the conformance module checks against a CAPTURED fixture.
 *
 * Derived from detector 7's own parse of that module — NOT from its
 * `import type { … }` list. The import list answers "is this name mentioned in
 * the file", which is a different and much weaker question than "has this type
 * ever been checked against a real response?", the question §11.5 of `audit.md`
 * claims this guard answers. Two ways the weaker question lies: a type used
 * only in an `ExpectUndeclared<…>` position is imported but never assigned a
 * captured value, and yet would mark every site repo-wide that names it as
 * covered; and a nested/indexed sub-assignment (`ProfilePayload
 * ['active_studio'] = fixture.active_studio`) says nothing about the whole
 * shape. Only a `const x: T = <fixture binding>` counts. */
function coveredTypeNames(conformanceSites: readonly Site[]): Set<string> {
  return new Set(
    conformanceSites
      .map((s) => s.headType)
      .filter((n): n is string => typeof n === 'string' && n.length > 0),
  );
}

/** Every exported type name in `api/types.ts` — the client response-type
 * vocabulary detector 7 recognises. */
function typesVocabulary(typesSource: string): Set<string> {
  return new Set(
    [...typesSource.matchAll(/export\s+(?:interface|type)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
  );
}

// ---------------------------------------------------------------------------
// Recorded exemptions — the ONLY way a site is allowed to stay unverified.
//
// Each entry is ONE site, keyed by `<file> :: <descriptor>`, with a reason a
// future reader can audit. Deliberately not file-level, glob-level, or
// type-level: a blanket entry would let a genuinely new unverified site hide
// behind an old exemption, which is the exact failure this guard exists to
// prevent. Fourteen `OkResponse` sites therefore get fourteen entries, not one
// rule — audit finding CW-1 is what that redundancy is paying for.
//
// "One entry, one site" is ENFORCED, not merely intended. Entries are consumed
// one per matching site: N sites sharing a key need N entries, and a surplus
// entry is reported as stale. Set membership alone made a single entry an
// unbounded licence — `apiFetch<OkResponse>(\`sessions/<var>\`)` covered both the
// audited DELETE and any later PUT, POST or PATCH on the same path — so the
// descriptor also carries the literal HTTP method.
//
// Adding one is a decision, not a formality: the question to answer is "what
// makes it acceptable that this site's shape is unchecked?", and the answer
// goes in `reason`. `audit.md` in the change directory (tracked, survives
// archival) holds the per-site verdicts these reasons cite.
// ---------------------------------------------------------------------------

interface Exemption {
  key: string;
  reason: string;
}

const EXEMPTIONS: readonly Exemption[] = [
  // --- The shared seam and the wrapper plumbing. Unresolved type parameters:
  // these acquire no client type at all, they forward one. The audit made the
  // same exclusion (§1: "minus the *unresolved* apiFetch<T> inside fetchAdmin
  // — that occurrence is the wrapper, not a site"). Left as per-site entries
  // rather than a rule so that a NEW wrapper still surfaces here for review.
  {
    key: 'api/client.ts :: apiFetch<T>(path: string)',
    reason:
      'The declaration of the shared helper itself, not a call. `T` is its type parameter; the sites that resolve it are the call sites below.',
  },
  {
    key: 'pages/admin-users/AdminUsersPage.tsx :: fetchAdmin<T>(path: string)',
    reason:
      'Declaration of the local generic wrapper (audit population (b)). Acquires no shape; its six call sites are enumerated individually.',
  },
  {
    key: 'pages/admin-users/AdminUsersPage.tsx :: apiFetch<T>(path)',
    reason:
      "The wrapper's forwarding call — passes its own unresolved `T` through. This is the occurrence `grep 'apiFetch<'` saw instead of the crashing call (design D6).",
  },
  {
    key: 'api/client.ts :: fetch(url)',
    reason:
      'The one global `fetch` inside the shared helper — the seam every typed call goes through. Its shape is whatever the caller asserts, checked at those call sites.',
  },
  {
    key: 'api/client.ts :: const j = (await res.json()) as { detail?: unknown; message?: unknown };',
    reason:
      'The shared error probe (audit §4, last row). Reads only `detail`/`message` off a non-2xx body and narrows each with a `typeof` check before use; no payload type is asserted.',
  },
  {
    key: "api/client.ts :: if (ct.includes('application/json')) return res.json() as Promise<T>;",
    reason:
      "The unchecked cast this whole change is about. It cannot be verified in place — `T` is the caller's. Verification happens per call site; task 2.1 pins this branch behaviourally in client.test.ts.",
  },

  // --- `apiFetch<OkResponse>` — fourteen sites, fourteen entries. Audit §5
  // rows 17-25 and 30, and the explicit `OkResponse` enumeration under §5.
  // NOT one blanket rule: CW-1 found two sites typed `OkResponse` whose
  // handlers emit no `ok` key at all, so "it's only an OkResponse" is exactly
  // the reasoning that has already failed once here.
  {
    key: 'api/hooks/useAudio.ts :: apiFetch<OkResponse>(`sessions/<var>/audio-recording-lease`) [POST]',
    reason:
      'audit §5 row 17 CONFORMS — `LeaseStore.claimLease` emits `{ok: true}` (409 on conflict), read end-to-end. Result discarded by the caller; no fixture captured (phase 4 §9 inventory).',
  },
  {
    key: 'api/hooks/useAudio.ts :: apiFetch<OkResponse>(`sessions/<var>/audio-recording-lease/heartbeat`) [POST]',
    reason:
      'audit §5 row 18 CONFORMS — emits `{ok}`, where `ok` can legitimately be `false` at 200. Result discarded; recorded there as a behavioural note, not a shape defect.',
  },
  {
    key: 'api/hooks/useAudio.ts :: apiFetch<OkResponse>(`sessions/<var>/audio-recording-lease/release`) [POST]',
    reason: 'audit §5 row 19 CONFORMS — emits `{ok: true}`. Result discarded.',
  },
  {
    key: 'api/hooks/useAudio.ts :: apiFetch<OkResponse>(`sessions/<var>/audio/segments/<var>/waveform`) [PUT]',
    reason: 'audit §5 row 20 CONFORMS — emits `{ok: true}` (404 for an unknown segment).',
  },
  {
    key: 'api/hooks/useEvents.ts :: apiFetch<OkResponse>(`sessions/<var>/events/<var>`) [DELETE]',
    reason:
      'audit §5 row 21 CONFORMS — DELETE emits `{ok: true}` (404 if missing); 404 path probed.',
  },
  {
    key: 'api/hooks/useSessions.ts :: apiFetch<OkResponse>(`sessions/<var>/archive`) [POST]',
    reason:
      'audit §5 row 22 CONFORMS — emits `{ok: true, archived: true}`; the extra key is additively tolerated.',
  },
  {
    key: 'api/hooks/useSessions.ts :: apiFetch<OkResponse>(`sessions/<var>/restore`) [POST]',
    reason: 'audit §5 row 23 CONFORMS — emits `{ok: true, archived: false}`.',
  },
  {
    key: 'api/hooks/useSessions.ts :: apiFetch<OkResponse>(`sessions/<var>`) [DELETE]',
    reason: 'audit §5 row 24 CONFORMS — DELETE emits `{ok: true, hidden: true}`.',
  },
  {
    key: 'api/hooks/useSessions.ts :: apiFetch<OkResponse>(`sessions/<var>/youtube-import`) [POST]',
    reason:
      'audit §5 row 25 CONFORMS — `{ok: true}` on success; the handler was read in full including every guard and rollback path (503/400/409/502 otherwise).',
  },
  {
    key: 'api/hooks/useTeams.ts :: apiFetch<OkResponse>(teamPath(teamId)) [DELETE]',
    reason: 'audit §5 row 30 CONFORMS — DELETE /api/teams/:id emits `{ok: true}`.',
  },
  {
    key: "api/hooks/useTeams.ts :: apiFetch<OkResponse>(teamPath(teamId, 'invites')) [POST]",
    reason:
      'audit §5 row 30 CONFORMS — POST invites emits `{ok: true}`, deliberately uniform across the existing-user and pending-invite branches.',
  },
  {
    key: "api/hooks/useTeams.ts :: apiFetch<OkResponse>(teamPath(teamId, 'invites', encodeURIComponent(email))) [DELETE]",
    reason: 'audit §5 row 30 CONFORMS — revoke invite emits `{ok: true}`.',
  },
  {
    key: "api/hooks/useTeams.ts :: apiFetch<OkResponse>(teamPath(teamId, 'members', encodeURIComponent(userId))) [DELETE]",
    reason: 'audit §5 row 30 CONFORMS — remove member emits `{ok: true}`.',
  },
  {
    key: "api/hooks/useTeams.ts :: apiFetch<OkResponse>(teamPath(teamId, 'leave')) [POST]",
    reason: 'audit §5 row 30 CONFORMS — leave team emits `{ok: true}`.',
  },

  // --- `apiFetch<void>` — the two 204 routes. Audit §5 rows 34 and 37.
  {
    key: 'api/hooks/useTopics.ts :: apiFetch<void>(`sessions/<var>/topics/<var>`) [DELETE]',
    reason:
      "audit §5 row 34 CONFORMS — DELETE topic returns 204 with an empty body and no content-type, so `apiFetch` takes its `res.text()` branch and returns `''` as `void`. No JSON payload exists to check.",
  },
  {
    key: 'api/hooks/useTranscriptWords.ts :: apiFetch<void>(`sessions/<var>/transcript-words/<var>`) [DELETE]',
    reason: 'audit §5 row 37 CONFORMS — DELETE transcript word, identical 204 + empty-body shape.',
  },

  // --- `apiFetch<EventsGenerateResponse>` — auto-generate-event-logs task 5.1.
  {
    key: 'api/hooks/useEvents.ts :: apiFetch<EventsGenerateResponse>(`sessions/<var>/events/generate`) [POST]',
    reason:
      'auto-generate-event-logs task 5.1 — success body read end-to-end: the route has exactly one 2xx ' +
      'emission, the inline two-key literal `c.json({ created: outcome.createdEvents, cap_hit: ' +
      'outcome.createdEvents >= cap })` (server/src/routers/events.ts), matching `EventsGenerateResponse` ' +
      'key-for-key; every other path throws `ApiError` (guard ladder 404/503/400/409, opaque 502) and ' +
      'acquires no shape. Not fixture-covered: a capture would require a scripted fake-CLI AI turn inside ' +
      'the capture harness (CLAUDE_CLI_PATH spawn + loopback MCP, the ai.int.test.ts machinery) to produce ' +
      'a 200 at all — a capture is the right answer if this shape ever grows beyond the two-key literal.',
  },

  // --- Types declared OUTSIDE `api/types.ts` — captured AND fixture-checked,
  // but structurally invisible to this guard's covered-set, which only counts
  // a name the site's file imports from the canonical `api/types` module
  // (coverage clause (iv)) — a hook-local union or feature-module interface
  // can never satisfy that no matter how well it is checked. Each shape below
  // IS asserted against a captured fixture in api/types.conformance.test.ts;
  // these entries exist because the guard cannot see those checks, not
  // because the shapes are unchecked.
  {
    key: 'api/hooks/useTranscriptGenerationStatus.ts :: apiFetch<TranscriptGenerationStatus>(TRANSCRIPT_GENERATION_STATUS_PATH)',
    reason:
      'pr-3 remediation — TranscriptGenerationStatus is declared hook-locally, not in api/types, so no conformance check can confer coverage on this site (clause (iv)). Both union branches ARE captured from the real handler (fixtures transcriptGenerationStatusIdle/transcriptGenerationStatusBusy, the busy one taken while transcriptGenerationLock was genuinely held) and type-level asserted in api/types.conformance.test.ts, including the redacted-nulls busy variant. Moving the union into api/types.ts would retire this entry.',
  },
  {
    key: 'pages/index/batchImport/logImportClient.ts :: apiFetch<{ job_id: string }>(`shows/<var>/log-import`) [POST]',
    reason:
      'pr-3 remediation — an inline object type containing no PascalCase name acquires nothing the covered-set can mark. The body IS captured from the real handler behind the SHEETS_LOG_IMPORT_ENABLED gate (fixtures/api-responses/logImportJobCreate.json) and asserted against the same `{ job_id: string }` annotation in api/types.conformance.test.ts.',
  },
  {
    key: 'pages/index/batchImport/logImportClient.ts :: apiFetch<LogImportJobStatus>(`log-import/<var>`)',
    reason:
      'pr-3 remediation — LogImportJobStatus is declared in this feature module, not api/types, so its conformance check cannot confer coverage (clause (iv)). A real TERMINAL failed-job body is captured (fixtures/api-responses/logImportJobStatus.ts — a .ts fixture because of the `status` literal union) and type-level asserted in api/types.conformance.test.ts.',
  },

  // --- Untyped `apiFetch(…)` — population (c), audit §3. Six sites, all
  // discarding the response, so the inferred `unknown` never reaches a
  // consumer. Verdict row 40 (CONFORMS vacuously — no type is asserted).
  {
    key: "api/hooks/useCompanionPresence.ts :: apiFetch<>('companion/presence') [POST]",
    reason:
      'audit §3/§5 row 40 — untyped; response discarded via `.catch(() => {})`. Presence is best-effort by design.',
  },
  {
    key: "pages/index/components/NewSessionModal.tsx :: apiFetch<>('profile') [PUT]",
    reason: 'audit §3/§5 row 40 — untyped PUT /api/profile; awaited, value unused.',
  },
  {
    key: 'pages/index/components/SessionWorkspace.tsx :: apiFetch<>(`sessions/<var>/transport/stop`) [POST]',
    reason: 'audit §3/§5 row 40 — untyped, fire-and-forget transport stop; value unused.',
  },
  {
    key: 'pages/index/components/YouTubeImportErrorModal.tsx :: apiFetch<>(`sessions/<var>/archive`) [POST]',
    reason: 'audit §3/§5 row 40 — untyped archive on the import-failure path; value unused.',
  },
  {
    key: 'pages/index/components/YouTubeImportErrorModal.tsx :: apiFetch<>(`sessions/<var>`) [DELETE]',
    reason: 'audit §3/§5 row 40 — untyped DELETE session on the import-failure path; value unused.',
  },
  {
    key: 'pages/index/hooks/useRecoveryStopWarning.ts :: apiFetch<>(`sessions/<var>/events`) [POST]',
    reason: 'audit §3/§5 row 40 — untyped recovery-stop event POST; value unused.',
  },
  {
    key: "pages/index/batchImport/runner.ts :: apiFetch<>('profile') [PUT]",
    reason:
      'pr-3 remediation — untyped PUT /api/profile from `alignActiveShow`; the handler emits the full ProfilePayload but the batch runner awaits and discards it (same shape/site class as the NewSessionModal PUT above).',
  },
  {
    key: 'pages/index/batchImport/runner.ts :: apiFetch<>(`sessions/<var>/local-audio-import?<var>`) [POST]',
    reason:
      'pr-3 remediation — untyped; POST local-audio-import has exactly one 2xx emission, the literal `{ok: true}` (server/src/routers/sessions.ts local-audio-import handler); every other path throws ApiError. Value unused by the runner.',
  },
  {
    key: 'pages/index/batchImport/runner.ts :: apiFetch<>(`sessions/<var>`) [DELETE]',
    reason:
      'pr-3 remediation — untyped DELETE session on the batch rollback path; emits `{ok: true, hidden: true}` (audit §5 row 24 shape); value unused.',
  },

  // --- Untyped `fetchAdmin(…)` — population (b)'s five type-argument-free
  // call sites. Audit §2 and verdict row 39 (CONFORMS vacuously).
  {
    key: "pages/admin-users/AdminUsersPage.tsx :: fetchAdmin<>('admin/studios') [POST]",
    reason:
      'audit §2/§5 row 39 — no type argument, inferred `unknown`, response discarded. (Handler emits `{studio: {id, name, builtin}}`.)',
  },
  {
    key: 'pages/admin-users/AdminUsersPage.tsx :: fetchAdmin<>(`admin/studios/<var>`) [DELETE]',
    reason:
      'audit §2/§5 row 39 — no type argument; response discarded. Handler emits `{ok: true}`.',
  },
  {
    key: 'pages/admin-users/AdminUsersPage.tsx :: fetchAdmin<>(`admin/users/<var>/memberships`) [POST]',
    reason: 'audit §2/§5 row 39 — no type argument; response discarded.',
  },
  {
    key: 'pages/admin-users/AdminUsersPage.tsx :: fetchAdmin<>(`admin/users/<var>/memberships/<var>`) [DELETE]',
    reason: 'audit §2/§5 row 39 — no type argument; response discarded.',
  },
  {
    key: 'pages/admin-users/AdminUsersPage.tsx :: fetchAdmin<>(`admin/users/<var>/<var>`) [POST]',
    reason: 'audit §2/§5 row 39 — disable/enable toggle; no type argument; response discarded.',
  },

  // --- Raw `fetch(` call sites — population (d). A request on its own acquires
  // no type; where a body IS typed, the typing site is the `.json()` entry
  // below and carries its own reason.
  {
    key: 'pages/index/components/useSseTurn.tsx :: fetch(url) [POST]',
    reason:
      'audit §4 d14 — the SSE POST. The raw `Response` is only branched on `status`/`ok`/`body`; the body is typed downstream at `extractErrorDetail` and the `delta` frame parse, both listed separately.',
  },
  {
    key: 'pages/index/components/AiV2Design.tsx :: fetch(`<var>/sessions/<var>/ai/v2/answer`) [POST]',
    reason: 'audit §4 d9 — POST …/ai/v2/answer; the success body is never read.',
  },
  {
    key: 'pages/index/components/TranscribeModal.tsx :: fetch(`<var>/sessions/<var>/transcribe.csv`)',
    reason:
      'audit §4 d10 / §5 row 42 — success is `res.blob()`, not JSON, and the endpoint is a permanent 503 stub (`transcribe.ts`). No shape is asserted.',
  },
  {
    key: 'pages/index/components/aiV2/dashboardPersistence.ts :: fetch(`/api/sessions/<var>/ai/v2/dashboard`)',
    reason:
      'audit §4 d1 — the GET request itself; the typed read of its body is the `.json()` site below.',
  },
  {
    key: 'pages/index/components/aiV2/dashboardPersistence.ts :: fetch(`/api/sessions/<var>/ai/v2/dashboard<var>`) [PUT]',
    reason: 'audit §4 d3 — the PUT request; its success body is never read.',
  },
  {
    key: 'pages/index/hooks/useAudioClips.ts :: fetch(`/api/sessions/<var>/audio/segments/sync-from-disk`) [POST]',
    reason: 'audit §4 d11 — sync-from-disk POST; the response is fully discarded.',
  },
  {
    key: 'shared/utils/waveformDecode.ts :: fetch(url)',
    reason:
      'audit §4 d12 — fetches a segment blob URL and reads `res.arrayBuffer()`. Not a JSON response at all.',
  },

  // --- `Response.json()` outside the shared helper.
  {
    key: 'pages/index/components/aiV2/dashboardPersistence.ts :: const data = (await res.json()) as { detail?: unknown };',
    reason:
      "audit §4 d2 — an error probe on a non-2xx body, defensively narrowed with `typeof data.detail === 'string'` before use. No payload type is acquired.",
  },
  {
    key: 'pages/index/components/aiV2/dashboardPersistence.ts :: const data = (await res.json()) as { config: DashboardConfig | null };',
    reason:
      "audit §4 d1 / §5 row 41 CONFORMS — the ONE raw-fetch site that does assert a payload type. Verified by reading `aiV2.ts`'s GET handler and `DashboardStore.getDashboard`, and by comparing web `widgetTypes.ts`'s WIDGET_TYPES/INTERACTION_KINDS element-by-element against the server's `dashboardConfigSchema`: identical, and the config is schema-validated on every WRITE path, so the read-side assertion is backed by a write-side check. Not fixture-covered — a capture is the right long-term answer if this endpoint grows.",
  },
  {
    key: 'pages/index/components/useSseTurn.tsx :: const body = (await res.json()) as { detail?: unknown };',
    reason:
      "audit §4 d4 — `extractErrorDetail`, an error probe on non-2xx bodies of the three AI endpoints, narrowed by `typeof body.detail === 'string'`.",
  },

  // --- `JSON.parse` sites.
  {
    key: 'pages/index/components/useSseTurn.tsx :: return JSON.parse(raw);',
    reason:
      'audit §4 d5 — `safeJsonParse` returns `unknown`. Every consumer (delta/tool/done/error frames, d5/d6/d8) narrows with a runtime `typeof` guard before reading a field.',
  },
  {
    key: 'pages/index/components/TranscribeModal.tsx :: const json = JSON.parse(text) as { detail?: string };',
    reason:
      'audit §4 d10 — error-body probe for a permanently-503 endpoint; only `detail` is read, to render as text.',
  },
  {
    key: 'api/hooks/useSessionSocket.ts :: msg = JSON.parse(ev.data);',
    reason:
      'audit §4 d13 — WebSocket frames. WebSocket validation is an EXPLICIT Non-Goal of this change (design "Goals / Non-Goals"), so no verdict was issued. A SECOND WS parse site would still be surfaced by this guard rather than absorbed by this entry.',
  },
  {
    key: 'pages/index/components/aiV2/dashboardPersistence.ts :: const parsed = JSON.parse(raw) as unknown;',
    reason:
      "audit §8.8 — a DELIBERATE exclusion, not an oversight. `localStorageDashboardPersistence.load` parses browser localStorage (which this client itself wrote), not a server response; the audit's universe is the server↔client wire. It does re-assert `parsed as DashboardConfig` two lines later after an `Array.isArray(...widgets)` check — that second assertion is downstream of this parse and is not separately detected, which §8.8 predicted and this entry is the named exemption for.",
  },
  {
    key: 'shared/utils/perfDebug.ts :: const o = JSON.parse(raw);',
    reason:
      "Parses a localStorage-backed debug-flag record (`FlagState`), not an API response. Guarded by `o && typeof o === 'object'` before the cast.",
  },

  // --- `navigator.sendBeacon` — fire-and-forget, no Response object exists.
  {
    key: 'pages/index/components/AudioRecorder.tsx :: navigator.sendBeacon(`<var>/sessions/<var>/audio-recording-lease/release`, b);',
    reason:
      'audit §4 d15 — `sendBeacon` returns a boolean queued-flag, never a body. There is nothing to type-check at this site.',
  },
  {
    key: "api/hooks/useCompanionPresence.ts :: navigator.sendBeacon(apiUrl('companion/presence'), b);",
    reason: 'audit §4 d16 — same as d15: pagehide presence clear, no response handle.',
  },

  // --- Detector 7: the conformance module's two hand-written literals.
  {
    key: 'api/types.conformance.test.ts :: const LogEvent = orphanFromSourceRead',
    reason:
      "audit CW-4 / §9 — `enrichEventRpc`'s orphan branch (category deleted from the profile, colour snapshot missing) is unreachable by seeding, so no capture can produce it. This literal is written from a full read of `enrichEventRpc` + `eventRowToRpc`, is labelled as a source-read at its site, and exists to HOLD the widened `category_color`/`timecode` types in place — a type-holder, not evidence about the wire. Design D1's named production-data-variance residual.",
  },
  {
    key: 'api/types.conformance.test.ts :: const Session = orphanedFromSourceRead',
    reason:
      "audit CW-9 / §9 — a seeded session always has a joined show row and a `created_at_utc`, so `serializeSessionEntry`'s four `?? null` branches never fire against any capture. Written from the serializer, labelled as such, and spread over the CAPTURED `sessionDetail` so only the four nulled fields are hand-written. Same residual as above.",
  },
];

/** Client types declared in `api/types.ts` with ZERO response-consuming sites
 * in `web/src` — dead, by design. The real consumer is the Companion module,
 * which mirrors the shapes in `companion/src/state.ts`, so no fixture is
 * captured (audit §8.7 and §9). They are recorded here rather than as
 * exemptions because there is no site to exempt; the assertion below fails if
 * that ever stops being true, so the note cannot silently rot. */
const DEAD_CLIENT_TYPES = ['CompanionRemoteCommand', 'CompanionCommandsWaitResponse'] as const;

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

interface ScanResult {
  sites: Site[];
  unverified: Site[];
  unusedExemptions: string[];
}

/** Rounds of wrapper discovery before the fixed-point loop gives up. Each round
 * that does not converge adds at least one wrapper name, so real trees converge
 * in (chain depth + 1) rounds — 2 for this repo. */
const WRAPPER_DISCOVERY_ROUND_CAP = 32;

function scanTree(root: string, exemptions: readonly Exemption[] = EXEMPTIONS): ScanResult {
  const typesPath = path.join(root, 'api', 'types.ts');
  const typesSource = fs.existsSync(typesPath) ? fs.readFileSync(typesPath, 'utf8') : '';
  const vocabulary = typesVocabulary(typesSource);

  // Read the tree ONCE. Everything below is a pass over this list, because the
  // wrapper population is a property of the whole tree, not of a single file.
  const files = walk(root).map((file) => ({
    rel: relOf(root, file),
    content: fs.readFileSync(file, 'utf8'),
  }));
  const appFiles = files.filter((f) => f.rel !== CONFORMANCE_MODULE && !isTestFile(f.rel));

  const conformanceSource = files.find((f) => f.rel === CONFORMANCE_MODULE)?.content ?? '';
  const conformanceSites = conformanceSource
    ? scanConformanceModule(
        CONFORMANCE_MODULE,
        conformanceSource,
        vocabulary,
        declaredCaptureNames(),
      )
    : [];
  const covered = coveredTypeNames(conformanceSites);

  // PRE-PASS — the union of every generic wrapper over `apiFetch` declared
  // anywhere in the tree, collected before any file is scanned. A wrapper
  // exported from its own module (`export function fetchTyped<T>(…)`) and
  // called from twenty others is the ordinary shape of this refactor; scanning
  // per file would see only the wrapper's own plumbing and would never see a
  // single one of those twenty concrete, hand-transcribed call sites.
  //
  // ITERATED TO A FIXED POINT, because a wrapper over a wrapper is a wrapper.
  // Seeding discovery from the `apiFetch` bindings alone stopped at depth one:
  // `fetchOuter<T>` → `fetchInner<T>` → `apiFetch<T>` reported only the three
  // plumbing sites with an unresolved `T` — each a near-verbatim match for a
  // recorded exemption, so the file's own precedent invites a maintainer to
  // exempt them — while `fetchOuter<HopResponse>(…)`, the site carrying the
  // hand-transcribed shape, never appeared at all. Each round re-runs discovery
  // with everything found so far as additional forwarding targets.
  const treeWrappers = new Set<string>();
  for (let round = 0; ; round++) {
    const before = treeWrappers.size;
    for (const f of appFiles) {
      const bases = [...new Set([...apiFetchBindings(f.content), ...treeWrappers])];
      for (const name of discoverWrappers(f.content, bases)) treeWrappers.add(name);
    }
    if (treeWrappers.size === before) break;
    // The set only ever GROWS and is bounded by the identifiers in the tree, so
    // this terminates; the cap exists so a pathological input fails loudly here
    // instead of hanging a test run with no explanation.
    if (round >= WRAPPER_DISCOVERY_ROUND_CAP) {
      throw new Error(
        `wrapper discovery did not converge in ${WRAPPER_DISCOVERY_ROUND_CAP} rounds ` +
          `(${treeWrappers.size} wrappers so far: ${[...treeWrappers].sort().join(', ')})`,
      );
    }
  }

  const sites: Site[] = [...conformanceSites];
  for (const f of appFiles) sites.push(...scanFile(f.rel, f.content, covered, treeWrappers));

  // Exemptions are CONSUMED, one entry per site. Set membership would let a
  // single entry absorb an unbounded number of later sites that happen to
  // normalise to the same key — and for `{ok}`-shaped mutation endpoints that
  // collision is routine. Surplus in either direction is an error: more sites
  // than entries means something new slipped in unexamined; more entries than
  // sites means the list is describing a tree that no longer exists.
  const remaining = new Map<string, number>();
  for (const e of exemptions) remaining.set(e.key, (remaining.get(e.key) ?? 0) + 1);

  const unverified: Site[] = [];
  for (const site of sites) {
    if (site.covered) continue;
    const left = remaining.get(site.key) ?? 0;
    if (left > 0) {
      remaining.set(site.key, left - 1);
      continue;
    }
    unverified.push(site);
  }

  const totals = new Map<string, number>();
  for (const e of exemptions) totals.set(e.key, (totals.get(e.key) ?? 0) + 1);
  const unusedExemptions: string[] = [];
  for (const [key, left] of remaining) {
    if (left <= 0) continue;
    const total = totals.get(key) ?? 0;
    unusedExemptions.push(
      total === left
        ? key
        : `${key}  (${total} entries recorded, only ${total - left} matching site(s))`,
    );
  }

  return { sites, unverified, unusedExemptions: unusedExemptions.sort() };
}

function report(sites: Site[]): string {
  return sites
    .map(
      (s) =>
        `  ${s.file}:${s.line}  [${s.detector}]  ${s.descriptor}` +
        (s.typeNames.length > 0 ? `\n      acquires: ${s.typeNames.join(', ')}` : '') +
        `\n      key: ${s.key}`,
    )
    .join('\n');
}

// this file: web/src/apiResponseShapes.repo.test.ts -> the scan root is web/src.
const WEB_SRC = THIS_DIR;

// ---------------------------------------------------------------------------
// Vacuity floors. A guard whose scan matches nothing passes forever, so the
// scan is asserted to SEE the tree it claims to cover. Floors are set below
// today's counts so that deleting a call site is not a failure, but silently
// losing a whole detector or an over-narrowed walk is.
// ---------------------------------------------------------------------------

// Measured after the branch-audit fixes (2026-07-28): 120 sites — apiFetch
// 52, wrapper 7, rawFetch 8, jsonBody 5, jsonParse 5, beacon 2,
// conformanceAssertion 41 — of which 68 are COVERED and 52 are EXEMPTED.
// (Was 117/65/52 when coverage was read off the conformance module's import
// list; the three added sites are the direct `Show`, `Category` and
// `ActiveStudioCategory` fixture assignments that the corrected covered-set
// rule showed were missing.) Neither the second review round's fixes
// (fixed-point wrapper discovery, resolved type-import specifiers, cast
// rejection, namespace-qualified callees) nor the branch audit's (semicolon and
// arrow-typed type arguments, unparsed-site recording, object return-type
// annotations, the declared-capture cross-check, alias-symmetric coverage) moved
// any of the four numbers on this tree. That is the expected result — they close
// shapes the tree does not yet contain — and it is asserted, not assumed.
//
// HOW MUCH SLACK EACH FLOOR ALLOWS, stated rather than left to be inferred. A
// floor far below its count lets a scan regression lose sites silently, which
// is the same vacuity this block exists to prevent (branch audit, M8): the old
// POPULATION_FLOOR of 100 against 120 tolerated a 20-site loss. Each floor now
// sits a few sites under today's count — enough that deleting a feature's call
// sites is not a failure, little enough that a regression is. Deleting more
// than the slack means re-measuring these numbers deliberately, which is the
// intended cost.
const POPULATION_FLOOR = 115; // 120 today; tolerates a 5-site loss
const DETECTOR_FLOORS: Record<Detector, number> = {
  apiFetch: 48, // 52 today
  wrapper: 6, // 7 today
  rawFetch: 7, // 8 today
  jsonBody: 4, // 5 today
  jsonParse: 4, // 5 today
  beacon: 1, // 2 today — a 2-site detector cannot have both slack and rigour
  conformanceAssertion: 37, // 41 today
};
/** Today's covered count is 68. Same reasoning as the floors above: the
 * previous value of 60 tolerated losing eight conformance checks in silence. */
const COVERED_FLOOR = 64;

/** Sites that must be found by name. Each one exercises a different detector
 * path, so an over-narrowed pattern or a broken walk fails here with a
 * specific name rather than by quietly finding nothing. */
const CANARY_SITES: readonly { key: string; why: string }[] = [
  {
    key: "pages/admin-users/AdminUsersPage.tsx :: fetchAdmin<AdminDataResponse>('admin/users')",
    why: 'population (b): the wrapper-laundered call the memberships crash lived in — invisible to `grep apiFetch<`',
  },
  {
    key: "api/hooks/useProfile.ts :: apiFetch<ProfilePayload>('profile')",
    why: 'population (a): a plain typed hook call',
  },
  {
    key: 'pages/index/components/aiV2/dashboardPersistence.ts :: const data = (await res.json()) as { config: DashboardConfig | null };',
    why: 'population (d): the raw-fetch ingress that DOES assert a payload type',
  },
  {
    key: 'api/hooks/useSessionSocket.ts :: msg = JSON.parse(ev.data);',
    why: 'population (d): a JSON.parse ingress with no `as` at all',
  },
  {
    key: "api/hooks/useCompanionPresence.ts :: navigator.sendBeacon(apiUrl('companion/presence'), b);",
    why: 'population (d): a raw network primitive with no Response object',
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('detection predicates (mutation checks — prove the detectors actually fire)', () => {
  let tmpRoot: string;

  afterEach(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function fixtureTree(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-shape-guard-'));
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(root, ...rel.split('/'));
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    return root;
  }

  const CONFORMANCE_STUB = [
    "import adminUsers from '../../../fixtures/api-responses/adminUsers.json';",
    "import type { AdminDataResponse } from './types';",
    'const check: AdminDataResponse = adminUsers;',
  ].join('\n');
  const TYPES_STUB = [
    'export interface AdminDataResponse { users: string[] }',
    'export interface BrandNewResponse { id: string }',
  ].join('\n');

  function scanResult(
    files: Record<string, string>,
    exemptions?: readonly Exemption[],
  ): ScanResult {
    tmpRoot = fixtureTree({
      'api/types.ts': TYPES_STUB,
      [CONFORMANCE_MODULE]: CONFORMANCE_STUB,
      ...files,
    });
    return scanTree(tmpRoot, exemptions);
  }

  function scanOnly(files: Record<string, string>): Site[] {
    return scanResult(files).sites.filter((s) => s.detector !== 'conformanceAssertion');
  }

  const IMPORTS_ADMIN = "import type { AdminDataResponse } from '../types';\n";
  // Source text FOR a synthetic tree, so the interpolation belongs to the
  // fixture, not to this file — escaped `$\{` keeps it out of both this
  // module's templates and the linter's placeholder check.
  const THING_PATH = `\`things/$\{id}\``;

  it('a NEW typed apiFetch call whose type has no conformance check is unverified', () => {
    const sites = scanOnly({
      'api/hooks/useThing.ts':
        "import { apiFetch } from '../client';\n" +
        "import type { BrandNewResponse } from '../types';\n" +
        "export const load = () => apiFetch<BrandNewResponse>('things');\n",
    });
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({
      detector: 'apiFetch',
      file: 'api/hooks/useThing.ts',
      typeNames: ['BrandNewResponse'],
      covered: false,
    });
  });

  it('a typed apiFetch call whose type IS conformance-checked is covered', () => {
    const sites = scanOnly({
      'api/hooks/useThing.ts': `${IMPORTS_ADMIN}export const load = () => apiFetch<AdminDataResponse>('admin/users');\n`,
    });
    expect(sites).toHaveLength(1);
    expect(sites[0].covered).toBe(true);
  });

  it('a call through a NEW local generic wrapper is discovered, not laundered away', () => {
    const sites = scanOnly({
      'pages/Thing.tsx':
        'async function fetchThing<T>(p: string): Promise<T> { return apiFetch<T>(p); }\n' +
        "export const go = () => fetchThing<BrandNewResponse>('things');\n",
    });
    const wrapperCalls = sites.filter((s) => s.detector === 'wrapper');
    // the declaration, and the resolved call site
    expect(wrapperCalls.map((s) => s.descriptor)).toEqual([
      'fetchThing<T>(p: string)',
      "fetchThing<BrandNewResponse>('things')",
    ]);
    expect(wrapperCalls[1].covered).toBe(false);
  });

  // --- MULTI-FILE trees. Every case below was a live false negative until the
  // phase-5 review: each one passed a synthetic SINGLE-file mutation check
  // while a real, unenumerated response site sat in the tree. Single-file
  // fixtures structurally cannot express "declared here, called there", which
  // is the ordinary shape of every one of these refactors.

  it('a wrapper declared in ANOTHER file still brings its call sites into the population', () => {
    const sites = scanOnly({
      'api/typedFetch.ts':
        "import { apiFetch } from './client';\n" +
        'export async function fetchTyped<T>(p: string): Promise<T> { return apiFetch<T>(p); }\n',
      'pages/Consumer.tsx':
        "import { fetchTyped } from '../api/typedFetch';\n" +
        "import type { BrandNewResponse } from '../api/types';\n" +
        "export const go = () => fetchTyped<BrandNewResponse>('things');\n",
    });
    const call = sites.find((s) => s.file === 'pages/Consumer.tsx');
    // Without the tree-wide wrapper pre-pass this site does not exist at all —
    // the only two sites are the wrapper's own plumbing, which closely
    // resembles two recorded exemptions and so reads as already-handled.
    expect(call).toMatchObject({
      detector: 'wrapper',
      typeNames: ['BrandNewResponse'],
      covered: false,
      descriptor: "fetchTyped<BrandNewResponse>('things')",
    });
  });

  it('a cross-file wrapper forwarding `apiFetch<T[]>` is a wrapper too', () => {
    // `fetchList<T>(): Promise<T[]>` is the most natural next helper here, and
    // an exact `apiFetch<T>` match would launder every one of its call sites.
    const sites = scanOnly({
      'api/list.ts':
        "import { apiFetch } from './client';\n" +
        'export const fetchList = async <T>(p: string): Promise<T[]> => apiFetch<T[]>(p);\n',
      'pages/List.tsx': "export const go = () => fetchList<BrandNewResponse>('things');\n",
    });
    expect(sites.find((s) => s.file === 'pages/List.tsx')).toMatchObject({
      detector: 'wrapper',
      covered: false,
    });
  });

  it('a wrapper whose forwarding call sits past a fixed window is still a wrapper', () => {
    const filler = `  // ${'padding '.repeat(30)}\n`.repeat(12); // > 1500 chars
    const sites = scanOnly({
      'api/slow.ts':
        "import { apiFetch } from './client';\n" +
        'export async function fetchLate<T>(p: string): Promise<T> {\n' +
        filler +
        '  return apiFetch<T>(p);\n}\n',
      'pages/Late.tsx': "export const go = () => fetchLate<BrandNewResponse>('things');\n",
    });
    expect(sites.find((s) => s.file === 'pages/Late.tsx')?.detector).toBe('wrapper');
  });

  it('wrapper discovery needs a SECOND round when the outer wrapper is read first', () => {
    // I3. The pair below is the same shape as the case that follows, ORDERED so
    // that one round cannot possibly suffice: `walk` visits files in sorted
    // order, `aaOuter.ts` sorts before `zzInner.ts`, and on round 0 `fetchOuter`
    // forwards only to a name that is not yet known to be a wrapper. The
    // original fixed-point case passes with `break` after round 0 — its files
    // happen to resolve in walk order — so it demonstrated the fix without
    // requiring it. This one goes red the moment the loop stops iterating.
    const sites = scanOnly({
      'api/aaOuter.ts':
        "import { fetchInner } from './zzInner';\n" +
        'export async function fetchOuter<T>(p: string): Promise<T> { return fetchInner<T>(p); }\n',
      'api/zzInner.ts':
        "import { apiFetch } from './client';\n" +
        'export async function fetchInner<T>(p: string): Promise<T> { return apiFetch<T>(p); }\n',
      'pages/Ordered.tsx':
        "import { fetchOuter } from '../api/aaOuter';\n" +
        "import type { BrandNewResponse } from '../api/types';\n" +
        "export const go = () => fetchOuter<BrandNewResponse>('ordered/thing');\n",
    });
    expect(sites.find((s) => s.file === 'pages/Ordered.tsx')).toMatchObject({
      detector: 'wrapper',
      typeNames: ['BrandNewResponse'],
      covered: false,
      descriptor: "fetchOuter<BrandNewResponse>('ordered/thing')",
    });
  });

  it('a wrapper over a WRAPPER is a wrapper — discovery runs to a fixed point', () => {
    // Second review round, NEW-1. Seeding discovery from the `apiFetch`
    // bindings alone stopped at depth one: this tree reported only the three
    // plumbing sites carrying an unresolved `T`, each a near-verbatim match for
    // a recorded exemption, while the site holding the hand-transcribed shape
    // never appeared at all.
    const sites = scanOnly({
      'api/inner.ts':
        "import { apiFetch } from './client';\n" +
        'export async function fetchInner<T>(p: string): Promise<T> { return apiFetch<T>(p); }\n',
      'api/outer.ts':
        "import { fetchInner } from './inner';\n" +
        'export async function fetchOuter<T>(p: string): Promise<T> { return fetchInner<T>(p); }\n',
      'pages/Hop.tsx':
        "import { fetchOuter } from '../api/outer';\n" +
        "import type { BrandNewResponse } from '../api/types';\n" +
        "export const go = () => fetchOuter<BrandNewResponse>('hop/thing');\n",
    });
    expect(sites.find((s) => s.file === 'pages/Hop.tsx')).toMatchObject({
      detector: 'wrapper',
      typeNames: ['BrandNewResponse'],
      covered: false,
      descriptor: "fetchOuter<BrandNewResponse>('hop/thing')",
    });
  });

  it('an inline type argument separated by SEMICOLONS is a site — the formatter writes that form', () => {
    // I3-round finding I1, the most reachable of the three. `readAngles` bailed
    // on any `;`, and `scanFile` turned a bail into `continue`, so the site
    // vanished ENTIRELY — not even recorded as an untyped call. `npx biome
    // format`, which `npm run lint` runs, rewrites `{ a: X, b: Y }` into
    // `{ a: X; b: Y }`, so linting a detectable site converted it into an
    // undetectable one. The tree already carries three inline envelopes.
    const sites = scanOnly({
      'api/hooks/useEnvelope.ts':
        "import { apiFetch } from '../client';\n" +
        "export const semi = () => apiFetch<{ ok: boolean; detail: string }>('probe/semi');\n",
    });
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({
      detector: 'apiFetch',
      covered: false,
      descriptor: "apiFetch<{ ok: boolean; detail: string }>('probe/semi')",
    });
  });

  it('an ARROW-typed member inside a type argument does not close the angles early', () => {
    // Same finding, second half: the `>` of `() => void` was counted as the
    // closer, after which the next character was not `(` and the call was
    // discarded as "a reference, not a call". Comma-separated on purpose, so
    // that this case and the semicolon case above fail independently of each
    // other when either fix alone is reverted.
    const sites = scanOnly({
      'api/hooks/useArrow.ts':
        "import { apiFetch } from '../client';\n" +
        "export const cb = () => apiFetch<{ cb: () => void, id: BrandNewResponse }>('probe/arrow');\n",
    });
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({
      detector: 'apiFetch',
      typeNames: ['BrandNewResponse'],
      covered: false,
    });
  });

  it('a type argument this scanner CANNOT parse is recorded, never dropped', () => {
    // The residual half of I1's fix. A statement break still ends the angle
    // read — that bail is what stops a stray `<` swallowing the file — but the
    // occurrence is now recorded with an unparsed type expression and no
    // acquired names, so it is uncovered by construction and must be looked at.
    const sites = scanOnly({
      'api/hooks/useUnparsed.ts':
        "import { apiFetch } from '../client';\n" +
        'export const weird = (a: number, b: number) => apiFetch<a; b>(1);\n',
    });
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ detector: 'apiFetch', typeNames: [], covered: false });
    expect(sites[0].descriptor).toContain('<unparsed>');
  });

  it('a wrapper with an OBJECT return-type annotation is still a wrapper', () => {
    // I2, and the third sighting of the C1/NEW-1 class. `readDeclarationBody`
    // returned at the first balanced `{…}` outside the parameter list, which
    // for `: Promise<{ data: T; total: number }>` is the RETURN-TYPE
    // annotation. The forwarding `apiFetch` sat past it, so the wrapper was
    // never discovered and its hand-transcribed call site produced ZERO sites.
    const sites = scanOnly({
      'api/envelope.ts':
        "import { apiFetch } from './client';\n" +
        'export async function fetchEnvelope<T>(p: string): Promise<{ data: T; total: number }> {\n' +
        '  return apiFetch<T>(p).then((data) => ({ data, total: 0 }));\n}\n',
      'pages/Envelope.tsx':
        "import { fetchEnvelope } from '../api/envelope';\n" +
        "import type { BrandNewResponse } from '../api/types';\n" +
        "export const go = () => fetchEnvelope<BrandNewResponse>('probe/envelope');\n",
    });
    expect(sites.find((s) => s.file === 'pages/Envelope.tsx')).toMatchObject({
      detector: 'wrapper',
      typeNames: ['BrandNewResponse'],
      covered: false,
      descriptor: "fetchEnvelope<BrandNewResponse>('probe/envelope')",
    });
  });

  it('a wrapper whose TYPE PARAMETER carries an object constraint is still a wrapper', () => {
    // The same read, one brace earlier: `<T extends { id: string }>` is not a
    // body either, and returning at it would delete the wrapper just as surely.
    const sites = scanOnly({
      'api/constrained.ts':
        "import { apiFetch } from './client';\n" +
        'export async function fetchById<T extends { id: string }>(p: string): Promise<T> {\n' +
        '  return apiFetch<T>(p);\n}\n',
      'pages/ById.tsx': "export const go = () => fetchById<BrandNewResponse>('probe/by-id');\n",
    });
    expect(sites.find((s) => s.file === 'pages/ById.tsx')?.detector).toBe('wrapper');
  });

  it('a COMMENT in a wrapper signature does not mis-place its body', () => {
    // Braces and semicolons inside a comment are not syntax. A declaration
    // scanner that counted them would end the body read before the forwarding
    // call, which un-discovers the wrapper and silently deletes every one of
    // its call sites — the same consequence as I2, by a different route.
    const sites = scanOnly({
      'api/commented.ts':
        "import { apiFetch } from './client';\n" +
        'export async function fetchCommented<T>(p: string) /* ; { */ : Promise<T> {\n' +
        '  return apiFetch<T>(p);\n}\n',
      'pages/Commented.tsx':
        "export const go = () => fetchCommented<BrandNewResponse>('probe/commented');\n",
    });
    expect(sites.find((s) => s.file === 'pages/Commented.tsx')?.detector).toBe('wrapper');
  });

  it('a fixture-directory import the SERVER never declared capturing is not a check', () => {
    // I4. `covered` used to mean "the specifier contains
    // `fixtures/api-responses/`" — a path substring over a directory outside
    // this scan's root, so a hand-authored module dropped in beside the real
    // captures conferred full coverage. The name must now appear in the
    // server's own CaptureSpec inventory.
    tmpRoot = fixtureTree({
      'api/types.ts': TYPES_STUB,
      [CONFORMANCE_MODULE]: [
        "import adminUsers from '../../../fixtures/api-responses/adminUsers.json';",
        "import handAuthored from '../../../fixtures/api-responses/handAuthored.json';",
        "import type { AdminDataResponse, BrandNewResponse } from './types';",
        'const check: AdminDataResponse = adminUsers;',
        'const fake: BrandNewResponse = handAuthored;',
      ].join('\n'),
      'api/hooks/useThing.ts':
        "import type { BrandNewResponse } from '../types';\n" +
        "export const load = () => apiFetch<BrandNewResponse>('things');\n",
    });
    const result = scanTree(tmpRoot);
    expect(result.sites.find((s) => s.file === 'api/hooks/useThing.ts')).toMatchObject({
      typeNames: ['BrandNewResponse'],
      covered: false,
    });
    // …and the assignment itself surfaces rather than sitting in the module
    // looking like a check.
    expect(result.unverified.map((s) => s.key)).toContain(
      `${CONFORMANCE_MODULE} :: const BrandNewResponse = handAuthored`,
    );
  });

  it('an ALIASED conformance annotation records the ORIGINAL checked name', () => {
    // M3. Alias resolution was one-sided: call sites mapped alias→original,
    // the conformance module read the raw annotation. So
    // `import type { AdminDataResponse as BrandNewResponse }` plus
    // `const c: BrandNewResponse = adminUsers` marked `BrandNewResponse`
    // covered while only `AdminDataResponse` had been checked.
    tmpRoot = fixtureTree({
      'api/types.ts': TYPES_STUB,
      [CONFORMANCE_MODULE]: [
        "import adminUsers from '../../../fixtures/api-responses/adminUsers.json';",
        "import type { AdminDataResponse as BrandNewResponse } from './types';",
        'const check: BrandNewResponse = adminUsers;',
      ].join('\n'),
      'api/hooks/useThing.ts':
        "import type { BrandNewResponse } from '../types';\n" +
        "export const load = () => apiFetch<BrandNewResponse>('things');\n",
      'api/hooks/useAdmin.ts':
        "import type { AdminDataResponse } from '../types';\n" +
        "export const load = () => apiFetch<AdminDataResponse>('admin/users');\n",
    });
    const sites = scanTree(tmpRoot).sites;
    // The check was against `AdminDataResponse`; that is what it covers…
    expect(sites.find((s) => s.file === 'api/hooks/useAdmin.ts')?.covered).toBe(true);
    // …and NOT the local spelling it happened to be imported under.
    expect(sites.find((s) => s.file === 'api/hooks/useThing.ts')?.covered).toBe(false);
  });

  it('a SIBLING `types.ts` cannot lend its locally declared shapes a checked type name', () => {
    // Second review round, NEW-2. A per-feature `types.ts` is standard React
    // layout, and the names it would plausibly redeclare (`Session`,
    // `Category`, `LogEvent`) are exactly the checked ones. Gating on the
    // specifier's BASENAME made every such module an alias for `api/types`.
    const sites = scanOnly({
      'pages/plantzone/types.ts':
        'export interface AdminDataResponse { totally_hand_transcribed: string }\n',
      'pages/plantzone/Page.tsx':
        "import type { AdminDataResponse } from './types';\n" +
        "export const go = () => apiFetch<AdminDataResponse>('things');\n",
    });
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ file: 'pages/plantzone/Page.tsx', covered: false });
  });

  it('an import ALIAS moves coverage with the ORIGINAL name, in both directions', () => {
    // `import { Checked as Local }` must carry the check to `Local`; the
    // reverse spelling — a NEW type aliased to a checked name — must not
    // acquire it. Resolving the module without also resolving the alias would
    // close the sibling-`types.ts` hole and leave this one open.
    const sites = scanOnly({
      'api/hooks/useAliased.ts':
        "import type { AdminDataResponse as Checked } from '../types';\n" +
        "export const ok = () => apiFetch<Checked>('admin/users');\n",
      'api/hooks/useMasquerade.ts':
        "import type { BrandNewResponse as AdminDataResponse } from '../types';\n" +
        "export const nope = () => apiFetch<AdminDataResponse>('things');\n",
    });
    expect(sites.find((s) => s.file === 'api/hooks/useAliased.ts')?.covered).toBe(true);
    expect(sites.find((s) => s.file === 'api/hooks/useMasquerade.ts')?.covered).toBe(false);
  });

  it('a NAMESPACE-imported `apiFetch` (`import * as api`) is still `apiFetch`', () => {
    // Second review round. `import * as` is a live idiom in this tree, and the
    // callee scan's `(?<![.\w$])` lookbehind — there to stop `foo.fetch(` from
    // matching the global `fetch` — rejected the qualified form outright.
    const sites = scanOnly({
      'api/nsWrap.ts':
        "import * as api from './client';\n" +
        'export async function wrap<T>(p: string): Promise<T> { return api.apiFetch<T>(p); }\n',
      'pages/Ns.tsx':
        "import * as client from '../api/client';\n" +
        "import { wrap } from '../api/nsWrap';\n" +
        "import type { BrandNewResponse } from '../api/types';\n" +
        "export const direct = () => client.apiFetch<BrandNewResponse>('things');\n" +
        "export const viaWrapper = () => wrap<BrandNewResponse>('things');\n",
    });
    const inNs = sites.filter((s) => s.file === 'pages/Ns.tsx');
    expect(inNs.map((s) => s.descriptor).sort()).toEqual([
      "client.apiFetch<BrandNewResponse>('things')",
      "wrap<BrandNewResponse>('things')",
    ]);
    expect(inNs.every((s) => s.covered === false)).toBe(true);
    // The namespace-qualified forwarding call is what makes `wrap` a wrapper at
    // all — without it, `viaWrapper` above does not exist as a site.
    expect(sites.find((s) => s.file === 'api/nsWrap.ts' && s.detector === 'wrapper')).toBeDefined();
  });

  it('`apiFetch` imported under an ALIAS is still `apiFetch`', () => {
    const sites = scanOnly({
      'pages/Aliased.tsx':
        "import { apiFetch as request } from '../api/client';\n" +
        "import type { BrandNewResponse } from '../api/types';\n" +
        "export const go = () => request<BrandNewResponse>('things');\n",
    });
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ detector: 'apiFetch', covered: false });
  });

  it('two sites on ONE path with different methods are two sites, not one', () => {
    const sites = scanOnly({
      'api/hooks/useThing.ts':
        IMPORTS_ADMIN +
        `export const del = () => apiFetch<BrandNewResponse>(${THING_PATH}, { method: 'DELETE' });\n` +
        `export const put = () => apiFetch<BrandNewResponse>(${THING_PATH}, { method: 'PUT' });\n`,
    });
    expect(sites.map((s) => s.key)).toEqual([
      'api/hooks/useThing.ts :: apiFetch<BrandNewResponse>(`things/<var>`) [DELETE]',
      'api/hooks/useThing.ts :: apiFetch<BrandNewResponse>(`things/<var>`) [PUT]',
    ]);
  });

  it('an exemption is CONSUMED by one site — a second site sharing its key is not absorbed', () => {
    const files = {
      // Same path, same (absent) literal method, so the descriptors collide by
      // construction — the residual collision an HTTP method cannot resolve.
      'api/hooks/useThing.ts':
        IMPORTS_ADMIN +
        `export const a = () => apiFetch<BrandNewResponse>(${THING_PATH}, opts);\n` +
        `export const b = () => apiFetch<BrandNewResponse>(${THING_PATH}, opts);\n`,
    };
    const key = 'api/hooks/useThing.ts :: apiFetch<BrandNewResponse>(`things/<var>`)';
    const one = scanResult(files, [{ key, reason: 'x'.repeat(40) }]);
    expect(one.unverified.map((s) => s.key)).toEqual([key]);
    expect(one.unusedExemptions).toEqual([]);

    const two = scanResult(files, [
      { key, reason: 'x'.repeat(40) },
      { key, reason: 'y'.repeat(40) },
    ]);
    expect(two.unverified).toEqual([]);
    expect(two.unusedExemptions).toEqual([]);
  });

  it('SURPLUS exemption entries are reported with their counts, not silently used up', () => {
    const key = 'api/hooks/useThing.ts :: apiFetch<BrandNewResponse>(`things/<var>`)';
    const result = scanResult(
      {
        'api/hooks/useThing.ts':
          IMPORTS_ADMIN +
          `export const a = () => apiFetch<BrandNewResponse>(${THING_PATH}, opts);\n`,
      },
      [
        { key, reason: 'x'.repeat(40) },
        { key, reason: 'y'.repeat(40) },
      ],
    );
    expect(result.unusedExemptions).toEqual([
      `${key}  (2 entries recorded, only 1 matching site(s))`,
    ]);
  });

  it('a LOCALLY declared type cannot borrow a checked type name it merely shares', () => {
    const sites = scanOnly({
      'pages/Shadow.tsx':
        'export interface AdminDataResponse { totally_different: string }\n' +
        "export const go = () => apiFetch<AdminDataResponse>('things');\n",
    });
    expect(sites).toHaveLength(1);
    // The conformance module checks a type SPELLED `AdminDataResponse`; this
    // file declares its own, and coverage keyed on the spelling alone would
    // wave a wholly hand-transcribed shape through.
    expect(sites[0].covered).toBe(false);
  });

  it('a type imported into the conformance module but never ASSIGNED a fixture is not covered', () => {
    tmpRoot = fixtureTree({
      'api/types.ts': TYPES_STUB,
      // `BrandNewResponse` is imported ALONGSIDE the really-checked type and
      // mentioned — in a helper-type position only, never assigned a capture.
      // Reading coverage off the import list marks every site repo-wide that
      // names it as checked against a real response.
      [CONFORMANCE_MODULE]: [
        "import adminUsers from '../../../fixtures/api-responses/adminUsers.json';",
        "import type { AdminDataResponse, BrandNewResponse } from './types';",
        'const check: AdminDataResponse = adminUsers;',
        'type Expect<T, K extends string> = K;',
        "const mentioned: Expect<BrandNewResponse, 'id'> = 'id';",
      ].join('\n'),
      'api/hooks/useThing.ts':
        "import type { BrandNewResponse } from '../types';\n" +
        "export const load = () => apiFetch<BrandNewResponse>('things');\n",
    });
    const site = scanTree(tmpRoot).sites.find((s) => s.file === 'api/hooks/useThing.ts');
    expect(site).toMatchObject({ typeNames: ['BrandNewResponse'], covered: false });
  });

  it('a `@ts-expect-error` assignment is not a conformance check', () => {
    tmpRoot = fixtureTree({
      'api/types.ts': TYPES_STUB,
      [CONFORMANCE_MODULE]: [
        "import adminUsers from '../../../fixtures/api-responses/adminUsers.json';",
        "import type { AdminDataResponse, BrandNewResponse } from './types';",
        'const check: AdminDataResponse = adminUsers;',
        '// @ts-expect-error the capture is deliberately NOT this shape',
        'const nope: BrandNewResponse = adminUsers;',
      ].join('\n'),
      'api/hooks/useThing.ts':
        "import type { BrandNewResponse } from '../types';\n" +
        "export const load = () => apiFetch<BrandNewResponse>('things');\n",
    });
    const site = scanTree(tmpRoot).sites.find((s) => s.file === 'api/hooks/useThing.ts');
    expect(site?.covered).toBe(false);
  });

  it('a CAST-defeated conformance assignment is not a conformance check', () => {
    // Second review round, NEW-3. `fixture as unknown as T` is a bare
    // annotation, initialised from a fixture binding, with no
    // `@ts-expect-error` above it — it satisfies every other clause — and it
    // compiles whatever the capture's real shape is, so it asserts nothing.
    tmpRoot = fixtureTree({
      'api/types.ts': TYPES_STUB,
      [CONFORMANCE_MODULE]: [
        "import adminUsers from '../../../fixtures/api-responses/adminUsers.json';",
        "import type { AdminDataResponse, BrandNewResponse } from './types';",
        'const check: AdminDataResponse = adminUsers;',
        'const cast: BrandNewResponse = adminUsers as unknown as BrandNewResponse;',
      ].join('\n'),
      'api/hooks/useThing.ts':
        "import type { BrandNewResponse } from '../types';\n" +
        "export const load = () => apiFetch<BrandNewResponse>('things');\n",
    });
    const result = scanTree(tmpRoot);
    // The consuming site does not inherit coverage from it…
    expect(result.sites.find((s) => s.file === 'api/hooks/useThing.ts')).toMatchObject({
      typeNames: ['BrandNewResponse'],
      covered: false,
    });
    // …and the assignment itself surfaces as unverified rather than sitting in
    // the conformance module looking like a check.
    expect(result.unverified.map((s) => s.key)).toContain(
      `${CONFORMANCE_MODULE} :: const BrandNewResponse = adminUsers`,
    );
  });

  it('a URL in a string literal does not comment out the typed read beside it', () => {
    const sites = scanOnly({
      'pages/Url.ts':
        "import type { BrandNewResponse } from '../api/types';\n" +
        "export const go = async () => (await (await fetch('https://h/x')).json()) as BrandNewResponse;\n",
    });
    // The `//` in `https://` used to swallow the rest of the line, discarding
    // the TYPED read — the one direction this guard must never fail in.
    expect(sites.map((s) => s.detector).sort()).toEqual(['jsonBody', 'rawFetch']);
    expect(sites.find((s) => s.detector === 'jsonBody')).toMatchObject({
      typeNames: ['BrandNewResponse'],
      covered: false,
    });
  });

  it('a raw fetch whose body is asserted to an unchecked type is unverified', () => {
    const sites = scanOnly({
      'pages/Raw.ts':
        "export async function load() {\n  const res = await fetch('/api/things');\n" +
        '  const data = (await res.json()) as BrandNewResponse;\n  return data;\n}\n',
    });
    expect(sites.map((s) => s.detector)).toEqual(['rawFetch', 'jsonBody']);
    expect(sites[1]).toMatchObject({ typeNames: ['BrandNewResponse'], covered: false });
  });

  it('a JSON.parse assertion to an unchecked type is unverified', () => {
    const sites = scanOnly({
      'pages/Frame.ts': 'export const p = (raw: string) => JSON.parse(raw) as BrandNewResponse;\n',
    });
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ detector: 'jsonParse', covered: false });
  });

  it('raw network primitives are sites; an availability guard and prose are not', () => {
    const sites = scanOnly({
      'pages/Beacon.ts':
        '// clears via sendBeacon on pagehide, never EventSource\n' +
        "if (typeof navigator.sendBeacon !== 'function') { /* noop */ }\n" +
        "navigator.sendBeacon('/api/presence', body);\n" +
        "const es = new EventSource('/api/stream');\n",
    });
    expect(sites.map((s) => s.line)).toEqual([3, 4]);
    expect(sites.every((s) => s.detector === 'beacon')).toBe(true);
  });

  it('a hand-written literal fed into a conformance assertion is unverified', () => {
    tmpRoot = fixtureTree({
      'api/types.ts': TYPES_STUB,
      [CONFORMANCE_MODULE]: `${CONFORMANCE_STUB}\nconst handWritten: AdminDataResponse = { users: [] };\n`,
    });
    const sites = scanTree(tmpRoot).sites.filter((s) => s.detector === 'conformanceAssertion');
    expect(sites.map((s) => s.covered)).toEqual([true, false]);
  });

  it('finds NOTHING in a tree with no response sites (proves it does not just always-fire)', () => {
    const sites = scanOnly({
      'pages/Pure.ts':
        '// this module mentions apiFetch and JSON.parse only in prose\n' +
        'export const add = (a: number, b: number) => a + b;\n',
    });
    expect(sites).toEqual([]);
  });

  it('skips test files, so a mocked response in a spec is not a site', () => {
    const sites = scanOnly({
      'pages/Thing.test.ts': "const r = apiFetch<BrandNewResponse>('things');\n",
    });
    expect(sites).toEqual([]);
  });
});

describe('web/src — the guard sees the tree it claims to (anti-vacuity)', () => {
  const result = scanTree(WEB_SRC);

  it(`finds at least ${POPULATION_FLOOR} response-consuming sites`, () => {
    expect(result.sites.length).toBeGreaterThanOrEqual(POPULATION_FLOOR);
  });

  it('finds at least the floor for EVERY detector — a silently dead pattern fails here', () => {
    const counts = Object.fromEntries(
      Object.keys(DETECTOR_FLOORS).map((d) => [
        d,
        result.sites.filter((s) => s.detector === d).length,
      ]),
    ) as Record<Detector, number>;
    const below = Object.entries(DETECTOR_FLOORS).filter(
      ([d, floor]) => counts[d as Detector] < floor,
    );
    expect({ below, counts }).toEqual({ below: [], counts });
  });

  it('finds every canary site by name — an over-narrowed scan fails specifically', () => {
    const keys = new Set(result.sites.map((s) => s.key));
    const missing = CANARY_SITES.filter((c) => !keys.has(c.key));
    expect(missing).toEqual([]);
  });

  it('knows which client types are conformance-checked, and it is not an empty set', () => {
    const covered = result.sites.filter((s) => s.covered);
    expect(covered.length).toBeGreaterThanOrEqual(COVERED_FLOOR);
    // Population (b)'s one typed call — the endpoint this whole change exists
    // for — must be COVERED, not merely enumerated.
    expect(
      covered.some((s) => s.typeNames.includes('AdminDataResponse') && s.detector === 'wrapper'),
    ).toBe(true);
  });

  it('the fixture directory and the server capture inventory are the same set', () => {
    // The reverse direction of I4. Detector 7 refuses coverage to a
    // fixture-directory import the server never declared capturing; this
    // asserts the converse — that nothing is sitting in that directory
    // unaccounted for, and that every declared capture actually landed. Without
    // it, a hand-authored module could live there indefinitely, merely unable
    // to confer coverage.
    const declared = [...declaredCaptureNames()].sort();
    const onDisk = fs
      .readdirSync(FIXTURE_DIR)
      .filter((f) => !FIXTURE_SUPPORT_MODULES.has(f))
      .map((f) => f.replace(/\.(json|ts)$/, ''))
      .sort();
    expect(onDisk).toEqual(declared);
    expect(declared.length).toBeGreaterThanOrEqual(DECLARED_CAPTURE_FLOOR);
  });

  it('the dead Companion client types still have zero response sites', () => {
    const used = result.sites.filter((s) =>
      s.typeNames.some((n) => DEAD_CLIENT_TYPES.includes(n as (typeof DEAD_CLIENT_TYPES)[number])),
    );
    expect(report(used)).toBe('');
  });
});

describe('web/src — every response-consuming site is checked or exempted (spec: "New response-consuming sites cannot silently skip verification")', () => {
  const result = scanTree(WEB_SRC);

  it('has no site that acquires a client type without a conformance check or a recorded exemption', () => {
    expect(
      result.unverified.length === 0
        ? ''
        : `\n${result.unverified.length} unverified response site(s). Each needs EITHER a\n` +
            `conformance check in ${CONFORMANCE_MODULE} — its client type asserted against a\n` +
            `CAPTURED fixture, never a hand-written one — OR an entry in EXEMPTIONS\n` +
            `(web/src/apiResponseShapes.repo.test.ts) recording WHY it is acceptable\n` +
            `that this site's shape is unchecked:\n\n${report(result.unverified)}\n`,
    ).toBe('');
  });

  it('has no stale exemption — one matching no site is a lie about the tree', () => {
    expect(result.unusedExemptions).toEqual([]);
  });

  it('every exemption records a substantive reason, not a bare path', () => {
    const thin = EXEMPTIONS.filter((e) => e.reason.trim().length < 40);
    expect(thin).toEqual([]);
  });
});
