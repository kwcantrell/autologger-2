import { ApiError } from '../../../api/client';
import {
  previewAutogenerateJob,
  startAutogenerateJob,
} from '../../../api/hooks/useAutogenerateJobs';
import type {
  AutogenerateLiveJobConflict,
  AutogenerateScopeBody,
  AutogenerateStep,
  AutogenerateWikiMode,
  ProfilePayload,
} from '../../../api/types';
import { BLOCKED_TEXT, orderedSteps } from '../components/autogenerate/autogenerateModel';
import { isAbortError } from './runner';

// playlist-import-autogenerate design D4, D5, D12 (batch-audio-import "YouTube playlist import can
// autogenerate afterwards", "End-of-run start" and "One re-scope on 404"): after the last part of
// a confirmed Start Import, preview the exact sessions the playlist part brought in and start one
// batch job over them, with the preview's count as `expected_sessions`. Every outcome is one
// progress line (two with the re-scope line); nothing is retried, and an abort sends nothing more.

const SETTINGS_POINTER = 'Start it in Settings → Batch autogenerate.';

export const AUTOGENERATE_NO_VIDEO_LINE =
  'Autogenerate not started: no video was imported by this import.';
export const AUTOGENERATE_OTHER_USER_LINE =
  'Autogenerate not started: you are signed in as a different user than the one who confirmed.';
export const AUTOGENERATE_FAILED_LINE = `Autogenerate not started: the request failed. ${SETTINGS_POINTER}`;
export const AUTOGENERATE_LIVE_JOB_LINE =
  'Autogenerate not started: a batch job is already running for this team. Start one for this show in Settings → Batch autogenerate when it ends.';
export const AUTOGENERATE_MAY_HAVE_STARTED_LINE =
  'Autogenerate may have started; check Settings → Batch autogenerate before starting it again.';
const STARTED_PREFIX = 'Autogenerate started for ';

export const formatAutogenerateStartedLine = (sessions: number, maxRuns: number) =>
  `${STARTED_PREFIX}${sessions} sessions (at most ${maxRuns} runs); follow it in Settings → Batch autogenerate.`;
const detailLine = (detail: string) => `Autogenerate not started: ${detail} ${SETTINGS_POINTER}`;
const leftOutLine = (k: number) =>
  `Autogenerate: left out ${k} imported session(s) that no longer exist.`;

/** Whether the lines end in a start that was sent and may have created a job (design D5: the
 * modal then refreshes Settings' job list). */
export const autogenerateMayHaveStarted = (lines: readonly string[]) => {
  const last = lines.at(-1) ?? '';
  return last.startsWith(STARTED_PREFIX) || last === AUTOGENERATE_MAY_HAVE_STARTED_LINE;
};

export interface StartAutogenerateAfterImportOptions {
  teamId: string;
  /** The qualifying sessions, in the order the playlist part reported them. */
  sessionIds: readonly string[];
  steps: readonly AutogenerateStep[];
  wikiMode: AutogenerateWikiMode;
  /** `auth.user.id` recorded when the user confirmed (design D12). */
  confirmedUserId: string;
  /** `GET /api/profile`. */
  readProfile: (signal: AbortSignal) => Promise<ProfilePayload>;
  /** The run's show's current session ids (the runner's fresh read, re-aligning the active show). */
  listShowSessionIds: (signal: AbortSignal) => Promise<string[]>;
  signal: AbortSignal;
}

const stringDetail = (err: ApiError): string | null => {
  const detail = (err.body as { detail?: unknown } | undefined)?.detail;
  return typeof detail === 'string' ? detail : null;
};

const isSessionNotFound = (err: unknown) =>
  err instanceof ApiError && err.status === 404 && stringDetail(err) === 'Session not found';

/** The start route's `503` "unconfigured" refusal carries its own instruction as a string
 * `detail` (api-contract-freeze "Batch autogenerate endpoints"); it is answered before anything
 * is written, unlike other server errors. */
const isUnconfigured = (err: unknown): err is ApiError =>
  err instanceof ApiError && err.status === 503 && stringDetail(err) !== null;

