// AI SDK safety rules (ai-sdk-agent-harness design D3, D5; ai-topics-chat "Model requests on the AI
// SDK route are guarded"). A syntax scan of the production sources in `packages/ai-runtime/src` and
// the AI routers (`server/src/routers/{ai,transcribe,events}.ts`). It fails when one of them:
//
// 1. passes a string as the model to `streamText` / `generateText` (`streamObject`,
//    `generateObject` too): a string id resolves through the AI SDK gateway, a default provider
//    the guarded fetch never sees (A15);
// 2. imports `@ai-sdk/gateway`, statically, dynamically or through `require`;
// 3. passes an error to a log sink (`console.*`, `process.stdout.write`, `process.stderr.write`;
//    the server has no other logger) when it is an AI SDK export (any identifier imported from `ai`
//    or `@ai-sdk/*`), or, in a file that imports `ai` or `@ai-sdk/*` (the SDK turn code), any value
//    bound by a `catch` clause, a `.catch(...)` callback or an `onError` callback. An AI SDK error
//    carries the whole prompt and the provider's body (A5);
// 4. calls `streamText` without an `onError` property in an object-literal argument: without it the
//    SDK prints the provider body to stderr itself (A31).
//
// It is a syntax scan, so it cannot see through a variable holding a string model id or an options
// object built elsewhere: rule 1 sees only literal model values, and rule 4 needs the options inline.
// `sdkTurn.ts` (task 6.3) is written to that shape. The scanner's own cases below pin each rule.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const PKG_SRC = __dirname;
const REPO = join(PKG_SRC, '..', '..', '..');
const ROUTERS = ['ai.ts', 'transcribe.ts', 'events.ts'].map((f) =>
  join(REPO, 'server', 'src', 'routers', f),
);

const MODEL_CALLS = new Set(['streamText', 'generateText', 'streamObject', 'generateObject']);
const SDK_MODULE = /^(ai|ai\/.*|@ai-sdk\/.*)$/;
const GATEWAY_MODULE = /^@ai-sdk\/gateway(\/.*)?$/;

function productionFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (
        /\.(ts|tsx|mts)$/.test(e.name) &&
        !/\.test\.tsx?$/.test(e.name) &&
        !e.name.endsWith('.d.ts')
      )
        out.push(p);
    }
  };
  walk(PKG_SRC);
  return [...out, ...ROUTERS];
}

const calleeName = (e: ts.Expression): string | null =>
  ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null;

function isLogSink(e: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(e)) return false;
  const target = e.expression;
  if (ts.isIdentifier(target) && target.text === 'console') return true;
  return (
    e.name.text === 'write' &&
    ts.isPropertyAccessExpression(target) &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === 'process' &&
    (target.name.text === 'stdout' || target.name.text === 'stderr')
  );
}

const bindingNames = (n: ts.BindingName | undefined, into: Set<string>) => {
  if (!n) return;
  if (ts.isIdentifier(n)) into.add(n.text);
  else for (const el of n.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, into);
};

/** The rule violations in one source text, as `rule: line` strings. */
export function scan(fileName: string, text: string): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const sdkImports = new Set<string>();
  let importsSdk = false;

  const moduleOf = (n: ts.Node): string | null => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier)
      return ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text : null;
    if (
      ts.isCallExpression(n) &&
      (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(n.expression) && n.expression.text === 'require')) &&
      n.arguments[0] &&
      ts.isStringLiteralLike(n.arguments[0])
    )
      return n.arguments[0].text;
    if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      const x = n.moduleReference.expression;
      return ts.isStringLiteral(x) ? x.text : null;
    }
    return null;
  };

  // Pass 1: imports.
  const visitImports = (n: ts.Node) => {
    const m = moduleOf(n);
    if (m !== null) {
      if (GATEWAY_MODULE.test(m)) out.push(`gateway-import: ${line(n)}`);
      if (SDK_MODULE.test(m)) {
        importsSdk = true;
        if (ts.isImportDeclaration(n) && n.importClause) {
          const c = n.importClause;
          if (c.name) sdkImports.add(c.name.text);
          const nb = c.namedBindings;
          if (nb && ts.isNamespaceImport(nb)) sdkImports.add(nb.name.text);
          if (nb && ts.isNamedImports(nb))
            for (const el of nb.elements) sdkImports.add(el.name.text);
        }
      }
    }
    ts.forEachChild(n, visitImports);
  };
  visitImports(sf);

  // Pass 2: error bindings in SDK files.
  const errorNames = new Set<string>();
  const visitErrors = (n: ts.Node) => {
    if (ts.isCatchClause(n) && n.variableDeclaration)
      bindingNames(n.variableDeclaration.name, errorNames);
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'catch'
    ) {
      const cb = n.arguments[0];
      if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)))
        for (const p of cb.parameters) bindingNames(p.name, errorNames);
    }
    if (
      (ts.isPropertyAssignment(n) || ts.isMethodDeclaration(n)) &&
      (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) &&
      n.name.text === 'onError'
    ) {
      const fn = ts.isPropertyAssignment(n) ? n.initializer : n;
      if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isMethodDeclaration(fn))
        for (const p of fn.parameters) bindingNames(p.name, errorNames);
    }
    ts.forEachChild(n, visitErrors);
  };
  if (importsSdk) visitErrors(sf);

  const mentions = (n: ts.Node, names: Set<string>): boolean => {
    let hit = false;
    const v = (x: ts.Node) => {
      if (hit) return;
      if (ts.isIdentifier(x) && names.has(x.text)) {
        // A property name (`a.err`, `{err: 1}`) is not a reference.
        const p = x.parent;
        const isName =
          (ts.isPropertyAccessExpression(p) && p.name === x) ||
          (ts.isPropertyAssignment(p) && p.name === x);
        if (!isName) hit = true;
      }
      ts.forEachChild(x, v);
    };
    v(n);
    return hit;
  };

  // Pass 3: calls.
  const visitCalls = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n.expression);
      if (name !== null && MODEL_CALLS.has(name)) {
        const opts = n.arguments.find(ts.isObjectLiteralExpression);
        const model = opts?.properties.find(
          (p): p is ts.PropertyAssignment =>
            ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'model',
        );
        const init = model?.initializer;
        if (init && (ts.isStringLiteralLike(init) || ts.isTemplateExpression(init)))
          out.push(`string-model: ${line(n)}`);
        if (name === 'streamText') {
          const hasOnError = opts?.properties.some(
            (p) =>
              (ts.isPropertyAssignment(p) ||
                ts.isMethodDeclaration(p) ||
                ts.isShorthandPropertyAssignment(p)) &&
              (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
              p.name.text === 'onError',
          );
          if (!hasOnError) out.push(`streamText-without-onError: ${line(n)}`);
        }
      }
      if (isLogSink(n.expression)) {
        const args = n.arguments;
        if (args.some((a) => mentions(a, sdkImports)) || args.some((a) => mentions(a, errorNames)))
          out.push(`error-logged: ${line(n)}`);
      }
    }
    ts.forEachChild(n, visitCalls);
  };
  visitCalls(sf);
  return out;
}

