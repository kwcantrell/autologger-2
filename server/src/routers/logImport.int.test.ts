import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clearLogImportJobs } from '@autologger/log-import';
import { TRANSCRIPTION_FIXTURES_DIR } from '@autologger/transcription';
import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { app, env, envWith } from '../test/harness';
import { loginCookie, seedSession, seedShow, seedStudio, seedUser } from '../test/helpers';

const NOT_CONFIGURED_DETAIL =
  'Google Sheets log import is not configured on this deployment. Set SHEETS_LOG_IMPORT_ENABLED=1 to enable it.';
const SHOW_NOT_FOUND_DETAIL = 'Show not found.';
const OPEN_NETWORK_DETAIL =
  'Google Sheets log import is refused: the server is bound to a non-loopback address with REQUIRE_LOGIN disabled and no IP_ALLOWLIST. ' +
  'Enable login, set an IP_ALLOWLIST, or bind to loopback (HOST=127.0.0.1) before importing logs.';

/** The base test env leaves SHEETS_LOG_IMPORT_ENABLED unset (503); suites that
 * exercise configured behavior opt in per-request, the envWith pattern. The
 * loopback HOST pin sidesteps the open-network refusal (the youtube-import
 * configuredEnv precedent — the base env is open-network by default). */
const enabledEnv = () => envWith({ SHEETS_LOG_IMPORT_ENABLED: '1', HOST: '127.0.0.1' });

const BODY = JSON.stringify({
  spreadsheet_url: 'https://docs.google.com/spreadsheets/d/abc123xyz/edit',
});

function postImport(showId: string, bindings = enabledEnv(), headers: Record<string, string> = {}) {
  return app.request(
    `/api/shows/${showId}/log-import`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: BODY,
    },
    bindings,
  );
}

afterEach(() => {
  clearLogImportJobs();
  vi.unstubAllGlobals();
});

