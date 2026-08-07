# session-title-suffix — proposal

## Why

Session chrome surfaces a redundant "Episode N" line beside the show name, while
the useful identity operators care about is the session title (e.g. `HD - test`).
Creation naming today is `show_code - episode` with a Bonus toggle and a
settings "Next Ep" counter — none of which match how operators want sessions
named (`HD_260802`, duplicates `HD_260802_002`, or padded episode numbers).

## What Changes

- **Session-meta display**: the workspace chrome shows the session **title**
  (session name) beside the show name — no `Episode [n]` meta. (Pre-apply
  staleness note 2026-08-07: the literal Episode display was already removed by
  unrelated strip work — da14b20 — and the slot now lives in
  `MaximizeLogStrip.tsx`'s `sessionMeta`, which already prefers `title`; this
  change's remaining work is wiring that display to the new derivation/
  `deck_title` semantics, not removing a display.)
- **Show settings (General)**: after **Code**, add **Suffix** dropdown with
  `Date` | `Episode Number`. Remove **Next Ep** from the UI and from the show
  wire (**BREAKING** show shape: `next_episode` omitted; `title_suffix` added).
  The DB column `shows.next_episode` is **retained unused** (no bump, not on
  wire) for safer binary rollback.
- **New Session modal**: remove the Bonus toggle. Show the episode field **only**
  when the selected show's Suffix is `Episode Number`. Creation titles become
  `[code]_[suffix]` (see design for date collision + episode padding rules).
- **Server title generation**: when `POST /api/sessions` omits `title`, derive
  it from the show's code + suffix preference (not `code - episode`).
- **`deck_title` wire semantics**: every frozen surface that emits session
  `deck_title` (Companion state, session list/detail, session status) SHALL
  equal the session's stored `title`, not a recomputed `code - episode`
  string (**BREAKING** semantic change to an existing field; shape unchanged).
- **Batch import**: unchanged (filename stem → title/episode); no requirement
  to adopt the new naming scheme.

## Capabilities

### New Capabilities

- `session-title-suffix`: show-level title-suffix preference, create-time title
  derivation (date / episode), New Session / Settings UI, Timeline title meta,
  and Companion deck_title = stored title.

### Modified Capabilities

- `api-contract-freeze`: authorize (1) new/changed show fields
  (`title_suffix` added; `next_episode` removed from show wire, column retained),
  (2) create-session title derivation / optional episode when date suffix,
  (3) session `deck_title` semantics = stored session title on all emitters.

## Impact

- **Web**: `Timeline`, `HomeSettingsModal`, `NewSessionModal`, show draft types,
  tests; visual baselines for new-session / settings modals.
- **Server**: show schema + migration (`title_suffix`), profile/show validation,
  `sessionDeckDisplayTitle` / create path, stop next-episode bump, Companion
  state, tests, README if inventory prose mentions deck_title derivation.
- **Companion**: variable that surfaces `deck_title` now tracks session title
  (no module API shape change beyond the string value semantics).
- **Contract**: yes — show shape and `deck_title` meaning; create-session may
  make `episode` optional when title is server-derived under Date suffix.
- **DB**: new `shows.title_suffix` (migrated shows → `episode`; new shows →
  `date`); retain unused `shows.next_episode`; keep `sessions.episode`.

## Non-Goals

- Renaming existing sessions or backfilling old titles to the new scheme.
- Changing batch-import matching/create naming.
- Removing `sessions.episode` column or event export shapes.
- Dropping `shows.next_episode` from SQLite (soft-retained).
- Timezone picker for Date suffix (use UTC calendar date of create timestamp).
- Restoring or wiring the unused studio `show_title_format` /
  `title_prefix` settings blob into the new UI.
