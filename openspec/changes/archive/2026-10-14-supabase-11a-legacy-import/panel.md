# Panel: supabase-11a-legacy-import
Tier: 2 · Reviewers: data fidelity and app correctness (importer), safety and security (importer), FLAC frames and converter (Follow-up C) · Date: 2026-10-11

## Importer: data fidelity and app correctness

- [x] [minor] The cutover's strict parity file fails on prod, which has real sign-ins since 2026-10-08 (`users: N row(s), expected none`), and the owner claim fires only in the OAuth callback (`routers/auth.ts:272`), not for an already signed-in owner. Evidence: `docs/legacy-import.md` §3 before the fix. Resolved: the cutover generates with `--allow-signed-in-users`, and the runbook says to sign out and back in; tasks 4.2.
- [x] [minor] Parity never cross-checked `sessions.revision` against `session_meta.events_stream_revision` in SQL, so a bug in the TypeScript derivation would pass (both sides hash the derived value). Evidence: `legacyImportSql.ts` `parityChecks`. Resolved: a SQL invariant per session (0 when the meta value isn't a 1–18 digit integer); a pg test tampers revision and meta; tasks 4.1.
- [x] [minor] Parity compares against the source as of generation, while `server/data` showed fresh WAL mtimes. Evidence: `catalog.db` unchanged since 2026-10-03; only `-shm`/`-wal` touched by read-only opens. Declined: no running writer; the cutover freeze step in the runbook covers prod.

## Importer: safety and security

- [x] [major] `--replace` deleted every session of the team, including ones created after the import, plus memberships and invites, orphaning blobs, with no check that the team was unused. Evidence: `legacyImportSql.ts` replace block. Resolved: plain `--replace` refuses live data (sessions, shows or audio not in the source, memberships, invites, show grants, leases, overwrite records) unless `--replace-live`; the runbook lists blobs left behind; tasks 4.1.
- [x] [major] Blob keys were not tied to their session, and a key starting with `-` reached `rm`/`stat` as an option (`rm -f -r audio`). Evidence: `importLegacy.ts` `checkBlobKey`; `docs/legacy-import.md` rollback step. Resolved: keys must be `audio/<the segment's session id>/<file>` with no empty, `-`-leading or `..` component; the runbook uses `--`; tasks 4.1, 4.2.
- [x] [minor] An interactive psql runs COPY data lines as SQL after an abort (confirmed with `docker exec -it`). Resolved: the runbook, headers and usage say to feed files only non-interactively (`-f` or `docker exec -i … <`); `make dev-psql <` dropped; tasks 4.2.
- [x] [minor] Output to stdout committed even when a later blob/sha256 check failed. Resolved: `COMMIT` is written last, after every check; a test fails each sink and asserts no `COMMIT;`; tasks 4.1.
- [x] [minor] The runbook had no cleanup of `import.sql`, `parity.sql`, the manifest and the ~40 GB staged blobs. Resolved: a cleanup step after parity; tasks 4.2.
- [x] [minor] The fixture built SQLite with autocommit inserts and `synchronous=FULL` (~1.5 s per build), timing out a test at the 5 s default. Resolved: `journal_mode = MEMORY`, `synchronous = OFF`, one transaction per file (unit file 15.5 s → 0.3 s); tasks 4.1.

## Follow-up C: FLAC frames and converter

- [x] [major] Trailing bytes after a source's last frame (an ID3v1 tag, padding) end up in mediabunny's last packet; the renumbering then recomputed CRC-16 over frame plus junk, leaving the original CRC mid-packet, and strict decoders drop the frame. Evidence: fixture + 128-byte `TAG…`, merged, `ffmpeg -err_detect crccheck` reported a CRC error. Resolved: `trimFlacFrame` verifies CRC-16 and trims at the last matching boundary (throws when none matches); tests with an ID3v1 tag, zero padding, a fake sync word; tasks C4.
- [x] [minor] Sample-rate code 12 (12/64/128 kHz) is misread by mediabunny, so the merge threw and failed the whole transcript. Resolved: a segment that yields no packets is listed in `skipped`; 12 and 64 kHz fixtures; tasks C4.
- [x] [minor] Coded sample numbers ≥ 2^31 are rejected by ffmpeg and overflow mediabunny. Resolved: a comment in `flacFrames.ts`, and `partitionRuns` starts a new group before 2^31 samples; tasks C4.
- [x] [minor] STREAMINFO nits: a mid-stream frame under 16 samples, min blocksize 0 for a single-frame group, the variable bit with equal blocks. Declined: ffmpeg and mediabunny decode them bit-exact; informational.
- [x] [minor] 4 of the 26 legacy WAVs are 32-bit float, which FLAC cannot hold. Resolved: the converter reports them and keeps them as WAV; README, runbook, proposal and design state it; tasks C4.
