/// <reference types="node" />
// shadcn-foundation design D7/D8 — CI guard for the AA contrast floor (web-ui-system
// "AA contrast floor on rendered surfaces") between agent-browser QA passes.
//
// Each colour is read from its source of truth (tailwind.css tokens, the shared class
// strings) and composited over the LIGHTEST effective surface the in-page probe
// (openspec/changes/shadcn-foundation/qa/contrast.js) measured it on. Light text on the
// dark theme loses contrast as the surface lightens, so the lightest measured surface is
// the binding case — comparing against the darkest V5 colour could never fail.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const CSS = read('shared/theme/tailwind.css');

type RGBA = [number, number, number, number];

function parseColor(raw: string): RGBA {
  const s = raw.trim();
  const hex = s.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const m = s.match(/^rgba?\(([^)]+)\)$/);
  if (!m) throw new Error(`unparseable colour: ${raw}`);
  const p = m[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number);
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
}

function over(top: RGBA, bottom: RGBA): RGBA {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i] * a + bottom[i] * (1 - a)).concat(1) as RGBA;
}

function luminance([r, g, b]: RGBA): number {
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(fg: RGBA, surface: RGBA): number {
  const x = luminance(over(fg, surface));
  const y = luminance(surface);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Value of a custom property declared in tailwind.css (first declaration). */
function token(name: string): string {
  const m = CSS.match(new RegExp(`^\\s*${name.replace(/[-]/g, '\\-')}:\\s*([^;]+);`, 'm'));
  if (!m) throw new Error(`token ${name} not found in tailwind.css`);
  return m[1].trim();
}

/** A custom property's value with `var(--x)` references followed to a literal. */
function resolved(name: string): string {
  let v = token(name);
  for (let i = 0; i < 5; i++) {
    const ref = v.match(/^var\((--[a-z0-9-]+)\)$/);
    if (!ref) return v;
    v = token(ref[1]);
  }
  throw new Error(`var() chain too deep for ${name}`);
}

/** Resolves the text colour a class string applies: `text-v5-x` tokens or `text-[<colour>]`. */
function textColour(classes: string): string {
  for (const raw of classes.split(/\s+/)) {
    const c = raw.replace(/^!/, '');
    const arbitrary = c.match(/^text-\[((?:#|rgba?\().+)\]$/);
    if (arbitrary) return arbitrary[1].replace(/_/g, ' ');
    const named = c.match(/^text-(v5-[a-z0-9-]+)$/);
    if (named) return token(`--color-${named[1]}`);
  }
  throw new Error(`no text colour in: ${classes}`);
}

/** The string literal assigned to `const NAME =` in a source file. */
function classConst(rel: string, name: string): string {
  const m = read(rel).match(new RegExp(`const ${name}\\s*=\\s*\\n?\\s*'([^']+)'`));
  if (!m) throw new Error(`${name} not found in ${rel}`);
  return m[1];
}

// Lightest effective surfaces the probe measured (qa/baseline/*.contrast.json `bg`).
const SURFACE = {
  sessionRow: parseColor('rgb(35, 57, 76)'),
  dialogClose: parseColor('rgb(48, 56, 76)'),
  dialogField: parseColor('rgb(51, 58, 78)'),
  eventButtonRow: parseColor('rgb(40, 44, 55)'),
  primaryButton: parseColor('rgb(45, 89, 121)'),
  loginLink: parseColor('rgb(46, 54, 74)'),
};

const AA = 4.5;

describe('AA contrast floor — source colours over their lightest measured surfaces', () => {
  it('muted text token (utility and custom property agree) on rows and dialog close buttons', () => {
    const utility = parseColor(token('--color-v5-muted'));
    expect(parseColor(token('--v5-muted'))).toEqual(utility);
    expect(contrast(utility, SURFACE.sessionRow)).toBeGreaterThanOrEqual(AA);
    expect(contrast(utility, SURFACE.dialogClose)).toBeGreaterThanOrEqual(AA);
  });

  it('input/textarea placeholder floor on dialog fields', () => {
    const block = CSS.match(/input::placeholder,\s*textarea::placeholder\s*\{\s*color:\s*([^;]+);/);
    expect(block).not.toBeNull();
    expect(
      contrast(parseColor((block as RegExpMatchArray)[1]), SURFACE.dialogField),
    ).toBeGreaterThanOrEqual(AA);
  });

  it('sky primary button label (BTN_PRIMARY_SKY) on its tinted surface', () => {
    const fg = parseColor(textColour(classConst('shared/theme/classnames.ts', 'BTN_PRIMARY_SKY')));
    expect(contrast(fg, SURFACE.primaryButton)).toBeGreaterThanOrEqual(AA);
  });

  it('login secondary link (BTN_CREATE) on its surface', () => {
    const fg = parseColor(
      textColour(classConst('pages/index/components/LoginPage.tsx', 'BTN_CREATE')),
    );
    expect(contrast(fg, SURFACE.loginLink)).toBeGreaterThanOrEqual(AA);
  });

  it('event-button "AI Rules" label without instructions on its row', () => {
    const m = read('pages/index/components/EventButtonsTable.tsx').match(
      /bearing \? 'text-v5-primary' : '([^']+)'/,
    );
    expect(m).not.toBeNull();
    expect(
      contrast(parseColor(textColour((m as RegExpMatchArray)[1])), SURFACE.eventButtonRow),
    ).toBeGreaterThanOrEqual(AA);
  });

  it('timeline total-duration readout carries no extra opacity reduction', () => {
    const line = read('pages/index/components/Timeline.tsx')
      .split('\n')
      .find((l) => l.includes('text-[0.65rem] font-medium tracking-[0.04em] text-v5-muted'));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/opacity-\[/);
  });
});

describe('shadcn semantic tokens alias V5 values that clear the floor (design D5)', () => {
  it('muted-foreground on the lightest dialog field and card surfaces', () => {
    const fg = parseColor(resolved('--muted-foreground'));
    expect(contrast(fg, SURFACE.dialogField)).toBeGreaterThanOrEqual(AA);
    expect(contrast(fg, parseColor(resolved('--card')))).toBeGreaterThanOrEqual(AA);
  });

  it('primary-foreground on the sky-tinted primary surface', () => {
    expect(
      contrast(parseColor(resolved('--primary-foreground')), SURFACE.primaryButton),
    ).toBeGreaterThanOrEqual(AA);
  });

  it('foreground on background, card and popover', () => {
    const fg = parseColor(resolved('--foreground'));
    for (const surface of ['--background', '--card', '--popover']) {
      expect(contrast(fg, parseColor(resolved(surface)))).toBeGreaterThanOrEqual(AA);
    }
  });

  it('each shadcn colour token is exposed as a Tailwind colour via @theme inline', () => {
    for (const t of [
      'background',
      'foreground',
      'card',
      'card-foreground',
      'popover',
      'popover-foreground',
      'primary',
      'primary-foreground',
      'secondary',
      'secondary-foreground',
      'muted',
      'muted-foreground',
      'accent',
      'accent-foreground',
      'destructive',
      'border',
      'input',
      'ring',
    ]) {
      expect(token(`--color-${t}`)).toBe(`var(--${t})`);
    }
  });
});
