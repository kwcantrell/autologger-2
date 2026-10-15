// The legacy import (OpenSpec change `supabase-11a-legacy-import`): encoding, canonical hashing,
// source checks and the emitted files, without a database. The Postgres round trip is
// test/pg/importLegacy.pg.test.ts.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkBlobKey,
  EXIT_FAIL,
  EXIT_OK,
  EXIT_USAGE,
  type ImportSummary,
  importLegacy,
  main,
  type Sink,
} from '../../scripts/importLegacy';
import {
  ALL_TABLES,
  canonicalField,
  commentLines,
  copyField,
  copyLine,
  copyText,
  realText,
  rowHash,
  TARGET_SCHEMA_VERSION,
} from '../../scripts/legacyImportSql';
import { buildLegacyDataDir, IDS, MIGRATIONS, NASTY } from './legacyFixture';

/** Decodes one COPY text-format field the way Postgres does (the escapes copyText emits, plus
 * `\N`), to prove the encoding round-trips. */
function decodeCopyField(f: string): string | null {
  if (f === '\\N') return null;
  return f.replace(
    /\\(.)/g,
    (_, c: string) => ({ n: '\n', r: '\r', t: '\t', '\\': '\\' })[c] ?? `\\${c}`,
  );
}

/** The SQL text of an emitted file: every line outside COPY data, header comments excluded. */
function sqlTextOf(file: string): string {
  const out: string[] = [];
  let inCopy = false;
  for (const l of file.split('\n')) {
    if (inCopy) {
      if (l === '\\.') inCopy = false;
      continue;
    }
    if (/^COPY .* FROM STDIN;$/.test(l)) inCopy = true;
    if (!l.startsWith('-- ')) out.push(l);
  }
  return out.join('\n');
}

function memSink(): Sink & { text: () => string } {
  const parts: string[] = [];
  return { write: async (s) => void parts.push(s), text: () => parts.join('') };
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'legacy-import-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('COPY text encoding', () => {
  it('escapes exactly backslash, newline, carriage return and tab', () => {
    expect(copyText('a\\b\nc\rd\te')).toBe('a\\\\b\\nc\\rd\\te');
    expect(copyText(NASTY.copyEnd)).toBe('\\\\.');
    expect(copyText(NASTY.dollars)).toBe(NASTY.dollars);
    expect(copyText(NASTY.quotes)).toBe(NASTY.quotes);
    expect(copyText(NASTY.unicode)).toBe(NASTY.unicode);
  });

  it('round-trips every nasty value, and no encoded field holds a raw separator', () => {
    for (const v of Object.values(NASTY)) {
      const f = copyField(v, 'text');
      expect(f).not.toMatch(/[\n\r\t]/);
      expect(decodeCopyField(f)).toBe(v);
    }
  });

  it('a data line can never be the end marker or break into SQL', () => {
    const line = copyLine(
      ['\\.', '\n\\.\nCOMMIT;\n'],
      [
        { name: 'a', type: 'text', nullable: false },
        { name: 'b', type: 'text', nullable: false },
      ],
    );
    expect(line.split('\n')).toEqual(['\\\\.\t\\n\\\\.\\nCOMMIT;\\n', '']);
  });

  it('refuses NUL, which Postgres text cannot hold', () => {
    expect(() => copyText('a\u0000b')).toThrow(/NUL/);
  });

  it('NULL is \\N, distinct from the text "\\N"', () => {
    expect(copyField(null, 'text')).toBe('\\N');
    expect(copyField('\\N', 'text')).toBe('\\\\N');
  });

  it('reals use the shortest round-trip text, with -0, NaN and infinities spelled out', () => {
    for (const v of [29.97, 23.976, 0.1 + 0.2, 1e-7, 5e-324, 1.7976931348623157e308, 1e21, 24]) {
      expect(Number(realText(v))).toBe(v);
    }
    expect(realText(-0)).toBe('-0');
    expect(realText(Number.NaN)).toBe('NaN');
    expect(realText(Number.NEGATIVE_INFINITY)).toBe('-Infinity');
    expect(copyField(9007199254740993n, 'int')).toBe('9007199254740993');
  });
});

describe('canonical row hash', () => {
  it('encodes each type unambiguously', () => {
    expect(canonicalField(null, 'text')).toBe('N');
    expect(canonicalField('é|x', 'text')).toBe('T4:é|x');
    expect(canonicalField(-12n, 'int')).toBe('I-12');
    expect(canonicalField(29.97, 'real')).toBe('D403df851eb851eb8');
    expect(canonicalField(-0, 'real')).toBe('D8000000000000000');
  });

  it('distinguishes NULL from empty and shifted separators', () => {
    const cols = [
      { name: 'a', type: 'text' as const, nullable: true },
      { name: 'b', type: 'text' as const, nullable: true },
    ];
    const hashes = new Set([
      rowHash([null, 'x'], cols),
      rowHash(['', 'x'], cols),
      rowHash(['N', 'x'], cols),
      rowHash(['a|T1:b', ''], cols),
      rowHash(['a', 'b'], cols),
    ]);
    expect(hashes.size).toBe(5);
  });
});

