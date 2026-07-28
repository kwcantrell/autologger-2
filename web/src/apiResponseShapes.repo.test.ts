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
// false negative is how the original bug shipped. Four structural choices
// follow from that:
//
//   1. The population is the union of SIX detectors over application code,
//      deliberately over-broad: every `apiFetch` call (typed or not, under its
//      imported name, under an import alias, or under a namespace qualifier
//      from `import * as api`), every call to a generic wrapper over `apiFetch`
//      (DISCOVERED tree-wide, not hardcoded and not per-file, and iterated to a
//      FIXED POINT so that a wrapper over a wrapper is a wrapper — this is the
//      population `grep 'apiFetch<'` missed and the `memberships` crash
//      lived in), every global `fetch(`, every `Response.json()`, every
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
//      (ii) assigned by a declaration that actually ASSERTS something, i.e. one
//      that neither sits under a `@ts-expect-error` nor casts its initializer
//      (`fixture as unknown as T` compiles whatever the capture's shape is);
//      and (iii) in scope in the SITE'S OWN FILE via an import whose specifier
//      RESOLVES — relative to that file, not merely spelled `types` — to the
//      canonical `api/types` module, under the export name that was checked.
//      Clause (iii) is what stops a locally declared type, or one imported from
//      a sibling per-feature `types.ts`, or one aliased onto a checked name,
//      from inheriting coverage by sharing a spelling; a specifier that does not
//      resolve inside the tree contributes no coverage at all, so its sites
//      surface. Everything else must be exempted BY SITE, with a reason,
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
//      vacuity check from the other direction.
//   4. The detectors are mutation-checked, over MULTI-FILE synthetic trees as
//      well as single-file ones. The first describe block runs the real scanner
//      over trees carrying a planted unverified site of each shape — including
//      a wrapper declared in one file and called from another, a wrapper over a
//      wrapper, a namespace-qualified `api.apiFetch<T>`, two sites on one path
//      differing only in method, a locally declared type shadowing a checked
//      name, a sibling `types.ts` shadowing one, an import alias in both
//      directions, and a cast-defeated conformance assignment — and over a
//      clean tree, so "the guard fires" and "the guard does not just
//      always-fire" are both demonstrated rather than assumed. Single-file
//      fixtures alone hid three gaps for a whole review cycle, and a second
//      adversarial round found three more; EVERY case below is a former false
//      negative, each verified to go red when its own fix is reverted.
//
// WHAT IT CANNOT SEE — stated, not glossed (audit.md §8 records the same list
// for the one-time enumeration, §11.5 the ranked version). Ordered by how
// reachable each is by an ordinary refactor, largest first; where two are
// equally reachable, the one that fails SILENTLY ranks higher. Nothing here is
// stated as absolute unless the code enforces it:
//   - Indirect type acquisition. A JSON value passed as `unknown` into a typed
//     helper several modules away acquires its type at no `fetch`/`.json()`/
//     `JSON.parse` token, so no detector fires (audit §8.3). This is the
//     largest REMAINING structural hole: it is a limit of matching on
//     deserialization syntax, not a tuning gap.
//   - A callee reached under a name rebound OUTSIDE the calling file. The scan
//     resolves `apiFetch` through a named import (including
//     `import { apiFetch as x }`) and through a namespace qualifier
//     (`import * as api` … `api.apiFetch<T>(…)`), and it resolves wrappers by
//     their DECLARED name anywhere in the tree. It does not follow a re-export
//     that renames (`export { apiFetch as request } from './client'`), nor a
//     wrapper imported under an alias (`import { fetchTyped as ft }`): under
//     either, the call site is invisible, not merely mis-keyed. One token of
//     refactor, and the same class as the two false negatives already found.
//   - Whether a COVERED type is checked against the RIGHT endpoint's fixture.
//     Coverage is per type NAME, not per (site, endpoint) pair: reusing an
//     already-checked type on a new endpoint passes silently. The same
//     looseness sits inside the conformance module — a `const x: T = <binding>`
//     counts when the binding is ANY captured fixture, so a slice of an
//     unrelated capture (`const s: Session = adminUsers.users[0]`) would count
//     as `Session`'s check. Deciding which fixture belongs to which type is the
//     audit's per-row verdict table (§5), which is a snapshot, not a standing
//     check; the guard cannot derive that mapping and does not pretend to.
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
//   - Whether an exemption's `reason` is TRUE. The guard forces a recorded,
//     non-trivial justification; it cannot adjudicate one.

const CODE_EXTENSIONS = new Set(['.ts', '.tsx']);
const EXCLUDED_DIR_NAMES = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);

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
 * Returns the inner text and the index just past the closing `>`, or null. */
