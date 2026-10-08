#!/bin/sh
# docker/scripts/test_check_envs.sh -- regression cases for check-envs.sh invariants 14 and 15
# (infisical-secrets tasks 2.1, 2.2), 16 and the invariant 4 exceptions (supabase-db task 2.1), and
# invariant 4's packages/*/src rule (retire-sqlite-catalog task 4.1), and the auth networks
# (gotrue-sign-in task 2.1), and the stage public mode (stage-public-https, invariant 7).
# Each case copies the working tree (tracked + untracked, git-ignored files excluded, so no env file or data directory is copied) to a scratch dir,
# applies one mutation, runs the check there and asserts the outcome.
#
#   sh docker/scripts/test_check_envs.sh
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd -P)
SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT
PASS=0; FAILED=0

snapshot() { # DIR: copy the working tree into DIR
  mkdir -p "$1"
  # xargs may run several `tar -c` (one archive each); --ignore-zeros reads past each end marker.
  (cd "$ROOT" && git ls-files -co --exclude-standard -z | xargs -0 tar -cf -) | tar --ignore-zeros -xf - -C "$1"
}

# expect NAME DIR WANT[ok|fail] [PATTERN]: run check-envs in DIR; assert status (and output).
expect() {
  _n=$1; _d=$2; _w=$3; _p=${4:-}
  if sh "$_d/docker/scripts/check-envs.sh" all >"$SCRATCH/out" 2>&1; then got=ok; else got=fail; fi
  if [ "$got" = "$_w" ] && { [ -z "$_p" ] || grep -q -- "$_p" "$SCRATCH/out"; }; then
    PASS=$((PASS + 1)); echo "ok   $_n"
  else
    FAILED=$((FAILED + 1)); echo "FAIL $_n (wanted $_w${_p:+ with [$_p]}, got $got)"; sed 's/^/     /' "$SCRATCH/out"
  fi
}

BASE=$SCRATCH/base
snapshot "$BASE"
expect "clean tree passes" "$BASE" ok

d=$SCRATCH/envfile; snapshot "$d"
# Re-add an env_file to prod api (invariant 14).
sed -i 's/^    container_name: autologger-api$/    container_name: autologger-api\n    env_file: .env/' "$d/compose.yaml"
expect "env_file on prod api is caught" "$d" fail "invariant 14] prod"

d=$SCRATCH/devenvfile; snapshot "$d"
sed -i 's/^    container_name: autologger-dev-app$/    container_name: autologger-dev-app\n    env_file: .env.dev/' "$d/docker/compose.dev.yaml"
expect "env_file on dev app is caught" "$d" fail "invariant 14] dev"

d=$SCRATCH/direct; snapshot "$d"
# A passthrough added directly to prod api, not to the allowlist file (invariant 15).
sed -i 's/^      NODE_ENV: production$/      NODE_ENV: production\n      SNEAKY_KEY:/' "$d/compose.yaml"
expect "passthrough added outside the allowlist is caught" "$d" fail "invariant 15] prod"

d=$SCRATCH/dropped; snapshot "$d"
# A dev literal pin that shadows an allowlist key is fine; dropping extends is not.
sed -i '/extends: { file: docker\/secrets-env.yaml, service: secrets }/d' "$d/docker/compose.dev.yaml"
expect "dev app without the allowlist is caught" "$d" fail "invariant 15] dev"

# ---- supabase-db (invariant 16, invariant 4 exceptions)
DBF=docker/supabase-db.yaml
d=$SCRATCH/dbport; snapshot "$d"
sed -i 's/^    restart: unless-stopped$/    restart: unless-stopped\n    ports: ["127.0.0.1:5432:5432"]/' "$d/$DBF"
expect "a published db port is caught" "$d" fail "invariant 16]"

d=$SCRATCH/dbnet; snapshot "$d"
sed -i '0,/^    networks: \[db\]$/s//    networks: [db, default]/' "$d/$DBF"
expect "db on a second network is caught" "$d" fail "invariant 16]"

d=$SCRATCH/compdb; snapshot "$d"
sed -i '/^  companion:$/,/networks:/s/networks: \[dev\]/networks: [dev, db]/' "$d/docker/compose.dev.yaml"
expect "companion joined to the db network is caught" "$d" fail "invariant 16] dev"

d=$SCRATCH/dbinternal; snapshot "$d"
sed -i 's/^    internal: true$/    internal: false/' "$d/compose.yaml"
expect "a non-internal db network is caught" "$d" fail "invariant 16] prod"

