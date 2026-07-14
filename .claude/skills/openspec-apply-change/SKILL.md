---
name: openspec-apply-change
description: Implement tasks from an OpenSpec change. Use when the user wants to start implementing, continue implementation, or work through tasks.
allowed-tools: Bash(openspec:*)
license: MIT
compatibility: Requires openspec CLI.
metadata:
  author: openspec
  version: "1.0"
  generatedBy: "1.6.0"
---

Implement tasks from an OpenSpec change.

> **Repo customization (autologger):** steps 6–7 replace the stock inline implementation
> loop with subagent-dispatched execution (see CLAUDE.md "How we work"). The orchestrator
> that carried explore → propose → panel → gate stays lean by never implementing inline —
> code, diffs, and test logs live in per-task subagents and report files. If the `openspec`
> CLI ever regenerates this file, re-apply this customization.

**Store selection:** If the user names a store (a store is a standalone OpenSpec repo registered on this machine) or the work lives in one, run `openspec store list --json` to discover registered store ids, then pass `--store <id>` on the commands that read or write specs and changes (`new change`, `status`, `instructions`, `list`, `show`, `validate`, `archive`, `doctor`, `context`). Other commands do not take the flag. Hints printed by commands already carry the flag; keep it on follow-ups. Without a store, commands act on the nearest local `openspec/` root.

**Input**: Optionally specify a change name. If omitted, check if it can be inferred from conversation context. If vague or ambiguous you MUST prompt for available changes.

**Steps**

1. **Select the change**

   If a name is provided, use it. Otherwise:
   - Infer from conversation context if the user mentioned a change
   - Auto-select if only one active change exists
   - If ambiguous, run `openspec list --json` to get available changes and use the **AskUserQuestion tool** to let the user select

   Always announce: "Using change: <name>" and how to override (e.g., `/opsx:apply <other>`).

2. **Check status to understand the schema**
   ```bash
   openspec status --change "<name>" --json
   ```
   Parse the JSON to understand:
   - `schemaName`: The workflow being used (e.g., "spec-driven")
   - `planningHome`, `changeRoot`, and `actionContext`: planning scope and edit constraints
   - Which artifact contains the tasks (typically "tasks" for spec-driven, check status for others)

3. **Get apply instructions**

   ```bash
   openspec instructions apply --change "<name>" --json
   ```

   This returns:
   - `contextFiles`: artifact ID -> array of concrete file paths (varies by schema - could be proposal/specs/design/tasks or spec/tests/implementation/docs)
   - Progress (total, complete, remaining)
   - Task list with status
   - Dynamic instruction based on current state

   **Handle states:**
   - If `state: "blocked"` (missing artifacts): show message, suggest using openspec-continue-change
   - If `state: "all_done"`: congratulate, suggest archive
   - Otherwise: proceed to implementation

4. **Read context files**

   Read every file path listed under `contextFiles` from the apply instructions output.
   The files depend on the schema being used:
   - **spec-driven**: proposal, specs, design, tasks
   - Other schemas: follow the contextFiles from CLI output

5. **Show current progress**

   Display:
   - Schema being used
   - Progress: "N/M tasks complete"
   - Remaining tasks overview
   - Dynamic instruction from CLI

