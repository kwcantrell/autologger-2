// Export routes — ported from web/routers/exports.py + export.py. Events come from
// the SessionDO, category labels are enriched in the Worker, then serialized to
// CSV (columns TIMECODE/UTC/CATEGORY/MESSAGE, CRLF, csv-minimal quoting matching
// Python's csv module) or JSONL.

import { type Context, Hono } from 'hono';
import type { EventRpc } from '../studio';
import { enrichEventRpc } from '../studio';
import type { AppEnv } from '../types';
import { getSessionDO, requireSession } from './_helpers';

export const exportsRouter = new Hono<AppEnv>();

const COLUMNS = ['TIMECODE', 'UTC', 'CATEGORY', 'MESSAGE'] as const;
const NO_TC = 10 ** 15;

/** Sort key (timecode_total_frames or 1e15, wall_time_utc, event_id), then build rows. */
async function exportRows(
  c: Context<AppEnv>,
  sessionId: string,
): Promise<Array<Record<(typeof COLUMNS)[number], string>>> {
  const profile = await c.get('catalog').studioProfileForSession(sessionId);
  const events = await getSessionDO(c, sessionId).exportEvents();
  events.sort((a, b) => {
    const ka = a.timecode_total_frames ?? NO_TC;
    const kb = b.timecode_total_frames ?? NO_TC;
    if (ka !== kb) return ka - kb;
    if (a.wall_time_utc !== b.wall_time_utc) return a.wall_time_utc < b.wall_time_utc ? -1 : 1;
    return a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0;
  });
  return events.map((ev) => ({
    TIMECODE: timecodeHms(ev),
    UTC: utcYmdHms(ev.wall_time_utc),
    CATEGORY: String(enrichEventRpc(ev, profile).category_label ?? ev.category),
    MESSAGE: ev.message,
  }));
}

exportsRouter.get('/api/sessions/:sessionId/export.csv', async (c) => {
  const sessionId = c.req.param('sessionId');
  await requireSession(c, sessionId);
  const rows = await exportRows(c, sessionId);
  const body = rows.length ? toCsv(rows) : '';
  return new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="autologger_${sessionId.slice(0, 8)}.csv"`,
    },
  });
});

exportsRouter.get('/api/sessions/:sessionId/export.jsonl', async (c) => {
  const sessionId = c.req.param('sessionId');
  await requireSession(c, sessionId);
  const rows = await exportRows(c, sessionId);
  const body = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  return new Response(body, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'content-disposition': `attachment; filename="autologger_${sessionId.slice(0, 8)}.jsonl"`,
    },
  });
});

/** _format_timecode_hms — SMPTE with the trailing `:FF`/`;FF` frame field stripped. */
function timecodeHms(ev: EventRpc): string {
  if (ev.timecode === null) return '';
  return ev.timecode.replace(/[:;]\d{2}$/, '');
}

/** _format_utc_ymd_hms — `%y-%m-%d %H:%M:%S` in UTC. */
function utcYmdHms(iso: string): string {
  const d = new Date(iso);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getUTCFullYear() % 100)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** Serialize to CSV matching Python's csv module: QUOTE_MINIMAL, CRLF line endings. */
function toCsv(rows: Array<Record<(typeof COLUMNS)[number], string>>): string {
  const lines = [COLUMNS.map(csvField).join(',')];
  for (const r of rows) lines.push(COLUMNS.map((col) => csvField(r[col])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

function csvField(value: string): string {
  const s = String(value ?? '');
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
