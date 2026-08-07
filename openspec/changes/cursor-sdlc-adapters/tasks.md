# Tasks: cursor-sdlc-adapters

> GATED 2026-08-06: panel + consistency read complete, E1/E2/E3 ruled
> (keep-restart-with-ownership-fix / keep six adapters / native-panel-or-handoff),
> final human gate APPROVED. This is the plan of record.

## 1. Routed-target alignment (encoding amendment, D8)

- [x] 1.1 Customize `.claude/skills/openspec-propose/SKILL.md`: replace the Output step's
      "run apply" continuation with the gate stop (artifacts complete → tasks.md
      provisional until fact-check + panel + gate; do not suggest or run apply), matching
      the apply skill's customization pattern. Extend CLAUDE.md's re-apply-customization
      note to name the propose skill. Verify the skill still loads (machine-parsed
      governance file — invoke it against a scratch change name and confirm the
      instructions flow renders).

## 2. Adapter files

- [x] 2.1 Write `AGENTS.md` pointer (~12 lines: CLAUDE.md is normative, read fully, no
      restatements, D9 handoff sentence) and `.cursor/rules/openspec-sdlc.mdc`
      (`alwaysApply: true`; three encodings by path; read-before-design-bearing; the four
      bounded stop-conditions per D3).
- [x] 2.2 Write the opsx command adapters per D1: five runnable-verb
      pointers (explore/propose/update/sync/archive; propose carries TWO stop-conditions
      — D8's gate stop, phrased to avoid the guard's banned-phrase collision, and D9's
      panel-dispatch-or-handoff) and the apply stop/handoff adapter.
- [x] 2.3 Write `.cursor/rules/restart-server-yourself.mdc` per the ownership-scoped
      requirement (agent-started or identified-by-command-line only; ask-first otherwise;
      `:8791` off-limits; `:5173` disposition explicit; script references not command
      lines). Guard applies size/phrase checks but not the pointer check (E1).
- [x] 2.4 Add `.cursor/mcp.json` to `.gitignore`; write `.cursor/mcp.json.example`
      (portable, exact-version package spec, localization instructions).

## 3. Drift guard (TDD pair with 2.x — batch into one dispatch unit)

- [x] 3.1 Write `web/src/cursorAdapters.repo.test.ts` per D5: closed-world walk
      (`.cursor/**` recursive + all-depth `AGENTS.md` + `.cursorrules`) with allowlist
      failure on unenumerated files; per-file line+char budgets counted over the whole
      file; path-literal pointer checks; banned-phrase scan including frontmatter;
      gitignore/example/package-spec-literal assertions. Root resolution via
      `fileURLToPath(import.meta.url)`; no git subprocesses.
- [x] 3.2 One-time predicate check against the pre-drop stock bodies via
      `git show ed43b29^:<path>` (never committed as fixtures); record the outcome in the
      `.apply/` ledger.

## 4. Final gates

- [x] 4.1 `npm run typecheck` + `npm test` green (guard runs in the web project).
- [x] 4.2 Declared-proportionality gate skip: no runtime surface (adapters, one repo-scan
      test, skill-text customization), so `npm run e2e` and `npm run e2e:visual` are
      SKIPPED; state this in the ledger. Whole-branch review per the apply skill.

## 5. Non-gating follow-ups (do not block the branch; conservative defaults shipped)

- [ ] 5.1 On the contributor's machine, across the Cursor modes they actually use: verify
      rule attachment (`alwaysApply`), AGENTS.md auto-read, command discovery (nested
      `opsx/` — flatten to `opsx-<verb>.md` in a follow-up if undiscovered), and one
      behavioral spot-check that a runnable-verb adapter causes a full skill read and
      honors its stop-condition. Record outcomes in design.md; failures degrade to
      status quo ante (pointers simply not loaded), so none block this change.
