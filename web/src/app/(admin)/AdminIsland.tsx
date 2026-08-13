'use client';

import dynamic from 'next/dynamic';
import { AppLoadingSkeleton } from '@/shared/ui/AppLoadingSkeleton';

// AdminIsland (nextjs-frontend-migration, task 2.3; design D3/D9.1).
//
// The `ssr: false` client-island wrapper for `AdminRoot` -- same shape and
// rationale as `IndexIsland.tsx`. `AdminRoot` restores its own StrictMode
// behavior via an explicit `<StrictMode>` subtree wrapper (design D4); this
// wrapper does not need to know that.
const AdminRoot = dynamic(
  () => import('@/pages/admin-users/AdminRoot').then((mod) => mod.AdminRoot),
  {
    ssr: false,
    loading: () => <AppLoadingSkeleton />,
  },
);

export function AdminIsland() {
  return <AdminRoot />;
}
