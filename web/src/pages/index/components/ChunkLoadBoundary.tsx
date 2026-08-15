import {
  Component,
  type ComponentType,
  type ErrorInfo,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useState,
} from 'react';
import { ROUTE_STATE_PAGE } from './RouteLoadingState';

// --- ChunkLoadBoundary / LazyChunk (bundle route-splitting, review fix) ---
//
// The route split put six surfaces behind `React.lazy` — six `LazyChunk` call
// sites: the workspace (`SessionRoute`), `TeamsRoute`, and four modals
// (NewSession, BatchImport, YouTubeImportError, HomeSettings). Every one of
// them is a network fetch at render time, and the island has NO error boundary
// above it: Next's
// `pageExtensions` pin means there is no `error.page.tsx`, so a rejected chunk
// import throws straight through `<Suspense>` and out of the `ssr: false`
// island root — unmounting the ENTIRE app to a permanently blank page. The
// trigger is routine, not exotic: a redeploy rewrites content-hashed chunk
// URLs, so any tab open across a deploy 404s on its next lazy import.
//
// Naming note: "chunk" here means a *JavaScript bundle chunk*, NOT the audio
// chunks that `chunkUploadQueue` / `ChunkRescueBanner` / `chunkLeaveWarning`
// own. The two vocabularies are unrelated; `ChunkLoad*` matches the
// `ChunkLoadError` name webpack itself throws, which is the disambiguator.

/**
 * Message shapes the various bundlers/engines use for a failed dynamic import.
 * webpack (what Next uses) throws an `Error` with `name === 'ChunkLoadError'`
 * and a "Loading chunk N failed" message; the ESM-native paths (used by the
 * vitest/browser dev transform, and by Next in some edge cases) throw the
 * engine's own wording, which differs per browser. A stale HTML document
 * served in place of a deleted chunk yields the MIME-type variant.
 */
const CHUNK_ERROR_PATTERNS: readonly RegExp[] = [
  /loading chunk \S+ failed/i, // webpack
  /loading css chunk/i, // webpack (mini-css-extract)
  /failed to fetch dynamically imported module/i, // Chromium
  /error loading dynamically imported module/i, // Firefox
  /importing a module script failed/i, // Safari
  /failed to load module script/i, // Chromium, stale HTML served for a dead chunk
];

/**
 * True iff `error` looks like a failed dynamic import rather than a bug in the
 * loaded code. Deliberately name-first (`ChunkLoadError` is webpack's own
 * class) with message matching as the cross-engine fallback — there is no
 * structured signal available in either case.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === 'ChunkLoadError') return true;
  if (typeof message !== 'string') return false;
  return CHUNK_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * `route` renders inside the shared page frame (`ROUTE_STATE_PAGE`, the same
 * height-mirrored frame `RouteLoadingState` and SessionRoute's own states use,
 * so a failure shifts nothing); `overlay` renders a compact card for surfaces
 * that are themselves overlays over an otherwise-intact page.
 */
export type ChunkBoundaryVariant = 'route' | 'overlay';

// Mirrors SessionRoute's own state-panel idioms (STATE_PANEL/TITLE/COPY/BUTTON
// there). Copied rather than imported: SessionRoute imports THIS module, so
// exporting them from there would be a cycle, and this module must stay cheap
// enough to sit in the eagerly-loaded homepage graph (its only import is the
// page-frame constant, already in that graph).
const PANEL =
  'glass-panel relative box-border w-full max-w-[25rem] rounded-v5-lg px-7 py-9 text-center';
const TITLE =
  'm-0 font-league-gothic text-[2.25rem] leading-none tracking-[0.02em] uppercase text-v5-text';
const COPY = 'mx-auto mb-0 mt-3 max-w-[19rem] text-[0.9rem] leading-[1.5] text-v5-muted';
const BUTTON =
  'box-border flex h-11 w-full cursor-pointer items-center justify-center rounded-v5-sm border border-v5-border-strong bg-[rgba(255,255,255,0.03)] px-4 text-[0.8125rem] font-semibold tracking-[0.04em] text-v5-muted [transition:border-color_0.15s_ease,background_0.15s_ease,color_0.15s_ease] hover-always:bg-[rgba(255,255,255,0.05)] hover-always:text-v5-text';

