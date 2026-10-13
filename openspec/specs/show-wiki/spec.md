# show-wiki Specification

## Purpose
Gives each show a knowledge wiki, "show memory for producers": people, topics, running bits and per-session index pages, written in Markdown, with full revision history, aliases, merge and split, and citations that open the transcript at the cited moment.

## Requirements

### Requirement: Wiki pages belong to one show
Every wiki page SHALL belong to exactly one show. A page has:
- an `id`, a `kind`, a `title`, a Markdown `body_md`, a list of `aliases` and a `revision` number;
- the name and time of whoever created it and of whoever last changed it;
- `merged_into`: the page it was merged into, or `null`;
- `deleted`: whether it is soft-deleted.

**Kinds.** `kind` SHALL be one of `person`, `topic`, `bit` (a running bit) or `session`.

**Session pages.**
- A `session` page SHALL name one session of the same show (`session_id`); every other kind SHALL have `session_id` `null`.
- A session SHALL have at most one live session page.
- A page's `kind` SHALL NOT change to or from `session`, and its `session_id` SHALL NOT change; an edit that tries either SHALL be refused with `422`.
- A hidden session MAY have a session page and MAY be cited: hiding a session SHALL NOT change the wiki, and only a person deletes wiki pages.

**Limits:**
- `title`: 1–200 characters after trimming;
- `body_md`: at most 100,000 characters;
- `aliases`: at most 50, each 1–200 characters after trimming; a `session` page has none;
- a title or alias SHALL NOT contain control characters (U+0000–U+001F, U+007F), so it stays one line of plain text;
- a body SHALL NOT contain NUL.

**Names.** Names are recorded as they were at the time of the write, so a page keeps its authors' names after they leave the team.

#### Scenario: A session page names a session of its show
- **WHEN** a user with show access creates a `session` page for a session of that show
- **THEN** the page is created with that `session_id`, and a second create for the same session is refused with `409` naming the existing page

#### Scenario: A session from another show is refused
- **WHEN** a user creates a `session` page in show A naming a session of show B
- **THEN** the create is refused with `422` and no page is written

#### Scenario: A kind can't become session
- **WHEN** a user edits a `topic` page with `kind` `session`
- **THEN** the edit is refused with `422` and the page is unchanged

#### Scenario: A title can't carry Markdown lines
- **WHEN** a user creates a page whose title contains a newline
- **THEN** the create is refused with `422`

### Requirement: Wiki access is show access
A user SHALL be able to read and change a show's wiki exactly when the show is one they can access under the show-grant rules: an owner or admin of the show's team, or a team member with a grant on the show. Every such user SHALL be able to create, edit, merge, split, delete and restore pages, and read revisions.

Any other user SHALL get the same `404` they would get for a show or page that does not exist. That includes a team member without a grant.

The database SHALL enforce the same rule through row-level security, and SHALL keep each alias and merge redirect in the same show as its page, so a query outside the routes can't read or write another show's wiki.

#### Scenario: An ungranted member can't see the wiki
- **WHEN** a member of the show's team who has no grant on the show requests the show's page list, or a page of that show by id
- **THEN** each request gets `404`, the same as for a nonexistent show or page

#### Scenario: A granted member can edit
- **WHEN** a member with a grant on the show edits a page of that show
- **THEN** the edit succeeds and appends a revision authored by that member

### Requirement: Every change appends an immutable revision
Every write that changes a page SHALL append one revision holding the page's resulting title, kind, body and aliases, its author's name, its time and a short note. The writes are create, edit, merge (on both pages), split (on both pages), delete and restore.

- An edit that changes nothing SHALL succeed without appending a revision.
- The page's `revision` number SHALL equal the number of its newest revision; revision 1 is the create.
- Revisions SHALL NOT be updated or deleted, by the API or by a direct write as the user role.
- **Restoring a revision** is an edit that sets the page to revision *n*'s title, kind, body and aliases and names *n*. It SHALL append a new revision whose note names *n*.
- **A page that isn't live** (merged or deleted) SHALL report the aliases of its newest revision.

#### Scenario: Restore appends, never rewrites
- **WHEN** a page at revision 4 has revision 2 restored
- **THEN** the page is at revision 5 with revision 2's title, body and aliases and a note naming revision 2, and revisions 1–4 are unchanged

#### Scenario: Revisions can't be rewritten directly
- **WHEN** a user with show access updates or deletes a revision row directly as the catalog user role
- **THEN** the statement fails with a permission error and the revision is unchanged

