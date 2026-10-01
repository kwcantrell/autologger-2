// Promise hygiene (async-session-callers D3, async-catalog-callers D4; core-ports-architecture
// "Server code never drops or misuses a promise"): server production code consumes every promise.
// A Promise-typed expression statement must be awaited, voided, returned or given a rejection
// handler; a promise must never be a condition, a `!` operand, a comparison operand, a template
// value or a `c.json(...)` body or field; and an async function must never go where a callback
// returning no value is expected. Biome's noFloatingPromises misses calls through
// `@autologger/ports` interfaces and `!promise`, so this uses the TypeScript type checker over the
// real program.
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SERVER = join(__dirname, '..');

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

const PRELUDE = `
interface Kv { put(k: string, v: string): Promise<void>; get(k: string): Promise<string | null> }
interface Presence { list(): Promise<string[]> }
declare const kv: Kv;
declare const c: { json(o: unknown): unknown; env: { ports: { kv: Kv } } };
declare function each(f: (x: string) => void): void;
declare function inTx(mutate: (k: Kv) => undefined): void;
async function requireSession(id: string): Promise<{ id: string }> { return { id }; }
async function canView(id: string): Promise<boolean> { return id !== ''; }
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

  it('server production code drops and misuses no promise', () => {
    const parsed = ts.getParsedCommandLineOfConfigFile(
      join(SERVER, 'tsconfig.json'),
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (d) => {
          throw new Error(String(d.messageText));
        },
      },
    );
    if (!parsed) throw new Error('server/tsconfig.json did not parse');
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    const files = program
      .getSourceFiles()
      .filter(
        (sf) =>
          sf.fileName.startsWith(join(SERVER, 'src')) &&
          !/\.test\.ts$/.test(sf.fileName) &&
          !sf.fileName.includes('/src/test/'),
      );
    expect(files.length).toBeGreaterThan(30);
    expect(findPromiseMisuse(program, files)).toEqual([]);
  }, 120_000);
});