function readAngles(content: string, open: number): { inner: string; end: number } | null {
  if (content[open] !== '<') return null;
  let depth = 0;
  for (let i = open; i < content.length; i++) {
    const ch = content[i];
    if (ch === '<') depth++;
    else if (ch === '>') {
      depth--;
      if (depth === 0) return { inner: content.slice(open + 1, i), end: i + 1 };
    } else if (ch === ';') {
      // A type-argument list never spans a statement break here; bailing keeps
      // a stray `<` from swallowing the rest of the file.
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

/** The source text of a function declaration starting at `start`, read to its
 * BALANCED closing brace (or, for a concise arrow body, its terminating `;`).
 *
 * A fixed-size window would silently stop looking partway through a long
 * function, so a wrapper whose forwarding call sits past the cutoff would be
 * laundered out of the population — the same class of miss this guard exists
 * to prevent. Braces inside the parameter list (destructuring, object type
 * literals) are not body braces and are skipped by tracking paren depth. */
function readDeclarationBody(content: string, start: number): string {
  let parenDepth = 0;
  let braceDepth = 0;
  let entered = false;
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
    if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (parenDepth === 0 && ch === '{') {
      braceDepth++;
      entered = true;
    } else if (parenDepth === 0 && ch === '}') {
      braceDepth--;
      if (entered && braceDepth <= 0) return content.slice(start, i + 1);
    } else if (ch === ';' && parenDepth === 0 && braceDepth === 0) {
      return content.slice(start, i + 1);
    }
  }
  return content.slice(start);
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
      let typeExpr = '';
      if (content[cursor] === '<') {
        const angles = readAngles(content, cursor);
        if (!angles) continue;
        typeExpr = collapse(angles.inner);
        cursor = angles.end;
        while (/\s/.test(content[cursor] ?? '')) cursor++;
      }
      if (content[cursor] !== '(') continue; // a re-export/reference, not a call
      const args = readArgs(content, cursor);
      const names = typeNamesIn(typeExpr);
      // The callee as WRITTEN (qualifier included), so `api.apiFetch<T>(…)` and
      // a bare `apiFetch<T>(…)` in the same file are two distinct keys.
      const written = collapse(m[0]).replace(/\s/g, '');
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

/** Detector 7 — the conformance module's own inputs, scanned only there.
 * Every `const x: <ClientType> = <expr>` in that module must be fed by a
 * binding imported from `fixtures/api-responses/`. This is what keeps design
 * D2 — "fixtures are captured by executing the handler, never hand-authored" —
 * from being quietly undone by someone adding a hand-written literal back into
 * the checks, which is precisely the transcription step that caused the bug. */
function scanConformanceModule(rel: string, content: string, vocabulary: Set<string>): Site[] {
  const fixtureBindings = new Set<string>();
  const imports =
    /import\s+(?:type\s+)?(?:(\w+)|\{([^}]*)\})\s+from\s+'[^']*fixtures\/api-responses\/[^']*'/g;
  for (let m = imports.exec(content); m !== null; m = imports.exec(content)) {
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
    const inlineObject =
      annotation.startsWith('{') && typeNamesIn(annotation).some((n) => vocabulary.has(n));
    if (!vocabulary.has(head) && !inlineObject) continue;
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
    const asserted =
      bare !== undefined &&
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
      ...(asserted ? { headType: bare } : {}),
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
    key: 'api/client.ts :: const j = (await res.json()) as { detail?: unknown };',
    reason:
      'The shared error probe (audit §4, last row). Reads only `detail` off a non-2xx body and narrows it with a `typeof` check before use; no payload type is asserted.',
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
    ? scanConformanceModule(CONFORMANCE_MODULE, conformanceSource, vocabulary)
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

const here = path.dirname(fileURLToPath(import.meta.url));
// this file: web/src/apiResponseShapes.repo.test.ts -> the scan root is web/src.
const WEB_SRC = here;

// ---------------------------------------------------------------------------
// Vacuity floors. A guard whose scan matches nothing passes forever, so the
// scan is asserted to SEE the tree it claims to cover. Floors are set below
// today's counts so that deleting a call site is not a failure, but silently
// losing a whole detector or an over-narrowed walk is.
// ---------------------------------------------------------------------------

// Measured after the phase-5 review fixes (2026-07-28): 120 sites — apiFetch
// 52, wrapper 7, rawFetch 8, jsonBody 5, jsonParse 5, beacon 2,
// conformanceAssertion 41 — of which 68 are COVERED and 52 are EXEMPTED.
// (Was 117/65/52 when coverage was read off the conformance module's import
// list; the three added sites are the direct `Show`, `Category` and
// `ActiveStudioCategory` fixture assignments that the corrected covered-set
// rule showed were missing.) The second review round's fixes — fixed-point
// wrapper discovery, resolved type-import specifiers, cast rejection, and
// namespace-qualified callees — left all four numbers unchanged on this tree,
// which is the expected result: they close shapes the tree does not yet
// contain.
// The floors sit under those with enough headroom that deleting a call site is
// not a failure, but losing a detector or over-narrowing the walk is.
const POPULATION_FLOOR = 100;
const DETECTOR_FLOORS: Record<Detector, number> = {
  apiFetch: 45,
  wrapper: 5,
  rawFetch: 6,
  jsonBody: 4,
  jsonParse: 4,
  beacon: 1,
  conformanceAssertion: 30,
};

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
    expect(covered.length).toBeGreaterThanOrEqual(60);
    // Population (b)'s one typed call — the endpoint this whole change exists
    // for — must be COVERED, not merely enumerated.
    expect(
      covered.some((s) => s.typeNames.includes('AdminDataResponse') && s.detector === 'wrapper'),
    ).toBe(true);
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
