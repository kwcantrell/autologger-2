import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';
import type { ProfilePayload, ProfileUpdateBody, Show, ShowCreateBody } from '../types';
import { showKeys } from './useShows';

export function useProfile() {
  return useQuery({
    queryKey: ['profile'],
    queryFn: () => apiFetch<ProfilePayload>('profile'),
    staleTime: 30_000,
  });
}

export function useProfileMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ProfileUpdateBody) =>
      apiFetch<ProfilePayload>('profile', {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    onSuccess: (data) => {
      qc.setQueryData(['profile'], data);
    },
  });
}

export function useCreateShow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ShowCreateBody) =>
      apiFetch<{ show: Show }>('shows', { method: 'POST', body: JSON.stringify(body) }),
    // The created show has to reach BOTH show caches, not just the profile:
    // `profile.shows[]` is the brief list every show picker reads, and
    // the studio-shows list is the full-config one HomeSettingsModal edits — the new
    // show would otherwise be missing from its own show selector until that
    // query's 30s staleTime expired (profile-shows-slimming). The response
    // itself stays the full `Show`, which the caller uses to seed a draft
    // synchronously, so neither refetch is on the critical path.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profile'] });
      qc.invalidateQueries({ queryKey: showKeys.allStudios() });
    },
  });
}
