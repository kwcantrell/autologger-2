#!/bin/sh
# docker/scripts/make-guards.sh -- guard logic for the root Makefile (containerized-dev-env, task 7.2).
#
#   make-guards.sh envfile dev|stage      env file present (names the template) + resolved config safe
#   make-guards.sh urls dev|stage         print the URLs to use after `up`
#   make-guards.sh creds-exists           host ~/.claude/.credentials.json must exist (dev bind)
#   make-guards.sh creds-inode            WARN (exit 0) if host and running dev container inodes differ
#   make-guards.sh reset dev|stage        CONFIRM=yes + resolved project name check; prints the env
#                                         file to pass to `down -v` (the real one, else /dev/null)
#   make-guards.sh prod-git               clean working tree AND branch main
#   make-guards.sh prod-tags              WEB_TAG and API_TAG set (non-empty, not latest) in root .env
#   make-guards.sh prod-builder BUILDER   buildx builder lists linux/amd64 and linux/arm64
#   make-guards.sh native-platform        print linux/arm64 or linux/amd64 (the docker server's arch)
#
# Run from the repo root (the Makefile does). POSIX sh. It reads ONLY tag keys (and COMPOSE_ key
# names) from env files with grep+sed, and validates the rest through compose config; it never sources or prints an env file, and never reads the contents
# of ~/.claude/.credentials.json (inode only).
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd -P)
cd "$ROOT"
# shellcheck source=docker/scripts/compose-env.sh
. docker/scripts/compose-env.sh

die() { echo "make: $*" >&2; exit 1; }

# key_of FILE KEY: last KEY=value line's value, trailing whitespace/CR stripped, may be empty.
# (Used only for the prod .env tags; the dev/stage port and project guards and the post-`up`
# URL hints use the RESOLVED compose config instead, see envfile and urls.)
key_of() {
  grep -E "^$2=" "$1" 2>/dev/null | tail -n 1 | sed -e "s/^$2=//" -e 's/[[:space:]]*$//' || true
}