function reloadPage(): void {
  window.location.reload();
}

interface FallbackProps {
  variant: ChunkBoundaryVariant;
  /** Chunk-load failures only — a generic render error has no useful retry. */
  onRetry: (() => void) | null;
  /** Overlay surfaces only: closes the owning open-flag in the parent. */
  onDismiss?: (() => void) | undefined;
  title: string;
  copy: string;
}

function ChunkBoundaryFallback({ variant, onRetry, onDismiss, title, copy }: FallbackProps) {
  const actions = (
    <>
      {onRetry && (
        <button
          type="button"
          className={`${BUTTON} ${variant === 'route' ? 'mt-6' : ''}`}
          data-testid="chunk-load-retry"
          onClick={onRetry}
        >
          Try again
        </button>
      )}
      <button
        type="button"
        className={`${BUTTON} ${variant === 'route' || onRetry ? 'mt-3' : ''}`}
        data-testid="chunk-load-reload"
        onClick={reloadPage}
      >
        Reload page
      </button>
      {onDismiss && (
        <button
          type="button"
          className={`${BUTTON} mt-3`}
          data-testid="chunk-load-dismiss"
          onClick={onDismiss}
        >
          Dismiss
        </button>
      )}
    </>
  );

  if (variant === 'overlay') {
    // Compact card, positioned like ChunkRescueBanner's rescue surface (the
    // app's existing "something needs your attention, the page underneath is
    // fine" idiom) — the route below it stays visible and interactive.
    return (
      <div
        role="alert"
        data-testid="chunk-load-error"
        data-variant="overlay"
        className="glass-face-strong fixed inset-x-0 top-0 z-(--z-toast) mx-auto mt-2 box-border w-[min(28rem,94vw)] rounded-v5-md border border-v5-border-strong p-4 shadow-[0_8px_32px_rgba(0,0,0,0.35)]"
      >
        <p className="m-0 text-[0.9rem] font-medium text-v5-text">{title}</p>
        <p className="m-0 mt-1 text-[0.8rem] leading-[1.45] text-v5-muted">{copy}</p>
        <div className="mt-3 flex flex-col gap-2">{actions}</div>
      </div>
    );
  }

  return (
    <div className={ROUTE_STATE_PAGE}>
      <div className={PANEL} role="alert" data-testid="chunk-load-error" data-variant="route">
        <h1 className={TITLE}>{title}</h1>
        <p className={COPY}>{copy}</p>
        {actions}
      </div>
    </div>
  );
}

interface ChunkLoadBoundaryProps {
  variant: ChunkBoundaryVariant;
  /** Bumps the owning `LazyChunk`'s attempt counter — see its doc comment. */
  onRetry: () => void;
  onDismiss?: (() => void) | undefined;
  children: ReactNode;
}

interface ChunkLoadBoundaryState {
  error: unknown;
  caught: boolean;
}

/**
 * Class component because error boundaries have no hook equivalent — React
 * exposes `getDerivedStateFromError` / `componentDidCatch` on classes only.
 *
 * Failure policy (deliberate, two cases):
 *
 *   chunk-load failure -> retry UI. The import can succeed on a second try
 *     (the network blipped, or the user is mid-redeploy and a reload will pull
 *     the new manifest), so both a Retry and a Reload are offered.
 *
 *   any other render error -> a generic error state with Reload only. NOT
 *     rethrown: rethrowing would resume the exact failure mode this boundary
 *     exists to remove (nothing above it catches, so the island unmounts to a
 *     blank page). NOT silently swallowed either — it renders a visible error
 *     surface AND `componentDidCatch` logs the error with its component stack,
 *     so a real bug still shows up in the console rather than being masked as
 *     "a chunk failed". Retry is withheld in this case on purpose: remounting
 *     the same code with the same props re-throws, and a Retry button that
 *     cannot work is worse than none.
 *
 * State is never cleared from inside: retry is the parent bumping the `key`,
 * which remounts this boundary with a fresh (empty) state AND a freshly built
 * `lazy()` — see `LazyChunk`.
 */
