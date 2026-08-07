import { describe, expect, it } from 'vitest';
import { model } from '../model/components';
import { isMappedOrExcluded, mappedFiles } from '../model/coverage';
import { projectComponentEdges } from '../model/edges';
import { extractFileImports } from '../src/lib/extractImports';
import { listTrackedFiles, repoRoot } from '../src/lib/repo';

// Regression test for audit finding F1 (openspec/changes/web-docs-architecture-viz):
// extractFileImports silently skipped every file outside the four app
// workspaces (server/web/companion/e2e), so web-docs's OWN mapped source —
// including src/lib/erSchema.ts, which really does import
// `@autologger/storage` and server/src/session/{SessionHub,sessionCore}.ts
// (see the module-header comment on erSchema.ts) — never contributed edges to
// the derived snapshot. This is a live-repo check, not a count pin (spec
// "Live-repo drift gates run at build and via docs:check" / F2 disposition):
// it asserts a specific, source-documented architectural coupling exists,
// not an exact edge count — it stays true unless erSchema.ts's imports
// themselves change, which is the exact drift this pipeline exists to catch.
//
// persistence-package-extraction task 2.2: erSchema.ts's `applyMigrations`
// import moved from server/src/node/migrate.ts to `@autologger/storage`, so
// the web-docs -> node-infra edge this test used to assert is now
// web-docs -> storage. Task 4.3: erSchema.ts's other two imports
// (sqliteSessionSql/SessionCore) moved from server/src/session/ to
// `@autologger/session-core`, so the web-docs -> session edge is now
// web-docs -> session-core.
//
// Deliberately does NOT call `buildSnapshot` (audit re-review minor 1):
// `buildSnapshot` throws on any unmapped-import error, which is correct for
// the human-run regeneration command (scripts/snapshot.ts keeps that strict
// throw unchanged) but wrong for a test that runs under root `npm test` —
// an unrelated branch adding a brand-new, not-yet-mapped
// `server/src/<newdir>/` imported by mapped code would throw here and red
// root `npm test`, re-entering the exact "live-repo state pinned inside a
// test" failure mode the F2 fix (above) exists to avoid. Instead this test
// re-derives the same edge list inline via `extractFileImports` +
// `projectComponentEdges` directly, tolerating unknown/unmapped import
// targets by simply not asserting on `unmappedImportErrors` — an unknown
// target is skipped (its import never lands in `extraction.imports`, so it
// never becomes an edge), never thrown. The assertion below only needs
// erSchema.ts's own imports to keep resolving, which is independent of
// whatever else the live tree happens to contain.
describe('web-docs live-repo edges — web-docs is itself extracted (audit F1 regression)', () => {
  it("captures erSchema.ts's real imports as production edges web-docs -> storage and web-docs -> session-core", {
    timeout: 30_000,
  }, () => {
    const root = repoRoot();
    const trackedTsFiles = listTrackedFiles({ extensions: ['.ts', '.tsx'], cwd: root });
    const extraction = extractFileImports({
      files: mappedFiles(trackedTsFiles, model),
      repoRoot: root,
      isKnown: (file) => isMappedOrExcluded(file, model),
    });
    // Tolerant on purpose: unmapped-import errors are neither asserted on
    // nor thrown here — see the module comment above.
    const projected = projectComponentEdges(extraction.imports, model);
    const webDocsTargets = projected.edges
      .filter((edge) => edge.from === 'web-docs' && edge.kind === 'production')
      .map((edge) => edge.to);

    expect(webDocsTargets).toEqual(expect.arrayContaining(['storage', 'session-core']));
  });
});
