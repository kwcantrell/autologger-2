import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@/shared/theme/tailwind.css';
import 'overlayscrollbars/overlayscrollbars.css';

// Admin root layout (nextjs-frontend-migration, task 2.3; design D4).
//
// Named `layout.page.tsx` -- see `web/next.config.ts`'s `pageExtensions`
// comment and `(index)/layout.page.tsx`'s header for why every App Router
// special file under `web/src/app/**` carries the `.page.` suffix.
//
// The SECOND of the two root layouts (route groups `(index)` and
// `(admin)`) -- see `(index)/layout.page.tsx` for why there is no root-level
// `app/layout.page.tsx`. Replicates the head output of the retired
// `web/src/pages/admin-users/index.html`: no `data-v4-transport` body
// attribute (that's index-only), its own title, and its own theme color.
// CSS import order pinned identically to the index layout (design D5):
// `tailwind.css` before `overlayscrollbars.css`, centralized here rather
// than at a leaf component.
export const metadata: Metadata = {
  title: 'AutoLogger — Admin Users',
  icons: {
    icon: [{ url: '/static/logo-autologger-transparent.png', type: 'image/png' }],
    apple: '/static/logo-autologger-app.png',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#1e2129',
};

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
