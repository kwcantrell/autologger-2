import { useState } from 'react';
import { ApiError } from '../../../api/client';
import { useCreateTeam } from '../../../api/hooks/useTeams';

// --- CreateTeamForm (teams-self-serve, task 6.1) ---
//
// Lives in its own module rather than inside `TeamsRoute.tsx` for a bundling
// reason (bundle route-splitting, plan C5.3): it has two consumers — the
// `/teams` page and `OnboardingPanel` — and `OnboardingPanel` is part of the
// eagerly-loaded homepage graph (AppShell early-returns to it for a logged-in
// user with zero teams). While this component lived in `TeamsRoute.tsx`, that
// one import pinned the ENTIRE teams page — `TeamCard` and the whole
// `useTeams` detail/invite/role mutation surface — into the initial download,
// silently cancelling TeamsRoute's `React.lazy` edge (its lazy chunk built out
// to zero files). Splitting the shared leaf into its own module is what makes
// that edge actually cut. Keep it dependency-light for the same reason.

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : fallback;
}

/** Create-team form (task 6.1's `useCreateTeam` mutation). Reused verbatim by
 * the zero-membership onboarding panel (task 6.3, design D8). */
export function CreateTeamForm({ onCreated }: { onCreated?: () => void }) {
  const [slug, setSlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useCreateTeam();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    create.mutate(
      { id: slug.trim(), display_name: displayName.trim() },
      {
        onSuccess: () => {
          setSlug('');
          setDisplayName('');
          onCreated?.();
        },
        onError: (err) => setError(errorMessage(err, 'Could not create team.')),
      },
    );
  }

  return (
    <form
      className="glass-panel rounded-v5-lg px-4 py-4"
      data-testid="team-create-form"
      onSubmit={handleSubmit}
    >
      {error && (
        <p role="alert" className="modal-hint text-[#ff8a8a]">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <label className="field">
          <span>Team id (slug)</span>
          <input
            type="text"
            id="team-create-slug"
            className="profile-select"
            placeholder="my-crew"
            maxLength={63}
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Display name</span>
          <input
            type="text"
            id="team-create-name"
            className="profile-select"
            placeholder="My Crew"
            maxLength={200}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </label>
        <button
          type="submit"
          className="btn primary"
          disabled={create.isPending || slug.trim() === '' || displayName.trim() === ''}
        >
          {create.isPending ? 'Creating…' : 'Create team'}
        </button>
      </div>
      <p className="modal-hint mt-2">
        Lowercase, starts with a letter, letters/digits/hyphens only, 2–63 characters. The id
        can&apos;t be changed later.
      </p>
    </form>
  );
}
