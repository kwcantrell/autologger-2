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
// `/sessions/:id` (one non-empty raw segment, decoded value MAY contain
// `/`), `/teams` -- via `isShellSegments` (the shared route-definition
// module's shell-set predicate, `web/src/shared/utils/loginReturnPath.ts`,
// task 2.2). Any other decoded segment shape 404s. This retires the
// three-way route-table lockstep mirror (`web-session-routing` delta):
// AppShell's wouter route strings remain the one manually-synced mirror
// (they cannot mechanically import this predicate).
//
// `force-dynamic` (panel decision, design D3): Next's default for a
// dynamic route with no `generateStaticParams` is on-demand static
// generation, which would persist per-id HTML into `web/.next` at runtime
// -- an unauthenticated, unbounded disk-growth surface and an e2e
// shared-`.next` race. `force-dynamic` keeps `web/.next` read-only at
// runtime; cheap here since the page is a static client-island shell.
//
// KNOWN GAP, discovered empirically while smoke-testing this task (task
// 2.6's framework-behavior spike is the task of record for verifying and,
// if needed, escalating this -- not fixed here, out of this unit's scope):
// against the pinned Next 15.5.23, a live `next build` + `next start`
// smoke test showed `GET /teams/` resolves to `path: ['teams']` here (the
// SAME as `/teams`, not `['teams', '']`), so it currently returns `200`,
// NOT the `404` design D3 / the `web-frontend-platform` spec's "Trailing
// slash stays 404" scenario require. `skipTrailingSlashRedirect: true`
// (`next.config.ts`) does suppress the 308 redirect as intended, but Next's
// catch-all segment computation independently normalizes a trailing slash
// for ROUTE MATCHING regardless of that flag -- a distinct mechanism design
// D3 did not distinguish. Separately (lower severity -- does not change
// this validator's pass/fail outcome, since `isShellSegments` checks shape
// only): the same smoke test showed `/sessions/a%2Fb` arrives as
// `['sessions', 'a%2Fb']` (still percent-ENCODED), not the decoded
// `['sessions', 'a/b']` design D3 states Next produces. Both are
// version-pinned framework-behavior facts task 2.6 is explicitly scoped to
// verify and, on failure, escalate to the gate -- recorded here so that
// spike does not have to rediscover them from scratch.
export const dynamic = 'force-dynamic';

interface IndexShellPageProps {
  // Next 15: `params` is a Promise. The optional catch-all's decoded
  // segment list is `undefined` for `/`, otherwise the array of decoded
  // segments -- see `isShellSegments`'s doc comment for why this validator
  // never re-splits an already-decoded segment.
  params: Promise<{ path?: string[] }>;
}

export default async function IndexShellPage({ params }: IndexShellPageProps) {
  const { path } = await params;
  if (!isShellSegments(path)) {
    notFound();
  }
  return <IndexIsland />;
}
