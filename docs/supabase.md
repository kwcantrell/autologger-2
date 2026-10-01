# Supabase Postgres in the compose stacks

ADR 0021 slice 1.2a (OpenSpec change `supabase-db`). Each stack (dev, stage, prod) has its own
Supabase Postgres. The other Supabase services (auth, rest, realtime, storage, Studio and a
gateway) come in slice 1.2b. Nothing in the app uses Postgres yet; the catalog moves there in
slice 4.

## Layout

- **`docker/supabase-db.yaml`** defines two services. `docker/scripts/compose-env.sh` adds the
  file to every stack.
  - `db` runs `supabase/postgres`, pinned by digest. It is healthy when `pg_isready` passes.
  - `migrate` is a one-shot runner. `compose up` never starts it.
- **The `db` network.** Each base compose file declares it: internal, with no host address
  (`gateway_mode_ipv4/ipv6: isolated`), on a pinned subnet.

  | Stack | Subnet |
  | --- | --- |
  | dev | `172.28.31.0/24` |
  | stage | `172.28.22.0/24` |
  | prod | `172.28.12.0/24` |

  Only `db` and `migrate` join it. Nothing on the host can connect to Postgres, and no port is
  published. `make check` invariant 16 enforces all of this.
- **Volumes.** `<project>_supabase-db` holds the data and `<project>_supabase-db-config` holds
  the pgsodium root key. **They are one unit.** Back them up, restore them and delete them
  together. A data volume without its config volume silently gets a new root key, and anything
  encrypted with the old one can't be read.
- **The password.** `POSTGRES_PASSWORD` comes from Infisical (see
  [infisical-secrets.md](infisical-secrets.md)). Only `db` and `migrate` receive it. It is the
  password of the `postgres` and `supabase_admin` roles.

## Commands

| Command | What it does |
| --- | --- |
| `make dev-up`, `make stage-up` | Start the stack, then apply migrations |
| `make dev-migrate` | Apply migrations to dev. It starts `db` and waits for it to be healthy. |
| `make dev-psql` | psql in the dev `db` as `postgres`, with no history file |
| `make dev-reset CONFIRM=yes`, `make stage-reset CONFIRM=yes` | **Delete** every volume of that stack, Postgres included |

Nothing migrates prod or opens a shell in it. The compose wrapper refuses `compose run` and
`compose exec` for prod. Prod is migrated by the cutover runbook (ADR 0021, slice 11).

## Writing a migration

- **Name:** `supabase/migrations/<14-digit UTC timestamp>_<name>.sql`, where `<name>` uses
  `a-z`, `0-9` and `_`, for example `20261001120000_catalog_tables.sql`. Each version must be
  unique. The runner refuses the whole directory if any name is wrong, a version repeats, or an
  entry isn't a plain file.
- **One transaction per file.** The runner wraps each file, together with its record in
  `supabase_migrations.schema_migrations`, in one transaction under an advisory lock. Either
  both land or neither does. So a file must not:
  - start a line with a psql meta-command (`\`);
  - start a line with `BEGIN`, `COMMIT`, `ROLLBACK`, `END`, `ABORT`, `SAVEPOINT`, `RELEASE` or
    `START TRANSACTION`. Indent the `BEGIN … END` of a function body;
  - use statements that can't run in a transaction: `CREATE INDEX CONCURRENTLY`, `VACUUM`,
    `ALTER SYSTEM` or `CREATE DATABASE`.
- **Timeouts.** A file waits at most 10 s for a lock and runs for at most 15 minutes.
- **Ordering.** Every unrecorded version runs, in version order, even one older than the newest
  applied version (for example, a branch merged late).
- **Applied files are final.** Editing a file that has already been applied has no effect.
  Write a new migration instead.
- **History table.** It has the Supabase CLI's shape (`version`, `statements`, `name`), so the
  CLI can take over later.

## Rotating `POSTGRES_PASSWORD`

The database keeps the old password until you change it inside Postgres, so do both steps.
This procedure was tested on dev, 2026-09-30.

1. **Set the new value** in that environment's Infisical project: `openssl rand -hex 16`, pasted
   into the UI. Don't print it anywhere else.
2. **Change it in the running database**, which still has the old environment. Using `\password`
   means the value never appears in a statement or a log.
   - Dev: `make dev-psql`, then `\c postgres supabase_admin`, `\password postgres` and
     `\password supabase_admin`, entering the new value each time.
   - Stage: `docker exec -it autologger-stage-db-1 psql -U supabase_admin`, then the same two
     `\password` commands.
   - Prod: the owner runs `docker exec -it autologger-db-1 psql -U supabase_admin` on the deploy
     host, since the wrapper refuses exec for prod.
3. **Restart and check.** Run `make dev-up` (or `make stage-up`). It recreates `db` with the
   new value, and its migrate step fails if the passwords don't match.

**If the old value is lost and the new one doesn't match:**
- Inside the container, `supabase_admin` can still log in over the local socket without a
  password, so step 2 works anyway.
- Infisical's version history also keeps earlier values.
- On dev and stage, a reset is the last resort.
