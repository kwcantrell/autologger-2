// Promise hygiene (async-session-callers D3, async-catalog-callers D4; core-ports-architecture
// "Server code never drops or misuses a promise"): server production code consumes every promise.
// A Promise-typed expression statement must be awaited, voided, returned or given a rejection
// handler; a promise must never be a condition, a `!` operand, a comparison operand, a template
// value or a `c.json(...)` body or field; an async function must never go where a callback
// returning no value is expected; and an async function must not return an un-awaited promise from
// inside a `try` (typescript-eslint `return-await` "in-try-catch"). The scan covers
// `packages/catalog/src`, and since async-session-hub D9 `packages/session-core`, `log-import`,
// `transcription` and `ai-runtime` too; test files, the session-core tests included, may not pass
// a promise to `expect()` (async-catalog-stores D6). Biome's noFloatingPromises misses calls through
// `@autologger/ports` interfaces and `!promise`, so this uses the TypeScript type checker over the
// real program.
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SERVER = join(__dirname, '..');
const PACKAGES = join(SERVER, '..', 'packages');
const CATALOG_SRC = join(PACKAGES, 'catalog', 'src');
/** Production roots beside `server/src` (async-catalog-stores D6; async-session-hub D9). */
const PACKAGE_ROOTS = [
  CATALOG_SRC,
  ...['session-core', 'log-import', 'transcription', 'ai-runtime'].map((p) =>
    join(PACKAGES, p, 'src'),
  ),
];
/** Files the production scan must reach, one or more per package root (async-session-hub D9). */
const KEY_PACKAGE_FILES = [
  'session-core/src/SessionHub.ts',
  'session-core/src/sessionCore.ts',
  'log-import/src/runSessionLogImport.ts',
  'transcription/src/generateTranscript.ts',
  'ai-runtime/src/aiMcpServer.ts',
];

function isPromiseLike(checker: ts.TypeChecker, type: ts.Type): boolean {
  if (type.isUnion()) return type.types.some((t) => isPromiseLike(checker, t));
  const then = type.getProperty('then');
  if (!then) return false;
  const thenType = checker.getTypeOfSymbol(then);
  return thenType.getCallSignatures().length > 0;
}

const strip = (e: ts.Expression): ts.Expression => {
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x))
    x = x.expression;
  return x;
};

/** A `.catch(h)` or `.then(f, h)` statement handles rejection, so it consumes the promise. */
function handlesRejection(e: ts.Expression): boolean {
  if (!ts.isCallExpression(e) || !ts.isPropertyAccessExpression(e.expression)) return false;
  const name = e.expression.name.text;
  return (
    (name === 'catch' && e.arguments.length >= 1) || (name === 'then' && e.arguments.length >= 2)
  );
}

/** A `return` inside a `try` block (or a `catch` with a `finally`) of an async function: an
 * un-awaited promise returned there settles after the `catch`/`finally` ran (typescript-eslint
 * `return-await` "in-try-catch"; async-session-hub D9). */
function returnsFromTryInAsync(node: ts.ReturnStatement): boolean {
  let inTry = false;
  let child: ts.Node = node;
  for (let p = node.parent; p; child = p, p = p.parent) {
    if (ts.isTryStatement(p)) {
      if (child === p.tryBlock || (child === p.catchClause && p.finallyBlock)) inTry = true;
    } else if (ts.isFunctionLike(p)) {
      const isAsync =
        (ts.getCombinedModifierFlags(p as ts.Declaration) & ts.ModifierFlags.Async) !== 0;
      return inTry && isAsync;
    }
  }
  return false;
}

const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

