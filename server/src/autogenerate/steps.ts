// The batch worker's step operations over the shared runners (OpenSpec change `batch-autogenerate`,
// design D6, D7, D9, D12): the cleanup of recorded partial output, the gap checks, each runner with
// the batch's write-ahead hooks and its outcome classified per D9, and the safe wiki auto-accept.
// Every call runs as the principal (the initiator).

import { type AutogenerateStep, isSafeSuggestion } from '@autologger/contract';
import { deleteOwnEvents, eventsPresent, runEvents } from '../generation/events';
import { type GenerationPrincipal, hubFor } from '../generation/principal';
import { deleteOwnTopics, runTopics, topicsPresent } from '../generation/topics';
import { runTranscript, type TranscriptOutcome } from '../generation/transcript';
import { runWiki } from '../generation/wiki';
import type { StepHooks, StepOps, StepResult } from './worker';

/** D9: a transcript runner outcome in the worker's terms. */
export function transcriptResult(out: TranscriptOutcome): StepResult {
  switch (out.kind) {
    case 'ok':
      return { kind: 'done' };
    case 'present':
      return { kind: 'present' };
    case 'unconfigured':
    case 'forbidden':
    case 'busy':
      return { kind: out.kind };
    case 'error':
      switch (out.code) {
        case 'no_audio':
          return { kind: 'skip', outcome: 'no-audio' };
        case 'no_speech':
          return { kind: 'skip', outcome: 'no-speech' };
        case 'upstream':
          return { kind: 'fail', outcome: 'provider-failed' };
        case 'rate-limited':
          return { kind: 'rate-limited' };
        case 'oversize':
          return { kind: 'fail', outcome: 'too-large' };
        case 'missing_blob':
          return { kind: 'fail', outcome: 'missing-audio-file' };
        case 'unreadable':
          return { kind: 'fail', outcome: 'unreadable' };
      }
  }
}

/** The AI steps' shared endings (D9: any turn failure is `generation-failed`, a 429 on the AI SDK
 * route `rate-limited`). */
function aiResult(
  out:
    | { kind: 'unconfigured' | 'forbidden' | 'busy' | 'present' | 'stopped' }
    | { kind: 'failed'; rateLimited: boolean; keptEdited?: number }
    | { kind: 'ok'; keptEdited?: number },
): StepResult {
  switch (out.kind) {
    case 'ok':
      return { kind: 'done', keptEdited: out.keptEdited ?? 0 };
    case 'failed':
      return out.rateLimited
        ? { kind: 'rate-limited', keptEdited: out.keptEdited ?? 0 }
        : { kind: 'fail', outcome: 'generation-failed', keptEdited: out.keptEdited ?? 0 };
    default:
      return { kind: out.kind };
  }
}

async function sessionRow(p: GenerationPrincipal, sessionId: string) {
  return p.catalog.sessions.getSessionIndexRow(sessionId);
}

export function workerSteps(): StepOps {
  return {
    async cleanup(p, sessionId, step, ids) {
      if (step === 'events') return (await deleteOwnEvents(p, sessionId, ids.runIds)).keptEdited;
      if (step === 'topics') return (await deleteOwnTopics(p, sessionId, ids.topicIds)).keptEdited;
      return 0;
    },

    async present(p, sessionId, step, recorded) {
      switch (step) {
        case 'transcript':
          return (await (await hubFor(p, sessionId)).listTranscriptWords()).length > 0;
        case 'events':
          return eventsPresent(p, sessionId, recorded.runIds);
        case 'topics':
          return topicsPresent(p, sessionId, recorded.topicIds);
        case 'wiki':
          return false;
      }
    },

    async run(p, sessionId, step: AutogenerateStep, hooks: StepHooks): Promise<StepResult> {
      const row = await sessionRow(p, sessionId);
      // The ladder checked the session just before; one that vanished since fails the step.
      if (row === null) return { kind: 'fail', outcome: 'generation-failed' };
      switch (step) {
        case 'transcript':
          return transcriptResult(await runTranscript(p, sessionId, { row, onlyIfEmpty: true }));
        case 'events': {
          const out = await runEvents(p, sessionId, {
            row,
            batch: { earlierRunIds: hooks.earlierRunIds, beforeRun: (id) => hooks.beforeRun(id) },
          });
          if (out.kind === 'precondition') {
            // `too-many-instructions` (the aggregate instruction bound) has no outcome code of its
            // own; it is the show's instructions that keep the step from running.
            return {
              kind: 'skip',
              outcome: out.code === 'too-many-instructions' ? 'no-instructions' : out.code,
            };
          }
          return aiResult(out);
        }
        case 'topics': {
          const out = await runTopics(p, sessionId, {
            batch: {
              beforeRun: () => hooks.beforeRun(null),
              recordTopicId: (id) => hooks.recordTopicId(id),
            },
          });
          if (out.kind === 'precondition') return { kind: 'skip', outcome: 'no-transcript' };
          return aiResult(out);
        }
        case 'wiki': {
          const out = await runWiki(p, sessionId, {
            row,
            runId: crypto.randomUUID(),
            batch: {
              beforeRun: async (id) => ((await hooks.beforeRun(id)) === 'go' ? 'go' : 'stop'),
            },
          });
          if (out.kind === 'precondition') return { kind: 'skip', outcome: 'no-transcript' };
          return aiResult(out);
        }
      }
    },

    async wikiStored(p, sessionId, runId) {
      return p.catalog.wiki.anyOfRun(sessionId, runId);
    },

    async acceptWiki(p, sessionId, runId, jobId, mode) {
      const ids = await p.catalog.wiki.pendingOfRun(sessionId, runId);
      if (mode === 'pending') return { accepted: 0, pending: ids.length };
      let accepted = 0;
      let pending = 0;
      for (const id of ids) {
        // D12: in proposal order, each as its own transaction; anything unsafe, stale or refused
        // stays pending for a person. Nothing is dismissed.
        try {
          const s = await p.catalog.wiki.getSuggestion(id);
          if (s === null || s.status !== 'pending') {
            pending += 1;
            continue;
          }
          const page = s.page_id === null ? null : await p.catalog.wiki.getPage(s.page_id);
          if (s.page_id !== null && (page === null || page.revision !== s.base_revision)) {
            pending += 1;
            continue;
          }
          const safe = isSafeSuggestion(
            page === null
              ? null
              : { title: page.title, aliases: page.aliases, body_md: page.body_md },
            { page_id: s.page_id, title: s.title, aliases: s.aliases, body_md: s.body_md },
          );
          if (!safe) {
            pending += 1;
            continue;
          }
          await p.catalog.wiki.acceptSuggestion(
            id,
            s.base_revision === null ? {} : { expectedRevision: s.base_revision },
            { batchJobId: jobId },
          );
          accepted += 1;
        } catch {
          pending += 1;
        }
      }
      return { accepted, pending };
    },
  };
}
