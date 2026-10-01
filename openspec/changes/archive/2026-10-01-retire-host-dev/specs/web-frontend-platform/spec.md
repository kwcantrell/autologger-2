## MODIFIED Requirements

### Requirement: Single-process development
Development SHALL run only inside the dev compose stack (`make dev-up`). There, `npm run dev`
SHALL start one process serving pages, assets, API, and WebSockets on one origin (`:8787`,
through the dev gate), with Next dev-mode HMR for web edits. There SHALL be no second dev origin
and no dev proxy. The dev process SHALL bind loopback (`127.0.0.1`), pinned by the dev compose
file. Outside production mode the server SHALL default `HOST` to `127.0.0.1`, and it SHALL use one
effective host value both for binding and for its open-network checks. This preserves the
security posture of the retired Vite dev server's loopback pin: dev-mode source, framework dev
endpoints, and the HMR socket are not LAN-reachable. LAN device testing is unavailable during the
Supabase migration, until the stage stack is made reachable through the upstream proxy.

The server SHALL refuse to boot, exiting non-zero with a message that names `make dev-up` and no
environment values, unless `AUTOLOGGER_STACK` is one of `dev`, `stage` or `prod` (the compose
stack sentinel). It SHALL refuse to boot when `DATA_DIR` is unset or not an absolute path, and
SHALL NOT fall back to a default data directory. It SHALL refuse to boot when another server
process already holds that `DATA_DIR`, before migrating, sweeping or creating anything in it.
`npm run dev` SHALL apply the same checks before starting its file watcher, so a refused run exits
instead of waiting for changes. No package script SHALL read a `server/.env` file.

#### Scenario: Host boot is refused
- **WHEN** `npm run dev` is run on the host, outside any compose stack
- **THEN** it exits non-zero naming `make dev-up`, nothing listens on :8787, and no data
  directory is opened

#### Scenario: No implicit data directory
- **WHEN** the server boots with a valid `AUTOLOGGER_STACK` and `DATA_DIR` unset or relative
- **THEN** it exits non-zero naming `DATA_DIR`, and opens no data directory

#### Scenario: A second server on the same data directory is refused
- **WHEN** a server holds a `DATA_DIR` and a second server process starts against it, whether
  by `npm run dev` or directly
- **THEN** the second process exits non-zero before applying migrations or removing any scratch
  directory, and the running server is unaffected

#### Scenario: No package script reads server/.env
- **WHEN** every `package.json` script in the repository is inspected
- **THEN** none passes an env file to Node or tsx

#### Scenario: One origin in dev
- **WHEN** the dev server is running and a browser loads the app
- **THEN** pages, `/api/*` calls, and the session WebSocket all use the same origin, and
  editing a web component updates the page via HMR without a server restart

#### Scenario: Dev server is loopback-only by default
- **WHEN** the server starts outside production mode with no `HOST` set
- **THEN** it listens on `127.0.0.1`, is not reachable from other hosts, and treats itself as
  loopback-bound for its open-network checks
