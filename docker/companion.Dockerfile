# syntax=docker/dockerfile:1
# Dev-only Bitfocus Companion image carrying this repo's module (containerized-dev-env, D9).
# Built with docker/companion.Dockerfile.dockerignore (allowlist form; replaces .dockerignore).

ARG NODE_IMAGE=node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

# ---- context-audit: prints every file that entered the build context (evidence, not shipped) ----
FROM busybox:1.37 AS context-audit
COPY . /ctx
RUN set -eu; find /ctx -type f | sort > /ctx-listing.txt; \
    echo "=== build-context listing ==="; cat /ctx-listing.txt; echo "=== end listing ==="; \
    if grep -Ev '^/ctx/(package\.json|package-lock\.json|companion/.*)$' /ctx-listing.txt; then echo "file outside allowlist entered the context" >&2; exit 1; fi; \
    if grep -E '/(node_modules|dist|pkg)/|\.tgz$|/\.env' /ctx-listing.txt; then echo "excluded path entered the context" >&2; exit 1; fi

# ---- module: build and package the module ----
# Deviation from design D9 step 4 (an EMPTY node_modules/): Companion treats extra-module-path
# modules as unpackaged and resolves `@companion-module/base/package.json` from the module dir
# to learn the API version (verified live on v4.3.4: "Failed to get module api version"). The
# bundle itself is still self-contained; node_modules only carries that package (non-empty, so
# the entrypoint still skips its yarn install).
FROM ${NODE_IMAGE} AS module
WORKDIR /src
# Forces the audit stage (and its build-log listing + allowlist assertion) into every build.
COPY --from=context-audit /ctx-listing.txt /tmp/ctx-listing.txt
# Root manifest + lock first so the root `overrides` (@companion-module/base ~1.14.0) applies.
COPY package.json package-lock.json ./
COPY companion/ companion/
RUN npm ci --workspace=companion --include-workspace-root=false
RUN npm run build -w companion && npm run package -w companion
RUN set -eu; \
    tgz="$(ls companion/*.tgz | head -n1)"; \
    mkdir -p /module/autologger; \
    tar -xzf "$tgz" -C /module/autologger --strip-components=1; \
    mkdir -p /module/autologger/node_modules/@companion-module; \
    cp -r node_modules/@companion-module/base /module/autologger/node_modules/@companion-module/base; \
    node -e "const v=require('/module/autologger/node_modules/@companion-module/base/package.json').version; if(!v.startsWith('1.14.')){console.error('bad base version',v);process.exit(1)}"; \
    ls -la /module/autologger; \
    grep -n '"apiVersion"' /module/autologger/companion/manifest.json; \
    node -e "const m=require('/module/autologger/companion/manifest.json'); if(!String(m.runtime.apiVersion).startsWith('1.14.')){console.error('bad apiVersion',m.runtime.apiVersion);process.exit(1)}"; \
    test -d /module/autologger/node_modules

# ---- runtime ----
FROM ghcr.io/bitfocus/companion/companion:v4.3.4@sha256:7fddb11a82ed4934c6ef3d34782963bac9b12916f31be525b81df87bb2458df5
COPY --from=module /module/autologger /app/module-local-dev/autologger
