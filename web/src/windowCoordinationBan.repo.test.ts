/// <reference types="node" />
// Like queryKeyFactories.repo.test.ts, this file needs Node's filesystem APIs
// (walking web/src from disk); the directive scopes the Node global-module
// types to this file alone rather than widening web/tsconfig.json's `types`
// for the whole workspace.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

// --- Window-coordination ban (web-coordination-seam, task 5.1; rebuilt on
// the TypeScript AST during the phase-5 fix wave) ---
//
// Spec "One-to-one coordination has a single typed module home": no file
// under web/src — production or test — may contain an ambient global-scope
// declaration block augmenting the `Window` interface, stated in absolute
// form because a rule scoped to "coordination handle names" can only
// enforce the names it was given (spec: "an eleventh handle would evade it
// silently"). Spec "No coordination handle is reintroduced on the global
// object by any route": no write to a global object's namespace exists,
// under any name.
//
// design D8: the draft check enumerated the ten retired handle names and was
// defeated by five mutations that all typecheck cleanly, plus a brand-new
// eleventh name it could not see because it was never told about it. This
// check is deliberately name-blind: it flags any write shape reaching a
// global object, never a specific handle name.
//
// PHASE-5 FIX WAVE (this rebuild). The first version of this file (task
// 5.1) was a per-line regex scan and was itself defeated by seven further
// mutations the phase-5 review found: `Reflect.set(window, 'X', fn)`,
// `globalThis['X'] ??= fn` (a logical-assignment operator), a destructured
// `const { assign } = Object; assign(window, {...})`, the same write in a
// `.mts` file (the walker's own extension filter), `self.X = fn` (a global
// alias the regex never named), a computed (non-literal) bracket key, and a
// multi-line `Object.assign(...)` call (the regex ran per-line). Regex
// shape #8 was never going to be the last one — this repo carries a
// standing recommendation from an earlier campaign audit that a fifth
// scanner defect means "rebuild on `ts.createSourceFile`, not a fifth
// patch." Seven had appeared. This file now parses each source file into a
// real AST and asks a structural question — "does this assignment's target,
// or this call's first argument, RESOLVE to a global object?" — rather than
// pattern-matching source text. `ts.createSourceFile` needs no `ts.Program`
// or type-checker for this; it is a pure parse, no different in cost from
// the regex scan it replaces.
//
// WHAT COUNTS AS "resolves to a global object": the identifiers `window`,
// `globalThis`, `self`, `top` (BASE_GLOBAL_NAMES below), OR a local variable
// whose initializer is one of those (or, transitively, another such local
// variable — `const g = globalThis; const g2 = g;` both alias), unwrapping
// parentheses, `as`/`satisfies`/`<T>` casts, and non-null assertions at
// every step. A write is any assignment (`=` and every compound/logical
// operator `isAssignmentOperatorToken` recognizes — `+=`, `??=`, `||=`,
// `&&=`, ...) whose LEFT side is a property access (`g.X = `), an element
// access with a literal or a COMPUTED key (`g['X'] =` / `g[key] =`), OR a
// call to `Object.assign`/`Object.defineProperty`/`Reflect.set` whose first
// argument resolves to a global object — recognized both by its direct
// `Object.assign(...)` spelling and through a destructured or
// identifier-aliased reference (`const { assign } = Object;` /
// `const set = Reflect.set;`). None of this depends on the write landing on
// one source line, one specific base name, or one specific call spelling.
//
// PHASE-5 FIX WAVE 2 (N1/N2/N3, this rebuild). The re-review of fix wave 1
// found three more write-shape survivors, none of them exotic:
// - N2/N3 — a write target SELECTED by a ternary or short-circuit
//   expression, `(cond ? window : globalThis).X = fn` or
//   `(maybeWindow() || window).X = fn`. `unwrap()` deliberately never peels
//   `ConditionalExpression`/`BinaryExpression` (peeling a branch means
//   CHOOSING one, not stripping a wrapper) — instead, "resolves to a global
//   object" is now the separate, recursive `resolvesToGlobal` predicate,
//   which treats a conditional/short-circuit expression as a global
//   reference if EITHER operand resolves to one, applied at every write
//   site (dot/bracket-write target, `Object.assign`-family first argument)
//   AND inside alias resolution itself (`const g = cond ? window :
//   globalThis;` now also aliases `g`).
// - N1 — a global reference exported from one file and written to through
//   an IMPORTED binding in another (`export const w = window;` / `w.X =
//   fn;` in an importing file). This file's guards are all single-file AST
//   scans with no `ts.Program` and no module resolution, so teaching this
//   one check to follow an `ImportSpecifier` back to its declaring file
//   would be a structural addition none of its sibling `*.repo.test.ts`
//   files share. Closed at its SOURCE instead:
//   `collectExportedGlobalAliasViolations` flags the EXPORT of a name that
//   resolves to a global object — `export const w = window;`, `const w =
//   globalThis; export { w };`, `export default window;` — so the write in
//   the importing file can never happen without the export that enabled it
//   already being its own violation, in the file where the AST scan can see
//   it.
//
// WHAT THIS STILL DOES NOT SEE (residual, stated rather than discovered
// later): a global reference reached only through a function CALL that
// *returns* the global object (`getWindow().X = fn`) — the alias tracking
// follows variable initializers, not arbitrary call results; a global
// alias captured as a function PARAMETER default (`function f(w = window)`)
// rather than a `const`/`let`/`var` declaration; and reflective indirection
// this repo's own precedent (`server/src/packageBoundaries.repo.test.ts`)
// disclaims for the same reason — `eval`, `Function(...)`, and
// `createRequire`. Each is a call-shaped or parameter-shaped indirection a
// textual/structural scan without a type-checker cannot resolve; none is
// exotic-syntax the way the ten prior survivors were, and none has a live
// instance in this tree today (verified by the zero-violations real-tree
// assertion below over the actual `web/src`). A further, NEW residual this
// fix wave's own rebuild introduces: `collectExportedGlobalAliasViolations`
// resolves the EXPORTED name against this file's OWN `globalAliasNames`, so
// it does not chase an alias exported under one name and then RE-exported
// under another through a second file (`a.ts`: `export const w = window;`;
// `b.ts`: `export { w as w2 } from './a';`; `c.ts`: `w2.X = fn;`) — `b.ts`'s
// re-export has no local `VariableDeclaration` for `w2` to resolve, so
// `resolveGlobalAliases` never adds it. `a.ts`'s own `export const w =
// window;` line is still flagged there, so the chain is caught at its
// origin, but not at every hop; no live instance exists in `web/src` today.
//
// TWO ATTACKS THIS FIX WAVE INVENTED AGAINST ITS OWN REBUILD (per the
// re-review's mandate to keep attacking, not just re-run the recorded
// list). One was fixed on the spot because it cost one line and one Set
// entry; the other is disclosed as a residual rather than fixed, because
// closing it properly would mean tracking every bare-identifier
// REASSIGNMENT (not just declarations) as a potential alias source across
// the whole file — a materially bigger structural change with its own new
// false-positive surface, for a shape with no live instance today:
// - FIXED: `Object.defineProperties(window, {...})` — the multi-property
//   sibling of `Object.defineProperty`, entirely absent from the original
//   `OPERATIONS` set. Added alongside `Object.assign` (same "many
//   properties in one call" unconditional-flag treatment).
// - NOT FIXED, disclosed: `export let w: any; w = window;` (a `let`/`var`
//   export declared WITHOUT an initializer, then reassigned to a global in
//   a later bare-identifier statement) is invisible to alias tracking.
//   `collectVarCandidates` only harvests `VariableDeclaration`s that
//   already carry an `initializer`, so a declaration-without-initializer
//   never becomes a `VarCandidate` at all; the later `w = window;`
//   reassignment has a bare `Identifier` on its LEFT side, which the
//   assignment-detection walk only checks for PROPERTY/ELEMENT access, not
//   bare-identifier targets. The export itself is therefore never flagged
//   (unlike the `export const w = window;` shape, which IS caught at
//   declaration), and a subsequent `w.X = fn;` in an importing file is
//   likewise invisible. Confirmed live against the real `web/src` tree
//   during this fix wave's own attack-invention pass (reverted
//   immediately; no live instance exists in this tree today).
//
// THIS FILE'S OWN FIXTURES AND PROSE: every dangerous construct this file's
// detectors look for is assembled at runtime from separate tokens (`W`, `G`,
// `DECLARE`, `GLOBAL`, ...) rather than written as a contiguous literal —
// exactly queryKeyFactories.repo.test.ts's concatenation discipline. This
// matters LESS than it did for the old regex scan (a string literal like
// `'window.X = fn;'` is opaque to the AST parser — it can never be
// misparsed as a real assignment the way a regex could match it inside a
// comment or a string), but is kept because the fixture-returning helpers
// still assemble literal TEXT that gets written to and parsed from separate
// synthetic files, and consistency with the sibling repo-test files' idiom
// costs nothing.

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const EXCLUDED_DIR_NAMES = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);