export class ChunkLoadBoundary extends Component<ChunkLoadBoundaryProps, ChunkLoadBoundaryState> {
  override state: ChunkLoadBoundaryState = { error: null, caught: false };

  static getDerivedStateFromError(error: unknown): ChunkLoadBoundaryState {
    return { error, caught: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Keep the real diagnostic: a swallowed non-chunk error would otherwise be
    // indistinguishable from a network failure.
    console.error('[ChunkLoadBoundary] caught render error', error, info.componentStack);
  }

  override render(): ReactNode {
    const { variant, onRetry, onDismiss, children } = this.props;
    if (!this.state.caught) return children;

    if (isChunkLoadError(this.state.error)) {
      return (
        <ChunkBoundaryFallback
          variant={variant}
          onRetry={onRetry}
          onDismiss={onDismiss}
          title={variant === 'route' ? "Couldn't finish loading" : "Couldn't load this panel"}
          copy="Part of the app failed to download. This usually means the connection dropped, or a new version was just deployed."
        />
      );
    }

    return (
      <ChunkBoundaryFallback
        variant={variant}
        onRetry={null}
        onDismiss={onDismiss}
        title="Something went wrong"
        copy="This part of the app hit an unexpected error. Reloading the page usually clears it."
      />
    );
  }
}

interface LazyChunkProps<P extends object> {
  /**
   * Module loader, e.g. `() => import('./Foo').then((m) => ({ default: m.Foo }))`.
   * MUST be defined at module scope (or otherwise referentially stable): it is
   * read at mount and on each retry, never watched for identity changes.
   */
  load: () => Promise<{ default: ComponentType<P> }>;
  variant: ChunkBoundaryVariant;
  /** Suspense fallback while the chunk is in flight. `null` for overlays. */
  fallback?: ReactNode;
  /** Overlay surfaces: lets the failure card close the parent's open flag. */
  onDismiss?: (() => void) | undefined;
  children: (Loaded: ComponentType<P>) => ReactNode;
}

/**
 * One `React.lazy` mount, wrapped in its own `<Suspense>` and its own
 * `ChunkLoadBoundary`. Each call site gets an independent boundary, so a
 * failure stays local — a dead settings chunk shows a card over an intact
 * route instead of blanking it.
 *
 * Why the lazy is built HERE and not at module scope: `React.lazy` memoizes
 * the promise it gets from `load()`, INCLUDING a rejection. Once a module-scope
 * `lazy()` has rejected, every future render of it re-throws the cached
 * rejection forever — remounting it, resetting boundary state, and clicking
 * any number of Retry buttons cannot make it call `import()` again. The only
 * way back is a brand-new `lazy()` instance, so retry rebuilds one:
 *
 *   retry -> setChunk({ attempt: n + 1, Loaded: lazy(load) })
 *         -> new `Loaded` (fresh, un-poisoned promise cache)
 *         -> `key={attempt}` remounts the boundary (state reset) and the
 *            Suspense below it, which re-invokes `load()` -> a real new fetch.
 *
 * The attempt counter and the lazy live in ONE state object so they can never
 * drift apart. This state survives the failure it recovers from: the throw
 * happens below the `<Suspense>` inside this component, so the error unwinds
 * to the boundary — never to `LazyChunk` itself, whose hooks stay mounted.
 * (webpack de-dupes concurrent/repeat requests for the same module, so the
 * warm-up `import()` in SessionRoute and this `lazy()` share one module load.)
 */
export function LazyChunk<P extends object>({
  load,
  variant,
  fallback = null,
  onDismiss,
  children,
}: LazyChunkProps<P>) {
  const [chunk, setChunk] = useState(() => ({ attempt: 0, Loaded: lazy(load) }));

  const handleRetry = useCallback(() => {
    setChunk((prev) => ({ attempt: prev.attempt + 1, Loaded: lazy(load) }));
  }, [load]);

  return (
    <ChunkLoadBoundary
      key={chunk.attempt}
      variant={variant}
      onRetry={handleRetry}
      onDismiss={onDismiss}
    >
      <Suspense fallback={fallback}>{children(chunk.Loaded)}</Suspense>
    </ChunkLoadBoundary>
  );
}
