# Spec Delta

## Purpose

Lets a signed-in user find sessions, shows, studios and moments (transcript passages, AI topics and events) across every studio they belong to. What they can find matches exactly what the session lists and session content already show them.

## ADDED Requirements

### Requirement: Search covers names, session metadata and moments
Search SHALL match a query against:
- studio display names;
- show names;
- session titles, episodes and notes;
- transcript text;
- AI topic summaries;
- event messages.

Search SHALL return results in four groups:
- `studios`;
- `shows`;
- `sessions`;
- `moments`: transcript passages, topics and events, each tied to its session.

Sessions whose `ui_hidden` flag is set, and sessions with no show, SHALL never appear in any group, and their moments SHALL never appear either.

#### Scenario: A spoken word finds its passage
- **WHEN** a user with access to a show searches for a word spoken in one of its session transcripts
- **THEN** `moments` contains a `transcript` entry for that session whose snippet contains the word

#### Scenario: Topic and event text are searchable
- **WHEN** the query matches a topic summary and an event message in an accessible session
- **THEN** `moments` contains a `topic` entry and an `event` entry for that session

#### Scenario: Hidden sessions never match
- **WHEN** a session whose title, notes and transcript all match the query has `ui_hidden = 1`
- **THEN** neither that session nor any of its moments appears in the response

### Requirement: Search access matches the session lists
The caller SHALL see only results from studios they belong to. Within those studios:
- studio and show names match for every member;
- a session's title and episode match for every member of the show's team;
- a session's notes match, and its moments are returned, only when the caller can access the show (studio owner or admin, or a member holding a grant for the show).

A notes match SHALL NOT be returned, and no notes text SHALL appear in any snippet, for a show the caller cannot access. Notes SHALL NOT influence the ranking or the `match` value of such a show's sessions either. Nothing from a studio the caller does not belong to SHALL appear in any group.

#### Scenario: An ungranted member matches titles only
- **WHEN** a member without a grant for show S searches for a word that appears in a session of S, in its title, in its notes and in its transcript
- **THEN** the session appears in `sessions` with `match: "title"` and no snippet, and `moments` contains nothing from S

#### Scenario: A granted member matches notes and moments
- **WHEN** a member with a grant for show S searches for a word that appears only in a session's notes and transcript
- **THEN** the session appears with `match: "notes"` and a notes snippet, and `moments` contains its transcript entry

#### Scenario: Hidden notes don't affect ranking
- **WHEN** an ungranted member of show S searches for a title word shared by two sessions of S, once adding a word found only in the first session's notes and once adding a word found only in the second's
- **THEN** both searches return the two sessions in the same order, each with `match: "title"`

#### Scenario: Other teams are invisible
- **WHEN** a user searches for the exact title of a session in a team they don't belong to
- **THEN** every group is empty for that session, its show and its studio

### Requirement: Query syntax and normalisation
Search SHALL fold case and accents. Full-text matching SHALL use English stemming and SHALL support:
- quoted phrases;
- `-word` exclusions;
- `or`.

Studio, show and session-title matching SHALL also accept close misspellings and partial names. A query that is only stop words SHALL still run name matching and SHALL NOT fail.

#### Scenario: Stemming and accents
- **WHEN** a transcript says "they were divorced at the café" and the user searches `divorce cafe`
- **THEN** the passage is returned

#### Scenario: A misspelled show name
- **WHEN** a show is named "Christina Ramos Live" and the user searches `christna`
- **THEN** the show appears in `shows`

#### Scenario: Exclusion
- **WHEN** the user searches `budget -wedding` and one passage mentions both words while another mentions only "budget"
- **THEN** only the second passage is returned

### Requirement: Grouping, ranking and limits
- **Size:** each group SHALL hold at most `limit` results (default 5, range 1–25).
- **Ranking:** within a group, results SHALL be ranked by match strength, with newer sessions first on a tie.
- **Variety:** at most 3 moments from one session SHALL appear in the `moments` group.
- **Seek time:** each moment SHALL carry a `kind` (`transcript` | `topic` | `event`) and a `sec`. For a transcript passage, `sec` is the passage's start time in seconds, or null when no word in it has a timing. For topics and events, `sec` is always null; clients place them with their own timeline rules.

