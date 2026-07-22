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
//   oversize-bypass      — probe succeeds; download simulates a
//                           size-unknown stream yt-dlp's --max-filesize
//                           flag cannot enforce in advance: reads the
//                           `--max-filesize` value straight off its own
//                           argv and writes a produced file strictly LARGER
//                           than that cap, then still exits 0 — proving
//                           `ytdlp.ts`'s JS-side stat() backstop (not the
//                           flag) is what rejects it.
//   unsupported-container — probe succeeds; download writes `audio.opus`
//                           (outside the webm/ogg/wav/m4a supported set).
//   hang                 — records argv/env then loops forever without
//                           exiting on its own (relies on the caller's
//                           hang-timeout group-kill).
//   hang-with-descendant — same as `hang`, but first spawns a grandchild
//                           (NOT detached — it inherits THIS process's
//                           process group, same as a real ffmpeg
//                           postprocessor yt-dlp itself would launch) that
//                           sleeps `control.descendantDelayMs` (default
//                           2000) then writes `descendant-marker.txt`.
//                           Proves the caller's hang-timeout kill reaches
//                           the whole process group, not just this pid: if
//                           only this pid were signaled, the grandchild
//                           would survive and eventually write the marker.

import { spawn as spawnChild } from 'node:child_process';
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

if (mode === 'hang' || mode === 'hang-with-descendant') {
  if (mode === 'hang-with-descendant') {
    // Spawned WITHOUT `detached` — on POSIX it inherits this process's
    // process group (pgid), exactly like a real ffmpeg postprocessor
    // yt-dlp itself launches. `stdio: 'ignore'` + `.unref()` so this
    // fixture process's own exit/kill is never blocked waiting on it —
    // the marker file, not the exit code, is the proof.
    const markerPath = join(cwd, 'descendant-marker.txt');
    const delayMs = Number(control.descendantDelayMs) || 2000;
    const grandchild = spawnChild(
      process.execPath,
      ['-e', `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(markerPath)}, 'alive'), ${delayMs})`],
      { stdio: 'ignore' },
    );
    grandchild.unref();
  }
  // A bare unresolved Promise does not keep the event loop alive on its
  // own; hold an active timer handle so this process genuinely hangs until
  // the parent's hang-timeout kills the group (mirrors fake-claude.mjs's
  // hang mode).
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
  } else if (mode === 'oversize-bypass') {
    // Simulate yt-dlp being UNABLE to enforce --max-filesize in advance
    // (e.g. a size-unknown DASH/chunked stream): read the cap straight off
    // this invocation's own argv and write a file strictly larger than it,
    // then still exit 0 — the flag "worked" (no error) but the produced
    // file breaches the cap anyway.
    const capIdx = argv.indexOf('--max-filesize');
    const capBytes = capIdx >= 0 ? Number(argv[capIdx + 1]) : 0;
    const ext = control.ext || 'm4a';
    writeFileSync(join(cwd, `audio.${ext}`), Buffer.alloc(capBytes + 1024, 'x'));
    process.exitCode = 0;
  } else {
    const ext = mode === 'unsupported-container' ? 'opus' : control.ext || 'm4a';
    writeFileSync(join(cwd, `audio.${ext}`), 'fake-audio-bytes');
    process.exitCode = 0;
  }
}
