# Stack secrets from Infisical

The dev, stage and prod compose stacks get their secrets from the owner's self-hosted Infisical
(OpenSpec change `infisical-secrets`, ADR 0021 slice 1.1). There are no `.env.dev`, `.env.stage`
or prod `.env` files any more. Every `make dev-*`, `stage-*` and `prod-*` target that runs compose
goes through `docker/scripts/compose-run.mjs`. That script:

1. logs in to Infisical's HTTP API once;
2. fetches that stack's environment into memory;
3. checks every name and value;
4. runs the guards and `docker compose` with an environment built only from the allowed keys.

Nothing is written to disk. No secret is put on a command line or read by a shell.

## Requirements on each host

- **Node 22.12 or newer on `PATH`** when you run `make`. The Makefile resolves `node` from your
  `PATH`, then runs it under `env -i`. No `npm ci` is needed, because the wrapper uses only
  built-in modules.
- **Network access to Infisical.** Today that is `https://192.168.0.100`, reachable on the LAN
  and over Tailscale.
- **The CA certificate that Infisical's TLS chains to.** Today that is
  `~/infisical/infisical-root-ca.crt`. Node does not use the system trust store, so the path is
  required even if the CA is installed system-wide. The file must be a regular file, not a
  symlink, not writable by group or others, and at most 64 KiB.

## The credentials file

Each host holds one untracked file per environment it runs, at the repo root:
`.env.infisical.dev`, `.env.infisical.stage` or `.env.infisical.prod`.

```bash
cp docker/infisical-credentials.example .env.infisical.dev
chmod 600 .env.infisical.dev
$EDITOR .env.infisical.dev
```

| Key | Value |
| --- | --- |
| `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID` / `..._CLIENT_SECRET` | That environment's machine identity (universal auth) |
| `INFISICAL_PROJECT_ID` | The Infisical project |
| `INFISICAL_DOMAIN` | A bare `https://host[:port]` origin, with no path |
| `INFISICAL_CA_FILE` | Absolute path of the CA certificate |

The wrapper refuses the file if any of these hold:
- it is a symlink;
- it is not owned by you;
- it is readable or writable by group or others;
- a key is missing;
- the domain is not a bare `https` origin.

The file is git-ignored (`.env.*`), and agents are denied reading it with the Read tool.

Moving Infisical to another host means editing `INFISICAL_DOMAIN` and `INFISICAL_CA_FILE` in
these files. No repo change is needed.

## What goes in each Infisical environment

An environment may hold only these keys:
- the container keys listed in `docker/secrets-env.yaml`;
- that environment's compose keys:

  | Environment | Compose keys |
  | --- | --- |
  | `dev` | `DEV_PORT`, `DEV_COMPANION_PORT` |
  | `stage` | `STAGE_PORT` |
  | `prod` | `ROUTER_PORT`, `WEB_TAG`, `API_TAG`, `PUBLIC_BASE_URL` |

Any other name is refused before anything runs, and the error names the key without printing its
value. That includes `LD_PRELOAD`, `DOCKER_HOST`, any `COMPOSE_*` name, and a key meant for
another service.

Other rules:
- **Tags.** `WEB_TAG` and `API_TAG` are the 12-character git SHA that `make prod-push` prints.
  `latest` is refused.
- **Required prod keys.** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `ADMIN_TOKEN`, plus
  `API_TOKEN` if Companion is used (at least 32 random bytes).
- **Never reuse prod secrets in dev or stage.** Use separate, low-limit keys and separate OAuth
  clients.
- **Ports are set in Infisical.** `DEV_PORT=9000 make dev-up` no longer overrides them, because
  the wrapper builds the child environment from Infisical only.
- **Imports and `${...}` references are not used.** The fetch passes `includeImports=false` and
  `expandSecretReferences=false`, so store plain values.
- **Every value must be readable by the identity.** A value the identity can list but not read
  arrives as `<hidden-by-infisical>`, and the wrapper refuses it.

To add a container key:
1. Add a line `KEY:` to `docker/secrets-env.yaml`. `make check` invariant 15 keeps compose in
   step with that file.
2. Set the key in Infisical.

## Identity hardening

Each environment is its own Infisical project (`autologger-dev`, `autologger-stage`,
`autologger-prod`) holding only that environment. Each project has one machine identity, created
inside it, with the built-in `viewer` role. The free plan has no custom roles, so separate projects
are what keep the dev identity away from prod. Configure each identity (universal auth) as follows.

| Setting | Value |
| --- | --- |
| Access | `viewer` on its **own** project only. The dev identity must not read `stage` or `prod`. |
| Access-token TTL | 15 minutes, with a maximum TTL of 1 hour |
| Trusted IPs | Set on both the client secret and the access token, limited to the hosts that run that stack |
| Client secret | Rotate when a host is decommissioned, and at least yearly |

To check that the dev identity can't read prod, on a host that holds no prod credentials:
1. Copy `.env.infisical.dev` to `.env.infisical.prod`, and set `INFISICAL_PROJECT_ID` in the copy
   to the prod project's ID.
2. Run `make prod-check`. It must fail with `HTTP 403` or `HTTP 404`.
3. Delete the copy.

## Commands

| Command | What it does |
| --- | --- |
| `make dev-up`, `make stage-up` | Log in, fetch, check the resolved config, then `compose up` |
| `make prod-check` | Prod dry run on any branch: log in, fetch, guards, `compose config`. Starts nothing. Run it on the deploy host before cutover. |
| `make prod-up`, `make prod-pull` | Clean `main` only |
| `make dev-reset CONFIRM=yes`, `make stage-reset CONFIRM=yes` | Reset. Refused for prod. |

## What the wrapper protects against

- **Your shell's Node settings can't change the wrapper.** The Makefile runs it under `env -i`,
  so `NODE_OPTIONS`, `NODE_DEBUG`, `NODE_TLS_REJECT_UNAUTHORIZED` and proxy variables never reach
  it, and it refuses to start if they are present anyway.
- **TLS is always verified,** with `rejectUnauthorized: true` against your CA file only.
- **Responses are strict:** exactly HTTP 200, no redirects, 15 s to connect, 30 s in total, a
  1 MiB cap, and no compression.
- **Error messages never contain a value.** Parse errors and crashes print a fixed message, and
  Infisical's own error message is stripped of control characters and cut to 200 characters.
- **The whole fetch is refused on any bad secret:** a non-string value, a duplicate key, a NUL
  byte, an invalid or disallowed name, a hidden value, or an empty environment.
- **Steps stop at the first failure.** SIGTERM and SIGHUP are forwarded to compose.

## Break-glass: Infisical is unreachable

- **Running containers are unaffected.** They keep the environment they started with.
- **Stopping prod needs no secrets:**
  `docker stop autologger-router autologger-web autologger-api`.
- **Starting or restarting needs Infisical.** Otherwise the only way is to revert the
  `infisical-secrets` change on a checkout and use a temporary `.env` file.
- **Don't delete the old env files too early.** Keep `.env.dev`, `.env.stage` and prod's `.env`
  until this change is on `main` and an Infisical backup has been restored successfully. Without
  Infisical's `ENCRYPTION_KEY` (kept off-host, see `~/infisical/README.md`), a backup can't be
  restored.
- **An Infisical `make reset` issues a new CA.** Re-export it and point `INFISICAL_CA_FILE` at
  the new file.
