import type { CategoryRecord } from '@autologger/domain';
import {
  appendLogImportLine,
  createLogImportJob,
  fetchPublicWorkbookSheets,
  getLogImportJob,
  runSessionLogImport,
  setLogImportStatus,
  type TranscriptToken,
  timedTranscriptTokens,
} from '@autologger/log-import';
import type { Config } from '@autologger/ports';
import type { SessionHubFacade, TimecodeCtx } from '@autologger/session-core';
import { generateTranscriptWords, TranscriptGenerateError } from '@autologger/transcription';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Bindings } from '../appEnv';
import { sheetsLogImportConfigured, sheetsLogImportOpenNetworkRefused } from '../env';
import { ApiError } from '../httpError';
import { timecodeCtx } from './_helpers';

export const logImportRouter = new Hono<AppEnv>();

const SHEETS_LOG_IMPORT_NOT_CONFIGURED_DETAIL =
  'Google Sheets log import is not configured on this deployment. Set SHEETS_LOG_IMPORT_ENABLED=1 to enable it.';
const SHEETS_LOG_IMPORT_OPEN_NETWORK_DETAIL =
  'Google Sheets log import is refused: the server is bound to a non-loopback address with REQUIRE_LOGIN disabled and no IP_ALLOWLIST. ' +
  'Enable login, set an IP_ALLOWLIST, or bind to loopback (HOST=127.0.0.1) before importing logs.';
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
  getHub: () => SessionHubFacade;
  config: Config;
  audio: Bindings['ports']['audio'];
  ctx: TimecodeCtx;
  onProgress: (line: string) => void;
}): Promise<TranscriptToken[]> {
  let tokens = timedTranscriptTokens(input.getHub());
  if (tokens.length > 0) {
    input.onProgress(`Transcript already present (${tokens.length} timed words).`);
    return tokens;
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
    const next = timedTranscriptTokens(input.getHub());
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

logImportRouter.post('/api/shows/:showId/log-import', async (c) => {
  const showId = c.req.param('showId');
  const catalog = c.get('catalog');
  const user = c.get('user');
  const show = catalog.shows.getShowRow(showId);
  if (!show) throw new ApiError(404, SHOW_NOT_FOUND_DETAIL);
  // Studio-membership scope (the requireSession pattern in _helpers.ts): an
  // authenticated user who isn't a member of the show's studio gets the SAME
  // 404 as a nonexistent show — no existence oracle. An anonymous requester
  // (user === null: REQUIRE_LOGIN=0 dev mode, or API-token auth) passes,
  // exactly as on every sibling route.
  if (user !== null) {
    const studioId = String(show.studio_id ?? '');
    if (!studioId || !catalog.auth.authUserHasStudio(user.id, studioId)) {
      throw new ApiError(404, SHOW_NOT_FOUND_DETAIL);
    }
  }

  // Configuration gate AFTER the 404 scope check (the youtube-import ordering
  // in sessions.ts): the outbound docs.google.com fetch is operator opt-in —
  // unconfigured deployments 503 before any body parsing or job creation.
  if (!sheetsLogImportConfigured(c.env.config)) {
    throw new ApiError(503, SHEETS_LOG_IMPORT_NOT_CONFIGURED_DETAIL);
  }
  // Open-network refusal AFTER the config gate (the youtube-import/AI-chat
  // ordering): a run can trigger paid DeepGram transcription, so an open
  // deployment must not expose it even when the operator opted in.
  if (sheetsLogImportOpenNetworkRefused(c.env.config)) {
    throw new ApiError(503, SHEETS_LOG_IMPORT_OPEN_NETWORK_DETAIL);
  }

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, 'Request body must be JSON.');
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, 'spreadsheet_url is required.');

  const job = createLogImportJob(c.env.ports.clock, user?.id ?? null);
  const env = c.env;
  const spreadsheetUrl = parsed.data.spreadsheet_url;
  const categories = categoriesFromShowRow(show);

  void (async () => {
    setLogImportStatus(env.ports.clock, job.id, 'running');
    try {
      appendLogImportLine(job.id, 'Fetching spreadsheet…');
      const sheets = await fetchPublicWorkbookSheets(spreadsheetUrl);
      appendLogImportLine(job.id, `Loaded ${sheets.length} sheet(s).`);

      const sessions = catalog.sessions.listSessionsForShow(showId);
      let sessionsOk = 0;
      let sessionsFailed = 0;

      for (const sheet of sheets) {
        const title = sheet.name.trim();
        const session = sessions.find((s) => String(s.title ?? '').trim() === title);
        if (!session) {
          appendLogImportLine(job.id, `Skipped sheet “${title}” (no matching session title).`);
          continue;
        }
        if (sheet.rows.length === 0) {
          appendLogImportLine(job.id, `Skipped sheet “${title}” (no log rows from row 7).`);
          continue;
        }
        const sessionId = String(session.id);
        appendLogImportLine(job.id, `Importing “${title}” → session ${sessionId.slice(0, 8)}…`);
        try {
          const getHub = () => env.ports.sessions.get(sessionId);
          const row = catalog.sessions.getSessionJoinedRow(sessionId, { includeHidden: true });
          if (!row) throw new Error('Session not found.');
          const ctx = timecodeCtx(row);
          const transcript = await ensureTimedTranscript({
            sessionId,
            getHub,
            config: env.config,
            audio: env.ports.audio,
            ctx,
            onProgress: (line) => appendLogImportLine(job.id, `  ${title}: ${line}`),
          });
          const result = runSessionLogImport({
            hub: getHub(),
            rows: sheet.rows,
            categories,
            ctx,
            transcript,
            projectLive: (projection) => {
              catalog.sessions.projectSessionLive(sessionId, projection);
            },
          });
          for (const line of result.lines) {
            appendLogImportLine(job.id, `  ${title}: ${line}`);
          }
          sessionsOk += 1;
        } catch (err) {
          sessionsFailed += 1;
          const detail = err instanceof Error ? err.message : String(err);
          appendLogImportLine(job.id, `Failed “${title}”: ${detail}`);
          appendLogImportLine(job.id, `Continuing with remaining sheets…`);
          // Per-session failure must not abort the rest of the workbook.
        }
      }

      appendLogImportLine(
        job.id,
        `Done. ${sessionsOk} session(s) imported, ${sessionsFailed} failed.`,
      );
      if (sessionsFailed > 0 && sessionsOk === 0) {
        setLogImportStatus(
          env.ports.clock,
          job.id,
          'failed',
          'All matched sessions failed to import.',
        );
      } else if (sessionsFailed > 0) {
        setLogImportStatus(
          env.ports.clock,
          job.id,
          'completed',
          `${sessionsFailed} session(s) failed; see progress lines.`,
        );
      } else {
        setLogImportStatus(env.ports.clock, job.id, 'completed');
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      appendLogImportLine(job.id, `Failed: ${detail}`);
      setLogImportStatus(env.ports.clock, job.id, 'failed', detail);
    }
  })();

  return c.json({ job_id: job.id });
});

logImportRouter.get('/api/log-import/:jobId', (c) => {
  const user = c.get('user');
  const job = getLogImportJob(c.env.ports.clock, c.req.param('jobId'));
  // Creator scope: an authenticated requester who didn't create the job gets
  // the SAME 404 as an unknown id — no existence oracle. Anonymous requesters
  // (REQUIRE_LOGIN=0 dev mode, or API-token auth) pass, mirroring the
  // studio-membership pattern on sibling routes. Not egress-gated: this route
  // only reads local in-process state.
  if (!job || (user !== null && job.createdByUserId !== user.id)) {
    throw new ApiError(404, JOB_NOT_FOUND_DETAIL);
  }
  return c.json({
    status: job.status,
    lines: job.lines,
    error: job.error,
  });
});
