#!/bin/sh
# docker/scripts/test_check_envs.sh -- regression cases for check-envs.sh invariants 14 and 15
# (infisical-secrets tasks 2.1, 2.2), 16 and the invariant 4 exceptions (supabase-db task 2.1), and
# invariant 4's packages/*/src rule (retire-sqlite-catalog task 4.1), and the auth networks
# (gotrue-sign-in task 2.1), and the stage public mode (stage-public-https, invariant 7), and the
# blob volume (shared-blob-volume task 6.1, invariants 4, 6 and 7), and the retired Supabase
# services, networks and keys (drop-unused-supabase-services D4, invariants 3, 4, 6 and 16), and the
# media worker (media-worker task W.6, invariants 6, 7 and 16).
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
  # One tar reads the whole list: `xargs tar` splits a long list into several archives, and the
  # extracting tar stops at the first one's end (every later file was silently dropped).
  (cd "$ROOT" && git ls-files -co --exclude-standard -z | tar --null -T - -cf -) | tar -xf - -C "$1"
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
# drop-unused-supabase-services D4: the cases that targeted rest, storage or the gateway now target
# auth or db (pwrest, storageport, apprest, restcat, restegress, restauthapp, gwbind); the gateway
# and supabase/edge network cases (gwdb, restedge, sbinternal, edgesubnet) went with their target.
SBF=docker/supabase-services.yaml
d=$SCRATCH/pwauth; snapshot "$d"
sed -i 's#^      GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED: "false"$#&\n      X_PW: ${POSTGRES_PASSWORD}#' "$d/$SBF"
expect "the superuser password in auth is caught" "$d" fail "invariant 16]"

d=$SCRATCH/authimg; snapshot "$d"
sed -i 's#^    image: supabase/gotrue@sha256:[0-9a-f]* \# v2.196.0$#    image: supabase/gotrue:v2.196.0#' "$d/$SBF"
expect "an unpinned auth image is caught" "$d" fail "invariant 16]"

d=$SCRATCH/authport; snapshot "$d"
sed -i 's/^      GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED: "false"$/&\n    ports: ["127.0.0.1:9999:9999"]/' "$d/$SBF"
expect "auth publishing a port is caught" "$d" fail "invariant 16]"

d=$SCRATCH/anonapi; snapshot "$d"
sed -i 's/^    container_name: autologger-api$/    container_name: autologger-api\n    labels: { k: "${ANON_KEY}" }/' "$d/compose.yaml"
expect "the anon key in prod api is caught" "$d" fail "invariant 16] prod"

d=$SCRATCH/caddybind; snapshot "$d"
sed -i '0,/dev-gate.Caddyfile:\/etc\/caddy\/Caddyfile:ro$/s#^      - ./docker/dev-gate.Caddyfile:/etc/caddy/Caddyfile:ro$#&\n      - ./docker/Caddyfile:/x:ro#' "$d/docker/compose.dev.yaml"
expect "the router Caddyfile bound into the dev app gate is caught" "$d" fail "invariant 4] dev: a read-only bind source"

d=$SCRATCH/initbind; snapshot "$d"
sed -i '0,/dev-gate.Caddyfile:\/etc\/caddy\/Caddyfile:ro$/s#^      - ./docker/dev-gate.Caddyfile:/etc/caddy/Caddyfile:ro$#&\n      - ./docker/supabase/init/roles.sql:/x.sql:ro#' "$d/docker/compose.dev.yaml"
expect "init SQL mounted outside db is caught" "$d" fail "invariant 4] dev"

# ---- catalog-pg-schema (invariants 3 and 16: the two-member catalog network, APP_DB_PASSWORD)
d=$SCRATCH/appauth; snapshot "$d"
sed -i 's#^      GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED: "false"$#&\n      X_PW: ${APP_DB_PASSWORD}#' "$d/$SBF"
expect "the app password in auth is caught" "$d" fail "invariant 16]"

