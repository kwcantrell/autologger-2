'use client';

import dynamic from 'next/dynamic';
import { AppLoadingSkeleton } from '@/shared/ui/AppLoadingSkeleton';

// IndexIsland (nextjs-frontend-migration, task 2.3; design D3/D9.1).
//
// The `ssr: false` client-island wrapper for `IndexRoot` -- App Router
// requires the `ssr: false` option to be passed from INSIDE a client
// component (`dynamic()` calls in a server component always SSR). Today's
// product is 100% client-rendered into an empty `#root`; hydrating the
// heavy tree buys nothing and is the entire hydration-mismatch risk class
// (design D3), so `IndexRoot` never runs on the server.
//
// With `ssr: false` PLUS a `loading` element, Next still server-renders the
// `loading` component itself for the initial document (only the
// dynamically-imported module is excluded from the server render) -- that
// is how the shell ships real skeleton markup instead of an empty mount
// node (design D9.1, "Server-rendered shell"). `AppLoadingSkeleton` is the
// single shared component used here.
const IndexRoot = dynamic(() => import('@/pages/index/IndexRoot').then((mod) => mod.IndexRoot), {
  ssr: false,
  loading: () => <AppLoadingSkeleton />,
});

export function IndexIsland() {
  return <IndexRoot />;
}
