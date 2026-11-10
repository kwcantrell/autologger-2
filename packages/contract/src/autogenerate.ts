// Batch autogenerate (OpenSpec change `batch-autogenerate`, design D1, D9, D14; api-contract-freeze
// "Batch autogenerate job object", "Batch autogenerate endpoints"): the scope and start bodies, the
// fixed outcome codes with their item status and fixed detail, the stop reasons, the step order,
// and the strict response bodies. Outcomes and stop reasons are also check-constrained in
// `catalog.autogenerate_items` / `catalog.autogenerate_jobs` (migration 20261025000000); the detail
// text lives only here, looked up from the code, so no row or response carries provider text.

import { z } from 'zod';

/** The steps, in run order (owner decision 3). */
export const AUTOGENERATE_STEPS = ['transcript', 'events', 'topics', 'wiki'] as const;
export type AutogenerateStep = (typeof AUTOGENERATE_STEPS)[number];
export const autogenerateStepSchema = z.enum(AUTOGENERATE_STEPS);

/** A step's position in the run order, 0..3. */
export function autogenerateStepOrder(step: AutogenerateStep): number {
  return AUTOGENERATE_STEPS.indexOf(step);
}

/** The steps that call the language model (the LLM failure count, design D17). */
export const AUTOGENERATE_LLM_STEPS: readonly AutogenerateStep[] = ['events', 'topics', 'wiki'];

export const AUTOGENERATE_WIKI_MODES = ['accept', 'pending'] as const;
export type AutogenerateWikiMode = (typeof AUTOGENERATE_WIKI_MODES)[number];

export const AUTOGENERATE_JOB_STATUSES = [
  'queued',
  'running',
  'finished',
  'cancelled',
  'failed',
] as const;
export type AutogenerateJobStatus = (typeof AUTOGENERATE_JOB_STATUSES)[number];

export const AUTOGENERATE_ITEM_STATUSES = [
  'pending',
  'running',
  'done',
  'skipped',
  'failed',
  'cancelled',
] as const;
export type AutogenerateItemStatus = (typeof AUTOGENERATE_ITEM_STATUSES)[number];

export const AUTOGENERATE_STOP_REASONS = [
  'cancelled',
  'initiator-unavailable',
  'initiator-role-lost',
  'not-approved',
  'unconfigured-stt',
  'unconfigured-llm',
  'provider-failing',
] as const;
export type AutogenerateStopReason = (typeof AUTOGENERATE_STOP_REASONS)[number];

/** Every item outcome, its one item status and its fixed detail (the contract table). */
export const AUTOGENERATE_OUTCOMES = {
  present: { status: 'skipped', detail: 'Already had output; left unchanged.' },
  'no-audio': { status: 'skipped', detail: 'The session has no audio to transcribe.' },
  'no-speech': { status: 'skipped', detail: 'No speech was found in the audio.' },
  'no-transcript': { status: 'skipped', detail: 'The session has no transcript words.' },
  'no-anchors': {
    status: 'skipped',
    detail: 'The transcript has no timecodes to place events on.',
  },
  'no-instructions': {
    status: 'skipped',
    detail: 'No event button on this show has a generation instruction.',
  },
  busy: { status: 'skipped', detail: 'The session stayed busy for 10 minutes.' },
  'access-lost': { status: 'skipped', detail: 'The initiator can no longer access this session.' },
  'session-gone': { status: 'skipped', detail: 'The session no longer exists.' },
  'earlier-step-failed': { status: 'skipped', detail: 'Skipped because an earlier step failed.' },
  unconfigured: { status: 'failed', detail: 'No provider is configured for this step.' },
  'provider-failed': { status: 'failed', detail: 'The provider request failed.' },
  'rate-limited': { status: 'failed', detail: 'The provider kept refusing with a rate limit.' },
  'too-large': { status: 'failed', detail: "The audio is over the provider's size limit." },
  'missing-audio-file': { status: 'failed', detail: 'An audio file of the session is missing.' },
  unreadable: { status: 'failed', detail: 'The audio could not be read.' },
  'generation-failed': { status: 'failed', detail: 'Generation failed.' },
  interrupted: { status: 'failed', detail: 'Interrupted three times; not retried.' },
  cancelled: { status: 'cancelled', detail: 'Cancelled before it started.' },
  'job-stopped': { status: 'cancelled', detail: 'The job stopped before this step.' },
} as const satisfies Record<
  string,
  { status: Exclude<AutogenerateItemStatus, 'pending' | 'running' | 'done'>; detail: string }
>;
export type AutogenerateOutcome = keyof typeof AUTOGENERATE_OUTCOMES;
export const AUTOGENERATE_OUTCOME_CODES = Object.keys(AUTOGENERATE_OUTCOMES) as [
  AutogenerateOutcome,
  ...AutogenerateOutcome[],
];

/** The fixed detail of an outcome, or null for none. */
export function autogenerateOutcomeDetail(outcome: string | null): string | null {
  if (outcome === null) return null;
  return (AUTOGENERATE_OUTCOMES as Record<string, { detail: string }>)[outcome]?.detail ?? null;
}

/** The most sessions one job may process, and the most show ids a scope may name. */
export const AUTOGENERATE_MAX_SESSIONS = 1000;
export const AUTOGENERATE_MAX_SHOW_IDS = 200;

const idSchema = z.string().min(1).max(200);

const scopeShape = {
  show_ids: z.array(idSchema).min(1).max(AUTOGENERATE_MAX_SHOW_IDS).optional(),
  session_ids: z.array(idSchema).min(1).max(AUTOGENERATE_MAX_SESSIONS).optional(),
  steps: z
    .array(autogenerateStepSchema)
    .min(1)
    .refine((s) => new Set(s).size === s.length, { message: 'steps must not repeat' }),
  wiki_mode: z.enum(AUTOGENERATE_WIKI_MODES).default('accept'),
};