d=$SCRATCH/dbgw; snapshot "$d"
sed -i '/gateway_mode_ipv4: isolated/d' "$d/docker/compose.dev.yaml"
expect "a db network without host isolation is caught" "$d" fail "invariant 16] dev"

d=$SCRATCH/dbsubnet; snapshot "$d"
sed -i 's/172\.28\.22\.0/172.28.23.0/' "$d/docker/compose.stage.yaml"
expect "a db network off its pinned subnet is caught" "$d" fail "invariant 16] stage"

d=$SCRATCH/dbimg; snapshot "$d"
sed -i '0,/^    image: \*image$/s//    image: supabase\/postgres:17.6.1.136/' "$d/$DBF"
expect "an unpinned db image is caught" "$d" fail "invariant 16]"

d=$SCRATCH/migimg; snapshot "$d"
sed -i '/^  migrate:$/,/image:/s/^    image: \*image$/    image: supabase\/postgres:17.6.1.136/' "$d/$DBF"
expect "an unpinned migrate image is caught" "$d" fail "invariant 16]"

d=$SCRATCH/dburl; snapshot "$d"
sed -i '0,/^      PORT: "8786"$/s/^      PORT: "8786"$/      PORT: "8786"\n      DATABASE_URL: postgres:\/\/postgres:${POSTGRES_PASSWORD}@db\/postgres/' "$d/docker/compose.dev.yaml"
expect "the password embedded in a dev app DATABASE_URL is caught" "$d" fail "invariant 16] dev"

d=$SCRATCH/pwlabel; snapshot "$d"
sed -i 's/^    container_name: autologger-api$/    container_name: autologger-api\n    labels: { pw: "${POSTGRES_PASSWORD}" }/' "$d/compose.yaml"
expect "the password in a prod api label is caught" "$d" fail "invariant 16] prod"

d=$SCRATCH/dockerbind; snapshot "$d"
sed -i 's#^      - ./docker/supabase/migrate.sh:/migrate.sh:ro$#&\n      - ./docker/Caddyfile:/x:ro#' "$d/$DBF"
expect "a docker/ bind outside the exceptions is caught" "$d" fail "invariant 4] dev"

d=$SCRATCH/migbind; snapshot "$d"
sed -i 's#^      - ./docker/dev-gate.Caddyfile:/etc/caddy/Caddyfile:ro$#&\n      - ./supabase/migrations:/m:ro#' "$d/docker/compose.dev.yaml"
expect "the migrations directory mounted outside migrate is caught" "$d" fail "invariant 4] dev"

# ---- supabase-services (invariant 16 rewritten, invariants 3 and 4)
SBF=docker/supabase-services.yaml
d=$SCRATCH/pwrest; snapshot "$d"
sed -i 's#^      PGRST_DB_SCHEMAS: public$#&\n      X_PW: ${POSTGRES_PASSWORD}#' "$d/$SBF"
expect "the superuser password in rest is caught" "$d" fail "invariant 16]"

d=$SCRATCH/gwdb; snapshot "$d"
sed -i 's/^    networks: \[supabase, edge\]$/    networks: [supabase, edge, db]/' "$d/$SBF"
expect "the gateway on the db network is caught" "$d" fail "invariant 16]"

d=$SCRATCH/restedge; snapshot "$d"
sed -i 's/^    command: \["postgrest"\]$/&\n    networks: [db, supabase, edge]/' "$d/$SBF"
expect "rest on the edge network is caught" "$d" fail "invariant 16]"

d=$SCRATCH/sbinternal; snapshot "$d"
sed -i '/^  supabase:$/,/internal: true/{/^    internal: true$/d}' "$d/docker/compose.dev.yaml"
expect "a non-internal supabase network is caught" "$d" fail "invariant 16] dev"

d=$SCRATCH/authimg; snapshot "$d"
sed -i 's#^    image: supabase/gotrue@sha256:[0-9a-f]* \# v2.196.0$#    image: supabase/gotrue:v2.196.0#' "$d/$SBF"
expect "an unpinned auth image is caught" "$d" fail "invariant 16]"

d=$SCRATCH/storageport; snapshot "$d"
sed -i 's/^      S3_PROTOCOL_ENABLED: "false"$/&\n    ports: ["127.0.0.1:5000:5000"]/' "$d/$SBF"
expect "storage publishing a port is caught" "$d" fail "invariant 16]"