function findPromiseMisuse(program: ts.Program, files: readonly ts.SourceFile[]): string[] {
  const checker = program.getTypeChecker();
  const out = new Set<string>();
  for (const sf of files) {
    const promiseAt = (e: ts.Expression) => isPromiseLike(checker, checker.getTypeAtLocation(e));
    const report = (node: ts.Node, what: string) => {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      out.add(`${relative(SERVER, sf.fileName)}:${line + 1} ${what}`);
    };
    const checkCondition = (e: ts.Expression): void => {
      const x = strip(e);
      if (ts.isPrefixUnaryExpression(x) && x.operator === ts.SyntaxKind.ExclamationToken) {
        checkCondition(x.operand);
      } else if (
        ts.isBinaryExpression(x) &&
        (x.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          x.operatorToken.kind === ts.SyntaxKind.BarBarToken)
      ) {
        checkCondition(x.left);
        checkCondition(x.right);
      } else if (promiseAt(x)) {
        report(x, 'promise used as a condition');
      }
    };
    const checkResponseValue = (e: ts.Expression): void => {
      const x = strip(e);
      if (!ts.isObjectLiteralExpression(x)) {
        if (promiseAt(x)) report(x, 'promise serialised into a response');
        return;
      }
      for (const p of x.properties) {
        if (ts.isPropertyAssignment(p)) checkResponseValue(p.initializer);
        else if (ts.isShorthandPropertyAssignment(p) && promiseAt(p.name))
          report(p.name, 'promise serialised into a response');
        else if (ts.isSpreadAssignment(p)) checkResponseValue(p.expression);
      }
    };
    /** The argument's contextual type is a function whose every signature returns void/undefined. */
    const expectsNoValue = (arg: ts.Expression): boolean => {
      const ctx = checker.getContextualType(arg);
      if (!ctx) return false;
      const sigs = checker.getNonNullableType(ctx).getCallSignatures();
      return (
        sigs.length > 0 &&
        sigs.every((sig) => {
          const ret = checker.getReturnTypeOfSignature(sig);
          return (ret.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) !== 0;
        })
      );
    };
    const returnsPromise = (type: ts.Type): boolean =>
      type
        .getCallSignatures()
        .some((sig) => isPromiseLike(checker, checker.getReturnTypeOfSignature(sig)));
    const visit = (node: ts.Node): void => {
      if (ts.isExpressionStatement(node)) {
        const e = strip(node.expression);
        const consumed =
          ts.isAwaitExpression(e) ||
          ts.isVoidExpression(e) ||
          (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) ||
          handlesRejection(e);
        if (!consumed && promiseAt(e)) report(e, 'dropped promise');
      } else if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) {
        checkCondition(node.expression);
      } else if (ts.isForStatement(node) && node.condition) {
        checkCondition(node.condition);
      } else if (ts.isConditionalExpression(node)) {
        checkCondition(node.condition);
      } else if (
        ts.isPrefixUnaryExpression(node) &&
        node.operator === ts.SyntaxKind.ExclamationToken
      ) {
        checkCondition(node.operand);
      } else if (
        ts.isReturnStatement(node) &&
        node.expression &&
        !ts.isAwaitExpression(strip(node.expression)) &&
        promiseAt(strip(node.expression)) &&
        returnsFromTryInAsync(node)
      ) {
        report(node.expression, 'un-awaited return inside try');
      } else if (ts.isTemplateSpan(node) && promiseAt(node.expression)) {
        report(node.expression, 'promise in a template');
      } else if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'json'
      ) {
        for (const arg of node.arguments) checkResponseValue(arg);
      } else if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind)) {
        for (const side of [node.left, node.right]) {
          if (promiseAt(strip(side))) report(side, 'promise used in a comparison');
        }
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        for (const arg of node.arguments ?? []) {
          if (returnsPromise(checker.getTypeAtLocation(arg)) && expectsNoValue(arg)) {
            report(arg, 'async callback where no value is expected');
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return [...out];
}

/** `expect(x)` where `x` is promise-like, unless the chain continues with `.resolves`/`.rejects`
 * or asserts `.toBeInstanceOf(Promise)` (async-catalog-stores D6): a missed `await` on a catalog read would otherwise make
 * `expect(row).not.toBeNull()` pass vacuously. */
function findUnawaitedExpect(program: ts.Program, files: readonly ts.SourceFile[]): string[] {
  const checker = program.getTypeChecker();
  const out = new Set<string>();
  for (const sf of files) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'expect' &&
        node.arguments.length > 0 &&
        isPromiseLike(checker, checker.getTypeAtLocation(node.arguments[0]))
      ) {
        const parent = node.parent;
        const member =
          ts.isPropertyAccessExpression(parent) && parent.expression === node ? parent : null;
        const isPromiseCheck =
          member?.name.text === 'toBeInstanceOf' &&
          ts.isCallExpression(member.parent) &&
          member.parent.arguments.length === 1 &&
          ts.isIdentifier(member.parent.arguments[0]) &&
          member.parent.arguments[0].text === 'Promise';
        const chained =
          member?.name.text === 'resolves' || member?.name.text === 'rejects' || isPromiseCheck;
        if (!chained) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          out.add(`${relative(SERVER, sf.fileName)}:${line + 1} promise passed to expect()`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return [...out];
}

function fixtureProgram(source: string): { program: ts.Program; file: ts.SourceFile } {
  const name = join(SERVER, 'src/__fixture.ts');
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    lib: ['lib.es2022.d.ts'],
    strict: true,
    noEmit: true,
  };
  const host = ts.createCompilerHost(options);
  const orig = host.getSourceFile.bind(host);
  host.getSourceFile = (f, v) =>
    f === name ? ts.createSourceFile(f, source, v, true) : orig(f, v);
  const program = ts.createProgram([name], options, host);
  const file = program.getSourceFile(name);
  if (!file) throw new Error('fixture not loaded');
  return { program, file };
}

function programFor(tsconfig: string): ts.Program {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    tsconfig,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(String(d.messageText));
      },
    },
  );
  if (!parsed) throw new Error(`${tsconfig} did not parse`);
  return ts.createProgram(parsed.fileNames, parsed.options);
}

