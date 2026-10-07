import { createCatalog } from '@autologger/catalog';
import type { CategoryRecord } from '@autologger/domain';
import {
  fetchPublicWorkbookSheets,
  JOB_HEARTBEAT_INTERVAL_MS,
  runSessionLogImport,
  type TranscriptToken,
  timedTranscriptTokens,
} from '@autologger/log-import';
import type { Config } from '@autologger/ports';
import { type SessionHubFacade, type TimecodeCtx, userCaller } from '@autologger/session-core';
import { generateTranscriptWords, TranscriptGenerateError } from '@autologger/transcription';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Bindings } from '../appEnv';
import { runFeatureAllowed, sheetsLogImportConfigured } from '../env';
import { ApiError } from '../httpError';
import { requireShowAccess, requireUser, timecodeCtx } from './_helpers';

export const logImportRouter = new Hono<AppEnv>();

const SHEETS_LOG_IMPORT_NOT_CONFIGURED_DETAIL =
  'Google Sheets log import is not configured on this deployment. Set SHEETS_LOG_IMPORT_ENABLED=1 to enable it.';
const SHOW_NOT_FOUND_DETAIL = 'Show not found.';
const JOB_NOT_FOUND_DETAIL = 'Log import job not found.';

const bodySchema = z.object({
  spreadsheet_url: z.string().trim().min(1),
});

function categoriesFromShowRow(row: { categories_json?: unknown }): CategoryRecord[] {
  try {
    const parsed = JSON.parse(String(row.categories_json ?? '[]'));
    if (!Array.isArray(parsed)) return [];
    return parsed as CategoryRecord[];
  } catch {
    return [];
  }
}

// Relocated verbatim from `logImport/runSessionLogImport.ts`
// (feature-service-packages D2): this module already imports `hono` and
// holds `env.config`/`env.ports.audio`/`getHub`/`ctx`/`onProgress` at its
// call site, so the coordinator lands here rather than in a non-Hono
// `routers/coordinators/*.ts` module, which the router-membership check
// (router-directory-decomposition) would reject.
/** Ensure timed transcript words exist; generate via DeepGram when missing. */
export async function ensureTimedTranscript(input: {
  sessionId: string;
  /** Resolves the hub at the point of use; it is re-resolved after the generation's await. */
  getHub: () => Promise<SessionHubFacade>;
  config: Config;
  audio: Bindings['ports']['audio'];
  ctx: TimecodeCtx;
  onProgress: (line: string) => void;
  /** Whether the job's creator is approved for run features, decided when the job was created
   * (run-status-and-sweeper D9). False: generation is skipped and the session fails. */
  generationAllowed: boolean;
}): Promise<TranscriptToken[]> {
  let tokens = await timedTranscriptTokens(await input.getHub());
  if (tokens.length > 0) {
    input.onProgress(`Transcript already present (${tokens.length} timed words).`);
    return tokens;
  }
  if (!input.generationAllowed) {
    input.onProgress('Skipped transcript generation: limited to approved users on this server.');
    throw new Error('No timed transcript is available for sync.');
  }

  input.onProgress('Generating transcript (DeepGram)…');
  const attempt = async (): Promise<TranscriptToken[]> => {
    const words = await generateTranscriptWords({
      config: input.config,
      audio: input.audio,
      getHub: input.getHub,
      ctx: input.ctx,
      sessionId: input.sessionId,
    });
    const next = await timedTranscriptTokens(await input.getHub());
    if (next.length === 0) {
      throw new Error(
        `Transcript generation finished (${words.length} words) but none have usable timing for sync.`,
      );
    }
    return next;
  };

  try {
    tokens = await attempt();
    input.onProgress(`Transcript ready (${tokens.length} timed words).`);
    return tokens;
  } catch (err) {
    const isUpstream =
      err instanceof TranscriptGenerateError &&
      (err.code === 'upstream' || err.code === 'in_flight');
    if (isUpstream) {
      input.onProgress(`Transcript generation failed (${err.message}); retrying once…`);
      // Brief pause: clears in-flight slot races and transient DeepGram blips.
      await new Promise((r) => setTimeout(r, 2000));
      try {
        tokens = await attempt();
        input.onProgress(`Transcript ready after retry (${tokens.length} timed words).`);
        return tokens;
      } catch (retryErr) {
        if (retryErr instanceof TranscriptGenerateError) {
          throw new Error(`Transcript generation failed: ${retryErr.message}`);
        }
        throw retryErr;
      }
    }
    if (err instanceof TranscriptGenerateError) {
      throw new Error(`Transcript generation failed: ${err.message}`);
    }
    throw err;
  }
}

/** A job line's detail: the error's own message for domain failures, which operators act on;
 * null for a catalog or database-driver failure, whose text can carry internals, so it is only
 * logged (catalog-concurrency-hazards D9). */
function jobFailureDetail(err: unknown): string | null {
  const e = err as { code?: unknown; name?: unknown; message?: unknown } | null;
  if (typeof e?.code === 'string' || String(e?.name ?? '').startsWith('Catalog')) {
    console.warn(
      `[log-import] catalog failure during a job (${typeof e?.code === 'string' ? e.code : String(e?.name)})`,
    );
    return null;
  }
  return err instanceof Error ? err.message : String(err);
}