describe('header comments', () => {
  it('keep only printable ASCII without backslash', () => {
    expect(commentLines(['a\nb\\c é'])).toEqual(['-- a?b?c ?']);
  });
});

describe('the target schema version', () => {
  it('is the newest migration in supabase/migrations (a new migration needs this map reviewed)', () => {
    const dir = resolve(import.meta.dirname, '../../../supabase/migrations');
    const newest = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.slice(0, 14))
      .sort()
      .at(-1);
    expect(newest).toBe(TARGET_SCHEMA_VERSION);
  });

  it('every target column of the map exists in the migrations', () => {
    const sql = readdirSync(resolve(import.meta.dirname, '../../../supabase/migrations'))
      .map((f) =>
        readFileSync(resolve(import.meta.dirname, '../../../supabase/migrations', f), 'utf8'),
      )
      .join('\n');
    for (const spec of ALL_TABLES) {
      expect(sql, spec.target).toMatch(new RegExp(`create table catalog\\.${spec.target} \\(`));
      for (const c of spec.cols) {
        expect(sql, `${spec.target}.${c.name}`).toMatch(new RegExp(`\\b${c.name}\\b`));
      }
    }
  });
});

describe('blob keys', () => {
  it("accepts only audio/<the segment's session id>/<file name> and refuses anything else", () => {
    expect(() => checkBlobKey('audio/s1/0001_a.webm', 's1')).not.toThrow();
    for (const [k, sid] of [
      ['', 's1'],
      ['/etc/passwd', 's1'],
      ['../x', 's1'],
      ['audio/../../x', 's1'],
      ['audio/s1/../x', 's1'],
      ['audio//x', 's1'],
      ['a/./b', 's1'],
      ['a\nb', 's1'],
      ['a\\b', 's1'],
      ['a/', 's1'],
      ['audio/s1/', 's1'],
      ['audio/s1', 's1'],
      ['audio/s2/0001_a.webm', 's1'], // another session's audio
      ['audio/s1/sub/0001_a.webm', 's1'],
      ['audio/s1/-rf', 's1'], // an option to stat/rm/xargs
      ['audio/-s1/x', '-s1'],
      ['audio/s1/a..b', 's1'],
      ['audio/s1/a\tb', 's1'],
      ['audio/s1/x\n', 's1'],
      ['blobs/s1/x', 's1'],
    ]) {
      expect(() => checkBlobKey(k, sid), JSON.stringify(k)).toThrow(/audio segment key/);
    }
  });
});