function exactlyOneScope(
  body: { show_ids?: string[]; session_ids?: string[] },
  ctx: z.RefinementCtx,
): void {
  const n = (body.show_ids ? 1 : 0) + (body.session_ids ? 1 : 0);
  if (n !== 1) {
    ctx.addIssue({
      code: 'custom',
      path: [],
      message: 'Give exactly one of show_ids and session_ids.',
    });
  }
}

/** The preview body (and the scope part of the start body). */
export const autogenerateScopeBodySchema = z.object(scopeShape).superRefine(exactlyOneScope);
export type AutogenerateScopeBody = z.infer<typeof autogenerateScopeBodySchema>;

/** The start body: the scope plus the session count the client confirmed. */
export const autogenerateStartBodySchema = z
  .object({ ...scopeShape, expected_sessions: z.number().int().nonnegative() })
  .superRefine(exactlyOneScope);
export type AutogenerateStartBody = z.infer<typeof autogenerateStartBodySchema>;

const countsSchema = z.strictObject({
  pending: z.number(),
  running: z.number(),
  done: z.number(),
  skipped: z.number(),
  failed: z.number(),
  cancelled: z.number(),
});

/** The job object (api-contract-freeze "Batch autogenerate job object"). */
export const autogenerateJobSchema = z.strictObject({
  id: z.string(),
  team_id: z.string(),
  status: z.enum(AUTOGENERATE_JOB_STATUSES),
  stop_reason: z.enum(AUTOGENERATE_STOP_REASONS).nullable(),
  scope: z.enum(['shows', 'sessions']),
  show_ids: z.array(z.string()).nullable(),
  steps: z.array(autogenerateStepSchema),
  wiki_mode: z.enum(AUTOGENERATE_WIKI_MODES),
  initiator_id: z.string(),
  initiator_name: z.string(),
  cancel_requested_by_name: z.string().nullable(),
  cancel_requested_at_utc: z.string().nullable(),
  created_at_utc: z.string(),
  started_at_utc: z.string().nullable(),
  finished_at_utc: z.string().nullable(),
  sessions: z.number(),
  counts: countsSchema,
  current: z.strictObject({ session_id: z.string(), step: z.string() }).nullable(),
});
export type AutogenerateJobWire = z.infer<typeof autogenerateJobSchema>;

export const autogenerateJobResponseSchema = z.strictObject({ job: autogenerateJobSchema });
export type AutogenerateJobResponse = z.infer<typeof autogenerateJobResponseSchema>;

export const autogenerateJobListResponseSchema = z.strictObject({
  jobs: z.array(autogenerateJobSchema),
});
export type AutogenerateJobListResponse = z.infer<typeof autogenerateJobListResponseSchema>;

export const autogenerateItemSchema = z.strictObject({
  step: autogenerateStepSchema,
  status: z.enum(AUTOGENERATE_ITEM_STATUSES),
  outcome: z.enum(AUTOGENERATE_OUTCOME_CODES).nullable(),
  detail: z.string().nullable(),
  wiki_accepted: z.number().nullable(),
  wiki_pending: z.number().nullable(),
  kept_edited: z.number().nullable(),
});
export type AutogenerateItemWire = z.infer<typeof autogenerateItemSchema>;

export const autogenerateDetailResponseSchema = z.strictObject({
  job: autogenerateJobSchema,
  sessions: z.array(
    z.strictObject({
      session_id: z.string(),
      title: z.string(),
      show_id: z.string(),
      effective_date: z.string().nullable(),
      ordinal: z.number(),
      steps: z.array(autogenerateItemSchema),
    }),
  ),
});
export type AutogenerateDetailResponse = z.infer<typeof autogenerateDetailResponseSchema>;

export const AUTOGENERATE_BLOCKED = [
  'unconfigured-stt',
  'unconfigured-llm',
  'not-approved',
] as const;
export type AutogenerateBlocked = (typeof AUTOGENERATE_BLOCKED)[number];

export const autogeneratePreviewResponseSchema = z.strictObject({
  sessions: z.number(),
  steps: z.array(autogenerateStepSchema),
  runs: z.partialRecord(autogenerateStepSchema, z.number()),
  max_runs: z.number(),
  blocked: z.enum(AUTOGENERATE_BLOCKED).nullable(),
});
export type AutogeneratePreviewResponse = z.infer<typeof autogeneratePreviewResponseSchema>;

/** The start route's two typed 409 bodies and the cancel route's. */
export const autogenerateLiveJobConflictSchema = z.strictObject({
  detail: z.literal('A batch job is already running for this team.'),
  job_id: z.string(),
});
export const autogenerateSessionsChangedSchema = z.strictObject({
  detail: z.literal('The sessions changed since the estimate.'),
  sessions: z.number(),
});
export const autogenerateCancelEndedSchema = z.strictObject({
  detail: z.literal('Job already ended.'),
  status: z.enum(AUTOGENERATE_JOB_STATUSES),
});

/** The fixed details of the routes' own refusals. */
export const AUTOGENERATE_DETAIL = {
  showNotFound: 'Show not found.',
  sessionNotFound: 'Session not found',
  noSessions: 'No sessions to process.',
  tooMany: 'A batch job can process at most 1000 sessions.',
  liveJob: 'A batch job is already running for this team.',
  sessionsChanged: 'The sessions changed since the estimate.',
  jobNotFound: 'Job not found.',
  jobEnded: 'Job already ended.',
  sttUnconfigured: 'Add a speech-to-text key in Settings → Advanced to generate transcripts.',
  llmUnconfigured: 'Add a language model in Settings → Advanced to autogenerate.',
} as const;
