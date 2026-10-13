# Spec Delta

## ADDED Requirements

### Requirement: Wiki suggestions table
The catalog SHALL hold AI wiki suggestions in **`catalog.wiki_suggestions`**, one row per suggestion:
- **Columns:**
  - `id` (primary key), `show_id` (references `catalog.shows`), `session_id`, `run_id`;
  - `page_id` (nullable), `base_revision` (nullable);
  - `kind`, `title`, `body_md`, `aliases_json`, `rationale`;
  - `status`, `created_by`, `created_by_name`, `created_at_utc`;
  - `resolved_by` (nullable), `resolved_by_name` (nullable), `resolved_at_utc` (nullable), `resolved_revision` (nullable).
- **Composite keys:**
  - `(session_id, show_id)` references `catalog.sessions (id, show_id)`, so a suggestion's session is always in its show;
  - `(page_id, show_id)` references `catalog.wiki_pages (id, show_id)`, so a suggestion's target page is always in its show.
- **Checks:**
  - `status` in (`pending`, `accepted`, `dismissed`, `superseded`);
  - `kind` in (`person`, `topic`, `bit`, `session`);
  - `page_id` and `base_revision` are both null (a new page) or both set (an existing page);
  - title 1–200 characters after trimming, `body_md` at most 100,000 characters, `rationale` at most 500 characters;
  - `resolved_by`, `resolved_at_utc` are set exactly when `status` is `accepted` or `dismissed`; `resolved_revision` is set exactly when `status` is `accepted`.
- **Unique indexes on pending rows** (`status = 'pending'`):
  - `(show_id, page_id)` where `page_id` is not null;
  - `(show_id, catalog.search_norm(title))` where `page_id` is null.
- No suggestion row SHALL cascade deletes from shows, sessions or pages.

#### Scenario: Suggestion for a page in another show
- **WHEN** a user who can access shows A and B inserts, as `catalog_user`, a `wiki_suggestions` row with `show_id` B and a `page_id` of a page in show A
- **THEN** the insert fails on the foreign key and no row is written

#### Scenario: Two pending suggestions for one page
- **WHEN** a second `pending` row is inserted for the same `(show_id, page_id)` while the first is still `pending`
- **THEN** the insert fails on the unique index

### Requirement: Wiki suggestions row-level security
Row-level security SHALL be enabled on `catalog.wiki_suggestions`, and `catalog_user` SHALL be able to insert suggestions and resolve them, but never rewrite what a suggestion proposed or who wrote it.

- **Select:** `catalog_user` reads only rows whose `show_id` is in `catalog.accessible_shows(catalog.app_user_id())`.
- **Insert:** `catalog_user` inserts only rows of an accessible show with `created_by = catalog.app_user_id()` and `status = 'pending'`.
- **Update:** `catalog_user` holds the update privilege only on `status`, `resolved_by`, `resolved_by_name`, `resolved_at_utc` and `resolved_revision`. It may update only a row that is `pending` and in an accessible show, and the new row SHALL be either `superseded`, or `accepted` or `dismissed` with `resolved_by = catalog.app_user_id()`. So a resolved row can't be reopened, and a suggestion's target, title, aliases, body and rationale can't change after it was checked.
- **Delete:** `catalog_user` has no delete privilege, so a delete fails with `42501`.
- **`catalog_system`** has the usual allow-all policy.

The `*_by_name` snapshots are written by the store, as on wiki pages and revisions; the policy pins the user ids, not the names.

#### Scenario: Ungranted member reads no suggestions
- **WHEN** an owner, a granted member, an ungranted member and an outsider each select from `wiki_suggestions` as `catalog_user`
- **THEN** the owner and granted member see the show's rows, and the ungranted member and outsider see none

#### Scenario: Suggestions are never deleted by users
- **WHEN** an owner, as `catalog_user`, deletes a `wiki_suggestions` row
- **THEN** the statement fails with `42501`

#### Scenario: A checked suggestion can't be rewritten
- **WHEN** a granted member, as `catalog_user`, updates the `body_md` of a pending suggestion
- **THEN** the statement fails with `42501` and the body is unchanged

#### Scenario: A resolved suggestion can't be reopened
- **WHEN** a granted member, as `catalog_user`, sets an `accepted` suggestion back to `pending`
- **THEN** no row is updated

#### Scenario: Suggestions carry their real author
- **WHEN** a granted member, as `catalog_user`, inserts a suggestion whose `created_by` is another user, or resolves one with another user's `resolved_by`
- **THEN** the statement is refused by the policy