d=$SCRATCH/appweb; snapshot "$d"
sed -i '0,/^    networks: \[front\]$/s//    networks: [front]\n    labels: { pw: "${APP_DB_PASSWORD}" }/' "$d/compose.yaml"
expect "the app password in prod web is caught" "$d" fail "invariant 16] prod"

d=$SCRATCH/compcat; snapshot "$d"
sed -i '/^  companion:$/,/networks:/s/networks: \[dev\]/networks: [dev, catalog]/' "$d/docker/compose.dev.yaml"
expect "companion joined to the catalog network is caught" "$d" fail "invariant 16] dev"

d=$SCRATCH/authcat; snapshot "$d"
sed -i 's/^    networks: \[db, auth-egress, auth-app\]$/    networks: [db, auth-egress, auth-app, catalog]/' "$d/$SBF"
expect "auth on the catalog network is caught" "$d" fail "invariant 16]"

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
d=$SCRATCH/dbegress; snapshot "$d"
sed -i 's/^    networks: \[db, catalog, media\]$/    networks: [db, catalog, media, auth-egress]/' "$d/$DBF"
expect "db on the auth egress network is caught" "$d" fail "invariant 16]"

d=$SCRATCH/appegress; snapshot "$d"
sed -i 's/^    networks: \[dev, catalog, auth-app\]$/    networks: [dev, catalog, auth-app, auth-egress]/' "$d/docker/compose.dev.yaml"
expect "the dev app on the auth egress network is caught" "$d" fail "] dev"

d=$SCRATCH/dbauthapp; snapshot "$d"
sed -i 's/^    networks: \[db, catalog, media\]$/    networks: [db, catalog, media, auth-app]/' "$d/$DBF"
expect "db on the auth-app network is caught" "$d" fail "invariant 16]"

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
sed -i 's/^    networks: \[db, auth-egress, auth-app\]$/    networks: [db, auth-egress]/' "$d/$SBF"
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

# ---- shared-blob-volume (invariants 4, 6, 7): BLOB_DIR is the literal /blobs on its own named volume
d=$SCRATCH/devblobvar; snapshot "$d"
sed -i 's#^      BLOB_DIR: /blobs$#      BLOB_DIR: ${BLOB_DIR:-/blobs}#' "$d/docker/compose.dev.yaml"
expect "a dev BLOB_DIR that is not a literal is caught" "$d" fail "invariant 6] dev: a posture pin"

d=$SCRATCH/devblobval; snapshot "$d"
sed -i 's#^      BLOB_DIR: /blobs$#      BLOB_DIR: /data/blobs#' "$d/docker/compose.dev.yaml"
expect "a dev BLOB_DIR other than /blobs is caught" "$d" fail "invariant 6] dev: a resolved posture pin"

d=$SCRATCH/devblobvol; snapshot "$d"
sed -i 's#^      - dev-blobs:/blobs$#      - dev-home:/blobs#' "$d/docker/compose.dev.yaml"
expect "a dev /blobs that is not the dev-blobs volume is caught" "$d" fail "invariant 4] dev: BLOB_DIR"

d=$SCRATCH/devblobnovol; snapshot "$d"
sed -i '0,/^      - dev-blobs:\/blobs$/{/^      - dev-blobs:\/blobs$/d}' "$d/docker/compose.dev.yaml"
expect "a dev app without a /blobs volume is caught" "$d" fail "invariant 4] dev: BLOB_DIR"

d=$SCRATCH/apiblobenv; snapshot "$d"
sed -i '0,/^      BLOB_DIR: \/blobs$/{/^      BLOB_DIR: \/blobs$/d}' "$d/compose.yaml"
expect "a prod api without BLOB_DIR is caught" "$d" fail "invariant 7] prod: api BLOB_DIR"
expect "a stage api without BLOB_DIR is caught" "$d" fail "invariant 7] stage: api BLOB_DIR"

