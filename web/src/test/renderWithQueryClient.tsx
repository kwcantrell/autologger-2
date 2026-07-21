import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RenderResult } from '@testing-library/react';
import { renderStrict } from './renderStrict';

/**
 * `renderStrict`, plus a `QueryClientProvider` ancestor — for tests that
 * render a component tree calling real `@tanstack/react-query` hooks
 * (`useQuery`/`useMutation`) without a `QueryClientProvider` of their own
 * (see `main.tsx`'s app-level provider, which real usage sits under but a
 * unit test rendering the component in isolation does not). Generalizes the
 * per-file pattern already used by `useSession.test.tsx`/`AiChat.test.tsx`
 * (ai-v2-dashboards task 5.6 needed a third, non-hook-test copy, hence
 * pulling it out here) — introduced by task 5.6's `useAiV2WidgetData`,
 * called unconditionally inside `AiV2Panel`.
 *
 * `retry: false` by default so a mocked rejection settles on the first
 * attempt instead of retrying through the test's own timeout.
 */
export function renderWithQueryClient(
  ui: React.ReactElement,
  client: QueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
): RenderResult {
  return renderStrict(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}
