// The batch autogenerate worker (OpenSpec change `batch-autogenerate`, design D3-D5, D7-D11, D17;
// ADR 0033). Every API process runs one loop: it polls every 15 s, claims at most one due job under
// a 60 s lease renewed every 10 s, and processes the job one session at a time in its order, one
// step at a time. Every job and item write is fenced on the lease (the store reports 0 rows for a
// worker that lost it, and this worker then writes nothing more). No database wake-up: polling only.
//
// Before each session the per-session ladder (D5) runs: the cancel (0), the initiator's account
// (1), role (2) and approval (3), then the session as the initiator (4). Each step then cleans up
// the recorded partial output of its session and step (D7), checks the gap (5), and runs its
// runner (6-10) as the initiator, retrying a busy session every 15 s for 10 minutes (D8) and a
// rate limit after 30, 60, 120, 240 and 480 s (D17). Every ending that is not `done`, and every
// abandoned session with recorded output, cleans up first (D7 "Every ending cleans up").
//
// The orchestration below talks to its collaborators through `WorkerPorts`, so the unit test
// drives it with a fake clock, fake runners and a fake store; `createWorkerPorts` (ports.ts) wires
// the real ones.

import type {
  AutogenerateItemRow,
  AutogenerateJobRow,
  AutogenerateStoreFacade,
} from '@autologger/catalog';
import {
  AUTOGENERATE_LLM_STEPS,
  type AutogenerateOutcome,
  type AutogenerateStep,
} from '@autologger/contract';
import type { GenerationPrincipal } from '../generation/principal';

export const WORKER_POLL_MS = 15_000;
export const WORKER_LEASE_MS = 60_000;
export const WORKER_RENEW_MS = 10_000;
export const BUSY_RETRY_MS = 15_000;
export const BUSY_WINDOW_MS = 10 * 60_000;
export const RATE_LIMIT_WAITS_MS = [30_000, 60_000, 120_000, 240_000, 480_000] as const;
export const PROVIDER_FAILURE_STOP = 3;
/** The fourth entry of an interrupted item ends it `failed` `interrupted` (design D11). */
export const MAX_ATTEMPTS = 3;

/** What a step's runner reported, in the worker's terms (design D9). */
export type StepResult =
  | { kind: 'done'; keptEdited?: number; wikiAccepted?: number; wikiPending?: number }
  | { kind: 'present'; keptEdited?: number }
  | {
      kind: 'skip';
      outcome: 'no-audio' | 'no-speech' | 'no-transcript' | 'no-anchors' | 'no-instructions';
    }
  | {
      kind: 'fail';
      outcome:
        | 'provider-failed'
        | 'too-large'
        | 'missing-audio-file'
        | 'unreadable'
        | 'generation-failed';
      keptEdited?: number;
    }
  | { kind: 'rate-limited'; keptEdited?: number }
  | { kind: 'busy' }
  | { kind: 'unconfigured' }
  | { kind: 'forbidden' }
  /** The run id or a topic id could not be recorded: the lease is lost. */
  | { kind: 'stopped' };

/** The write-ahead hooks a step's runner calls (design D7 "Fenced write-ahead"). */
export interface StepHooks {
  /** The item's own recorded run ids (earlier attempts), for the events exclusion. */
  earlierRunIds: readonly string[];
  /** Under the slot: re-check the gap (D5 step 9) and record `runId` on the item. */
  beforeRun(runId: string | null): Promise<'go' | 'present' | 'stop'>;
  /** Records a topic id on the item; false when the lease is lost. */
  recordTopicId(id: string): Promise<boolean>;
}

export interface StepOps {
  /** Deletes recorded output (version-guarded, as the principal); the rows it kept as edited. */
  cleanup(
    p: GenerationPrincipal,
    sessionId: string,
    step: AutogenerateStep,
    ids: { runIds: readonly string[]; topicIds: readonly string[] },
  ): Promise<number>;
  /** The gap check (D7): whether the step's output is present, ignoring unedited `recorded`. */
  present(
    p: GenerationPrincipal,
    sessionId: string,
    step: AutogenerateStep,
    recorded: { runIds: readonly string[]; topicIds: readonly string[] },
  ): Promise<boolean>;
  run(
    p: GenerationPrincipal,
    sessionId: string,
    step: AutogenerateStep,
    hooks: StepHooks,
  ): Promise<StepResult>;
  /** Whether a wiki run already stored its suggestions (a resumed wiki step makes no second run). */
  wikiStored(p: GenerationPrincipal, sessionId: string, runId: string): Promise<boolean>;
  /** The safe auto-accept of one run's suggestions (D12) in `accept` mode; in `pending` mode
   * nothing is accepted. Returns the accepted and the left-pending counts. */
  acceptWiki(
    p: GenerationPrincipal,
    sessionId: string,
    runId: string,
    jobId: string,
    mode: 'accept' | 'pending',
  ): Promise<{ accepted: number; pending: number }>;
}

