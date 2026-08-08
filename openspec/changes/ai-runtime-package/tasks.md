# Tasks — ai-runtime-package

> **Plan of record.** Gated 2026-08-08 after the pre-panel fact-check pass and the
> four-reviewer adversarial panel; rulings E1–E10 are recorded in `design.md`'s Panel &
> review log and folded across all four artifacts.

**Standing rules for every phase.** `file:line` anchors are orientation only — locate code by
content before editing. **Every dispatch unit leaves all four root gates green** (`npm test`,
`npm run typecheck`, `npm run lint`, `npm run docs:check`); the panel demonstrated three
separate red windows in the draft this plan replaces, so no unit may be knowingly red and no
"inverted canary" may create a red window by design. Pure `git mv` commits separately from
semantic edits where a unit permits it; moves are hash-verified against the **phase base**
(`git rev-parse BASE:old` vs `HEAD:new`) — noting that hash verification does not apply to
files the same unit also rewrites, and that `npm run lint` runs `biome check --write` with
`organizeImports` on, so "lint green" is no evidence about import ordering. Comment re-points
land in phase 5, not in the move unit.

**Four edit-set instruments, run every phase** — the campaign has under-counted the edit set on
four consecutive changes, each time by a different instrument's blind spot, and this change's
panel found a fourth class:
1. **Import-specifier extraction** over the whole repo *including `server/scripts/`*.
2. **Path-literal search** (`.mjs`, config files, anything no import scan sees).
3. **Moved-symbol search** (a staying module can lose exports).
4. **Normative prose** — `README.md`, `CLAUDE.md`, and doc comments. No gate reads these, and
   no code instrument sees them.

## 1. Scaffold the package, prove its coverage, and close the two gate holes it exercises

*One dispatch unit per task group below; all four root gates green at each unit's end.*

- [x] 1.1 Create `packages/ai-runtime/` — `package.json` (source-only `exports` with `.` and `./*`; dependencies `@autologger/{domain,contract,session-core,ports}`, `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`; `zod` as a **peerDependency**; `vitest` and `typescript` as devDependencies), `tsconfig.json`, a non-empty `src/` (an empty `src/` fails `tsc` at scaffold time), and `fixturesDir.ts` re-exported from the barrel. **`@autologger/ports` is not optional**: D3's Clock threading gives five moving modules `import type { Clock } from '@autologger/ports'`, and the pre-change edge inventory does not show it. Add `@autologger/ai-runtime` to `server/package.json` dependencies.
- [x] 1.2 Add the package to the **root `package.json`** `test` and `typecheck` chains — this, not `server/vitest.config.ts`, is the package enumeration. Prove membership with a deliberately failing test **and** a deliberate type error, each failing the corresponding root command; record both in the ledger and revert them.
- [x] 1.3 Add the package's `fakeClock` copy (the fifth, per final duplicate-per-package policy) **and** its `TEST_INFRASTRUCTURE_EXEMPTIONS` entry. The `log-import` precedent records that the exemption must land **ahead of** the file it governs; without it `checkThirdPartySpecifiers` flags `vitest` as an undeclared third-party specifier, because `devDependencies` are not merged by the package discovery.
- [x] 1.4 Enrol `ai-runtime` in `WORKSPACE_REGIMES` **and** add `packages/ai-runtime/src/**` to the `ai-runtime` atlas component's globs *alongside* its existing `server/src/ai-runtime/**` glob (both coexist; no overlap). These are two different gates and the draft conflated them: regime enrolment governs edge extraction, while a scaffold file outside every component glob is an **orphan** and turns `docs:check` red — demonstrated against the live coverage gate.
- [x] 1.5 Add `@autologger/ai-runtime` to `SERVICE_PACKAGES` and the allowed-edge set (`ai-runtime → {domain, contract, session-core, ports}`). Extend the existing mutation coverage — typo'd-set and empty-set cases — to run against the four service checks with the new member present, invoking the **production** check functions and **production** membership constants.
- [x] 1.6 Add the **`SERVICE_PACKAGES` completeness assertion**: every `packages/*` that is not L0 or L1 is in the set or on a named exemption list. Demonstrate the hole it closes — remove a real member from the constant and confirm a deliberate service-to-service violation stops being reported by all of checks (1)–(3) while the completeness assertion fires. Record in the ledger.
- [x] 1.7 Add the **server-manifest scan**: every `@autologger/*` specifier in `server/src` production sources appears in `server/package.json` dependencies. Verify it is green across the nine packages the server declares on `main` plus the tenth this phase adds, then demonstrate by removing a real declaration. Scope it to the `@autologger/*` direction only — the third-party direction stays an open gap and the delta says so.

## 2. Characterize and reshape the two seams, while the modules are still in the app

*Characterization and reshape are a TDD pair and batch into one unit per seam (ruling E10).*

