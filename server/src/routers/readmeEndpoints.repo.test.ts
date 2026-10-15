// media-worker B.3/B.4 (api-contract-freeze: "the README endpoint table is the route list"): the
// routes this change adds are each registered by their router and listed, with their statuses, in
// README "Endpoints". A textual check over the two files, like the other repo tests.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');

function endpointsSection(): string {
  const md = read('README.md');
  const start = md.indexOf('\n## Endpoints\n');
  expect(start, 'README has an "## Endpoints" section').toBeGreaterThan(-1);
  const end = md.indexOf('\n## ', start + 5);
  return md.slice(start, end === -1 ? undefined : end);
}

/** route as registered → [README text, statuses it must list]. */
/** The upload routes are registered as template literals on `BASE`; spelled here by pieces so the
 * literal text is matched without a template-in-string. */
const T = (rest: string) => `\`$${'{'}BASE}${rest}\``;

const ROUTES: { file: string; method: string; path: string; readme: string; statuses: string[] }[] =
  [
    {
      file: 'server/src/routers/audio.ts',
      method: 'post',
      path: "'/api/sessions/:sessionId/audio/recordings/:recordingOrdinal/finalize'",
      readme: 'POST …/audio/recordings/{recordingOrdinal}/finalize',
      statuses: ['400', '404', '200'],
    },
    {
      file: 'server/src/routers/audioUploads.ts',
      method: 'post',
      path: 'BASE,',
      readme: 'POST …/audio/uploads',
      statuses: ['201', '400', '413', '429', '507'],
    },
    {
      file: 'server/src/routers/audioUploads.ts',
      method: 'put',
      path: T('/:uploadId/parts/:n'),
      readme: 'PUT …/audio/uploads/{uploadId}/parts/{n}',
      statuses: ['204', '400', '404', '413', '507'],
    },
    {
      file: 'server/src/routers/audioUploads.ts',
      method: 'get',
      path: T('/:uploadId'),
      readme: 'GET …/audio/uploads/{uploadId}',
      statuses: ['200', '404'],
    },
    {
      file: 'server/src/routers/audioUploads.ts',
      method: 'post',
      path: T('/:uploadId/complete'),
      readme: 'POST …/audio/uploads/{uploadId}/complete',
      statuses: ['200', '400', '404', '409'],
    },
    {
      file: 'server/src/routers/audioUploads.ts',
      method: 'delete',
      path: T('/:uploadId'),
      readme: 'DELETE …/audio/uploads/{uploadId}',
      statuses: ['204', '404'],
    },
  ];

describe('README "Endpoints" lists the media-worker routes', () => {
  it.each(ROUTES)('$readme is registered and documented', (r) => {
    const src = read(r.file).replace(/\s+/g, ' ').replace(/\( /g, '(');
    expect(src.includes(`.${r.method}(${r.path}`), `${r.file} registers ${r.readme}`).toBe(true);
    const section = endpointsSection();
    const row = section.split('\n').find((l) => l.startsWith('|') && l.includes(`\`${r.readme}\``));
    expect(row, `a table row naming \`${r.readme}\``).toBeDefined();
    for (const s of r.statuses) expect(row, `${r.readme} lists ${s}`).toContain(`**${s}**`);
  });
});
