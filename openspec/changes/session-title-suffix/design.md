# session-title-suffix — design

## Approach

Keep `sessions.episode` for Episode-suffix creates and batch import, but stop treating
episode as the operator-facing identity. Persist a per-show `title_suffix`, derive
untitled create titles on the server, point Timeline meta + Companion `deck_title` at
the stored `title`, and strip Next Ep / Bonus from the UI.

## Decisions

### D1 — Soft-retain `shows.next_episode` column; remove from product + wire

**Decision (gate 2026-08-02):** Keep the SQLite column. Stop bumping it on create.
Omit it from show API objects and Settings. Legacy update keys are ignored
(not persisted as a live counter). Do **not** drop the column in this change.

**Alternatives:** Hard-drop column (cleaner schema, unsafe binary rollback).
**Rationale:** Owner chose soft retain for rollback safety; product "remove Next
Ep altogether" is satisfied by UI + wire + no bump.

### D2 — Date suffix uses UTC calendar date of create timestamp

**Decision:** `YYMMDD` comes from the UTC date of the single create-path clock
read used for `started_at_utc` / `created_at_utc`.

**Alternatives:** Server local TZ; operator TZ setting (no such setting exists).
**Rationale:** Deterministic for tests and single-process deploys.

### D3 — Collision numbering: max occupied suffix + 1

**Decision (gate 2026-08-02):** First title of the day is bare `CODE_YYMMDD`.
Duplicates use `_002`, `_003`, … via **max occupied numeric slot + 1**:

- Consider index rows for that show (**including archived and `ui_hidden`**)
  whose `title` equals `base` or equals `base` + `_` + one or more ASCII digits
  (literal prefix match; no SQL/regex wildcards on the code).
- Bare `base` occupies slot `1`. A title `base_N` occupies slot `N` (decimal).
- Let `M` be the maximum occupied slot, or `0` if none.
- If `M = 0`, title is `base`. If `M ≥ 1`, title is `base` + `_` +
  zero-padded decimal of `M + 1` to width at least 3 (so `2` → `_002`; values
  `≥ 1000` use their full decimal width).

Allocate and insert in the same catalog transaction. Gaps after renames are OK;
allocation does not reuse an occupied slot.

**Alternatives:** Lowest unused ≥2; count-based (rejected — can duplicate).
**Rationale:** Owner chose A; matches product examples without duplicate risk.

### D4 — Episode padding width 4 for values ≤ 9999

**Decision:** Pure digit strings with integer value ≤ 9999 → `padStart(4, '0')`.
Values > 9999 and non-numeric tokens unchanged. Leading-zero digit strings are
evaluated by integer value then re-padded when ≤9999 (`00001` → `0001`).

**Alternatives:** Always 5-digit pad; pad only by string length.
**Rationale:** Owner examples (`0001`, `0002`) and “up to 10000”.

### D5 — Wire deck_title = stored title

**Decision:** Shared `sessionDeckDisplayTitle` (Companion, session list/detail,
session status) returns trimmed stored `title`, or `"—"` if blank. Timeline meta
uses session `title` in the former Episode slot.

**Alternatives:** Companion-only mapping; keep `code - episode`.
**Rationale:** One identity everywhere; owner asked Companion to show session name.

### D6 — Create body: episode optional only for date-suffix derivation

**Decision:** If deriving under `date`, allow blank/omitted episode (store `''`).
If `episode` suffix, require non-blank episode unless explicit non-blank `title`.
Explicit `title` wins over derivation and is stored after existing trim.

**Alternatives:** Always require episode; client fabricates date into episode.
**Rationale:** Avoid fake episode values when Date mode hides the field.

### D7 — Migrated shows → `episode`; new shows → `date`

**Decision (gate 2026-08-02):** Migration backfills existing shows to
`title_suffix = 'episode'`. Column / create default for newly inserted shows is
`date`.