d=$SCRATCH/edgesubnet; snapshot "$d"
sed -i 's/172\.28\.24\.0/172.28.25.0/' "$d/docker/compose.stage.yaml"
expect "an edge network off its pinned subnet is caught" "$d" fail "invariant 16] stage"

d=$SCRATCH/anonapi; snapshot "$d"
sed -i 's/^    container_name: autologger-api$/    container_name: autologger-api\n    labels: { k: "${ANON_KEY}" }/' "$d/compose.yaml"
expect "the anon key in prod api is caught" "$d" fail "invariant 16] prod"

d=$SCRATCH/gwbind; snapshot "$d"
sed -i '0,/dev-gate.Caddyfile:\/etc\/caddy\/Caddyfile:ro$/s#^      - ./docker/dev-gate.Caddyfile:/etc/caddy/Caddyfile:ro$#&\n      - ./docker/supabase-gw.Caddyfile:/x:ro#' "$d/docker/compose.dev.yaml"
expect "the gateway Caddyfile mounted outside the gateway is caught" "$d" fail "invariant 4] dev"

d=$SCRATCH/initbind; snapshot "$d"
sed -i '0,/dev-gate.Caddyfile:\/etc\/caddy\/Caddyfile:ro$/s#^      - ./docker/dev-gate.Caddyfile:/etc/caddy/Caddyfile:ro$#&\n      - ./docker/supabase/init/roles.sql:/x.sql:ro#' "$d/docker/compose.dev.yaml"
expect "init SQL mounted outside db is caught" "$d" fail "invariant 4] dev"

# ---- catalog-pg-schema (invariants 3 and 16: the two-member catalog network, APP_DB_PASSWORD)
d=$SCRATCH/apprest; snapshot "$d"
sed -i 's#^      PGRST_DB_SCHEMAS: public$#&\n      X_PW: ${APP_DB_PASSWORD}#' "$d/$SBF"
expect "the app password in rest is caught" "$d" fail "invariant 16]"

d=$SCRATCH/appweb; snapshot "$d"
sed -i '0,/^    networks: \[front\]$/s//    networks: [front]\n    labels: { pw: "${APP_DB_PASSWORD}" }/' "$d/compose.yaml"
expect "the app password in prod web is caught" "$d" fail "invariant 16] prod"

d=$SCRATCH/compcat; snapshot "$d"
sed -i '/^  companion:$/,/networks:/s/networks: \[dev\]/networks: [dev, catalog]/' "$d/docker/compose.dev.yaml"
expect "companion joined to the catalog network is caught" "$d" fail "invariant 16] dev"

d=$SCRATCH/restcat; snapshot "$d"
sed -i 's/^    command: \["postgrest"\]$/&\n    networks: [db, supabase, catalog]/' "$d/$SBF"
expect "rest on the catalog network is caught" "$d" fail "invariant 16]"

d=$SCRATCH/appdb; snapshot "$d"
sed -i 's/^    networks: \[dev, catalog, auth-app\]$/    networks: [dev, catalog, auth-app, db]/' "$d/docker/compose.dev.yaml"
expect "the dev app on the shared db network is caught" "$d" fail "invariant 16] dev"

d=$SCRATCH/apidb; snapshot "$d"
sed -i 's/^    networks: \[back, catalog, auth-app\]$/    networks: [back, catalog, auth-app, db]/' "$d/compose.yaml"
expect "the prod api on the shared db network is caught" "$d" fail "invariant 16] prod"

d=$SCRATCH/nsshare; snapshot "$d"
sed -i 's/^networks:$/  sidecar:\n    image: caddy:2\n    network_mode: service:app\n\nnetworks:/' "$d/docker/compose.dev.yaml"
expect "a second service in the app's namespace is caught" "$d" fail "invariant 16] dev"

d=$SCRATCH/catsubnet; snapshot "$d"
sed -i 's/172\.28\.25\.0/172.28.26.0/' "$d/docker/compose.stage.yaml"
expect "a catalog network off its pinned subnet is caught" "$d" fail "invariant 16] stage"

d=$SCRATCH/catinternal; snapshot "$d"
sed -i '/^  catalog:$/,/internal: true/{/^    internal: true$/d}' "$d/compose.yaml"
expect "a non-internal catalog network is caught" "$d" fail "invariant 16] prod"

d=$SCRATCH/gatedeny; snapshot "$d"
sed -i '/^      GATE_DENY_SUBNET: /d' "$d/docker/compose.dev.yaml"
expect "an app gate that admits the catalog subnet is caught" "$d" fail "invariant 16] dev"

