# Legacy data import: rehearse, check, cut over, roll back

ADR 0021 slice 11, OpenSpec change `supabase-11a-legacy-import`. This moves one team's data
from the pre-Supabase SQLite files (`DATA_DIR/catalog.db`, `DATA_DIR/sessions/<id>.db`,
`DATA_DIR/blobs/audio/...`) into schema `catalog` and the blob volume.

## What it does and doesn't import

- **Imported** (every column copied explicitly, so no Postgres default replaces a stored value):
  - the team's `studio_definitions` row and its shows;
  - its `studio_config:<team>` setting;
  - every session of those shows, archived and hidden ones included;
  - all nine per-session tables (events, transport, audio segments, transcript words, topics,
    paragraphs, sentiment, dashboards and meta).
- **Not imported:** users, memberships, prefs, invites, KV rows, the retired global
  `active_studio_id` / `active_show_id` keys, and other teams. Legacy user ids aren't GoTrue ids
  (ADR 0021 slice 5a). The imported team has no owner. The bootstrap owner
  (`BOOTSTRAP_OWNER_EMAIL`) claims it at their next sign-in, then grants shows to members.
- **Recomputed, as the app would write them:**
  - the session's live projection (`event_count`, `max_timecode_total_frames` and the four
    transport columns), from the imported events and transport row;
  - `sessions.revision`, from the `events_stream_revision` meta value, or 0 when it is missing or
    not a plain integer, as migration `20261010000000` seeds it;
  - `version = 1` on events, words and topics;
  - a default transport row for a session that has none, as `SessionCore.seed()` adds when a
    session opens.
- **Refused, so nothing is written:**
  - a `catalog.db` whose `_migrations` isn't exactly `0001`-`0006`;
  - a table whose columns differ from the map;
  - a value of the wrong type, a NUL character or invalid UTF-8;
  - an audio key that isn't `audio/<its session's id>/<file name>` (no component may be empty,
    start with `-`, or hold `..`, a backslash or a control character);
  - at apply time, a target whose newest migration isn't the one the tool was written for
    (`TARGET_SCHEMA_VERSION`);
  - at apply time, a team, show, session or `studio_config` key that already exists, unless you
    pass `--replace` (or `--replace-live`).

`--replace` deletes the team's existing rows in the same transaction before importing:

- its sessions and every session row, including leases and overwrite records;
- its shows, show grants, settings, memberships and invites.

It still refuses when an imported show or session id belongs to *another* team. And plain
`--replace` only swaps a team **nobody has used yet**: at apply time it refuses, changing
nothing, with `legacy import refused: --replace would delete live data of team …`, when the team
has any of:

- a session, show or audio segment that isn't in the source (created in the app after the
  import);
- a membership or invite (someone signed in, or the owner claimed the team);
- a show grant, a session lease or an overwrite record.

`--replace-live` deletes those too. Use it only when you mean to throw away what was done in the
app. It does not delete blob files: the audio of a deleted segment that isn't in the new manifest
stays in the blob volume, unreferenced. To list those files, **before** applying, save the keys
the team references now and compare them with the new manifest:

```bash
docker exec -i <db container> psql -X -U postgres -At -v team=ymhs <<'SQL' | sort > referenced-before.txt
select a.r2_key from catalog.session_audio_segments a
  join catalog.sessions s on s.id = a.session_id join catalog.shows sh on sh.id = s.show_id
 where sh.studio_id = :'team';
SQL
sort manifest.txt | comm -23 referenced-before.txt - > orphaned-after-replace.txt
```

## 1. Generate the files (on the host that has the legacy `DATA_DIR`)

Run this from an AutoLogger checkout of this branch, with `npm ci` done. It needs only Node and
`better-sqlite3`. The source is opened read-only, and output files must not exist yet.

```bash
DATA=/home/spark/autologger-2/server/data      # the legacy DATA_DIR (or a copyDataDir.ts copy)
OUT=~/legacy-import && mkdir -p "$OUT"
npx tsx server/scripts/importLegacy.ts "$DATA" --studio ymhs \
  --out "$OUT/import.sql" --parity "$OUT/parity.sql" \
  --manifest "$OUT/manifest.txt" --blob-sizes "$OUT/sizes.txt"
