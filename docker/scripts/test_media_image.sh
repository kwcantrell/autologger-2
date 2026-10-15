#!/bin/sh
# docker/scripts/test_media_image.sh -- the media-worker image, built for the native platform
# through the bake target and checked (media-worker task W.5; spec container-deployment "Two
# images built from one repository", "media-worker image carries only the worker"):
#   - ffmpeg and node are present; the worker's src, its workspace packages and node_modules are;
#   - no server/src, web, claude, yt-dlp, deno, test files, fixtures, or .env other than .env.example;
#   - the image runs as uid 10001 and its entrypoint is the worker;
#   - under the compose posture (read-only, cap_drop ALL, no-new-privileges, tmpfs /tmp,
#     --network none, --init) node and ffmpeg run, the pinned ffmpeg decodes a fixture through
#     pipe:0 as uid 10001, and the worker refuses to start without its environment.
# Skips (exit 0) without a docker daemon. Removes the image it built.
#
#   sh docker/scripts/test_media_image.sh
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
if ! docker info >/dev/null 2>&1; then
  echo "SKIP test_media_image: no docker daemon"
  exit 0
fi
TAG=autologger-media-worker:imagetest-$$
CID=
cleanup() {
  [ -n "$CID" ] && docker rm -f "$CID" >/dev/null 2>&1 || true
  docker image rm -f "$TAG" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok   $1"; }
bad() { fail=$((fail + 1)); echo "FAIL $1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

ARCH=$(docker version --format '{{.Server.Arch}}')
case $ARCH in amd64|arm64) ;; aarch64) ARCH=arm64 ;; x86_64) ARCH=amd64 ;; *) echo "unknown arch $ARCH" >&2; exit 2 ;; esac
echo "building media-worker for linux/$ARCH through docker-bake.hcl"
(cd "$ROOT" && docker buildx bake --builder default -f docker-bake.hcl media-worker \
  --set "media-worker.platform=linux/$ARCH" --set "media-worker.tags=$TAG" --load) >/dev/null 2>&1 \
  || { (cd "$ROOT" && docker buildx bake --builder default -f docker-bake.hcl media-worker \
        --set "media-worker.platform=linux/$ARCH" --set "media-worker.tags=$TAG" --load) 2>&1 | tail -20; exit 1; }
ok "bake target media-worker builds for linux/$ARCH"

LIST=$(mktemp)
CID=$(docker create "$TAG")
docker export "$CID" | tar -t > "$LIST"
docker rm "$CID" >/dev/null
CID=
has() { grep -qE "$1" "$LIST"; }
check "ffmpeg present" "has '^usr/local/bin/ffmpeg$'"
check "node present" "has '^usr/local/bin/node$'"
check "worker entry present" "has '^app/media-worker/src/main.ts$'"
check "worker package.json present" "has '^app/media-worker/package.json$'"
check "domain, storage, transcription src present" \
  "has '^app/packages/domain/src/waveformPeaks.ts$' && has '^app/packages/storage/src/mediaJobs.ts$' && has '^app/packages/transcription/src/audioMerge.ts$'"
check "production dependencies present (postgres, mediabunny, tsx)" \
  "has '^app/node_modules/postgres/' && has '^app/node_modules/mediabunny/' && has '^app/node_modules/tsx/'"
check "no server/src" "! has '^app/server/'"
check "no web" "! has '^app/web/'"
check "no claude CLI" "! has '(^|/)claude(-code)?(/|$)' && ! has '@anthropic-ai/'"
check "no yt-dlp" "! has 'yt-dlp'"
check "no deno" "! has '(^|/)deno$'"
check "no test files" "! has '^app/.*\\.test\\.[a-z]+$' && ! has '^app/media-worker/src/test/'"
check "no fixtures" "! has '^app/.*/fixtures/'"
check "no .env other than .env.example" "! grep -E '(^|/)\\.env' '$LIST' | grep -vE '(^|/)\\.env\\.example$' | grep -q ."
check "no better-sqlite3 (peer of storage, never loaded by the worker)" "! has '^app/node_modules/better-sqlite3/'"
rm -f "$LIST"

