import type { CategoryRecord } from '@autologger/domain';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../appEnv';
import { sheetsLogImportConfigured, sheetsLogImportOpenNetworkRefused } from '../env';
import { ApiError } from '../httpError';
import {
  appendLogImportLine,
  createLogImportJob,
  getLogImportJob,
  setLogImportStatus,
} from '../logImport/jobStore';
import { ensureTimedTranscript, runSessionLogImport } from '../logImport/runSessionLogImport';
import { fetchPublicWorkbookSheets } from '../logImport/sheetsFetch';
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

  const job = createLogImportJob(user?.id ?? null);
  const env = c.env;
  const spreadsheetUrl = parsed.data.spreadsheet_url;
  const categories = categoriesFromShowRow(show);

  void (async () => {
    setLogImportStatus(job.id, 'running');
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
        setLogImportStatus(job.id, 'failed', 'All matched sessions failed to import.');
      } else if (sessionsFailed > 0) {
        setLogImportStatus(
          job.id,
          'completed',
          `${sessionsFailed} session(s) failed; see progress lines.`,
        );
      } else {
        setLogImportStatus(job.id, 'completed');
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      appendLogImportLine(job.id, `Failed: ${detail}`);
      setLogImportStatus(job.id, 'failed', detail);
    }
  })();

  return c.json({ job_id: job.id });
});

logImportRouter.get('/api/log-import/:jobId', (c) => {
  const user = c.get('user');
  const job = getLogImportJob(c.req.param('jobId'));
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
