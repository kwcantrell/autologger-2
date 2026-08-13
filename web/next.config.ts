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
const nextConfig: NextConfig = {
  reactStrictMode: false,
  images: {
    unoptimized: true,
  },
  poweredByHeader: false,
  skipTrailingSlashRedirect: true,
};

export default nextConfig;
