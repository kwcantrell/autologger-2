import { useEffect, useRef } from 'react';
import { useProviders } from '../../../api/hooks/useProviders';
import type { ProviderCredential } from '../../../api/types';

function signature(llm: ProviderCredential | null): string | null {
  return llm === null ? null : `${llm.provider}|${llm.updated_at}`;
}

/**
 * Clears a "no language model" latch once the user saves one (ai-sdk-agent-harness D8;
 * web-session-console "Honest capability gating on generation features", ai-topics-chat "AI tab
 * and subtab arrangement"). The chat's not-configured state and the topics and events generate
 * latches use it.
 *
 * While `latched`, it subscribes to the `['providers']` query, as the Transcribe feed does for
 * speech to text; Settings › Advanced invalidates that query on every save. The language model it
 * first sees while latched is the baseline, and `clear` runs only when a saved language model
 * differs from it. So a latch taken while a model is already saved (one the server still refuses,
 * such as a Claude CLI choice after the account left the allowlist) waits for a new save instead of
 * clearing itself at once.
 */
export function useClearOnLanguageModelSave(latched: boolean, clear: () => void) {
  const providers = useProviders({ enabled: latched });
  const current = providers.data ? signature(providers.data.llm) : undefined;
  const baseline = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (!latched) {
      baseline.current = undefined;
      return;
    }
    if (current === undefined) return;
    if (baseline.current === undefined) {
      baseline.current = current;
      return;
    }
    if (current !== null && current !== baseline.current) clear();
  }, [latched, current, clear]);
}

/** The hook as a component, for a surface that should not subscribe at all until latched: render
 * it only while latched (AiChat renders it inside its not-configured state). */
export function ClearOnLanguageModelSave({ onSave }: { onSave: () => void }) {
  useClearOnLanguageModelSave(true, onSave);
  return null;
}
