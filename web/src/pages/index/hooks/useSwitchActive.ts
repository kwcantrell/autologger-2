import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useProfile, useProfileMutation } from '../../../api/hooks/useProfile';
import { sessionStatusKeys } from '../../../api/hooks/useSessionStatus';
import { showAccessFrom } from '../../../api/hooks/useShowAccess';
import type { ProfileUpdateBody } from '../../../api/types';
import { showToast } from '../utils/toast';

// --- Switching the active team and show (redesign-show-ignition D5; catalog-search D9) ---
//
// Extracted from TopBar so the top-bar menus and a search result share one switch path.
// Switching writes `PUT /api/profile` immediately:
//   - a team sends `{ active_studio_id }` with `active_show_id` omitted, so the server picks the
//     new team's first show (the Settings modal's mid-switch rule);
//   - a show sends `{ active_studio_id, active_show_id }` in one PUT — the server 400s on a show
//     outside the active studio (`server/src/routers/profile.ts`), so the show's own studio goes
//     with it (the active one from the top bar, the hit's from a search result).
// A switch that changes the studio follows the close-session path. Either then refetches the
// session list, events, session status and show categories, as the modal's save did
// (web-coordination-seam "The settings modal still refetches the session list"). A failure leaves
// the cache — and so the shown selection — untouched and names the failure. With Settings open
// and holding unsaved edits, a switch first asks through the view's discard guard
// (`confirmSwitch`); declining keeps the edits and the selection.

export interface SwitchTarget {
  studioId: string;
  /** Omitted for a team switch. */
  showId?: string;
}

interface Options {
  /** AppShell's close-session path (navigates to `/` only when a session is open). */
  onCloseSession: () => void;
  /** The open Settings view's discard guard; `true` at once when nothing is dirty. */
  confirmSwitch?: () => true | Promise<boolean>;
}

export interface UseSwitchActiveResult {
  /** The active studio and show, as the switch reads them. */
  activeStudioId: string;
  activeShowId: string;
  isPending: boolean;
  /**
   * Switch to `target`. Resolves `true` when the target is active afterwards (already active
   * included), `false` when the guard declined, a switch was already in flight, or the write
   * failed (the failure is toasted).
   */
  switchActive: (target: SwitchTarget) => Promise<boolean>;
}

export function useSwitchActive({ onCloseSession, confirmSwitch }: Options): UseSwitchActiveResult {
  const { data: profile } = useProfile();
  const mutation = useProfileMutation();
  const queryClient = useQueryClient();
  const activeStudioId = showAccessFrom(profile).activeStudioId;
  const activeShowId = profile?.active_show_id ?? '';
  const { mutateAsync, isPending } = mutation;

  const switchActive = useCallback(
    async ({ studioId, showId }: SwitchTarget): Promise<boolean> => {
      if (!studioId) return false;
      const sameStudio = studioId === activeStudioId;
      if (sameStudio && (showId === undefined || showId === activeShowId)) return true;
      if (isPending) return false;
      const allowed = confirmSwitch?.() ?? true;
      if (allowed !== true && !(await allowed)) return false;
      const body: ProfileUpdateBody =
        showId === undefined
          ? { active_studio_id: studioId }
          : { active_studio_id: studioId, active_show_id: showId };
      try {
        await mutateAsync(body);
      } catch (err) {
        const detail = err instanceof Error ? err.message : 'The change was not saved.';
        showToast(
          `Couldn't switch ${showId === undefined ? 'the team' : 'the show'}: ${detail}`,
          true,
        );
        return false;
      }
      if (!sameStudio) onCloseSession();
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      queryClient.invalidateQueries({ queryKey: ['events'] });
      queryClient.invalidateQueries({ queryKey: sessionStatusKeys.all() });
      queryClient.invalidateQueries({ queryKey: ['show-categories'] });
      return true;
    },
    [
      activeStudioId,
      activeShowId,
      isPending,
      confirmSwitch,
      mutateAsync,
      onCloseSession,
      queryClient,
    ],
  );

  return { activeStudioId, activeShowId, isPending, switchActive };
}
