import { Hono } from 'hono';
import { z } from 'zod';
import type { CategoryRecord } from '../studio';
import type { AppEnv } from '../types';
import {
  appendLogImportLine,
  createLogImportJob,
  getLogImportJob,
  setLogImportStatus,
} from '../logImport/jobStore';
import { runSessionLogImport, ensureTimedTranscript } from '../logImport/runSessionLogImport';
import { fetchPublicWorkbookSheets } from '../logImport/sheetsFetch';
import { ApiError, timecodeCtx } from './_helpers';

export const logImportRouter = new Hono<AppEnv>();

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
  const show = catalog.shows.getShowRow(showId);
  if (!show) throw new ApiError(404, 'Show not found.');

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, 'Request body must be JSON.');
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, 'spreadsheet_url is required.');

  const job = createLogImportJob();
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
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          appendLogImportLine(job.id, `Failed “${title}”: ${detail}`);
          setLogImportStatus(job.id, 'failed', detail);
          return;
        }
      }

      appendLogImportLine(job.id, 'Done.');
      setLogImportStatus(job.id, 'completed');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      appendLogImportLine(job.id, `Failed: ${detail}`);
      setLogImportStatus(job.id, 'failed', detail);
    }
  })();

  return c.json({ job_id: job.id });
});

logImportRouter.get('/api/log-import/:jobId', (c) => {
  const job = getLogImportJob(c.req.param('jobId'));
  if (!job) throw new ApiError(404, 'Log import job not found.');
  return c.json({
    status: job.status,
    lines: job.lines,
    error: job.error,
  });
});