d=$SCRATCH/apiblobvol; snapshot "$d"
sed -i '0,/^      - autologger-blobs:\/blobs$/{/^      - autologger-blobs:\/blobs$/d}' "$d/compose.yaml"
expect "a prod api without the /blobs named volume is caught" "$d" fail "invariant 7] prod: api /blobs"
expect "a stage api without the /blobs named volume is caught" "$d" fail "invariant 7] stage: api /blobs"

d=$SCRATCH/apiblobbind; snapshot "$d"
sed -i 's#^      - autologger-blobs:/blobs$#      - ./blobs:/blobs#' "$d/compose.yaml"
expect "a prod api /blobs bind mount is caught" "$d" fail "invariant 7] prod: api /blobs"

d=$SCRATCH/stageblobenv; snapshot "$d"
sed -i 's#^      SESSION_COOKIE: autologger_stage_sid$#&\n      BLOB_DIR: /srv/blobs#' "$d/docker/compose.stage.yaml"
expect "a stage overlay that moves BLOB_DIR is caught" "$d" fail "invariant 7] stage: api BLOB_DIR"

# ---- drop-unused-supabase-services (invariants 3, 6, 16, design D4): the retired services,
# their networks and their keys stay out of every stack
d=$SCRATCH/restback; snapshot "$d"
sed -i 's#^services:$#services:\n  rest:\n    image: postgrest/postgrest@sha256:c9dc201e555f5d8e37e7f39cdd4df0229774996e213bfd7de8d10ac609030f2c\n    networks: [db]\n#' "$d/$SBF"
expect "a rest service added back is caught" "$d" fail "invariant 16] prod: a retired Supabase service"
expect "a rest service added back changes the dev service set" "$d" fail "invariant 6] dev: the service set"

d=$SCRATCH/gwback; snapshot "$d"
sed -i 's#^services:$#services:\n  supabase-gw:\n    image: caddy@sha256:0c994536bddb66445885237f1a5dcc1916bccea922661c76b4e9fc24061f9b52\n    ports: ["127.0.0.1:8790:8000"]\n#' "$d/$SBF"
expect "a supabase-gw service added back is caught" "$d" fail "invariant 16] prod: a retired Supabase service"
expect "a supabase-gw port added back is caught in dev" "$d" fail "invariant 3] dev"

d=$SCRATCH/authsupabase; snapshot "$d"
sed -i 's/^    networks: \[db, auth-egress, auth-app\]$/    networks: [db, auth-egress, auth-app, supabase]/' "$d/$SBF"
printf 'networks:\n  supabase:\n    internal: true\n' >>"$d/$SBF"
expect "auth on a new supabase network is caught" "$d" fail "invariant 16] prod: a supabase or edge network"

d=$SCRATCH/webedge; snapshot "$d"
sed -i '0,/^    networks: \[front\]$/s//    networks: [front, edge]/' "$d/compose.yaml"
printf 'networks:\n  edge: {}\n' >>"$d/$SBF"
expect "a service on a new edge network is caught" "$d" fail "invariant 16] prod: a supabase or edge network"

d=$SCRATCH/authsvckey; snapshot "$d"
sed -i 's#^    image: supabase/gotrue@sha256:[0-9a-f]* \# v2.196.0$#&\n    labels: { k: "${SERVICE_ROLE_KEY}" }#' "$d/$SBF"
expect "the retired service-role key in an auth label is caught" "$d" fail "invariant 16] prod: the retired SERVICE_ROLE_KEY value"

# ---- media-worker (invariants 6, 7, 16; design D1, D4, D15): the worker joins only `media`, whose
# members are exactly db and media-worker; it runs confined, holds only its own password and the five
# connection literals plus BLOB_DIR, and mounts only the blob volume
MW='/^  media-worker:$/,/^  [a-z]/'
d=$SCRATCH/mwthird; snapshot "$d"
sed -i '/^  companion:$/,/networks:/s/networks: \[dev\]/networks: [dev, media]/' "$d/docker/compose.dev.yaml"
expect "a third member of the media network (dev companion) is caught" "$d" fail "invariant 16] dev: the media network"

