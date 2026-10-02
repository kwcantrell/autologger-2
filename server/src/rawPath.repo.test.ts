// Raw-path security decisions are banned (require-login D13; gate-decoded-path D1). Hono routes on
// the percent-decoded path (`c.req.path`), so a gate or route that judged the raw pathname would
// let `/%61pi/x` past a check the router then serves as `/api/x`. No file under
// `server/src/middleware/` or `server/src/routers/` may read `.pathname` (the
// `new URL(c.req.url).pathname` idiom included). Only `upgradeDispatch.ts`, outside those
// directories, reads the raw pathname, by design. The scan uses the TypeScript parser, so comments
// and strings that mention the word don't count.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = __dirname;
const SCANNED = ['middleware', 'routers'];

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return tsFiles(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** `file:line` for every `.pathname` / `['pathname']` read in the source text. */
function rawPathReads(fileName: string, text: string): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    const hit =
      (ts.isPropertyAccessExpression(node) && node.name.text === 'pathname') ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === 'pathname') ||
      (ts.isBindingElement(node) &&
        (node.propertyName && ts.isIdentifier(node.propertyName)
          ? node.propertyName.text
          : ts.isIdentifier(node.name)
            ? node.name.text
            : '') === 'pathname');
    if (hit) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      out.push(`${relative(SRC, fileName)}:${line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe('no raw-path security decisions (require-login D13)', () => {
  it('the scanner catches each spelling and ignores comments and strings', () => {
    const sample = [
      'const a = new URL(c.req.url).pathname;',
      "const b = u['pathname'];",
      'const { pathname } = new URL(c.req.url);',
      '// the raw pathname would let it past the gate',
      "const s = 'pathname';",
    ].join('\n');
    expect(rawPathReads(join(SRC, 'routers', 'sample.ts'), sample)).toEqual([
      'routers/sample.ts:1',
      'routers/sample.ts:2',
      'routers/sample.ts:3',
    ]);
  });

  it('no file under server/src/middleware or server/src/routers reads .pathname', () => {
    const files = SCANNED.flatMap((d) => tsFiles(join(SRC, d)));
    expect(files.length).toBeGreaterThan(20);
    const offenders = files.flatMap((f) => rawPathReads(f, readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
