import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';
import type {
  CompanionDeviceCreateBody,
  CompanionDeviceCreatedResponse,
  CompanionDeviceListResponse,
} from '../types';

// --- Companion device hooks (companion-devices task 7.1; design D6) ---
//
// The signed-in user's own devices, through `/api/companion-devices` (api-contract-freeze
// "Companion device management routes"). The create response carries the device's token, which is
// shown once: the create mutation never writes it into the query cache. It invalidates the list
// instead, so the cache only ever holds the token-free list shape. Errors surface as `ApiError`,
// whose message is the response's `detail`.

export const companionDeviceKeys = {
  list: () => ['companion-devices'] as const,
};

export function useCompanionDevices() {
  return useQuery({
    queryKey: companionDeviceKeys.list(),
    queryFn: () => apiFetch<CompanionDeviceListResponse>('companion-devices'),
  });
}

export function useCreateCompanionDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CompanionDeviceCreateBody) =>
      apiFetch<CompanionDeviceCreatedResponse>('companion-devices', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    // `gcTime: 0` drops the settled mutation (and with it the token in its `data`) from the
    // mutation cache as soon as no component observes it.
    gcTime: 0,
    onSuccess: () => qc.invalidateQueries({ queryKey: companionDeviceKeys.list() }),
  });
}

export function useRevokeCompanionDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`companion-devices/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: companionDeviceKeys.list() }),
  });
}
