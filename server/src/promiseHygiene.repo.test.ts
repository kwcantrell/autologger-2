// Promise hygiene (async-session-callers D3; core-ports-architecture "Server code never drops or
// misuses a promise"): server production code consumes every promise. A Promise-typed expression
// statement must be awaited, voided, returned or given a rejection handler; a promise must never
// be a condition, a `!` operand, a template value or a `c.json(...)` field. Biome's
// noFloatingPromises misses calls through `@autologger/ports` interfaces and `!promise`, so this
// uses the TypeScript type checker over the real program.
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
        for (const arg of node.arguments) {
          if (!ts.isObjectLiteralExpression(arg)) continue;
          for (const p of arg.properties) {
            if (ts.isPropertyAssignment(p) && promiseAt(p.initializer)) {
              report(p.initializer, 'promise serialised into a response');
            }
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
declare const c: { json(o: object): unknown; env: { ports: { kv: Kv } } };
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
