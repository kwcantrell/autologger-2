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
//      deliberately over-broad: every `apiFetch` call (typed or not), every
//      call to a LOCAL generic wrapper over `apiFetch` (discovered, not
//      hardcoded — this is the population `grep 'apiFetch<'` missed and the
//      `memberships` crash lived in), every global `fetch(`, every
//      `Response.json()`, every `JSON.parse(`, and every raw network primitive
//      (`navigator.sendBeacon`, `new EventSource`, `new XMLHttpRequest`).
//      Detector 7 additionally scans the conformance module itself. Anything a
//      JSON payload can enter web/src through is a site whether or not it looks
//      like a mistake. Over-matching costs a one-line exemption; under-matching
//      costs the next outage.
//   2. Nothing is covered by being ignored. A site is COVERED only when every
//      client type it acquires is one that `api/types.conformance.test.ts`
//      checks against a CAPTURED response — read out of that module's own
//      import list, so adding a check is what makes a site pass. Everything
//      else must be exempted BY SITE, with a reason, in EXEMPTIONS below —
//      never by file, never by glob, never by a type-wide or category-wide
//      rule that a future site could fall into unnoticed.
//      `apiFetch<OkResponse>` is the cautionary case: it reads as trivially
//      safe, and audit finding CW-1 proved it was not (transport start/stop
//      emit the transport state and no `ok` key at all). So each of those
//      sites carries its own exemption naming its audit row, and a NEW
//      `OkResponse` site is covered by none of them.
//   3. The scan is asserted to SEE things. A regex that matches zero files
//      passes forever. `POPULATION_FLOOR`, the per-detector minimums, and
//      CANARY_SITES all fail loudly if the walk or a pattern is over-narrowed,
//      so an empty scan cannot masquerade as a clean repo. A stale exemption
//      (one matching no site) is also an error — the same vacuity check from
//      the other direction.
//   4. The detectors are mutation-checked. The first three describe blocks run
//      the real scanner over synthetic trees carrying a planted unverified
//      site of each shape, and over a clean tree, so "the guard fires" and
//      "the guard does not just always-fire" are both demonstrated rather than
//      assumed.
//
// WHAT IT CANNOT SEE — stated, not glossed (audit.md §8 records the same list
// for the one-time enumeration):
//   - Test files. `*.test.ts(x)` and `test/` under web/src are outside the
//     application-code scan. Detector 7 is the one deliberate exception and it
//     covers only the conformance module.
//   - Indirect type acquisition. A JSON value passed as `unknown` into a typed
//     helper several modules away acquires its type at no `fetch`/`.json()`/
//     `JSON.parse` token, so no detector fires (audit §8.3).
//   - A re-assertion downstream of an already-flagged parse. Only the
//     deserialization token is a site; a later `x as SomeType` on the same
//     value is not separately detected (see the `dashboardPersistence` local-
//     storage exemption, whose reason names both lines).
//   - Whether a COVERED type is checked against the RIGHT endpoint's fixture.
//     Coverage is per type NAME, not per (site, endpoint) pair: reusing an
//     already-checked type on a new endpoint passes silently. The audit's
//     per-site verdict table is what answers that question.
//   - Data-dependent branches no captured fixture reaches (audit CW-9).
//   - WebSocket frames, an explicit Non-Goal of this change — the one
//     `JSON.parse(ev.data)` site is exempted as such, so a SECOND one would
//     still surface.
//   - Prose. Detectors skip matches inside comments (see `isProse`), the same
//     concession noAgentAuthoredMarkup.repo.test.ts makes; a real call written
//     after a `//` on the same line would be missed.

const CODE_EXTENSIONS = new Set(['.ts', '.tsx']);
const EXCLUDED_DIR_NAMES = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);

/** The conformance module — the sole authority on which client types are
 * checked against a captured response, and the target of detector 7. */
const CONFORMANCE_MODULE = 'api/types.conformance.test.ts';

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

// ---------------------------------------------------------------------------
// Source scanning primitives
// ---------------------------------------------------------------------------

/** Collapses whitespace so a site key survives reformatting and line moves. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Replaces `${…}` interpolations with a placeholder so that renaming a
 * variable does not churn every exemption key that mentions the endpoint.
 * The placeholder is `<var>` rather than a bare `<var>` so the keys below are
 * plain strings a linter has no reason to mistake for template literals. */
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

