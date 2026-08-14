import { AUTOLOGGER_LOADING_VIDEO_SRC } from '../../../shared/utils/loadingVideo';

// --- RouteLoadingState (bundle route-splitting, plan C5.1) ---
//
// Lifted verbatim out of `SessionRoute.tsx` so that BOTH the resolution
// pending branch and the `<Suspense>` fallbacks introduced by the route split
// render THE SAME markup. That identity is the zero-added-CLS invariant: with
// `WorkspaceStatic` behind `React.lazy`, a deep link now passes through two
// consecutive waits — session resolution, then the workspace chunk fetch — and
// the second must be pixel-indistinguishable from the first, or the split
// re-introduces the layout shift `STATE_PAGE`'s min-height was added to kill.
//
// Keep this module cheap: it is imported by the eagerly-loaded homepage graph,
// so anything it pulls in is pinned into the initial download. Its only
// dependency is the loading-video src constant (already in that graph).

// Height mirrors `#v3-session-active` (SessionWorkspace's `v3-session-active-root`:
// `min-h-[calc(100vh-2.2rem)] max-md:min-h-0`) so swapping any of SessionRoute's states out
// for the workspace — or back — shifts nothing (measured CLS 0.122 before the mirror).
export const ROUTE_STATE_PAGE =
  'relative z-[1] flex w-full items-center justify-center px-5 py-16 min-h-[calc(100vh-2.2rem)] max-md:min-h-0';

interface RouteLoadingStateProps {
  /** What is being waited on, announced to screen readers. */
  label?: string;
  /**
   * DOM id. Defaults to the session route's because its pending branch, its workspace-chunk
   * fallback, and the tests keyed on that id all predate this component being shared with
   * other routes — a route rendering in SessionRoute's PLACE passes its own instead.
   */
  id?: string;
}

// Parameterized (PR review finding 3) because the markup is shared across routes while the
// ANNOUNCEMENT is not: reused prop-less at the `/teams` Suspense fallback, this told screen
// readers "Loading session" on a route with no session in it, and duplicated the session
// route's DOM id onto an element that is not it. The visual treatment — the whole reason the
// component is shared — is unaffected: only the label and the id vary, and both default to
// the session values so every existing call site and id-keyed test is unchanged.
export function RouteLoadingState({
  label = 'Loading session',
  id = 'session-route-loading',
}: RouteLoadingStateProps) {
  // The brand loading treatment (the RootGate LoadingState idiom).
  return (
    <output
      className={ROUTE_STATE_PAGE}
      id={id}
      aria-busy="true"
      aria-live="polite"
      aria-label={label}
    >
      <div className="autologger-loading-video">
        <video
          className="autologger-loading-video__media"
          src={AUTOLOGGER_LOADING_VIDEO_SRC}
          preload="auto"
          muted
          playsInline
          autoPlay
          loop
        />
      </div>
    </output>
  );
}
