import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@/shared/theme/tailwind.css';
import 'overlayscrollbars/overlayscrollbars.css';

// Index root layout (nextjs-frontend-migration, task 2.3; design D4).
//
// Named `layout.page.tsx`, not the bare `layout.tsx` the design doc/tasks
// spell -- see `web/next.config.ts`'s `pageExtensions` comment for why: the
// pre-existing `web/src/pages/` directory (this workspace's own zone, unrelated
// to Next) collides with Next's hardcoded legacy-Pages-Router detection, and
// scoping `pageExtensions` to a `.page.` suffix is what keeps that directory
// un-routed. Every App Router special file under `web/src/app/**` carries the
// same suffix for the same reason.
//
// One of TWO root layouts (route groups `(index)` and `(admin)`) -- there is
// deliberately no root-level `app/layout.page.tsx`; every route lives inside
// one of the two groups, so Next never requires one. This layout replicates the
// head/body output of the retired `web/src/pages/index/index.html` as
// closely as the App Router allows:
//  - `<body data-v4-transport="rolling">` (load-bearing attribute, ported
//    verbatim from the Vite entry).
//  - CSS import order is PINNED here (design D5): `tailwind.css` before
//    `overlayscrollbars.css` -- centralizing both imports in the layout (not
//    a leaf component) is what pins App Router's otherwise-unspecified CSS
//    cascade order. The AppShell-level `overlayscrollbars.css` import is
//    removed by this same task.
//  - Theme color goes through the `viewport` export, not `metadata`
//    (Next 15 rejects `themeColor` inside `metadata` -- panel fix,
//    design D4).
export const metadata: Metadata = {
  title: 'AutoLogger',
  icons: {
    icon: [{ url: '/static/logo-autologger-transparent.png', type: 'image/png' }],
    apple: '/static/logo-autologger-app.png',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#070b14',
};

export default function IndexLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body data-v4-transport="rolling">
        {/* Font preloads (perf C4b). Rendered in <body> deliberately: this
            layout has no <head> element, and React 19 hoists <link> to the
            document head from anywhere in the tree. Next's `metadata` export
            has no preload API, so this is the supported route.

            Both hrefs are stable /public paths rather than bundler-emitted
            content-hashed asset URLs, because a preload must name the exact
            URL the CSS `src:` will request (see the matching @font-face
            comments in tailwind.css). Trade-off: /public loses immutable
            content-hash caching; these two files change ~never.

            `crossOrigin="anonymous"` is MANDATORY even same-origin -- fonts
            are always fetched in CORS mode, so a preload without it is a
            cache-key mismatch and the font downloads twice. */}
        <link
          rel="preload"
          href="/static/fonts/inter-latin-var.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <link
          rel="preload"
          href="/static/fonts/league-gothic-latin.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        {children}
      </body>
    </html>
  );
}
