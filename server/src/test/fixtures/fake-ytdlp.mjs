#!/usr/bin/env node
// youtube-audio-import (task 3.2) — hermetic test double for `yt-dlp`. Never
// invoked directly by its own shebang in the test suite (that would need
// `env`/`node` resolvable on the CHILD's PATH, which `ytdlp.ts`'s minimal
// child env deliberately does NOT provide — its PATH is pinned to the
// resolved binary's own directory, design D9). Instead the test harness
// generates a tiny `#!/bin/sh` launcher next to this file's absolute path
// baked in via an ABSOLUTE `node` interpreter path (`process.execPath`) —
// so the OS-level exec chain needs no PATH lookup at all, proving the
// module's minimal-env posture doesn't break real execution.
//
// Distinguishes the PROBE call (`ytdlp.ts` always passes `--skip-download`)
// from the DOWNLOAD call (never does) purely by argv inspection — no env
// var needed to tell them apart, since the real module's own contract
// already makes that distinction structural.
//
// Recording (so tests can assert argv/env content without depending on
// stdout ordering): EVERY invocation appends its full argv to
// `argv-log.jsonl` (one JSON array per line, in `process.cwd()` — which
// `ytdlp.ts` always sets to the per-request temp dir) and writes an
// env snapshot to `env-check-probe.json` / `env-check-download.json`
// (fixed names, keyed by call kind) recording whether a planted secret,
// HOME, and the exact PATH value reached this child.
//
// Behavior select via a `.ytdlp-stub.json` CONTROL FILE in `process.cwd()`
// (NOT an env var): `ytdlp.ts`'s child env is deliberately scrubbed down to
// HOME + a PATH pin + a small proxy/TLS allowlist (design D9) — an
// arbitrary `YTDLP_STUB_MODE` env var would never reach this process
// through the real code path, so the test harness instead drops a JSON file
// into the per-request temp dir (which IS this process's cwd) before
// calling `fetchYoutubeAudio`. Missing file ⇒ default "success" behavior.
// Shape: `{ mode?: string, ext?: string, uploadDate?: string | null }`.
//
// Modes (default "success"):
//   success              — probe reports a normal short video; download
//                           writes `audio.<ext>` (YTDLP_STUB_EXT, default
//                           m4a). upload_date defaults to "20240115";
//                           override via YTDLP_STUB_UPLOAD_DATE (empty
//                           string ⇒ omitted/null).
//   live                 — probe reports is_live: true, duration: null.
//   null-duration        — probe reports is_live: false, duration: null.
//   long-duration        — probe reports duration: 20000 (> 4h).
//   probe-fail           — probe exits non-zero with no JSON on stdout.
//   download-fail        — probe succeeds; download exits non-zero, no file.
//   oversize             — probe succeeds; download simulates yt-dlp's own
//                           --max-filesize abort: exits non-zero, no file.
//   unsupported-container — probe succeeds; download writes `audio.opus`
//                           (outside the webm/ogg/wav/m4a supported set).
//   hang                 — records argv/env then loops forever without
//                           exiting on its own (relies on the caller's
//                           hang-timeout SIGKILL).

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const cwd = process.cwd();
const controlPath = join(cwd, '.ytdlp-stub.json');
const control = existsSync(controlPath) ? JSON.parse(readFileSync(controlPath, 'utf8')) : {};
const mode = control.mode || 'success';
const isProbe = argv.includes('--skip-download');

appendFileSync(join(cwd, 'argv-log.jsonl'), `${JSON.stringify(argv)}\n`);

writeFileSync(
  join(cwd, isProbe ? 'env-check-probe.json' : 'env-check-download.json'),
  JSON.stringify({
    hasPlantedSecret: Object.hasOwn(process.env, 'PLANTED_SECRET_TOKEN'),
    hasHome: Object.hasOwn(process.env, 'HOME'),
    path: process.env.PATH ?? null,
    hasIgnoreConfig: argv.includes('--ignore-config'),
    hasNoPlugins: argv.includes('--no-plugins'),
    hasNoNetrc: argv.includes('--no-netrc'),
  }),
);

if (mode === 'hang') {
  // A bare unresolved Promise does not keep the event loop alive on its
  // own; hold an active timer handle so this process genuinely hangs until
  // the parent SIGKILLs it (mirrors fake-claude.mjs's hang mode).
  setInterval(() => {}, 1 << 30);
} else if (isProbe) {
  if (mode === 'probe-fail') {
    process.stderr.write('simulated metadata probe failure\n');
    process.exitCode = 3;
  } else {
    const upload_date = Object.hasOwn(control, 'uploadDate') ? control.uploadDate : '20240115';
    let payload;
    if (mode === 'live') payload = { is_live: true, duration: null, upload_date: null };
    else if (mode === 'null-duration') payload = { is_live: false, duration: null, upload_date };
    else if (mode === 'long-duration') payload = { is_live: false, duration: 20000, upload_date };
    else payload = { is_live: false, duration: 125, upload_date };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    process.exitCode = 0;
  }
} else {
  // ── download call ──
  if (mode === 'download-fail') {
    process.stderr.write('simulated download failure\n');
    process.exitCode = 1;
  } else if (mode === 'oversize') {
    process.stderr.write('ERROR: File is larger than max-filesize, aborting.\n');
    process.exitCode = 1;
  } else {
    const ext = mode === 'unsupported-container' ? 'opus' : control.ext || 'm4a';
    writeFileSync(join(cwd, `audio.${ext}`), 'fake-audio-bytes');
    process.exitCode = 0;
  }
}
