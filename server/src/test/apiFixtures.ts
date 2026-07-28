// Captured API-response fixtures — the server side of the two-sided check
// (web-api-shape-conformance, design D2/D3, task 4.1).
//
// WHAT THIS IS FOR. `web/src/api/client.ts`'s `apiFetch<T>` asserts `T`; it
// never checks it. Every client response type is therefore a hand
// transcription of what someone believed the server emits, and the
// `/admin/users` crash is what happens when one of those beliefs is wrong.
// The fix is to make the transcription step disappear: fixtures here are
// **captured by executing the real handler through `app.request`** and are
// then (a) re-asserted against the live handler on every server test run, so
// they cannot go stale, and (b) assigned to the client types in the web tier,
// so a client type that contradicts the wire fails `tsc`.
//
// FIXTURES ARE OUTPUTS, NOT SOURCE (D2). Hand-editing one — trimming a field,
// prettifying a value, or re-deriving it from `web/src/api/types.ts` —
// silently destroys the guarantee, because the fixture would then encode the
// same belief it exists to check. Regenerate instead:
//
//     npm run fixtures:capture -w server
//
// ASSERT-ONLY BY DEFAULT (task 4.1 / design Open Question). A missing or
// mismatched fixture FAILS; it is never written on the fly. Auto-write-on-miss
// would bless drift automatically, which is the exact failure mode this whole
// mechanism exists to catch. Regeneration requires the explicit env var above
// and is refused outright under `CI`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

/** Repo-root `fixtures/api-responses/`. Deliberately outside both workspaces:
 * the server captures these files and the web tier consumes them, so they
 * belong to neither and a path under `server/src` or `web/src` would imply an
 * owner that does not exist. Both `tsc` runs reach them by import resolution
 * (verified: `web`'s `include: ["src"]` still type-checks an imported file
 * outside it), and neither biome scope covers them, which is correct for
 * generated output. */
const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'fixtures',
  'api-responses',
);

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * NORMALIZING THE INHERENTLY UNSTABLE — and why this does not blind the check.
 *
 * Two kinds of value cannot survive a re-run: `crypto.randomUUID()` ids and
 * wall-clock readings. The check would be permanently red without handling
 * them, and the three obvious handlings are all wrong for this purpose:
 * deleting the key blinds the check to that key disappearing; replacing the
 * value with `expect.any(String)` blinds it to a field going nullable — the
 * single most common real drift, and half of audit findings CW-4 and CW-9;
 * and freezing the clock is not available (most of these timestamps come from
 * `new Date()` inside the producing function, not from the injected
 * `ports.clock`).
 *
 * So values are **redacted in place, preserving everything the check is about**:
 *
 *   - Redaction is applied to string values by PATTERN, not by key name, and
 *     only to the matched substring. A uuid inside a URL is redacted; the
 *     surrounding `/api/sessions/…/audio/segments/…` path is not. A stable id
 *     that happens to sit under a key called `id` (`my-crew`) is left alone,
 *     because it matches no volatile pattern — so it still participates in the
 *     comparison.
 *   - Each pattern masks only the character class that actually varies, and
 *     masks it 1:1, so length and punctuation survive: a uuid becomes
 *     `########-####-####-####-############`, an ISO instant becomes
 *     `####-##-##T##:##:##.###Z`, a timecode becomes `##:##:##:##`.
 *   - Non-strings are never pattern-redacted. `null` stays `null`, booleans
 *     stay themselves. Only the handful of genuinely clock-derived NUMBERS
 *     listed in `VOLATILE_NUMBER_KEYS` are collapsed, and only to `0`, which
 *     is still a number.
 *
 * What still fails, which is the whole point:
 *
 *   - a key stops being emitted, or a new required key appears
 *   - a value goes `null` (null is never redacted, so it cannot match a
 *     redacted string)
 *   - a value changes JSON type (a redacted string never equals a number)
 *   - a value changes format or precision (`##:##:##:##` vs `##:##:##.###`;
 *     an ISO instant losing its `Z`)
 *   - an id stops being a uuid (it no longer matches, so the raw value is
 *     compared and differs)
 *
 * What is deliberately given up: the literal value of an id or timestamp, and
 * with it cross-field identity (a fixture cannot demonstrate that a session's
 * `show_id` equals its show's `id`) and same-format clock churn. Neither is a
 * property of the response *shape*, which is what these fixtures certify.
 */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_INSTANT_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
/** `HH:MM:SS`, `HH:MM:SS:FF`, `HH:MM:SS.mmm` — timecode and runtime readouts. */
const CLOCK_RE = /\b\d{2,}:\d{2}:\d{2}(?:[:.;]\d{1,3})?\b/g;

/** Clock-derived numeric fields. Pattern matching cannot reach a number, so
 * these few are named. Kept as short as possible: every key here is one the
 * comparison no longer constrains beyond "still a number". */
const VOLATILE_NUMBER_KEYS: readonly string[] = [
  'elapsed_frames',
  'timecode_total_frames',
  'audio_recording_lease_age_sec',
];

function redactString(value: string): string {
  return value
    .replace(UUID_RE, (m) => m.replace(/[0-9a-fA-F]/g, '#'))
    .replace(ISO_INSTANT_RE, (m) => m.replace(/\d/g, '#'))
    .replace(CLOCK_RE, (m) => m.replace(/\d/g, '#'));
}

function normalize(value: Json, numberKeys: ReadonlySet<string>): Json {
  if (Array.isArray(value)) return value.map((v) => normalize(v, numberKeys));
  if (value !== null && typeof value === 'object') {
    const out: { [key: string]: Json } = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = numberKeys.has(key) && typeof v === 'number' ? 0 : normalize(v, numberKeys);
    }
    return out;
  }
  return typeof value === 'string' ? redactString(value) : value;
}

