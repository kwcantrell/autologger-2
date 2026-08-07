import { describe, expect, it } from 'vitest';
import { repoRoot } from '../src/lib/repo';
import { buildSnapshot } from './snapshot';

// Regression test for audit finding F1 (openspec/changes/web-docs-architecture-viz):
// extractFileImports silently skipped every file outside the four app
// workspaces (server/web/companion/e2e), so web-docs's OWN mapped source —
// including src/lib/erSchema.ts, which really does import
// server/src/node/migrate.ts and server/src/session/{SessionHub,sessionCore}.ts
// (see the module-header comment on erSchema.ts) — never contributed edges to
// the derived snapshot. This is a live-repo check, not a count pin (spec
// "Live-repo drift gates run at build and via docs:check" / F2 disposition):
// it asserts a specific, source-documented architectural coupling exists,
// not an exact edge count — it stays true unless erSchema.ts's imports
// themselves change, which is the exact drift this pipeline exists to catch.
describe('buildSnapshot — web-docs is itself extracted (audit F1 regression)', () => {
  it("captures erSchema.ts's real imports as production edges web-docs -> node-infra and web-docs -> session", {
    timeout: 30_000,
  }, () => {
    const root = repoRoot();
    const snapshot = buildSnapshot(root);
    const webDocsTargets = snapshot
      .filter((edge) => edge.from === 'web-docs' && edge.kind === 'production')
      .map((edge) => edge.to);

    expect(webDocsTargets).toEqual(expect.arrayContaining(['node-infra', 'session']));
  });
});