# add  --sha256 "$OUT/sha256.txt"  to hash every blob (reads all ~40 GB)
```

The summary on stderr gives:

- row counts per table;
- audio referenced, present and **missing** (each missing key is listed);
- sessions without a `.db` file, and session files that lack a table (read as empty);
- how many stored legacy projections were stale (recomputed);
- any session that was still rolling.

Exit 1 means it refused; the reason is printed and no partial file is left. Every check runs
before the closing `COMMIT` is written, so even an import written to stdout by a failed run can't
commit.

**Feed the files to psql non-interactively only:** `psql -X -f import.sql`, or stdin redirected
from the file into a container without a TTY (`docker exec -i … psql -X -U postgres < import.sql`,
`docker compose exec -T …`). Never paste them into an interactive psql, and don't use
`make dev-psql < import.sql` (`compose exec` may allocate a TTY). An interactive psql doesn't stop
at the first error: after an aborted COPY it reads the following data lines as SQL.

## 2. Rehearse on dev (VM `autologger-import`)

The VM runs the dev stack (`make dev-up`) from this branch, with migrations applied. **Don't sign
in before the parity check:** the parity file expects no users.

1. **Copy the audio into the `dev-blobs` volume**, owned by the app's user. The image's `node`
   user is uid 1000 (`docker/Dockerfile`, `USER node`), and `/blobs` is `chown node`. Only the
   files the manifest lists are copied, and the copy is additive (never `--delete`):

   ```bash
   # from the Spark host
   rsync -a --files-from="$OUT/manifest.txt" "$DATA/blobs/" autologger-import:legacy-blobs/
   scp "$OUT"/{import.sql,parity.sql,manifest.txt,sizes.txt} autologger-import:
   # on the VM
   BVOL=$(docker volume inspect -f '{{.Mountpoint}}' autologger-dev_dev-blobs)
   sudo rsync -a --chown=1000:1000 --files-from=manifest.txt ~/legacy-blobs/ "$BVOL/"
   sudo sh -c 'cd "$1" && xargs -d "\n" stat -c "%s %n" -- < "$2"' _ "$BVOL" ~/manifest.txt | diff - sizes.txt && echo blobs OK
   # with --sha256:  sudo sh -c 'cd "$1" && sha256sum -c --quiet "$2"' _ "$BVOL" ~/sha256.txt
   ```

2. **Import:** `docker exec -i autologger-dev-db-1 psql -X -U postgres < import.sql` (not
   `make dev-psql`, see step 1). It prints nothing on success. Any `ERROR:` line means the whole
   transaction rolled back. `legacy import refused: …` names the collision, the live data that
   `--replace` won't delete, or the schema mismatch.
3. **Parity:** `docker exec -i autologger-dev-db-1 psql -X -U postgres < parity.sql`. It must print
   `NOTICE:  legacy parity OK: 13 tables match` and exit 0. On a failure it prints
   `legacy parity FAILED: <table>: …` for every difference, then rolls back. Besides the per-table
   hashes it checks each session's live projection and that `sessions.revision` equals its
   `events_stream_revision` meta value (0 when that isn't a plain integer). Parity compares the
   database with the source as of the moment the files were generated, so run it before anyone
   uses the team.
4. `make dev-restart`, so no process keeps cached team names. Then **sign in as the
   `BOOTSTRAP_OWNER_EMAIL` user**. The boot log shows
   `OAuth callback: bootstrap owner claimed team ymhs`, and the team, its 7 shows and its 274
   sessions (39 hidden) appear. Spot-check:
   - a session with audio plays, with seeking (Range);
   - the transcript, topics and dashboards are present;
   - the event count on the session list matches the session.

   Then grant shows to members (Team settings).
5. To re-run after a fix, before anyone signed in, regenerate with `--replace`. Once someone has
   signed in (the owner's claim is a membership), plain `--replace` refuses; regenerate with
   `--replace-live --allow-signed-in-users` if you mean to discard what was done in the app (see
   "What it does and doesn't import" for listing the audio that this leaves behind). The parity
   file then accepts existing users. `--replace-live` removes the team's memberships, so the
   owner must sign out and in again to claim the team.
6. **Clean up** once parity passed (they hold the team's data):

   ```bash
   # on the VM
   rm -f ~/import.sql ~/parity.sql ~/manifest.txt ~/sizes.txt ~/sha256.txt && rm -rf ~/legacy-blobs
   # on the Spark host
   rm -f "$OUT"/{import.sql,parity.sql,manifest.txt,sizes.txt,sha256.txt} && rmdir "$OUT"
   ```

The rehearsal on 2026-10-11 used `server/data` with `--studio ymhs` against a throwaway Postgres
(the pinned image, every migration). Results:

- 274 sessions, 1,096 events, 241,675 words, 14,246 paragraphs, 6,107 sentiment rows, 214
  topics, 259 audio segments, 549 meta rows, 1 dashboard;
- 259 of 259 blobs present (41.7 GB);
- import 1.7 s, parity 0.5 s, OK.

## 3. Cutover (stage or prod)

1. **Freeze the old server** (no writes). Back up the target first:
   `pg_dump -Fc` of the stack's database, plus a snapshot of the blob volume (README "Backup").
2. Make a WAL-safe copy of the old `DATA_DIR` (`server/scripts/copyDataDir.ts`). Then generate
   the files from that copy, as in step 1, **with `--allow-signed-in-users`**: prod has had real
   signed-in users since 2026-10-08, so the default parity ("no users, memberships, prefs,
   invites or login sessions") would fail there. The table hashes, projection and revision checks
   are unchanged.
3. **Audio:** follow README "Moving audio into BLOB_DIR", with `api` stopped. To copy one team
   only, add `--files-from=manifest.txt`:

   ```bash
   BVOL=$(docker volume inspect -f '{{.Mountpoint}}' autologger_autologger-blobs)
   sudo rsync -a --chown=1000:1000 --files-from=manifest.txt "$OLD_DATA/blobs/" "$BVOL/"
   ```

   Then check sizes against `sizes.txt`, as in the rehearsal (`stat … --`).
4. **Import and parity**, as `postgres` in the stack's db container:

   ```bash
   docker exec -i autologger-db-1 psql -X -U postgres < import.sql      # stage: autologger-stage-db-1
   docker exec -i autologger-db-1 psql -X -U postgres < parity.sql
   ```

5. Start `api`. The bootstrap owner (`BOOTSTRAP_OWNER_EMAIL`) must **sign out and sign in
   again**: the claim of ownerless teams runs only in the OAuth callback
   (`server/src/routers/auth.ts`), so an existing session does not pick up the imported team. The
   api log shows `OAuth callback: bootstrap owner claimed team <id>`. Then check as in the
   rehearsal, and grant shows.
6. Clean up the generated files and any staged audio copy, as in rehearsal step 6.

## 4. Rollback

- **Before COMMIT:** nothing to do. The import is one transaction, so any error rolls it all
  back.
- **After COMMIT, before anyone used the team:** regenerate with `--replace` from the corrected
  source and apply it. It swaps the team in one transaction.
- **After COMMIT, after use:** plain `--replace` refuses (the team has live data);
  `--replace-live` swaps it and discards the app's changes, or restore the dump (next item).
- **When in doubt:** restore the `pg_dump` from step 3.1 (README "Backup", restore). Blobs were
  only added, so the volume needs no rollback. To remove them anyway, delete only the manifest's
  files that the restored database does not reference: every key is under
  `audio/<session id>/` of one of the team's sessions, but the restored database may still
  reference them (for example from an earlier import of the same team), and nothing in the target
  stops another row from naming the same key.

  ```bash
  docker exec -i autologger-db-1 psql -X -U postgres -At \
    -c 'select r2_key from catalog.session_audio_segments' | sort > referenced.txt
  sort manifest.txt | comm -23 - referenced.txt > unreferenced.txt
  sudo sh -c 'cd "$1" && xargs -d "\n" rm -f -- < "$2"' _ "$BVOL" "$PWD/unreferenced.txt"
  ```
- The legacy files are never written, so the old server can be started again on its own
  `DATA_DIR` at any point.
