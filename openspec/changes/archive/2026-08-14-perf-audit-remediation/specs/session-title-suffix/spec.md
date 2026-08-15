# session-title-suffix — delta

## MODIFIED Requirements

### Requirement: Show title-suffix preference

Each show SHALL persist a `title_suffix` preference with exactly two allowed
values: `date` and `episode`. After migration, every **pre-existing** show
SHALL have `title_suffix: "episode"`. Newly created shows SHALL default to
`title_suffix: "date"`. Profile show reads and `show_updates` writes SHALL
round-trip `title_suffix`: it is one of the five keys the **brief** show entry
`GET /api/profile` emits (`{id, studio_id, name, show_code, title_suffix}`), deliberately
retained there because an always-loaded surface decides whether to ask for an episode
number the moment a show is selected. A show's **full** configuration — categories and
palettes — is not on profile and SHALL be read from `GET /api/shows?studio_id=…` or
`GET /api/shows/:showId`, which also carry `title_suffix`. The Settings General tab SHALL
expose a **Suffix** control immediately after **Code** with labels **Date** and **Episode
Number** mapped to those values. The Settings General tab SHALL NOT expose **Next Ep**.

#### Scenario: Operator sets Date suffix

- **WHEN** the operator selects Suffix = Date for a show and saves profile
- **THEN** subsequent profile reads for that show include `title_suffix: "date"` on its
  brief `shows[]` entry

#### Scenario: Operator sets Episode Number suffix

- **WHEN** the operator selects Suffix = Episode Number for a show and saves
  profile
- **THEN** subsequent profile reads for that show include `title_suffix: "episode"` on its
  brief `shows[]` entry

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
