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
   - **One change in flight per checkout** (decided 2026-07-14): before branching, the
     working tree must be clean of other work — commit spike/side artifacts to their own
     branch (or stash them). Uncommitted alien files force every reviewer to re-verify
     staging hygiene and risk contaminating this change's commits.
   - **Commit the gated artifacts before any dispatch** (decided 2026-07-14): if
     `openspec/changes/<name>/` has untracked or modified files, `git add` that directory
     (the git-ignored `.apply/` stays out automatically) and commit
     (`docs(openspec): add <name> gated artifacts`). This version-pins the plan of record
     implementers and reviewers read at the SHA where implementation starts; checkbox
     ticks and post-gate disposition edits then land as diffable docs commits.
   - Scratch dir: `openspec/changes/<name>/.apply/` (git-ignored). Ledger: `.apply/ledger.md`.
   - If the ledger exists, resume from it: tasks it records complete are DONE — do not
     re-dispatch them. After compaction, trust the ledger and `git log` over memory.

   **Per phase — partition first:** at the start of each phase, before any dispatch,
   group the phase's tasks into **dispatch units** (one unit = one implementer
   subagent handling one or more tasks). Batch tasks into a unit when:
   - they form a **TDD pair** — a tests-first task and the implementation it gates
     MUST share a unit, because every commit must leave the suite green (a failing
     test commit alone would break the gate);
   - they touch the **same files or seam**, so a second subagent would re-derive the
     first one's context;
   - a later task consumes an interface the earlier one defines and splitting would
     force a lossy handoff.
   Keep units small (≤3 tasks), never span phases, and record the partition in the
   ledger at phase start (`Phase <N> units: [x.1+x.2], [x.3]`). Units run strictly
   sequentially, exactly as tasks did.

   **Shared-helper preassignment (decided 2026-07-14):** at each partition, scan for
   nontrivial logic shared with already-landed code AND later planned tasks (tasks.md
   is known up front) — especially auth/authorization- or correctness-relevant logic.
   Name the shared home (file + export) in the ledger partition entry and the affected
   dispatch prompts at the earliest partition where the need is visible; revisit at
   every subsequent partition. Implementers extract to the named home instead of
   duplicating, and never write scope comments that misstate what was in scope
   (evidence: `normalizeEmail` triplicated across three phases, including a factually
   false "out of scope" comment, cleaned up only at branch review).

   **Seam declaration (decided 2026-07-27):** at each partition, also scan for
   interfaces whose caller-supplied parameters later phases will satisfy
   **independently** — each call site choosing its own source/value. Record a seam
   declaration in the ledger at the earliest partition where this is visible, and
   revisit at every subsequent partition (a seam may only become visible when its
   second caller's phase partitions): the parameter, the property every call site must
   satisfy, and the phases that will call it. State the property against the seam's
   **external consumer** where one exists ("every caller passes the clip layout the
   player consumes") — never as inter-caller uniformity, which a uniformly-wrong set
   of callers satisfies. Declare-when guidance, so declarations stay signal rather
   than blanket: declare data whose correctness depends on agreeing with another
   consumer; do NOT declare per-caller mode flags or identity params. Dispatch
   prompts for the calling phases carry the declaration; the ledger partition entry
   is the cross-check that they did (evidence: `useTimelineSeek`'s `events` parameter
   — three feeds independently chose `limit 200` while the player consumed
   `limit 2000`; every phase was individually correct, and the branch's one Critical
   lived entirely in the seam).

   **Verification discipline (applies throughout the apply session):**
   - **Single controlled diagnosis (decided 2026-07-14):** a gate failure suspected to
     be environmental (snapshot drift, credential/toolchain issues, flaky infra) gets
     exactly one controlled experiment to assign causality; the ledger records the
     verdict **with the experiment's method and conditions**. Later steps and reviewers
     cite the recorded verdict instead of re-deriving it — but any reviewer may reject
     a verdict whose recorded experiment doesn't meet the identical-conditions bar, or
     when concrete new evidence contradicts it: then one re-run, re-record. A verdict
     is challengeable with cause, never frozen.
   - **Paid-API pre-flight (decided 2026-07-14):** before dispatching any unit that
     will call a paid external API, validate credentials/reachability with one minimal
     probe — prefer an unmetered auth/reachability endpoint over a billable call. The
     ledger records **only PASS/FAIL + endpoint** (never response bodies, tokens, or
     credential material). Re-probe after credential rotation or any auth failure;
     "validated earlier this session" does not survive a 401.

   **Per dispatch unit (strictly sequential — never dispatch implementers in parallel):**

   a. Record `BASE=$(git rev-parse HEAD)`.

   b. Classify the unit (by its heaviest task), which decides whether its phase needs
      a review in (e):
      - **mechanical** — pure renames, comment/doc sweeps, checkbox/validator runs,
        config touch-ups with no behavior change
      - **code-bearing** — anything that changes behavior, reshapes a seam, or
        adds/modifies tests

   c. Dispatch an implementer subagent. The prompt contains:
      - The artifact paths from `contextFiles`, introduced as "read these first — they
        are your requirements"
      - The unit's task ID(s) + their verbatim text from tasks.md (a multi-task unit
        gets every task's text and the ordering between them, e.g. RED then GREEN)
      - Any interface or decision from an earlier task the artifacts can't know
        (usually nothing — the subagent can read the code)
      - The report-file path `.apply/task-<id>-report.md`: everything **unit-specific**
        goes there — what was implemented and why, files changed, deviations from
        tasks.md, TDD RED/GREEN evidence when the task orders tests first, self-review
        findings, concerns, interfaces produced, and a one-line per-unit gate assertion
        ("full suite green: N passed, typecheck clean"). **Report diet (decided
        2026-07-14):** repeated boilerplate — full suite tails, known pre-existing
        warnings, branch-hygiene recitals — does NOT go in reports; it lives as one
        ledger line per phase, and beyond its assertion line the report says "gates
        green (see ledger)"
      - **Gate-intent verification (decided 2026-07-14):** in every phase — including
        mechanical and deferred-tier ones — verify each gate's *intent* (the property
        the gate exists to establish: hermeticity, isolation, contract byte-identity),
        not just its exit code, and record findings in the report (evidence: the
        DEEPGRAM key leaking into "hermetic" e2e servers was the period's highest-value
        catch, found exactly this way in a phase with no reviewer)
      - **Frozen-surface self-check:** a unit touching frozen-surface-adjacent code adds
        one affirmative line to its report — "emits only statuses/shapes/headers in the
        authorized delta: yes/no + list" — so silence is a checked assertion, not an
        omission
      - The return contract: **≤15 lines** — STATUS (`DONE` | `DONE_WITH_CONCERNS` |
        `BLOCKED` | `NEEDS_CONTEXT`), commits (short SHA + subject), one-line test
        summary, concerns, report path
      - Requirements: follow the task's own test ordering (tests-first where it says
        so); `npm run typecheck` + `npm test` green before committing; conventional
        commits; locate code by content, not stale `file:line` anchors; CLAUDE.md
        invariants bind (frozen HTTP/WS contract, synchronous hub RPCs, etc.)
      - **Staging discipline (decided 2026-07-27):** stage explicit paths only — never
        `git add -A`, `git add .`, or `commit -a` — and report any unexplained
        working-tree entry rather than sweeping it into a commit (subagents author
        most of a branch's commits, so the discipline binds them too; evidence: a
        1.3 MB QA screenshot literally named `-s` — a flag consumed as a filename —
        swept into a commit whose message claimed only checkbox ticks)
      - Model tier: cheapest that fits, and implementers do NOT default to the top
        tier — by apply time the hard reasoning is done and lives in the gated
        artifacts; implementation is execution against them. Light model for
        mechanical units; **mid-tier (sonnet) is the default for code-bearing
        units**, including multi-file integration. The top tier (fable/opus-class)
        is exception-only — reserve it for a unit that genuinely needs fresh
        judgment the artifacts can't encode (e.g. gnarly concurrent/ordering
        semantics with no spec'd answer), and record the justification in the
        ledger's unit line. Review tiers are unchanged: phase reviewers keep the
        mid-tier floor; the final whole-branch review keeps the most capable model.

   d. Handle the returned status:
      - `DONE` → proceed to (e)
      - `DONE_WITH_CONCERNS` → read the concerns (not the report body). **A concern
        touching the frozen HTTP/WS contract surface (a status code, JSON shape,
        header/range semantic, export body, or WS emission absent from the change's
        authorized delta) is a gate question: escalate to the owner and resolve it —
        including any delta amendment — before the next dispatch; never park it for
        the phase review** (decided 2026-07-14; the deepgram 499, self-flagged at
        commit time, still cost a phase-review FAIL + fix wave + three artifact edits
        to adjudicate). This is a latency fast-path, not a guard — detection stays
        with the phase reviews and the audit's contract feed. Other correctness/scope
        concerns are addressed before review; observations noted in the ledger
      - `NEEDS_CONTEXT` → supply what's missing, re-dispatch
      - `BLOCKED` → change something: more context, a more capable model, a smaller
        split, or escalate to the user if the artifacts themselves are wrong. Never
        retry unchanged.

   e. **Review gate (per phase, risk-tiered):** reviews run once per numbered phase
      (a `## N.` heading in tasks.md), after the phase's LAST task clears — not per
      task. At phase partition time, record the phase's review tier in the ledger
      (decided 2026-07-14, replacing the code-bearing/mechanical threshold —
      evidence: across the first 4 applied changes, every Important+ phase finding
      was in a full-tier category; all other phases reviewed uniformly clean):
      - **full** — any task in the phase touches the frozen HTTP/WS contract
        surface, auth/authorization or security-sensitive validation (redirect
        targets, session cookies, input that gates access), concurrency/caching/
        transaction/ordering semantics, or destructive data ops (migrations, bulk
        rewrites/deletes). **When in doubt, tier full.**
      - **deferred** — code-bearing but none of the above (pure UI with tests,
        e2e/test-harness-only work, docs+config): skip the phase reviewer; the
        always-on whole-branch review covers it. Ledger:
        `Phase <N>: review deferred (risk-tier: <one-line reason>)`.
      - **mechanical** — only mechanical tasks: skip, as before.
      - For a **full**-tier phase → write the phase's cumulative diff to a file this
        session never reads (PHASE_BASE = HEAD before the phase's first task, from
        the ledger):
        `{ git log --oneline $PHASE_BASE..HEAD; git diff --stat $PHASE_BASE..HEAD; git diff -U10 $PHASE_BASE..HEAD; } > openspec/changes/<name>/.apply/phase-<N>-diff.txt`
        Dispatch a reviewer subagent (mid-tier model floor) with the diff path, the
        spec/design paths, and the phase's task report paths. It must return **two
        verdicts**: spec compliance (the diff does what the phase's tasks + spec
        require — nothing missing, nothing extra) and code quality — plus a closing
        **Orchestrator notes** section (≤5 bullets): forward-relevant facts only —
        interfaces later phases will consume, seams/helpers created, residuals
        accepted, config defaults that bind future work. The orchestrator copies
        these into the ledger verbatim; they are the phase's compressed handoff.
        Critical/Important findings → dispatch a fix subagent (fixes + re-runs
        covering tests, appends results to the phase's reports) → re-review. Loop
        until clean. Do not pre-judge findings in the reviewer prompt ("don't flag
        X" is a red flag).
      - **Fix-wave re-reviews are scoped to the fix diff** (decided 2026-07-14 —
        4/4 cumulative re-reads across the first applied changes found nothing
        new): write `git diff -U10 <pre-fix HEAD>..HEAD` to
        `.apply/phase-<N>-fix-diff.txt`; the re-reviewer gets that path, the
        original findings, and the original reviewer's notes, and verifies each
        finding is closed and the fix introduces no regressions — NOT a full
        cumulative re-read. Escalate to a fresh cumulative re-review only if the
        fix wave reshaped the phase beyond the findings themselves.
      - **Merge-blocking fixes ship demonstrated (decided 2026-07-27):** a fix wave
        closing a finding the review marks merge-blocking, or whose consequence is
        silent wrong behavior — the trigger is the consequence, never a severity
        label — records in the fix report (a) the failure demonstrated on the
        pre-fix code **reproducibly**: a named failing test, or a named command with
        its wrong output; prose "observed the bug" does not qualify — and (b) a
        **mutation check** on the fix's central guarantee: re-introduce the defect
        (or null out the guard), name the specific test(s) that fail, revert, show
        green — **working-tree-only, never committed**. "Full suite green after
        fix" alone does not close such a finding. The scoped re-review
        **re-executes the recorded mutation** (observe red, revert, observe green)
        and remains expected to run one of its own choosing — the record supplements
        the independent adversarial check, never replaces it (evidence: a Critical's
        fix passed every gate until the re-reviewer mutated the new provider to
        `{ clips: [] }` and the whole web suite stayed green — the parity test
        asserted against a hand-written mirror).
      - Mid-phase, tasks still get no individual reviewer — but a `DONE_WITH_CONCERNS`
        correctness concern is addressed before the next dispatch, not parked until
        the phase review.

   f. Bookkeeping: tick every checkbox the unit covers in tasks.md (`- [ ]` → `- [x]`)
      and append one ledger line per unit, plus two per phase when its gate resolves —
      the review line and the phase gate tail (the single home for suite counts, known
      pre-existing warnings, and branch-hygiene state that reports no longer repeat):
      `Task <id(s)>: complete (commits <base7>..<head7>)`
      `Phase <N>: review clean (phase-<N>-diff.txt) | skipped-mechanical`
      `Phase <N> gates: <suite counts, typecheck, known warnings, hygiene>`
      **Bookkeeping commits stage explicit paths (decided 2026-07-27):** never
      `git add -A`, `git add .`, or `commit -a` — read `git status --porcelain`
      before each commit, and give every unexplained path a **ledger disposition
      line** (path, origin if known, deleted / committed-under-task-N), with
      delete-unless-claimed the default; a silent "looks fine, proceed" leaves no
      evidence (evidence: an orchestrator sweep committed the 1.3 MB stray `-s`
      binary under a checkbox-tick message, and history had to be rewritten to
      remove it). The one-change-in-flight setup rule exists partly so `git add -A`
      is never necessary — a supposedly-clean tree is no exemption.

   **Pause if:**
   - Task is unclear → ask for clarification
   - Implementation reveals a design issue → suggest updating artifacts
   - A blocker you cannot resolve → report and wait for guidance
   - User interrupts

7. **Final whole-branch review (always, after all tasks) — a layered scoped audit,
   not a cumulative re-read** (decided 2026-07-14, replacing the full-branch-diff
   re-read: its internal-quality yield on full-tier-reviewed code was 0/4 across the
   first applied changes, but its contract/seam inputs are irreplaceable)

   Build the audit package from the ledger's recorded PHASE_BASE SHAs. It ALWAYS
   includes:
   - the **full diffs of deferred and mechanical phases** — the audit is their sole
     reviewer;
   - the **contract/seam-relevant diffs of every phase** that touched the observable
     HTTP/WS surface or produced/consumed a cross-phase interface, regardless of the
     phase's tier or review outcome;
   - the **full diffs of clean phases that share files or state with deferred
     phases** (emergent shared-state interactions aren't declared interfaces);
   - a **full re-read of any phase whose code was modified after its review closed**
     (later fix waves re-open the phase for the audit);
   - the branch's **materialized file list** (decided 2026-07-27): `git diff --stat
     main...HEAD` and `git log --stat`, plus the result of a **mechanical stray-file
     scan** run at package-build time — flag binaries, files over ~100 KB, and names
     shaped like command-line artifacts (`-s`, `--flag`); that list is illustrative,
     not exhaustive — the load-bearing test is "accounted for by tasks/ledger". The
     scan is mechanical work and stays at build time; the audit *reviews* the scan
     rather than performing it (evidence: no reviewer ever had the stray `-s` binary
     in view — no audit package carried a stat section);
   - **all call sites of every declared seam, packaged together** (decided
     2026-07-27) — regardless of the calling phases' tiers or review outcomes.
   Reports + reviewer notes stand in ONLY for the internal-quality re-read of
   non-contract code in full-tier phases that **closed clean** — clean means no open
   Critical/Important findings; accepted minors carry to the audit's triage list.
   **Exclusion may never drop contract- or seam-touching hunks from the package** —
   when partitioning the diffs is ambiguous, include the phase's full diff.

   **Package integrity (decided 2026-07-27):** before dispatch, verify every phase
   section is **non-empty** and that the per-phase diffs reconcile against the
   `main...HEAD` totals — a silent truncation is a **build failure to fix, never a
   quieter audit** (evidence: `audit-package-deferred.txt` ended at its phase-11
   header with no content, so one nominally audit-covered phase was reviewed by no
   one, and neither builder nor auditor noticed).

   Write the package to `.apply/audit-package-*.txt` files this session never reads.
   Dispatch one reviewer on the **most capable model** with those paths, all artifact
   paths, and the ledger. Its charter, beyond the package: audit the branch's complete
   observable HTTP/WS surface delta against the authorized delta specs end-to-end;
   answer **tree hygiene in affirmative-evidence form** (decided 2026-07-27) — file
   count plus "flagged: none" or the flagged list with dispositions, the
   frozen-surface self-check's yes/no + list pattern, so a one-liner cannot satisfy
   it; check every declared-seam call site **against the declared property** (its
   agreement with the external consumer, not merely with the other callers), with
   declared seams a **floor, not a ceiling** — still question any undeclared
   caller-supplied parameter found independently satisfied (decided 2026-07-27);
   triage every minor and carry-note accumulated in the ledger; catalogue residuals
   and invariants for archive. It ends with an **Orchestrator notes** section (≤5
   bullets) — oriented at merge/archive: residuals to record in the archived change,
   follow-on work worth a roadmap note, invariants the merge must not disturb. If it
   returns findings, dispatch **one** fix subagent with the complete list — not one
   per finding — then re-review (fix-diff-scoped, as with phase reviews; a
   merge-blocking / silent-wrong-behavior finding carries step 6e's
   demonstrated-failure + mutation-check obligation, and the re-review re-executes
   the recorded mutation and runs one of its own). When clean,
   suggest merge back to `main` and archive.

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
✓ Task complete (ledger + checkbox updated)

Working on task 4/7: <task description> [mechanical — last task of phase 2]
[dispatch implementer → DONE, 1 commit, "typecheck + suite green"]
[phase 2 tiered full (touches frozen contract) → diff → .apply/phase-2-diff.txt;
 dispatch reviewer → spec ✅, quality approved]
✓ Phase 2 complete (ledger + checkboxes updated)
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
- **Never execute tasks against untracked planning artifacts** — the gated artifacts are
  committed before the first dispatch (see Setup)
- **Never implement inline** — every code change goes through an implementer subagent
- **Never read diffs, code, or full test logs into the orchestrator session** — hand them
  over as file paths
- **Never dispatch implementer subagents in parallel** — dispatch units run strictly
  sequentially
- **Every committer stages explicit paths — never `git add -A`, `git add .`, or
  `commit -a`** — the orchestrator reads `git status --porcelain` before each
  bookkeeping commit and dispositions every unexplained path on the ledger
  (delete-unless-claimed); implementer dispatch prompts carry the same discipline,
  and implementers report unexplained tree entries rather than sweeping them
- **Partition each phase into dispatch units before its first dispatch** — TDD pairs
  always share a unit; same-files/same-seam tasks usually should; record the partition
  in the ledger, and preassign the shared home for any logic multiple units (or
  landed code + a later task) will need — implementers never duplicate it or write
  scope comments that misstate scope
- **Declare seams at partition, revisiting every subsequent partition** — a
  caller-supplied parameter later phases satisfy independently gets a ledger
  declaration (parameter, property stated against the external consumer — not
  inter-caller uniformity — and calling phases), carried in the calling phases'
  dispatch prompts; the audit packages all its call sites together and checks each
  against the declared property, and declared seams are a floor, not a ceiling
- **Reviews run per phase, not per task, and only for full-tier phases** — one reviewer
  over the phase's cumulative diff after its last task; deferred/mechanical phases skip
  to the whole-branch audit, which is the only always-on review; when in doubt about a
  phase's tier, review it
- **A frozen-surface `DONE_WITH_CONCERNS` goes to the owner before the next dispatch**
  — never parked for the phase review; units touching frozen-surface-adjacent code
  include the affirmative authorized-delta self-check line in their report
- **Verify gate intent, not just exit codes, in every phase** — including mechanical
  and deferred-tier phases; record findings in the report
- **One controlled diagnosis per suspected-environmental failure** — verdict + method
  + conditions in the ledger; rejectable with cause, never frozen
- **Probe paid-API credentials before dispatching the unit** — unmetered endpoint
  preferred; ledger records PASS/FAIL + endpoint only, never response bodies or
  credential material
- **Reports carry unit-specific content plus a one-line gate assertion** — repeated
  suite tails, known warnings, and hygiene recitals live once per phase in the ledger
- **A merge-blocking / silent-wrong-behavior fix ships with a reproducible pre-fix
  failure and a working-tree-only mutation check** (named test/command; the mutation
  is never committed) — the scoped re-review re-executes the recorded mutation and
  still runs one of its own; suite-green alone never closes such a finding
- **The whole-branch audit's package may never exclude contract- or seam-touching
  hunks** — reports stand in only for the internal-quality re-read of non-contract
  code in full-tier phases that closed clean (no open Critical/Important findings)
- **The audit package materializes the branch's file list and verifies its own
  integrity** — `git diff --stat main...HEAD` + `git log --stat` + the mechanical
  stray-file scan at build time; every phase section non-empty, per-phase diffs
  reconciling against the `main...HEAD` totals; a truncated package is a build
  failure, never a quieter audit — and the audit answers tree hygiene in
  affirmative-evidence form (count + "flagged: none"/list with dispositions)
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