#### Scenario: A no-op save adds nothing
- **WHEN** a user saves a page at revision 3 with the same title, body and aliases
- **THEN** the save succeeds and the page stays at revision 3

### Requirement: Edits are compare-and-set on the revision
Every write to an existing page SHALL carry the page revision the client last saw. Those writes are edit (including restoring a revision), delete, restore, merge (both pages) and split.
- If any named page's current revision differs, the write SHALL change nothing and answer `409 Version conflict.` with the current page.
- A write to a merged page SHALL answer `409` naming the page it was merged into.
- An edit, merge or split of a deleted page SHALL answer `409`.

#### Scenario: Two editors, one wins
- **WHEN** two users load a page at revision 3 and both save, one after the other, with `expected_revision` 3
- **THEN** the first save makes revision 4, and the second gets `409` with the page at revision 4 and changes nothing

### Requirement: Titles and aliases are unique within a show
Within one show, no two live non-session pages (neither merged nor deleted) SHALL share a title or alias, compared ignoring case and accents. That covers title against title, alias against alias, and title against alias.

- A create, edit, merge, split or restore that would break this SHALL change nothing and answer `409 Title already used.` with the id of the page that holds the name.
- Within one request, an alias equal (ignoring case and accents) to the page's own title or to an earlier alias SHALL be dropped silently.

Session pages SHALL be outside this rule, because two sessions can share a title. A session page is identified by its session.

#### Scenario: Accent-insensitive clash
- **WHEN** a show has a live page titled "Café Noir" and a user creates a page titled "cafe noir"
- **THEN** the create gets `409` naming the existing page

#### Scenario: Alias clashes with a title
- **WHEN** a user adds the alias "Chris" to a page while another live page of the same show is titled "chris"
- **THEN** the edit gets `409` naming that page and the alias is not added

#### Scenario: Duplicate aliases in one request collapse
- **WHEN** a user saves aliases `["Chris", "chris", "<the page's own title>"]`
- **THEN** the save succeeds and the page's aliases are `["Chris"]`

### Requirement: Merge and split
**Merging page A into page B** SHALL require that both pages are in the same show, both are live, neither is a `session` page, and A ≠ B. It SHALL, in one step:
1. append A's body to B's body under a level-2 heading `Merged from <A's title>`, with A's title escaped so it reads as plain text;
2. add A's title and aliases to B's aliases, dropping any that equal (ignoring case and accents) B's title or an alias B already has;
3. set A's `merged_into` to B, leaving A's body readable;
4. append one revision to each page.

If B's resulting body would exceed 100,000 characters, or its aliases would exceed 50, the merge SHALL change nothing and answer `422`.

**Splitting a page** SHALL, in one step:
1. replace the source page's body with the given remaining body;
2. create a new live page of the same show, with the given kind (not `session`), title and body;
3. append a revision to the source page and create revision 1 of the new page.

A merge or split that fails any check SHALL change nothing.

#### Scenario: Merge leaves a redirect
- **WHEN** a user merges "Chris R." into "Christina Ramos"
- **THEN** "Christina Ramos" ends with a "Merged from Chris R." section and alias "Chris R.", and reading "Chris R." returns its `merged_into` pointing at "Christina Ramos"

#### Scenario: Merge that would overflow is refused
- **WHEN** a user merges two pages whose bodies together exceed 100,000 characters
- **THEN** the merge gets `422` and neither page changes

#### Scenario: Split moves text atomically
- **WHEN** a user splits a section out of a topic page into a new `bit` page whose title is already used
- **THEN** the split gets `409`, the source page is unchanged, and no page is created

### Requirement: Citations and page links
A page body SHALL link to the transcript and to other pages through Markdown links that use two reserved schemes:
- **Citation:** `[quoted words](cite:<session_id>@<seconds>)`. `<seconds>` is a non-negative decimal number with at most 3 decimal places, and the link text is the quote.
- **Page link:** `[label](wiki:<page_id>)`.

**What counts as a link.** A link is every link, reference definition and autolink that the CommonMark parser used for rendering finds in the body, after it decodes escapes and entities. Each one whose URL starts with `cite:` or `wiki:`, in any letter case, SHALL be checked.

**Checks.** Every write that sets a body (create, edit, merge, split and restore) SHALL check each link:
- it matches the grammar above exactly, with the scheme in lower case;
- a citation's session is a session of the page's show;
- a page link names a page of the same show. Linking to a deleted or merged page is allowed.

