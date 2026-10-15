# syntax=docker/dockerfile:1
# The media worker image (OpenSpec change media-worker, design D13; spike 0.1): node copied onto
# the digest-pinned linuxserver/ffmpeg base, the worker's src, the workspace packages it imports
# and their production dependencies, uid 10001 (not the api's 1000), the worker as ENTRYPOINT.
# Built only through docker-bake.hcl (target media-worker, linux/amd64 + linux/arm64), from the
# repo root context; the root .dockerignore keeps tests, fixtures, data and env files out.
#
# The ffmpeg pin lives HERE ONLY (D13): server/scripts/blobSegmentRows.ts's FFMPEG_IMAGE is held
# equal by server/src/test/ffmpegPin.repo.test.ts, and dependabot (docker ecosystem, /docker)
# proposes digest bumps. A bump is a tier 1 change: re-run docker/scripts/test_media_image.sh
# and the media-worker *.ffmpeg tests, then move the review date.

# node:22-bookworm-slim (multi-arch index digest, resolved 2026-09-28; same pin as docker/Dockerfile)
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
# linuxserver/ffmpeg 9.0 (multi-arch index: amd64 + arm64) # reviewed 2026-10-11
ARG FFMPEG_IMAGE=linuxserver/ffmpeg:9.0-cli-ls84@sha256:a7182d4fe498feea393622b43513cfaecb3fd073dcd3c7f38e9d74a10a4e8702

FROM ${NODE_IMAGE} AS node

# Manifests only: the workspace's package.json files the worker's dependency tree names.
FROM ${NODE_IMAGE} AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY media-worker/package.json media-worker/package.json
COPY packages/contract/package.json packages/contract/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/ports/package.json packages/ports/package.json
COPY packages/session-core/package.json packages/session-core/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY packages/transcription/package.json packages/transcription/package.json

# Production dependencies for the TARGET platform (tsx's esbuild binary is per architecture).
# --omit=peer: storage's better-sqlite3 peer is never loaded by the worker.
FROM manifests AS worker-deps
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --omit=peer --workspace=media-worker --include-workspace-root=false \
 && test ! -e node_modules/better-sqlite3

FROM manifests AS worker-src
COPY media-worker/src media-worker/src
COPY packages/domain/src packages/domain/src
COPY packages/ports/src packages/ports/src
COPY packages/storage/src packages/storage/src
COPY packages/transcription/src packages/transcription/src
RUN find media-worker packages -type f \( -name '*.test.*' -o -name '*.spec.*' \) -delete \
 && find media-worker packages -type d -name test -prune -exec rm -rf {} + \
 && rm -f package.json package-lock.json

FROM ${FFMPEG_IMAGE} AS media-worker
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=worker-deps /app/node_modules ./node_modules
COPY --from=worker-src /app/media-worker media-worker
COPY --from=worker-src /app/packages packages
ENV NODE_ENV=production
USER 10001:10001
# The base image's ENTRYPOINT (/ffmpegwrapper.sh, an s6 uid switcher) is replaced: the worker
# runs ffmpeg itself, by argv, with stdin fed from the files it opened.
ENTRYPOINT ["/usr/local/bin/node", "--import", "tsx", "/app/media-worker/src/main.ts"]
CMD []
