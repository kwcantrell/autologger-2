# Tasks — web-package-boundary

**PROVISIONAL until the human gate.** No questions are escalated (design Open Questions), so the
gate is accept / reject / amend rather than a set of rulings.

`file:line` anchors are orientation only — locate every target by content before editing.

**Standing gate:** `npm run typecheck` + `npm test` + `npm run lint` + `npm run docs:check`.

**Gates deliberately skipped, declared not assumed:** `npm run e2e` and `npm run e2e:visual`. No
runtime behavior is touched — the only non-test edit in the change is a comment.

## 1. The rule and its guard

- [x] 1.1 Extend `web/src/webBoundaries.repo.test.ts` with the cross-workspace rule: **no production
      file under `web/src` imports from `packages/`**, by relative path or by `@autologger/*`
      specifier, at any layer.
      Reuse the file's existing AST machinery (`ts.createSourceFile`) and its production/test
      partition — do **not** add a second parser or a regex path. The file was rebuilt on the AST
      precisely because regex scanning was defeated repeatedly.
      **Test files are exempt and the exemption is load-bearing** — `clientAggregates.pinning.test.ts`
      imports the real package module to keep the mirror honest, and that guarantee is what makes
      the duplication acceptable. Verify that test still passes (11 tests, 2 files).
- [x] 1.2 Prove the rule non-vacuous, matching the properties this file already carries:
      - a **mutation pair** against a real temporary filesystem — fires on a violating input, does
        not fire on a conforming one;
      - the existing non-zero examined-file assertion still covers the new scan.
      Then demonstrate against the **real tree**: plant a production `web/src → packages/domain`
      relative import, confirm the guard goes red, revert; repeat with an `@autologger/domain`
      specifier form. **Working-tree only — never commit a mutation.** Report the exact messages.
      Note for context: this exact probe currently passes all three gates
      (`webBoundaries`, `packageBoundaries`, `tsc -p web`), which is the defect being closed.

## 2. The stale justification

- [x] 2.1 Correct the header of
      `web/src/pages/index/components/aiV2/clientAggregates.ts` (locate by its
      `server.fs.allow` sentence). Two edits, comment only:
      - **Remove the dead reason.** Packages resolve through a `node_modules` symlink
        (`@autologger/ai-runtime -> ../../packages/ai-runtime`), so "loosening Vite's dev-server
        `server.fs.allow`" is no longer a constraint.
      - **Keep the surviving reason** — `aggregates.ts`'s parameter types come from
        `@autologger/session-core`, an L1 package with a `better-sqlite3` peerDependency — and update
        its **paths**, which still name the pre-package `server/src/session/...` locations.
      - **Mark the mirror permanent**, citing the rule from task 1.1, so a future reader does not
        re-open a settled question.
      Do not change any code in the file. Its `computeTranscriptExcerpt` is a client-only derivation
      with no server counterpart and its own explanation — leave that untouched.

## 3. Verification

- [x] 3.1 Run the four root gates and record **actual output, not a claim**. State explicitly that
      `e2e` and `e2e:visual` were skipped and why.
- [x] 3.2 Confirm the diff touches only `web/src/webBoundaries.repo.test.ts`,
      `web/src/pages/index/components/aiV2/clientAggregates.ts`, and this change's artifacts. Any
      other path is a finding, not a convenience.
- [x] 3.3 `openspec validate web-package-boundary --strict`.
- [x] 3.4 Verify the MODIFIED requirement is a **strict superset** of the baseline's: every existing
      sentence and all three original scenarios present, three scenarios added. Compare scenario
      name sets in **both directions** with `LC_ALL=C sort` — a prior campaign step produced a false
      "scenarios dropped" scare from a bad collation, and a prior panel found a MODIFIED block that
      silently dropped three.
