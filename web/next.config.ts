import type { NextConfig } from 'next';

// Panel-decided contents (design.md D1/D6, 2026-08-13):
// - reactStrictMode: false — the index tree must not double-invoke (load-bearing for the
//   departure watcher and the coordination registry); AdminRoot restores StrictMode via an
//   explicit subtree wrapper instead (D4).
// - images.unoptimized — no `/_next/image` optimizer; the app uses plain `<img>` and the
//   optimizer is an unauthenticated compute endpoint with a CVE history (D6.4).
// - poweredByHeader: false — no `X-Powered-By` egress of framework identity (D6.4).
// - skipTrailingSlashRedirect: true — trailing-slash shell paths reach the catch-all
//   unnormalized instead of Next's default 308 redirect, so they keep 404ing like today
//   (D3 trailing-slash decision).
//
// - pageExtensions (task 2.3 build-gate fix, discovered running `next build`, not
//   anticipated by design.md): Next's `findPagesDir` (`next/dist/lib/find-pages-dir.js`)
//   unconditionally treats an existing `<root>/src/pages` directory as a SECOND, legacy
//   Pages Router root, alongside `app/` — a hardcoded convention with no "disable" flag.
//   This repo's `web/src/pages/` predates Next entirely (it is this workspace's own
//   `pages -> api -> shared` zone, `web-coordination-seam` spec) and was never meant to be
//   routed. With the default `pageExtensions` (`ts`/`tsx`/`js`/`jsx`), Next's page
//   collector (`createValidFileMatcher`, `next/dist/server/lib/find-page-file.js`) treats
//   EVERY matching-extension file under `src/pages/**` as a page-build candidate,
//   regardless of what it exports — demonstrated to crash the build attempting to
//   webpack-compile `pages/index/components/aiV2/clientAggregates.pinning.test.ts` (a
//   vitest fixture that reaches into `packages/ai-runtime`, untranspiled for the app
//   webpack compiler) as if it were a route. Narrowing `pageExtensions` to a distinguishing
//   suffix scopes BOTH routers' file-matching to that suffix: nothing under
//   `web/src/pages/**` today ends in `.page.ts(x)` (verified), so the legacy Pages Router
//   collects zero routes there, while `web/src/app/**`'s special files
//   (`layout.page.tsx`, `page.page.tsx`, `not-found.page.tsx`) opt in explicitly. This is a
//   documented community pattern for exactly this "pre-existing `pages/`-named directory
//   during a Pages->App migration" collision, not a novel scheme.
// - webpack(): Next's built-in `next-image-loader` handles the image extensions the app's
//   static `import x from './y.png'` sites rely on (task 1.2), but ships no default rule
//   for `.webm` (a video, not an image) — `loadingVideo.ts`'s webm import otherwise fails
//   webpack's default "parse as JS" fallback ("Module parse failed: Unexpected character").
//   `asset/resource` mirrors Vite's default asset-import behavior (emits the file, returns
//   a plain string URL) — matching the `string | { src }` union already declared for these
//   modules (`web/src/types/assets.d.ts`, task 1.2) and landing under the already-declared
//   `/_next/static/*` path family (D6.4), not new surface.
// - allowedDevOrigins (dev-layout-fix, 2026-08-13; lever pre-approved in design.md D1):
//   dev-only — silences (and, when a future Next flips warn→block, keeps allowing) the
//   "Cross origin request detected from 127.0.0.1 to /_next/* resource" warning. Mechanism
//   (verified in next@15.5.23 `router-server.js` → `block-cross-site.js`): dev requests to
//   `/_next/*`/`/__nextjs*` (incl. the HMR WS upgrade) compare the browser's `Origin`
//   hostname against `['*.localhost', 'localhost', opts.hostname]` + `allowedDevOrigins`.
//   Our embedded custom server instantiates `next({ dev, dir })` with no `hostname` option,
//   so only `localhost` is assumed — while the dev server binds 127.0.0.1:8787 (D10 loopback
//   pin) and the browser therefore sends `Origin: http://127.0.0.1:8787`. `127.0.0.1` is the
//   one extra origin dev actually uses; `localhost` stays allowed built-in. Setting the
//   option flips unlisted origins from warn to 403-block, which is correct for the loopback
//   posture (LAN testing goes through the prod serve path, not dev). No prod effect:
//   `blockCrossSite` runs only on the dev router path.
const nextConfig: NextConfig = {
  reactStrictMode: false,
  allowedDevOrigins: ['127.0.0.1'],
  images: {
    unoptimized: true,
  },
  poweredByHeader: false,
  skipTrailingSlashRedirect: true,
  pageExtensions: ['page.tsx', 'page.ts'],
  webpack(config) {
    config.module.rules.push({
      test: /\.webm$/,
      type: 'asset/resource',
    });
    return config;
  },
};

export default nextConfig;