describe('importLegacy on the fixture', () => {
  async function run(extra: Partial<Parameters<typeof importLegacy>[1]> = {}) {
    const sinks = {
      importSql: memSink(),
      paritySql: memSink(),
      manifest: memSink(),
      blobSizes: memSink(),
      sha256: memSink(),
    };
    const summary: ImportSummary = await importLegacy(
      root,
      { studio: IDS.studio, ...extra },
      sinks,
    );
    return { summary, sinks };
  }

  it('imports one team: its shows, its studio_config, all sessions, every session table', async () => {
    buildLegacyDataDir(root);
    const { summary } = await run();
    expect(summary.rows).toEqual({
      studio_definitions: 1,
      shows: 2,
      app_settings: 1,
      sessions: 3,
      session_events: 5,
      session_transport: 3, // s1's row, plus the seed row for s2 (no row) and s3 (no file)
      session_audio_segments: 2,
      session_transcript_words: 3,
      session_topics: 1,
      session_transcript_paragraphs: 1,
      session_transcript_sentiment: 1,
      session_dashboards: 1,
      session_meta: 4,
    });
    expect(summary.sessionsWithoutDb).toEqual([IDS.s3]);
    expect(summary.missingTables).toEqual({
      [IDS.s2]: [
        'session_transcript_paragraphs',
        'session_transcript_sentiment',
        'session_dashboards',
      ],
    });
    expect(summary.staleProjections).toBe(2); // s1 (count 99 stored) and s2 (count 0 stored, 1 event)
  });

  it('never names users, memberships, prefs, invites, kv or another team in the import', async () => {
    buildLegacyDataDir(root);
    const { sinks } = await run();
    const sql = sqlTextOf(sinks.importSql.text());
    for (const word of [
      'catalog.users',
      'catalog.user_prefs',
      'catalog.kv',
      'COPY catalog.user_studio_memberships',
      'COPY catalog.team_invites',
    ]) {
      expect(sql).not.toContain(word);
    }
    for (const v of [
      IDS.otherStudio,
      IDS.otherShow,
      IDS.otherSession,
      'active_studio_id',
      'active_show_id',
      'sb1',
      'x@y.z',
    ]) {
      expect(sinks.importSql.text()).not.toContain(v);
    }
  });

  it('writes source values only inside COPY data, never into SQL text', async () => {
    buildLegacyDataDir(root);
    const { sinks } = await run();
    const text = sinks.importSql.text();
    const joined = sqlTextOf(text);
    for (const v of [IDS.studio, IDS.showA, IDS.s1, 'YMH Studios', 'DROP TABLE', 'Speaker 0']) {
      expect(joined).not.toContain(v);
    }
    expect(text.split('\n')[0]).toMatch(/^-- /);
    expect(joined).toMatch(/\\set ON_ERROR_STOP on\nBEGIN;/);
    expect(joined.trimEnd().endsWith('COMMIT;')).toBe(true);
  });

  it('lists every referenced blob, sizes and checksums for present ones, and reports the missing', async () => {
    buildLegacyDataDir(root);
    const { summary, sinks } = await run({ sha256: true });
    expect(sinks.manifest.text()).toBe(
      `audio/${IDS.s1}/0001_a1.webm\naudio/${IDS.s1}/0002_a2.m4a\n`,
    );
    expect(sinks.blobSizes.text()).toBe(`10 audio/${IDS.s1}/0001_a1.webm\n`);
    expect(sinks.sha256.text()).toMatch(
      new RegExp(`^[0-9a-f]{64}  audio/${IDS.s1}/0001_a1\\.webm\\n$`),
    );
    expect(summary.blobs).toEqual({
      referenced: 2,
      present: 1,
      bytes: 10,
      missing: [`audio/${IDS.s1}/0002_a2.m4a`],
    });
  });

  it('refuses a _migrations set other than 0001-0006', async () => {
    buildLegacyDataDir(root, { migrations: MIGRATIONS.slice(0, 5) });
    await expect(run()).rejects.toThrow(
      /_migrations is \[.*0005_show_title_suffix\.sql\], expected exactly/,
    );
    rmSync(root, { recursive: true, force: true });
    buildLegacyDataDir(root, { migrations: [...MIGRATIONS, '0007_future.sql'] });
    await expect(run()).rejects.toThrow(/expected exactly/);
  });

  it('refuses an unknown team', async () => {
    buildLegacyDataDir(root);
    await expect(importLegacy(root, { studio: 'nope' }, { importSql: memSink() })).rejects.toThrow(
      /no studio_definitions row "nope"/,
    );
  });

  it('refuses a session table whose columns differ from the map', async () => {
    buildLegacyDataDir(root);
    const db = new Database(join(root, 'sessions', `${IDS.s1}.db`));
    db.exec('ALTER TABLE session_topics ADD COLUMN surprise TEXT');
    db.close();
    await expect(run()).rejects.toThrow(/session_topics has unexpected columns.*unknown: surprise/);
  });

  it('refuses a value of the wrong type, invalid UTF-8, a NUL and a traversing blob key', async () => {
    const cases: Array<[string, RegExp]> = [
      ["UPDATE events SET timecode_total_frames = 'abc' WHERE id = 'e1'", /expected an integer/],
      ["UPDATE events SET message = CAST(X'C328' AS TEXT) WHERE id = 'e1'", /not valid UTF-8/],
      ["UPDATE events SET message = 'a' || char(0) || 'b' WHERE id = 'e1'", /NUL/],
      [
        "UPDATE session_audio_segments SET r2_key = '../../etc/passwd' WHERE id = 'a1'",
        /audio segment key "\.\.\/\.\.\/etc\/passwd"/,
      ],
      [
        `UPDATE session_audio_segments SET r2_key = 'audio/${IDS.s2}/0001_a1.webm' WHERE id = 'a1'`,
        /is not audio\/<session id>\/<file name> for session/,
      ],
    ];
    for (const [stmt, err] of cases) {
      rmSync(root, { recursive: true, force: true });
      buildLegacyDataDir(root);
      const db = new Database(join(root, 'sessions', `${IDS.s1}.db`));
      db.exec(stmt);
      db.close();
      await expect(run(), stmt).rejects.toThrow(err);
    }
  });

  it('validates everything before COMMIT: a failure while checking blobs or writing parity leaves no committable stream', async () => {
    const failing = (what: string): Sink => ({
      write: async () => {
        throw new Error(`${what} sink failed`);
      },
    });
    for (const which of ['sha256', 'blobSizes', 'manifest', 'paritySql'] as const) {
      rmSync(root, { recursive: true, force: true });
      buildLegacyDataDir(root);
      const importSql = memSink();
      const sinks = {
        importSql,
        paritySql: memSink(),
        manifest: memSink(),
        blobSizes: memSink(),
        sha256: memSink(),
        [which]: failing(which),
      };
      await expect(
        importLegacy(root, { studio: IDS.studio, sha256: true }, sinks),
        which,
      ).rejects.toThrow(/sink failed/);
      expect(sqlTextOf(importSql.text()), which).not.toMatch(/^COMMIT;$/m);
    }
  });

  it('--replace refuses live team data at apply time unless --replace-live', async () => {
    buildLegacyDataDir(root);
    const guarded = sqlTextOf((await run({ replace: true })).sinks.importSql.text());
    expect(guarded).toMatch(/--replace would delete live data of team %/);
    expect(guarded).toMatch(/use --replace-live/);
    for (const live of [
      'catalog.user_studio_memberships',
      'catalog.team_invites',
      'catalog.show_grants',
      'catalog.session_leases',
      'catalog.session_overwrites',
    ]) {
      expect(guarded, live).toContain(live);
    }
    const live = sqlTextOf((await run({ replaceLive: true })).sinks.importSql.text());
    expect(live).not.toMatch(/would delete live data/);
    expect(live).toMatch(/DELETE FROM catalog\.sessions/);
    const plain = sqlTextOf((await run()).sinks.importSql.text());
    expect(plain).not.toMatch(/DELETE FROM/);
  });

  it('opens the source read-only and leaves it byte-identical', async () => {
    buildLegacyDataDir(root);
    const before = readFileSync(join(root, 'catalog.db'));
    const s1 = readFileSync(join(root, 'sessions', `${IDS.s1}.db`));
    await run();
    expect(readFileSync(join(root, 'catalog.db')).equals(before)).toBe(true);
    expect(readFileSync(join(root, 'sessions', `${IDS.s1}.db`)).equals(s1)).toBe(true);
  });
});

