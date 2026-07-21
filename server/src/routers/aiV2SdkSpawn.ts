// ai-v2-dashboards (design D7/D8, task 0.9) — the ONE call site that reaches
// the Agent SDK's `query()`, and therefore the one place a design turn can
// spawn a subprocess. This module exists so the spec's "Design turn
// contract" requirement — "No guard path SHALL spawn a subprocess" — is
// TESTABLE against the SDK transport, which the CLI transport's
// `fake-claude` argv-recording fixture (ai-topics-chat) does not reach (see
// tasks.md's "Test-infra note").
//
// Task 2.5 (turn runner + SSE relay) and 2.6 (lifecycle: timeout backstop,
// orphan-safe kill ladder per task 0.5's spike) OWN the real implementation
// and will extend `attemptDesignTurnSpawn` in place — build guard
// evaluation, streaming/relay, and lifecycle around this call, not a
// competing one. This file's job stops at: accept an already-resolved
// `Options` object (2.3 owns building the closed-world lockdown set) and
// call the SDK exactly once.
//
// THE CONTRACT CALLERS MUST HONOR: call `attemptDesignTurnSpawn` only after
// every guard in the design endpoint's order (spec: authentication → session
// resolution/scoping `404` → configuration/open-network `503` → body
// validation `422`/`400` → turn slot `409`) has already passed. A
// guard-rejected request must return BEFORE this function is ever called —
// that is what makes "no guard path spawns" observable: nothing upstream of
// this module touches the SDK, so a no-spawn test only has to prove this
// function was never invoked (see `aiV2SdkSpawn.test.ts`'s recorder-fixture
// seam), never introspect what the SDK itself decided to do.
//
// `query()` spawns the child SYNCHRONOUSLY as part of construction —
// confirmed by reading the pinned SDK's bundled transport (`sdk.mjs`):
// `initialize()` (which builds argv and calls `child_process.spawn`, or the
// `spawnClaudeCodeProcess` override when one is supplied) runs directly in
// the transport's constructor unless `deferSpawn` is set, which only the
// SDK's own `resume`-with-`sessionStore` path passes — this design's fresh,
// non-resumed turns never take that path. So by the time `query()` returns,
// the spawn attempt has already happened, whether or not any message is
// ever read from the returned `Query`.

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';

/**
 * Start a design turn against the Agent SDK. This is the spawn boundary:
 * calling it is calling `query()`, which spawns the child synchronously
 * (see module docstring). Deliberately does not drain or await the turn —
 * 2.5 owns SSE relay and message handling; 2.6 owns lifecycle/timeout. A
 * caller that only cares about the spawn/no-spawn boundary (this module's
 * own tests) may drop the returned `Query` without ever reading from it.
 */
export function attemptDesignTurnSpawn(prompt: string, options: Options): Query {
  return query({ prompt, options });
}