export interface SessionGates {
  /** D5 step 2: the initiator is an owner or admin of the team (as the initiator). */
  manages(p: GenerationPrincipal, teamId: string): Promise<boolean>;
  /** D5 step 3: the approved-user rule. */
  approved(p: GenerationPrincipal): boolean;
  /** D5 step 4: the session as the initiator. */
  session(
    p: GenerationPrincipal,
    sessionId: string,
    teamId: string,
  ): Promise<'ok' | 'session-gone' | 'access-lost'>;
  /** D8: a live recording lease makes the session busy. */
  recording(p: GenerationPrincipal, sessionId: string): Promise<boolean>;
}

export interface WorkerPorts {
  workerId: string;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** The store on the worker's system binding (`autogenerate-worker`). */
  store: AutogenerateStoreFacade;
  /** D4: the initiator re-read under the system binding, then bound; null when missing/disabled. */
  principal(userId: string): Promise<GenerationPrincipal | null>;
  /** The initiator's bindings without the account re-read, for a cleanup the job attempts even
   * when the account is gone (D7 "Every ending cleans up"; refusals are tolerated). */
  bind(userId: string): GenerationPrincipal;
  gates: SessionGates;
  steps: StepOps;
  /** Starts the lease renewal (every 10 s); returns its stop. */
  renewEvery(ms: number, fn: () => Promise<void>): () => void;
  log(line: string): void;
}

/** The lease is lost or the job row vanished: write nothing more for this job. */
class LeaseLost extends Error {
  override name = 'LeaseLost';
}

type StopReason =
  | 'initiator-unavailable'
  | 'initiator-role-lost'
  | 'not-approved'
  | 'unconfigured-stt'
  | 'unconfigured-llm'
  | 'provider-failing';

/** The job ends because of a cancel or a stop reason (after its current item's cleanup). */
class JobEnd extends Error {
  constructor(readonly reason: 'cancelled' | StopReason) {
    super(reason);
    this.name = 'JobEnd';
  }
}

const kindOf = (step: AutogenerateStep): 'stt' | 'llm' =>
  AUTOGENERATE_LLM_STEPS.includes(step) ? 'llm' : 'stt';
const PROVIDER_OUTCOMES = new Set<AutogenerateOutcome>([
  'provider-failed',
  'generation-failed',
  'rate-limited',
]);

/** One job's processing by this worker. */
export class JobRun {
  #lost = false;
  #stt: number;
  #llm: number;
  #p: GenerationPrincipal | null = null;

  constructor(
    private readonly ports: WorkerPorts,
    private readonly job: AutogenerateJobRow,
  ) {
    this.#stt = job.consecutive_stt_failures;
    this.#llm = job.consecutive_llm_failures;
  }

  get lost(): boolean {
    return this.#lost;
  }

  /** Marks the lease lost (the renewal found it taken or the row gone). */
  loseLease(): void {
    this.#lost = true;
  }

  async run(): Promise<void> {
    const stopRenewal = this.ports.renewEvery(WORKER_RENEW_MS, async () => {
      if (this.#lost) return;
      const r = await this.ports.store.renew(
        this.job.id,
        this.ports.workerId,
        this.ports.now(),
        WORKER_LEASE_MS,
      );
      if (r !== 'ok') this.#lost = true;
    });
    try {
      await this.#process();
    } catch (e) {
      if (!(e instanceof LeaseLost)) throw e;
      this.ports.log(`[autogenerate] job=${this.job.id}: lease lost; stopping`);
    } finally {
      stopRenewal();
    }
  }

  // -- fenced writes ----------------------------------------------------------------------------

  #fence(n: number): void {
    if (n === 0) {
      this.#lost = true;
      throw new LeaseLost();
    }
  }

  #check(): void {
    if (this.#lost) throw new LeaseLost();
  }

