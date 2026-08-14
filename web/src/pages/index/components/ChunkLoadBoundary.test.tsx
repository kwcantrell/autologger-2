import { fireEvent, screen } from '@testing-library/react';
import type { ComponentType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderStrict } from '../../../test/renderStrict';
import { isChunkLoadError, LazyChunk } from './ChunkLoadBoundary';

// --- ChunkLoadBoundary / LazyChunk tests (bundle route-splitting, review fix)
// ---
//
// The property under test is the one the route split broke: a failed chunk
// fetch must degrade to a local, retryable surface instead of throwing out of
// the `ssr: false` island and blanking the app. Two mechanics are pinned that
// a naive boundary would get wrong:
//
//   1. Locality — the failing subtree is replaced, its siblings are not.
//   2. Retry actually re-imports. `React.lazy` memoizes the promise it was
//      handed, rejection included, so resetting boundary state alone would
//      re-throw the SAME cached rejection forever. The retry path is only
//      correct if it builds a new `lazy()`; the "reject once, then resolve"
//      test below fails against any implementation that reuses the instance.

vi.mock('../../../shared/utils/loadingVideo', () => ({
  AUTOLOGGER_LOADING_VIDEO_SRC: '',
}));

interface LoadedProps {
  label: string;
}

type Loader = () => Promise<{ default: ComponentType<LoadedProps> }>;

function Loaded({ label }: LoadedProps) {
  return <div data-testid="loaded-content">{label}</div>;
}

/** What webpack throws when a content-hashed chunk URL 404s (post-redeploy). */
function chunkLoadError(): Error {
  const error = new Error('Loading chunk 42 failed. (error: /_next/static/chunks/42-abc.js)');
  error.name = 'ChunkLoadError';
  return error;
}

const errorCard = () => screen.queryByTestId('chunk-load-error');
const retryButton = () => screen.queryByTestId('chunk-load-retry');

