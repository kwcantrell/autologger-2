import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';
import type { ProfilePayload, ProfileUpdateBody, Show, ShowCreateBody } from '../types';

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
    onSuccess: () => qc.invalidateQueries({ queryKey: ['profile'] }),
  });
}