  async #setItem(
    item: AutogenerateItemRow,
    patch: Parameters<AutogenerateStoreFacade['updateItem']>[4],
  ): Promise<void> {
    this.#check();
    this.#fence(
      await this.ports.store.updateItem(
        this.job.id,
        this.ports.workerId,
        item.session_id,
        item.step,
        patch,
      ),
    );
  }

  async #endItem(
    item: AutogenerateItemRow,
    status: 'done' | 'skipped' | 'failed' | 'cancelled',
    outcome: AutogenerateOutcome | null,
    extra: { kept_edited?: number; wiki_accepted?: number; wiki_pending?: number } = {},
  ): Promise<void> {
    await this.#setItem(item, {
      status,
      outcome,
      finished_at_ms: this.ports.now(),
      ...(item.step === 'events' || item.step === 'topics'
        ? { kept_edited: extra.kept_edited ?? 0 }
        : {}),
      ...(item.step === 'wiki' && status === 'done'
        ? { wiki_accepted: extra.wiki_accepted ?? 0, wiki_pending: extra.wiki_pending ?? 0 }
        : {}),
    });
    this.ports.log(
      `[autogenerate] job=${this.job.id} session=${item.session_id} step=${item.step}: ${outcome ?? status}`,
    );
  }

  // -- the job ----------------------------------------------------------------------------------

  async #process(): Promise<void> {
    // A cancel requested before the claim ends the job at the first ladder (D3, D5 step 0).
    for (;;) {
      this.#check();
      const items = await this.ports.store.items(this.job.id);
      const next = items.find((i) => i.status === 'pending' || i.status === 'running');
      if (!next) {
        this.#fence(
          await this.ports.store.endJob(
            this.job.id,
            this.ports.workerId,
            'finished',
            null,
            this.ports.now(),
          ),
        );
        return;
      }
      const session = items.filter((i) => i.session_id === next.session_id);
      try {
        await this.#session(session);
      } catch (e) {
        if (!(e instanceof JobEnd)) throw e;
        await this.#endJob(e.reason);
        return;
      }
    }
  }

  /** Ends the job: every item not yet ended becomes `cancelled` (`cancelled` or `job-stopped`). */
  async #endJob(reason: 'cancelled' | StopReason): Promise<void> {
    const now = this.ports.now();
    await this.ports.store.cancelRemaining(
      this.job.id,
      this.ports.workerId,
      reason === 'cancelled' ? 'cancelled' : 'job-stopped',
      now,
    );
    this.#fence(
      await this.ports.store.endJob(
        this.job.id,
        this.ports.workerId,
        reason === 'cancelled' ? 'cancelled' : 'failed',
        reason,
        now,
      ),
    );
    this.ports.log(`[autogenerate] job=${this.job.id}: ended ${reason}`);
  }

  /** D5 steps 0-3: the job-level part of the ladder. Throws `JobEnd`; returns the principal. */
  async #jobLadder(current: AutogenerateItemRow | null): Promise<GenerationPrincipal> {
    this.#check();
    const row = await this.ports.store.readJob(this.job.id);
    if (row === null || row.status !== 'running' || row.locked_by !== this.ports.workerId) {
      this.#lost = true;
      throw new LeaseLost();
    }
    if (row.cancel_requested_at_ms !== null) {
      await this.#cleanupItem(current);
      throw new JobEnd('cancelled');
    }
    const p = await this.ports.principal(this.job.initiator_user_id);
    if (p === null) {
      this.#p = null;
      await this.#cleanupItem(current);
      throw new JobEnd('initiator-unavailable');
    }
    this.#p = p;
    if (!(await this.ports.gates.manages(p, this.job.team_id))) {
      await this.#cleanupItem(current);
      throw new JobEnd('initiator-role-lost');
    }
    if (!this.ports.gates.approved(p)) {
      await this.#cleanupItem(current);
      throw new JobEnd('not-approved');
    }
    return p;
  }

  /** D7 "Every ending cleans up": the item's own recorded output, as the initiator; a refusal is
   * tolerated (the rows stay recorded on a non-done item, excluded from every gap check). */
  async #cleanupItem(item: AutogenerateItemRow | null): Promise<number> {
    if (item === null || (item.step !== 'events' && item.step !== 'topics')) return 0;
    const fresh = (await this.ports.store.items(this.job.id)).find(
      (i) => i.session_id === item.session_id && i.step === item.step,
    );
    const ids = {
      runIds: fresh?.run_ids ?? item.run_ids,
      topicIds: fresh?.own_topic_ids ?? item.own_topic_ids,
    };
    if (ids.runIds.length === 0 && ids.topicIds.length === 0) return 0;
    const p = this.#p ?? this.ports.bind(this.job.initiator_user_id);
    try {
      return await this.ports.steps.cleanup(p, item.session_id, item.step, ids);
    } catch (e) {
      this.ports.log(
        `[autogenerate] job=${this.job.id} session=${item.session_id} step=${item.step}: cleanup refused (${(e as Error)?.name ?? 'error'})`,
      );
      return 0;
    }
  }

  // -- one session ------------------------------------------------------------------------------

  async #session(items: AutogenerateItemRow[]): Promise<void> {
    const open = items.filter((i) => i.status === 'pending' || i.status === 'running');
    const inFlight = open.find((i) => i.status === 'running') ?? null;
    const p = await this.#jobLadder(inFlight);
    const sessionId = items[0]?.session_id as string;
    // D5 step 4: the session, as the initiator, before every session.
    const access = await this.ports.gates.session(p, sessionId, this.job.team_id);
    if (access !== 'ok') {
      for (const item of open) {
        await this.#cleanupItem(item);
        await this.#endItem(item, 'skipped', access);
      }
      return;
    }
    let cascade: AutogenerateOutcome | null = null;
    let noTranscript = false;
    const failed = { stt: false, llm: false };
    const done = { stt: false, llm: false };
    for (const item of open) {
      if (cascade !== null) {
        await this.#endItem(item, 'skipped', cascade);
        continue;
      }
      if (noTranscript && item.step !== 'transcript') {
        await this.#endItem(item, 'skipped', 'no-transcript');
        continue;
      }
      const out = await this.#step(item);
      const kind = kindOf(item.step);
      if (out.status === 'done') done[kind] = true;
      if (out.status === 'failed' && out.outcome && PROVIDER_OUTCOMES.has(out.outcome)) {
        failed[kind] = true;
      }
      if (out.status === 'failed') cascade = 'earlier-step-failed';
      if (out.status === 'busy-skip') cascade = 'busy';
      if (
        out.outcome === 'no-audio' ||
        out.outcome === 'no-speech' ||
        (item.step === 'events' && out.outcome === 'no-transcript')
      ) {
        noTranscript = true;
      }
    }
    // D17: one count per provider kind; a done step resets only its own kind.
    const stt = failed.stt ? this.#stt + 1 : done.stt ? 0 : this.#stt;
    const llm = failed.llm ? this.#llm + 1 : done.llm ? 0 : this.#llm;
    if (stt !== this.#stt || llm !== this.#llm) {
      this.#stt = stt;
      this.#llm = llm;
      this.#check();
      this.#fence(
        await this.ports.store.setFailureCounts(
          this.job.id,
          this.ports.workerId,
          stt,
          llm,
          this.ports.now(),
        ),
      );
    }
    if (stt >= PROVIDER_FAILURE_STOP || llm >= PROVIDER_FAILURE_STOP) {
      throw new JobEnd('provider-failing');
    }
  }

  // -- one step ---------------------------------------------------------------------------------

  async #step(item: AutogenerateItemRow): Promise<{
    status: 'done' | 'skipped' | 'failed' | 'busy-skip';
    outcome: AutogenerateOutcome | null;
  }> {
    // D11: a re-entered item counts an attempt; the fourth entry ends it `interrupted`.
    if (item.status === 'running' && item.attempts >= MAX_ATTEMPTS) {
      const kept = await this.#cleanupItem(item);
      await this.#endItem(item, 'failed', 'interrupted', { kept_edited: kept });
      return { status: 'failed', outcome: 'interrupted' };
    }
    await this.#setItem(item, {
      status: 'running',
      attempts: item.attempts + 1,
      started_at_ms: item.started_at_ms ?? this.ports.now(),
    });
    let busySince: number | null = null;
    let rateRetries = 0;
    for (;;) {
      // D10 / D17: the cancel, the account, role and approval before each attempt.
      const p = await this.#jobLadder(item);
      const fresh =
        (await this.ports.store.items(this.job.id)).find(
          (i) => i.session_id === item.session_id && i.step === item.step,
        ) ?? item;
      const attempt = await this.#attempt(p, fresh);
      if (attempt.kind === 'busy') {
        busySince ??= this.ports.now();
        if (this.ports.now() - busySince >= BUSY_WINDOW_MS) {
          const kept = await this.#cleanupItem(fresh);
          await this.#endItem(fresh, 'skipped', 'busy', { kept_edited: kept });
          return { status: 'busy-skip', outcome: 'busy' };
        }
        await this.#wait(BUSY_RETRY_MS);
        continue;
      }
      if (attempt.kind === 'rate-limited') {
        if (rateRetries >= RATE_LIMIT_WAITS_MS.length) {
          const kept = await this.#cleanupItem(fresh);
          await this.#endItem(fresh, 'failed', 'rate-limited', {
            kept_edited: kept + (attempt.keptEdited ?? 0),
          });
          return { status: 'failed', outcome: 'rate-limited' };
        }
        await this.#wait(RATE_LIMIT_WAITS_MS[rateRetries] as number);
        rateRetries += 1;
        continue;
      }
      return this.#finish(fresh, attempt);
    }
  }

  /** A wait that renews nothing itself (the renewal timer runs) and notices a lost lease. */
  async #wait(ms: number): Promise<void> {
    await this.ports.sleep(ms);
    this.#check();
  }

  /** One attempt of a step: own output first, the gap, then the runner (D5 steps 5-10). */
  async #attempt(p: GenerationPrincipal, item: AutogenerateItemRow): Promise<StepResult> {
    const sessionId = item.session_id;
    let kept = 0;
    if (item.step === 'events' || item.step === 'topics') {
      // D7: every recorded partial output of this session and step (any job's non-done item,
      // this one's earlier attempts included) is deleted first, version-guarded, as the initiator.
      const recorded = await this.ports.store.recordedPartialOutput(sessionId, item.step);
      try {
        kept = await this.ports.steps.cleanup(p, sessionId, item.step, recorded);
      } catch (e) {
        // A refused delete leaves the rows recorded (excluded from the gap check below).
        this.ports.log(
          `[autogenerate] job=${this.job.id} session=${sessionId} step=${item.step}: cleanup refused (${(e as Error)?.name ?? 'error'})`,
        );
      }
      if (await this.ports.steps.present(p, sessionId, item.step, recorded)) {
        return { kind: 'present', keptEdited: kept };
      }
    } else if (item.step === 'transcript') {
      if (
        await this.ports.steps.present(p, sessionId, 'transcript', { runIds: [], topicIds: [] })
      ) {
        return { kind: 'present' };
      }
    } else {
      // Wiki is never present; a resumed step whose run stored its suggestions makes no new run.
      const last = item.run_ids.at(-1);
      if (last !== undefined && (await this.ports.steps.wikiStored(p, sessionId, last))) {
        return this.#acceptWiki(p, sessionId, last);
      }
    }
    if (await this.ports.gates.recording(p, sessionId)) return { kind: 'busy' };
    let runIdUsed: string | null = null;
    const hooks: StepHooks = {
      earlierRunIds: item.run_ids,
      beforeRun: async (runId) => {
        if (this.#lost) return 'stop';
        runIdUsed = runId;
        if (item.step !== 'wiki') {
          const recorded =
            item.step === 'transcript'
              ? { runIds: [], topicIds: [] }
              : await this.ports.store.recordedPartialOutput(sessionId, item.step);
          if (await this.ports.steps.present(p, sessionId, item.step, recorded)) return 'present';
        }
        if (runId !== null) {
          const n = await this.ports.store.appendRunId(
            this.job.id,
            this.ports.workerId,
            sessionId,
            item.step,
            runId,
          );
          if (n === 0) {
            this.#lost = true;
            return 'stop';
          }
        }
        return 'go';
      },
      recordTopicId: async (id) => {
        if (this.#lost) return false;
        const n = await this.ports.store.appendTopicId(
          this.job.id,
          this.ports.workerId,
          sessionId,
          item.step,
          id,
        );
        if (n === 0) this.#lost = true;
        return n > 0;
      },
    };
    let out: StepResult;
    try {
      out = await this.ports.steps.run(p, sessionId, item.step, hooks);
    } catch (e) {
      // D9: any unexpected throw is `generation-failed`, logged with the error class only.
      this.ports.log(
        `[autogenerate] job=${this.job.id} session=${sessionId} step=${item.step}: unexpected ${(e as Error)?.name ?? 'error'}`,
      );
      out = { kind: 'fail', outcome: 'generation-failed' };
    }
    if (this.#lost) throw new LeaseLost();
    if (item.step === 'wiki' && out.kind === 'done' && runIdUsed !== null) {
      return this.#acceptWiki(p, sessionId, runIdUsed);
    }
    if ('keptEdited' in out && typeof out.keptEdited === 'number') {
      return { ...out, keptEdited: out.keptEdited + kept } as StepResult;
    }
    if (kept > 0 && (out.kind === 'done' || out.kind === 'present' || out.kind === 'fail')) {
      return { ...out, keptEdited: kept } as StepResult;
    }
    return out;
  }

  /** D12: the run's safe suggestions accepted as the initiator (`accept` mode). */
  async #acceptWiki(p: GenerationPrincipal, sessionId: string, runId: string): Promise<StepResult> {
    const counts = await this.ports.steps.acceptWiki(
      p,
      sessionId,
      runId,
      this.job.id,
      this.job.wiki_mode,
    );
    return { kind: 'done', wikiAccepted: counts.accepted, wikiPending: counts.pending };
  }

  /** Records the attempt's ending (design D9). */
  async #finish(
    item: AutogenerateItemRow,
    out: Exclude<StepResult, { kind: 'busy' } | { kind: 'rate-limited' }>,
  ): Promise<{ status: 'done' | 'skipped' | 'failed'; outcome: AutogenerateOutcome | null }> {
    switch (out.kind) {
      case 'done':
        await this.#endItem(item, 'done', null, {
          kept_edited: out.keptEdited,
          wiki_accepted: out.wikiAccepted,
          wiki_pending: out.wikiPending,
        });
        return { status: 'done', outcome: null };
      case 'present':
        await this.#endItem(item, 'skipped', 'present', { kept_edited: out.keptEdited });
        return { status: 'skipped', outcome: 'present' };
      case 'skip':
        await this.#endItem(item, 'skipped', out.outcome);
        return { status: 'skipped', outcome: out.outcome };
      case 'fail': {
        const kept = await this.#cleanupItem(item);
        await this.#endItem(item, 'failed', out.outcome, {
          kept_edited: kept + (out.keptEdited ?? 0),
        });
        return { status: 'failed', outcome: out.outcome };
      }
      case 'unconfigured': {
        const kept = await this.#cleanupItem(item);
        await this.#endItem(item, 'failed', 'unconfigured', { kept_edited: kept });
        throw new JobEnd(kindOf(item.step) === 'stt' ? 'unconfigured-stt' : 'unconfigured-llm');
      }
      case 'forbidden':
        await this.#cleanupItem(item);
        throw new JobEnd('not-approved');
      case 'stopped':
        this.#lost = true;
        throw new LeaseLost();
    }
  }
}