describe('log-import job HTTP surface', () => {
  it('404s unknown job ids', async () => {
    const res = await app.request('/api/log-import/no-such-job', {}, env);
    expect(res.status).toBe(404);
  });

  it('404s unknown shows on POST (before the config gate — same base env, no opt-in)', async () => {
    const res = await postImport('missing', env);
    expect(res.status).toBe(404);
  });

  it('503s when SHEETS_LOG_IMPORT_ENABLED is unset, even for an existing show', async () => {
    const studio = seedStudio();
    const show = seedShow({ studioId: studio });
    const res = await postImport(show, env);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ detail: NOT_CONFIGURED_DETAIL });
  });

  it('503s with the open-network detail when configured but REQUIRE_LOGIN is off on a non-loopback bind', async () => {
    const studio = seedStudio();
    const show = seedShow({ studioId: studio });
    const openNetwork = envWith({
      SHEETS_LOG_IMPORT_ENABLED: '1',
      REQUIRE_LOGIN: '0',
      HOST: '0.0.0.0',
      IP_ALLOWLIST: '',
    });
    const res = await postImport(show, openNetwork);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ detail: OPEN_NETWORK_DETAIL });
  });

  it('a deployment that is BOTH unconfigured AND open-network-refused returns the NOT_CONFIGURED detail (config gate first)', async () => {
    const studio = seedStudio();
    const show = seedShow({ studioId: studio });
    const bothConditions = envWith({ REQUIRE_LOGIN: '0', HOST: '0.0.0.0', IP_ALLOWLIST: '' });
    const res = await postImport(show, bothConditions);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ detail: NOT_CONFIGURED_DETAIL });
  });

  it('404s (uniform "not found") when an authenticated non-member POSTs to another tenant’s show', async () => {
    const studio = seedStudio();
    const show = seedShow({ studioId: studio });
    const otherStudio = seedStudio();
    const outsider = seedUser({ studios: [otherStudio] });
    const res = await postImport(show, enabledEnv(), { cookie: await loginCookie(outsider) });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: SHOW_NOT_FOUND_DETAIL });
  });

  it('returns a job_id and eventually fails when fetch is not xlsx', async () => {
    const studio = seedStudio();
    const show = seedShow({ studioId: studio });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<!DOCTYPE html><html></html>', { status: 200 })),
    );

    const post = await postImport(show);
    expect(post.status).toBe(200);
    const { job_id } = (await post.json()) as { job_id: string };
    expect(job_id).toBeTruthy();

    let status = 'queued';
    for (let i = 0; i < 40; i++) {
      const get = await app.request(`/api/log-import/${job_id}`, {}, env);
      expect(get.status).toBe(200);
      const body = (await get.json()) as { status: string; error: string | null };
      status = body.status;
      if (status === 'failed' || status === 'completed') {
        expect(status).toBe('failed');
        expect(body.error).toMatch(/HTML|link/i);
        return;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`job did not finish, last status=${status}`);
  });

  it('POST succeeds for a studio member with the gate configured, and the creator can poll the job', async () => {
    const studio = seedStudio();
    const show = seedShow({ studioId: studio });
    const member = seedUser({ studios: [studio] });
    const memberCookie = await loginCookie(member);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<!DOCTYPE html><html></html>', { status: 200 })),
    );

    const post = await postImport(show, enabledEnv(), { cookie: memberCookie });
    expect(post.status).toBe(200);
    const { job_id } = (await post.json()) as { job_id: string };
    expect(job_id).toBeTruthy();

    const get = await app.request(
      `/api/log-import/${job_id}`,
      { headers: { cookie: memberCookie } },
      env,
    );
    expect(get.status).toBe(200);
    const body = (await get.json()) as { status: string };
    expect(['queued', 'running', 'completed', 'failed']).toContain(body.status);
  });

  it('GET job 404s for an authenticated non-creator (same 404 as an unknown id)', async () => {
    const studio = seedStudio();
    const show = seedShow({ studioId: studio });
    const creator = seedUser({ studios: [studio] });
    const otherMember = seedUser({ studios: [studio] });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<!DOCTYPE html><html></html>', { status: 200 })),
    );

    const post = await postImport(show, enabledEnv(), { cookie: await loginCookie(creator) });
    expect(post.status).toBe(200);
    const { job_id } = (await post.json()) as { job_id: string };

    const res = await app.request(
      `/api/log-import/${job_id}`,
      { headers: { cookie: await loginCookie(otherMember) } },
      env,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: 'Log import job not found.' });
  });

  // ── Pipeline end-to-end (pr-3-review test-gap wave) ────────────────────────
  // Every other test in this file stops at the HTTP surface; this one observes
  // the import's OUTPUT — real event rows created in the session — through the
  // whole 176-line pipeline: xlsx fetch → parse → sheet/session title match →
  // transcript sync (syncLogRowsToSeams) → category mapping → event creation.

  it('success path: a matched sheet syncs against the transcript and creates real events with the expected timecodes and categories', async () => {
    const studio = seedStudio();
    // mapLogCategory requires an OTHER category; 'Camera' exercises the
    // type-cell → category match, '' the OTHER fallback.
    const show = seedShow({
      studioId: studio,
      categoriesJson: JSON.stringify([
        {
          id: 'cam',
          name: 'Camera',
          color: '#112233',
          type: 'BUTTON',
          dropdown_options: [],
          on_label: '',
          off_label: '',
        },
        {
          id: 'other',
          name: 'Other',
          color: '#445566',
          type: 'BUTTON',
          dropdown_options: [],
          on_label: '',
          off_label: '',
        },
      ]),
    });
    const session = seedSession({ showId: show, title: 'EP 12' }); // 24 fps

    // Real audio + seam metadata: one 1800 s imported take through the actual
    // local-audio-import route (what the batch importer calls), which persists
    // the seam part `seamPartsForSession` reads and logs the two internal
    // Recording events.
    const importRes = await app.request(
      `/api/sessions/${session}/local-audio-import?duration_s=1800`,
      {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: new Uint8Array([0x52, 0x49, 0x46, 0x46]),
      },
      env,
    );
    expect(importRes.status).toBe(200);

    // Timed transcript words — real rows via the hub (ensureTimedTranscript
    // sees them and skips DeepGram entirely). The phrase sits at session
    // ~527 s while the sheet clock says 8:48 (= 528 s) → offset −1 s.
    env.ports.sessions.get(session).replaceTranscriptWords([
      { session_time: '00:08:47', speaker: '0', word: 'almost', start_sec: 527, end_sec: 527.2 },
      { session_time: '00:08:47', speaker: '0', word: 'called', start_sec: 527.3, end_sec: 527.4 },
      { session_time: '00:08:47', speaker: '0', word: 'a', start_sec: 527.5, end_sec: 527.6 },
      {
        session_time: '00:08:47',
        speaker: '0',
        word: 'helicopter',
        start_sec: 527.7,
        end_sec: 528.4,
      },
      { session_time: '00:08:48', speaker: '0', word: 'but', start_sec: 528.5, end_sec: 528.7 },
    ]);

    // A real minimal xlsx workbook, shaped the way parseWorkbookBuffer reads
    // it: worksheet named after the session title, data from row 7, columns
    // A=timecode / B=message / C=type.
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('EP 12');
    ws.getCell('A1').value = 'Show log header (rows 1–6 are ignored)';
    ws.getCell('A7').value = '8:48';
    ws.getCell('B7').value = 'almost called a helicopter but just crawled';
    ws.getCell('C7').value = 'Camera';
    ws.getCell('A8').value = '9:00';
    ws.getCell('B8').value = 'ad break starts now maybe';
    ws.getCell('C8').value = '';
    const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(xlsx), { status: 200 })),
    );

    const post = await postImport(show);
    expect(post.status).toBe(200);
    const { job_id } = (await post.json()) as { job_id: string };

    let body: { status: string; lines: string[]; error: string | null } | null = null;
    for (let i = 0; i < 80; i++) {
      const get = await app.request(`/api/log-import/${job_id}`, {}, env);
      expect(get.status).toBe(200);
      body = (await get.json()) as { status: string; lines: string[]; error: string | null };
      if (body.status === 'failed' || body.status === 'completed') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(body?.status, `job lines:\n${body?.lines.join('\n')}`).toBe('completed');
    expect(body?.error).toBeNull();
    expect(body?.lines.join('\n')).toContain('Created 2, skipped 0');

    // THE point of this test: actual events exist in the session, at the
    // offset-adjusted timecodes, in the mapped categories.
    const eventsRes = await app.request(`/api/sessions/${session}/events`, {}, env);
    expect(eventsRes.status).toBe(200);
    const events = (await eventsRes.json()) as {
      total: number;
      events: Array<{
        category: string;
        message: string;
        timecode_total_frames: number | null;
        metadata: Record<string, unknown>;
      }>;
    };
    // 2 internal Recording events from the audio import + the 2 imported rows.
    expect(events.total).toBe(4);

    const helicopter = events.events.find(
      (e) => e.message === 'almost called a helicopter but just crawled',
    );
    // 8:48 sheet + (−1 s) offset = 527 s session → 527 × 24 fps = 12648.
    expect(helicopter).toBeDefined();
    expect(helicopter?.category).toBe('cam');
    expect(helicopter?.timecode_total_frames).toBe(12648);
    expect(helicopter?.metadata).toMatchObject({ imported_from_sheets: true });

    const adBreak = events.events.find((e) => e.message === 'ad break starts now maybe');
    // Empty type cell → OTHER category; 9:00 sheet − 1 s = 539 s → 12936.
    expect(adBreak).toBeDefined();
    expect(adBreak?.category).toBe('other');
    expect(adBreak?.timecode_total_frames).toBe(12936);
  });

  it('anonymous GET still works in dev mode (user resolves to null, matching sibling-route scoping)', async () => {
    const studio = seedStudio();
    const show = seedShow({ studioId: studio });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<!DOCTYPE html><html></html>', { status: 200 })),
    );

    // Anonymous creator (REQUIRE_LOGIN=0 base env) → anonymous poll succeeds.
    const post = await postImport(show);
    const { job_id } = (await post.json()) as { job_id: string };
    const res = await app.request(`/api/log-import/${job_id}`, {}, env);
    expect(res.status).toBe(200);
  });
});