# envfile dev|stage: the env file exists (names the template) and the config compose will
# actually run is safe. Validation is on the RESOLVED config (`config --no-env-resolution
# --format json`, which never inlines env_file contents), so it sees the env file, the process
# environment (`DEV_PORT=8080 make dev-up`) and compose's own parsing (`export X=`, indentation,
# `X = y`) exactly as `up` will. It prints ONLY a problem description, never the JSON (which
# holds interpolated values). Also rejects any COMPOSE_* key by name: those re-target compose
# itself (COMPOSE_PROJECT_NAME onto prod's volumes) and have no place in a dev/stage env file.
# TEST HOOK: an optional 2nd argument names the env file to validate, honored only when
# AUTOLOGGER_TEST=1 (so dev cases can be exercised without touching the operator's .env.dev).
envfile() {
  case "$1" in
    dev)   f=.env.dev;   t=docker/.env.dev.example;   fn=compose_dev;   want=autologger-dev ;;
    stage) f=.env.stage; t=docker/.env.stage.example; fn=compose_stage; want=autologger-stage ;;
    *) die "envfile: dev|stage" ;;
  esac
  if [ "${AUTOLOGGER_TEST:-}" = 1 ] && [ -n "${2:-}" ]; then f=$2; fi
  [ -f "$f" ] || die "$f is missing. Create it from the template:  cp $t $f   (then fill in values)"
  if grep -Eq '^[[:space:]]*(export[[:space:]]+)?COMPOSE_' "$f"; then
    die "$f sets a COMPOSE_* variable; remove it (COMPOSE_* re-targets the compose project/files and is not allowed in $1 env files)"
  fi
  json=$("$fn" "$f" config --no-env-resolution --format json 2>/dev/null) ||
    die "compose could not resolve the $1 config with $f (bad port value?); run the compose config by hand to see why"
  if [ "$1" = dev ]; then
    flt='.name==$want
         and ([.services[]|(.ports//[])[]]|length==2)
         and ([.services[]|(.ports//[])[]|select(.host_ip!="127.0.0.1")]|length==0)
         and ([.services[]|(.ports//[])[]|.published|tostring]|all(test("^[1-9][0-9]{0,4}$") and (tonumber<=65535) and .!="8080" and .!="80" and .!="443"))
         and (.services.app.ports[0].published!=.services.companion.ports[0].published)'
  else
    flt='.name==$want
         and ([.services[]|(.ports//[])[]]|length==1)
         and ([.services[]|(.ports//[])[]|select(.host_ip!="127.0.0.1")]|length==0)
         and ([.services[]|(.ports//[])[]|.published|tostring]|all(test("^[1-9][0-9]{0,4}$") and (tonumber<=65535) and .!="8080"))'
  fi
  # Diagnose which property failed without echoing any value except the project name and 8080.
  printf '%s' "$json" | jq -e --arg want "$want" ".name==\$want" >/dev/null ||
    die "refusing: compose resolves the $1 project to a name other than '$want' (a COMPOSE_PROJECT_NAME override?)"
  printf '%s' "$json" | jq -e '[.services[]|(.ports//[])[]|select(.host_ip!="127.0.0.1")]|length==0' >/dev/null ||
    die "refusing: a published $1 port is not bound to 127.0.0.1"
  printf '%s' "$json" | jq -e '[.services[]|(.ports//[])[]|.published|tostring]|any(.=="8080")|not' >/dev/null ||
    die "refusing: a published $1 port is 8080 (production's router port); pick another (check the env file AND your shell environment)"
  printf '%s' "$json" | jq -e '[.services[]|(.ports//[])[]|.published|tostring]|all(test("^[1-9][0-9]{0,4}$") and (tonumber<=65535))' >/dev/null ||
    die "refusing: a published $1 port is not a plain number 1-65535"
  # Dev only: 80/443 pass every other guard but browsers omit the default port from the Origin/
  # Host header, so the dev gate (which matches "host:port") would reject every request
  # (fail-closed, but confusing). Stage has no Host allowlist, so STAGE_PORT=80 is left alone.
  if [ "$1" = dev ]; then
    printf '%s' "$json" | jq -e '[.services[]|(.ports//[])[]|.published|tostring]|any(.=="80" or .=="443")|not' >/dev/null ||
      die "refusing: a published dev port is 80 or 443; browsers omit the default port from Host/Origin so the dev gate would reject every request. Pick another DEV_PORT/DEV_COMPANION_PORT (check the env file AND your shell environment)"
  fi
  printf '%s' "$json" | jq -e --arg want "$want" "$flt" >/dev/null ||
    die "refusing: the resolved $1 ports are not the expected set (dev: app and Companion on distinct ports; stage: the router only)"
}

# urls dev|stage: print the URLs to use after `up`. The ports come from the RESOLVED config (the
# same compose call the envfile guard uses), so a shell `DEV_PORT=9000`, an `export DEV_PORT=`
# line or any other form compose accepts is reflected. Prints only port numbers.
urls() {
  case "$1" in
    dev)
      j=$(compose_dev .env.dev config --no-env-resolution --format json 2>/dev/null) ||
        die "urls: could not resolve the dev config"
      p=$(printf '%s' "$j" | jq -r '[.services.app.ports[0].published,.services.companion.ports[0].published]|map(tostring)|join(" ")')
      dp=${p%% *}; cp=${p##* }
      echo "dev app:        http://127.0.0.1:$dp"
      echo "dev Companion:  http://127.0.0.1:$cp"
      echo "In Companion, set the AutoLogger connection base URL to:  http://app:8787"
      ;;
    stage)
      j=$(compose_stage .env.stage config --no-env-resolution --format json 2>/dev/null) ||
        die "urls: could not resolve the stage config"
      sp=$(printf '%s' "$j" | jq -r '.services.router.ports[0].published|tostring')
      echo "stage:          http://localhost:$sp   (use localhost, not 127.0.0.1)"
      ;;
    *) die "urls: dev|stage" ;;
  esac
}

creds_exists() {
  [ -f "$HOME/.claude/.credentials.json" ] ||
    die "host ~/.claude/.credentials.json is missing; dev mounts it (create_host_path is false). Run 'claude auth login' on the host first."
}

creds_inode() {
  c=autologger-dev-app
  [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || true)" = true ] || return 0
  # TEST-ONLY override, honored only when AUTOLOGGER_TEST=1 is also set (an ambient
  # AUTOLOGGER_TEST_HOST_CREDS alone can no longer mask the warning). Lets the mismatch branch
  # be exercised against a scratch file without touching ~/.claude/.credentials.json.
  # Stat only, never read.
  hc=$HOME/.claude/.credentials.json
  if [ "${AUTOLOGGER_TEST:-}" = 1 ] && [ -n "${AUTOLOGGER_TEST_HOST_CREDS:-}" ]; then hc=$AUTOLOGGER_TEST_HOST_CREDS; fi
  hi=$(stat -c %i "$hc" 2>/dev/null || true)
  ci=$(docker exec "$c" stat -c %i /home/node/.claude/.credentials.json 2>/dev/null || true)
  [ -n "$hi" ] && [ -n "$ci" ] || return 0
  if [ "$hi" != "$ci" ]; then
    echo "WARNING: the host ~/.claude/.credentials.json (inode $hi) is no longer the file $c sees (inode $ci)." >&2
    echo "         The host file was replaced (rename-on-refresh); the container holds a stale copy." >&2
    echo "         Fix: if the host is logged out run 'claude auth login' (or plain 'claude' then /login; verify which the installed CLI supports via 'claude --help' inside the dev image); then make dev-restart (or make dev-down && make dev-up). See README dev section." >&2
  fi
  return 0
}

reset() {
  case "$1" in
    dev)   f=.env.dev;   fn=compose_dev;   want=autologger-dev ;;
    stage) f=.env.stage; fn=compose_stage; want=autologger-stage ;;
    *) die "reset: dev|stage" ;;
  esac
  [ "${CONFIRM:-}" = yes ] || die "refusing: 'make $1-reset' deletes the $want volumes. Re-run with CONFIRM=yes."
  [ -f "$f" ] || f=/dev/null
  got=$("$fn" "$f" config --no-env-resolution --format json | jq -r .name)
  [ "$got" = "$want" ] || die "refusing: compose resolved project name '$got', expected '$want'"
  echo "$f"
}

prod_git() {
  [ -z "$(git status --porcelain)" ] || die "refusing: working tree is not clean (commit or stash; untracked files count)"
  b=$(git rev-parse --abbrev-ref HEAD)
  [ "$b" = main ] || die "refusing: on branch '$b', prod targets require main"
}

prod_tags() {
  [ -f .env ] || die "root .env is missing: cp docker/.env.example .env (README: Container deployment)"
  for k in WEB_TAG API_TAG; do
    v=$(key_of .env "$k")
    [ -n "$v" ] || die "$k is unset or empty in .env (a git-SHA tag is required)"
    [ "$v" != latest ] || die "$k=latest is refused; pin a git-SHA tag"
  done
}

prod_builder() {
  out=$(docker buildx inspect "$1" 2>/dev/null) || out=
  if echo "$out" | grep -q 'linux/amd64' && echo "$out" | grep -q 'linux/arm64'; then return 0; fi
  {
    echo "make: builder '$1' is missing or does not list both linux/amd64 and linux/arm64."
    echo "One-time setup (privileged host change; see README 'Container deployment'):"
    echo "  docker run --privileged --rm tonistiigi/binfmt --install all"
    echo "  docker buildx create --name $1 --driver docker-container"
    echo "  docker buildx inspect --builder $1 --bootstrap"
  } >&2
  exit 1
}

native_platform() {
  case "$(docker version -f '{{.Server.Arch}}')" in
    arm64|aarch64) echo linux/arm64 ;;
    amd64|x86_64) echo linux/amd64 ;;
    *) die "unsupported docker server architecture" ;;
  esac
}

cmd=${1:-}; [ $# -gt 0 ] && shift
case "$cmd" in
  envfile) envfile "${1:-}" "${2:-}" ;;
  urls) urls "${1:-}" ;;
  creds-exists) creds_exists ;;
  creds-inode) creds_inode ;;
  reset) reset "${1:-}" ;;
  prod-git) prod_git ;;
  prod-tags) prod_tags ;;
  prod-builder) prod_builder "${1:-}" ;;
  native-platform) native_platform ;;
  *) echo "usage: $0 envfile|urls|creds-exists|creds-inode|reset|prod-git|prod-tags|prod-builder|native-platform" >&2; exit 2 ;;
esac