If a link fails, the write SHALL change nothing and answer `422` with a detail naming the first bad link. A body may hold at most 500 such links.

#### Scenario: Citation to another show is refused
- **WHEN** a user saves a page of show A whose body cites a session of show B
- **THEN** the save gets `422` naming that `cite:` link, and the page is unchanged

#### Scenario: Other link forms are checked too
- **WHEN** a user saves a body that reaches a session of show B only through a reference definition (`[x][r]` and `[r]: cite:<B session>@1`), an angle-bracket destination, an autolink, or an upper-case `CITE:` scheme
- **THEN** each save gets `422`, and the page is unchanged

### Requirement: Page bodies render safely
The web app SHALL render page bodies as Markdown into React elements:
- raw HTML in the body SHALL be shown as nothing, never parsed;
- **what is clickable:** only `https:` links, and `cite:` and `wiki:` links that match the citation-and-link grammar exactly. Anything else, such as `javascript:` or a malformed `cite:`, SHALL render as plain text;
- a `cite:` link SHALL render as a moment link that opens `/sessions/<session_id>?t=<seconds>`, labelled with its text and its time as `h:mm:ss`;
- a `wiki:` link SHALL open `/wiki/<page_id>`;
- `https:` links SHALL open in a new tab with `rel="noopener noreferrer"`;
- images SHALL render as their alt text only.

#### Scenario: Script links are inert
- **WHEN** a page body contains `<img src=x onerror=alert(1)>` and `[x](javascript:alert(1))`
- **THEN** the rendered page has no `img` element and no link for `x`, and no script runs

#### Scenario: A citation opens the moment
- **WHEN** a user clicks a citation `[we start Monday](cite:S1@754)` on a page
- **THEN** the app opens `/sessions/S1?t=754`, and the session seeks to 12:34 as for any moment deep link

### Requirement: Soft delete and restore
Deleting a page SHALL mark it deleted and append a revision. A deleted page:
- SHALL leave the default page list, and SHALL be listed only when the caller asks for deleted pages;
- SHALL keep all its revisions;
- SHALL stop holding its title, aliases and session.

Restoring SHALL make the page live again and append a revision, unless one of these is now held by another live page:
- its title or one of its aliases (`409`);
- its session, which already has another page (`409`).

#### Scenario: Deleted pages free their names
- **WHEN** a user deletes "Running Joke" and then creates a new page titled "Running Joke"
- **THEN** the create succeeds, and restoring the deleted page then gets `409` naming the new page

### Requirement: Wiki screens
The web app SHALL provide two screens.

**`/wiki`, the active show's wiki:**
- tabs for People, Topics, Running bits and Sessions list the live pages of each kind, sorted by title;
- a filter matches titles and aliases;
- a "Deleted" view lists deleted pages with Restore;
- "New page" asks for kind and title;
- with no active show, the screen says to choose a show.

**`/wiki/:pageId`, the page view:**
- It shows the rendered body, the aliases, and who changed the page last and when.
- **Edit** opens Write and Preview tabs over the Markdown, with alias chips. When a save gets `409`, the user's text stays and a banner offers to reload the current page.
- **History** lists revisions newest first, loading older ones on request. It shows a line diff of any revision against the current page, and can restore that revision.
- **Merge into…** picks another page of the same show and confirms first.
- **Split** takes the text to move and the new page's kind and title.
- **Delete** confirms first.

**Redirects and other shows:**
- opening a merged page SHALL replace the URL with the page it was merged into;
- opening a page of a show other than the active show SHALL offer to switch to that show.

**Entry points:**
- a "Wiki" link in the top bar opens `/wiki`, and the top bar SHALL still fit on one line at 390px;
- a "Wiki page" button at the end of the session workspace's feed-tab row opens that session's page, creating it on first use with the session's title as the page title.

Switching the active show SHALL drop cached wiki data from the previous show.

#### Scenario: Session page from the workspace
- **WHEN** a user with show access presses "Wiki page" in a session that has no page yet
- **THEN** a `session` page titled after the session is created and opened, and pressing it again opens the same page

#### Scenario: Edit conflict keeps the draft
- **WHEN** a user saves an edit after someone else has saved the same page
- **THEN** the save gets `409`, the user's text stays in the editor, and a banner offers to load the newer page