// ── Cross-package `instanceof` pin: TranscriptGenerateError arriving with
// D2's relocated `ensureTimedTranscript` coordinator (feature-service-
// packages task 5.1, design D2/D6) ──────────────────────────────────────
//
// `TranscriptGenerateError` is defined in `@autologger/transcription`;
// `routers/logImport.ts`'s `ensureTimedTranscript` (relocated verbatim from
// `logImport/runSessionLogImport.ts`) matches it with `instanceof` at THREE
// sites: the initial upstream/in_flight retry check, the retry-failure
// wrap, and the final non-retry wrap. This is a DIFFERENT route from
// `transcribe.int.test.ts`'s existing pin (task 4.5) — same class, a
// different newly-created cross-package boundary — so design D6's "every
// newly cross-boundary class gets a pin, not just the first one" requires
// its own coverage here, not reuse of transcribe's.
//
// The log-import route reports failure asynchronously — job `lines`/`error`
// via GET poll, never a direct response status — so unlike
// transcribe.int.test.ts's 502/409 assertions, the pin here asserts the
// exact wrapped text `ensureTimedTranscript` produces from the real
// error's `.message`. Both tests drive a real request -> real
// `generateTranscriptWords()` inside the package -> a real thrown
// `TranscriptGenerateError` -> the router's own `instanceof` sites,
// following `routers/flows.int.test.ts`'s "real cross-package error class,
// not a unit-level throw" shape (task 3.3/4.5's precedent).
describe('cross-package instanceof pin: TranscriptGenerateError in ensureTimedTranscript (task 5.1, design D2/D6)', () => {
  function deepgramConfiguredEnv(overrides: Record<string, unknown> = {}) {
    return envWith({
      SHEETS_LOG_IMPORT_ENABLED: '1',
      HOST: '127.0.0.1',
      DEEPGRAM_API_KEY: 'test-deepgram-key',
      DEEPGRAM_MODEL: 'nova-3',
      ...overrides,
    });
  }

  async function xlsxBytes(
    title: string,
    row: { timecode: string; message: string; type: string },
  ) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(title);
    ws.getCell('A7').value = row.timecode;
    ws.getCell('B7').value = row.message;
    ws.getCell('C7').value = row.type;
    return new Uint8Array(await wb.xlsx.writeBuffer());
  }

  /** Long budget: the "upstream" case's real 2000ms retry pause (no fake
   * timers at the integration tier — real elapsed time, matching task
   * 1.1's unit-tier pin using fake timers for the SAME sleep) must fit
   * inside the poll window. */
  async function pollJob(
    jobId: string,
  ): Promise<{ status: string; lines: string[]; error: string | null }> {
    let body: { status: string; lines: string[]; error: string | null } | null = null;
    for (let i = 0; i < 200; i++) {
      const get = await app.request(`/api/log-import/${jobId}`, {}, env);
      expect(get.status).toBe(200);
      body = (await get.json()) as { status: string; lines: string[]; error: string | null };
      if (body.status === 'failed' || body.status === 'completed') return body;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`job did not finish, last status=${body?.status}`);
  }

  it(
    'a "no_audio" TranscriptGenerateError (non-retryable) matches the FINAL catch\'s instanceof ' +
      '-> exact frozen-wrapped job line, no DeepGram call made',
    async () => {
      const studio = seedStudio();
      const show = seedShow({ studioId: studio });
      const title = 'No Audio Session';
      seedSession({ showId: show, title });
      const xlsx = await xlsxBytes(title, { timecode: '0:01', message: 'hello', type: '' });

      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: Parameters<typeof fetch>[0]) => {
          const url = String(input);
          if (url.includes('deepgram.com')) {
            throw new Error('unexpected DeepGram call: session has no audio segments');
          }
          return new Response(xlsx, { status: 200 });
        }),
      );

      const post = await postImport(show, deepgramConfiguredEnv());
      expect(post.status).toBe(200);
      const { job_id } = (await post.json()) as { job_id: string };

      const body = await pollJob(job_id);
      expect(body.status).toBe('failed');
      expect(body.error).toBe('All matched sessions failed to import.');
      // Exact (not substring) match on the coordinator's own wrap of the
      // real TranscriptGenerateError's `.message` — proves the FINAL
      // `instanceof TranscriptGenerateError` branch (no retry: 'no_audio'
      // is neither 'upstream' nor 'in_flight') matched the real thrown
      // instance.
      expect(body.lines).toContain(
        `Failed “${title}”: Transcript generation failed: This session has no recorded audio to transcribe.`,
      );
    },
  );

  it(
    'an "upstream" TranscriptGenerateError retries once, hitting BOTH the retry-check and ' +
      'retry-failure instanceof sites -> exact frozen-wrapped job lines, DeepGram called twice',
    async () => {
      const studio = seedStudio();
      const show = seedShow({ studioId: studio });
      const title = 'Upstream Retry Session';
      const session = seedSession({ showId: show, title });

      const seg1 = readFileSync(join(TRANSCRIPTION_FIXTURES_DIR, 'audio', 'seg1.webm'));
      const uploadRes = await app.request(
        `/api/sessions/${session}/audio/segments`,
        { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: seg1 },
        env,
      );
      expect(uploadRes.status).toBe(200);

      const xlsx = await xlsxBytes(title, { timecode: '0:01', message: 'hello', type: '' });
      let deepgramCalls = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: Parameters<typeof fetch>[0]) => {
          const url = String(input);
          if (url.includes('deepgram.com')) {
            deepgramCalls += 1;
            return new Response('server error', { status: 500 });
          }
          return new Response(xlsx, { status: 200 });
        }),
      );

      const post = await postImport(show, deepgramConfiguredEnv());
      expect(post.status).toBe(200);
      const { job_id } = (await post.json()) as { job_id: string };

      const body = await pollJob(job_id);
      // The retry actually ran a second real provider call, not merely the
      // first — proves the FIRST `instanceof` site's `isUpstream` check
      // matched the real thrown instance and engaged the retry branch.
      expect(deepgramCalls).toBe(2);
      expect(body.status).toBe('failed');
      expect(body.error).toBe('All matched sessions failed to import.');
      expect(body.lines).toContain(
        `  ${title}: Transcript generation failed (DeepGram transcription failed or timed out.); retrying once…`,
      );
      // Exact match on the coordinator's wrap of the RETRY attempt's real
      // TranscriptGenerateError — proves the SECOND `instanceof` site (the
      // retry-failure catch) also matched.
      expect(body.lines).toContain(
        `Failed “${title}”: Transcript generation failed: DeepGram transcription failed or timed out.`,
      );
    },
  );
});