- [x] 2.1 Characterize the kill ladder's SIGTERM→SIGKILL escalation and `prepareDesignTurnCredentials`'s login fallback **before** touching either signature. The credential path has **zero** test coverage today, and the characterization must run **through the router**, not at unit level, so an optional-field regression cannot pass. Record which paths were already covered and which gained a test.
- [x] 2.2 Thread `Clock` through the six in-package signatures — `killProcessGroup`, `killAiChatProcessGroup`, `RunAiChatTurnOptions`, `driveAiTurn`, `GenerateTopicsTurnOptions`/`generateTopicsTurn`, `createDesignTurnSpawner` — and supply `c.env.ports.clock` at **four** router call sites: `routers/ai.ts`, `routers/events.ts`, `routers/aiV2.ts`, `routers/transcribe.ts`. The fourth is the non-obvious one: `topics/generate` reaches the ladder through the in-package `generateTopicsTurn` → `driveAiTurn`. `clock` is **required and leading at every level** (ruling E3) — an optional options field is locally idiomatic, which is exactly the danger, because a missed construction site would typecheck. **`killProcessGroup` must remain total**: it is awaited inside two `finally` blocks whose remaining statements release a concurrency slot, abandon pending questions, dispose an MCP turn token, and delete the copied-credentials directory. Update the stable re-export aliases in `aiV2SdkSpawn.ts`.
- [x] 2.3 Verify the positional shift site-by-site, not by compiler alone: inserting a leading parameter shifts positionals past an **optional** `graceMs`, and five call sites pass explicit grace values — dropping one typechecks and silently reverts to the 3000 ms default.
- [x] 2.4 Make the kill-ladder tests deterministic with **both** the clock and the poll's sleep under test control. This is not only about new tests: `aiChatRunner.test.ts` already holds a `SIGTERM→SIGKILL ladder, no orphans` block whose three cases drive the real loop against a live process group, and handing them a frozen `makeFakeClock()` hangs the suite — demonstrated. Scope any timer control to the ladder call: the same file's `waitForPidFile` helper polls on a real timer and is awaited *before* the code under test, so describe-scope fake timers hang the test before it arrives. Alternatively inject a sleep seam; the delta makes sleep control a SHALL either way.
- [x] 2.5 Move the credential-source path resolution out of `prepareDesignTurnCredentials` into `createBindings`, carried on `Config` as a **required** field with **no environment override** (ruling E6), and passed at the single production call site in `routers/aiV2.ts`. Confirm 2.1's characterization passes unchanged. Add no file to `server/src/node/` — this is a line in the existing `config.ts`.

## 3. Move both directories — a single dispatch unit

*Ruling E9: `server/src/ai-runtime/` and `server/src/aiV2/` move together. The one app-internal
edge is a **value** import of `AGGREGATE_MCP_SERVER_NAME` carried by `aiV2SdkSpawn.ts` and two
moving test files, and `checkPackagesBoundary` walks test files — splitting the directories
across units leaves three `escape` violations and `npm test` red for a whole phase
(demonstrated). Tasks 3.1–3.6 land as one unit.*