**Alternatives:** All existing → `date`.
**Rationale:** Owner chose preserve episode workflow for current shows; Date is
the default going forward for new shows.

### D8 — Legacy `next_episode` on updates: ignore/strip

**Decision (gate 2026-08-02):** Do not require `400` when a stale client sends
`next_episode`. Strip/ignore; do not persist counter semantics.

## Invariants (do not "helpfully" undo)

- Do not remove `sessions.episode` in this change.
- Do not drop `shows.next_episode` in this change (soft-retained).
- Do not invent a unique DB constraint on titles; collision handling is
  application-level at create time only.
- API contract changes require the freeze delta in this change — do not treat
  `next_episode` wire removal or `deck_title` semantics as a small fix later.

## Risks

- **Stale clients** sending `next_episode` succeed but the field is ignored
  (gate: ignore/strip).
- **Companion overlays** flip from `CODE - N` to session titles (intended).
- **Max-suffix collision** leaves gaps after renames (accepted).
- **Soft-retained column** can confuse future readers — comment in migration /
  store that it is unused.

## Panel & review log

### Pre-panel fact-check — 2026-08-02

Method: property-level verify against live `server/src` + `web/src` (full helper /
route bodies on claim-relevant paths). `openspec validate session-title-suffix
--strict` → valid.

| # | Property claimed | Verdict | Evidence |
|---|------------------|---------|----------|
| F1 | Timeline meta is `Episode {episode}` when show linked | CONFIRMED | `Timeline.tsx` |
| F2 | New Session has Bonus + seeds from `next_episode` | CONFIRMED | `NewSessionModal.tsx` |
| F3 | Settings Next Ep + profile `next_episode` | CONFIRMED | `HomeSettingsModal.tsx`, schemas, `0001_init.sql` |
| F4 | Untitled create uses `{code} - {episode}` | CONFIRMED | `sessions.ts` + `sessionDeckDisplayTitle` |
| F5 | Create bumps `next_episode` | CONFIRMED | `sessionIndexStore.ts` |
| F6 | Create requires non-blank `episode` today | CONFIRMED | `newSessionBodySchema` |
| F7 | `deck_title` only on Companion | FALSE → corrected | list + status + Companion |
| F8 | Batch import sends explicit title | CONFIRMED (panel) | `runner.ts` stem → title+episode |
| F9 | `show_title_format` unused by new Suffix UI | CONFIRMED | Non-Goal |
| F10 | Collision algorithm / inventory | resolved at gate | D3 = max+1; include hidden/archived |

### Adversarial panel — 2026-08-02

Reviewers: Requirements, Assumptions, Failure & abuse, Scope & simpler.
Synthesis rejected apply-readiness until gate; majors folded; conflicts escalated.

### Blockers / majors fixed in place

(See pre-gate fold list from 2026-08-02 panel synthesis — deck_title scope,
show serializer surfaces, trim wording, Date episode blanking, blank code 400,
pad edges, tasks coverage.)

### Escalated to gate — dispositions 2026-08-02

| # | Question | Ruling |
|---|----------|--------|
| 1 | Collision algorithm | **A — max occupied suffix + 1** → D3 |
| 2 | `next_episode` column | **Soft retain** → D1 |
| 3 | Migration default | **Existing → episode, new → date** → D7 |
| 4 | Stale `next_episode` on update | **Ignore/strip** → D8 |

### Minors accepted as residual

- No timezone picker (UTC) — Non-Goal.
- Control/bidi weird episode tokens remain accepted when non-numeric.
- Suffix width grows past three digits when `M + 1 ≥ 1000`.

### Post-gate consistency read — 2026-08-02

Read: `proposal.md`, `design.md`, both delta specs, `tasks.md`. Findings fixed
in place: (1) this log entry was still pending — filled; (2) freeze wording
`NEED NOT cause 400` → `SHALL NOT cause 400 solely due to that key`. Otherwise
clean against gate rulings (max+1, soft-retain column, existing→episode /
new→date, ignore/strip).
