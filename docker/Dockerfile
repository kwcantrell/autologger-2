# syntax=docker/dockerfile:1
# AutoLogger split images (containerize-split-images D4/D5/D6): `web` (Next standalone) and
# `api` (server, API-only). Build from the repo root context:
#   docker buildx bake -f docker-bake.hcl           (see docker-bake.hcl)
#   docker build -f docker/Dockerfile --target api .
#
# Every COPY names explicit source paths, never a whole workspace directory: server/data (live
# SQLite + audio) and server/.env sit inside server/. .dockerignore is the second fence.
# Both images build and run at /app: Next's standalone server.js embeds the absolute
# build-time tracing root.

# node:22-bookworm-slim (multi-arch index digest, resolved 2026-09-28)
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

# ---------------------------------------------------------------------------------------------
# manifests: only package.json files + the lockfile, so dependency layers cache independently of
# source edits. `companion` and `e2e` are deliberately absent (see `deps`).
FROM ${NODE_IMAGE} AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
COPY packages/ai-runtime/package.json packages/ai-runtime/package.json
COPY packages/catalog/package.json packages/catalog/package.json
COPY packages/contract/package.json packages/contract/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/log-import/package.json packages/log-import/package.json
COPY packages/media-import/package.json packages/media-import/package.json
COPY packages/ports/package.json packages/ports/package.json
COPY packages/session-core/package.json packages/session-core/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY packages/transcription/package.json packages/transcription/package.json

# ---------------------------------------------------------------------------------------------
# deps: full install (dev included) for the web build. python3/make/g++ exist only in build
# stages, as the node-gyp fallback for better-sqlite3 when no prebuild matches.
# Runs on the BUILD host's native platform ($BUILDPLATFORM), not the target: `next build` (SWC)
# SIGILLs under QEMU amd64 emulation (task 6.1a). The output is arch-independent JS -- see the
# `.node` guard in web-build -- so the `web` runtime stage below still targets each platform.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY --from=manifests /app/ ./
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspace=web --include-workspace-root=false

# ---------------------------------------------------------------------------------------------
FROM deps AS web-build
ENV NEXT_TELEMETRY_DISABLED=1
COPY web/next.config.ts web/tsconfig.json web/postcss.config.mjs web/next-env.d.ts web/
COPY web/public web/public
COPY web/src web/src
RUN cd web && npx next build
# Next traces its optional `sharp` (build-platform native) into the standalone tree. It is dead
# weight here (images.unoptimized: true, next.config.ts) and would be the WRONG architecture in
# the cross-built image, so drop it; then fail the build if any native addon remains.
RUN rm -rf web/.next/standalone/node_modules/sharp web/.next/standalone/node_modules/@img \
 && ! find web/.next/standalone -name '*.node' | grep -q .

# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=web-build /app/web/.next/standalone ./
COPY --from=web-build /app/web/.next/static web/.next/static
COPY --from=web-build /app/web/public web/public
USER node
EXPOSE 3000
CMD ["node", "web/server.js"]

# ---------------------------------------------------------------------------------------------
# api-deps: production-only install for server + packages/* (tsx is a prod dependency, D3).
FROM manifests AS api-deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --workspace=server --include-workspace-root=false \
 && node -e "const D=require('better-sqlite3');new D(':memory:').close();console.log('better-sqlite3 native binding loads')" \
 || (echo 'better-sqlite3 failed to load' >&2; exit 1)

# api-src: server + package sources, test files pruned BEFORE the final COPY so they never
# exist in any api image layer.
FROM manifests AS api-src
COPY server/tsconfig.json server/tsconfig.json
COPY server/src server/src
COPY packages/ai-runtime/src packages/ai-runtime/src
COPY packages/catalog/src packages/catalog/src
COPY packages/catalog/migrations packages/catalog/migrations
COPY packages/contract/src packages/contract/src
COPY packages/domain/src packages/domain/src
COPY packages/log-import/src packages/log-import/src
COPY packages/media-import/src packages/media-import/src
COPY packages/ports/src packages/ports/src
COPY packages/session-core/src packages/session-core/src
COPY packages/storage/src packages/storage/src
COPY packages/transcription/src packages/transcription/src
RUN find server packages -type f \( -name '*.test.*' -o -name '*.spec.*' \) -delete \
 && find server packages -type d -name test -prune -exec rm -rf {} + \
 && rm -f package.json package-lock.json

