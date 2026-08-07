## Purpose

Defines how Autologger names new sessions from a show's code and title-suffix
preference, how that preference is edited in Settings, and how the session
workspace and Companion surface the resulting session name.

## ADDED Requirements

### Requirement: Show title-suffix preference

Each show SHALL persist a `title_suffix` preference with exactly two allowed
values: `date` and `episode`. After migration, every **pre-existing** show
SHALL have `title_suffix: "episode"`. Newly created shows SHALL default to
`title_suffix: "date"`. Profile show reads and `show_updates` writes SHALL
round-trip `title_suffix`. The Settings General tab SHALL expose a **Suffix**
control immediately after **Code** with labels **Date** and **Episode Number**
mapped to those values. The Settings General tab SHALL NOT expose **Next Ep**.

#### Scenario: Operator sets Date suffix

- **WHEN** the operator selects Suffix = Date for a show and saves profile
- **THEN** subsequent profile reads for that show include `title_suffix: "date"`

#### Scenario: Operator sets Episode Number suffix

- **WHEN** the operator selects Suffix = Episode Number for a show and saves
  profile
- **THEN** subsequent profile reads for that show include `title_suffix: "episode"`

#### Scenario: Next Ep is gone from Settings

- **WHEN** the operator opens Settings → General for a show
- **THEN** no Next Ep (or equivalent next-episode) control is present

#### Scenario: Migrated show keeps Episode Number

- **WHEN** a show that existed before migration is read after migration with no
  intervening suffix edit
- **THEN** that show has `title_suffix: "episode"`

#### Scenario: Newly created show defaults to Date

- **WHEN** a show is created after migration
- **THEN** that show has `title_suffix: "date"` until changed

### Requirement: Create-session title derivation

When `POST /api/sessions` omits `title` (or sends null/blank) and the session is
linked to a show, the server SHALL set `sessions.title` from the show's
`show_code` and `title_suffix` as follows:

- **Date**: Derivation REQUIRES a non-blank trimmed show code; otherwise create
  SHALL fail with `400`. Let `base` be `{CODE}_{YYMMDD}` using that code and the
  UTC calendar date of the single create-path clock read used for
  `started_at_utc`/`created_at_utc` (`YY` = year mod 100, zero-padded month and
  day). Among index rows for that show (**including archived and `ui_hidden`**)
  whose `title` equals `base` or equals `base` + `_` + one or more ASCII digits
  (literal match), bare `base` occupies slot `1` and `base_N` occupies slot `N`.
  Let `M` be the maximum occupied slot, or `0` if none. If `M = 0`, the title
  SHALL be `base`. If `M ≥ 1`, the title SHALL be `base` + `_` + the decimal
  representation of `M + 1` zero-padded to width at least 3. Allocation and
  insert SHALL run in the same catalog transaction. Under Date derivation the
  stored `episode` SHALL be `''` (request episode omitted or blank; non-blank
  episode in the body SHALL NOT be retained as a fake episode value).
- **Episode**: the request SHALL include a non-blank `episode` unless an
  explicit non-blank `title` is supplied. Let `token` be that trimmed episode
  string. If `token` matches `^\d+$` and its integer value is less than or
  equal to 9999, `token` SHALL be left-padded with zeros to width 4 (e.g. `1`
  → `0001`, `12` → `0012`, `9999` → `9999`). If `token` is non-numeric, or is
  a number greater than 9999 (e.g. `10000`), `token` SHALL be used unchanged
  (no zero-padding). Leading-zero digit strings are evaluated by integer value
  then re-padded to width 4 when ≤9999 (e.g. `00001` → `0001`). The title
  SHALL be `{CODE}_{token}`. Derivation REQUIRES a non-blank trimmed show code;
  otherwise create SHALL fail with `400`.

An explicit non-blank `title` in the create body SHALL win over derivation
(batch import and other callers) and SHALL be stored after the existing
create-path trim. Creating a session SHALL NOT update any per-show
next-episode counter.

#### Scenario: First date-suffix session of the UTC day

- **WHEN** a show with code `HD` and `title_suffix: "date"` creates a session
  without a title on UTC date 2026-08-02 and no prior title matches `HD_260802`
  or `HD_260802_` + digits
- **THEN** the created session's `title` is `HD_260802`

#### Scenario: Second date-suffix session the same UTC day

- **WHEN** that show creates another untitled session on the same UTC date and
  one prior title already equals `HD_260802`
- **THEN** the created session's `title` is `HD_260802_002`

#### Scenario: Date collision uses max suffix after a gap

- **WHEN** titles `HD_260802` and `HD_260802_003` already exist for the show and
  another untitled date-suffix session is created on that UTC day
- **THEN** the created session's `title` is `HD_260802_004`

#### Scenario: Numeric episode title is zero-padded

- **WHEN** a show with code `HD` and `title_suffix: "episode"` creates a session
  with `episode: "7"` and no explicit title
- **THEN** the created session's `title` is `HD_0007`

#### Scenario: Non-numeric episode is not padded

- **WHEN** a show with `title_suffix: "episode"` creates a session with
  `episode: "Pilot"` and no explicit title
- **THEN** the created session's `title` is `{CODE}_Pilot`

#### Scenario: Explicit title wins over derivation

- **WHEN** create is called with a non-blank `title`
- **THEN** that title is stored after create-path trim (suffix derivation does
  not run)

### Requirement: New Session modal respects suffix

The New Session modal SHALL omit the Bonus episode control. The episode input
SHALL be visible and required only when the selected show's `title_suffix` is
`episode`. When the selected show's `title_suffix` is `date`, the episode input
SHALL be hidden and the create request SHALL omit `episode` or send it blank
(server Date derivation applies; no stale episode from a prior show selection).
The modal SHALL NOT display or seed a next-episode default from the show.

#### Scenario: Episode field hidden for Date suffix

- **WHEN** the selected show has `title_suffix: "date"`
- **THEN** the New Session modal does not show an episode field or Bonus control

#### Scenario: Episode field shown for Episode Number suffix

- **WHEN** the selected show has `title_suffix: "episode"`
- **THEN** the New Session modal shows an episode field, does not show Bonus,
  and refuses submit while episode is blank

### Requirement: Session meta shows session title instead of Episode N

While a session with a linked show is open, the workspace's session-meta
display (the fused strip's `sessionMeta` line — the former Timeline header
slot; the literal `Episode {episode}` display was already removed by unrelated
prior strip work) SHALL render the session's `title` (session name) sourced
from the stored title, and SHALL NOT render an `Episode` label. The show-name
heading behavior MAY remain unchanged.

#### Scenario: Open session shows title in meta

- **WHEN** the operator views a session whose title is `HD_260802` and whose
  status includes a show code
- **THEN** the session-meta line includes `HD_260802` and does not include the
  literal label `Episode`

### Requirement: Wire deck_title is the session name

Every frozen HTTP surface that emits a session `deck_title` (Companion state,
session list/detail, session status) SHALL set that field to the session's
stored `title` (trimmed), falling back to `"—"` only when the stored title is
blank. It SHALL NOT recompute deck title as `{show_code} - {episode}` when a
show code is present.

#### Scenario: Companion reflects stored title

- **WHEN** the active session title is `HD_260802` and Companion fetches state
- **THEN** `session.deck_title` equals `HD_260802`

#### Scenario: Session status reflects stored title

- **WHEN** session status is fetched for a titled session with a show code
- **THEN** `deck_title` equals the stored `title`
