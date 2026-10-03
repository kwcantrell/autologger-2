-- Catalog roles (ADR 0021 slice 6b-1, catalog-roles design D1-D3).
--
-- Every catalog statement runs as one of two NOLOGIN roles: `catalog_user` (for a signed-in user,
-- whose id the transaction sets in `app.user_id`) or `catalog_system` (for a named system task).
-- `autologger_app` holds both with `inherit false, set true`, so it switches per transaction
-- (`set_config('role', …, true)`) and holds none of their privileges while it has not. Row-level
-- security is on for every catalog table, with one allow-all policy per role, so behaviour does not
-- change; slice 6b-2 replaces the `catalog_user` policies.
-- `autologger_app` keeps only `USAGE` on the schema, so a statement it sends without switching
-- role fails with `permission denied for table …`.
--
-- No transaction-control lines: every `begin`/`end` inside a DO block stays indented (migrate.sh
-- refuses a line that starts with one).

-- role:begin
do $$
  begin
    if not exists (select from pg_roles where rolname = 'catalog_user') then
      create role catalog_user nologin;
    end if;
    if not exists (select from pg_roles where rolname = 'catalog_system') then
      create role catalog_system nologin;
    end if;
  end
$$;
alter role catalog_user nologin nocreatedb nocreaterole nobypassrls;
alter role catalog_system nologin nocreatedb nocreaterole nobypassrls;
-- Roles are cluster-wide: in a second database these grants already exist (a notice, no error).
grant catalog_user to autologger_app with inherit false, set true;
grant catalog_system to autologger_app with inherit false, set true;
-- The strict guard (design D3): exactly these two memberships, each set only.
-- guard:begin
do $$
  begin
    if exists (select from pg_auth_members m join pg_roles r on r.oid = m.roleid
               where m.member = 'autologger_app'::regrole
                 and not (r.rolname in ('catalog_user', 'catalog_system')
                          and m.set_option and not m.inherit_option and not m.admin_option)) then
      raise exception 'autologger_app must hold only catalog_user and catalog_system, set only';
    end if;
    if (select count(distinct r.rolname) from pg_auth_members m join pg_roles r on r.oid = m.roleid
        where m.member = 'autologger_app'::regrole
          and r.rolname in ('catalog_user', 'catalog_system')) <> 2 then
      raise exception 'autologger_app must be a member of both catalog_user and catalog_system';
    end if;
    if exists (select from pg_roles where rolname = 'autologger_app'
               and (rolsuper or rolreplication)) then
      raise exception 'autologger_app must not be a superuser or a replication role';
    end if;
  end
$$;
-- guard:end
do $$
  begin
    if exists (select from pg_roles where rolname in ('catalog_user', 'catalog_system')
               and (rolcanlogin or rolbypassrls or rolsuper or rolreplication or rolcreatedb
                    or rolcreaterole)) then
      raise exception 'catalog_user and catalog_system must be NOLOGIN roles with no special attribute';
    end if;
    if exists (select from pg_auth_members
               where member in ('catalog_user'::regrole, 'catalog_system'::regrole)) then
      raise exception 'catalog_user and catalog_system must not be members of any role';
    end if;
    if exists (select from pg_auth_members
               where roleid in ('catalog_user'::regrole, 'catalog_system'::regrole)
                 and member not in ('autologger_app'::regrole, 'postgres'::regrole)) then
      raise exception 'only autologger_app and postgres may be members of the catalog roles';
    end if;
  end
$$;
-- role:end

revoke all on all tables in schema catalog from autologger_app;
alter default privileges for role postgres in schema catalog
  revoke select, insert, update, delete on tables from autologger_app;
grant usage on schema catalog to catalog_user, catalog_system;
grant select, insert, update, delete on all tables in schema catalog to catalog_user, catalog_system;
alter default privileges for role postgres in schema catalog
  grant select, insert, update, delete on tables to catalog_user, catalog_system;

-- The transaction's user id, or null (design D1). `app.user_id` reads '' once it was used on the
-- connection, hence `nullif`. No `set search_path`: it calls only pg_catalog functions.
create or replace function catalog.app_user_id() returns text language sql stable
  as $$ select nullif(current_setting('app.user_id', true), '') $$;
revoke all on function catalog.app_user_id() from public;
grant execute on function catalog.app_user_id() to catalog_user, catalog_system;

-- Row-level security on every catalog table, one allow-all policy per catalog role (design D2).
do $$
  declare t text;
  begin
    for t in select tablename from pg_tables where schemaname = 'catalog' order by 1 loop
      execute format('alter table catalog.%I enable row level security', t);
      execute format('create policy %I on catalog.%I for all to catalog_user using (true) with check (true)', t || '_user_all', t);
      execute format('create policy %I on catalog.%I for all to catalog_system using (true) with check (true)', t || '_system_all', t);
    end loop;
  end
$$;
