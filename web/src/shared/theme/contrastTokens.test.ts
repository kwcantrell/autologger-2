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

/**
 * The custom properties declared directly inside the first rule whose selector list contains
 * `selector` (e.g. `[data-transport='recording']`). Used for the transport-state blocks, which
 * redeclare the same names per state.
 */
function blockVars(selector: string): Record<string, string> {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = CSS.match(new RegExp(`(?:^|[\\n,])\\s*${esc}\\s*(?:,[^{]*)?\\{([^}]*)\\}`));
  if (!m) throw new Error(`no rule for ${selector} in tailwind.css`);
  const out: Record<string, string> = {};
  for (const d of m[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim();
  return out;
}

const srgbToLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const linearToSrgb = (v: number) => {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, Math.round(c * 255)));
};

// Björn Ottosson's OKLab (the space CSS `color-mix(in oklab, …)` interpolates in).
function toOklab([r, g, b]: RGBA): [number, number, number] {
  const [lr, lg, lb] = [r, g, b].map(srgbToLinear);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
function fromOklab([L, a, b]: [number, number, number]): RGBA {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    1,
  ];
}

/**
 * A colour-valued custom property evaluated to an opaque RGBA: follows `var()` (looking in
 * `scope` first, then the first :root declaration) and evaluates the opaque
 * `color-mix(in oklab, A p%, B)` form the Show Ignition tokens use.
 */
function colour(nameOrValue: string, scope: Record<string, string> = {}): RGBA {
  const lookup = (n: string) => scope[n] ?? token(n);
  const evalValue = (raw: string, depth: number): RGBA => {
    if (depth > 8) throw new Error(`colour chain too deep: ${raw}`);
    const v = raw.trim();
    const ref = v.match(/^var\((--[a-z0-9-]+)\)$/);
    if (ref) return evalValue(lookup(ref[1]), depth + 1);
    const mix = v.match(/^color-mix\(in oklab,\s*(.+?)\s+(\d+(?:\.\d+)?)%,\s*(.+)\)$/);
    if (mix) {
      const p = Number(mix[2]) / 100;
      const a = toOklab(evalValue(mix[1], depth + 1));
      const b = toOklab(evalValue(mix[3], depth + 1));
      return fromOklab([0, 1, 2].map((i) => a[i] * p + b[i] * (1 - p)) as [number, number, number]);
    }
    return parseColor(v);
  };
  return evalValue(nameOrValue.startsWith('--') ? lookup(nameOrValue) : nameOrValue, 0);
}