// Known platform builtins this repo legitimately assigns onto `window` /
// `globalThis` — derived by running this file's own scanner against the real
// tree and allowlisting each finding by hand, not by trusting a supplied
// list: jsdom test stubs for matchMedia, ResizeObserver, IntersectionObserver
// (EventLogSheet.test.tsx, a multi-line assignment the AST scan handles
// natively — no per-line boundary to split across), Audio, and localStorage.
// Anything else is a coordination-handle-shaped write and must be caught.
const BUILTIN_ALLOWLIST = new Set([
  'matchMedia',
  'ResizeObserver',
  'IntersectionObserver',
  'Audio',
  'localStorage',
]);

// The base identifiers a write target can resolve to, directly or via a
// tracked local alias. `self` and `top` are real runtime aliases for the
// global object in a browser (Finding 2, mutation A11) — textually ordinary
// identifiers, so real local variables can legitimately be named `top` (this
// tree has one: Timeline.tsx's tooltip-positioning `let top = ...`). That is
// exactly why only DOT/BRACKET WRITES and destructured-operation calls on
// these names are flagged, never a bare `top = ...` reassignment of the
// identifier itself (which would misfire on that legitimate local) — a bare
// reassignment is caught only via the separate ambient-declared-name pass
// below, which requires an actual `declare global { var top }` block to
// exist somewhere in the tree first.
const BASE_GLOBAL_NAMES = new Set(['window', 'globalThis', 'self', 'top']);

// The three global-object mutation primitives this scanner recognizes by
// call shape, whether reached directly (`Object.assign(...)`) or through a
// destructured/identifier alias (`const { assign } = Object;` /
// `const set = Reflect.set;`).
type Operation =
  | 'Object.assign'
  | 'Object.defineProperty'
  | 'Object.defineProperties'
  | 'Reflect.set';
const OPERATIONS = new Set<Operation>([
  'Object.assign',
  'Object.defineProperty',
  'Object.defineProperties',
  'Reflect.set',
]);

// --- fixture-building tokens (see file-header note) ---
const W = 'window';
const G = 'globalThis';
const DECLARE = 'declare';
const GLOBAL = 'global';

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

interface Violation {
  file: string;
  line: number;
  kind: string;
  text: string;
}

function scriptKindFor(ext: string): ts.ScriptKind {
  switch (ext) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      // .ts, .mts, .cts all parse as plain TS syntax.
      return ts.ScriptKind.TS;
  }
}

function parseFile(rel: string, content: string): ts.SourceFile {
  return ts.createSourceFile(
    rel,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(path.extname(rel)),
  );
}

function lineAt(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function textOfLine(content: string, line: number): string {
  return content.split('\n')[line - 1]?.trim() ?? '';
}

/** `token` is `=` or any compound/logical-assignment operator (`+=`, `??=`,
 * `||=`, `&&=`, ...). `ts.isAssignmentOperator` implements this exact range
 * check at runtime but is not part of `typescript`'s public `.d.ts` (an
 * internal compiler API bundled into the same module, invisible to
 * `tsc --noEmit`) — reimplemented here from the public
 * `SyntaxKind.FirstAssignment`/`LastAssignment` bounds the type declarations
 * DO export, rather than reaching past the type checker with an `as`-cast
 * onto the untyped runtime export. */
function isAssignmentOperatorToken(token: ts.SyntaxKind): boolean {
  return token >= ts.SyntaxKind.FirstAssignment && token <= ts.SyntaxKind.LastAssignment;
}

/** Unwraps parens, `as`/`satisfies`/`<T>` casts, and non-null assertions —
 * every shape a global reference can be wrapped in without changing what it
 * refers to (Finding 2's "regardless of syntax"). Does NOT peel
 * `ConditionalExpression`/`BinaryExpression` — that is `resolvesToGlobal`'s
 * job (phase-5 fix wave 2, N2/N3), since peeling those means picking a
 * BRANCH, not a single inner expression. */
function unwrap(node: ts.Expression): ts.Expression {
  let n = node;
  for (;;) {
    if (ts.isParenthesizedExpression(n)) {
      n = n.expression;
    } else if (ts.isAsExpression(n) || ts.isSatisfiesExpression(n)) {
      n = n.expression;
    } else if (ts.isNonNullExpression(n)) {
      n = n.expression;
    } else if (ts.isTypeAssertionExpression(n)) {
      n = n.expression;
    } else {
      return n;
    }
  }
}

/** The short-circuit/ternary operators whose result can be EITHER operand
 * at runtime, so a global reference "selected" through one of them must be
 * treated as a global reference if EITHER side resolves to one (phase-5
 * fix wave 2, N2/N3: `(cond ? window : globalThis).X = fn`,
 * `(maybeWindow() || window).X = fn`). */
function isBranchingOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.BarBarToken ||
    kind === ts.SyntaxKind.AmpersandAmpersandToken ||
    kind === ts.SyntaxKind.QuestionQuestionToken
  );
}

