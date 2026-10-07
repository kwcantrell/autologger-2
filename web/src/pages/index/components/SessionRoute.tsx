import { useEffect } from 'react';
import { useRestoreSession, useSession } from '../../../api/hooks/useSessions';
import type { Session } from '../../../api/types';
import { toast } from '../../../shared/components/Toast';
import { Button } from '../../../shared/components/ui/button';
import { navigate } from '../navigation';
import { LazyChunk } from './ChunkLoadBoundary';
import { HomeRoute } from './HomeRoute';
import { RouteLoadingState } from './RouteLoadingState';
import { RouteState } from './RouteState';

// Workspace code-split behind session resolution (bundle route-splitting, plan
// C5.2): the whole session workspace — Timeline, feeds, AudioPlayer/Recorder,
// react-virtual — leaves the homepage graph and is fetched
// only once an id actually resolves to a live session. The `<Suspense>`
// fallback (inside `LazyChunk`) is the SAME `RouteLoadingState` the pending
// branch renders, so resolution -> chunk-fetch is one continuous, non-shifting
// loading frame.
//
// Module scope, and passed as a loader rather than pre-wrapped in `lazy()`:
// `LazyChunk` owns the `lazy()` instance so a failed chunk fetch can be retried
// with a fresh one (React.lazy caches rejections permanently — see
// ChunkLoadBoundary). Stable identity matters: `LazyChunk` reads this at mount
// and on retry.
const loadWorkspaceStatic = () =>
  import('./WorkspaceStatic').then((m) => ({ default: m.WorkspaceStatic }));

// --- SessionRoute (session-deep-links, task 4.2; spec: web-session-routing
// "Deep-link resolution states", design D5) ---
//
// Resolves the routed session id through the per-id `useSession` query and
// renders exactly one of five states:
//
//   loading   -> brand loading treatment (never a flash of not-found)
//   found, not archived -> the workspace (WorkspaceStatic, exactly as before
//                this change) — the workspace mount is GATED on resolution,
//                so an arbitrary id can never drive per-session fetches
//   found, archived     -> interstitial: identifies the session, offers the
//                existing Restore mutation (success invalidates the per-id
//                query, so the SAME URL re-resolves to the workspace with no
//                navigation) and a way back to `/`
//   not-found (404)     -> one state for nonexistent, deleted, and
//                unauthorized ids alike (the server masks all three behind a
//                single 404; nothing here may distinguish them)
//   error (non-404)     -> retryable, visually and semantically DISTINCT from
//                not-found: a transient failure must never read as a missing
//                session
//
// Latched: the decision below branches on `query.data` FIRST (the RootGate
// data-first idiom) and reads NOTHING from the polled sessions list, and the
// query itself never spontaneously refetches (no polling, staleTime Infinity —
// see useSession). Once the workspace has mounted for an id, background
// changes (list poll, remote archive, show/studio switch) cannot evict it; the
// state changes only on route change, on retry from the error state, or on
// Restore from the archived interstitial.
//
// The empty id (`/` or an unmatched path) bypasses resolution entirely and
// renders the dedicated home route component (`HomeRoute`, design D10 —
// GATE-OVERRIDDEN vs the spike, which rendered the same visuals inside
// SessionWorkspace's now-retired `#v3-session-placeholder`): no per-id
// request is issued. (The settings modal itself is mounted by AppShell, one
// level up — teams-settings-nav, design D1 — not here.)

// The page-frame class (height mirror included) and the brand loading treatment
// both live in `./RouteLoadingState` now — shared with the Suspense fallbacks
// added by the route split (plan C5.1), so every wait renders identical markup.
const LoadingState = RouteLoadingState;

// shadcn-port-shell D2: the three resolution states render through the shared RouteState panel
// (frame = the height-mirrored ROUTE_STATE_PAGE). Roles stay explicit: not-found and archived are
// polite `status`, error is `alert` (spec: error is semantically distinct from not-found).
function BackToSessions() {
  return (
    <Button variant="outline" className="h-11 w-full" onClick={() => navigate('/')}>
      Back to sessions
    </Button>
  );
}

function NotFoundState() {
  // One and the same state for nonexistent, deleted, and unauthorized ids —
  // the copy deliberately confirms nothing about whether the session exists.
  return (
    <RouteState
      frame="route"
      id="session-route-not-found"
      role="status"
      title="Session not found"
      actions={<BackToSessions />}
    >
      There&apos;s no session at this link. It may have been removed, or the link may be wrong.
    </RouteState>
  );
}

