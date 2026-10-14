# Spec Delta

## ADDED Requirements

### Requirement: AI suggestions
A wiki suggestion SHALL be a proposed full version of one page, written by a wiki-generation run (wiki-generation capability) and kept until a person resolves it. A suggestion has:
- the show and the session whose run wrote it, and the user who started that run;
- a **target**: either an existing page and the **base revision** the proposal was written against, or a new page's kind and title;
- the proposed title, aliases and Markdown body, which follow the page limits and link rules of a manual save, and a plain-text **rationale** of at most 500 characters;
- a **status**: `pending`, `accepted`, `dismissed` or `superseded`.

Rules:
- **Access is show access.** A user who can access the show can list, read, accept and dismiss its suggestions; anyone else gets the masked 404.
- **One pending suggestion per target.** When a run stores a suggestion for a target that already has a pending one (the same page, or a new page whose title matches ignoring case and accents), the older one SHALL become `superseded` in the same transaction. The run reads the older suggestion before proposing (wiki-generation "The wiki turn and its tools"), so its unreviewed additions are carried into the new one rather than lost.
- **A suggestion never changes a page by itself.** Only accepting it does.
- **Suggestions are not deleted.** Accepted, dismissed and superseded suggestions stay listable by status.
- **The rationale, title and aliases are shown as plain text.** The body renders under the same safe-rendering rules as a page.

#### Scenario: A newer run supersedes the older suggestion
- **WHEN** a page has a pending suggestion from session 1, and a run for session 2 stores a suggestion for the same page
- **THEN** the session 1 suggestion is `superseded`, the session 2 suggestion is `pending`, and the page is unchanged

#### Scenario: Ungranted member can't see suggestions
- **WHEN** a team member without a grant on the show lists the show's suggestions
- **THEN** the response is the masked 404

### Requirement: Accepting a suggestion is a compare-and-set edit
Accepting a suggestion SHALL be one transaction that writes the page and resolves the suggestion together.

- **For an existing page**, accepting SHALL be an edit with compare-and-set on `expected_revision`, the page revision the reviewer saw, which MAY be newer than the base revision. It sets the page to the suggestion's title, aliases and body, or to the reviewer's edited values ("edit, then accept"). The new revision's author is the reviewer, and its note is `accepted suggestion <id>`, or `accepted suggestion <id> (edited)` when the reviewer changed any value.
- **For a new page**, accepting SHALL create the page with the suggestion's kind and the suggestion's (or the edited) title, aliases and body, and the suggestion's session when the kind is `session`. Revision 1's note is `created from suggestion <id>`.
- The page write SHALL follow every rule of a manual save: compare-and-set, title and alias uniqueness, the session-page rule, the link checks, and the merged and deleted states. When any of them refuses the write, nothing changes and the suggestion stays `pending`.
- On success the suggestion becomes `accepted`, recording the reviewer, the time and the page revision written.
- **Dismissing** a pending suggestion makes it `dismissed`, recording the reviewer and the time, and changes no page.
- Accepting or dismissing a suggestion that isn't `pending` SHALL change nothing and answer `409 Suggestion already resolved.`
- Quotes in the reviewer's edits are not checked against the transcript, as for any manual save.

#### Scenario: Accept writes a revision authored by the reviewer
- **WHEN** a reviewer accepts a pending suggestion for a page at its base revision 2
- **THEN** the page is at revision 3 with the suggestion's body, the revision's author is the reviewer, its note is `accepted suggestion <id>`, and the suggestion is `accepted` with `resolved_revision` 3

#### Scenario: A stale accept is refused
- **WHEN** a reviewer accepts with `expected_revision` 4 after someone else saved the page to revision 5
- **THEN** the response is `409 Version conflict.` with the current page, the page stays at revision 5, and the suggestion stays `pending`

#### Scenario: Edit, then accept
- **WHEN** a reviewer accepts a suggestion with an edited `body_md`
- **THEN** the page gets the edited body, and the revision's note is `accepted suggestion <id> (edited)`

### Requirement: Suggestions inbox
The web app SHALL let a user with show access review the active show's suggestions.

- **`/wiki`** SHALL have a **Suggestions** tab, labelled with the number of pending suggestions, listing them grouped by target page. Each item shows the target title (or "New page" with its kind), the session it came from, its rationale, and a **Stale** badge when the page has changed since the base revision.
- **A page with a pending suggestion** SHALL show a banner offering to review it.
- **The review sheet** SHALL show:
  - a line diff of title, aliases and body against the page's current revision, saying so when the page has changed since the base revision (stale); a new-page suggestion shows its whole body as added;
  - a rendered preview of the suggested body;
  - **Accept**, which sends the revision the diff was drawn against;
  - **Edit, then accept**, which opens the page editor prefilled with the suggestion's title, aliases and body (for a new page, the same editor with the kind fixed) and accepts on save;
  - **Dismiss**.
- When an accept gets `409 Version conflict.`, the sheet SHALL reload the page and redraw the diff against the new revision, and keep the reviewer's edited text when there is one.
- **The session workspace** SHALL have an **Update wiki** button in the feed-tab row, immediately before "Wiki page", which stays at the end of the row. While the run is in progress it reads "Updating wiki…" and can't be pressed again. On success it says how many suggestions were stored and links to the Suggestions tab. On `503` it explains that a language model is needed in Settings → Advanced; other failures show the response's detail.
- Accepting or dismissing SHALL refresh the suggestion list, the page and the page list.

#### Scenario: Review a stale suggestion
- **WHEN** a user opens a suggestion whose page was edited after the run
- **THEN** the sheet says the page changed since the suggestion, the diff is against the current revision, and Accept sends that revision

#### Scenario: Update wiki from the session page
- **WHEN** a user with an AI route presses "Update wiki" and the run stores 3 suggestions
- **THEN** the button reads "Updating wiki…" during the run, and afterwards the user is told 3 suggestions are ready, with a link to the Suggestions tab
