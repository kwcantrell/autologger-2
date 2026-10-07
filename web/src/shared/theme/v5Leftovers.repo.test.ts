/// <reference types="node" />
// redesign-show-ignition 11.4 cleanup (owner-approved V5 leftovers) / web-ui-system "Single V5
// component vocabulary": no surface renders the retired V5 glass, and the chrome keeps one accent.
// Source scans pin the six leftovers the DESIGN.md documenter found: the aiV2 widget glass, the
// global plain-input look (translucent well, 0.6rem corners, cyan focus), the slate waveform body
// gradient, the sign-in banner's off-token reds, the category strip's legacy scrollbar thumb, and
// the unused rail shelf gradient token.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const CSS = read('shared', 'theme', 'tailwind.css');
const AI_V2 = path.join(SRC, 'pages', 'index', 'components', 'aiV2');
const compact = (s: string) => s.replace(/\s+/g, '');

/** The body of the first `selector {…}` block (no nested braces) after `from`. */
function ruleBody(css: string, selector: RegExp): string {
  const m = css.match(new RegExp(`${selector.source}\\s*\\{([^}]*)\\}`));
  return m?.[1] ?? '';
}

describe('V5 leftovers (11.4 cleanup)', () => {
  it('AI dashboard surfaces carry no glass gradient, navy glass fill or cyan', () => {
    const sources = fs
      .readdirSync(AI_V2)
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
      .map((f) => path.join(AI_V2, f))
      // The AI dashboards design panel and the shared Assistant/Dashboards composer.
      .concat(['AiV2Design.tsx', 'useSseTurn.tsx'].map((f) => path.join(AI_V2, '..', f)))
      .map((p) => ({ f: path.basename(p), s: compact(fs.readFileSync(p, 'utf8')) }));
    const hits = sources
      .filter(({ s }) => /linear-gradient|rgba\(13,19,34|rgba\(22,30,52|rgba\(56,189,248/.test(s))
      .map(({ f }) => f);
    expect(hits).toEqual([]);
  });

  it('WidgetChrome is a flat Card surface (panel fill, hairline, 12px card radius)', () => {
    const s = read('pages', 'index', 'components', 'aiV2', 'WidgetChrome.tsx');
    expect(s).toMatch(/\bbg-card\b/);
    expect(s).toMatch(/\bborder-si-line\b/);
    expect(s).toMatch(/\brounded-card\b/);
    expect(s).not.toMatch(/gradient/);
  });

  it('the plain input/textarea baseline is the Show Ignition input', () => {
    const c = compact(CSS);
    expect(c).not.toContain('rgba(56,189,248');
    expect(c).not.toContain('rgba(7,11,20');
    const base = compact(ruleBody(CSS, /input\[type='text'\],\s*textarea/));
    expect(base).toContain('background:var(--si-bg)');
    expect(base).toContain('border:1pxsolidvar(--si-line-strong)');
    expect(base).toContain('border-radius:var(--r-ctl)');
    const focus = compact(
      ruleBody(CSS, /input\[type='text'\]:focus-visible,\s*textarea:focus-visible/),
    );
    expect(focus).toContain('border-color:var(--ring)');
    const ph = compact(ruleBody(CSS, /input::placeholder,\s*textarea::placeholder/));
    expect(ph).toContain('color:var(--si-muted)');
  });

  it('the waveform body is a flat on-palette token, not the slate gradient', () => {
    const s = read('pages', 'index', 'components', 'timeline', 'TimelineWaveform.tsx');
    expect(s).not.toMatch(/linearGradient|#94a3b8|#64748b|#334155|#0f172a/);
    expect(s).toContain('[fill:var(--si-wave-body)]');
    expect(compact(CSS)).toMatch(/--si-wave-body:color-mix\(inoklab,var\(--si-fg\)/);
  });

  it('the sign-in error banner uses the danger tokens', () => {
    const s = compact(read('pages', 'index', 'components', 'LoginPage.tsx'));
    expect(s).not.toContain('248,113,113');
    expect(s).toContain('border-(--si-danger-line)');
  });

  it('the category strip scrollbar thumb takes the themed scrollbar palette', () => {
    const thumb = compact(
      ruleBody(CSS.slice(CSS.indexOf('@utility cat-strip-scrollbar')), /&::-webkit-scrollbar-thumb/),
    );
    expect(thumb).not.toContain('legacy');
    expect(thumb).toContain('var(--si-line-strong)');
  });

  it('the unused rail shelf gradient token is gone', () => {
    expect(CSS).not.toContain('--v6-rail-recent-shelf-bg');
  });
  it('no production component under pages/ keeps the V5 cyan or a sky-* utility', () => {
    const PAGES = path.join(SRC, 'pages');
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)],
      );
    const hits = walk(PAGES)
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
      .filter((f) => {
        const code = fs
          .readFileSync(f, 'utf8')
          .split('\n')
          .filter((l) => !/^\s*(\/\/|\*)/.test(l))
          .join('\n');
        return /rgba\(\s*56\s*,\s*189\s*,\s*248|\bsky-\d{3}\b/.test(code);
      })
      .map((f) => path.relative(SRC, f));
    expect(hits).toEqual([]);
  });
});