const isTest = (f: string) => /\.test\.ts$/.test(f) || f.includes('/src/test/');

const PRELUDE = `
interface Kv { put(k: string, v: string): Promise<void>; get(k: string): Promise<string | null> }
interface Presence { list(): Promise<string[]> }
declare const kv: Kv;
declare const c: { json(o: unknown): unknown; env: { ports: { kv: Kv } } };
declare function each(f: (x: string) => void): void;
declare function inTx(mutate: (k: Kv) => undefined): void;
async function requireSession(id: string): Promise<{ id: string }> { return { id }; }
async function canView(id: string): Promise<boolean> { return id !== ''; }
declare function expect(x: unknown): { resolves: { toBe(v: unknown): Promise<void> }; rejects: { toThrow(): Promise<void> }; toBe(v: unknown): void; toEqual(v: unknown): void; toBeInstanceOf(c: unknown): void; not: { toBeNull(): void } };
interface Hub { addEvent(input: { message: string }): Promise<{ id: string }>; claimLease(id: string): Promise<boolean>; listTopics(): Promise<string[]>; replaceTranscriptWords(w: string[]): Promise<void> }
declare const hub: Hub;
declare const lock: { release(): void };
`;

describe('promise hygiene', () => {
  it.each([
    [
      'a dropped gate call',
      'export async function h() { requireSession("s"); }',
      'dropped promise',
    ],
    [
      'a dropped aliased presence.list()',
      'export async function h(presence: Presence) { presence.list(); }',
      'dropped promise',
    ],
    [
      'a dropped port-interface call',
      'export async function h() { c.env.ports.kv.put("a", "b"); }',
      'dropped promise',
    ],
    [
      '!asyncFn()',
      'export async function h() { if (!canView("x")) return 1; return 2; }',
      'condition',
    ],
    [
      'a promise as a ternary condition',
      'export function h() { return canView("x") ? 1 : 2; }',
      'condition',
    ],
    [
      'a promise in c.json',
      'export function h() { return c.json({ t: kv.get("k") }); }',
      'response',
    ],
    [
      'a promise as the whole c.json body',
      'export function h() { return c.json(kv.get("k")); }',
      'response',
    ],
    [
      'a promise as a shorthand c.json field',
      'export function h() { const members = kv.get("k"); return c.json({ members }); }',
      'response',
    ],
    [
      'a promise spread into c.json',
      'export function h() { const s = requireSession("s"); return c.json({ ...s }); }',
      'response',
    ],
    [
      'a promise compared with === null',
      'export function h() { const r = kv.get("k") === null; return r; }',
      'comparison',
    ],
    [
      'a promise compared with !=',
      'export function h() { const r = null != kv.get("k"); return r; }',
      'comparison',
    ],
    [
      'an async arrow where a void callback is expected',
      'export function h() { each(async (x) => { await kv.put(x, x); }); }',
      'async callback',
    ],
    [
      'a named async function where a void callback is expected',
      'async function m(x: string) { await kv.put(x, x); } export function h() { each(m); }',
      'async callback',
    ],
    // async-session-hub D9: the same checks fire through the session hub facade.
    [
      'a dropped hub.addEvent(…)',
      'export async function h() { hub.addEvent({ message: "m" }); }',
      'dropped promise',
    ],
    [
      'if (!hub.claimLease(id))',
      'export async function h(id: string) { if (!hub.claimLease(id)) return 1; return 2; }',
      'condition',
    ],
    [
      'c.json({ topics: hub.listTopics() })',
      'export function h() { return c.json({ topics: hub.listTopics() }); }',
      'response',
    ],
    [
      'an un-awaited return inside try/finally',
      'export async function h(w: string[]) { try { return hub.replaceTranscriptWords(w); } finally { lock.release(); } }',
      'un-awaited return inside try',
    ],
    [
      'an un-awaited return inside try/catch',
      'export async function h() { try { return hub.listTopics(); } catch { return []; } }',
      'un-awaited return inside try',
    ],
  ])('flags %s', (_name, body, what) => {
    const { program, file } = fixtureProgram(PRELUDE + body);
    const found = findPromiseMisuse(program, [file]);
    expect(found.length, found.join('\n')).toBe(1);
    expect(found[0]).toContain(what);
  });

  it('accepts consumed promises', () => {
    const { program, file } = fixtureProgram(
      `${PRELUDE}
export async function h() {
  await requireSession('s');
  void kv.put('a', 'b');
  kv.put('a', 'b').catch(() => {});
  const p = kv.get('k');
  if (await canView('x')) await p;
  if ((await kv.get('k')) === null) return null;
  each((x) => {
    void kv.put(x, x);
  });
  inTx((k) => {
    void k;
    return undefined;
  });
  c.json(await kv.get('k'));
  const members = await kv.get('k');
  c.json({ members, ...(await requireSession('s')) });
  return kv.get('k');
}`,
    );
    expect(findPromiseMisuse(program, [file])).toEqual([]);
  });

  it('flags expect(promise) and accepts awaited, .resolves and .rejects', () => {
    const bad = fixtureProgram(
      `${PRELUDE}export async function t() { const row = kv.get('k'); expect(row).not.toBeNull(); }`,
    );
    const found = findUnawaitedExpect(bad.program, [bad.file]);
    expect(found.length, found.join('\n')).toBe(1);
    expect(found[0]).toContain('promise passed to expect()');
    const good = fixtureProgram(
      `${PRELUDE}export async function t() {
  expect(await kv.get('k')).toBe(null);
  await expect(kv.get('k')).resolves.toBe(null);
  await expect(kv.put('a', 'b')).rejects.toThrow();
  expect(kv.get('k')).toBeInstanceOf(Promise);
}`,
    );
    expect(findUnawaitedExpect(good.program, [good.file])).toEqual([]);
  });

  it('flags expect(hub.listTopics()) in a test (async-session-hub D9)', () => {
    const bad = fixtureProgram(
      `${PRELUDE}export async function t() { expect(hub.listTopics()).toEqual([]); }`,
    );
    const found = findUnawaitedExpect(bad.program, [bad.file]);
    expect(found.length, found.join('\n')).toBe(1);
    expect(found[0]).toContain('promise passed to expect()');
  });

  it('accepts return await inside try, and the wrapper-object memo of a promise (async-session-hub D9)', () => {
    const { program, file } = fixtureProgram(
      `${PRELUDE}
export async function h(w: string[]) {
  try {
    return await hub.replaceTranscriptWords(w);
  } finally {
    lock.release();
  }
}
export async function g() {
  try {
    return await hub.listTopics();
  } catch {
    return [];
  }
}
export class Listener {
  private started: { promise: Promise<void> } | null = null;
  start(): Promise<void> {
    if (this.started) return this.started.promise;
    const started = { promise: kv.put('a', 'b') };
    this.started = started;
    return started.promise;
  }
}
let singleton: { promise: Promise<string | null> } | null = null;
export function getSingleton(): Promise<string | null> {
  if (singleton !== null) return singleton.promise;
  const wrapper: { promise: Promise<string | null> } = { promise: kv.get('k') };
  wrapper.promise = wrapper.promise.catch((err: unknown) => {
    if (singleton === wrapper) singleton = null;
    throw err;
  });
  singleton = wrapper;
  return wrapper.promise;
}
export async function reset(): Promise<void> {
  const w = singleton;
  singleton = null;
  if (w !== null) await w.promise.catch(() => null);
}`,
    );
    expect(findPromiseMisuse(program, [file])).toEqual([]);
  });

  it('server production code drops and misuses no promise', () => {
    const program = programFor(join(SERVER, 'tsconfig.json'));
    const sources = program.getSourceFiles();
    // async-catalog-stores D6: the catalog stores hold most transaction bodies; async-session-hub
    // D9 adds session-core and the packages that call the session hub.
    const files = sources.filter(
      (sf) =>
        [join(SERVER, 'src'), ...PACKAGE_ROOTS].some((root) => sf.fileName.startsWith(root)) &&
        !isTest(sf.fileName),
    );
    expect(files.length).toBeGreaterThan(30);
    expect(files.some((sf) => sf.fileName.startsWith(CATALOG_SRC))).toBe(true);
    // async-session-hub D9: session-core and the hub-calling packages are scanned too; a root
    // that stops being reached fails here.
    const scanned = new Set(files.map((sf) => sf.fileName));
    expect(KEY_PACKAGE_FILES.filter((f) => !scanned.has(join(PACKAGES, f)))).toEqual([]);
    expect(findPromiseMisuse(program, files)).toEqual([]);
    const tests = sources.filter(
      (sf) => sf.fileName.startsWith(join(SERVER, 'src')) && isTest(sf.fileName),
    );
    expect(tests.length).toBeGreaterThan(30);
    // session-tables D12: the DB-backed session tests moved to server/src/test/session/ and are
    // scanned here.
    const moved = tests.filter((sf) => sf.fileName.startsWith(join(SERVER, 'src/test/session/')));
    expect(moved.length).toBeGreaterThanOrEqual(10);
    expect(findUnawaitedExpect(program, tests)).toEqual([]);
    // The server program reaches no package test, so session-core's tests get their own program.
    const core = programFor(join(PACKAGES, 'session-core', 'tsconfig.json'));
    const coreTests = core
      .getSourceFiles()
      .filter(
        (sf) =>
          sf.fileName.startsWith(join(PACKAGES, 'session-core', 'src')) && isTest(sf.fileName),
      );
    // session-tables D12: only the pure session-core tests stay in the package.
    expect(coreTests.length).toBeGreaterThanOrEqual(1);
    expect(findUnawaitedExpect(core, coreTests)).toEqual([]);
  }, 120_000);
});
