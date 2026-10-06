/// <reference types="node" />
// shadcn-foundation design D2/D3: repo-wide hygiene for the shadcn layer.
//
// 1. Generated shadcn files import `cn` from the npm `cn` package and sonner reads
//    `next-themes`; both are rewritten on `add` (local `@/shared/lib/utils`, fixed dark
//    theme) and neither package may come back.
// 2. In this setup `dark:` compiles to `prefers-color-scheme: dark` (no custom `dark`
//    variant), so a leftover `dark:` in a primitive is a light/dark fork in a dark-only
//    app. Primitives fold the dark value into the base class instead.
// 3. The legacy `--border`/`--muted`/`--accent` tokens were renamed to `--legacy-*`
//    because shadcn owns those names now. Legacy code reattaching to the bare names
//    (via `var(--…)` or the `text-muted`/`text-accent`/`border-border` utilities) would
//    silently pick up the shadcn values, so outside the primitives they are banned. The
//    only allowed bare reference is the `@theme inline` mapping `--color-X: var(--X)`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(SRC, 'shared', 'components', 'ui');
const EXTENSIONS = new Set(['.ts', '.tsx', '.css']);

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return EXTENSIONS.has(path.extname(e.name)) ? [p] : [];
  });
}

const THIS_FILE = fileURLToPath(import.meta.url);
const files = walk(SRC).filter((f) => f !== THIS_FILE && !/\.test\.tsx?$/.test(f));
const isUi = (f: string) => f.startsWith(UI_DIR + path.sep);
const rel = (f: string) => path.relative(SRC, f);

type Hit = { file: string; line: number; text: string };
function scan(filter: (f: string) => boolean, re: RegExp, allowLine?: (l: string) => boolean): Hit[] {
  const hits: Hit[] = [];
  for (const f of files.filter(filter)) {
    fs.readFileSync(f, 'utf8')
      .split('\n')
      .forEach((l, i) => {
        if (re.test(l) && !allowLine?.(l)) hits.push({ file: rel(f), line: i + 1, text: l.trim() });
      });
  }
  return hits;
}

describe('shadcn hygiene', () => {
  it('no source imports the npm `cn` package or `next-themes`', () => {
    expect(scan(() => true, /from\s+['"](cn|next-themes)['"]/)).toEqual([]);
  });

  it('no shadcn primitive keeps a `dark:` variant', () => {
    expect(scan(isUi, /(^|[\s'"`])dark:/)).toEqual([]);
  });

  it('legacy code never references the bare --border/--muted/--accent tokens (or their --color-* twins)', () => {
    const mapping = (l: string) => /^\s*--color-(border|muted|accent):\s*var\(--\1\);/.test(l);
    expect(scan((f) => !isUi(f), /var\(--(color-)?(border|muted|accent)\)/, mapping)).toEqual([]);
  });

  it('legacy code never uses the bare (text|border|outline|bg|ring)-(muted|accent|border) utilities', () => {
    expect(scan((f) => !isUi(f), /(?<![\w-])(?:text|border|outline|bg|ring)-(?:muted|accent|border)(?![\w-])/)).toEqual([]);
  });
});
