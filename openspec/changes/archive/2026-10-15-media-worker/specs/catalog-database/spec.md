## ADDED Requirements

### Requirement: The media worker connects as its own read-mostly role
The migration SHALL create the role `autologger_media` for the media worker, `NOLOGIN` until the
migrations runner grants it `LOGIN` with its password (as it does for `autologger_app`), and SHALL
always reset it to no `CREATEDB`, `CREATEROLE`, `BYPASSRLS`, `REPLICATION` or superuser, a connection limit
of 4, a `statement_timeout` of 30 seconds, an `idle_in_transaction_session_timeout` of 15 seconds
and `search_path = catalog`. It SHALL be a member of no role, and the catalog roles' membership
check ("only `autologger_app` and `postgres`") SHALL still hold. Its privileges SHALL be exactly:
`USAGE` on schema `catalog`; `SELECT` on `catalog.media_jobs` and `UPDATE` of its columns `status`,
`locked_by`, `locked_until_ms`, `attempts`, `run_after_ms`, `result_json`, `error` and
`updated_at_ms` only; `SELECT` on `catalog.session_audio_segments` and `catalog.session_audio_seams`.
A `BEFORE UPDATE` trigger on `media_jobs` SHALL, for that role, allow only the transitions
`queued → running` while the lease is free or expired and `running → queued`, `done` or `failed`
with the lease holder unchanged, and raise on any other change; `result_json` SHALL be checked to
at most 262 144 bytes. Row-level security on those three tables SHALL have a permissive policy
for `autologger_media` allowing every row for those commands. The migration SHALL hold no
password; the migrations runner sets it from `MEDIA_DB_PASSWORD`, as it sets the app role's. The
tables `catalog.media_jobs`, `catalog.media_uploads` and `catalog.session_audio_seams` (one row per
accepted chunk window, primary key `(session_id, recording_ordinal, started_at_utc)`, pointing at
the segment that holds the window with its media offset and the original chunk's key) SHALL be
created with row-level security, a `catalog_system` allow-all policy, and `catalog_user` policies
scoped by the same session-access rule as the session tables (`media_jobs`: `INSERT` and `SELECT`
only; `media_uploads`: rows of accessible sessions the user created; `session_audio_seams`: like
the session tables).

#### Scenario: The worker role reads jobs and segments and nothing else
- **WHEN** `autologger_media` selects and updates `catalog.media_jobs`, selects
  `catalog.session_audio_segments` and `catalog.session_audio_seams`, then inserts into or
  deletes from `media_jobs`, updates `kind`, `session_id` or `target` of a job, updates or inserts
  into `session_audio_segments`, selects from `sessions`, `session_events` or `kv`, or runs
  `set role catalog_system`
- **THEN** the first four statements succeed and every other one is refused with `42501`

#### Scenario: The guard trigger bounds the worker's transitions
- **WHEN** `autologger_media` sets a `queued` job to `applied`, re-queues a `running` job held by
  another worker, or claims a `running` job whose lease has not expired
- **THEN** each update raises and changes no row, while claiming a `queued` job and finishing its
  own `running` job succeed

#### Scenario: A user transaction can enqueue but not steer jobs
- **WHEN** a `catalog_user` binding for a user with access to session S inserts a `media_jobs` row
  for S, then one for a session it cannot access, then updates a row
- **THEN** the first insert succeeds, the second fails with `42501`, and the update affects no row

#### Scenario: The role check still passes
- **WHEN** the catalog migrations are applied with `autologger_media` present
- **THEN** the roles migration's membership guard passes, and `autologger_media` is a member of no
  role
