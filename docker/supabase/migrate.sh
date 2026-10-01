#!/bin/sh
# docker/supabase/migrate.sh -- apply supabase/migrations/*.sql to this stack's db (supabase-db D3).
# Runs inside the `migrate` service (`compose run --rm migrate`): user postgres, read-only root,
# /migrations mounted read-only, PG* variables from compose. Prints versions and counts only.
set -eu
export LC_ALL=C
cd /migrations

# Phase 1, before connecting: one enumeration; refuse the whole directory on any unsafe entry.
refuse() { echo "migrate: refusing: $1" >&2; exit 2; }
files=; seen=
for f in *; do
  [ "$f" = '*' ] || [ "$f" = .gitkeep ] && continue
  [ -f "$f" ] && [ ! -L "$f" ] || refuse "$f is not a regular file"
  case $f in *[!a-z0-9_.]*) refuse "$f: name must match <14 digits>_<a-z0-9_>.sql" ;; esac
  expr "$f" : '[0-9]\{14\}_[a-z0-9_]\{1,\}\.sql$' >/dev/null || refuse "$f: name must match <14 digits>_<a-z0-9_>.sql"
  v=${f%%_*}
  case " $seen " in *" $v "*) refuse "$f: version $v is used by another file" ;; esac
  grep -q '^[[:space:]]*\\' "$f" && refuse "$f: psql meta-commands (lines starting with a backslash) are not allowed"
  grep -Eqi '^(begin|commit|rollback|end|abort|savepoint|release|start[[:space:]]+transaction)([^a-z_]|$)' "$f" &&
    refuse "$f: transaction control (BEGIN/COMMIT/ROLLBACK/END/SAVEPOINT) is not allowed; each file already runs in one transaction"
  seen="$seen $v"; files="$files $f"
done

# The app role's password (catalog-pg-schema D4): one line of at least 32 lowercase hex characters,
# checked before connecting. `case` matches the whole value, so a newline is refused too.
case ${APP_DB_PASSWORD-} in
  '' | *[!0-9a-f]*) refuse "APP_DB_PASSWORD is unset or not lowercase hexadecimal (create it with docker/scripts/supabase-keys.mjs)" ;;
esac
[ "${#APP_DB_PASSWORD}" -ge 32 ] || refuse "APP_DB_PASSWORD is shorter than 32 characters"

# Phase 2: the history table (Supabase CLI shape), then one transaction per unrecorded file.
psql -X -q -v ON_ERROR_STOP=1 -c 'create schema if not exists supabase_migrations' \
  -c 'create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text)'
cat >/tmp/one.sql <<'SQL'
set local lock_timeout = '10s';
set local statement_timeout = '15min';
select pg_advisory_xact_lock(724110001);
select exists (select 1 from supabase_migrations.schema_migrations where version = :'version') as done \gset
\if :done
\echo skipped :version
\else
\i :file
reset role;
reset search_path;
\set stmts `cat "$MIGRATION_FILE"; printf x`
insert into supabase_migrations.schema_migrations (version, statements, name) values (:'version', array[left(:'stmts', -1)], :'name');
\echo applied :version
\endif
SQL
n=0
for f in $files; do
  v=${f%%_*}; name=${f#*_}; name=${name%.sql}
  out=$(MIGRATION_FILE="/migrations/$f" psql -X -q -v ON_ERROR_STOP=1 --single-transaction \
    -v version="$v" -v name="$name" -v file="/migrations/$f" -f /tmp/one.sql) || { echo "migrate: $f failed; nothing of it was applied" >&2; exit 1; }
  [ "$(psql -X -At -c "select count(*) from supabase_migrations.schema_migrations where version = '$v'")" = 1 ] ||
    { echo "migrate: $f ran but is not recorded" >&2; exit 1; }
  echo "$out"
  case $out in *"applied $v"*) n=$((n + 1)) ;; esac
done
echo "$n applied"

# Phase 3: the app role's LOGIN and password, from the environment (never argv). Statement logging
# (log_statement is `ddl` for postgres on this image) and pg_stat_statements utility tracking are
# off for this transaction, so the plaintext reaches neither the log nor the stats view.
cat >/tmp/approle.sql <<'SQL'
\set apppw `printf %s "$APP_DB_PASSWORD"`
set local log_statement = 'none';
set local pg_stat_statements.track_utility = off;
select exists (select from pg_roles where rolname = 'autologger_app') as has_role \gset
\if :has_role
alter role autologger_app with login password :'apppw';
\echo app role password set
\else
\echo app role absent; password not set
\endif
SQL
psql -X -q -v ON_ERROR_STOP=1 --single-transaction -f /tmp/approle.sql ||
  { echo "migrate: setting the app role's password failed" >&2; exit 1; }
