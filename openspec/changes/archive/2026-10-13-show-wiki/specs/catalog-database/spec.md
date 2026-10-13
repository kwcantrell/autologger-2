# Spec Delta

## ADDED Requirements

### Requirement: Wiki tables
The catalog SHALL hold the show wiki in three tables, plus one supporting constraint on `catalog.sessions`.

**`catalog.sessions`** SHALL gain `unique (id, show_id)`. `id` is already the key, so this changes no existing row and exists only as the target of a composite foreign key.

**`catalog.wiki_pages`**, one row per page:
- **Columns:** `id`, `show_id` (references `catalog.shows`), `kind`, `title`, `body_md`, `session_id`, `revision`, `merged_into`, `deleted_at_utc` (nullable), `created_by`, `created_by_name`, `created_at_utc`, `updated_by`, `updated_by_name`, `updated_at_utc`.
- **Composite keys:**
  - `unique (id, show_id)`;
  - `(session_id, show_id)` references `catalog.sessions (id, show_id)`, so a session page's session is always in the page's show;
  - `(merged_into, show_id)` references `catalog.wiki_pages (id, show_id)`, so a merge redirect stays in the show.
- **Checks:**
  - `kind` in (`person`, `topic`, `bit`, `session`);
  - `session_id` is not null exactly when `kind` is `session`;
  - the length limits of the show-wiki capability.
- **Unique indexes**, where "live" means `merged_into is null and deleted_at_utc is null`:
  - live session pages on `(show_id, session_id)`;
  - live non-session pages on `(show_id, catalog.search_norm(title))`.

**`catalog.wiki_aliases`**, one row per alias of a live non-session page:
- **Columns:** `page_id`, `show_id`, `alias`;
- `(page_id, show_id)` references `catalog.wiki_pages (id, show_id)`;
- unique on `(show_id, catalog.search_norm(alias))`.

**`catalog.wiki_revisions`**:
- **Columns:** `page_id`, `revision`, `title`, `kind`, `body_md`, `aliases_json`, `author_user_id`, `author_name`, `at_utc`, `note`;
- **Primary key:** `(page_id, revision)`.

No wiki table SHALL cascade deletes from shows or sessions.

#### Scenario: Session page in the wrong show
- **WHEN** a row is inserted into `wiki_pages` with `show_id` A and a `session_id` whose session belongs to show B
- **THEN** the insert fails on the foreign key and no row is written

#### Scenario: Alias in the wrong show
- **WHEN** a user who can access shows A and B inserts, as `catalog_user`, a `wiki_aliases` row for a page of show A with `show_id` B
- **THEN** the insert fails on the foreign key and no row is written

### Requirement: Wiki row-level security
Row-level security SHALL be enabled on all three wiki tables.

**`catalog_user` on `wiki_pages` and `wiki_aliases`:** reads and writes only rows whose `show_id` is in `catalog.accessible_shows(catalog.app_user_id())`.

**`catalog_user` on `wiki_revisions`:**
- reads a revision only when its page's show is accessible;
- inserts a revision only when its page's show is accessible and `author_user_id = catalog.app_user_id()`;
- has no update or delete privilege, so those statements fail with `42501`.

**`catalog_system`** has the usual allow-all policy on each table.

#### Scenario: Ungranted member reads no wiki rows
- **WHEN** an owner, a granted member, an ungranted member and an outsider each select from `wiki_pages`, `wiki_aliases` and `wiki_revisions` as `catalog_user`
- **THEN** the owner and granted member see the show's rows, and the ungranted member and outsider see none

#### Scenario: Revisions are append-only for users
- **WHEN** an owner, as `catalog_user`, updates or deletes a `wiki_revisions` row
- **THEN** the statement fails with `42501`

#### Scenario: Revisions carry their real author
- **WHEN** a granted member, as `catalog_user`, inserts a revision whose `author_user_id` is another user
- **THEN** the insert is refused by the policy