# ---- gotrue-sign-in (invariants 3, 16): auth-egress has only auth; auth-app is auth plus the app
d=$SCRATCH/restegress; snapshot "$d"
sed -i 's/^    command: \["postgrest"\]$/&\n    networks: [db, supabase, auth-egress]/' "$d/$SBF"
expect "rest on the auth egress network is caught" "$d" fail "invariant 16]"

d=$SCRATCH/appegress; snapshot "$d"
sed -i 's/^    networks: \[dev, catalog, auth-app\]$/    networks: [dev, catalog, auth-app, auth-egress]/' "$d/docker/compose.dev.yaml"
expect "the dev app on the auth egress network is caught" "$d" fail "] dev"

d=$SCRATCH/restauthapp; snapshot "$d"
sed -i 's/^    command: \["postgrest"\]$/&\n    networks: [db, supabase, auth-app]/' "$d/$SBF"
expect "rest on the auth-app network is caught" "$d" fail "invariant 16]"

d=$SCRATCH/compauthapp; snapshot "$d"
sed -i 's/^    networks: \[dev\]$/    networks: [dev, auth-app]/' "$d/docker/compose.dev.yaml"
expect "the dev companion on the auth-app network is caught" "$d" fail "] dev"

d=$SCRATCH/authappinternal; snapshot "$d"
sed -i '/^  auth-app:$/,/internal: true/{/^    internal: true$/d}' "$d/compose.yaml"
expect "a non-internal auth-app network is caught" "$d" fail "invariant 16] prod"

d=$SCRATCH/egresssubnet; snapshot "$d"
sed -i 's/172\.28\.27\.0/172.28.29.0/' "$d/docker/compose.stage.yaml"
expect "an auth egress network off its pinned subnet is caught" "$d" fail "invariant 16] stage"

d=$SCRATCH/authnoapp; snapshot "$d"
sed -i 's/^    networks: \[db, supabase, auth-egress, auth-app\]$/    networks: [db, supabase, auth-egress]/' "$d/$SBF"
expect "auth off the auth-app network is caught" "$d" fail "invariant 16]"

d=$SCRATCH/apiextra; snapshot "$d"
sed -i 's/^    networks: \[back, catalog, auth-app\]$/    networks: [back, catalog, auth-app, extra]/; s/^networks:$/networks:\n  extra: {}/' "$d/compose.yaml"
expect "the prod api on a network outside back, catalog and auth-app is caught" "$d" fail "invariant 16] prod"

d=$SCRATCH/gatedenyauth; snapshot "$d"
sed -i 's#^      GATE_DENY_SUBNET: .*$#      GATE_DENY_SUBNET: 172.28.34.0/24#' "$d/docker/compose.dev.yaml"
expect "an app gate that admits the auth-app subnet is caught" "$d" fail "invariant 16] dev"

# ---- retire-sqlite-catalog (invariant 4): app source binds stay under packages/*/src
d=$SCRATCH/pkgnonsrc; snapshot "$d"
# An existing non-src package path, so the existence check can't be what refuses it.
sed -i 's#^      - { type: bind, source: ./packages/catalog/src, target: /app/packages/catalog/src, read_only: true }$#&\n      - { type: bind, source: ./packages/catalog/package.json, target: /app/packages/catalog/package.json, read_only: true }#' "$d/docker/compose.dev.yaml"
expect "a package bind outside src is caught" "$d" fail "invariant 4] dev: a read-only bind source is not under"

# ---- stage-public-https (invariant 7): stage defaults stay local; the public mode is exact
d=$SCRATCH/stagecookie; snapshot "$d"
sed -i 's/^      COOKIE_SECURE: ${STAGE_COOKIE_SECURE:-0}$/      COOKIE_SECURE: ${STAGE_COOKIE_SECURE:-1}/' "$d/docker/compose.stage.yaml"
expect "a stage COOKIE_SECURE default other than 0 is caught" "$d" fail "invariant 7] stage"

d=$SCRATCH/stageimage; snapshot "$d"
sed -i 's/^    image: ${STAGE_API_IMAGE:-autologger-stage-api:local}$/    image: autologger-stage-api:local/' "$d/docker/compose.stage.yaml"
expect "a stage api image that ignores STAGE_API_IMAGE is caught" "$d" fail "invariant 7] stage"

echo "test_check_envs: $PASS passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
