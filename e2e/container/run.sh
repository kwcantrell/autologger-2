#!/usr/bin/env bash
# containerize-split-images (task 5.4): one command for the `container` Playwright project.
#
#   npm run e2e:container [-- <extra playwright args, e.g. --grep "POST /sessions"> ]
#
# It (1) builds the web bundle + both images from the CURRENT tree, (2) starts a single-process
# reference server (`npm run start`, the differential's external consumer) and the compose stack
# behind the router, (3) runs `playwright test --project=container --workers=1`, and (4) tears
# everything down (stack, volumes, reference server, throwaway files) whatever the outcome.
#
# Nothing here touches deployment config: compose.yaml is used as-is, layered with the TEST-ONLY
# e2e/container/compose.e2e.yaml; secrets are random per-run values in a throwaway env file.
# Needs: docker (+ compose v2), node, the repo's installed dependencies, free ports
# ROUTER_PORT (default 18080) and REF_PORT (default 18793), and the node:22-bookworm-slim image
# (the api image's base, used for throwaway probe containers).
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD

ROUTER_PORT=${ROUTER_PORT:-18080}
REF_PORT=${REF_PORT:-18793}
export COMPOSE_PROJECT_NAME=alg-e2e
export COMPOSE_FILE="compose.yaml:e2e/container/compose.e2e.yaml"

if [ -n "$(docker compose ps -aq 2>/dev/null)" ]; then
  echo "refusing to run: compose project '$COMPOSE_PROJECT_NAME' already has containers (docker compose -p $COMPOSE_PROJECT_NAME down -v)" >&2
  exit 2
fi

WORK=$(mktemp -d)
REF_PID=""
cleanup() {
  status=$?
  if [ -n "$REF_PID" ]; then kill -- "-$REF_PID" 2>/dev/null || kill "$REF_PID" 2>/dev/null || true; fi
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  docker rmi "ghcr.io/kwcantrell/autologger-web:$E2E_TAG" "ghcr.io/kwcantrell/autologger-api:$E2E_TAG" >/dev/null 2>&1 || true
  rm -rf "$WORK"
  exit $status
}
E2E_TAG="e2e-$(git rev-parse --short HEAD)"
trap cleanup EXIT INT TERM

API_TOKEN="e2e-api-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
ADMIN_TOKEN="e2e-adm-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
cat > "$WORK/e2e.env" <<ENV
WEB_TAG=$E2E_TAG
API_TAG=$E2E_TAG
ROUTER_PORT=$ROUTER_PORT
PUBLIC_BASE_URL=https://autologger.e2e.invalid
GOOGLE_CLIENT_ID=e2e-dummy-client-id
GOOGLE_CLIENT_SECRET=e2e-dummy-client-secret
API_TOKEN=$API_TOKEN
ADMIN_TOKEN=$ADMIN_TOKEN
ENV
export COMPOSE_ENV_FILES="$WORK/e2e.env" E2E_ENV_FILE="$WORK/e2e.env"

echo "== build web (reference server) + images ($E2E_TAG)"
npm run build -w web
docker compose build

echo "== start the single-process reference on :$REF_PORT"
mkdir -p "$WORK/refdata"
(
  cd server
  # setsid: the server is a process tree (npm -> sh -> tsx -> node); a new session lets cleanup
  # signal the whole group instead of orphaning the node process.
  exec setsid env PORT="$REF_PORT" HOST=127.0.0.1 REQUIRE_LOGIN=1 DATA_DIR="$WORK/refdata" \
    GOOGLE_CLIENT_ID=e2e-dummy-client-id GOOGLE_CLIENT_SECRET=e2e-dummy-client-secret \
    PUBLIC_BASE_URL="http://127.0.0.1:$REF_PORT" IP_ALLOWLIST= API_TOKEN="$API_TOKEN" \
    ADMIN_TOKEN="$ADMIN_TOKEN" DEEPGRAM_API_KEY= CLAUDE_CLI_PATH= \
    npm run start
) > "$WORK/reference.log" 2>&1 &
REF_PID=$!
for _ in $(seq 1 90); do
  curl -fsS "http://127.0.0.1:$REF_PORT/api/profile" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:$REF_PORT/api/profile" >/dev/null || { echo "reference server did not start"; tail -20 "$WORK/reference.log"; exit 1; }

echo "== start the compose stack on 127.0.0.1:$ROUTER_PORT"
docker compose up -d --wait

echo "== playwright --project=container"
set +e
ROUTER_URL="http://127.0.0.1:$ROUTER_PORT" SINGLE_PROCESS_URL="http://127.0.0.1:$REF_PORT" \
  E2E_API_TOKEN="$API_TOKEN" npx playwright test --project=container --workers=1 "$@"
rc=$?
set -e
[ $rc -ne 0 ] && echo "(stack logs: docker compose -p $COMPOSE_PROJECT_NAME logs; removed on exit)" >&2
exit $rc
