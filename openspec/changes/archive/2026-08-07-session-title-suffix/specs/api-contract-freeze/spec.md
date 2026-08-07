## ADDED Requirements

### Requirement: Show title_suffix on show wire; next_episode omitted

Every show object emitted via the shared show serializer (profile `shows[]`,
`GET /api/shows`, and `POST /api/shows` create responses) SHALL include
`title_suffix` as either `"date"` or `"episode"` and SHALL NOT include
`next_episode`. Profile `show_updates[]` entries SHALL accept `title_suffix`
with the same two values. Legacy `next_episode` keys on profile/show update
bodies SHALL be ignored (not persisted) and SHALL NOT cause `400` solely due
to that key. Catalog persistence SHALL store `title_suffix` on `shows`. The
SQLite column `shows.next_episode` MAY remain for rollback safety but SHALL
NOT be bumped on session create and SHALL NOT appear on the show wire.

#### Scenario: Profile show carries title_suffix

- **WHEN** a client reads profile after migration
- **THEN** each `shows[]` entry includes `title_suffix` of `"date"` or
  `"episode"` and omits `next_episode`

#### Scenario: Shows list matches profile show shape

- **WHEN** a client reads `GET /api/shows` after migration
- **THEN** each show object includes `title_suffix` and omits `next_episode`

#### Scenario: Profile update persists title_suffix

- **WHEN** a client PUTs profile with `show_updates[].title_suffix` set to
  `"episode"`
- **THEN** a subsequent profile read returns that show with
  `title_suffix: "episode"`

#### Scenario: Legacy next_episode on update is ignored

- **WHEN** a client PUTs profile with `show_updates[].next_episode` set
- **THEN** the update succeeds without failing solely due to that key and no
  next-episode counter is written as a live product field

### Requirement: Wire deck_title equals stored session title

Wherever the frozen HTTP surface emits `deck_title` for a session (including
`GET /api/companion/state` when `session` is non-null, session list/detail
serializers, and session status payloads that already include `deck_title`),
`deck_title` SHALL equal the trimmed stored session `title`, or `"—"` if that
title is blank. Field names and surrounding object shapes remain unchanged;
only the value derivation is authorized to change from
`{show_code} - {episode}` (when a show code is present) to the stored title.

#### Scenario: Companion deck_title tracks title

- **WHEN** Companion state is fetched for an active session titled `HD_260802`
- **THEN** `session.deck_title` is `HD_260802`

#### Scenario: Session list deck_title tracks title

- **WHEN** a session list entry is serialized for a session titled `HD_260802`
  with a non-blank show code
- **THEN** that entry's `deck_title` is `HD_260802`

### Requirement: Create-session optional episode under date suffix

`POST /api/sessions` SHALL continue to accept an optional `title`. When `title`
is omitted/blank and the linked show's `title_suffix` is `"date"`, `episode`
MAY be omitted or blank and the server SHALL still create the session with a
derived title per the `session-title-suffix` capability. When the linked show's
`title_suffix` is `"episode"`, a blank `episode` SHALL be rejected with `400`
unless an explicit non-blank `title` bypasses derivation. An explicit non-blank
`title` SHALL win over derivation and SHALL be stored after the existing
create-path trim (leading/trailing whitespace removed).

#### Scenario: Date-suffix create without episode succeeds

- **WHEN** a client creates a session for a date-suffix show without `title` and
  without `episode`
- **THEN** the response is `200` with a derived `title` and the session exists

#### Scenario: Episode-suffix create without episode fails

- **WHEN** a client creates a session for an episode-suffix show without a
  non-blank `episode` and without an explicit title that bypasses derivation
- **THEN** the response is `400 { detail }`
