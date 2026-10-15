/// <reference types="node" />
// remove-perf-debug: the performance-debug button, panel, body toggles and transport override
// were removed (web-session-console "Transport state tints the shell"). No web source may
// bring them back by name. This file is the one place the names appear.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const BANNED = /perf-dbg|perfDebug|perf-debug|DebugTransport/;

describe('web/src has no performance-debug tooling', () => {
  it('finds zero references outside this guard', () => {
    const SRC = path.dirname(fileURLToPath(import.meta.url));
    const self = fileURLToPath(import.meta.url);
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return walk(p);
        return /\.(ts|tsx|css)$/.test(e.name) && p !== self ? [p] : [];
      });
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(100);
    const hits = files.flatMap((f) =>
      fs
        .readFileSync(f, 'utf8')
        .split('\n')
        .flatMap((line, i) => (BANNED.test(line) ? [`${path.relative(SRC, f)}:${i + 1}`] : [])),
    );
    expect(hits).toEqual([]);
  });
});
