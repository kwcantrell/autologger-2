# Design

## Context

- **What runs the server.** The dev stack runs `CMD ["npm","run","dev"]`: root `dev` calls
  server `dev`, which runs `tsx watch … src/main.ts`. The api image runs `tsx src/main.ts`. No
  container, test, script or CI step runs `npm run start` or the root `build` (A7).
- **The sentinel.** `AUTOLOGGER_STACK` reaches every app container from
  `docker/secrets-env.yaml` (A1). Its values match `compose-run.mjs`'s environments
  (`dev`, `stage`, `prod`).
- **`tsx watch` stays alive after its child exits** (A2). Its restarts wait for, or SIGKILL, the
  old child before starting the new one (A8).
- **`createBindings` does a lot before `serve()`.** It creates subdirectories, migrates the
  catalog, purges KV, sweeps `youtube-import-*` scratch, and starts sweepers. A second server on
  a live `DATA_DIR` would do all of that before failing on the port.
- **`HOST` is read in two places.** `config.ts` stores `HOST: procEnv.HOST || ''`, and
  `env.ts` `loopbackHostname()` treats `''` as `0.0.0.0`. `main.ts` binds
  `process.env.HOST || '0.0.0.0'`.
- **`copyDataDir.ts` (the documented live backup) copies every `*.db` under `DATA_DIR`.**

## Goals / Non-Goals

**Goals:**
- **No accidental host boot.** The server can't start on the host by accident, use an implicit
  data directory, read `server/.env`, or share a data directory with another server.
- **One effective host.** The address the server binds is the one its loopback checks believe.
- **Docs, AGENTS.md and the Cursor rule** describe only stack-based dev.

**Non-Goals:** as in proposal.md. The guard stops accidents, not an operator who deliberately
fakes the sentinel. Even then, the lock, the absolute `DATA_DIR` and the loopback default still
apply.

## Decisions

### D1. Boot guard

- **`server/src/node/bootGuard.ts`** exports `STACKS = ['dev','stage','prod']` and
  `checkBootEnv(env): string | null`. The rules:
  - `AUTOLOGGER_STACK ∈ STACKS`;
  - `DATA_DIR` is set and `path.isAbsolute`.

  Messages name variables and `make dev-up` only, never values.
- **`main.ts`** calls it as its first statement: print to stderr, exit 1. Its static imports have
  no module-scope side effects (A4).
- **`createBindings` also throws** on a missing or relative `DATA_DIR`. This is defence in depth
  for any caller. The `'./data'` fallback is removed.
- **`server/src/node/bootGuardCli.ts`** runs `checkBootEnv`, then probes the lock (D2: acquire,
  then release). The dev script runs it before `tsx watch`, so a second `npm run dev` in the
  container exits 1 instead of starting a stray watcher.
- **`docker/secrets-env.yaml`**: the sentinel comment now says the server refuses to boot without
  it.
- **Tests first:**
  - `bootGuard.test.ts`: sentinel unset, empty or `x`; `DATA_DIR` unset or relative; the message
    contains no value; `STACKS` equals `compose-run.mjs`'s `ENVS`.
  - `bootOrder.int.test.ts`: spawns `tsx src/main.ts` under `env -i PATH=…` in a temp cwd.
    - Without the sentinel: exit 1, the message, and no `data/` created.
    - With the sentinel and `DATA_DIR=relative`: exit 1 naming `DATA_DIR`.
  - `config.test.ts`: `createBindings({})` and `createBindings({DATA_DIR:'rel'})` throw.

### D2. One server per `DATA_DIR`: `acquireDataDirLock(dir)` in `@autologger/storage`

The lock is SQLite's own exclusive file lock, held for the process lifetime.

1. `mkdirSync(dir, {recursive:true})`, so a missing `DATA_DIR` is created as today rather than
   failing opaquely.
2. Open `join(dir, '.server.lock')` with `new Database(file, { timeout: 0 })`.
   - The name has no `.db` suffix, so `copyDataDir.ts` (which copies `*.db`) never opens it, and
     a live backup keeps working.
   - `timeout: 0`: better-sqlite3 defaults to 5000 ms, so refusal would otherwise be 5 s late.
3. If `db.readonly`, throw. A file the process can't write would otherwise take only a READ lock
   and "succeed" twice.
