## MODIFIED Requirements

### Requirement: Generated events append, bounded and attributable

Generation SHALL **append** events by default: when `regenerate` is absent or
false, no existing event is modified or deleted by the run. When
`regenerate` is true and no `selection` is supplied, the server SHALL
snapshot the ids of every session event whose metadata has
`auto_generated === true`, append newly generated events under the same
per-run created-events cap and attribution rules (`auto_generated: true` +
`auto_generate_run_id`) as today, and delete the snapshotted rows only after
the CLI turn succeeds with at least one created event (**delete-after-success**
— see "Optional generate body
for regenerate and selection" for the full ordering, exclusion,
zero-created, and failure semantics). Manual (non-auto) events SHALL NOT be deleted. `regenerate: true`
combined with
a non-empty `selection` SHALL be rejected with `400`. Each run SHALL still
enforce the per-run created-events cap; further `create_event` calls SHALL
return a tool error naming the cap, and the run's response reports
`cap_hit: true`. Each generated event's `metadata_json` SHALL carry
`auto_generated: true` and a per-run `auto_generate_run_id`, so rows are
attributable to their run. A generated insert SHALL otherwise perform **every
side effect a manual insert performs**: the same transactional hub write path,
server-assigned id, one `event.changed` broadcast per insert (unchanged
emission semantics), category label/color UI snapshots merged into metadata
(so later button deletion/rename degrades and relinks identically to manual
rows), and the catalog live projection (`event_count` / max-timecode mirror)
so `GET /api/sessions` stays truthful — the run SHALL leave the catalog
projection current by the time the route responds (on regenerate, current
**including** the post-success delete's decrement) whenever the catalog mirror
write succeeds; if that write fails, the run's own outcome is still returned, a
warning is logged, and the session's next change rewrites the projection
(api-contract-freeze "Catalog mirror failures don't fail saved session changes").

#### Scenario: Generate All appends without deleting

- **WHEN** generate runs with no body or `{ regenerate: false }`
- **THEN** no existing events are deleted and new auto rows may be appended

#### Scenario: Regenerate All replaces auto rows after success

- **WHEN** generate runs with `{ regenerate: true }` and no `selection` and the
  CLI turn succeeds
- **THEN** the pre-run `auto_generated` events are deleted only after the CLI
  turn succeeds, manual events remain, and the run's new auto rows persist

#### Scenario: Regenerate with selection is rejected

- **WHEN** generate runs with `{ regenerate: true, selection: [...] }` where
  `selection` is non-empty
- **THEN** the response is `400 { detail }` and no events are deleted

#### Scenario: Re-run does not duplicate or destroy
- **WHEN** a run previously logged three SLATE events and a second run executes over an
  unchanged transcript without `regenerate`
- **THEN** no existing event is modified or deleted, the second run's prompt embeds
  the three existing SLATE events (complete for that category), and the prompt directs
  the model to log only moments not already logged

#### Scenario: The cap ends writing, not the world
- **WHEN** a run reaches the per-run cap mid-transcript
- **THEN** subsequent `create_event` calls return a tool error, previously created
  events persist, and the route responds `200` with `cap_hit: true`

#### Scenario: Sessions list stays truthful
- **WHEN** a run creates 40 events and completes
- **THEN** `GET /api/sessions` reflects the updated `event_count` without any
  intervening manual write