/** Does `expr` resolve to a global object — directly, through a tracked
 * local alias (`aliasNames`), or through ANY branch of a ternary or
 * short-circuit expression selecting between two such references? Recurses
 * through nested conditionals/short-circuits (`a ? (b ? window : x) : y`),
 * so an arbitrarily deep branch structure is still caught as long as some
 * leaf resolves to a global. */
function resolvesToGlobal(expr: ts.Expression, aliasNames: Set<string>): boolean {
  const u = unwrap(expr);
  if (ts.isIdentifier(u)) {
    return BASE_GLOBAL_NAMES.has(u.text) || aliasNames.has(u.text);
  }
  if (ts.isConditionalExpression(u)) {
    return resolvesToGlobal(u.whenTrue, aliasNames) || resolvesToGlobal(u.whenFalse, aliasNames);
  }
  if (ts.isBinaryExpression(u) && isBranchingOperator(u.operatorToken.kind)) {
    return resolvesToGlobal(u.left, aliasNames) || resolvesToGlobal(u.right, aliasNames);
  }
  return false;
}

interface VarCandidate {
  name: string;
  initExpr: ts.Expression | undefined;
}

interface DestructureCandidate {
  boundName: string;
  sourceObj: string;
  sourceProp: string;
}

/** Every `declare global { ... }` block in `sf` — a `ModuleDeclaration` whose
 * name is the bare identifier `global` (never a string-literal module name,
 * which is how `declare module '*.css'` parses, so those are excluded by
 * construction rather than by a name blocklist). */
function declareGlobalBlocksOf(sf: ts.SourceFile): ts.ModuleDeclaration[] {
  const blocks: ts.ModuleDeclaration[] = [];
  function visit(node: ts.Node) {
    if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'global') {
      blocks.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return blocks;
}

/** Every `var <Name>` declared directly inside a `declare global { ... }` block. */
function ambientVarNamesOf(block: ts.ModuleDeclaration): string[] {
  const names: string[] = [];
  if (block.body && ts.isModuleBlock(block.body)) {
    for (const stmt of block.body.statements) {
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) names.push(decl.name.text);
        }
      }
    }
  }
  return names;
}

/** Collects every `VariableDeclaration` in `sf`, split into plain
 * identifier bindings (candidates for a global-object OR an operation
 * alias) and object-destructuring bindings off a bare identifier source
 * (candidates for `const { assign } = Object;`-style operation aliases). */
function collectVarCandidates(sf: ts.SourceFile): {
  varCandidates: VarCandidate[];
  destructureCandidates: DestructureCandidate[];
} {
  const varCandidates: VarCandidate[] = [];
  const destructureCandidates: DestructureCandidate[] = [];
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name) && node.initializer) {
        varCandidates.push({ name: node.name.text, initExpr: node.initializer });
      } else if (
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        ts.isIdentifier(node.initializer)
      ) {
        const sourceObj = node.initializer.text;
        for (const el of node.name.elements) {
          if (ts.isIdentifier(el.name) && !el.dotDotDotToken) {
            const sourceProp =
              el.propertyName && ts.isIdentifier(el.propertyName)
                ? el.propertyName.text
                : el.name.text;
            destructureCandidates.push({ boundName: el.name.text, sourceObj, sourceProp });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return { varCandidates, destructureCandidates };
}

/** Fixed-point resolution: a name aliases a global object if its initializer
 * resolves (per `resolvesToGlobal` — direct, transitively-aliased, or
 * through a ternary/short-circuit branch) to a base global name or a name
 * already known to alias one — so `const g = globalThis; const g2 = g;`
 * resolves `g2` too, at whatever chain depth, and so does
 * `const g = cond ? window : globalThis;`. */
function resolveGlobalAliases(varCandidates: VarCandidate[]): Set<string> {
  const aliasNames = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const { name, initExpr } of varCandidates) {
      if (aliasNames.has(name) || !initExpr) continue;
      if (resolvesToGlobal(initExpr, aliasNames)) {
        aliasNames.add(name);
        changed = true;
      }
    }
  }
  return aliasNames;
}

/** Local names bound to one of the three mutation primitives, whether via
 * destructuring (`const { assign } = Object;`) or a plain identifier alias
 * (`const set = Reflect.set;`). */
function resolveOperationAliases(
  varCandidates: VarCandidate[],
  destructureCandidates: DestructureCandidate[],
): Map<string, Operation> {
  const map = new Map<string, Operation>();
  for (const { boundName, sourceObj, sourceProp } of destructureCandidates) {
    const op = `${sourceObj}.${sourceProp}`;
    if (OPERATIONS.has(op as Operation)) map.set(boundName, op as Operation);
  }
  for (const { name, initExpr } of varCandidates) {
    if (!initExpr) continue;
    const u = unwrap(initExpr);
    if (ts.isPropertyAccessExpression(u) && ts.isIdentifier(u.expression)) {
      const op = `${u.expression.text}.${u.name.text}`;
      if (OPERATIONS.has(op as Operation)) map.set(name, op as Operation);
    }
  }
  return map;
}

/**
 * Cross-file aliasing (Finding N1, phase-5 fix re-review) is closed AT ITS
 * SOURCE rather than by resolving imports across files: this repo's guards
 * are all single-file-AST scans (no `ts.Program`, no module resolution), so
 * teaching this one check to follow an `ImportSpecifier` back to its
 * declaring file would be a structural addition none of its siblings share.
 * Instead, flag the EXPORT of a global reference itself — `export const w =
 * window;`, `const w = globalThis; export { w };`, `export default window;`
 * — so `w.X = fn` in an importing file can never happen without the export
 * that made it possible already being a violation in its own file. Requires
 * `globalAliasNames` (this file's own resolved alias set) as input, since an
 * exported name can itself be an alias-of-an-alias.
 */