const TS_HEADER = (endpoint: string) => `// GENERATED — DO NOT EDIT BY HAND.
//
// Captured from a real \`${endpoint}\` response by
// \`server/src/routers/apiResponseFixtures.int.test.ts\` and re-asserted
// against the live handler on every server test run
// (web-api-shape-conformance, design D2/D3).
//
// Regenerate with:  npm run fixtures:capture -w server
//
// Emitted as a \`.ts\` module rather than \`.json\` because the client type this
// fixture checks contains a string-literal union: a JSON import widens
// \`"admin"\` to \`string\` and would fail the conformance assignment for a
// reason that has nothing to do with the server (design D4's verified
// wrinkle). \`as const\` preserves the literal; \`Mutable\` puts back the
// mutability \`as const\` takes away.
//
// Unstable values (uuids, timestamps, clock readouts) are redacted to \`#\` by
// the capture helper — see \`server/src/test/apiFixtures.ts\` for why they are
// redacted in place rather than deleted or wildcarded.

import type { Mutable } from './_mutable';

const captured = `;

const TS_FOOTER = (exportName: string) => ` as const;

export const ${exportName} = captured as Mutable<typeof captured>;
`;

const JSON_START = 'const captured = ';
const JSON_END = ' as const;';

function fixturePath(name: string, format: 'json' | 'ts'): string {
  return join(FIXTURE_DIR, `${name}.${format}`);
}

function readFixture(name: string, format: 'json' | 'ts'): Json | undefined {
  const path = fixturePath(name, format);
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, 'utf8');
  if (format === 'json') return JSON.parse(text) as Json;
  // The `.ts` module's payload is a plain JSON literal between two fixed
  // markers this helper wrote. A hand-edit that breaks that round trip throws
  // here — which is the intended outcome: fixtures are outputs, not source.
  const start = text.indexOf(JSON_START);
  const end = text.lastIndexOf(JSON_END);
  if (start < 0 || end < 0) {
    throw new Error(
      `Fixture ${name}.ts is not in the generated form (markers missing) — it was hand-edited. Regenerate with: npm run fixtures:capture -w server`,
    );
  }
  return JSON.parse(text.slice(start + JSON_START.length, end)) as Json;
}

function writeFixture(
  name: string,
  format: 'json' | 'ts',
  endpoint: string,
  exportName: string,
  body: Json,
): void {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const payload = JSON.stringify(body, null, 2);
  const text =
    format === 'json' ? `${payload}\n` : `${TS_HEADER(endpoint)}${payload}${TS_FOOTER(exportName)}`;
  writeFileSync(fixturePath(name, format), text);
}

export interface CaptureSpec {
  /** Fixture basename under `fixtures/api-responses/`. */
  name: string;
  /** Human-readable endpoint + branch, recorded in the generated header. */
  endpoint: string;
  /** `ts` for any response whose client type carries a string-literal union
   * (design D4); `json` otherwise. Recorded per endpoint in `audit.md` §9. */
  format: 'json' | 'ts';
  /** Export name for a `.ts` fixture. Ignored for `.json`. */
  exportName?: string;
  /** Extra clock-derived numeric keys beyond `VOLATILE_NUMBER_KEYS`, for this
   * endpoint only. String volatility needs no declaration — it is matched by
   * pattern. */
  volatileNumbers?: readonly string[];
  /** Expected HTTP status. Defaults to 200; asserted, not recorded. */
  status?: number;
}

function updateMode(): boolean {
  if (process.env.UPDATE_API_FIXTURES !== '1') return false;
  if (process.env.CI) {
    throw new Error(
      'UPDATE_API_FIXTURES=1 is refused under CI — regenerating fixtures there would bless drift automatically, which is what these fixtures exist to prevent.',
    );
  }
  return true;
}

/**
 * Issue-and-compare: reads `res`, redacts its unstable values, and asserts the
 * result equals the committed fixture. This is the "cannot silently go stale"
 * half of D3 — the fixture is compared against a **live** handler response on
 * every run, so a server-side shape change fails here even though nothing in
 * `web/` moved.
 *
 * Returns the normalized body so a caller can make an additional targeted
 * assertion without re-reading the response.
 */
export async function expectCapturedResponse(spec: CaptureSpec, res: Response): Promise<Json> {
  expect(res.status, `${spec.endpoint} status`).toBe(spec.status ?? 200);
  const raw = (await res.json()) as Json;
  const numberKeys = new Set([...VOLATILE_NUMBER_KEYS, ...(spec.volatileNumbers ?? [])]);
  const normalized = normalize(raw, numberKeys);

  if (updateMode()) {
    writeFixture(spec.name, spec.format, spec.endpoint, spec.exportName ?? spec.name, normalized);
    return normalized;
  }

  const expected = readFixture(spec.name, spec.format);
  if (expected === undefined) {
    throw new Error(
      `Missing captured fixture ${spec.name}.${spec.format} for ${spec.endpoint}. Fixtures are never written on the fly (that would bless drift) — capture it deliberately with: npm run fixtures:capture -w server`,
    );
  }
  expect(
    normalized,
    `${spec.endpoint} no longer matches fixtures/api-responses/${spec.name}.${spec.format}. If the server change is intended, re-capture with: npm run fixtures:capture -w server (and re-check the client types in web/src/api/types.ts).`,
  ).toEqual(expected);
  return normalized;
}
