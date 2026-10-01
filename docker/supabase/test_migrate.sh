#!/bin/sh
# docker/supabase/test_migrate.sh -- cases for the migrations runner docker/supabase/migrate.sh
# (supabase-db task 3.1; spec "Migrations runner"). Needs docker; run by hand:
#
#   sh docker/supabase/test_migrate.sh
#
# Starts a throwaway Postgres (containers, network and volume prefixed alg-migrate-test, removed on
# exit) from the pinned image and runs migrate.sh against it the way the `migrate` service does
# (user postgres, read-only root, read-only mounts), with one fixture directory per case.
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd -P)
IMG=$(sed -n 's/^x-image: &image //p' "$ROOT/docker/supabase-db.yaml")
P=alg-migrate-test
PW=0123456789abcdef0123456789abcdef
SCRATCH=$(mktemp -d)
PASS=0; FAILED=0

cleanup() {
  docker rm -f "$P-db" >/dev/null 2>&1 || true
  docker network rm "$P" >/dev/null 2>&1 || true
  docker volume rm "$P" >/dev/null 2>&1 || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT
cleanup; SCRATCH=$(mktemp -d)

docker network create --internal "$P" >/dev/null
docker run -d --name "$P-db" --network "$P" -v "$P:/var/lib/postgresql/data" -e POSTGRES_PASSWORD="$PW" \
  "$IMG" postgres -c config_file=/etc/postgresql/postgresql.conf >/dev/null
until docker exec "$P-db" pg_isready -U postgres -h localhost >/dev/null 2>&1; do sleep 1; done
sleep 2 # the image restarts once after initdb

# runner DIR: run migrate.sh over fixture DIR; output in $SCRATCH/out, status in $rc.
runner() {
  rc=0
  docker run --rm --network "$P" --user postgres --read-only --tmpfs /tmp --cap-drop ALL \
    -e PGHOST="$P-db" -e PGUSER=postgres -e PGDATABASE=postgres -e PGPASSWORD="$PW" \
    -v "$1:/migrations:ro" -v "$ROOT/docker/supabase/migrate.sh:/migrate.sh:ro" \
    --entrypoint sh "$IMG" /migrate.sh >"$SCRATCH/out" 2>&1 || rc=$?
}
sql() { docker exec -e PGPASSWORD="$PW" "$P-db" psql -X -At -h localhost -U postgres -c "$1"; }
check() { # NAME CONDITION...
  _n=$1; shift
  if "$@"; then PASS=$((PASS + 1)); echo "ok   $_n"; else FAILED=$((FAILED + 1)); echo "FAIL $_n"; sed 's/^/     /' "$SCRATCH/out"; fi
}
fixture() { rm -rf "$SCRATCH/$1"; mkdir -p "$SCRATCH/$1"; chmod 755 "$SCRATCH/$1"; echo "$SCRATCH/$1"; }
put() { printf '%s\n' "$3" >"$1/$2"; chmod 644 "$1/$2"; }

# 1. empty directory: exit 0, table created
d=$(fixture empty); touch "$d/.gitkeep"
runner "$d"
check "empty directory exits 0 and creates the history table" \
  test "$rc" = 0 -a "$(sql "select to_regclass('supabase_migrations.schema_migrations') is not null")" = t

# 2. two files in order; rerun applies nothing
d=$(fixture two)
put "$d" 20260101000002_second.sql "insert into t_one values (2);"
put "$d" 20260101000001_first.sql "create table t_one (v int); insert into t_one values (1);"
runner "$d"
check "two files apply in version order" test "$rc" = 0 -a "$(sql 'select string_agg(v::text, $$,$$ order by v) from t_one')" = "1,2"
runner "$d"
check "a rerun applies nothing" sh -c "[ $rc = 0 ] && grep -q '^0 applied' '$SCRATCH/out' && [ \"\$(cat '$SCRATCH/out' | grep -c '^applied')\" = 0 ]"
check "a rerun leaves the record count unchanged" test "$(sql 'select count(*) from supabase_migrations.schema_migrations')" = 2

# 3. good then bad statement: nothing of it remains; a later file is not applied
d=$(fixture bad)
put "$d" 20260101000003_bad.sql "create table t_bad (v int);
select 1/0;"
put "$d" 20260101000004_later.sql "create table t_later (v int);"
runner "$d"
check "a failing file exits non-zero naming it" sh -c "[ $rc != 0 ] && grep -q 20260101000003_bad.sql '$SCRATCH/out'"
check "the failing file left no table and no record" test \
  "$(sql "select (to_regclass('t_bad') is null) and not exists (select 1 from supabase_migrations.schema_migrations where version='20260101000003')")" = t
check "a later file is not applied after a failure" test "$(sql "select to_regclass('t_later') is null")" = t

# 4. unsafe directories are refused before connecting (nothing applied)
for c in "misnamed:add_table.sql:select 1;" \
         "dupe:20260101000005_a.sql:select 1;" \
         "commit:20260101000006_c.sql:create table t_c (v int);
COMMIT;" \
         "meta:20260101000007_m.sql:\\set ON_ERROR_STOP off
create table t_m (v int);"; do
  name=${c%%:*}; rest=${c#*:}; file=${rest%%:*}; body=${rest#*:}
  d=$(fixture "$name"); put "$d" 20260101000009_ok.sql "create table t_ok_$name (v int);"; put "$d" "$file" "$body"
  [ "$name" = dupe ] && put "$d" 20260101000005_b.sql "select 2;"
  runner "$d"
  check "refused before connecting: $name" sh -c "[ $rc != 0 ] && grep -q 'refusing' '$SCRATCH/out' && [ \"\$(cat '$SCRATCH/out' | grep -c '^applied')\" = 0 ]"
  check "nothing applied for: $name" test "$(sql "select to_regclass('t_ok_$name') is null")" = t
done
d=$(fixture subdir); mkdir "$d/20260101000008_dir.sql"
runner "$d"
check "refused before connecting: a directory entry" sh -c "[ $rc != 0 ] && grep -q 'refusing' '$SCRATCH/out'"

# 5. two runners at once with one new file: one record, both exit 0
d=$(fixture race); put "$d" 20260101000010_race.sql "select pg_sleep(2); create table t_race (v int);"
( runner "$d"; echo "$rc" >"$SCRATCH/rc1" ) & p1=$!
sleep 0.3
rc2=0; docker run --rm --network "$P" --user postgres --read-only --tmpfs /tmp --cap-drop ALL \
  -e PGHOST="$P-db" -e PGUSER=postgres -e PGDATABASE=postgres -e PGPASSWORD="$PW" \
  -v "$d:/migrations:ro" -v "$ROOT/docker/supabase/migrate.sh:/migrate.sh:ro" \
  --entrypoint sh "$IMG" /migrate.sh >"$SCRATCH/out2" 2>&1 || rc2=$?
wait $p1 || true
check "concurrent runs both exit 0" test "$(cat "$SCRATCH/rc1")" = 0 -a "$rc2" = 0
check "concurrent runs record the file once" test "$(sql "select count(*) from supabase_migrations.schema_migrations where version='20260101000010'")" = 1

# 6. the record holds the file byte-for-byte
d=$(fixture exact)
cat >"$d/20260101000011_exact.sql" <<'EOF'
-- it's a $$ test with :foo and :'bar' tokens
create function f_exact() returns text language sql as $$ select 'it''s :foo' $$;

EOF
chmod 644 "$d/20260101000011_exact.sql"
runner "$d"
sql "select statements[1] from supabase_migrations.schema_migrations where version='20260101000011'" >"$SCRATCH/rec" || true
printf '\n' >>"$SCRATCH/rec.nl"; # psql -At adds one trailing newline
check "the record holds the file exactly" sh -c "[ $rc = 0 ] && [ \"\$(cat '$SCRATCH/rec' | od -c)\" = \"\$(cat '$d/20260101000011_exact.sql' '$SCRATCH/rec.nl' | od -c)\" ]"

echo "test_migrate: $PASS passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