function collectExportedGlobalAliasViolations(
  sf: ts.SourceFile,
  rel: string,
  content: string,
  globalAliasNames: Set<string>,
): Violation[] {
  const violations: Violation[] = [];

  function flag(node: ts.Node) {
    const line = lineAt(sf, node.getStart(sf));
    violations.push({
      file: rel,
      line,
      kind: 'global-alias-export',
      text: textOfLine(content, line),
    });
  }

  for (const stmt of sf.statements) {
    // `export const w = window;` (also `let`/`var`, and an initializer that
    // is itself an alias-of-an-alias or a ternary/short-circuit selecting a
    // global — resolvesToGlobal handles all of those uniformly).
    if (ts.isVariableStatement(stmt) && ts.canHaveModifiers(stmt)) {
      const isExported = ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (isExported) {
        for (const decl of stmt.declarationList.declarations) {
          if (decl.initializer && resolvesToGlobal(decl.initializer, globalAliasNames)) {
            flag(decl);
          }
        }
      }
    }

    // `const w = window; export { w };` / `export { w as x };` — a name
    // this file already resolved as a global alias, exported by a separate
    // statement rather than at its declaration site.
    if (
      ts.isExportDeclaration(stmt) &&
      !stmt.moduleSpecifier &&
      stmt.exportClause &&
      ts.isNamedExports(stmt.exportClause)
    ) {
      for (const el of stmt.exportClause.elements) {
        const localName = (el.propertyName ?? el.name).text;
        if (globalAliasNames.has(localName)) flag(el);
      }
    }

    // `export default window;` / `export default g;`
    if (
      ts.isExportAssignment(stmt) &&
      !stmt.isExportEquals &&
      resolvesToGlobal(stmt.expression, globalAliasNames)
    ) {
      flag(stmt);
    }
  }

  return violations;
}

/**
 * Per-file scan: `declare global` blocks, every assignment (any operator
 * `isAssignmentOperatorToken` recognizes) whose target is a property/element
 * access on a global-object reference, every
 * `Object.assign`/`Object.defineProperty`/`Reflect.set` call (direct or
 * aliased) whose first argument is a global-object reference, and every
 * EXPORT of a name that resolves to a global object (N1's fix — see
 * `collectExportedGlobalAliasViolations`). Does NOT include the cross-file
 * ambient-bare-identifier pass — that runs once per tree in `scanTree`,
 * because it needs every file's declared ambient names before it can check
 * any file's bare references.
 */
