## MODIFIED Requirements

### Requirement: Generated events append, bounded and attributable

Generation SHALL **append** events by default: when `regenerate` is absent or
false, no existing event is modified or deleted by the run. When
`regenerate` is true and no `selection` is supplied, the server SHALL first
delete every session event whose metadata has `auto_generated === true`, then
append newly generated events under the same per-run created-events cap and
attribution rules (`auto_generated: true` + `auto_generate_run_id`) as today.
Manual (non-auto) events SHALL NOT be deleted. `regenerate: true` combined with
a non-empty `selection` SHALL be rejected with `400`. Each run SHALL still
enforce the per-run created-events cap; further `create_event` calls SHALL
return a tool error naming the cap.

#### Scenario: Generate All appends without deleting

- **WHEN** generate runs with no body or `{ regenerate: false }`
- **THEN** no existing events are deleted and new auto rows may be appended

#### Scenario: Regenerate All deletes auto rows then generates

- **WHEN** generate runs with `{ regenerate: true }` and no `selection`
- **THEN** all `auto_generated` events for the session are deleted before the
  CLI turn, manual events remain, and new auto rows may be appended

#### Scenario: Regenerate with selection is rejected

- **WHEN** generate runs with `{ regenerate: true, selection: [...] }` where
  `selection` is non-empty
- **THEN** the response is `400 { detail }` and no events are deleted

## ADDED Requirements

### Requirement: Optional generate body for regenerate and selection

`POST /api/sessions/:sessionId/events/generate` SHALL accept an optional JSON
body. Absent or empty body SHALL mean Generate All (full instruction-bearing
set, no delete). Fields:

- `regenerate` (boolean, default false)
- `selection` (optional array of `{ category_id, option_label? }`):
  - omitted or empty → full instruction-bearing set
  - non-empty → only matching instruction-bearing **entries** participate
    (button-level when `option_label` is null/omitted; a dropdown option when
    `option_label` equals that option’s stored label and that option has a
    non-empty `auto_instruction`)
  - unknown ids/labels that match nothing SHALL be ignored for membership;
    if after filtering zero instruction entries remain, SHALL `400` (same
    class as no-instructions)

Delete of auto rows (when `regenerate` is true) SHALL occur only after the
existing guard ladder and successful AI-slot acquire, and before CLI spawn,
inside the session hub (transactional bulk delete). A failed pre-guard SHALL
NOT delete events.

On success the response SHALL be `{ created, cap_hit }` and, when
`regenerate` was true, SHALL also include `deleted` (number of auto rows
removed).

#### Scenario: Custom selection filters the run

- **WHEN** generate runs with a `selection` naming one button-level entry and
  one dropdown option entry, and `regenerate` is false
- **THEN** no events are deleted and the run snapshot/prompt/allowlist include
  only those instruction entries

#### Scenario: Empty selection after filter fails

- **WHEN** generate runs with a `selection` that matches no instruction-bearing
  entry
- **THEN** the response is `400 { detail }` and no CLI turn runs
