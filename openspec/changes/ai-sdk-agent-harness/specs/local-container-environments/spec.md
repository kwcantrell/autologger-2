## MODIFIED Requirements

### Requirement: Dev environment runs the hot-reload single process with every integration
The dev environment SHALL run the repo's single-process `npm run dev` in a container built
from a `dev` target of `docker/Dockerfile`. The image SHALL include:
- the workspace dependencies for `server`, `web`, and `packages/*`;
- the pinned Claude CLI, with `CLAUDE_CLI_PATH` set to it;
- the pinned yt-dlp and deno in one directory, with `YTDLP_PATH` set to that yt-dlp.

Source subtrees SHALL be bind-mounted so that editing them reloads the running process
without an image rebuild. Every `packages/*` directory SHALL have its `src` mounted; a
missing mount SHALL fail the dev check. A dependency-manifest, lockfile, or config change
SHALL require `make dev-build`, and the documentation SHALL say so.

The following SHALL be settable through the OpenBao `dev` KV secret:
- `DEEPGRAM_API_KEY`
- `SHEETS_LOG_IMPORT_ENABLED`
- `AI_V2_ENABLED`
- `AI_V2_API_KEY`
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
- `CLAUDE_CLI_EMAILS`
- `AI_CHAT_MAX_STEPS`, `AI_CHAT_MAX_TOKENS`, `GENERATE_MAX_STEPS` and `GENERATE_MAX_TOKENS`

`CLAUDE_CLI_EMAILS`, `AI_CHAT_MAX_STEPS`, `AI_CHAT_MAX_TOKENS`, `GENERATE_MAX_STEPS` and
`GENERATE_MAX_TOKENS` SHALL be listed in the shared allowlist file, so every stack's app container
can receive them from its own OpenBao KV secret; the step and token variables must be listed
because the allowlist refuses a whole secret that holds an unlisted key. The env examples and the
OpenBao documentation SHALL name all five, `CLAUDE_CLI_EMAILS` with no value, and no email address
SHALL appear in any committed file.

`API_TOKEN` is no longer read by the server (ADR 0021 slice 9d). `docker/secrets-env.yaml` SHALL
keep allowing it, commented as ignored, until every OpenBao secret has dropped it, because the
allowlist refuses a whole secret that holds an unlisted key. The env examples SHALL NOT list it
and SHALL point to Settings › Companion devices instead.

Sign-in is required, as in every stack:
- The OpenBao `dev` KV secret SHALL hold its own Google OAuth client
  (`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`); without it, dev refuses to start (see
  "Secrets come from one OpenBao KV path per stack, retired keys ignored").
- Google sign-in works against `PUBLIC_BASE_URL=http://localhost:${DEV_PORT}`, which the
  compose file pins.
- The documentation SHALL state the redirect URI the OAuth client needs, and that dev needs
  the Google client in the OpenBao `dev` KV secret.

#### Scenario: Server edit hot-reloads
- **WHEN** the dev environment is up and a file under `server/src/` is edited on the host
- **THEN** the server process restarts within the container, and no image rebuild runs

#### Scenario: Frontend edit hot-reloads
- **WHEN** a file under `web/src/` is edited on the host while a page is open
- **THEN** the page updates through the Next dev HMR socket served on the same published
  origin