logImportRouter.post('/api/shows/:showId/log-import', async (c) => {
  const showId = c.req.param('showId');
  const user = requireUser(c);
  // Show access (show-grants D3): a user who can't access the show (a non-member, or a member
  // without a grant) gets the SAME 404 as a nonexistent show — no existence oracle.
  const show = await requireShowAccess(c, showId, SHOW_NOT_FOUND_DETAIL);

  // Configuration gate AFTER the 404 scope check (the youtube-import ordering
  // in sessions.ts): the outbound docs.google.com fetch is operator opt-in —
  // unconfigured deployments 503 before any body parsing or job creation.
  if (!sheetsLogImportConfigured(c.env.config)) {
    throw new ApiError(503, SHEETS_LOG_IMPORT_NOT_CONFIGURED_DETAIL);
  }

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, 'Request body must be JSON.');
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, 'spreadsheet_url is required.');

  // shared-request-state D1: the job is a kv record any process can report; this process runs it.
  const jobs = c.env.ports.logImportJobs;
  const job = await jobs.create(user.id);
  const env = c.env;
  const spreadsheetUrl = parsed.data.spreadsheet_url;
  const categories = categoriesFromShowRow(show);
  // run-status-and-sweeper D9: decided now, held in memory for this process's run of the job.
  const generationAllowed = runFeatureAllowed(c.env.config, user);

  // Every write is queued on the job's chain and never rejects (D1); `log` only enqueues.
  const log = (line: string): void => {
    void jobs.appendLine(job.id, line);
  };
  const setStatus = (status: 'completed' | 'failed', error: string | null = null): void => {
    void jobs.setStatus(job.id, status, error);
  };

  void (async () => {
    // A 10 s heartbeat keeps the record from reading as stale while this process runs the job.
    const heartbeat = setInterval(() => {
      void jobs.heartbeat(job.id);
    }, JOB_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();
    void jobs.setStatus(job.id, 'running');
    try {
      // The job outlives its request, so it builds its own catalog (catalog-concurrency-hazards D9).
      const catalog = createCatalog(env.ports.catalog).system('log-import-job');
      await catalog.init();
      log('Fetching spreadsheet…');
      const sheets = await fetchPublicWorkbookSheets(spreadsheetUrl);
      log(`Loaded ${sheets.length} sheet(s).`);

      const sessions = await catalog.sessions.listSessionsForShow(showId);
      let sessionsOk = 0;
      let sessionsFailed = 0;

      for (const sheet of sheets) {
        // A poll switched the record to failed (this process looked stopped): the failure is
        // final, so stop importing and write nothing more (D1).
        if (jobs.isLost(job.id)) return;
        // Access re-check before each sheet (show-grants D19, owner decision F): a creator who
        // lost access to the show stops the job; sheets already imported keep their events.
        if (!(await catalog.auth.authCanAccessShow(job.createdByUserId, showId))) {
          log('Access revoked; stopping.');
          setStatus('failed', 'Access revoked.');
          return;
        }
        const title = sheet.name.trim();
        const session = sessions.find((s) => String(s.title ?? '').trim() === title);
        if (!session) {
          log(`Skipped sheet “${title}” (no matching session title).`);
          continue;
        }
        if (sheet.rows.length === 0) {
          log(`Skipped sheet “${title}” (no log rows from row 7).`);
          continue;
        }
        const sessionId = String(session.id);
        log(`Importing “${title}” → session ${sessionId.slice(0, 8)}…`);
        try {
          // The job's hub calls run as its creator (session-content-policies D7, owner decision 2):
          // the database applies the creator's current access to every statement.
          const getHub = async () =>
            (await env.ports.sessions.get(sessionId)).as(userCaller(job.createdByUserId));
          const row = await catalog.sessions.getSessionJoinedRow(sessionId, {
            includeHidden: true,
          });
          if (!row) throw new Error('Session not found.');
          const ctx = timecodeCtx(row);
          const transcript = await ensureTimedTranscript({
            sessionId,
            getHub,
            config: env.config,
            audio: env.ports.audio,
            ctx,
            onProgress: (line) => log(`  ${title}: ${line}`),
            generationAllowed,
          });
          const result = await runSessionLogImport({
            hub: await getHub(),
            rows: sheet.rows,
            categories,
            ctx,
            transcript,
          });
          for (const line of result.lines) {
            log(`  ${title}: ${line}`);
          }
          sessionsOk += 1;
        } catch (err) {
          sessionsFailed += 1;
          const detail = jobFailureDetail(err);
          log(detail === null ? `Failed “${title}”` : `Failed “${title}”: ${detail}`);
          log(`Continuing with remaining sheets…`);
          // Per-session failure must not abort the rest of the workbook.
        }
      }

      log(`Done. ${sessionsOk} session(s) imported, ${sessionsFailed} failed.`);
      if (sessionsFailed > 0 && sessionsOk === 0) {
        setStatus('failed', 'All matched sessions failed to import.');
      } else if (sessionsFailed > 0) {
        setStatus('completed', `${sessionsFailed} session(s) failed; see progress lines.`);
      } else {
        setStatus('completed');
      }
    } catch (err) {
      const detail = jobFailureDetail(err);
      log(detail === null ? 'Failed' : `Failed: ${detail}`);
      setStatus('failed', detail ?? 'Import failed.');
    } finally {
      // Drain the chain before the heartbeat stops, so no write is left behind it (D1).
      await jobs.release(job.id);
      clearInterval(heartbeat);
    }
  })();

  return c.json({ job_id: job.id });
});

logImportRouter.get('/api/log-import/:jobId', async (c) => {
  const user = requireUser(c);
  const job = await c.env.ports.logImportJobs.get(c.req.param('jobId'));
  // Creator scope: a requester who didn't create the job gets the SAME 404 as
  // an unknown id — no existence oracle (always checked, require-login D3).
  // Not egress-gated: this route only reads the job record in the catalog kv.
  if (!job || job.createdByUserId !== user.id) {
    throw new ApiError(404, JOB_NOT_FOUND_DETAIL);
  }
  return c.json({
    status: job.status,
    lines: job.lines,
    error: job.error,
  });
});
