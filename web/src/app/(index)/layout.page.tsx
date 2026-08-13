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
      <body data-v4-transport="rolling">{children}</body>
    </html>
  );
}