#### Scenario: Every gated feature is available
- **WHEN** all of the following hold:
  - the dev environment is up;
  - the host `~/.claude/.credentials.json` holds a Claude login;
  - the OpenBao `dev` KV secret sets `DEEPGRAM_API_KEY`, `SHEETS_LOG_IMPORT_ENABLED=1`,
    `AI_V2_ENABLED=1` and a `CLAUDE_CLI_EMAILS` that lists the caller, and no `AI_V2_API_KEY`;
  - a signed-in member of the session's team, who has saved the `claude-cli` language model
    provider in Settings → Advanced, makes the calls (a caller with no saved `llm` credential gets
    the AI features' not-configured `503` in dev too: there is no development-mode CLI fallback)
- **THEN** none of these is answered with its "not configured" or credentials-refusal `503`:
  - AI chat;
  - `topics/generate`;
  - `events/generate`;
  - AI v2 design;
  - YouTube import;
  - Sheets log import;
  - transcript generation.

#### Scenario: The AI allowlist and cap variables pass through
- **WHEN** a stack's OpenBao KV secret holds `CLAUDE_CLI_EMAILS`, `AI_CHAT_MAX_STEPS`,
  `AI_CHAT_MAX_TOKENS`, `GENERATE_MAX_STEPS` and `GENERATE_MAX_TOKENS`
- **THEN** the secret is accepted, not refused as holding an unlisted key, and the app container
  receives all five variables

#### Scenario: Optional sign-in
- **WHEN** the OpenBao `dev` KV secret sets a Google OAuth client whose redirect URI is
  `http://localhost:<DEV_PORT>/auth/google/callback`, and a user signs in at
  `http://localhost:<DEV_PORT>/`
- **THEN** the callback completes on that origin, and `/api/profile` reports the user

#### Scenario: Dev is not anonymous
- **WHEN** the dev environment is up and `GET /api/sessions` is sent with no session cookie
- **THEN** the response is `401` `{"detail": "Login required."}`

### Requirement: Dev isolates data and secrets, sharing only the operator's Claude login
The dev environment SHALL set `DATA_DIR` to a path inside a named volume of the dev project,
and `BLOB_DIR` to `/blobs`, the mount of a second named volume of the dev project
(`dev-blobs`). `make dev-reset` SHALL delete `dev-blobs` with the project's other volumes.

Bind mounts:
- Source bind mounts SHALL be read-only.
- Each source mount SHALL resolve under a repository source subtree. The exceptions are
  the gate configuration file `docker/dev-gate.Caddyfile`, the migrations runner script
  `docker/supabase/migrate.sh`, the migrations directory `supabase/migrations`, and the Supabase
  init SQL files under `docker/supabase/init/`. Each of these SHALL also be read-only. The runner
  script and the migrations directory SHALL be mounted only into `migrate`, and the init SQL only
  into `db`.
- The only read-write bind mount SHALL be the host `~/.claude/.credentials.json` file,
  mounted at the runtime user's `~/.claude/.credentials.json`. This gives the dev CLI and
  Agent SDK the operator's Claude login.
- No bind mount SHALL be any of the following:
  - the repository root;
  - a path with a `data` segment;
  - a `.env` file, including an OpenBao credentials file (`.env.openbao.<env>`);
  - any other path under the host home directory, which includes `~/.claude` as a directory
    and `~/.claude.json`.

The runtime user's home SHALL be a named volume of the dev project (`dev-home`). The CLI's
session store, its `~/.claude.json`, and its history live there, never on the host.

The dev `app` container SHALL receive secrets only as the variables named in the shared
allowlist file, each passed through from the OpenBao `dev` KV secret, plus the catalog
connection literals `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` and `PGPASSWORD`, whose password
is `APP_DB_PASSWORD`. It SHALL have no `env_file`, and
SHALL NOT receive the OpenBao token or AppRole credentials. The
documentation SHALL state the accepted residuals of the credentials mount:
- the container can read the operator's Claude login;
- the OAuth token may be refreshed, and the file rewritten, by either the container or host
  Claude Code sessions.

#### Scenario: Resolved config mounts nothing forbidden
- **WHEN** the dev project's config is resolved the way the Makefile resolves it
- **THEN**:
  - every source mount is read-only, and names an existing path under a source subtree or one
    of the named exceptions;
  - the only read-write bind is `~/.claude/.credentials.json`;
  - the runtime home is the `dev-home` named volume;
  - `DATA_DIR` resolves to a named-volume mount;
  - `BLOB_DIR` resolves to `/blobs`, the `dev-blobs` named-volume mount.

#### Scenario: Host server/.env is invisible
- **WHEN** a shell runs in the dev container
- **THEN** `/app/server/.env` and `/app/server/data` do not exist

#### Scenario: Login is shared, not repeated
- **WHEN** the host `~/.claude/.credentials.json` holds a Claude login and dev starts
- **THEN** an AI chat turn by a caller on `CLAUDE_CLI_EMAILS` who has saved the `claude-cli`
  provider runs on the Claude CLI and succeeds without any login step inside the container
- **AND** nothing is written under the host `~/.claude` other than that file

#### Scenario: Unnamed OpenBao secrets stay out of the container
- **WHEN** dev is up
- **THEN** `env` inside the `app` container shows no variable outside the allowlist, the pins,
  the five `PG*` catalog connection literals, and the image's own environment
- **AND** it shows no `BAO_*` variable and no `SSL_CERT_FILE`
