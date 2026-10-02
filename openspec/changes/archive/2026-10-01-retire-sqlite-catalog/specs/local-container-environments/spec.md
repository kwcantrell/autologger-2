## MODIFIED Requirements

### Requirement: Dev isolates data and secrets, sharing only the operator's Claude login
The dev environment SHALL set `DATA_DIR` to a path inside a named volume of the dev project.

Bind mounts:
- Source bind mounts SHALL be read-only.
- Each source mount SHALL resolve under a repository source subtree. The exceptions are
  the gate configuration file `docker/dev-gate.Caddyfile`, the migrations runner script
  `docker/supabase/migrate.sh`, the migrations directory `supabase/migrations`, the Supabase
  gateway configuration `docker/supabase-gw.Caddyfile`, and the Supabase init SQL files under
  `docker/supabase/init/`. Each of these SHALL also be read-only. The runner script and the
  migrations directory SHALL be mounted only into `migrate`, the gateway configuration only into
  `supabase-gw`, and the init SQL only into `db`.
- The only read-write bind mount SHALL be the host `~/.claude/.credentials.json` file,
  mounted at the runtime user's `~/.claude/.credentials.json`. This gives the dev CLI and
  Agent SDK the operator's Claude login.
- No bind mount SHALL be any of the following:
  - the repository root;
  - a path with a `data` segment;
  - a `.env` file, including an Infisical credentials file;
  - any other path under the host home directory, which includes `~/.claude` as a directory
    and `~/.claude.json`.

The runtime user's home SHALL be a named volume of the dev project (`dev-home`). The CLI's
session store, its `~/.claude.json`, and its history live there, never on the host.

The dev `app` container SHALL receive secrets only as the variables named in the shared
allowlist file, each passed through from the Infisical `dev` environment, plus the catalog
connection literals `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` and `PGPASSWORD`, whose password
is `APP_DB_PASSWORD`. It SHALL have no `env_file`, and
SHALL NOT receive the Infisical access token or machine-identity credentials. The
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
  - `DATA_DIR` resolves to a named-volume mount.

#### Scenario: Host server/.env is invisible
- **WHEN** a shell runs in the dev container
- **THEN** `/app/server/.env` and `/app/server/data` do not exist

#### Scenario: Login is shared, not repeated
- **WHEN** the host `~/.claude/.credentials.json` holds a Claude login and dev starts
- **THEN** an AI chat turn succeeds without any login step inside the container
- **AND** nothing is written under the host `~/.claude` other than that file

#### Scenario: Unnamed Infisical secrets stay out of the container
- **WHEN** dev is up
- **THEN** `env` inside the `app` container shows no variable outside the allowlist, the pins,
  the five `PG*` catalog connection literals, and the image's own environment
- **AND** it shows no `INFISICAL_*` variable and no `SSL_CERT_FILE`
