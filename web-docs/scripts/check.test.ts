import { describe, expect, it, vi } from 'vitest';

// Hoisted module mock recording every `readFileSync`/`readdirSync` call's
// path argument while still executing the REAL implementation (the "no
// gitignored reads" test below needs the real pipeline to actually run
// against the real tree — it only needs to OBSERVE what it reads). This
// mechanically proves the property, rather than scanning atlas.json's
// content for a gitignored-looking substring: a tracked file's own TEXT can
// legitimately mention a gitignored-looking path as prose/citation (e.g.
// the two authored `.mmd` diagrams cite their own `.apply/*-report.md`
// provenance in a `%%` comment) without that ever having been an actual
// disk read of gitignored content — read-call-site instrumentation observes
// the real I/O the process performs, which content-scanning cannot.
const recordedReads: string[] = [];
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn((...args: Parameters<typeof actual.readFileSync>) => {
      recordedReads.push(String(args[0]));
      return actual.readFileSync(...args);
    }),
    readdirSync: vi.fn((...args: Parameters<typeof actual.readdirSync>) => {
      recordedReads.push(String(args[0]));
      // biome-ignore lint/suspicious/noExplicitAny: readdirSync's overload set doesn't narrow cleanly through a spread re-call.
      return (actual.readdirSync as any)(...args);
    }),
  };
});

import { formatPassMessage, runAllGates } from './check';

/**
 * Matches a path SEGMENT (not a mid-word substring) under one of the repo's
 * git-ignored artifact directories named in the spec ("no reads of
 * git-ignored artifacts: `.codegraph/`, `openspec/changes/**\/.apply/`,
 * `DATA_DIR` contents, test output dirs"). `DATA_DIR`'s own default
 * location isn't checked by pattern here — verified instead by code audit
 * (task-6.3-report.md): no call site in check.ts or its live-wiring
 * transitively references `DATA_DIR`/a `data/` directory at all, so there
 * is no path shape to defensively pattern-match without risking a false
 * positive against an unrelated `node_modules/**\/data/` path.
 */
const GITIGNORED_PATH_PATTERN = /(^|[/\\])(\.codegraph|\.apply|test-results)([/\\]|$)/;

describe('formatPassMessage', () => {
  it('reports every drift gate as passed — task 6.3 landed the last stub (diagram validity), so no gate is left unimplemented', () => {
    expect(formatPassMessage()).toContain('all drift gates passed');
  });
});

// Live-repo determinism smoke (task 6.3; spec "Builds are deterministic and
// offline" — "two runs ... byte-identical", "no absolute paths or
// hostnames"). Runs the REAL extraction/gate/atlas-assembly pipeline twice
// against the live working tree — mirrors the "+1 live-repo smoke" pattern
// already used by specParser.test.ts/overlay.test.ts/erSchema.test.ts (a
// smoke assertion the pipeline behaves sanely against the real repo, not the
// full hard-fail drift-gate battery — that stays exclusive to `docs:check`,
// per design.md D4's "root npm test runs fixture-based unit tests only").
// Two full runs (extraction + ER in-memory DB builds + ~35 real mermaid
// parses each) take a few seconds each — the extended timeout below is
// deliberate, not a sign something is stuck.
describe('runAllGates — live-repo determinism smoke', () => {
  it('two independent live runs produce byte-identical atlas JSON, with no absolute paths or real hostnames anywhere in it', {
    timeout: 30_000,
  }, async () => {
    const run1 = await runAllGates();
    const run2 = await runAllGates();
    const json1 = JSON.stringify(run1.atlas, null, 2);
    const json2 = JSON.stringify(run2.atlas, null, 2);
    expect(json1).toBe(json2);
    expect(json1.length).toBeGreaterThan(0);

    // No absolute filesystem path from THIS machine/checkout, and no
    // `file://` URL, anywhere in the serialized atlas. (Spec text quoted
    // verbatim from openspec/specs/*/spec.md legitimately contains
    // illustrative "https://" URLs inside security-scenario prose — e.g.
    // a phishing look-alike host in a threat-model scenario — so this
    // scans for absolute FILESYSTEM paths and `file://`, not every
    // "https://" substring.)
    expect(json1).not.toContain(process.cwd());
    expect(json1).not.toMatch(/file:\/\//);
    expect(json1).not.toMatch(/\/home\/[^"\\]+\/|\/Users\/[^"\\]+\//);
  });

  it('never performs a readFileSync/readdirSync call against a path under a git-ignored directory (.codegraph/, openspec/changes/**/.apply/, DATA_DIR-style data/, test-results/)', {
    timeout: 30_000,
  }, async () => {
    recordedReads.length = 0;
    await runAllGates();
    expect(recordedReads.length).toBeGreaterThan(0); // the instrumentation is actually observing real reads, not a no-op
    const gitignoredRead = recordedReads.find((read) => GITIGNORED_PATH_PATTERN.test(read));
    expect(gitignoredRead).toBeUndefined();
  });
});
