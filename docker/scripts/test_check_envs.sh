#!/bin/sh
# docker/scripts/test_check_envs.sh -- regression cases for check-envs.sh invariants 14 and 15
# (infisical-secrets tasks 2.1, 2.2). Each case copies the working tree (tracked + untracked,
# git-ignored files excluded, so no env file or data directory is copied) to a scratch dir,
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
  (cd "$ROOT" && git ls-files -co --exclude-standard -z | xargs -0 tar -cf -) | tar -xf - -C "$1"
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
expect "clean tree passes (prod + e2e overlay env_file exempt)" "$BASE" ok

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

echo "test_check_envs: $PASS passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
