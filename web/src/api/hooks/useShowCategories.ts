import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../client';
import type { ShowCategoriesResponse } from '../types';

export function useShowCategories(sessionId: string | null) {
  return useQuery({
    queryKey: ['show-categories', sessionId],
    queryFn: () => apiFetch<ShowCategoriesResponse>(`sessions/${sessionId}/show-categories`),
    enabled: Boolean(sessionId),
    staleTime: 30_000,
  });
}