function ErrorState({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  // Distinct from not-found: transient failure, retryable in place.
  return (
    <RouteState
      frame="route"
      id="session-route-error"
      role="alert"
      title="Couldn't load session"
      actions={
        <>
          <Button
            className="h-11 w-full"
            id="session-route-retry"
            disabled={retrying}
            onClick={onRetry}
          >
            {retrying ? 'Retrying…' : 'Try again'}
          </Button>
          <BackToSessions />
        </>
      }
    >
      Something went wrong loading this session. Check your connection and try again.
    </RouteState>
  );
}

function ArchivedInterstitial({
  session,
  reResolving,
}: {
  session: Session;
  reResolving: boolean;
}) {
  const restore = useRestoreSession();
  // Busy through the whole round trip: the POST and the invalidated per-id
  // refetch that flips this URL to the workspace.
  const busy = restore.isPending || reResolving;
  return (
    <RouteState
      frame="route"
      id="session-route-archived"
      role="status"
      badge="Archived session"
      title={session.title}
      actions={
        <>
          <Button
            className="h-11 w-full"
            id="session-route-restore"
            disabled={busy}
            onClick={() =>
              restore.mutate(session.id, {
                onError: (err) =>
                  toast.error(err instanceof Error ? err.message : 'Restore failed.'),
              })
            }
          >
            {busy ? 'Restoring…' : 'Restore session'}
          </Button>
          <BackToSessions />
        </>
      }
    >
      This session is archived. Restore it to open the workspace.
    </RouteState>
  );
}

interface SessionRouteProps {
  /** Route-derived session id; empty string means the no-session home view. */
  sessionId: string;
  ytImportPending?: boolean;
  /** Opens the AppShell-owned New Session modal (design D10); threaded to HomeRoute. */
  onNewSession: () => void;
}

export function SessionRoute({ sessionId, ytImportPending, onNewSession }: SessionRouteProps) {
  const query = useSession(sessionId);

  // Warm the workspace chunk in PARALLEL with resolution, mirroring AppShell's
  // idle-prefetch idiom (there: the settings chunk after the load burst). The
  // workspace is the app's largest chunk, and its `lazy()` below only starts
  // fetching once `useSession` has resolved — so a cold deep link paid two
  // serial round trips (resolve, then download) behind one loading frame. This
  // starts the download on route entry instead; webpack de-dupes the module
  // request, so the `lazy()` below resolves off this same in-flight load rather
  // than issuing a second one.
  //
  // Deliberate trade-off: an id that resolves to 404/archived warms a chunk it
  // never mounts. Bytes on an uncommon path, in exchange for removing a serial
  // RTT from the common one. The rejection is swallowed here because this is a
  // pure warm-up with no UI of its own — a genuinely broken chunk surfaces
  // through the boundary below, when the render path actually needs it.
  useEffect(() => {
    if (!sessionId) return;
    void loadWorkspaceStatic().catch(() => {});
  }, [sessionId]);

  if (!sessionId) {
    // Home view (design D10): the dedicated route component, not the
    // workspace — useSession is disabled for the empty id, so this issues no
    // per-id request.
    return <HomeRoute onNewSession={onNewSession} />;
  }

  const resolution = query.data;

  if (resolution?.kind === 'found' && !resolution.session.archived) {
    return (
      // Same fallback component as the pending branch below: the workspace
      // chunk fetch continues the loading frame rather than starting a new,
      // differently-sized one (plan C5.2). A failed fetch renders the
      // route-variant retry card in that same frame instead of throwing out of
      // the island.
      <LazyChunk load={loadWorkspaceStatic} variant="route" fallback={<LoadingState />}>
        {(WorkspaceStatic) => (
          <WorkspaceStatic sessionId={sessionId} ytImportPending={ytImportPending} />
        )}
      </LazyChunk>
    );
  }

  if (!resolution) {
    // Data-first branching (the RootGate idiom): the error panel is only
    // reachable while there is no resolved data at all, so a failed background
    // refetch (e.g. after a Restore invalidation) can never bounce a resolved
    // state back to loading/error.
    return query.isError ? (
      <ErrorState onRetry={() => void query.refetch()} retrying={query.isFetching} />
    ) : (
      <LoadingState />
    );
  }

  if (resolution.kind === 'not-found') {
    return <NotFoundState />;
  }

  return <ArchivedInterstitial session={resolution.session} reResolving={query.isFetching} />;
}
