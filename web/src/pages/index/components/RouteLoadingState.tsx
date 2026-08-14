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

export function RouteLoadingState() {
  // The brand loading treatment (the RootGate LoadingState idiom).
  return (
    <output
      className={ROUTE_STATE_PAGE}
      id="session-route-loading"
      aria-busy="true"
      aria-live="polite"
      aria-label="Loading session"
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