/** The worker loop: poll, claim, process, repeat, until stopped. */
export class AutogenerateWorker {
  #stopped = false;
  #current: Promise<void> | null = null;
  #job: JobRun | null = null;
  #wake: (() => void) | null = null;

  constructor(private readonly ports: WorkerPorts) {}

  /** One poll: claims a due job and processes it to its end (or until the lease is lost). Returns
   * whether a job was claimed. */
  async tick(): Promise<boolean> {
    const job = await this.ports.store.claim(
      this.ports.workerId,
      this.ports.now(),
      WORKER_LEASE_MS,
    );
    if (job === null) return false;
    this.ports.log(`[autogenerate] job=${job.id}: claimed by ${this.ports.workerId}`);
    const run = new JobRun(this.ports, job);
    this.#job = run;
    try {
      await run.run();
    } finally {
      this.#job = null;
    }
    return true;
  }

  /** Runs `tick` every 15 s (or at once after a job ended) until `stop`. */
  start(): void {
    const loop = async () => {
      while (!this.#stopped) {
        let claimed = false;
        try {
          claimed = await this.tick();
        } catch (e) {
          this.ports.log(`[autogenerate] worker pass failed (${(e as Error)?.name ?? 'error'})`);
        }
        if (this.#stopped) break;
        if (!claimed) {
          await new Promise<void>((resolve) => {
            this.#wake = resolve;
            void this.ports.sleep(WORKER_POLL_MS).then(resolve);
          });
          this.#wake = null;
        }
      }
    };
    this.#current = loop();
  }

  /** Stops polling; a job in progress stops writing at its next fenced write. */
  stop(): void {
    this.#stopped = true;
    this.#job?.loseLease();
    this.#wake?.();
  }

  /** Resolves once the loop has ended. */
  idle(): Promise<void> {
    return this.#current ?? Promise.resolve();
  }
}