# tools: yt-dlp + deno, pinned and sha256-verified per TARGETARCH (never the host arch).
# deno is the JS runtime yt-dlp needs for YouTube; both land in ONE directory because the
# server pins the yt-dlp child's PATH to dirname(yt-dlp). No ffmpeg (single bestaudio format).
FROM ${NODE_IMAGE} AS tools
ARG TARGETARCH
# yt-dlp 2026.08.19 (github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/SHA2-256SUMS)
ARG YTDLP_VERSION=2026.08.19
ARG YTDLP_SHA256_AMD64=58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a
ARG YTDLP_SHA256_ARM64=b16e4dab368a816cd05d477d698a605a6ae87ccee1c8ffd38fa21d7254141fcc
# deno 2.9.7 (github.com/denoland/deno/releases/download/v2.9.7/deno-<triple>.zip.sha256sum)
ARG DENO_VERSION=2.9.7
ARG DENO_SHA256_AMD64=c6527f24f4b16031d3ae4fa9f658d5f11534c8d84ce7dc8502420280919c3490
ARG DENO_SHA256_ARM64=c832298b1ad4422481334855f6003e0f54145762c5a134f20a489511d2f65bbf
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates unzip \
 && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "${TARGETARCH}" in \
      amd64) ytfile=yt-dlp_linux;         ytsha="${YTDLP_SHA256_AMD64}"; denoarch=x86_64;  densha="${DENO_SHA256_AMD64}" ;; \
      arm64) ytfile=yt-dlp_linux_aarch64; ytsha="${YTDLP_SHA256_ARM64}"; denoarch=aarch64; densha="${DENO_SHA256_ARM64}" ;; \
      *) echo "unsupported TARGETARCH '${TARGETARCH}'" >&2; exit 1 ;; \
    esac; \
    mkdir -p /opt/ytdlp /tmp/dl; cd /tmp/dl; \
    curl -fsSL -o yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${ytfile}"; \
    echo "${ytsha}  yt-dlp" | sha256sum -c -; \
    curl -fsSL -o deno.zip "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-${denoarch}-unknown-linux-gnu.zip"; \
    echo "${densha}  deno.zip" | sha256sum -c -; \
    unzip -q deno.zip deno; \
    install -m 0755 yt-dlp deno /opt/ytdlp/

# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS api
# @anthropic-ai/claude-code pinned (npm registry, resolved 2026-09-28).
ARG CLAUDE_CODE_VERSION=2.1.284
RUN --mount=type=cache,target=/root/.npm \
    npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"
COPY --from=tools /opt/ytdlp /opt/ytdlp
WORKDIR /app
COPY --from=api-deps /app/node_modules ./node_modules
COPY --from=api-src /app/server server
COPY --from=api-src /app/packages packages
COPY server/package.json server/package.json
# Volume mount points, owned by the runtime user so a fresh named volume (initialised from
# these dirs) is writable on first start. settings.json carries DISABLE_AUTOUPDATER because
# the server strips unlisted env vars from the CLI child; the ENV below covers direct
# invocations. A pre-existing /home/node volume shadows this file (see README task 7.1).
RUN mkdir -p /data /home/node/.claude \
 && printf '{\n  "env": { "DISABLE_AUTOUPDATER": "1" }\n}\n' > /home/node/.claude/settings.json \
 && chown -R node:node /data /home/node
ENV NODE_ENV=production \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8787 \
    YTDLP_PATH=/opt/ytdlp/yt-dlp \
    CLAUDE_CLI_PATH=/usr/local/bin/claude \
    DISABLE_AUTOUPDATER=1 \
    NEXT_TELEMETRY_DISABLED=1
VOLUME ["/data", "/home/node"]
USER node
WORKDIR /app/server
EXPOSE 8787
CMD ["/app/node_modules/.bin/tsx", "src/main.ts"]
