import { notFound } from 'next/navigation';
import { isShellSegments } from '@/shared/utils/loginReturnPath';
import { IndexIsland } from '../IndexIsland';

// Index shell catch-all (nextjs-frontend-migration, task 2.3; design D3).
//
// Named `page.page.tsx` -- see `web/next.config.ts`'s `pageExtensions`
// comment and `../layout.page.tsx`'s header for why every App Router
// special file under `web/src/app/**` carries the `.page.` suffix.
//
// Optional catch-all serving exactly the router-known index paths -- `/`,
// `/sessions/:id` (one non-empty raw segment; segments arrive still
// percent-ENCODED, not decoded -- see `isShellSegments`'s doc comment for
// why this validator is shape-only and never decodes-and-re-splits an
// entry), `/teams` -- via `isShellSegments` (the shared route-definition
// module's shell-set predicate, `web/src/shared/utils/loginReturnPath.ts`,
// task 2.2). Any other segment shape 404s. This retires the three-way
// route-table lockstep mirror (`web-session-routing` delta): AppShell's
// wouter route strings remain the one manually-synced mirror (they cannot
// mechanically import this predicate).
//
// `force-dynamic` (panel decision, design D3): Next's default for a
// dynamic route with no `generateStaticParams` is on-demand static
// generation, which would persist per-id HTML into `web/.next` at runtime
// -- an unauthenticated, unbounded disk-growth surface and an e2e
// shared-`.next` race. `force-dynamic` keeps `web/.next` read-only at
// runtime; cheap here since the page is a static client-island shell.
//
// RESOLVED GAP (was discovered empirically while smoke-testing task 2.3;
// task 2.6's framework-behavior spike confirmed and escalated it to the
// gate): against the pinned Next 15.5.23, `GET /teams/` resolves to
// `path: ['teams']` here (the SAME as `/teams`, not `['teams', '']`), so
// this route alone could not distinguish the two -- `skipTrailingSlashRedirect:
// true` (`next.config.ts`) suppresses the 308 redirect as intended, but
// Next's catch-all segment computation independently normalizes a trailing
// slash for ROUTE MATCHING regardless of that flag, a distinct mechanism
// design D3 did not originally distinguish. Per the owner ruling
// (2026-08-13), this is now enforced one layer up, in front of the
// framework: the Hono bridge (`server/src/app.ts`) 404s any non-`/`
// trailing-slash path before it ever reaches this page, keeping the pinned
// `404` (design D3; `web-frontend-platform` spec's "Trailing slash stays
// 404" scenario) e2e-pinned at the bridge layer.
export const dynamic = 'force-dynamic';

interface IndexShellPageProps {
  // Next 15: `params` is a Promise. The optional catch-all's segment list
  // is `undefined` for `/`, otherwise the array of raw, still
  // percent-ENCODED segments -- see `isShellSegments`'s doc comment for why
  // this validator never decodes-and-re-splits an entry.
  params: Promise<{ path?: string[] }>;
}

export default async function IndexShellPage({ params }: IndexShellPageProps) {
  const { path } = await params;
  if (!isShellSegments(path)) {
    notFound();
  }
  return <IndexIsland />;
}
