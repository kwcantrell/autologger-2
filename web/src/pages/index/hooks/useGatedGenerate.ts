import { useState } from 'react';
import { ApiError } from '../../../api/client';

/** The slice of a React Query mutation the latch drives — structurally
 * compatible with `useGenerateTranscript(...)`/`useGenerateTopics(...)`'s
 * `mutate` (void-variables mutations). */
type GenerateMutate<TVariables> = (
  variables: TVariables,
  options: { onError: (err: Error) => void },
) => void;

/**
 * Shared generate-503-latch state machine for the Transcribe and Topics feeds
 * (code-health-tail task 4.4, consolidating finding 2.5's near-verbatim copies).
 *
 * The latch is a DELIBERATE pattern (ui-refresh D9: honest capability gate) —
 * the server has no capability endpoint, so unavailability is learned on the
 * first 503 and then stated plainly instead of inviting repeat failures:
 *
 * - a 503 from generate sets `genUnavailable` — latched for the component's
 *   lifetime. The feed panels are mounted-hidden and unkeyed, so the latch
 *   persists across session switches and is cleared only by a full page
 *   reload, which is deliberate — the latched copy tells the operator to
 *   reload after configuring.
 * - any other error sets `genError` (single error channel: inline in the
 *   panel only, no duplicate toast) and does NOT latch — a retry re-calls
 *   the endpoint.
 */
export function useGatedGenerate<TVariables = undefined>(mutate: GenerateMutate<TVariables>) {
  const [genError, setGenError] = useState<string | null>(null);
  const [genUnavailable, setGenUnavailable] = useState(false);

  function handleGenerate(variables?: TVariables) {
    setGenError(null);
    mutate(variables as TVariables, {
      onError: (err) => {
        if (err instanceof ApiError && err.status === 503) {
          setGenUnavailable(true);
          return;
        }
        setGenError(err instanceof Error ? err.message : 'Generation failed.');
      },
    });
  }

  return { genError, genUnavailable, handleGenerate };
}
