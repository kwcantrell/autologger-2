#!/bin/sh
# docker/scripts/make-guards.sh -- guard logic for the root Makefile (containerized-dev-env, task 7.2).
#
#   make-guards.sh envfile dev|stage      env file present (names the template) + port keys valid
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
# Run from the repo root (the Makefile does). POSIX sh. It reads ONLY named port / tag keys from
# env files with grep+sed; it never sources or prints an env file, and never reads the contents
# of ~/.claude/.credentials.json (inode only).
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd -P)
cd "$ROOT"
# shellcheck source=docker/scripts/compose-env.sh
. docker/scripts/compose-env.sh

die() { echo "make: $*" >&2; exit 1; }

# key_of FILE KEY: last KEY=value line's value, trailing whitespace/CR stripped, may be empty.
key_of() {
  grep -E "^$2=" "$1" 2>/dev/null | tail -n 1 | sed -e "s/^$2=//" -e 's/[[:space:]]*$//' || true
}

# port_ok KEYNAME VALUE: empty (compose default) or a plain decimal 1-65535, and not 8080.
port_ok() {
  case "$2" in
    '') return 0 ;;
    *[!0-9]*) die "$1=$2 is not a plain decimal port (empty means the default)" ;;
    0*) die "$1=$2 must not have a leading zero" ;;
  esac
  [ "$2" -le 65535 ] || die "$1=$2 is above 65535"
  [ "$2" != 8080 ] || die "$1=8080 is production's router port; pick another"
}

envfile() {
  case "$1" in
    dev)   f=.env.dev;   t=docker/.env.dev.example ;;
    stage) f=.env.stage; t=docker/.env.stage.example ;;
    *) die "envfile: dev|stage" ;;
  esac
  [ -f "$f" ] || die "$f is missing. Create it from the template:  cp $t $f   (then fill in values)"
  if [ "$1" = dev ]; then
    dp=$(key_of "$f" DEV_PORT); cp=$(key_of "$f" DEV_COMPANION_PORT)
    port_ok DEV_PORT "$dp"; port_ok DEV_COMPANION_PORT "$cp"
    [ "${dp:-8787}" != "${cp:-8000}" ] || die "DEV_PORT and DEV_COMPANION_PORT must differ"
  else
    port_ok STAGE_PORT "$(key_of "$f" STAGE_PORT)"
  fi
}

urls() {
  case "$1" in
    dev)
      dp=$(key_of .env.dev DEV_PORT); cp=$(key_of .env.dev DEV_COMPANION_PORT)
      echo "dev app:        http://127.0.0.1:${dp:-8787}"
      echo "dev Companion:  http://127.0.0.1:${cp:-8000}"
      echo "In Companion, set the AutoLogger connection base URL to:  http://app:8787"
      ;;
    stage)
      sp=$(key_of .env.stage STAGE_PORT)
      echo "stage:          http://localhost:${sp:-8788}   (use localhost, not 127.0.0.1)"
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
  hi=$(stat -c %i "$HOME/.claude/.credentials.json" 2>/dev/null || true)
  ci=$(docker exec "$c" stat -c %i /home/node/.claude/.credentials.json 2>/dev/null || true)
  [ -n "$hi" ] && [ -n "$ci" ] || return 0
  if [ "$hi" != "$ci" ]; then
    echo "WARNING: the host ~/.claude/.credentials.json (inode $hi) is no longer the file $c sees (inode $ci)." >&2
    echo "         The host file was replaced (rename-on-refresh); the container holds a stale copy." >&2
    echo "         Fix: make dev-down && make dev-up  (re-binds the current file). See README dev section." >&2
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
  envfile) envfile "${1:-}" ;;
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
