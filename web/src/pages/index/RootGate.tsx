import { useProfile } from '../../api/hooks/useProfile';
import { AppLoadingSkeleton } from '../../shared/ui/AppLoadingSkeleton';
import { AUTOLOGGER_LOADING_VIDEO_SRC } from '../../shared/utils/loadingVideo';
import { AppShell } from './AppShell';
import { LoginPage } from './components/LoginPage';

// --- RootGate (add-login-screen, task 2.2) ---
// Root switch mounted above `AppShell` (design D2). Runs its own `useProfile()`
// and renders exactly one of four states, keyed on query status + data — not
// a latched boot decision — so a live profile refetch can flip the switch
// mid-session:
//
//   no data, pending  -> brand loading treatment (initial load in flight)
//   no data, error     -> retryable error panel (initial-load failure only)
//   data present,
//     oauth_configured
//     && !logged_in    -> LoginPage (also the mid-session sign-out case: a
//                         successful refetch that flips to signed-out lands
//                         here on the next render)
//   data present,
//     otherwise        -> AppShell
//
// Branching on `data` first (before status) is what makes a *background*
// refetch error fall through to the AppShell branch instead of the error
// panel: react-query keeps the last good `data` across a failed background
// refetch, so the error branch is only reachable when there is no data at
// all — i.e. the initial load itself failed.
//
// Self-contained wrapper shape (D2 shape note): this component owns its own
// `useProfile()` call rather than accepting profile state as props, so it
// relocates verbatim above the session-deep-links router shell when that
// change lands — the gate must keep covering every future URL.
//
// No branch here except AppShell mounts authenticated child hooks (sessions,
// sockets, …), so the loading/error/login states are structurally silent
// beyond the one anonymous `GET /api/profile` request the query issues.

const GATE_PAGE =
  'relative z-[1] flex min-h-screen min-h-[100dvh] w-full items-center justify-center px-5 py-10';

// Single-sourced with the Next `dynamic()` `loading` fallback (task 5.1,
// design D9.1): this renders the exact same `AppLoadingSkeleton` used by
// `IndexIsland`/`AdminIsland`, opting into the looping brand video as that
// component's `media` progressive-enhancement slot rather than hand-rolling
// a second copy of the loading frame.
function LoadingState() {
  return (
    <AppLoadingSkeleton
      id="root-gate-loading"
      media={
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
      }
    />
  );
}

function ErrorState({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  return (
    <div className={GATE_PAGE}>
      <div
        className="glass-panel relative box-border w-full max-w-[25rem] rounded-v5-lg px-7 py-9 text-center"
        id="root-gate-error"
        role="alert"
      >
        <h1 className="m-0 font-league-gothic text-[2.25rem] leading-none tracking-[0.02em] uppercase text-v5-text">
          AutoLogger
        </h1>
        <p className="mx-auto mb-0 mt-3 max-w-[19rem] text-[0.9rem] leading-[1.5] text-v5-muted">
          Couldn&apos;t reach the server. Check your connection and try again.
        </p>
        <button
          type="button"
          className="mt-6 box-border flex h-11 w-full cursor-pointer items-center justify-center rounded-v5-sm border border-v5-border-strong bg-[rgba(255,255,255,0.03)] px-4 text-[0.8125rem] font-semibold tracking-[0.04em] text-v5-muted [transition:border-color_0.15s_ease,background_0.15s_ease,color_0.15s_ease] hover-always:bg-[rgba(255,255,255,0.05)] hover-always:text-v5-text disabled:cursor-not-allowed disabled:opacity-50"
          id="root-gate-retry"
          disabled={retrying}
          onClick={onRetry}
        >
          {retrying ? 'Retrying…' : 'Try again'}
        </button>
      </div>
    </div>
  );
}

export function RootGate() {
  const { data, isError, isFetching, refetch } = useProfile();

  if (!data) {
    // No data yet: either the initial fetch is still in flight (pending, not
    // errored) or it has exhausted the query layer's retries and landed in
    // the error state. A query with no data is never in any other status.
    if (isError) {
      return <ErrorState onRetry={() => void refetch()} retrying={isFetching} />;
    }
    return <LoadingState />;
  }

  if (data.auth.oauth_configured && !data.auth.logged_in) {
    return <LoginPage />;
  }

  return <AppShell />;
}
