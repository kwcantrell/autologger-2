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
function scan(
  filter: (f: string) => boolean,
  re: RegExp,
  allowLine?: (l: string) => boolean,
): Hit[] {
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

  it('no source imports the retired per-primitive @radix-ui/react-* packages', () => {
    // shadcn-shared-wrappers 4.1: the shadcn primitives use the `radix-ui` umbrella package.
    expect(scan(() => true, /from\s+['"]@radix-ui\/react-/)).toEqual([]);
  });

  it('OverlayScrollbars stays removed (shadcn ScrollArea is the one scroll system)', () => {
    // shadcn-port-workspace D7: feeds and rail lists scroll in the shadcn ScrollArea.
    expect(scan(() => true, /(from\s+|import\s+|import\()['"]overlayscrollbars/)).toEqual([]);
    const pkg = JSON.parse(fs.readFileSync(path.join(SRC, '..', 'package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(deps).filter((d) => d.startsWith('overlayscrollbars'))).toEqual([]);
  });

  it('deleted legacy chrome classes are never passed as a class again', () => {
    // shadcn-port-modals D8: the modal chrome these named (`.modal-*`, `.tool-row`, the fps
    // family, …) was deleted from tailwind.css. Attribute-aware: only class arguments are
    // scanned — `className="…"`, and string literals inside `cn(…)` / `clsx(…)` — so a kept id
    // such as `id="new-session-form"` is not a hit. Generic words (`inline`, `num`, `wide`,
    // `actions`) are deliberately not listed: Tailwind's own `inline` is legitimate again.
    const DELETED = new Set([
      'modal-hint',
      'modal-lead',
      'modal-actions',
      'modal-dropdown-actions',
      'modal-export-actions',
      'tool-row',
      'export-row',
      'tool-row-session-opts',
      'fps-field',
      'fps-field-label',
      'fps-select',
      'fps-custom-wrap',
      'fps-custom-label',
      'fps-custom-input',
      'fps-hint',
      'new-session-form',
      'v5-panel-eyebrow',
      'v4-log-top__capture',
      'v4-log-top__playback',
      // remove-admin-users-page D6: the page chrome and form/button chrome whose last consumer
      // was the retired /admin/users page. Generic words (`field`, `primary`, `danger`,
      // `header`, `main`, `panel`, `footer`, `brand`) stay off the list, as above.
      'btn',
      'btn-icon',
      'profile-select',
      'admin-settings-block',
      'settings-subheading',
      'settings-actions',
      'settings-panel',
      'brand-with-logo',
      'brand-lockup',
      'brand-logo',
      'brand-text',
      'tagline',
      'developer-footer',
      'developer-label',
      'developer-logo',
      'crumb',
      'admin-table',
    ]);
    const classArgs = (src: string): string[] => {
      const out: string[] = [];
      for (const m of src.matchAll(/className=(?:"([^"]*)"|\{\s*['`]([^'`]*)['`]\s*\})/g))
        out.push(m[1] ?? m[2] ?? '');
      for (const m of src.matchAll(/\b(?:cn|clsx)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g))
        for (const lit of m[1].matchAll(/['"`]([^'"`]*)['"`]/g)) out.push(lit[1]);
      return out;
    };
    const hits: string[] = [];
    for (const f of files.filter((x) => /\.tsx?$/.test(x))) {
      for (const arg of classArgs(fs.readFileSync(f, 'utf8')))
        for (const token of arg.split(/\s+/))
          if (DELETED.has(token)) hits.push(`${rel(f)}: ${token}`);
    }
    expect(hits).toEqual([]);
  });

  it('no shadcn primitive keeps a `dark:` variant', () => {
    expect(scan(isUi, /(^|[\s'"`])dark:/)).toEqual([]);
  });

  it('legacy code never references the bare --border/--muted/--accent tokens (or their --color-* twins)', () => {
    const mapping = (l: string) => /^\s*--color-(border|muted|accent):\s*var\(--\1\);/.test(l);
    expect(scan((f) => !isUi(f), /var\(--(color-)?(border|muted|accent)\)/, mapping)).toEqual([]);
  });

  it('legacy code never uses the bare (text|border|outline|bg|ring)-(muted|accent|border) utilities', () => {
    expect(
      scan(
        (f) => !isUi(f),
        /(?<![\w-])(?:text|border|outline|bg|ring)-(?:muted|accent|border)(?![\w-])/,
      ),
    ).toEqual([]);
  });
});
