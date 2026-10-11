import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';
import type {
  ProviderCredential,
  ProviderKind,
  ProviderSaveBody,
  ProvidersResponse,
  ProviderTestResponse,
} from '../types';

// --- Provider credential hooks (byo-ai-providers task 6.1; design D6) ---
//
// The signed-in user's own provider credentials, through `/api/me/providers` (api-contract-freeze
// "Provider credential routes"). A typed key goes out only in the save body. The save mutation is
// kept out of the mutation cache (`gcTime: 0`) and reset by the caller once it settles, so its
// variables, which hold the key, don't linger. The query cache only ever holds the key-free list.
// Errors surface as `ApiError`, whose message is the response's `detail`.

export const providerKeys = {
  list: () => ['providers'] as const,
};

/** `enabled: false` subscribes without fetching (the Transcribe feed watches only while latched). */
export function useProviders(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: providerKeys.list(),
    queryFn: () => apiFetch<ProvidersResponse>('me/providers'),
    enabled: options.enabled ?? true,
  });
}

export function useSaveProvider(kind: ProviderKind) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ProviderSaveBody) =>
      apiFetch<ProviderCredential>(`me/providers/${kind}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    gcTime: 0,
    onSuccess: () => qc.invalidateQueries({ queryKey: providerKeys.list() }),
  });
}

export function useDeleteProvider(kind: ProviderKind) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<void>(`me/providers/${kind}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: providerKeys.list() }),
  });
}

export function useTestProvider(kind: ProviderKind) {
  return useMutation({
    mutationFn: () =>
      apiFetch<ProviderTestResponse>(`me/providers/${kind}/test`, { method: 'POST' }),
    gcTime: 0,
  });
}
