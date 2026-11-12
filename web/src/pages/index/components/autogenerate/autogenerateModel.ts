import { useEffect, useState } from 'react';
import type {
  AutogenerateBlocked,
  AutogenerateStep,
  AutogenerateWikiMode,
  ProvidersResponse,
} from '../../../../api/types';

// --- Batch autogenerate options model (playlist-import-autogenerate design D8) ---
//
// The step list, labels, wiki mode labels and blocked texts shared by Settings → Batch
// autogenerate and the Batch Import modal's "Autogenerate after import" group, so both say the
// same thing (web-ui-system "Settings runs batch autogenerate for owners and admins").

/** The four steps in run order, with Settings' labels. */
export const AUTOGENERATE_STEPS: readonly { id: AutogenerateStep; label: string }[] = [
  { id: 'transcript', label: 'Transcripts' },
  { id: 'events', label: 'Log events' },
  { id: 'topics', label: 'Topics' },
  { id: 'wiki', label: 'Wiki' },
];

export const stepLabel = (id: string) => AUTOGENERATE_STEPS.find((s) => s.id === id)?.label ?? id;

/** All four steps ticked: the default of both places. */
export const defaultAutogenerateSteps = () =>
  new Set<AutogenerateStep>(AUTOGENERATE_STEPS.map((s) => s.id));

/** A step set in run order (the body's `steps`). */
export const orderedSteps = (steps: ReadonlySet<AutogenerateStep>): AutogenerateStep[] =>
  AUTOGENERATE_STEPS.filter((s) => steps.has(s.id)).map((s) => s.id);

export const WIKI_MODE_LABEL: Record<AutogenerateWikiMode, string> = {
  accept: 'Add new pages and additions to the wiki',
  pending: 'Leave all as suggestions to review',
};

export const BLOCKED_TEXT: Record<AutogenerateBlocked, string> = {
  'unconfigured-stt': 'Add a speech-to-text key in Settings → Advanced to generate transcripts.',
  'unconfigured-llm': 'Add a language model in Settings → Advanced to autogenerate.',
  'not-approved':
    'Batch autogenerate is limited to approved users on this server. Ask the operator for approval.',
};

/** The job's bound: every step on every session (Settings' `max_runs = sessions × steps`). */
export const maxRuns = (sessions: number, steps: Iterable<AutogenerateStep>) =>
  sessions * [...steps].length;

const LLM_STEPS: readonly AutogenerateStep[] = ['events', 'topics', 'wiki'];

/**
 * The start route's blocked reason guessed from the user's provider status (design D6), in the
 * server's order: speech-to-text, then the language model, then approval. A guess: it cannot see
 * an undecryptable saved key or the dev-only Deepgram fallback, so callers show it only as a
 * warning, never as a block.
 */
export function blockedFromProviders(
  steps: Iterable<AutogenerateStep>,
  providers: ProvidersResponse,
): AutogenerateBlocked | null {
  const list = [...steps];
  if (list.includes('transcript') && providers.stt === null) return 'unconfigured-stt';
  if (list.some((s) => LLM_STEPS.includes(s))) {
    const llm = providers.llm;
    const usable =
      llm !== null && (llm.provider !== 'claude-cli' || providers.claude_cli_allowed === true);
    if (!usable) return 'unconfigured-llm';
  }
  if (!providers.run_features_allowed) return 'not-approved';
  return null;
}

/** `value`, delayed by `ms`; only the last change within the window lands. */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