/** True when the match at `index` sits inside a comment — a `//` earlier on the
 * line, or a JSDoc/block-comment continuation line. Prose naming `sendBeacon`
 * or `EventSource` is common in this codebase's module headers and must not
 * masquerade as a call site; the same concession the repo's other repo-guards
 * make for comments that document an invariant. */
function isProse(content: string, index: number): boolean {
  const start = lineStartOf(content, index);
  const before = content.slice(start, index);
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

/** Reads the first argument of a call whose `(` is at `open`, honouring nested
 * brackets, quotes, and template interpolations. Returns '' when there is none. */
function readFirstArg(content: string, open: number): string {
  if (content[open] !== '(') return '';
  const start = open + 1;
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
      if (ch === ')' && depth === 0) return content.slice(start, i);
      depth--;
    } else if (ch === ',' && depth === 0) return content.slice(start, i);
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
}

/** Names of local generic wrappers over `apiFetch<T>` (population (b)).
 * DISCOVERED, not hardcoded: any generic function whose body forwards one of
 * its own type parameters to `apiFetch<…>` is a wrapper, so a second
 * `fetchAdmin` added tomorrow brings its call sites into the population
 * automatically instead of laundering them out of it. */
function discoverWrappers(content: string): string[] {
  const found: string[] = [];
  const decl =
    /(?:function\s+([A-Za-z_$][\w$]*)\s*<([^>]*)>|const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?<([^>]*)>)/g;
  for (let m = decl.exec(content); m !== null; m = decl.exec(content)) {
    const name = m[1] ?? m[3];
    if (name === 'apiFetch') continue; // the helper itself, not a wrapper of it
    const params = (m[2] ?? m[4])
      .split(',')
      .map((p) => p.trim().split(/[\s=]/)[0])
      .filter((p) => /^[A-Za-z_$][\w$]*$/.test(p));
    const body = content.slice(m.index, m.index + 1500);
    if (params.some((p) => new RegExp(`apiFetch\\s*<\\s*${p}\\s*>`).test(body))) found.push(name);
  }
  return [...new Set(found)];
}