d=$SCRATCH/mwapi; snapshot "$d"
sed -i 's/^    networks: \[back, catalog, auth-app\]$/    networks: [back, catalog, auth-app, media]/' "$d/compose.yaml"
expect "the prod api on the media network is caught" "$d" fail "invariant 16] prod: the media network"

d=$SCRATCH/mwback; snapshot "$d"
sed -i 's/^    networks: \[media\]$/    networks: [media, back]/' "$d/compose.yaml"
expect "media-worker on another network (back) is caught" "$d" fail "invariant 16] prod: media-worker"

d=$SCRATCH/mwcatalog; snapshot "$d"
sed -i 's/^    networks: \[media\]$/    networks: [media, catalog]/' "$d/docker/compose.dev.yaml"
expect "media-worker on the catalog network is caught" "$d" fail "invariant 16] dev"

d=$SCRATCH/dbnomedia; snapshot "$d"
sed -i 's/^    networks: \[db, catalog, media\]$/    networks: [db, catalog]/' "$d/$DBF"
expect "db off the media network is caught" "$d" fail "invariant 16] prod"

d=$SCRATCH/mwport; snapshot "$d"
sed -i "$MW"'s/^    networks: \[media\]$/    networks: [media]\n    ports: ["127.0.0.1:9000:9000"]/' "$d/compose.yaml"
expect "a published worker port is caught" "$d" fail "invariant 16] prod: media-worker"

d=$SCRATCH/mwroot; snapshot "$d"
sed -i "$MW"'s/^    user: "10001:10001"$/    user: "0:0"/' "$d/compose.yaml"
expect "a root worker is caught" "$d" fail "invariant 16] prod: media-worker"

d=$SCRATCH/mwappuid; snapshot "$d"
sed -i "$MW"'s/^    user: "10001:10001"$/    user: node/' "$d/docker/compose.dev.yaml"
expect "a worker running as the app user is caught" "$d" fail "invariant 16] dev: media-worker"

d=$SCRATCH/mwnouser; snapshot "$d"
sed -i "$MW"'{/^    user: "10001:10001"$/d}' "$d/compose.yaml"
expect "a worker with the image's default user is caught" "$d" fail "invariant 16] prod: media-worker"

d=$SCRATCH/mwwritable; snapshot "$d"
sed -i "$MW"'s/^    read_only: true$/    read_only: false/' "$d/compose.yaml"
expect "a writable worker root filesystem is caught" "$d" fail "invariant 16] prod: media-worker"

d=$SCRATCH/mwcaps; snapshot "$d"
sed -i "$MW"'s/^    cap_drop: \[ALL\]$/    cap_drop: [NET_RAW]/' "$d/docker/compose.dev.yaml"
expect "a worker keeping capabilities is caught" "$d" fail "invariant 16] dev: media-worker"

d=$SCRATCH/mwnnp; snapshot "$d"
sed -i "$MW"'{/^    security_opt: \["no-new-privileges:true"\]$/d}' "$d/compose.yaml"
expect "a worker without no-new-privileges is caught" "$d" fail "invariant 16] prod: media-worker"

d=$SCRATCH/mwdata; snapshot "$d"
sed -i "$MW"'s#^      - autologger-blobs:/blobs$#&\n      - autologger-data:/data#' "$d/compose.yaml"
expect "a worker mounting /data is caught" "$d" fail "invariant 16] prod: media-worker"

d=$SCRATCH/mwblobvol; snapshot "$d"
sed -i "$MW"'s#^      - dev-blobs:/blobs$#      - dev-home:/blobs#' "$d/docker/compose.dev.yaml"
expect "a worker /blobs that is not the blob volume is caught" "$d" fail "invariant 16] dev: media-worker"