4. `PRAGMA locking_mode=EXCLUSIVE`, `BEGIN EXCLUSIVE`, then one write (`PRAGMA user_version=1`).
   That makes the exclusive lock real, and fails a read-only open with `SQLITE_READONLY`.
5. Keep the handle in a module-level `Set`, so garbage collection can't close it and silently drop
   the lock.
6. On `SQLITE_BUSY`, throw `DataDirLockedError(dir)`.
7. `release()` deletes the handle from the set and closes the connection. Closing is required:
   a rollback alone keeps an EXCLUSIVE-mode lock.

**Ordering.** `createBindings` calls the lock first: before any `mkdirSync` of subdirectories,
`openCatalogDb`, migrations or sweeps. `close()` releases it.

**Comment at the function.** It warns about POSIX `fcntl` semantics: any other open and close of
the lock file in the same process drops the lock. Nothing in the server walks the `DATA_DIR`
root, and nothing may.

**Assumption:** local volume drivers (ext4 here), not NFS.

**Tests first:**
- **Storage tests:**
  - a second acquire in-process throws `DataDirLockedError` within 100 ms;
  - after `release()`, an acquire succeeds;
  - a child process holding the lock, SIGKILLed, frees it;
  - a child run with `--expose-gc` acquires, calls `gc()`, and still holds the lock against a
    second child;
  - a read-only (chmod 444) lock file is refused;
  - a missing directory is created.
- **Server integration test:** hold the lock, plant `tmp/youtube-import-x`, call
  `createBindings`, and expect `DataDirLockedError`. The planted directory survives, and no
  `catalog.db` is created.
- **Live check (task 3.1):** first a data-free lock probe in the dev container (acquire `/data`,
  expect refusal), and only then `main.ts`.

### D3. Effective host, scripts

- **`HOST` is resolved once in `createBindings`:**
  `procEnv.HOST || (procEnv.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1')`.
  `main.ts` binds `bindings.config.HOST`. Test: with `HOST` unset and `NODE_ENV` unset,
  `loopbackHostname(config)` is true.
- **`server/package.json`:**
  - `dev` becomes `tsx src/node/bootGuardCli.ts && NEXT_TELEMETRY_DISABLED=1 tsx watch --exclude "../web/**" --exclude "../web/.next/**" src/main.ts`;
  - `start` is removed;
  - `merge-audio` and `capture:deepgram-fixture` drop `--env-file-if-exists=.env`.
- **Root `package.json`:** `build` and `start` are removed.
- **`merge-session-audio.ts`:**
  - requires `--data-dir` or `DATA_DIR`, with no `../data` fallback;
  - the header says to run it in the dev stack with `--out /tmp/<name>` (container scratch,
    never the data volume), then `docker cp`.
- **`capture-deepgram-fixture.mjs`:** the header and the error message say to run it on the host,
  since its fixtures aren't in the image. The key is entered with a hidden prompt
  (`read -rs DEEPGRAM_API_KEY; export DEEPGRAM_API_KEY`), never typed inline into history.
- **`main.ts:45`:** the warning becomes "frontend not built (serving API only)".
- **Repo test `server/src/hostDev.repo.test.ts`:** no `package.json` script contains
  `--env-file`, and server `dev` invokes `bootGuardCli`.

### D4. Docs (README capped at about 120 changed lines; pointers over prose)

- **README sections:**
  - **Env table** (871-880): `DATA_DIR` is required and absolute, with no default. Values come
    from Infisical. `server/.env.example` is the reference.
  - **Quick start** (914-943): `make dev-up`, with prerequisites in docs/infisical-secrets.md.
    The "Verify the contract" curls are shortened to a pointer.
  - **Container deployment** (947, 979, 1055) and the `ADMIN_TOKEN=<from .env>` line (1361).
  - **Frontend:** "`npm run build` runs `next build`" (1612).
  - **Dev flow** (1734-1776):
    - `make dev-up`, `make dev-restart`, `make dev-logs`;
    - dev auth is anonymous by the stack's pins;
    - LAN device testing is unavailable during the migration;
    - `npm test` and `npm run typecheck` still run on the host.
  - **Companion** `API_TOKEN` (1824): set in Infisical, then `make dev-up`.
- **AGENTS.md:** a pointer line, "**Dev runs in the dev stack** (`make dev-up`); the server
  refuses to boot on the host. `npm test`/`npm run typecheck` still run on the host. LAN device
  testing is unavailable during the migration."
