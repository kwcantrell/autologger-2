import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiFetch } from '../client';
import type { ConnectedAppListResponse } from '../types';

// --- Connected apps hooks (custom session dashboards J4; design 4.8) ---
//
// The signed-in user's own OAuth grants, through `/api/oauth/connected-apps`. The routes exist
// only with `CUSTOM_DASHBOARDS_ENABLED` on, so a `404` from the list means "feature off" (the
// `isFeatureOff` check): the query does not retry it, and the Settings view hides the section.
// Any other failure keeps the section listed and shows the error.

export const connectedAppKeys = {
  list: () => ['connected-apps'] as const,
};

/** Whether a list error is the server saying the feature is off (`404`). */
export const isFeatureOff = (err: unknown): boolean =>
  err instanceof ApiError && err.status === 404;

export function useConnectedApps() {
  return useQuery({
    queryKey: connectedAppKeys.list(),
    queryFn: () => apiFetch<ConnectedAppListResponse>('oauth/connected-apps'),
    // The probe is one request: a `404` is the answer, not a fault to retry.
    retry: (count, err) => !isFeatureOff(err) && count < 2,
    // The view and the section share this query; remounting the section must not restart a
    // failed query (that would flip it back to pending and drop the tab while it retries).
    retryOnMount: false,
    staleTime: 60_000,
  });
}

export function useRevokeConnectedApp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (grantId: string) =>
      apiFetch<void>(`oauth/connected-apps/${encodeURIComponent(grantId)}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: connectedAppKeys.list() }),
    // A 404 (already revoked elsewhere) leaves a stale row; refetch to clear it.
    onError: () => qc.invalidateQueries({ queryKey: connectedAppKeys.list() }),
  });
}