/** A refusal with a JSON body below 500: the request wrote nothing and its answer is certain. */
function refusalLine(err: unknown): string {
  if (isUnconfigured(err)) return detailLine(stringDetail(err) as string);
  if (!(err instanceof ApiError) || err.body === undefined || err.status >= 500) {
    return AUTOGENERATE_FAILED_LINE;
  }
  const detail = err.status === 422 ? null : stringDetail(err);
  return detail === null ? AUTOGENERATE_FAILED_LINE : detailLine(detail);
}

type Attempt = { kind: 'line'; line: string } | { kind: 'not-found' } | { kind: 'aborted' };

/**
 * Preview and start the end-of-run job. Resolves its progress lines: `[]` only on abort.
 * Never rejects.
 */
export async function startAutogenerateAfterImport(
  options: StartAutogenerateAfterImportOptions,
): Promise<string[]> {
  const { teamId, wikiMode, confirmedUserId, signal } = options;
  const steps = orderedSteps(new Set(options.steps));
  const lines: string[] = [];
  let ids = [...new Set(options.sessionIds)];

  if (signal.aborted) return [];
  if (ids.length === 0) return [AUTOGENERATE_NO_VIDEO_LINE];

  try {
    const profile = await options.readProfile(signal);
    if (signal.aborted) return [];
    if (profile.auth?.user?.id !== confirmedUserId) return [AUTOGENERATE_OTHER_USER_LINE];
  } catch (err) {
    if (signal.aborted || isAbortError(err)) return [];
    return [AUTOGENERATE_FAILED_LINE];
  }

  const attempt = async (sessionIds: string[]): Promise<Attempt> => {
    const scope: AutogenerateScopeBody = { session_ids: sessionIds, steps, wiki_mode: wikiMode };
    let preview: Awaited<ReturnType<typeof previewAutogenerateJob>>;
    try {
      preview = await previewAutogenerateJob(teamId, scope, signal);
    } catch (err) {
      if (signal.aborted || isAbortError(err)) return { kind: 'aborted' };
      if (isSessionNotFound(err)) return { kind: 'not-found' };
      return { kind: 'line', line: refusalLine(err) };
    }
    if (signal.aborted) return { kind: 'aborted' };
    if (preview.blocked !== null) {
      return { kind: 'line', line: `Autogenerate not started: ${BLOCKED_TEXT[preview.blocked]}` };
    }
    try {
      await startAutogenerateJob(teamId, { ...scope, expected_sessions: preview.sessions }, signal);
    } catch (err) {
      if (signal.aborted || isAbortError(err)) return { kind: 'aborted' };
      if (isSessionNotFound(err)) return { kind: 'not-found' };
      // No answer, or a server error: the transaction may have committed. Never re-sent.
      if (isUnconfigured(err)) return { kind: 'line', line: refusalLine(err) };
      if (!(err instanceof ApiError) || err.body === undefined || err.status >= 500) {
        return { kind: 'line', line: AUTOGENERATE_MAY_HAVE_STARTED_LINE };
      }
      const live = err.body as Partial<AutogenerateLiveJobConflict>;
      if (err.status === 409 && typeof live.job_id === 'string') {
        return { kind: 'line', line: AUTOGENERATE_LIVE_JOB_LINE };
      }
      return { kind: 'line', line: refusalLine(err) };
    }
    return {
      kind: 'line',
      line: formatAutogenerateStartedLine(preview.sessions, preview.max_runs),
    };
  };

  const first = await attempt(ids);
  if (first.kind === 'aborted') return [];
  if (first.kind === 'line') return [first.line];

  // One re-scope (design D4): a refused request wrote nothing, so a smaller set is not a retry.
  try {
    const listed = new Set(await options.listShowSessionIds(signal));
    if (signal.aborted) return [];
    const kept = ids.filter((id) => listed.has(id));
    lines.push(leftOutLine(ids.length - kept.length));
    ids = kept;
  } catch (err) {
    if (signal.aborted || isAbortError(err)) return [];
    return [AUTOGENERATE_FAILED_LINE];
  }
  if (ids.length === 0) return [...lines, AUTOGENERATE_NO_VIDEO_LINE];

  const second = await attempt(ids);
  if (second.kind === 'aborted') return [];
  if (second.kind === 'line') return [...lines, second.line];
  return [...lines, detailLine('Session not found')];
}
