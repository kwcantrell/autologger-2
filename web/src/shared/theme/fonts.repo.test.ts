/// <reference types="node" />
// redesign-show-ignition D9 / web-frontend-platform "Server-rendered shell" and "Self-hosted font
// faces are deduplicated and scoped to what renders": the critical-path font preloads name the
// exact URLs the stylesheet's @font-face `src:` requests, no face is Inter or Google-hosted, and
// every declared family is something web/src renders.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = path.resolve(SRC, '..');
const CSS_PATH = path.join(SRC, 'shared', 'theme', 'tailwind.css');
const CSS = fs.readFileSync(CSS_PATH, 'utf8');
const LAYOUT = fs.readFileSync(path.join(SRC, 'app', '(index)', 'layout.page.tsx'), 'utf8');

type Face = { family: string; weight: string; src: string };

const faces: Face[] = [...CSS.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => {
  const body = m[1];
  const family = body.match(/font-family:\s*['"]([^'"]+)['"]/)?.[1] ?? '';
  const weight = body.match(/font-weight:\s*([^;]+);/)?.[1].trim() ?? '';
  const src = body.match(/src:\s*url\(["']?([^"')]+)["']?\)/)?.[1] ?? '';
  return { family, weight, src };
});

const preloads = [...LAYOUT.matchAll(/<link\b([\s\S]*?)\/>/g)]
  .map((m) => {
    const attr = (n: string) => m[1].match(new RegExp(`\\b${n}="([^"]*)"`))?.[1];
    return {
      rel: attr('rel'),
      href: attr('href'),
      as: attr('as'),
      type: attr('type'),
      crossOrigin: attr('crossOrigin'),
    };
  })
  .filter((l) => l.rel === 'preload' && l.as === 'font');

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(tsx?|css)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}
const SOURCES = walk(SRC).map((f) => ({ f, text: fs.readFileSync(f, 'utf8') }));
// tailwind.css without its @font-face blocks: a family named only by its own face is unused.
const CSS_NO_FACES = CSS.replace(/@font-face\s*\{[^}]*\}/g, '');

describe('self-hosted fonts', () => {
  it('declares the Show Ignition faces', () => {
    const families = new Set(faces.map((f) => f.family));
    for (const fam of ['Barlow', 'Barlow Condensed', 'JetBrains Mono', 'League Gothic']) {
      expect(families.has(fam)).toBe(true);
    }
    const weights = (fam: string) =>
      faces
        .filter((f) => f.family === fam)
        .map((f) => f.weight)
        .sort();
    expect(weights('Barlow')).toEqual(['400', '500', '600', '700']);
    expect(weights('Barlow Condensed')).toEqual(['500', '600', '700']);
    expect(weights('JetBrains Mono')).toEqual(['500 600']);
  });

  it('preloads exactly three critical faces whose hrefs equal the @font-face src URLs', () => {
    expect(preloads).toHaveLength(3);
    const staticSrcs = faces.map((f) => f.src).filter((s) => s.startsWith('/static/fonts/'));
    expect(preloads.map((p) => p.href).sort()).toEqual([...staticSrcs].sort());
    for (const p of preloads) {
      expect(p.type).toBe('font/woff2');
      expect(p.crossOrigin).toBe('anonymous');
    }
    const preloaded = (fam: string, weight: string) =>
      faces.find((f) => f.family === fam && f.weight === weight && f.src.startsWith('/static/'));
    expect(preloaded('Barlow', '400')).toBeDefined();
    expect(preloaded('Barlow', '600')).toBeDefined();
    expect(faces.some((f) => f.family === 'League Gothic' && f.src.startsWith('/static/'))).toBe(
      true,
    );
  });

  it('every @font-face file exists, and no two faces share a file', () => {
    for (const f of faces) {
      const onDisk = f.src.startsWith('/')
        ? path.join(WEB, 'public', f.src)
        : path.resolve(path.dirname(CSS_PATH), f.src);
      expect(fs.existsSync(onDisk), f.src).toBe(true);
    }
    expect(new Set(faces.map((f) => f.src)).size).toBe(faces.length);
  });

  it('no @font-face references Inter or fonts.googleapis.com', () => {
    expect(faces.filter((f) => f.family === 'Inter')).toEqual([]);
    expect(CSS).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
    expect(
      fs.existsSync(path.join(WEB, 'public', 'static', 'fonts', 'inter-latin-var.woff2')),
    ).toBe(false);
  });

  it('every declared family is referenced in web/src', () => {
    for (const fam of new Set(faces.map((f) => f.family))) {
      const named = new RegExp(`['"]${fam}['"]`);
      // Either a source names the family directly, or a custom property holding it in
      // tailwind.css is consumed (`var(--font-x)` or the `font-x` utility).
      const direct =
        SOURCES.some(({ f, text }) => f !== CSS_PATH && named.test(text)) ||
        [...CSS_NO_FACES.matchAll(/font-family:\s*([^;]+);/g)].some((m) => named.test(m[1]));
      const tokens = [...CSS_NO_FACES.matchAll(/(--font-[a-z0-9-]+):\s*([^;]+);/g)]
        .filter((m) => named.test(m[2]))
        .map((m) => m[1]);
      const consumed = tokens.some((t) => {
        const utility = new RegExp(`(?<![\\w-])font-${t.slice('--font-'.length)}(?![\\w-])`);
        const ref = `var(${t})`;
        return SOURCES.some(({ f, text }) =>
          f === CSS_PATH ? CSS_NO_FACES.includes(ref) : text.includes(ref) || utility.test(text),
        );
      });
      expect(direct || consumed, `${fam} is declared but nothing renders it`).toBe(true);
    }
  });

  it('the body, label and timecode font tokens name the Show Ignition faces', () => {
    expect(CSS_NO_FACES).toMatch(/--font-ui:\s*['"]Barlow['"]/);
    expect(CSS_NO_FACES).toMatch(/--font-label:\s*['"]Barlow Condensed['"]/);
    expect(CSS_NO_FACES).toMatch(/--font-tc:\s*['"]JetBrains Mono['"]/);
    expect(CSS_NO_FACES).toMatch(/body\s*\{[^}]*font-family:\s*var\(--font-ui\)/);
  });
});