beforeEach(() => {
  // React itself logs every boundary-caught error; so does componentDidCatch.
  // Silenced so the suite output stays readable — the log is asserted on
  // explicitly in the non-chunk test below.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LazyChunk chunk-load failure', () => {
  it('renders the route retry card instead of blanking the tree, leaving siblings mounted', async () => {
    const load: Loader = () => Promise.reject(chunkLoadError());

    renderStrict(
      <div>
        <div data-testid="route-chrome">rail + header</div>
        <LazyChunk load={load} variant="route" fallback={<div data-testid="route-loading" />}>
          {(Chunk) => <Chunk label="workspace" />}
        </LazyChunk>
      </div>,
    );

    expect(await screen.findByTestId('chunk-load-error')).not.toBeNull();
    // The failure is local: everything outside the boundary survived it. (Before
    // this boundary existed, the throw escaped the island root and unmounted
    // the whole client tree — sibling included.)
    expect(screen.getByTestId('route-chrome')).not.toBeNull();
    expect(retryButton()).not.toBeNull();
    expect(screen.queryByTestId('loaded-content')).toBeNull();
  });

  it('retry re-imports and mounts the component — a fresh lazy(), not the cached rejection', async () => {
    // React.lazy caches the rejected promise for the lifetime of the instance:
    // if `LazyChunk` handed the same instance back after retry, no amount of
    // state resetting could ever produce `loaded-content` here, however many
    // times the loader is willing to succeed.
    const attempts: string[] = [];
    let mode: 'fail' | 'ok' = 'fail';
    const load: Loader = () => {
      attempts.push(mode);
      return mode === 'fail'
        ? Promise.reject(chunkLoadError())
        : Promise.resolve({ default: Loaded });
    };

    renderStrict(
      <LazyChunk load={load} variant="route" fallback={<div data-testid="route-loading" />}>
        {(Chunk) => <Chunk label="workspace" />}
      </LazyChunk>,
    );

    expect(await screen.findByTestId('chunk-load-error')).not.toBeNull();
    const attemptsAtFailure = attempts.length;
    expect(attemptsAtFailure).toBeGreaterThan(0);

    // The network recovers (or the user is now on the new deploy's manifest).
    mode = 'ok';
    fireEvent.click(screen.getByTestId('chunk-load-retry'));

    const loaded = await screen.findByTestId('loaded-content');
    expect(loaded.textContent).toBe('workspace');
    expect(errorCard()).toBeNull();
    // Proof the retry issued a real second import rather than replaying state.
    expect(attempts.length).toBeGreaterThan(attemptsAtFailure);
    expect(attempts.at(-1)).toBe('ok');
  });

  it('keeps a failed overlay local and dismissible, with the page beneath untouched', async () => {
    const load: Loader = () => Promise.reject(chunkLoadError());
    const onDismiss = vi.fn();

    renderStrict(
      <div>
        <div data-testid="route-content">session workspace</div>
        <LazyChunk load={load} variant="overlay" onDismiss={onDismiss}>
          {(Chunk) => <Chunk label="settings" />}
        </LazyChunk>
      </div>,
    );

    const card = await screen.findByTestId('chunk-load-error');
    expect(card.getAttribute('data-variant')).toBe('overlay');
    expect(screen.getByTestId('route-content')).not.toBeNull();

    fireEvent.click(screen.getByTestId('chunk-load-dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('mounts the component normally when the chunk loads, with no error surface', async () => {
    const load: Loader = () => Promise.resolve({ default: Loaded });

    renderStrict(
      <LazyChunk load={load} variant="route" fallback={<div data-testid="route-loading" />}>
        {(Chunk) => <Chunk label="workspace" />}
      </LazyChunk>,
    );

    expect(await screen.findByTestId('loaded-content')).not.toBeNull();
    expect(errorCard()).toBeNull();
  });
});

describe('LazyChunk non-chunk render errors', () => {
  // Policy (documented in ChunkLoadBoundary): NOT rethrown (that restores the
  // blank-island failure mode) and NOT silently swallowed — a visible generic
  // state plus a console log, and deliberately no Retry, since re-rendering
  // the same broken code with the same props just throws again.
  function Exploding(): never {
    throw new Error("Cannot read properties of undefined (reading 'events')");
  }

  it('renders a generic error state with no Retry, and logs the real error', async () => {
    const load: Loader = () =>
      Promise.resolve({ default: Exploding as unknown as ComponentType<LoadedProps> });

    renderStrict(
      <div>
        <div data-testid="route-chrome" />
        <LazyChunk load={load} variant="route" fallback={null}>
          {(Chunk) => <Chunk label="workspace" />}
        </LazyChunk>
      </div>,
    );

    const card = await screen.findByTestId('chunk-load-error');
    expect(card.textContent).toContain('Something went wrong');
    // No retry affordance that could not possibly work; reload is still offered.
    expect(retryButton()).toBeNull();
    expect(screen.getByTestId('chunk-load-reload')).not.toBeNull();
    // Still local, and still diagnosable.
    expect(screen.getByTestId('route-chrome')).not.toBeNull();
    expect(
      vi
        .mocked(console.error)
        .mock.calls.some((args) => String(args[0]).includes('[ChunkLoadBoundary]')),
    ).toBe(true);
  });
});

describe('isChunkLoadError', () => {
  it('recognizes the failed-dynamic-import shapes each engine throws', () => {
    const named = new Error('nondescript');
    named.name = 'ChunkLoadError';

    expect(isChunkLoadError(named)).toBe(true);
    expect(isChunkLoadError(new Error('Loading chunk 42 failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Loading CSS chunk 7 failed.'))).toBe(true);
    expect(
      isChunkLoadError(new Error('Failed to fetch dynamically imported module: /chunk.js')),
    ).toBe(true);
    expect(isChunkLoadError(new Error('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true);
    // A deleted chunk whose URL now falls through to the HTML shell.
    expect(
      isChunkLoadError(
        new Error(
          'Failed to load module script: Expected a JavaScript module script but the server ' +
            'responded with a MIME type of "text/html".',
        ),
      ),
    ).toBe(true);
  });

  it('does not claim ordinary application errors', () => {
    expect(isChunkLoadError(new Error("Cannot read properties of undefined (reading 'x')"))).toBe(
      false,
    );
    expect(isChunkLoadError(new TypeError('x is not a function'))).toBe(false);
    expect(isChunkLoadError('Loading chunk 3 failed')).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});