describe('CLI', () => {
  it('usage errors exit 2; success writes the files; a refusal exits 1 and leaves no partial output', async () => {
    const log: string[] = [];
    const l = (s: string) => void log.push(s);
    expect(await main([], l)).toBe(EXIT_USAGE);
    expect(await main([root, '--studio'], l)).toBe(EXIT_USAGE);
    expect(await main([root, '--studio', 'x', '--bogus'], l)).toBe(EXIT_USAGE);
    expect(log.join('\n')).toMatch(/--replace-live/);

    const data = join(root, 'data');
    buildLegacyDataDir(data);
    const out = (f: string) => join(root, f);
    const args = [
      data,
      '--studio',
      IDS.studio,
      '--out',
      out('import.sql'),
      '--parity',
      out('parity.sql'),
      '--manifest',
      out('manifest.txt'),
      '--blob-sizes',
      out('sizes.txt'),
    ];
    expect(await main(args, l)).toBe(EXIT_OK);
    expect(readFileSync(out('import.sql'), 'utf8')).toMatch(/COMMIT;\n$/);
    expect(readFileSync(out('parity.sql'), 'utf8')).toMatch(/ROLLBACK;\n$/);
    expect(log.join('\n')).toMatch(/1 missing/);
    expect(readFileSync(out('import.sql'), 'utf8')).toMatch(
      /^-- mode: refuse on any existing id$/m,
    );

    for (const [flag, mode] of [
      ['--replace', /^-- mode: --replace .*refuses if the team has live data/m],
      ['--replace-live', /^-- mode: --replace-live /m],
    ] as const) {
      const f = out(`import${flag}.sql`);
      expect(await main([data, '--studio', IDS.studio, '--out', f, flag], l)).toBe(EXIT_OK);
      expect(readFileSync(f, 'utf8')).toMatch(mode);
    }

    // Existing output files are never overwritten.
    expect(await main(args, l)).toBe(EXIT_FAIL);
    expect(readFileSync(out('import.sql'), 'utf8')).toMatch(/COMMIT;\n$/);

    writeFileSync(join(root, 'marker'), '');
    const bad = join(root, 'bad');
    buildLegacyDataDir(bad, { migrations: MIGRATIONS.slice(0, 5) });
    expect(await main([bad, '--studio', IDS.studio, '--out', out('bad.sql')], l)).toBe(EXIT_FAIL);
    expect(readdirSync(root)).not.toContain('bad.sql');
  });
});