- [x] 3.1 `git mv` all 13 production modules and 13 co-located test files from `server/src/ai-runtime/` and `server/src/aiV2/` into `packages/ai-runtime/src/`. Rewrite import specifiers on both sides using **subpath** form (`@autologger/ai-runtime/<module>`, ruling E4), and ensure each router and its integration test use the **identical** specifier — four int suites `vi.spyOn` a module namespace, which requires both sides to resolve one module record. This would be the repo's first `@autologger/*` subpath consumer, so verify resolution explicitly (`import.meta.resolve` plus a `tsc -p` pass) rather than assuming.
- [x] 3.2 Relocate **both** `*.real.test.ts` files — `topicGenerate.real.test.ts` and `eventGenerate.real.test.ts` — to `server/src/test/` (ruling E5). `topicGenerate.real.test.ts` must move because its `../env` import would be a package→app escape; `eventGenerate.real.test.ts` must move with it because `npm run test:real -w server` is a **server-workspace-scoped path-substring filter**, so a sibling left in the package would be silently dropped from the operator-facing escape hatch while `npm test` stayed green. Update `eventGenerate.real.test.ts`'s header, which documents its own invocation.
- [x] 3.3 Move the four in-package-read fixtures (`fake-claude.mjs`, `fake-claude-error.mjs`, `fake-claude-exit-before-stdin.mjs`, `ai-v2-sdk-spawn-recorder.mjs`) to `packages/ai-runtime/fixtures/` and point **every** reader at the exported constant, including in-package tests. Exactly one is genuinely shared — `fake-claude.mjs` — so the staying-side const import lands in its four integration-test readers (`transcribe.int.test.ts` reads it at **two** sites) plus the `join(...)` literal at `playwright.config.ts:20`. `fake-claude-error.mjs` is a **plain single-reader move**: `transcribe.int.test.ts` names it only in a comment. Verify each classification by reading the referencing line, never by matching the filename. Leave the six fixtures with no in-package reader where they are.
- [x] 3.4 In this same unit: remove `ai-runtime` and `aiV2` from `SERVER_SRC_LAYER_DIRS`; add the **by-name non-recreation check** for both directories and demonstrate it; re-point `checkAiRuntimePurity` at the package — a **body edit**, since the function takes only `repoRoot` and hardcodes `srcRoot = repoRoot/server/src` — and add its **permanent non-vacuity assertion** (`walkTsFiles` returns `[]` for a missing directory, and no `enumeratedButEmpty` analogue covers `packages/`). Widen `AI_RUNTIME_MOVED_BASENAMES` from 11 to 13 entries.
- [x] 3.5 In this same unit: widen `checkInterfaceOnlyConsumption`'s walked root to cover the service packages (D9). Without it the facade-only rule is **discharged by the act of moving** — 13 modules leave a `server/src`-scoped walk with no gate objecting. Verify it lands green today (`transcription` and `log-import` import `SessionHubFacade` as a type; the moving modules import only `SessionHubRegistryFacade`), and add a mutation case proving it fires from a package location.
- [x] 3.6 In this same unit: narrow the `ai-runtime` atlas component to the package glob only; **delete** the `aiV2` component rather than clearing its globs (an emptied-but-present component also defeats the capability gate's dangling-component check); drop `aiV2` from `capabilityScopes`' `ai-v2-dashboards` entry; move `ai-runtime-to-claude-cli`'s `from` endpoint with its evidence file. Then verify by review that **no** component in the model matches zero tracked files — the property is normative and explicitly not machine-checked, and seven `datastore`/`external` components legitimately declare no globs at all.
- [x] 3.7 Re-point `web/src/pages/index/components/aiV2/clientAggregates.pinning.test.ts`'s dynamic-import path literal. The 254-line mirror itself is untouched. Record this as a **deliberate, non-precedential** relocation of a test-only reader onto the package graph — not a ruling that `web/` may depend on it.
- [x] 3.8 Demonstrate the re-pointed purity check for **each** arm — `hono`, `appEnv`, and a relative reach into `server/src/` — not just `hono`. Only the `hono` arm is non-redundant with the package-boundary escape check, so a single-arm demonstration would pass identically against a check that had lost the other two. Record in the ledger.

## 4. Verify the move landed clean

- [x] 4.1 Confirm `server/src` contains only `node`, `auth`, `middleware`, `routers`, `test`, and that the layering enumeration's completeness check still passes over what remains.
- [x] 4.2 Confirm the moving set declares no `Error` subclass the app matches with `instanceof` — the delta requires a change with an empty set to say so rather than leave the obligation unaddressed — and that the existing cross-boundary pins (`TranscriptGenerateError`, `YtDlpError`, `InvalidRangeError`, `DashboardValidationError`) are unaffected.
- [x] 4.3 Parse `npm ls zod --json` and `npm ls better-sqlite3 --json` for **resolved-copy count**. Exit codes lie, and `zod@3.25.76` already reports `invalid` against the agent SDK's `^4.0.0` peer range **on `main`** — a pre-existing unrelated peer-range warning the baseline's own scenario carves out, not a regression.

## 5. Normative prose and stale path references

- [x] 5.1 Update `README.md` (the annotated source tree's `server/src/ai-runtime/` entry, and the packages section, which gains a tenth package) and `CLAUDE.md` (the Source-layout paragraph, which currently states the AI runtime "has its own home at `server/src/ai-runtime/`"). Both go false the moment this ships; **no gate in the repository reads either file**, and the immediately-preceding change edited them by 116 lines in its implementation commit. These land in the implementation branch, following that precedent.
- [x] 5.2 In a commit separate from the move, re-point stale path prose driven by **`git grep -n "server/src/ai-runtime\|server/src/aiV2"`** over tracked files rather than by a hand-written list — the draft's list was wrong in both directions, naming two files that were not stale and missing ten that were. Include `packageBoundaries.repo.test.ts`'s inherited narration of `server/src/session/` as "not yet fully empty", which has been false since step 2. Preserve every origin header verbatim: past-tense provenance ("ported from …") is deliberate and must not become a present-tense obligation.

## 6. Final gates and ledger

- [x] 6.1 Run the four root gates clean: `npm test`, `npm run typecheck`, `npm run lint`, `npm run docs:check`.
- [x] 6.2 Regenerate `edges.snapshot.json` (not the git-ignored `atlas.json`) and review it **per edge with attribution** — every vanished and every new edge traced to a decision in `design.md`.
- [x] 6.3 Run `npm run e2e` (chromium + login-gate) and `npm run e2e:visual`. This is the only gate that exercises `playwright.config.ts`'s fixture path literal. Visual baselines are current as of 2026-07-14 and this change alters no UI, so a visual diff is a defect to investigate, not drift to defer.
- [x] 6.4 Run `npm run test:real -w server` far enough to confirm **both** relocated real tests are still selected by its path-substring filter.
- [x] 6.5 Re-run all four edit-set instruments over the finished branch and reconcile against `git diff --stat` / `git log --stat` plus a stray-file scan. Confirm the frozen surface is untouched: no changed expectation in any conformance fixture, no status code, JSON shape, export body, header, or WS message or emission differs.
- [x] 6.6 Confirm `openspec validate ai-runtime-package --strict` passes, and run the predecessor's **scenario-name set-difference check** over each MODIFIED block against its baseline in both directions — the panel found all six baseline scenarios of one requirement silently replaced. Use `LC_ALL=C sort -u` before any `comm`.
