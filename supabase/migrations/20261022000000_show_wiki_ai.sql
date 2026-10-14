-- AI wiki suggestions (OpenSpec change `show-wiki-ai`, design D1; catalog-database "Wiki suggestions
-- table", "Wiki suggestions row-level security").
--
-- - `catalog.wiki_suggestions`: one row per AI suggestion, holding a full proposed version of a page
--   (title, kind, aliases, body) and, for an existing page, the revision it was based on. `show_id`
--   is stored, so every policy is the same show-access rule as `wiki_pages`, and the composite keys
--   `(session_id, show_id)` and `(page_id, show_id)` keep a suggestion inside its show (RLS alone
--   would let a user who can access two shows mix them).
-- - At most one pending suggestion per existing page, and one per new-page title compared with
--   `catalog.search_norm`. The store supersedes the older one first; the indexes are a backstop.
--
-- Row-level security: `catalog_user` reads suggestions of its accessible shows, inserts only pending
-- rows it authors, and updates only pending rows, to `superseded` or to `accepted`/`dismissed` with
-- itself as the resolver. It holds no delete privilege and the update privilege only on the
-- resolution columns (the catalog's default privileges grant all four), so a delete, or an update
-- of what a suggestion proposed or who wrote it, fails with 42501. The `*_by_name` snapshots are
-- written by the store. `catalog_system` has the allow-all policy. No foreign key cascades. Times
-- are ISO text, as elsewhere in the catalog.
--
-- No transaction-control lines (migrate.sh refuses a line that starts with one).

create table catalog.wiki_suggestions (
  id text collate "C" primary key,
  show_id text collate "C" not null references catalog.shows (id),
  session_id text collate "C" not null,
  run_id text collate "C" not null,
  page_id text collate "C",
  base_revision bigint,
  kind text collate "C" not null check (kind in ('person', 'topic', 'bit', 'session')),
  title text collate "C" not null check (char_length(btrim(title)) between 1 and 200),
  body_md text collate "C" not null check (char_length(body_md) <= 100000),
  aliases_json jsonb not null,
  rationale text collate "C" not null check (char_length(rationale) <= 500),
  status text collate "C" not null
    check (status in ('pending', 'accepted', 'dismissed', 'superseded')),
  created_by text collate "C" not null,
  created_by_name text collate "C" not null,
  created_at_utc text collate "C" not null,
  resolved_by text collate "C",
  resolved_by_name text collate "C",
  resolved_at_utc text collate "C",
  resolved_revision bigint,
  constraint wiki_suggestions_session_fkey foreign key (session_id, show_id)
    references catalog.sessions (id, show_id),
  constraint wiki_suggestions_page_fkey foreign key (page_id, show_id)
    references catalog.wiki_pages (id, show_id),
  constraint wiki_suggestions_target_check check ((page_id is null) = (base_revision is null)),
  constraint wiki_suggestions_resolved_check check (
    (status in ('accepted', 'dismissed')) = (resolved_by is not null)
    and (status in ('accepted', 'dismissed')) = (resolved_at_utc is not null)
    and (status = 'accepted') = (resolved_revision is not null))
);
create index idx_wiki_suggestions_show on catalog.wiki_suggestions (show_id);
create unique index idx_wiki_suggestions_pending_page on catalog.wiki_suggestions (show_id, page_id)
  where status = 'pending' and page_id is not null;
create unique index idx_wiki_suggestions_pending_title
  on catalog.wiki_suggestions (show_id, catalog.search_norm(title))
  where status = 'pending' and page_id is null;

alter table catalog.wiki_suggestions enable row level security;

drop policy if exists wiki_suggestions_system_all on catalog.wiki_suggestions;
create policy wiki_suggestions_system_all on catalog.wiki_suggestions
  for all to catalog_system using (true) with check (true);

drop policy if exists wiki_suggestions_user_select on catalog.wiki_suggestions;
create policy wiki_suggestions_user_select on catalog.wiki_suggestions
  for select to catalog_user
  using (show_id in (select catalog.accessible_shows(catalog.app_user_id())));

drop policy if exists wiki_suggestions_user_insert on catalog.wiki_suggestions;
create policy wiki_suggestions_user_insert on catalog.wiki_suggestions
  for insert to catalog_user
  with check (
    show_id in (select catalog.accessible_shows(catalog.app_user_id()))
    and created_by = catalog.app_user_id()
    and status = 'pending');

drop policy if exists wiki_suggestions_user_update on catalog.wiki_suggestions;
create policy wiki_suggestions_user_update on catalog.wiki_suggestions
  for update to catalog_user
  using (
    show_id in (select catalog.accessible_shows(catalog.app_user_id()))
    and status = 'pending')
  with check (
    show_id in (select catalog.accessible_shows(catalog.app_user_id()))
    and (status = 'superseded'
         or (status in ('accepted', 'dismissed') and resolved_by = catalog.app_user_id())));

revoke update, delete on catalog.wiki_suggestions from catalog_user;
grant update (status, resolved_by, resolved_by_name, resolved_at_utc, resolved_revision)
  on catalog.wiki_suggestions to catalog_user;