6. **Implement tasks by dispatching subagents (loop until done or blocked)**

   Never implement inline, and never read code, diffs, or full test logs into this
   session — implementation happens in disposable per-task subagents; heavy detail moves
   through files. The OpenSpec artifacts ARE the task briefs: gated, self-contained, on
   disk. A dispatch prompt is ~20 lines of pointers, not pasted context.

   **Setup (once per apply session):**
   - Be on a feature branch off `main` (plain branch — **never a worktree**, per CLAUDE.md).
   - Scratch dir: `openspec/changes/<name>/.apply/` (git-ignored). Ledger: `.apply/ledger.md`.
   - If the ledger exists, resume from it: tasks it records complete are DONE — do not
     re-dispatch them. After compaction, trust the ledger and `git log` over memory.

   **Per task (strictly sequential — never dispatch implementers in parallel):**

   a. Record `BASE=$(git rev-parse HEAD)`.

   b. Classify the task, which sets the review gate in (e):
      - **mechanical** — pure renames, comment/doc sweeps, checkbox/validator runs,
        config touch-ups with no behavior change
      - **code-bearing** — anything that changes behavior, reshapes a seam, or
        adds/modifies tests

   c. Dispatch an implementer subagent. The prompt contains:
      - The artifact paths from `contextFiles`, introduced as "read these first — they
        are your requirements"
      - The task ID + its verbatim text from tasks.md
      - Any interface or decision from an earlier task the artifacts can't know
        (usually nothing — the subagent can read the code)
      - The report-file path `.apply/task-<id>-report.md`: full detail goes there —
        what was implemented, files changed, test commands + output, TDD RED/GREEN
        evidence when the task orders tests first, self-review findings
      - The return contract: **≤15 lines** — STATUS (`DONE` | `DONE_WITH_CONCERNS` |
        `BLOCKED` | `NEEDS_CONTEXT`), commits (short SHA + subject), one-line test
        summary, concerns, report path
      - Requirements: follow the task's own test ordering (tests-first where it says
        so); `npm run typecheck` + `npm test` green before committing; conventional
        commits; locate code by content, not stale `file:line` anchors; CLAUDE.md
        invariants bind (frozen HTTP/WS contract, synchronous hub RPCs, etc.)
      - Model tier: cheapest that fits — light model for mechanical tasks, standard for
        multi-file integration, most capable only for judgment-heavy work

   d. Handle the returned status:
      - `DONE` → proceed to (e)
      - `DONE_WITH_CONCERNS` → read the concerns (not the report body); address
        correctness/scope concerns before review, note observations in the ledger
      - `NEEDS_CONTEXT` → supply what's missing, re-dispatch
      - `BLOCKED` → change something: more context, a more capable model, a smaller
        split, or escalate to the user if the artifacts themselves are wrong. Never
        retry unchanged.

   e. **Review gate (thresholded):**
      - **code-bearing** → write the diff to a file this session never reads:
        `{ git log --oneline $BASE..HEAD; git diff --stat $BASE..HEAD; git diff -U10 $BASE..HEAD; } > openspec/changes/<name>/.apply/task-<id>-diff.txt`
        Dispatch a reviewer subagent (mid-tier model floor) with the diff path, the
        spec/design paths, and the report path. It must return **two verdicts**: spec
        compliance (the diff does what the task + spec require — nothing missing,
        nothing extra) and code quality. Critical/Important findings → dispatch a fix
        subagent (fixes + re-runs covering tests, appends results to the same report
        file) → re-review with a fresh diff file. Loop until clean. Do not pre-judge
        findings in the reviewer prompt ("don't flag X" is a red flag).
      - **mechanical** → skip the per-task reviewer; step 7's whole-branch review
        covers it.

   f. Bookkeeping: tick the checkbox in tasks.md (`- [ ]` → `- [x]`) and append one
      ledger line:
      `Task <id>: complete (commits <base7>..<head7>, review clean | skipped-mechanical)`

   **Pause if:**
   - Task is unclear → ask for clarification
   - Implementation reveals a design issue → suggest updating artifacts
   - A blocker you cannot resolve → report and wait for guidance
   - User interrupts

7. **Final whole-branch review (always, after all tasks)**

   Write the branch package to a file:
   `BASE=$(git merge-base main HEAD); { git log --oneline $BASE..HEAD; git diff --stat $BASE..HEAD; git diff -U10 $BASE..HEAD; } > openspec/changes/<name>/.apply/branch-diff.txt`
   Dispatch one reviewer on the **most capable model** with that path, all artifact
   paths, and the ledger (so it can triage any minor findings accumulated there). If it
   returns findings, dispatch **one** fix subagent with the complete list — not one per
   finding — then re-review. When clean, suggest merge back to `main` and archive.

8. **On completion or pause, show status**

   Display:
   - Tasks completed this session
   - Overall progress: "N/M tasks complete"
   - If all done: suggest archive
   - If paused: explain why and wait for guidance

**Output During Implementation**

```
## Implementing: <change-name> (schema: <schema-name>)

Working on task 3/7: <task description> [code-bearing]
[dispatch implementer → DONE, 2 commits, "14/14 passing"]
[diff → .apply/task-3-diff.txt; dispatch reviewer → spec ✅, quality approved]
✓ Task complete (ledger + checkbox updated)

Working on task 4/7: <task description> [mechanical]
[dispatch implementer → DONE, 1 commit, "typecheck + suite green"]
✓ Task complete (per-task review skipped; covered by final branch review)
```

**Output On Completion**

```
## Implementation Complete

**Change:** <change-name>
**Schema:** <schema-name>
**Progress:** 7/7 tasks complete ✓

### Completed This Session
- [x] Task 1
- [x] Task 2
...

All tasks complete! Ready to archive this change.
```

**Output On Pause (Issue Encountered)**

```
## Implementation Paused

**Change:** <change-name>
**Schema:** <schema-name>
**Progress:** 4/7 tasks complete

### Issue Encountered
<description of the issue>

**Options:**
1. <option 1>
2. <option 2>
3. Other approach

What would you like to do?
```

**Guardrails**
- Keep going through tasks until done or blocked
- Always read context files before starting (from the apply instructions output)
- **Never implement inline** — every code change goes through an implementer subagent
- **Never read diffs, code, or full test logs into the orchestrator session** — hand them
  over as file paths
- **Never dispatch implementer subagents in parallel** — tasks run strictly sequentially
- **Never re-dispatch a task the ledger marks complete** — check `.apply/ledger.md` (and
  `git log`) after any compaction or resume
- If task is ambiguous, pause and ask before dispatching
- If implementation reveals issues, pause and suggest artifact updates
- Subagents keep changes minimal and scoped to their task; the dispatch prompt says so
- Update the task checkbox and ledger immediately after each task clears its gate
- Pause on errors, blockers, or unclear requirements - don't guess
- Use contextFiles from CLI output, don't assume specific file names

**Fluid Workflow Integration**

This skill supports the "actions on a change" model:

- **Can be invoked anytime**: Before all artifacts are done (if tasks exist), after partial implementation, interleaved with other actions
- **Allows artifact updates**: If implementation reveals design issues, suggest updating artifacts - not phase-locked, work fluidly