USER_CFG=$(docker image inspect --format '{{.Config.User}}' "$TAG")
check "runs as uid 10001 (got '$USER_CFG')" "[ '$USER_CFG' = '10001:10001' ]"
EP=$(docker image inspect --format '{{json .Config.Entrypoint}}' "$TAG")
check "entrypoint is the worker (got $EP)" "echo '$EP' | grep -q 'media-worker/src/main.ts'"

HARD="--rm --read-only --tmpfs /tmp:size=64m --cap-drop ALL --security-opt no-new-privileges:true --network none --init"
NODE_V=$(docker run $HARD --entrypoint node "$TAG" -e 'console.log(process.version, process.getuid())' 2>&1 || true)
check "node runs hardened as uid 10001 ($NODE_V)" "echo '$NODE_V' | grep -qE '^v22\\.[0-9]+\\.[0-9]+ 10001$'"
FF_V=$(docker run $HARD --entrypoint ffmpeg "$TAG" -hide_banner -version 2>&1 | head -1 || true)
check "ffmpeg runs hardened ($FF_V)" "echo '$FF_V' | grep -q '^ffmpeg version '"
BYTES=$(docker run -i $HARD --entrypoint ffmpeg "$TAG" -nostdin -hide_banner -loglevel error -xerror \
  -protocol_whitelist pipe -f matroska -i pipe:0 -f f32le -acodec pcm_f32le pipe:1 \
  < "$ROOT/packages/transcription/fixtures/audio/seg1.webm" | wc -c)
check "seg1.webm decodes through pipe:0 to f32 PCM ($BYTES bytes)" "[ '$BYTES' -eq 115200 ]"
set +e
REFUSE=$(docker run $HARD "$TAG" 2>&1)
RC=$?
set -e
check "the worker starts and refuses without its environment (rc $RC)" \
  "[ $RC -eq 2 ] && echo '$REFUSE' | grep -q '\"event\":\"refused\"'"
WRITE=$(docker run $HARD --entrypoint node "$TAG" -e "try{require('fs').writeFileSync('/app/x','')}catch(e){console.log(e.code)}" 2>&1)
check "root filesystem is read-only under the posture ($WRITE)" "[ '$WRITE' = 'EROFS' ]"

# The compose healthcheck: the loop touches its heartbeat even while the database is unreachable.
CID=$(docker run -d --read-only --tmpfs /tmp:size=64m --cap-drop ALL --security-opt no-new-privileges:true \
  --network none --init -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE=postgres \
  -e PGUSER=autologger_media -e PGPASSWORD=0000000000000000000000000000000000 -e BLOB_DIR=/tmp "$TAG")
sleep 3
HC=$(docker exec "$CID" node -e "const s=require('fs').statSync('/tmp/media-worker.heartbeat');process.exit(Date.now()-s.mtimeMs<60000?0:1)" >/dev/null 2>&1 && echo healthy || echo unhealthy)
check "healthcheck command passes on the heartbeat file ($HC)" "[ '$HC' = healthy ]"
LOGS=$(docker logs "$CID" 2>&1 | head -5)
check "logs are JSON events without the password" "echo '$LOGS' | grep -q '\"event\":\"started\"' && ! echo '$LOGS' | grep -q 0000000000000000"
docker stop -t 10 "$CID" >/dev/null
STOPLOG=$(docker logs "$CID" 2>&1 | tail -1)
check "SIGTERM stops it cleanly ($STOPLOG)" "echo '$STOPLOG' | grep -q '\"event\":\"stopped\"'"
docker rm -f "$CID" >/dev/null
CID=

SIZE=$(docker image inspect --format '{{.Size}}' "$TAG")
echo "image size: $((SIZE / 1000000)) MB (linux/$ARCH)"
echo "test_media_image: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
