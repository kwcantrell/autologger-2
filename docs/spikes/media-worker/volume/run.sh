#!/usr/bin/env bash
# Spike 0.1 (media-worker design D3/D4, assumptions A11/A13), as run on 2026-10-12.
# Builds the worker image for arm64 and amd64, then on a throwaway volume and network checks:
# node + ffmpeg on the pinned base, the hardened run flags, blob modes across uid 1000 (API) and
# uid 10001 (worker), the API's O_NOFOLLOW/fstat/copy adoption (including symlink swaps) and that
# an internal network has no external resolver. Removes everything it created.
# Run from the repo root: docs/spikes/media-worker/volume/run.sh
set -u
cd "$(git rev-parse --show-toplevel)"
S=$PWD/docs/spikes/media-worker/volume
FX=$PWD/packages/transcription/fixtures/audio
NODE=node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
VOL=media-worker-spike-blobs NET=media-worker-spike-net
cleanup() {
  docker rm -f media-worker-spike-db >/dev/null 2>&1
  docker volume rm "$VOL" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  docker rmi media-worker-spike:arm64 media-worker-spike:amd64 >/dev/null 2>&1
}
trap cleanup EXIT

for p in arm64 amd64; do
  docker buildx build -q --builder default --platform linux/$p -f docker/media-worker.Dockerfile \
    -t media-worker-spike:$p --load . >/dev/null || { echo "build $p failed"; exit 1; }
done

echo "=== A11: node and ffmpeg on the base, hardened flags"
for p in arm64 amd64; do
  H="--platform linux/$p --rm --user 10001:10001 --read-only --tmpfs /tmp:size=64m --cap-drop ALL --security-opt no-new-privileges:true --network none --init"
  # shellcheck disable=SC2016,SC2086 # $H is a flag list; the inner script expands in the container
  docker run -i $H --entrypoint bash media-worker-spike:$p -c 'set -o pipefail
    ffmpeg -nostdin -hide_banner -loglevel error -xerror -protocol_whitelist pipe -f matroska -i pipe:0 -f f32le -acodec pcm_f32le pipe:1 | wc -c; echo "ffmpeg rc=$?"
    echo "ldd not found: $(ldd /usr/local/bin/node | grep -c "not found")"; node -p "process.version+\" \"+process.arch+\" uid \"+process.getuid()"
    node -e "require(\"fs\").writeFileSync(\"/tmp/x\",\"1\");console.log(\"tmp ok\")"; touch /x 2>&1 | head -1' < "$FX/seg1.webm"
done

echo "=== D4: modes as the API writes them"
docker volume create "$VOL" >/dev/null
docker run --rm -v "$VOL":/blobs "$NODE" chown 1000:1000 /blobs
docker run --rm --user 1000:1000 -v "$VOL":/blobs -v "$S":/s:ro -v "$FX":/fx:ro "$NODE" node /s/api-init.js
docker run --rm -v "$VOL":/blobs "$NODE" sh -c 'cd /blobs && stat -c "%a %u:%g %n" . .tmp media audio audio/s1 audio/s1/*'
echo "--- worker writes it must not be able to make"
docker run --rm --user 10001:10001 --read-only --tmpfs /tmp --cap-drop ALL --network none -v "$VOL":/blobs \
  --entrypoint sh media-worker-spike:arm64 -c 'touch /blobs/audio/s1/x; rm -f /blobs/audio/s1/1_b.webm; touch /blobs/.tmp/x; mv /blobs/media /blobs/m2; true'

echo "=== D3/A13: API adopts worker output"
# The image's entrypoint is the worker itself; worker.js stands in for one job.
W="docker run --rm --user 10001:10001 --read-only --tmpfs /tmp:size=64m --cap-drop ALL --security-opt no-new-privileges:true --network none --init --entrypoint /usr/local/bin/node -v $VOL:/blobs -v $S:/s:ro"
A="docker run --rm --user 1000:1000 -v $VOL:/blobs -v $S:/s:ro $NODE node /s/api-adopt.js"
echo "--- job1: job dir left 0755 (expect rm FAIL EACCES)"
$W -e JOBMODE=755 media-worker-spike:arm64 /s/worker.js job1; $A job1 out.webm audio/s1/2_m.webm; echo "rc=$?"
echo "--- job2: worker chmods the job dir 0777 (expect copy + rm OK)"
$W -e JOBMODE=777 media-worker-spike:arm64 /s/worker.js job2; $A job2 out.webm audio/s1/3_m.webm; echo "rc=$?"
echo "--- job3: out.webm swapped for a symlink to another blob (expect open FAIL ELOOP)"
$W -e JOBMODE=777 media-worker-spike:arm64 /s/worker.js job3
docker run --rm --user 10001:10001 --network none -v "$VOL":/blobs --entrypoint sh media-worker-spike:arm64 \
  -c 'cd /blobs/media/job3 && rm out.webm && ln -s /blobs/audio/s1/1_b.webm out.webm'
$A job3 out.webm audio/s1/4_m.webm; echo "rc=$?"
echo "--- job4: the job dir itself a symlink to audio/s1 (expect REJECT on the owner check)"
docker run --rm --user 10001:10001 --network none -v "$VOL":/blobs --entrypoint sh media-worker-spike:arm64 \
  -c 'ln -s /blobs/audio/s1 /blobs/media/job4'
$A job4 1_b.webm audio/s1/5_m.webm; echo "rc=$?"
echo "--- job5: amd64 worker, same as job2"
$W -e JOBMODE=777 --platform linux/amd64 media-worker-spike:amd64 /s/worker.js job5; $A job5 out.webm audio/s1/6_m.webm; echo "rc=$?"

echo "=== D4: internal network has no external resolver"
docker network create --internal "$NET" >/dev/null
for p in arm64 amd64; do
  # shellcheck disable=SC2016 # expands in the container
  docker run --rm --platform linux/$p --user 10001:10001 --read-only --tmpfs /tmp --cap-drop ALL \
    --security-opt no-new-privileges:true --network "$NET" --entrypoint sh media-worker-spike:$p \
    -c 'getent hosts example.com; echo "getent rc=$? (expect 2)"; node -e "require(\"dns\").lookup(\"example.com\",(e,a)=>console.log(\"node dns\",e?e.code:a))"'
done
docker run -d --name media-worker-spike-db --network "$NET" --network-alias db "$NODE" sleep 60 >/dev/null
docker run --rm --user 10001:10001 --read-only --tmpfs /tmp --cap-drop ALL --network "$NET" \
  --entrypoint getent media-worker-spike:arm64 hosts db; echo "getent db rc=$? (expect 0)"
