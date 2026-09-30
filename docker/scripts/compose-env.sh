# docker/scripts/compose-env.sh -- shared compose invocation flags (containerized-dev-env, seam S2).
#
# SOURCED, never executed, by docker/scripts/check-envs.sh (task 7.1) and the root Makefile
# (task 7.2). Plain POSIX sh: no arrays, no `local`, no bashisms, so it works from dash and from
# a Makefile recipe (`. docker/scripts/compose-env.sh; compose_dev .env.dev up -d`).
#
# The property this file exists to keep: the static check and the Makefile resolve each
# project with the SAME compose file set, the SAME --project-directory and the SAME placeholder
# exports, and differ ONLY in which env file they pass (the check passes a placeholder file in
# a temp dir; the Makefile passes the operator's real one).
#
# Contract
#   * The current directory MUST be the repository root (every path below is root-relative;
#     compose.dev.yaml's relative binds depend on it). Each function fails if it is not.
#   * Every function takes the env file path as $1 and passes it as `--env-file`; the
#     remaining arguments are appended verbatim (global flags such as an extra `-f FILE` and
#     the subcommand). The env file is ALWAYS passed, so compose's default interpolation file
#     (the root .env, which is prod's) is never read for dev or stage.
#   * compose_dev   ENVFILE ARGS...   project autologger-dev
#       docker compose --project-directory . --env-file ENVFILE -f docker/compose.dev.yaml ARGS
#   * compose_stage ENVFILE ARGS...   project autologger-stage (the overlay's `name:` wins)
#       WEB_TAG=stage API_TAG=stage PUBLIC_BASE_URL=http://localhost:8788 (placeholders that only
#       satisfy compose.yaml's `${...:?}` guards, which compose interpolates BEFORE the merge)
#       docker compose -f compose.yaml -f docker/compose.stage.yaml --env-file ENVFILE ARGS
#   * compose_prod  ENVFILE ARGS...   project autologger; exactly README "Container deployment"
#       docker compose -f compose.yaml --env-file ENVFILE ARGS      (ENVFILE is normally .env)
#     No `-p` is ever passed: the project name must come from each file's own top-level `name:`.
#   * Ambient COMPOSE_PROJECT_NAME / COMPOSE_FILE / COMPOSE_PATH_SEPARATOR / COMPOSE_PROFILES /
#     COMPOSE_ENV_FILES / COMPOSE_DISABLE_ENV_FILE are stripped for the call (they would
#     silently override `name:`, the file list or the env file). The Makefile only reaches these
#     functions through docker/scripts/compose-run.mjs (infisical-secrets), which passes
#     /dev/null as the env file and an environment built from the stack's Infisical secrets, so
#     ambient overrides such as `DEV_PORT=9000 make dev-up` no longer apply: set the value in
#     Infisical. check-envs.sh strips the caller's variables itself.
#   * Variables (for callers that need the raw pieces): AL_DEV_FILE, AL_STAGE_FILES,
#     AL_PROD_FILE, AL_E2E_OVERLAY, AL_STAGE_WEB_TAG, AL_STAGE_API_TAG, AL_STAGE_PUBLIC_BASE_URL.

# shellcheck disable=SC2034  # the AL_* variables are consumed by the sourcing script
AL_DEV_FILE=docker/compose.dev.yaml
AL_PROD_FILE=compose.yaml
AL_STAGE_OVERLAY=docker/compose.stage.yaml
AL_STAGE_FILES="$AL_PROD_FILE $AL_STAGE_OVERLAY"
AL_E2E_OVERLAY=e2e/container/compose.e2e.yaml
AL_STAGE_WEB_TAG=stage
AL_STAGE_API_TAG=stage
AL_STAGE_PUBLIC_BASE_URL=http://localhost:8788

al_compose_guard() {
  if [ ! -f compose.yaml ] || [ ! -f docker/compose.dev.yaml ]; then
    echo "compose-env.sh: run from the repository root (compose.yaml not found in $(pwd))" >&2
    return 2
  fi
}

# AL_EXEC=1 (set by docker/scripts/compose-run.mjs only) execs instead of forking, so the
# wrapper's child IS docker and a forwarded SIGTERM/SIGHUP reaches it (infisical-secrets H9).
al_compose() {
  if [ "${AL_EXEC:-}" = 1 ]; then
    exec env -u COMPOSE_PROJECT_NAME -u COMPOSE_FILE -u COMPOSE_PATH_SEPARATOR -u COMPOSE_PROFILES \
      -u COMPOSE_ENV_FILES -u COMPOSE_DISABLE_ENV_FILE "$@"
  fi
  env -u COMPOSE_PROJECT_NAME -u COMPOSE_FILE -u COMPOSE_PATH_SEPARATOR -u COMPOSE_PROFILES \
    -u COMPOSE_ENV_FILES -u COMPOSE_DISABLE_ENV_FILE "$@"
}

compose_dev() {
  al_compose_guard || return $?
  _al_env=$1; shift
  al_compose docker compose --project-directory . --env-file "$_al_env" -f "$AL_DEV_FILE" "$@"
}

compose_stage() {
  al_compose_guard || return $?
  _al_env=$1; shift
  al_compose env WEB_TAG="$AL_STAGE_WEB_TAG" API_TAG="$AL_STAGE_API_TAG" \
    PUBLIC_BASE_URL="$AL_STAGE_PUBLIC_BASE_URL" \
    docker compose -f "$AL_PROD_FILE" -f "$AL_STAGE_OVERLAY" --env-file "$_al_env" "$@"
}

compose_prod() {
  al_compose_guard || return $?
  _al_env=$1; shift
  al_compose docker compose -f "$AL_PROD_FILE" --env-file "$_al_env" "$@"
}