function scanFile(rel: string, content: string, coveredTypes: Set<string>): Site[] {
  const sites: Site[] = [];
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

  // Detectors 1 + 2 — `apiFetch` and every discovered local wrapper over it.
  const callees = ['apiFetch', ...discoverWrappers(content)];
  for (const callee of callees) {
    const detector: Detector = callee === 'apiFetch' ? 'apiFetch' : 'wrapper';
    const re = new RegExp(`(?<![.\\w$])${callee}\\s*(?=[<(])`, 'g');
    for (let m = re.exec(content); m !== null; m = re.exec(content)) {
      if (isProse(content, m.index)) continue;
      let cursor = m.index + callee.length;
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
      const firstArg = normalizeArg(readFirstArg(content, cursor));
      const names = typeNamesIn(typeExpr);
      const covered = names.length > 0 && names.every((n) => coveredTypes.has(n));
      push(detector, m.index, `${callee}<${typeExpr}>(${firstArg})`, names, covered);
    }
  }

  // Detector 3 — the global `fetch(`, i.e. a request that bypasses the helper.
  const rawFetch = /(?<![.\w$])fetch\s*\(/g;
  for (let m = rawFetch.exec(content); m !== null; m = rawFetch.exec(content)) {
    if (isProse(content, m.index)) continue;
    const paren = content.indexOf('(', m.index);
    push('rawFetch', m.index, `fetch(${normalizeArg(readFirstArg(content, paren))})`, [], false);
  }

  // Detector 4 — `Response.json()`, the deserialization point of every JSON
  // body that did not go through `apiFetch`.
  const jsonBody = /\.json\s*\(\s*\)/g;
  for (let m = jsonBody.exec(content); m !== null; m = jsonBody.exec(content)) {
    if (isProse(content, m.index)) continue;
    const names = typeNamesIn(assertionAfter(content, m.index) ?? '');
    const covered = names.length > 0 && names.every((n) => coveredTypes.has(n));
    push('jsonBody', m.index, normalizeArg(lineTextAt(content, m.index)), names, covered);
  }

  // Detector 5 — `JSON.parse`, which is how SSE frames and WS messages enter.
  const jsonParse = /\bJSON\.parse\s*\(/g;
  for (let m = jsonParse.exec(content); m !== null; m = jsonParse.exec(content)) {
    if (isProse(content, m.index)) continue;
    const names = typeNamesIn(assertionAfter(content, m.index) ?? '');
    const covered = names.length > 0 && names.every((n) => coveredTypes.has(n));
    push('jsonParse', m.index, normalizeArg(lineTextAt(content, m.index)), names, covered);
  }

  // Detector 6 — the remaining raw-network primitives. Call-shaped on purpose
  // (`navigator.sendBeacon(`, `new EventSource(`), so a `typeof
  // navigator.sendBeacon !== 'function'` availability guard is not a site.
  const beacon = /(?:\bnavigator\.sendBeacon\s*\(|\bnew\s+(?:EventSource|XMLHttpRequest)\s*\()/g;
  for (let m = beacon.exec(content); m !== null; m = beacon.exec(content)) {
    if (isProse(content, m.index)) continue;
    push('beacon', m.index, normalizeArg(lineTextAt(content, m.index)), [], false);
  }

  return sites;
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

  const sites: Site[] = [];
  const decl = /\bconst\s+[A-Za-z_$][\w$]*\s*:\s*([^=]+?)\s*=\s*([^;]+);/g;
  for (let m = decl.exec(content); m !== null; m = decl.exec(content)) {
    if (isProse(content, m.index)) continue;
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
    sites.push({
      detector: 'conformanceAssertion',
      file: rel,
      line: lineOf(content, m.index),
      key: `${rel} :: const ${annotation} = ${root}`,
      descriptor: `const ${annotation} = ${root}`,
      typeNames: typeNamesIn(annotation),
      covered: fixtureBindings.has(root),
    });
  }
  return sites;
}

// ---------------------------------------------------------------------------
// The conformance-check vocabulary
// ---------------------------------------------------------------------------

/** Type names the conformance module checks against a CAPTURED fixture — read
 * from its `import type { … } from './types'` list rather than duplicated here,
 * so adding a check to that module is what makes a site covered. */
function coveredTypeNames(conformanceSource: string): Set<string> {
  const m = conformanceSource.match(/import\s+type\s*\{([\s\S]*?)\}\s*from\s*'\.\/types'/);
  if (!m) return new Set();
  return new Set(
    m[1]
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^[A-Z][A-Za-z0-9_]*$/.test(s)),
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
    key: 'api/hooks/useAudio.ts :: apiFetch<OkResponse>(`sessions/<var>/audio-recording-lease`)',
    reason:
      'audit §5 row 17 CONFORMS — `LeaseStore.claimLease` emits `{ok: true}` (409 on conflict), read end-to-end. Result discarded by the caller; no fixture captured (phase 4 §9 inventory).',
  },
  {
    key: 'api/hooks/useAudio.ts :: apiFetch<OkResponse>(`sessions/<var>/audio-recording-lease/heartbeat`)',
    reason:
      'audit §5 row 18 CONFORMS — emits `{ok}`, where `ok` can legitimately be `false` at 200. Result discarded; recorded there as a behavioural note, not a shape defect.',
  },
  {
    key: 'api/hooks/useAudio.ts :: apiFetch<OkResponse>(`sessions/<var>/audio-recording-lease/release`)',
    reason: 'audit §5 row 19 CONFORMS — emits `{ok: true}`. Result discarded.',
  },
  {
    key: 'api/hooks/useAudio.ts :: apiFetch<OkResponse>(`sessions/<var>/audio/segments/<var>/waveform`)',
    reason: 'audit §5 row 20 CONFORMS — emits `{ok: true}` (404 for an unknown segment).',
  },
  {
    key: 'api/hooks/useEvents.ts :: apiFetch<OkResponse>(`sessions/<var>/events/<var>`)',
    reason:
      'audit §5 row 21 CONFORMS — DELETE emits `{ok: true}` (404 if missing); 404 path probed.',
  },
  {
    key: 'api/hooks/useSessions.ts :: apiFetch<OkResponse>(`sessions/<var>/archive`)',
    reason:
      'audit §5 row 22 CONFORMS — emits `{ok: true, archived: true}`; the extra key is additively tolerated.',
  },
  {
    key: 'api/hooks/useSessions.ts :: apiFetch<OkResponse>(`sessions/<var>/restore`)',
    reason: 'audit §5 row 23 CONFORMS — emits `{ok: true, archived: false}`.',
  },
  {
    key: 'api/hooks/useSessions.ts :: apiFetch<OkResponse>(`sessions/<var>`)',
    reason: 'audit §5 row 24 CONFORMS — DELETE emits `{ok: true, hidden: true}`.',
  },
  {
    key: 'api/hooks/useSessions.ts :: apiFetch<OkResponse>(`sessions/<var>/youtube-import`)',
    reason:
      'audit §5 row 25 CONFORMS — `{ok: true}` on success; the handler was read in full including every guard and rollback path (503/400/409/502 otherwise).',
  },
  {
    key: 'api/hooks/useTeams.ts :: apiFetch<OkResponse>(teamPath(teamId))',
    reason: 'audit §5 row 30 CONFORMS — DELETE /api/teams/:id emits `{ok: true}`.',
  },
  {
    key: "api/hooks/useTeams.ts :: apiFetch<OkResponse>(teamPath(teamId, 'invites'))",
    reason:
      'audit §5 row 30 CONFORMS — POST invites emits `{ok: true}`, deliberately uniform across the existing-user and pending-invite branches.',
  },
  {
    key: "api/hooks/useTeams.ts :: apiFetch<OkResponse>(teamPath(teamId, 'invites', encodeURIComponent(email)))",
    reason: 'audit §5 row 30 CONFORMS — revoke invite emits `{ok: true}`.',
  },
  {
    key: "api/hooks/useTeams.ts :: apiFetch<OkResponse>(teamPath(teamId, 'members', encodeURIComponent(userId)))",
    reason: 'audit §5 row 30 CONFORMS — remove member emits `{ok: true}`.',
  },
  {
    key: "api/hooks/useTeams.ts :: apiFetch<OkResponse>(teamPath(teamId, 'leave'))",
    reason: 'audit §5 row 30 CONFORMS — leave team emits `{ok: true}`.',
  },

  // --- `apiFetch<void>` — the two 204 routes. Audit §5 rows 34 and 37.
  {
    key: 'api/hooks/useTopics.ts :: apiFetch<void>(`sessions/<var>/topics/<var>`)',
    reason:
      "audit §5 row 34 CONFORMS — DELETE topic returns 204 with an empty body and no content-type, so `apiFetch` takes its `res.text()` branch and returns `''` as `void`. No JSON payload exists to check.",
  },
  {
    key: 'api/hooks/useTranscriptWords.ts :: apiFetch<void>(`sessions/<var>/transcript-words/<var>`)',
    reason: 'audit §5 row 37 CONFORMS — DELETE transcript word, identical 204 + empty-body shape.',
  },

  // --- Untyped `apiFetch(…)` — population (c), audit §3. Six sites, all
  // discarding the response, so the inferred `unknown` never reaches a
  // consumer. Verdict row 40 (CONFORMS vacuously — no type is asserted).
  {
    key: "api/hooks/useCompanionPresence.ts :: apiFetch<>('companion/presence')",
    reason:
      'audit §3/§5 row 40 — untyped; response discarded via `.catch(() => {})`. Presence is best-effort by design.',
  },
  {
    key: "pages/index/components/NewSessionModal.tsx :: apiFetch<>('profile')",
    reason: 'audit §3/§5 row 40 — untyped PUT /api/profile; awaited, value unused.',
  },
  {
    key: 'pages/index/components/SessionWorkspace.tsx :: apiFetch<>(`sessions/<var>/transport/stop`)',
    reason: 'audit §3/§5 row 40 — untyped, fire-and-forget transport stop; value unused.',
  },
  {
    key: 'pages/index/components/YouTubeImportErrorModal.tsx :: apiFetch<>(`sessions/<var>/archive`)',
    reason: 'audit §3/§5 row 40 — untyped archive on the import-failure path; value unused.',
  },
  {
    key: 'pages/index/components/YouTubeImportErrorModal.tsx :: apiFetch<>(`sessions/<var>`)',
    reason: 'audit §3/§5 row 40 — untyped DELETE session on the import-failure path; value unused.',
  },
  {
    key: 'pages/index/hooks/useRecoveryStopWarning.ts :: apiFetch<>(`sessions/<var>/events`)',
    reason: 'audit §3/§5 row 40 — untyped recovery-stop event POST; value unused.',
  },

  // --- Untyped `fetchAdmin(…)` — population (b)'s five type-argument-free
  // call sites. Audit §2 and verdict row 39 (CONFORMS vacuously).
  {
    key: "pages/admin-users/AdminUsersPage.tsx :: fetchAdmin<>('admin/studios')",
    reason:
      'audit §2/§5 row 39 — no type argument, inferred `unknown`, response discarded. (Handler emits `{studio: {id, name, builtin}}`.)',
  },
  {
    key: 'pages/admin-users/AdminUsersPage.tsx :: fetchAdmin<>(`admin/studios/<var>`)',
    reason:
      'audit §2/§5 row 39 — no type argument; response discarded. Handler emits `{ok: true}`.',
  },
  {
    key: 'pages/admin-users/AdminUsersPage.tsx :: fetchAdmin<>(`admin/users/<var>/memberships`)',
    reason: 'audit §2/§5 row 39 — no type argument; response discarded.',
  },
  {
    key: 'pages/admin-users/AdminUsersPage.tsx :: fetchAdmin<>(`admin/users/<var>/memberships/<var>`)',
    reason: 'audit §2/§5 row 39 — no type argument; response discarded.',
  },
  {
    key: 'pages/admin-users/AdminUsersPage.tsx :: fetchAdmin<>(`admin/users/<var>/<var>`)',
    reason: 'audit §2/§5 row 39 — disable/enable toggle; no type argument; response discarded.',
  },

  // --- Raw `fetch(` call sites — population (d). A request on its own acquires
  // no type; where a body IS typed, the typing site is the `.json()` entry
  // below and carries its own reason.
  {
    key: 'pages/index/components/useSseTurn.tsx :: fetch(url)',
    reason:
      'audit §4 d14 — the SSE POST. The raw `Response` is only branched on `status`/`ok`/`body`; the body is typed downstream at `extractErrorDetail` and the `delta` frame parse, both listed separately.',
  },
  {
    key: 'pages/index/components/AiV2Design.tsx :: fetch(`<var>/sessions/<var>/ai/v2/answer`)',
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
    key: 'pages/index/components/aiV2/dashboardPersistence.ts :: fetch(`/api/sessions/<var>/ai/v2/dashboard<var>`)',
    reason: 'audit §4 d3 — the PUT request; its success body is never read.',
  },
  {
    key: 'pages/index/hooks/useAudioClips.ts :: fetch(`/api/sessions/<var>/audio/segments/sync-from-disk`)',
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

function scanTree(root: string): ScanResult {
  const conformancePath = path.join(root, ...CONFORMANCE_MODULE.split('/'));
  const conformanceSource = fs.existsSync(conformancePath)
    ? fs.readFileSync(conformancePath, 'utf8')
    : '';
  const typesPath = path.join(root, 'api', 'types.ts');
  const typesSource = fs.existsSync(typesPath) ? fs.readFileSync(typesPath, 'utf8') : '';

  const covered = coveredTypeNames(conformanceSource);
  const vocabulary = typesVocabulary(typesSource);

  const sites: Site[] = [];
  for (const file of walk(root)) {
    const rel = relOf(root, file);
    const content = fs.readFileSync(file, 'utf8');
    if (rel === CONFORMANCE_MODULE) {
      sites.push(...scanConformanceModule(rel, content, vocabulary));
      continue;
    }
    if (isTestFile(rel)) continue;
    sites.push(...scanFile(rel, content, covered));
  }

  const exemptKeys = new Set(EXEMPTIONS.map((e) => e.key));
  const usedExemptions = new Set<string>();
  const unverified: Site[] = [];
  for (const site of sites) {
    if (site.covered) continue;
    if (exemptKeys.has(site.key)) {
      usedExemptions.add(site.key);
      continue;
    }
    unverified.push(site);
  }

  return {
    sites,
    unverified,
    unusedExemptions: EXEMPTIONS.map((e) => e.key).filter((k) => !usedExemptions.has(k)),
  };
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

// Measured at the time of writing (2026-07-28): 117 sites — apiFetch 52,
// wrapper 7, rawFetch 8, jsonBody 5, jsonParse 5, beacon 2,
// conformanceAssertion 38 — of which 65 are COVERED and 52 are EXEMPTED.
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

  function scanOnly(files: Record<string, string>): Site[] {
    tmpRoot = fixtureTree({
      'api/types.ts': TYPES_STUB,
      [CONFORMANCE_MODULE]: CONFORMANCE_STUB,
      ...files,
    });
    return scanTree(tmpRoot).sites.filter((s) => s.detector !== 'conformanceAssertion');
  }

  it('a NEW typed apiFetch call whose type has no conformance check is unverified', () => {
    const sites = scanOnly({
      'api/hooks/useThing.ts':
        "import { apiFetch } from '../client';\n" +
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
      'api/hooks/useThing.ts':
        "export const load = () => apiFetch<AdminDataResponse>('admin/users');\n",
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
