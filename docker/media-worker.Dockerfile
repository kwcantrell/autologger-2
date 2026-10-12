# syntax=docker/dockerfile:1
# DRAFT (spike 0.1, openspec change media-worker, 2026-10-12): proves node runs on the pinned
# linuxserver/ffmpeg base for linux/amd64 and linux/arm64. Workstream W (task W.5) owns this file
# and adds the worker's src/**, workspace packages, production deps and its ENTRYPOINT.

# node:22-bookworm-slim (multi-arch index digest, resolved 2026-09-28; same pin as docker/Dockerfile)
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
# linuxserver/ffmpeg 9.0 (multi-arch index: amd64 + arm64) # reviewed 2026-10-11
ARG FFMPEG_IMAGE=linuxserver/ffmpeg:9.0-cli-ls84@sha256:a7182d4fe498feea393622b43513cfaecb3fd073dcd3c7f38e9d74a10a4e8702

FROM ${NODE_IMAGE} AS node

FROM ${FFMPEG_IMAGE} AS media-worker
COPY --from=node /usr/local/bin/node /usr/local/bin/node
USER 10001:10001
WORKDIR /tmp
ENTRYPOINT ["node"]
CMD ["--version"]
