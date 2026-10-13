-- Show wiki (OpenSpec change `show-wiki`, design D1, D2; catalog-database "Wiki tables", "Wiki
-- row-level security").
--
-- - `catalog.sessions` gains `unique (id, show_id)`. `id` is already the key, so no row changes; it
--   is only the target of the session page's composite foreign key.
-- - `catalog.wiki_pages`: one row per page. `unique (id, show_id)` is the target of the alias and
--   merge-redirect composite keys, and `(session_id, show_id)` references the sessions key above,
--   so a session page, an alias and a redirect always stay in the page's show (RLS alone would let
--   a user who can access two shows mix them; design A19). Names are unique among live pages only
--   (`merged_into is null and deleted_at_utc is null`), compared with `catalog.search_norm`, so a
--   merged or deleted page frees its name.
-- - `catalog.wiki_aliases`: one row per alias of a live non-session page, unique per show.
-- - `catalog.wiki_revisions`: an append-only snapshot per write (design D2).
--
-- Row-level security: `catalog_user` reads and writes pages and aliases of its accessible shows;
-- it reads revisions of those shows' pages and inserts only revisions it authors, and holds no
-- update or delete privilege on them (the catalog's default privileges grant all four), so those
-- statements fail with 42501, as on `session_overwrites`. `catalog_system` has the allow-all
-- policy on each table. No foreign key cascades. Times are ISO text, as elsewhere in the catalog.
--
-- No transaction-control lines (migrate.sh refuses a line that starts with one).

alter table catalog.sessions add constraint sessions_id_show_id_key unique (id, show_id);

create table catalog.wiki_pages (
  id text collate "C" primary key,
  show_id text collate "C" not null references catalog.shows (id),
  kind text collate "C" not null check (kind in ('person', 'topic', 'bit', 'session')),
  title text collate "C" not null check (char_length(btrim(title)) between 1 and 200),
  body_md text collate "C" not null check (char_length(body_md) <= 100000),
  session_id text collate "C",
  revision bigint not null,
  merged_into text collate "C",
  deleted_at_utc text collate "C",
  created_by text collate "C" not null,
  created_by_name text collate "C" not null,
  created_at_utc text collate "C" not null,
  updated_by text collate "C" not null,
  updated_by_name text collate "C" not null,
  updated_at_utc text collate "C" not null,
  constraint wiki_pages_id_show_id_key unique (id, show_id),
  constraint wiki_pages_session_fkey foreign key (session_id, show_id)
    references catalog.sessions (id, show_id),
  constraint wiki_pages_merged_into_fkey foreign key (merged_into, show_id)
    references catalog.wiki_pages (id, show_id),
  constraint wiki_pages_session_kind_check check ((kind = 'session') = (session_id is not null))
);
create index idx_wiki_pages_show on catalog.wiki_pages (show_id);
create unique index idx_wiki_pages_live_session on catalog.wiki_pages (show_id, session_id)
  where session_id is not null and merged_into is null and deleted_at_utc is null;
create unique index idx_wiki_pages_live_title on catalog.wiki_pages (show_id, catalog.search_norm(title))
  where kind <> 'session' and merged_into is null and deleted_at_utc is null;

create table catalog.wiki_aliases (
  page_id text collate "C" not null,
  show_id text collate "C" not null,
  alias text collate "C" not null check (char_length(btrim(alias)) between 1 and 200),
  primary key (page_id, alias),
  constraint wiki_aliases_page_fkey foreign key (page_id, show_id)
    references catalog.wiki_pages (id, show_id)
);
create unique index idx_wiki_aliases_name on catalog.wiki_aliases (show_id, catalog.search_norm(alias));

create table catalog.wiki_revisions (
  page_id text collate "C" not null references catalog.wiki_pages (id),
  revision bigint not null,
  title text collate "C" not null,
  kind text collate "C" not null,
  body_md text collate "C" not null,
  aliases_json jsonb not null,
  author_user_id text collate "C" not null,
  author_name text collate "C" not null,
  at_utc text collate "C" not null,
  note text collate "C",
  primary key (page_id, revision)
);

alter table catalog.wiki_pages enable row level security;
alter table catalog.wiki_aliases enable row level security;
alter table catalog.wiki_revisions enable row level security;

do $$
  declare t text;
  declare rule text := 'show_id in (select catalog.accessible_shows(catalog.app_user_id()))';
  begin
    foreach t in array array['wiki_pages', 'wiki_aliases', 'wiki_revisions'] loop
      execute format('drop policy if exists %I on catalog.%I', t || '_system_all', t);
      execute format('create policy %I on catalog.%I for all to catalog_system using (true) with check (true)',
                     t || '_system_all', t);
    end loop;
    foreach t in array array['wiki_pages', 'wiki_aliases'] loop
      execute format('drop policy if exists %I on catalog.%I', t || '_user_all', t);
      execute format('create policy %I on catalog.%I for all to catalog_user using (%s) with check (%s)',
                     t || '_user_all', t, rule, rule);
    end loop;
  end
$$;

drop policy if exists wiki_revisions_user_select on catalog.wiki_revisions;
create policy wiki_revisions_user_select on catalog.wiki_revisions
  for select to catalog_user using (
    exists (select 1 from catalog.wiki_pages p where p.id = page_id
            and p.show_id in (select catalog.accessible_shows(catalog.app_user_id()))));

drop policy if exists wiki_revisions_user_insert on catalog.wiki_revisions;
create policy wiki_revisions_user_insert on catalog.wiki_revisions
  for insert to catalog_user with check (
    author_user_id = catalog.app_user_id()
    and exists (select 1 from catalog.wiki_pages p where p.id = page_id
                and p.show_id in (select catalog.accessible_shows(catalog.app_user_id()))));

revoke update, delete on catalog.wiki_revisions from catalog_user;
