import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionIndexStore } from '@autologger/catalog';
import type { SessionHubFacade } from '@autologger/session-core';
import { TRANSCRIPTION_FIXTURES_DIR } from '@autologger/transcription';
import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { app, defaultUser, env, envWith } from '../test/harness';
import {
  catalogFor,
  loginCookie,
  NOT_APPROVED_EMAIL,
  seedMemberStudio,
  seedSession,
  seedShow,
  seedStudio,
  seedUser,
} from '../test/helpers';
import { observeRunLeases, runLeaseHolders } from '../test/runLeases';
import { busProcess, closeBusProcesses } from '../test/session/busProcesses';
import { harnessHub } from '../test/session/sessionRows';

const NOT_CONFIGURED_DETAIL =
  'Google Sheets log import is not configured on this deployment. Set SHEETS_LOG_IMPORT_ENABLED=1 to enable it.';
const SHOW_NOT_FOUND_DETAIL = 'Show not found.';

/** The base test env leaves SHEETS_LOG_IMPORT_ENABLED unset (503); suites that
 * exercise configured behavior opt in per-request, the envWith pattern (the
 * youtube-import configuredEnv precedent pins a loopback HOST too). */
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

/** Give a team member access to a show (show-grants D2). */
async function grant(userId: string, showId: string): Promise<void> {
  await catalogFor().auth.authGrantShow(userId, showId, userId, new Date().toISOString());
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Polls a job to a terminal status with the given headers, so its background run never outlives
 * the test (it reads the per-test env, which teardown removes). */
async function settleJob(jobId: string, headers: Record<string, string> = {}): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const res = await app.request(`/api/log-import/${jobId}`, { headers }, env);
    const body = (await res.json()) as { status?: string };
    if (body.status === 'failed' || body.status === 'completed') return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('job did not finish');
}

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
    const studio = await seedMemberStudio();
    const show = await seedShow({ studioId: studio });
    const res = await postImport(show, env);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ detail: NOT_CONFIGURED_DETAIL });
  });

  it('404s (uniform "not found") when an authenticated non-member POSTs to another tenant’s show', async () => {
    const studio = await seedStudio();
    const show = await seedShow({ studioId: studio });
    const otherStudio = await seedStudio();
    const outsider = await seedUser({ studios: [otherStudio] });
    const res = await postImport(show, enabledEnv(), { cookie: await loginCookie(outsider) });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: SHOW_NOT_FOUND_DETAIL });
  });

  it('returns a job_id and eventually fails when fetch is not xlsx', async () => {
    const studio = await seedMemberStudio();
    const show = await seedShow({ studioId: studio });
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

  it('POST succeeds for a studio member granted the show with the gate configured, and the creator can poll the job', async () => {
    const studio = await seedStudio();
    const show = await seedShow({ studioId: studio });
    const member = await seedUser({ studios: [studio] });
    await grant(member, show);
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
    const studio = await seedStudio();
    const show = await seedShow({ studioId: studio });
    const creator = await seedUser({ studios: [studio] });
    const otherMember = await seedUser({ studios: [studio] });
    await grant(creator, show);
    await grant(otherMember, show);
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

  it('GET job 404s for a signed-in non-member of the show’s studio (require-login D3)', async () => {
    const studio = await seedMemberStudio();
    const show = await seedShow({ studioId: studio });
    const outsider = await seedUser({ studios: [await seedStudio()] });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<!DOCTYPE html><html></html>', { status: 200 })),
    );

    const post = await postImport(show); // the default member starts it
    expect(post.status).toBe(200);
    const { job_id } = (await post.json()) as { job_id: string };

    const res = await app.request(
      `/api/log-import/${job_id}`,
      { headers: { cookie: await loginCookie(outsider) } },
      env,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: 'Log import job not found.' });
    await settleJob(job_id);
  });

  // ── Pipeline end-to-end (pr-3-review test-gap wave) ────────────────────────
  // Every other test in this file stops at the HTTP surface; this one observes
  // the import's OUTPUT — real event rows created in the session — through the
  // whole 176-line pipeline: xlsx fetch → parse → sheet/session title match →
  // transcript sync (syncLogRowsToSeams) → category mapping → event creation.

  it('success path: a matched sheet syncs against the transcript and creates real events with the expected timecodes and categories', async () => {
    const studio = await seedMemberStudio();
    // mapLogCategory requires an OTHER category; 'Camera' exercises the
    // type-cell → category match, '' the OTHER fallback.
    const show = await seedShow({
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
    const session = await seedSession({ showId: show, title: 'EP 12' }); // 24 fps

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
    await (await harnessHub(session)).replaceTranscriptWords([
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

  it('a catalog failure shows a generic line without the database error text, and the server warns (catalog-concurrency-hazards D9)', async () => {
    const studio = await seedMemberStudio();
    const show = await seedShow({ studioId: studio });
    const title = 'Catalog Failure Session';
    await seedSession({ showId: show, title });
    const xlsx = await xlsxBytes(title, { timecode: '0:01', message: 'hello', type: '' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(xlsx, { status: 200 })),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = vi.spyOn(SessionIndexStore.prototype, 'getSessionJoinedRow').mockRejectedValue(
      Object.assign(
        new Error('could not serialize access due to read/write dependencies among transactions'),
        {
          name: 'PostgresError',
          code: '40001',
        },
      ),
    );
    try {
      const post = await postImport(show, deepgramConfiguredEnv());
      const { job_id } = (await post.json()) as { job_id: string };
      const body = await pollJob(job_id);
      expect(body.lines).toContain(`Failed “${title}”`);
      expect(body.lines.join('\n')).not.toMatch(/serialize/);
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/40001/);
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
  });

  it(
    'a "no_audio" TranscriptGenerateError (non-retryable) matches the FINAL catch\'s instanceof ' +
      '-> exact frozen-wrapped job line, no DeepGram call made',
    async () => {
      const studio = await seedMemberStudio();
      const show = await seedShow({ studioId: studio });
      const title = 'No Audio Session';
      await seedSession({ showId: show, title });
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
      const studio = await seedMemberStudio();
      const show = await seedShow({ studioId: studio });
      const title = 'Upstream Retry Session';
      const session = await seedSession({ showId: show, title });

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

  it('a transcript run of the job claims the transcript-generation lease as the job creator (session-run-leases owner decision 4)', async () => {
    const studio = await seedStudio();
    const show = await seedShow({ studioId: studio });
    const member = await seedUser({ studios: [studio] });
    await grant(member, show);
    const cookie = await loginCookie(member);
    const title = 'Lease Holder Session';
    const session = await seedSession({ showId: show, title });
    const seg1 = readFileSync(join(TRANSCRIPTION_FIXTURES_DIR, 'audio', 'seg1.webm'));
    const uploadRes = await app.request(
      `/api/sessions/${session}/audio/segments`,
      { method: 'POST', headers: { 'content-type': 'audio/webm', cookie }, body: seg1 },
      env,
    );
    expect(uploadRes.status).toBe(200);

    const xlsx = await xlsxBytes(title, { timecode: '0:01', message: 'hello', type: '' });
    // The lease rows as the provider call sees them, mid-run.
    const duringProviderCall: Array<{ kind: string; holder_user_id: string | null }>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        if (String(input).includes('deepgram.com')) {
          duringProviderCall.push(await runLeaseHolders(session));
          return new Response(
            JSON.stringify({
              results: {
                channels: [
                  { alternatives: [{ words: [{ word: 'hi', start: 0.5, end: 0.9, speaker: 0 }] }] },
                ],
              },
            }),
            { status: 200 },
          );
        }
        return new Response(xlsx, { status: 200 });
      }),
    );

    const post = await postImport(show, deepgramConfiguredEnv(), { cookie });
    expect(post.status).toBe(200);
    const { job_id } = (await post.json()) as { job_id: string };
    await settleJob(job_id, { cookie });

    expect(duringProviderCall).toEqual([
      [{ kind: 'transcript-generation', holder_user_id: member }],
    ]);
    expect(await runLeaseHolders(session)).toEqual([]);
  });

  // run-status-and-sweeper D9: the creator's approval is decided when the job is created; a
  // creator who is not approved never generates a transcript, and that session fails.
  it('a creator who is not approved skips transcript generation: the skip line, no lease, no provider call, the session failed', async () => {
    const studio = await seedStudio();
    const show = await seedShow({ studioId: studio });
    const member = await seedUser({ email: NOT_APPROVED_EMAIL, studios: [studio] });
    await grant(member, show);
    const cookie = await loginCookie(member);
    const title = 'Not Approved Session';
    const session = await seedSession({ showId: show, title });
    const seg1 = readFileSync(join(TRANSCRIPTION_FIXTURES_DIR, 'audio', 'seg1.webm'));
    const uploadRes = await app.request(
      `/api/sessions/${session}/audio/segments`,
      { method: 'POST', headers: { 'content-type': 'audio/webm', cookie }, body: seg1 },
      env,
    );
    expect(uploadRes.status).toBe(200);

    const xlsx = await xlsxBytes(title, { timecode: '0:01', message: 'hello', type: '' });
    let deepgramCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        if (String(input).includes('deepgram.com')) {
          deepgramCalls += 1;
          return new Response('unexpected', { status: 500 });
        }
        return new Response(xlsx, { status: 200 });
      }),
    );
    const obs = observeRunLeases();
    try {
      const post = await postImport(show, deepgramConfiguredEnv(), { cookie });
      expect(post.status).toBe(200);
      const { job_id } = (await post.json()) as { job_id: string };
      await settleJob(job_id, { cookie });
      const res = await app.request(`/api/log-import/${job_id}`, { headers: { cookie } }, env);
      const body = (await res.json()) as { status: string; lines: string[]; error: string | null };
      expect(body.lines).toContain(
        `  ${title}: Skipped transcript generation: limited to approved users on this server.`,
      );
      expect(body.status).toBe('failed');
      expect(body.error).toBe('All matched sessions failed to import.');
      expect(obs.claims('transcript-generation')).toEqual([]);
    } finally {
      obs.restore();
    }
    expect(deepgramCalls).toBe(0);
    expect(await runLeaseHolders(session)).toEqual([]);
  });
});

// ── Imports re-check access (show-grants D19, owner decision F) ─────────────
describe('the log-import job re-checks its creator’s show access before each sheet (show-grants D19)', () => {
  const SHEET_ROW = 'almost called a helicopter but just crawled';
  const CATEGORIES = JSON.stringify([
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
  ]);

  /** A session with one imported take and timed transcript words, so a sheet imports without
   * DeepGram (the success-path test's setup). The default user is an admin of the studio. */
  async function preparedSession(show: string, title: string): Promise<string> {
    const session = await seedSession({ showId: show, title });
    const res = await app.request(
      `/api/sessions/${session}/local-audio-import?duration_s=1800`,
      {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: new Uint8Array([0x52, 0x49, 0x46, 0x46]),
      },
      env,
    );
    expect(res.status).toBe(200);
    await (await harnessHub(session)).replaceTranscriptWords([
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
    return session;
  }

  async function twoSheetWorkbook(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    // The same row on both sheets: each session's transcript matches it.
    for (const title of ['EP 1', 'EP 2']) {
      const ws = wb.addWorksheet(title);
      ws.getCell('A7').value = '8:48';
      ws.getCell('B7').value = SHEET_ROW;
      ws.getCell('C7').value = 'Camera';
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  async function eventMessages(session: string): Promise<string[]> {
    const res = await app.request(`/api/sessions/${session}/events`, {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ message: string }> };
    return body.events.map((e) => e.message);
  }

  /** Runs a two-sheet import as `creator`, calling `between` once after the first sheet's import
   * wrote its events (its insert, which commits the live projection with it, session-tables D8)
   * and before the second sheet. */
  async function runTwoSheetImport(
    creator: string,
    between: () => Promise<void>,
    opts: { beforeFirstCall?: boolean } = {},
  ) {
    const studio = await seedMemberStudio();
    const show = await seedShow({ studioId: studio, categoriesJson: CATEGORIES });
    await catalogFor().auth.authAddMembershipWithRole(creator, studio, 'member');
    const s1 = await preparedSession(show, 'EP 1');
    const s2 = await preparedSession(show, 'EP 2');
    const xlsx = await twoSheetWorkbook();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(xlsx), { status: 200 })),
    );
    const realSessions = env.ports.sessions;
    let hooked = false;
    // s1's bound hub, with its row insert followed by `between` once; every other member is the
    // hub's.
    const hookedHub = (hub: SessionHubFacade): SessionHubFacade =>
      new Proxy(hub, {
        get(target, prop) {
          // session-content-policies task 5.1: `beforeFirstCall` runs `between` once before s1's
          // first hub call instead, after the job's per-sheet access check.
          const member = Reflect.get(target, prop, target);
          if (opts.beforeFirstCall && typeof member === 'function') {
            return async (...args: unknown[]) => {
              if (!hooked) {
                hooked = true;
                await between();
              }
              return (member as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          if (prop === 'addEventAtTotalFramesIfAbsent') {
            return async (
              input: Parameters<SessionHubFacade['addEventAtTotalFramesIfAbsent']>[0],
            ) => {
              const result = await target.addEventAtTotalFramesIfAbsent(input);
              if (!hooked) {
                hooked = true;
                await between();
              }
              return result;
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    const sessions = new Proxy(realSessions, {
      get(target, prop) {
        if (prop === 'get') {
          return async (sessionId: string) => {
            const entry = await target.get(sessionId);
            if (sessionId !== s1) return entry;
            // The job binds its creator with `as` (session-content-policies D7): hook the bound
            // view it gets back.
            return new Proxy(entry, {
              get(e, prop) {
                if (prop === 'as') {
                  return (caller: Parameters<typeof e.as>[0]) => hookedHub(e.as(caller));
                }
                const value = Reflect.get(e, prop, e);
                return typeof value === 'function' ? value.bind(e) : value;
              },
            });
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const bindings = envWith({ SHEETS_LOG_IMPORT_ENABLED: '1', HOST: '127.0.0.1' }, { sessions });
    return { studio, show, s1, s2, bindings, hookedRef: () => hooked };
  }

  async function finished(jobId: string, cookie: string) {
    let body: { status: string; lines: string[]; error: string | null } | null = null;
    for (let i = 0; i < 200; i++) {
      const get = await app.request(`/api/log-import/${jobId}`, { headers: { cookie } }, env);
      expect(get.status).toBe(200);
      body = (await get.json()) as { status: string; lines: string[]; error: string | null };
      if (body.status === 'failed' || body.status === 'completed') return body;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('job did not finish');
  }

  it('a member whose grant is revoked after the first sheet: failed, Access revoked., first sheet’s events stay, second’s not written', async () => {
    const member = await seedUser();
    const cookie = await loginCookie(member);
    let showId = '';
    const run = await runTwoSheetImport(member, async () => {
      await catalogFor().auth.authRevokeShow(member, showId);
    });
    showId = run.show;
    await grant(member, run.show);

    const post = await postImport(run.show, run.bindings, { cookie });
    expect(post.status).toBe(200);
    const { job_id } = (await post.json()) as { job_id: string };
    const body = await finished(job_id, cookie);

    expect(run.hookedRef(), body.lines.join('\n')).toBe(true);
    expect(body.status, body.lines.join('\n')).toBe('failed');
    expect(body.error).toBe('Access revoked.');
    expect(body.lines[body.lines.length - 1]).toBe('Access revoked; stopping.');
    expect(body.lines.join('\n')).not.toContain('Done.');
    expect(await eventMessages(run.s1)).toContain(SHEET_ROW);
    expect(await eventMessages(run.s2)).not.toContain(SHEET_ROW);
  });

  it('a creator revoked after the per-sheet check: the sheet fails with the neutral refusal, no event is stored, and the next sheet stops the job', async () => {
    const member = await seedUser();
    const cookie = await loginCookie(member);
    let showId = '';
    const run = await runTwoSheetImport(
      member,
      async () => {
        await catalogFor().auth.authRevokeShow(member, showId);
      },
      { beforeFirstCall: true },
    );
    showId = run.show;
    await grant(member, run.show);

    const post = await postImport(run.show, run.bindings, { cookie });
    expect(post.status).toBe(200);
    const { job_id } = (await post.json()) as { job_id: string };
    const body = await finished(job_id, cookie);

    expect(run.hookedRef(), body.lines.join('\n')).toBe(true);
    expect(body.lines).toContain('Failed “EP 1”: access to the session was refused');
    expect(body.status, body.lines.join('\n')).toBe('failed');
    expect(body.error).toBe('Access revoked.');
    expect(body.lines[body.lines.length - 1]).toBe('Access revoked; stopping.');
    expect(await eventMessages(run.s1)).not.toContain(SHEET_ROW);
    expect(await eventMessages(run.s2)).not.toContain(SHEET_ROW);
  });

  it('an admin creator is never stopped (a revoke of their dormant grant changes nothing)', async () => {
    const admin = await seedUser();
    const cookie = await loginCookie(admin);
    let showId = '';
    const run = await runTwoSheetImport(admin, async () => {
      await catalogFor().auth.authRevokeShow(admin, showId);
    });
    showId = run.show;
    await catalogFor().auth.authUpsertMembershipRole(admin, run.studio, 'admin');
    await grant(admin, run.show);

    const post = await postImport(run.show, run.bindings, { cookie });
    expect(post.status).toBe(200);
    const { job_id } = (await post.json()) as { job_id: string };
    const body = await finished(job_id, cookie);

    expect(run.hookedRef(), body.lines.join('\n')).toBe(true);
    expect(body.status, body.lines.join('\n')).toBe('completed');
    expect(body.error).toBeNull();
    expect(await eventMessages(run.s1)).toContain(SHEET_ROW);
    expect(await eventMessages(run.s2)).toContain(SHEET_ROW);
  });
});

// shared-request-state D1 (ADR 0021 slice 9b): job records live in the catalog kv, so a second
// server process over the same database answers the status poll, and a job whose process stopped
// heartbeating reads as failed, finally.
describe('log-import jobs are shared across server processes (shared-request-state D1)', () => {
  afterEach(() => closeBusProcesses());

  it('a GET through a second app returns the job its first app started', async () => {
    const studio = await seedMemberStudio();
    const show = await seedShow({ studioId: studio });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<!DOCTYPE html><html></html>', { status: 200 })),
    );
    const post = await postImport(show); // through the harness app (process A)
    expect(post.status).toBe(200);
    const { job_id } = (await post.json()) as { job_id: string };
    const b = await busProcess();
    let body: { status: string; lines: string[]; error: string | null } | null = null;
    for (let i = 0; i < 200; i++) {
      const res = await app.request(`/api/log-import/${job_id}`, {}, b.bindings);
      expect(res.status).toBe(200);
      body = (await res.json()) as { status: string; lines: string[]; error: string | null };
      if (body.status === 'failed' || body.status === 'completed') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(body?.status).toBe('failed');
    expect(body?.error).toMatch(/HTML|link/i);
    expect(body?.lines[0]).toBe('Fetching spreadsheet…');
    expect(Object.keys(body ?? {}).sort()).toEqual(['error', 'lines', 'status']);
  });

  it('a running job whose process stopped heartbeating 61 s ago reads as failed, finally', async () => {
    const { id: userId } = await defaultUser();
    const jobId = crypto.randomUUID();
    const now = Date.now();
    // A record as a runner on a process that then died leaves it: running, last heartbeat 61 s ago.
    await env.ports.kv.put(
      `log-import-job:${jobId}`,
      JSON.stringify({
        v: 1,
        status: 'running',
        lines: ['Fetching spreadsheet…', 'Loaded 2 sheet(s).'],
        error: null,
        createdAtMs: now - 120_000,
        finishedAtMs: null,
        createdByUserId: userId,
        heartbeatMs: now - 61_000,
        seq: 3,
      }),
      { expirationTtl: 7200 },
    );
    const b = await busProcess();
    const res = await app.request(`/api/log-import/${jobId}`, {}, b.bindings);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'failed',
      lines: ['Fetching spreadsheet…', 'Loaded 2 sheet(s).'],
      error: 'The server running this import stopped.',
    });
    // The switch was written to the record, so process A reads the same final failure.
    const stored = JSON.parse((await env.ports.kv.get(`log-import-job:${jobId}`)) ?? '{}');
    expect(stored).toMatchObject({ status: 'failed', seq: 4 });
    const again = await app.request(`/api/log-import/${jobId}`, {}, env);
    expect(((await again.json()) as { status: string }).status).toBe('failed');
  });

  it('the creator-scoped 404 is unchanged through a second app', async () => {
    const studio = await seedStudio();
    const show = await seedShow({ studioId: studio });
    const creator = await seedUser({ studios: [studio] });
    const otherMember = await seedUser({ studios: [studio] });
    await grant(creator, show);
    await grant(otherMember, show);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<!DOCTYPE html><html></html>', { status: 200 })),
    );
    const creatorCookie = await loginCookie(creator);
    const post = await postImport(show, enabledEnv(), { cookie: creatorCookie });
    const { job_id } = (await post.json()) as { job_id: string };
    const b = await busProcess();
    const foreign = await app.request(
      `/api/log-import/${job_id}`,
      { headers: { cookie: await loginCookie(otherMember) } },
      b.bindings,
    );
    const unknown = await app.request(
      `/api/log-import/${crypto.randomUUID()}`,
      { headers: { cookie: creatorCookie } },
      b.bindings,
    );
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await foreign.text()).toBe(await unknown.text());
    await settleJob(job_id, { cookie: creatorCookie });
  });
});