/** Resolves the text colour a class string applies: `text-v5-x` tokens or `text-[<colour>]`. */
function textColour(classes: string): string {
  for (const raw of classes.split(/\s+/)) {
    const c = raw.replace(/^!/, '');
    const arbitrary = c.match(/^text-\[((?:#|rgba?\().+)\]$/);
    if (arbitrary) return arbitrary[1].replace(/_/g, ' ');
    const named = c.match(/^text-(v5-[a-z0-9-]+)$/);
    if (named) return resolved(`--color-${named[1]}`);
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
    const utility = parseColor(resolved('--color-v5-muted'));
    expect(parseColor(resolved('--v5-muted'))).toEqual(utility);
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

  it('login secondary link (BTN_CREATE) on its surface', () => {
    const fg = parseColor(
      textColour(classConst('pages/index/components/LoginPage.tsx', 'BTN_CREATE')),
    );
    expect(contrast(fg, SURFACE.loginLink)).toBeGreaterThanOrEqual(AA);
  });

  it('event-button row summary and Edit on the Event buttons card', () => {
    // Settings › Event buttons (redesign-show-ignition 9.1): each row's summary is an
    // ItemDescription (muted text) and its Edit a ghost Button (foreground text), both on the card.
    const src = read('pages/index/components/settings/EventButtonsSection.tsx');
    expect(src).toMatch(/<ItemDescription[^>]*>\s*\{summary\}/);
    expect(src).toMatch(/<Button\s+variant="ghost"[^>]*?>\s*Edit\s*</);
    const card = colour('--card');
    expect(contrast(colour('--muted-foreground'), card)).toBeGreaterThanOrEqual(AA);
    expect(contrast(colour('--foreground'), card)).toBeGreaterThanOrEqual(AA);
  });

  it('timeline total-duration readout carries no extra opacity reduction', () => {
    const line = read('pages/index/components/Timeline.tsx')
      .split('\n')
      .find((l) => l.includes('font-tc text-[0.6875rem] font-medium text-si-dim'));
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

  // The default Button renders the Show Ignition primary tint (redesign-show-ignition D1):
  // its label is --si-fg on --si-primary-tint, and solid accent fills (Badge, checkbox) carry
  // --primary-foreground on --primary. Both are evaluated from the CSS, color-mix included.
  it('primary labels on the accent surfaces (default Button label, e.g. Create & open)', () => {
    expect(contrast(colour('--primary-foreground'), colour('--primary'))).toBeGreaterThanOrEqual(
      AA,
    );
    expect(contrast(colour('--si-fg'), colour('--si-primary-tint'))).toBeGreaterThanOrEqual(AA);
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

describe('Show Ignition tokens (redesign-show-ignition D1)', () => {
  it('declares the direction contract values', () => {
    expect(token('--si-bg')).toBe('#101216');
    expect(token('--si-panel')).toBe('#16181d');
    expect(token('--si-panel-2')).toBe('#1c1f25');
    expect(token('--si-line')).toBe('#272b33');
    expect(token('--si-fg')).toBe('#eceef2');
    expect(token('--si-muted')).toBe('#a6acb7');
    expect(token('--si-dim')).toBe('#858c98');
    expect(token('--si-ink')).toBe('#0b0c0f');
    expect(token('--si-accent')).toBe('#5b7cff');
    expect(token('--r-ctl')).toBe('8px');
    expect(token('--r-card')).toBe('12px');
    expect(token('--h-ctl')).toBe('36px');
    expect(token('--h-sm')).toBe('30px');
    expect(token('--sel-bg')).toBe('color-mix(in oklab, var(--si-accent) 18%, transparent)');
    expect(token('--sel-line')).toBe('color-mix(in oklab, var(--si-accent) 48%, transparent)');
  });

  it('defines the four transport mixes', () => {
    expect(token('--si-tx-stopped')).toBe('color-mix(in oklab, var(--si-accent) 10%, #0c0d10)');
    expect(token('--si-tx-rolling')).toBe('color-mix(in oklab, var(--si-accent) 25%, #0a0b0e)');
    expect(token('--si-tx-recording')).toBe('color-mix(in oklab, var(--si-accent) 25%, #0a0b0e)');
    expect(token('--si-tx-playback')).toBe('color-mix(in oklab, var(--si-accent) 18%, #0c0d10)');
  });

  it('re-points the shadcn variables at the Show Ignition tokens', () => {
    expect(token('--background')).toBe('var(--si-bg)');
    expect(token('--foreground')).toBe('var(--si-fg)');
    expect(token('--card')).toBe('var(--si-panel)');
    expect(token('--popover')).toBe('var(--si-panel-2)');
    expect(token('--primary')).toBe('var(--si-accent)');
    expect(token('--secondary')).toBe('var(--si-panel-2)');
    expect(token('--muted')).toBe('var(--si-panel-2)');
    expect(token('--muted-foreground')).toBe('var(--si-muted)');
    expect(token('--border')).toBe('var(--si-line)');
    expect(token('--ring')).toBe('var(--si-accent)');
    for (const t of [
      'sidebar',
      'sidebar-foreground',
      'sidebar-primary',
      'sidebar-primary-foreground',
      'sidebar-accent',
      'sidebar-accent-foreground',
      'sidebar-border',
      'sidebar-ring',
    ]) {
      expect(token(`--color-${t}`)).toBe(`var(--${t})`);
    }
  });

  it('re-points the V5 names so untouched consumers render flat', () => {
    expect(resolved('--v5-bg')).toBe('#101216');
    expect(resolved('--v5-text')).toBe('#eceef2');
    expect(resolved('--v5-primary')).toBe('#5b7cff');
    for (const glass of [
      '--v5-glass-face',
      '--v5-glass-face-strong',
      '--v5-glass-face-aside',
      '--v5-glass-face-feed',
    ]) {
      expect(token(glass)).not.toMatch(/gradient/);
    }
    expect(token('--v5-shadow-glow')).not.toMatch(/rgba\(56, 189, 248/);
  });

  it('muted text clears AA on panel, panel-2 and every rail mix', () => {
    for (const surface of ['--si-panel', '--si-panel-2', '--si-bg']) {
      expect(contrast(colour('--si-muted'), colour(surface))).toBeGreaterThanOrEqual(AA);
      expect(contrast(colour('--muted-foreground'), colour(surface))).toBeGreaterThanOrEqual(AA);
    }
    for (const mix of ['stopped', 'rolling', 'recording', 'playback']) {
      expect(contrast(colour('--si-muted'), colour(`--si-tx-${mix}`))).toBeGreaterThanOrEqual(AA);
    }
  });

  it.each([
    ['stopped', 'STOPPED'],
    ['rolling', 'ROLLING'],
    ['recording', 'REC'],
    ['playback', 'PLAY'],
  ])('the %s status label (%s) clears AA on its own pill', (state) => {
    const scope = blockVars(`[data-transport='${state}']`);
    const fg = colour(scope['--tx-pill-fg'] ?? '--tx-pill-fg', scope);
    const bg = colour(scope['--tx-pill-bg'] ?? '--tx-pill-bg', scope);
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(AA);
    // The pill sits on the tinted top bar; stopped's pill is the bar itself.
    expect(scope['--tx-rail']).toBe(`var(--si-tx-${state})`);
  });

  // web-session-console "Transport state tints the shell": the top bar, rail and strip tint
  // together. The bar takes the rail's own mix (11.3: at 18% it read as untinted beside the
  // 25% rail), and the text on it still clears AA.
  it.each(['stopped', 'rolling', 'recording', 'playback'])(
    'the %s top bar takes the rail mix and its text clears AA',
    (state) => {
      const scope = blockVars(`[data-transport='${state}']`);
      expect(scope['--tx-bar']).toBe(`var(--si-tx-${state})`);
      const bar = colour(scope['--tx-bar'], scope);
      expect(contrast(colour('--si-fg'), bar)).toBeGreaterThanOrEqual(AA);
      expect(contrast(colour('--si-muted'), bar)).toBeGreaterThanOrEqual(AA);
    },
  );

  it('the live top bar carries the soft glow, as the rail and strip do', () => {
    const live = CSS.match(
      /\[data-transport='recording'\] \[data-slot='topbar'\],\s*\[data-transport='rolling'\] \[data-slot='topbar'\]\s*\{([^}]*)\}/,
    );
    expect(live?.[1]).toMatch(/box-shadow:[^;]*var\(--tx-glow\)/);
  });

  it('stopped is the :root default (the same rule declares both)', () => {
    expect(CSS).toMatch(/:root,\s*\[data-transport='stopped'\]\s*\{/);
  });
});