d=$SCRATCH/mwpwapi; snapshot "$d"
sed -i 's/^    container_name: autologger-api$/    container_name: autologger-api\n    labels: { pw: "${MEDIA_DB_PASSWORD}" }/' "$d/compose.yaml"
expect "the worker password in prod api is caught" "$d" fail "invariant 16] prod: the MEDIA_DB_PASSWORD value"

d=$SCRATCH/mwpwauth; snapshot "$d"
sed -i 's#^      GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED: "false"$#&\n      X_PW: ${MEDIA_DB_PASSWORD}#' "$d/$SBF"
expect "the worker password in auth is caught" "$d" fail "the MEDIA_DB_PASSWORD value"

d=$SCRATCH/mwappdb; snapshot "$d"
sed -i "$MW"'s/^      PGPASSWORD: ${MEDIA_DB_PASSWORD:?\(.*\)}$/      PGPASSWORD: ${APP_DB_PASSWORD:?\1}/' "$d/compose.yaml"
expect "the app password in the worker is caught" "$d" fail "invariant 16] prod: the APP_DB_PASSWORD value"

d=$SCRATCH/mwenv; snapshot "$d"
sed -i "$MW"'s#^      BLOB_DIR: /blobs$#&\n      NODE_OPTIONS: --inspect#' "$d/docker/compose.dev.yaml"
expect "a worker environment name beyond the PG* literals and BLOB_DIR is caught" "$d" fail "invariant 16] dev: media-worker's environment"

d=$SCRATCH/mwpguser; snapshot "$d"
sed -i "$MW"'s/^      PGUSER: autologger_media$/      PGUSER: autologger_app/' "$d/compose.yaml"
expect "a worker connecting as another role is caught" "$d" fail "invariant 16] prod: media-worker's environment"

d=$SCRATCH/mwextends; snapshot "$d"
sed -i "$MW"'s/^    restart: unless-stopped$/&\n    extends: { file: docker\/secrets-env.yaml, service: secrets }/' "$d/compose.yaml"
expect "a worker extending the allowlist is caught" "$d" fail "invariant 16] prod: media-worker's environment"

d=$SCRATCH/mwnoservice; snapshot "$d"
sed -i 's/^  media-worker:$/  mediaworker:/' "$d/docker/compose.dev.yaml"
expect "the dev service set without media-worker is caught" "$d" fail "invariant 6] dev: the service set"

d=$SCRATCH/mwinternal; snapshot "$d"
sed -i '/^  media:$/,/internal: true/{/^    internal: true$/d}' "$d/compose.yaml"
expect "a non-internal media network is caught" "$d" fail "invariant 16] prod: the media network"

d=$SCRATCH/mwisolated; snapshot "$d"
sed -i '/^  media:$/,/ipam:/{/gateway_mode_ipv4: isolated/d}' "$d/docker/compose.dev.yaml"
expect "a media network without host isolation is caught" "$d" fail "invariant 16] dev: the media network"

d=$SCRATCH/mwsubnet; snapshot "$d"
sed -i 's/172\.28\.29\.0/172.28.30.0/' "$d/docker/compose.stage.yaml"
expect "a media network off its pinned subnet is caught" "$d" fail "invariant 16] stage: the media network"

d=$SCRATCH/mwstageimage; snapshot "$d"
sed -i 's/^    image: ${STAGE_MEDIA_IMAGE:-autologger-stage-media-worker:local}$/    image: autologger-stage-media-worker:local/' "$d/docker/compose.stage.yaml"
expect "a stage worker image that ignores STAGE_MEDIA_IMAGE is caught" "$d" fail "invariant 7] stage"

d=$SCRATCH/mwprodlatest; snapshot "$d"
sed -i 's#^    image: ghcr.io/kwcantrell/autologger-media-worker:${MEDIA_TAG:?.*}$#    image: ghcr.io/kwcantrell/autologger-media-worker:latest#' "$d/compose.yaml"
expect "a prod worker image not pinned by MEDIA_TAG is caught" "$d" fail "invariant 7] prod: media-worker"

echo "test_check_envs: $PASS passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