function scanFileForViolations(rel: string, content: string): Violation[] {
  const sf = parseFile(rel, content);
  const violations: Violation[] = [];

  for (const block of declareGlobalBlocksOf(sf)) {
    const line = lineAt(sf, block.getStart(sf));
    violations.push({ file: rel, line, kind: 'declare-global', text: textOfLine(content, line) });
  }

  const { varCandidates, destructureCandidates } = collectVarCandidates(sf);
  const globalAliasNames = resolveGlobalAliases(varCandidates);
  const operationAliases = resolveOperationAliases(varCandidates, destructureCandidates);

  violations.push(...collectExportedGlobalAliasViolations(sf, rel, content, globalAliasNames));

  function isGlobalRef(expr: ts.Expression): boolean {
    return resolvesToGlobal(expr, globalAliasNames);
  }

  function visit(node: ts.Node) {
    if (ts.isBinaryExpression(node) && isAssignmentOperatorToken(node.operatorToken.kind)) {
      const left = unwrap(node.left);
      if (ts.isPropertyAccessExpression(left) && isGlobalRef(left.expression)) {
        const propName = left.name.text;
        if (!BUILTIN_ALLOWLIST.has(propName)) {
          const line = lineAt(sf, left.getStart(sf));
          violations.push({
            file: rel,
            line,
            kind: 'global-dot-write',
            text: textOfLine(content, line),
          });
        }
      } else if (ts.isElementAccessExpression(left) && isGlobalRef(left.expression)) {
        const line = lineAt(sf, left.getStart(sf));
        const argExpr = left.argumentExpression;
        if (argExpr && ts.isStringLiteralLike(argExpr)) {
          if (!BUILTIN_ALLOWLIST.has(argExpr.text)) {
            violations.push({
              file: rel,
              line,
              kind: 'global-bracket-write',
              text: textOfLine(content, line),
            });
          }
        } else {
          // A computed (non-literal) key: the property name cannot be
          // resolved statically, so it cannot be allowlist-checked — flagged
          // unconditionally (Finding 2, mutation A12).
          violations.push({
            file: rel,
            line,
            kind: 'global-computed-write',
            text: textOfLine(content, line),
          });
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      let operation: Operation | undefined;
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        const cand = `${callee.expression.text}.${callee.name.text}`;
        if (OPERATIONS.has(cand as Operation)) operation = cand as Operation;
      } else if (ts.isIdentifier(callee) && operationAliases.has(callee.text)) {
        operation = operationAliases.get(callee.text);
      }
      if (operation && node.arguments.length > 0 && isGlobalRef(node.arguments[0])) {
        const line = lineAt(sf, node.getStart(sf));
        if (operation === 'Object.assign' || operation === 'Object.defineProperties') {
          // Object.assign / Object.defineProperties (plural -- the
          // multi-property sibling of Object.defineProperty, found by one
          // of this fix wave's own invented attacks: it merges/defines many
          // properties in one call, exactly like Object.assign, and was
          // absent from the original OPERATIONS set) can merge many
          // properties in one call; the original regex scan never
          // allowlist-filtered this shape either (a builtin-only
          // Object.assign onto window/globalThis has no live instance in
          // this tree), so this stays an unconditional flag.
          violations.push({
            file: rel,
            line,
            kind: operation === 'Object.assign' ? 'object-assign' : 'object-define-properties',
            text: textOfLine(content, line),
          });
        } else {
          const kind = operation === 'Object.defineProperty' ? 'define-property' : 'reflect-set';
          const propArg = node.arguments[1];
          if (propArg && ts.isStringLiteralLike(propArg)) {
            if (!BUILTIN_ALLOWLIST.has(propArg.text)) {
              violations.push({ file: rel, line, kind, text: textOfLine(content, line) });
            }
          } else {
            violations.push({ file: rel, line, kind, text: textOfLine(content, line) });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }
  visit(sf);

  return violations;
}

/** True iff `node` is a genuinely BARE reference to its name — not the
 * property-name half of a dotted/qualified access, not a declaration name,
 * not an object-literal or binding-pattern property key, not an
 * import/export specifier's module-binding name. Those are the only shapes
 * where an identifier's TEXT can equal an ambient name without being a
 * value-level read or write of it. */
function isBareReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  return true;
}

/** Cross-file pass: a bare (unqualified) reference — read OR write — to any
 * name declared via `declare global { var X }` anywhere in the tree (design
 * D8: "a bare-identifier read also survives"). Guarded by the caller on
 * `ambientNames.size > 0`, so this never runs (and cannot false-positive on
 * an ordinary same-named local, e.g. Timeline.tsx's `top`) unless some file
 * actually declares an ambient global var of that name first.
 */
function scanBareIdentifierReferences(
  rel: string,
  content: string,
  ambientNames: Set<string>,
): Violation[] {
  const sf = parseFile(rel, content);
  const violations: Violation[] = [];
  function visit(node: ts.Node) {
    if (ts.isIdentifier(node) && ambientNames.has(node.text) && isBareReference(node)) {
      const line = lineAt(sf, node.getStart(sf));
      violations.push({
        file: rel,
        line,
        kind: 'ambient-bare-identifier',
        text: textOfLine(content, line),
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return violations;
}

/** Full-tree scan: per-file violations plus the cross-file ambient-bare-
 * identifier pass. Ambient names are collected from EVERY file before any
 * file's bare-reference scan runs, so declaration order in the walk never
 * matters. */
function scanTree(root: string): { violations: Violation[]; filesExamined: number } {
  const files = walk(root);
  const fileData = files.map((f) => ({
    rel: path.relative(root, f).split(path.sep).join('/'),
    content: fs.readFileSync(f, 'utf8'),
  }));

  const ambientNames = new Set<string>();
  for (const { rel, content } of fileData) {
    for (const block of declareGlobalBlocksOf(parseFile(rel, content))) {
      for (const n of ambientVarNamesOf(block)) ambientNames.add(n);
    }
  }

  const violations: Violation[] = [];
  for (const { rel, content } of fileData) {
    violations.push(...scanFileForViolations(rel, content));
    if (ambientNames.size > 0) {
      violations.push(...scanBareIdentifierReferences(rel, content, ambientNames));
    }
  }

  return { violations, filesExamined: fileData.length };
}

// --- fixture builders (obfuscated per the file-header note) ---

function windowDotWrite(prop: string): string {
  return `${W}.${prop} = fn;`;
}

function bracketWriteViaCastAlias(prop: string): string {
  return `(${W} as unknown as Record<string, unknown>)['${prop}'] = fn;`;
}

function objectAssignWrite(target: 'window' | 'globalThis', prop: string): string {
  const t = target === 'window' ? W : G;
  return `Object.assign(${t}, { ${prop}: fn });`;
}

function definePropertyWrite(target: 'window' | 'globalThis', prop: string): string {
  const t = target === 'window' ? W : G;
  return `Object.defineProperty(${t}, '${prop}', { value: fn });`;
}

/** Fix wave 2's own invented attack: the multi-property sibling of
 * `Object.defineProperty`, absent from the original `OPERATIONS` set. */
function definePropertiesWrite(target: 'window' | 'globalThis', prop: string): string {
  const t = target === 'window' ? W : G;
  return `Object.defineProperties(${t}, { ${prop}: { value: fn } });`;
}

function aliasedGlobalWrite(target: 'window' | 'globalThis', prop: string): string {
  const t = target === 'window' ? W : G;
  return [`const g = ${t} as any;`, `g.${prop} = fn;`].join('\n');
}

function declareGlobalVarBlock(name: string): string {
  return [`${DECLARE} ${GLOBAL} {`, `  var ${name}: (sec: number) => void;`, '}'].join('\n');
}

function bareAssign(name: string): string {
  return `${name} = (sec: number) => {};`;
}

function bareRead(name: string): string {
  return `export function jump(sec: number) { ${name}?.(sec); }`;
}

// --- Finding-2 fixture builders (phase-5 review survivors A7-A13) ---

function reflectSetWrite(target: 'window' | 'globalThis', prop: string): string {
  const t = target === 'window' ? W : G;
  return `Reflect.set(${t}, '${prop}', fn);`;
}

function bracketLogicalAssign(prop: string): string {
  return `(${G} as unknown as Record<string, unknown>)['${prop}'] ??= fn;`;
}

function destructuredObjectAssignWrite(prop: string): string {
  return ['const { assign } = Object;', `assign(${W}, { ${prop}: fn });`].join('\n');
}

function aliasSelfDotWrite(prop: string): string {
  return `self.${prop} = fn;`;
}

function aliasTopDotWrite(prop: string): string {
  return `top.${prop} = fn;`;
}

function computedKeyBracketWrite(prop: string): string {
  return [`const key = '${prop}';`, `(${W} as unknown as Record<string, unknown>)[key] = fn;`].join(
    '\n',
  );
}

function multiLineObjectAssignWrite(prop: string): string {
  return ['Object.assign(', `  ${G},`, `  { ${prop}: fn },`, ');'].join('\n');
}

// --- Phase-5 fix wave 2 fixture builders (re-review survivors N1/N2/N3) ---

function ternaryDotWrite(prop: string): string {
  return `(cond ? ${W} : ${G}).${prop} = fn;`;
}

function shortCircuitDotWrite(prop: string): string {
  return `(maybeWindow() || ${W}).${prop} = fn;`;
}

function exportedGlobalAliasAtDeclaration(): string {
  return `export const w = ${W};`;
}

function exportedGlobalAliasSeparateStatement(): string {
  return [`const w = ${G};`, 'export { w };'].join('\n');
}

function exportDefaultGlobalAlias(): string {
  return `export default ${W};`;
}

function writeThroughImportedAlias(prop: string): string {
  return [`import { w } from './a';`, `w.${prop} = fn;`].join('\n');
}

describe('detection predicate (mutation check — proves each detector fires)', () => {
  it('flags a window.<Id> write for a name not on the builtin allowlist', () => {
    const v = scanFileForViolations('probe.ts', windowDotWrite('AutoLogger_scrubToMarker'));
    expect(v.map((x) => x.kind)).toContain('global-dot-write');
  });

  it('does NOT flag a window.<Id> write for an allowlisted platform builtin', () => {
    const v = scanFileForViolations('probe.ts', windowDotWrite('ResizeObserver'));
    expect(v).toEqual([]);
  });

  it('flags bracket access through an inline cast alias', () => {
    const v = scanFileForViolations('probe.ts', bracketWriteViaCastAlias('AutoLogger_x'));
    expect(v.map((x) => x.kind)).toContain('global-bracket-write');
  });

  it(`flags Object.assign(${G}, {...}) and Object.assign(${W}, {...})`, () => {
    expect(
      scanFileForViolations('probe.ts', objectAssignWrite('globalThis', 'AutoLogger_x')).map(
        (x) => x.kind,
      ),
    ).toContain('object-assign');
    expect(
      scanFileForViolations('probe.ts', objectAssignWrite('window', 'AutoLogger_x')).map(
        (x) => x.kind,
      ),
    ).toContain('object-assign');
  });

  it('flags Object.defineProperty(window|globalThis, "<Id>", ...) for a non-builtin name', () => {
    const v = scanFileForViolations('probe.ts', definePropertyWrite('window', 'AutoLogger_x'));
    expect(v.map((x) => x.kind)).toContain('define-property');
  });

  it('flags Object.defineProperties(window|globalThis, {...}) — the multi-property sibling (self-invented attack)', () => {
    expect(
      scanFileForViolations('probe.ts', definePropertiesWrite('window', 'AutoLogger_x')).map(
        (x) => x.kind,
      ),
    ).toContain('object-define-properties');
    expect(
      scanFileForViolations('probe.ts', definePropertiesWrite('globalThis', 'AutoLogger_x')).map(
        (x) => x.kind,
      ),
    ).toContain('object-define-properties');
  });

  it('does NOT flag Object.defineProperty(window, "matchMedia"|"localStorage", ...) (setup.ts shape)', () => {
    expect(scanFileForViolations('probe.ts', definePropertyWrite('window', 'matchMedia'))).toEqual(
      [],
    );
    expect(
      scanFileForViolations('probe.ts', definePropertyWrite('window', 'localStorage')),
    ).toEqual([]);
  });

  it('flags a write through a locally aliased window/globalThis reference', () => {
    const v = scanFileForViolations('probe.ts', aliasedGlobalWrite('globalThis', 'AutoLogger_x'));
    // Unlike the old regex scanner (a distinct 'aliased-global-write' kind
    // for the alias path only), the AST scanner resolves the alias into the
    // SAME global-ref check the direct-name path uses, so an aliased write
    // reports the ordinary 'global-dot-write' kind — one code path, not two
    // that must be kept in sync.
    expect(v.map((x) => x.kind)).toContain('global-dot-write');
  });

  it('does NOT flag a read-only alias (no assignment through it) — e.g. useWaveforms.ts / stitch.ts shape', () => {
    const content = [
      `const w = ${G} as typeof ${G} & { AudioContext?: unknown };`,
      'const ctor = w.AudioContext;',
    ].join('\n');
    expect(scanFileForViolations('probe.ts', content)).toEqual([]);
  });

  it('flags any declare-global block, regardless of contents', () => {
    const v = scanFileForViolations('probe.ts', declareGlobalVarBlock('AutoLogger_seekAudio'));
    expect(v.map((x) => x.kind)).toContain('declare-global');
  });

  it('does NOT flag a bare AutoLogger_-prefixed asset import (shape, not prefix)', () => {
    const content = "import src from '../../assets/video/AutoLogger_Small.webm';\n";
    expect(scanFileForViolations('probe.ts', content)).toEqual([]);
  });

  it('does NOT flag a real local variable merely named `top` or `self` (Timeline.tsx tooltip-positioning shape)', () => {
    const content = ['let top = clientY - th - 12;', 'top = Math.min(pad, top);'].join('\n');
    expect(scanFileForViolations('probe.ts', content)).toEqual([]);
  });

  // --- Finding 2 (phase-5 review): the seven regex survivors, unit-level ---

  it('A7: flags Reflect.set(window, "<Id>", fn), direct spelling', () => {
    const v = scanFileForViolations('probe.ts', reflectSetWrite('window', 'AutoLogger_x'));
    expect(v.map((x) => x.kind)).toContain('reflect-set');
  });

  it('A7b: flags Reflect.set via a destructured `const { set } = Reflect;` alias', () => {
    const content = ['const { set } = Reflect;', `set(${W}, 'AutoLogger_x', fn);`].join('\n');
    expect(scanFileForViolations('probe.ts', content).map((x) => x.kind)).toContain('reflect-set');
  });

  it('does NOT flag Reflect.set(window, "matchMedia", ...) (builtin allowlist applies)', () => {
    expect(scanFileForViolations('probe.ts', reflectSetWrite('window', 'matchMedia'))).toEqual([]);
  });

  it("A8: flags a logical-assignment bracket write, (globalThis as ...)['X'] ??= fn", () => {
    const v = scanFileForViolations('probe.ts', bracketLogicalAssign('AutoLogger_x'));
    expect(v.map((x) => x.kind)).toContain('global-bracket-write');
  });

  it('A9: flags a destructured `const { assign } = Object; assign(window, {...})`', () => {
    const v = scanFileForViolations('probe.ts', destructuredObjectAssignWrite('AutoLogger_x'));
    expect(v.map((x) => x.kind)).toContain('object-assign');
  });

  it('A11: flags self.<Id> = fn and top.<Id> = fn', () => {
    expect(
      scanFileForViolations('probe.ts', aliasSelfDotWrite('AutoLogger_x')).map((x) => x.kind),
    ).toContain('global-dot-write');
    expect(
      scanFileForViolations('probe.ts', aliasTopDotWrite('AutoLogger_x')).map((x) => x.kind),
    ).toContain('global-dot-write');
  });

  it('A12: flags a computed (variable) bracket key write, (window as ...)[key] = fn', () => {
    const v = scanFileForViolations('probe.ts', computedKeyBracketWrite('AutoLogger_x'));
    expect(v.map((x) => x.kind)).toContain('global-computed-write');
  });

  it('A13: flags a multi-line Object.assign(\\n  window,\\n  {...},\\n);', () => {
    const v = scanFileForViolations('probe.ts', multiLineObjectAssignWrite('AutoLogger_x'));
    expect(v.map((x) => x.kind)).toContain('object-assign');
  });

  // --- Finding N1/N2/N3 (phase-5 fix re-review): the three new survivors ---

  it('N2: flags a ternary-selected write target, (cond ? window : globalThis).X = fn', () => {
    const v = scanFileForViolations('probe.ts', ternaryDotWrite('AutoLogger_x'));
    expect(v.map((x) => x.kind)).toContain('global-dot-write');
  });

  it('N3: flags a short-circuit-selected write target, (maybeWindow() || window).X = fn', () => {
    const v = scanFileForViolations('probe.ts', shortCircuitDotWrite('AutoLogger_x'));
    expect(v.map((x) => x.kind)).toContain('global-dot-write');
  });

  it('does NOT flag a ternary/short-circuit expression where NEITHER branch resolves to a global', () => {
    const content = '(cond ? a : b).AutoLogger_x = fn;';
    expect(scanFileForViolations('probe.ts', content)).toEqual([]);
  });

  it('N1: flags `export const w = window;` at its declaration site', () => {
    const v = scanFileForViolations('probe.ts', exportedGlobalAliasAtDeclaration());
    expect(v.map((x) => x.kind)).toContain('global-alias-export');
  });

  it('N1: flags `const w = globalThis; export { w };` (separate export statement)', () => {
    const v = scanFileForViolations('probe.ts', exportedGlobalAliasSeparateStatement());
    expect(v.map((x) => x.kind)).toContain('global-alias-export');
  });

  it('N1: flags `export default window;`', () => {
    const v = scanFileForViolations('probe.ts', exportDefaultGlobalAlias());
    expect(v.map((x) => x.kind)).toContain('global-alias-export');
  });

  it('does NOT flag an ordinary exported value unrelated to any global', () => {
    const content = 'export const count = 1;\nexport { count as alsoCount };';
    expect(scanFileForViolations('probe.ts', content)).toEqual([]);
  });

  it('does NOT flag a write through an IMPORTED alias by itself — the export at its own declaration is what is flagged (N1 fix closes the hole at its source, not by cross-file resolution)', () => {
    // The importing file alone has no local VariableDeclaration for `w` to
    // resolve as a global alias (it is bound via an ImportSpecifier), so
    // this file in isolation reports zero violations — the exporting file
    // (see the N1 tree-level test below) is where the violation fires.
    const v = scanFileForViolations('consumer.ts', writeThroughImportedAlias('AutoLogger_x'));
    expect(v).toEqual([]);
  });
});

describe('scanTree — end-to-end mutation check on a real filesystem walk', () => {
  let tmpRoot: string;

  afterEach(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function freshRoot(prefix: string): string {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    return tmpRoot;
  }

  // --- The six design-D8 mutations, run individually ---

  it('D8 mutation 1: an ambient global var block + bare-identifier assignment', () => {
    const root = freshRoot('coord-ban-mut1-');
    fs.writeFileSync(
      path.join(root, 'bus.ts'),
      [declareGlobalVarBlock('AutoLogger_seekAudio'), bareAssign('AutoLogger_seekAudio')].join(
        '\n',
      ),
    );
    const { violations } = scanTree(root);
    expect(violations.some((v) => v.kind === 'declare-global')).toBe(true);
  });

  it('D8 mutation 2: bare-identifier READ of a name declared global elsewhere in the tree', () => {
    const root = freshRoot('coord-ban-mut2-');
    fs.mkdirSync(path.join(root, 'a'));
    fs.mkdirSync(path.join(root, 'b'));
    fs.writeFileSync(
      path.join(root, 'a', 'declare.ts'),
      declareGlobalVarBlock('AutoLogger_seekAudio'),
    );
    fs.writeFileSync(path.join(root, 'b', 'consumer.ts'), bareRead('AutoLogger_seekAudio'));
    const { violations } = scanTree(root);
    expect(violations.some((v) => v.file === 'a/declare.ts' && v.kind === 'declare-global')).toBe(
      true,
    );
    expect(
      violations.some((v) => v.file === 'b/consumer.ts' && v.kind === 'ambient-bare-identifier'),
    ).toBe(true);
  });

  it(`D8 mutation 3: bracket access through a cast alias — (${W} as unknown as Record<string, unknown>)['X'] = fn`, () => {
    const root = freshRoot('coord-ban-mut3-');
    fs.writeFileSync(path.join(root, 'bus.ts'), bracketWriteViaCastAlias('AutoLogger_x'));
    const { violations } = scanTree(root);
    expect(violations.some((v) => v.kind === 'global-bracket-write')).toBe(true);
  });

  it(`D8 mutation 4: Object.assign(${G}, { X: fn })`, () => {
    const root = freshRoot('coord-ban-mut4-');
    fs.writeFileSync(path.join(root, 'bus.ts'), objectAssignWrite('globalThis', 'AutoLogger_x'));
    const { violations } = scanTree(root);
    expect(violations.some((v) => v.kind === 'object-assign')).toBe(true);
  });

  it(`D8 mutation 5: const g = ${G} as any; then a write through g (aliased globalThis)`, () => {
    const root = freshRoot('coord-ban-mut5-');
    fs.writeFileSync(path.join(root, 'bus.ts'), aliasedGlobalWrite('globalThis', 'AutoLogger_x'));
    const { violations } = scanTree(root);
    expect(violations.some((v) => v.kind === 'global-dot-write')).toBe(true);
  });

  it('D8 mutation 6: window.<BrandNewEleventhName> = fn — the check is name-blind', () => {
    const root = freshRoot('coord-ban-mut6-');
    fs.writeFileSync(path.join(root, 'bus.ts'), windowDotWrite('AutoLogger_scrubToMarker'));
    const { violations } = scanTree(root);
    expect(violations.some((v) => v.kind === 'global-dot-write')).toBe(true);
  });

  // --- Finding 2 (phase-5 review): the seven regex survivors, tree-level ---

  it('A7: Reflect.set(window, "X", fn) fires at tree level', () => {
    const root = freshRoot('coord-ban-a7-');
    fs.writeFileSync(path.join(root, 'bus.ts'), reflectSetWrite('window', 'AutoLogger_x'));
    const { violations } = scanTree(root);
    expect(violations.some((v) => v.kind === 'reflect-set')).toBe(true);
  });

  it("A8: (globalThis as ...)['X'] ??= fn fires at tree level", () => {
    const root = freshRoot('coord-ban-a8-');
    fs.writeFileSync(path.join(root, 'bus.ts'), bracketLogicalAssign('AutoLogger_x'));
    const { violations } = scanTree(root);
    expect(violations.some((v) => v.kind === 'global-bracket-write')).toBe(true);
  });

  it('A9: destructured `const { assign } = Object;` write fires at tree level', () => {
    const root = freshRoot('coord-ban-a9-');
    fs.writeFileSync(path.join(root, 'bus.ts'), destructuredObjectAssignWrite('AutoLogger_x'));
    const { violations } = scanTree(root);
    expect(violations.some((v) => v.kind === 'object-assign')).toBe(true);
  });

  it('A10: the same window.<Id> write in a .mts file fires (walk now includes .mts/.cts)', () => {
    const root = freshRoot('coord-ban-a10-');
    fs.writeFileSync(path.join(root, 'bus.mts'), windowDotWrite('AutoLogger_x'));
    const { violations, filesExamined } = scanTree(root);
    expect(filesExamined).toBe(1);
    expect(violations.some((v) => v.file === 'bus.mts' && v.kind === 'global-dot-write')).toBe(
      true,
    );
  });

  it('A10b: a .cts file is also walked', () => {
    const root = freshRoot('coord-ban-a10b-');
    fs.writeFileSync(path.join(root, 'bus.cts'), windowDotWrite('AutoLogger_x'));
    const { violations } = scanTree(root);
    expect(violations.some((v) => v.file === 'bus.cts' && v.kind === 'global-dot-write')).toBe(
      true,
    );
  });

  it('A11: self.<Id> = fn and top.<Id> = fn fire at tree level', () => {
    const root = freshRoot('coord-ban-a11-');
    fs.writeFileSync(
      path.join(root, 'bus.ts'),
      [aliasSelfDotWrite('AutoLogger_x'), aliasTopDotWrite('AutoLogger_y')].join('\n'),
    );
    const { violations } = scanTree(root);
    expect(violations.filter((v) => v.kind === 'global-dot-write').length).toBe(2);
  });

  it('A12: a computed bracket key write fires at tree level', () => {
    const root = freshRoot('coord-ban-a12-');
    fs.writeFileSync(path.join(root, 'bus.ts'), computedKeyBracketWrite('AutoLogger_x'));
    const { violations } = scanTree(root);
    expect(violations.some((v) => v.kind === 'global-computed-write')).toBe(true);
  });

  it('A13: a multi-line Object.assign(...) call fires at tree level', () => {
    const root = freshRoot('coord-ban-a13-');
    fs.writeFileSync(path.join(root, 'bus.ts'), multiLineObjectAssignWrite('AutoLogger_x'));
    const { violations } = scanTree(root);
    expect(violations.some((v) => v.kind === 'object-assign')).toBe(true);
  });

  // --- Finding N1/N2/N3 (phase-5 fix re-review), tree-level ---

  it('N2: a ternary-selected write target fires at tree level', () => {
    const root = freshRoot('coord-ban-n2-');
    fs.writeFileSync(path.join(root, 'bus.ts'), ternaryDotWrite('AutoLogger_x'));
    const { violations } = scanTree(root);
    expect(violations.some((v) => v.kind === 'global-dot-write')).toBe(true);
  });

  it('N3: a short-circuit-selected write target fires at tree level', () => {
    const root = freshRoot('coord-ban-n3-');
    fs.writeFileSync(path.join(root, 'bus.ts'), shortCircuitDotWrite('AutoLogger_x'));
    const { violations } = scanTree(root);
    expect(violations.some((v) => v.kind === 'global-dot-write')).toBe(true);
  });

  it('N1: the EXPORTING file is where the violation fires, even though the write happens in an importing file (closes the cross-file hole at its source)', () => {
    const root = freshRoot('coord-ban-n1-');
    fs.writeFileSync(path.join(root, 'a.ts'), exportedGlobalAliasAtDeclaration());
    fs.writeFileSync(path.join(root, 'consumer.ts'), writeThroughImportedAlias('AutoLogger_x'));
    const { violations } = scanTree(root);
    expect(violations.some((v) => v.file === 'a.ts' && v.kind === 'global-alias-export')).toBe(
      true,
    );
  });

  it('self-invented attack: Object.defineProperties(window, {...}) fires at tree level', () => {
    const root = freshRoot('coord-ban-defineprops-');
    fs.writeFileSync(path.join(root, 'bus.ts'), definePropertiesWrite('window', 'AutoLogger_x'));
    const { violations } = scanTree(root);
    expect(violations.some((v) => v.kind === 'object-define-properties')).toBe(true);
  });

  // --- Conforming fixture: proves the guard does not always-fire ---

  it('reports zero violations on a conforming fixture (builtin writes + an AutoLogger_-named asset import)', () => {
    const root = freshRoot('coord-ban-clean-');
    fs.writeFileSync(
      path.join(root, 'setup.ts'),
      [windowDotWrite('ResizeObserver'), definePropertyWrite('window', 'matchMedia')].join('\n'),
    );
    fs.writeFileSync(
      path.join(root, 'loadingVideo.ts'),
      "import src from '../../assets/video/AutoLogger_Small.webm';\nexport default src;\n",
    );
    const { violations, filesExamined } = scanTree(root);
    expect(filesExamined).toBe(2);
    expect(violations).toEqual([]);
  });

  it('a wrong root yields zero examined files rather than a silent pass (walk() swallows readdirSync errors)', () => {
    const { violations, filesExamined } = scanTree(
      path.join(os.tmpdir(), 'coord-ban-does-not-exist'),
    );
    expect(filesExamined).toBe(0);
    expect(violations).toEqual([]);
  });
});

const here = path.dirname(fileURLToPath(import.meta.url));
// this file: web/src/windowCoordinationBan.repo.test.ts -> the scan root is web/src itself.
const WEB_SRC = here;

describe('web/src AST-based guard — no declare-global Window augmentation, no non-builtin global write', () => {
  it('examines a non-zero number of files (proves the root resolved to the real tree)', () => {
    const { filesExamined } = scanTree(WEB_SRC);
    expect(filesExamined).toBeGreaterThan(0);
  });

  it('contains ZERO declare-global blocks and ZERO non-builtin global-object writes', () => {
    const { violations } = scanTree(WEB_SRC);
    expect(violations).toEqual([]);
  });

  it('the loadingVideo.ts AutoLogger_Small.webm asset import specifically produces no violation', () => {
    const rel = 'shared/utils/loadingVideo.ts';
    const content = fs.readFileSync(path.join(WEB_SRC, rel), 'utf8');
    expect(scanFileForViolations(rel, content)).toEqual([]);
  });

  it('the real Timeline.tsx `top` local variable specifically produces no violation (base-name/local-shadow disambiguation)', () => {
    const rel = 'pages/index/components/Timeline.tsx';
    const content = fs.readFileSync(path.join(WEB_SRC, rel), 'utf8');
    expect(scanFileForViolations(rel, content)).toEqual([]);
  });
});