describe('the scanner pins each rule', () => {
  const v = (text: string) => scan('x.ts', text);
  it('1: a string model to streamText or generateText', () => {
    expect(v(`streamText({ model: 'openai/gpt-5', onError() {} });`)).toEqual(['string-model: 1']);
    expect(v('generateText({ model: `anthropic/${m}` });')).toEqual(['string-model: 1']);
    expect(v(`ai.generateText({ model: "x" });`)).toEqual(['string-model: 1']);
    expect(v('streamText({ model: openai(id), onError: () => {} });')).toEqual([]);
  });
  it('2: an @ai-sdk/gateway import in any form', () => {
    expect(v(`import { gateway } from '@ai-sdk/gateway';`)).toEqual(['gateway-import: 1']);
    expect(v(`export * from '@ai-sdk/gateway';`)).toEqual(['gateway-import: 1']);
    expect(v(`const g = await import('@ai-sdk/gateway');`)).toEqual(['gateway-import: 1']);
    expect(v(`const g = require('@ai-sdk/gateway/x');`)).toEqual(['gateway-import: 1']);
    expect(v(`import { openai } from '@ai-sdk/openai';`)).toEqual([]);
  });
  it('3: an AI SDK error, or a caught turn error in SDK code, passed to a log sink', () => {
    const sdk = `import { streamText, APICallError } from 'ai';\n`;
    expect(v(`${sdk}try { x(); } catch (e) { console.error(e); }`)).toEqual(['error-logged: 2']);
    expect(v(`${sdk}p.catch((err) => console.warn(\`failed \${err.message}\`));`)).toEqual([
      'error-logged: 2',
    ]);
    expect(
      v(
        `${sdk}streamText({ model: m, onError: ({ error }) => { process.stderr.write(String(error)); } });`,
      ),
    ).toEqual(['error-logged: 2']);
    expect(v(`${sdk}console.log(APICallError);`)).toEqual(['error-logged: 2']);
    expect(v(`import * as AI from 'ai';\nconsole.info(AI.RetryError);`)).toEqual([
      'error-logged: 2',
    ]);
    // A file that does not use the SDK keeps its own diagnostics, and a property name is no reference.
    expect(v(`try { x(); } catch (e) { console.warn(String(e)); }`)).toEqual([]);
    expect(
      v(`${sdk}try { x(); } catch (e) { console.warn('turn failed', { e: 1 }.e === 1); }`),
    ).toEqual([]);
  });
  it('4: streamText without onError', () => {
    expect(v('streamText({ model: m });')).toEqual(['streamText-without-onError: 1']);
    expect(v('streamText(opts);')).toEqual(['streamText-without-onError: 1']);
    expect(v('streamText({ model: m, onError });')).toEqual([]);
    expect(v('streamText({ model: m, onError() {} });')).toEqual([]);
    expect(v('generateText({ model: m });')).toEqual([]);
  });
});

describe('AI SDK safety in production sources (ai-sdk-agent-harness D3, D5)', () => {
  it('scans ai-runtime and the AI routers', () => {
    const files = productionFiles().map((f) => relative(REPO, f));
    for (const want of [
      'packages/ai-runtime/src/aiTurn.ts',
      'packages/ai-runtime/src/aiMcpServer.ts',
      'server/src/routers/ai.ts',
      'server/src/routers/transcribe.ts',
      'server/src/routers/events.ts',
    ])
      expect(files).toContain(want);
  });

  it('no file breaks a rule', () => {
    const violations = productionFiles().flatMap((f) =>
      scan(f, readFileSync(f, 'utf8')).map((v) => `${relative(REPO, f)} ${v}`),
    );
    expect(violations).toEqual([]);
  });
});