#### Scenario: One long session can't fill the moments group
- **WHEN** a single session has 10 matching passages and another session has 1, and `limit` is 5
- **THEN** `moments` holds at most 3 entries from the first session and includes the second session's entry

#### Scenario: Default limit
- **WHEN** a query matches 12 shows and no `limit` is given
- **THEN** `shows` holds 5 entries

### Requirement: Snippets are plain text with sentinel highlights
- **Format:** a snippet SHALL be plain text with each highlighted span between U+E000 and U+E001.
- **Escaping:** before a snippet is built, any U+E000 or U+E001 already in the source text SHALL be removed.
- **Rendering:** clients SHALL render highlights as text elements and SHALL NOT interpret snippet text as HTML.
- **Which results get one:** studio, show and title-matched session results carry no snippet.

#### Scenario: Markup in a transcript is inert
- **WHEN** a transcript passage contains `<img src=x onerror=alert(1)>` near a matching word
- **THEN** the results page shows those characters as literal text, and no element is created from them

#### Scenario: An accented hit is highlighted
- **WHEN** a passage's 35th word is "Café" and the user searches `cafe`
- **THEN** the passage's snippet contains `Café` between the highlight sentinels

#### Scenario: Forged sentinels are stripped
- **WHEN** an event message contains U+E000 and U+E001 around a word that doesn't match the query
- **THEN** that word is not highlighted in the snippet

### Requirement: Filters and the timeout
- **Filters:** search SHALL accept optional `studio_id` and `show_id` filters that narrow every group. A filter naming a studio or show the caller can't see SHALL produce empty groups, exactly as for an id that doesn't exist.
- **Timeout:** the whole search SHALL use at most 3 seconds of database time. A search that runs longer SHALL be cancelled and reported as a timeout, not as a server error.
- **Concurrency:** each server process SHALL run at most 2 searches at once. A search that can't start within 1 second SHALL be reported as busy, so search can never occupy all of the catalog's database connections.

#### Scenario: Filter to one show
- **WHEN** the user searches with `show_id` set to show S
- **THEN** every result in `shows`, `sessions` and `moments` belongs to S, and `studios` holds only S's studio if it matches

#### Scenario: Searches can't starve the app
- **WHEN** 6 slow searches arrive at once on one server process
- **THEN** at most 2 run at a time, those still waiting after 1 second are answered as busy, and an unrelated catalog request made meanwhile completes normally

#### Scenario: A foreign filter reveals nothing
- **WHEN** the user filters by the id of a show in a team they don't belong to, and separately by a random id
- **THEN** both responses are `200` with every group empty, and the two bodies are the same apart from `q`

### Requirement: Command palette and results page
- **Opening the palette:** Cmd/Ctrl-K SHALL open a search palette, unless focus is in a text field or another modal dialog or sheet is open. A search button in the top bar SHALL also open it; its tooltip names the shortcut.
- **Palette behaviour:**
  - it SHALL search after typing pauses for about 200 ms;
  - it SHALL show up to 5 results per group;
  - it SHALL offer "See all results", which opens `/search?q=<query>`.
- **Results page:**
  - `/search` SHALL show every group with up to 25 results each, plus studio and show filters, loading, empty and error states;
  - the query and filters SHALL be kept in the URL.
- **Choosing a result:**
  - a session SHALL open `/sessions/<id>`;
  - a moment SHALL open its moment deep link;
  - a show SHALL become active together with its studio in one profile update; a studio SHALL become the active studio. Both SHALL go through the top bar's switch guard (unsaved Settings changes are confirmed first) and then open the home view.

#### Scenario: Palette to a transcript moment
- **WHEN** the user presses Cmd-K, types a spoken phrase, and chooses the transcript result
- **THEN** the session opens with the timeline at that passage's start time

#### Scenario: A moment in the open session
- **WHEN** session X is open and the user chooses a transcript moment of X from the palette
- **THEN** the timeline moves to that moment without reloading the workspace or starting playback

#### Scenario: See all results
- **WHEN** the user chooses "See all results" in the palette for query `budget`
- **THEN** the app navigates to `/search?q=budget` and shows grouped results

#### Scenario: Choosing a show switches to it
- **WHEN** the user chooses a show result from a different studio
- **THEN** one profile update sets that studio and show as active, and the home view lists that show's sessions