- **`.cursor/rules/restart-server-yourself.mdc`:**
  - restart via `make dev-restart`, which fetches the stack's secrets from Infisical and restarts
    the app, Companion and both gates;
  - if it fails, stop and ask; never `docker restart` or `docker exec` a server;
  - never start a server by hand.
- **`server/.env.example`:**
  - line 1 says this is the variable reference; nothing reads `server/.env`; values live in
    Infisical;
  - `DATA_DIR=/data` and `HOST`, with comments that compose pins them.
- **ADR 0021:** 1.4b done. **ADR 0022:** the follow-up notes `server/.env.example` is kept.
- **`packages/ai-runtime` comments** about a `./data` default are fixed.

### D5. Contract

Boot refusal, the lock and the `HOST` default change no route, JSON shape, status code, header
semantics or WebSocket message. The README endpoint table is untouched, and no
`api-contract-freeze` delta is needed. The open-network predicates keep their frozen definition
("non-loopback bind") and now read the effective host.

## Assumptions

| # | Assumption | Command | Observed |
|---|---|---|---|
| A1 | `AUTOLOGGER_STACK` reaches the app containers | `docker exec … printenv` | dev-app `dev`, stage-api `stage`; prod api extends the same file, with `:?` |
| A2 | `tsx watch` stays alive after its child exits 1; `guard && tsx watch` propagates through `npm run dev` | panel: scratch workspace | `exit=124` alone; with a failing guard: `npm error … exit=1` in 0.25 s |
| A3 | Every `createBindings` caller passes an absolute temp `DATA_DIR` and closes before a reboot | panel: grep of callers | `harness.ts:49`, `migrations.int.test.ts` (`first.close()`), `youtubeImport.int.test.ts` (`boot.close()`), `config.test.ts` (`mkdtemp`) |
| A4 | `main.ts`'s static imports have no module-scope side effects | panel: import under `env -i` in an empty cwd | `imported; handles= 0 []`, no files created |
| A5 | The SQLite EXCLUSIVE lock blocks other connections and processes, and is released by close or SIGKILL | panel: `lock.cjs` | in-process `SQLITE_BUSY`; child `SQLITE_BUSY` (1 ms with `timeout:0`, 5008 ms by default); after `kill -9`: `ACQUIRED`; rollback without close still holds |
| A6 | Garbage collection drops an unreferenced lock, and a read-only file takes only a READ lock | panel: `lk4.mjs` | GC case: `locks=0`, second `LOCK OK`; `chmod 444`: `POSIX ADVISORY READ`, second `LOCK OK` |
| A7 | Nothing uses root `build`/`start` or server `start` | panel: Dockerfile, Makefile, CI, scripts | none |
| A8 | `tsx watch` restarts don't race the lock | panel: 2 s and 8 s slow shutdowns | the new child gets the lock every time (SIGKILL after a second change) |
| A9 | A `.db`-named lock breaks the live backup; a non-`.db` name doesn't | panel: held lock, then `copyDataDir.ts` | `FAIL .server-lock.db: database is locked`, exit 1; non-`.db` files are not scanned (copier globs `*.db`) |

## Risks / Trade-offs

- **[A faked sentinel on the host]** → The lock, the absolute `DATA_DIR` and loopback still apply.
- **[Single-process production is unexercised]** → Owner decision: follow-up change
  `retire-single-process-prod`. The integration tests cover the bridge with injected factories
  only, not a real production build (corrected from the first draft).
- **[LAN device testing is unavailable]** → Owner decision: follow-up to make stage
  proxy-ready (public URL, Secure cookies, its own OAuth client, Pangolin route). Exposing stage
  data is decided then.
- **[An open and close of the lock file in-process drops it]** → Commented at the function.
  Nothing walks the `DATA_DIR` root.
- **[The lock file's inode replaced while held]** (for example, `rsync --delete` of `DATA_DIR`)
  → Restores require the api stopped. Documented in docs.
- **[The prod `api` must carry the sentinel]** → The cutover runbook checks
  `docker inspect autologger-api` for the variable name.

## Migration Plan

1. Merge. On this host, rebuild and restart dev and stage.
2. Owner: confirm `server/.env` values are in Infisical, then delete `server/.env`.
3. Cutover: confirm the prod `api` has `AUTOLOGGER_STACK`.
4. Rollback: revert the PR. `.server.lock` files left in data directories are harmless.
