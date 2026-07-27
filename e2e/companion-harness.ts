// Helpers for the binary-gated headless-Companion e2e harness (companion.e2e.spec.ts).
// Launches a real Bitfocus Companion 4.3.4 headless instance on an isolated
// admin port + config dir, loading this repo's autologger module via
// --extra-module-path, so the module's admin-UI connection flow can be
// exercised against the real Companion UI.
//
// Why we stage a *packaged* copy of the module instead of pointing
// --extra-module-path straight at the repo (as originally sketched in the
// task brief): Companion spawns each module's child process with Node's
// permission model locked to `--allow-fs-read=<module dir>` only. This repo
// is an npm *workspace*, so most of @companion-module/base's transitive deps
// (tslib, ejson, nanoid, ...) get hoisted to the workspace-root
// node_modules — outside that sandboxed read path — and the raw `tsc`
// output (companion/dist/main.js) crashes on require() with ERR_ACCESS_DENIED
// (verified empirically; see task-9-report.md). `npm run package -w companion`
// (the module's own official `companion-module-build` packaging script) esbuild
// -bundles main.js into a single dependency-free file specifically to avoid
// this class of problem, which is exactly what's needed here. The only extra
// step is a stub `node_modules/@companion-module/base/package.json` — Companion's
// ProcessManager does its own `require.resolve('@companion-module/base/package.json',
// {paths:[basePath]})` version-compat probe independent of the bundle, and
// wants that file resolvable from the module dir even though the bundled
// code no longer imports it at runtime.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

// Single source of truth for the local Companion install location (also
// consumed by playwright.config.ts's project gating). Override with the
// COMPANION_DIR env var; the default matches this machine's install.
export const COMPANION_DIR =
  (process.env.COMPANION_DIR || '').trim() || '/home/kalen/companion-x64';
export const COMPANION_LAUNCHER = join(COMPANION_DIR, 'companion_headless.sh');

/** True when the local Companion install is present (harness is skipped otherwise). */
export function companionAvailable(): boolean {
  return existsSync(COMPANION_LAUNCHER);
}

/**
 * Build the packaged (bundled) module and stage it into `<dir>/autologger`
 * with a stub `@companion-module/base` package.json, laid out the way
 * Companion's `loadInfoForModulesInDir` scanner expects: `--extra-module-path`
 * points at `dir`, whose immediate children are module folders each holding
 * `companion/manifest.json` + the entrypoint referenced from it.
 */
function stagePackagedModule(companionWorkspaceDir: string, stageDir: string): void {
  execFileSync('npm', ['run', 'package'], { cwd: companionWorkspaceDir, stdio: 'pipe' });
  const tgz = join(companionWorkspaceDir, 'autologger-0.1.0.tgz');
  const moduleDir = join(stageDir, 'autologger');
  mkdirSync(moduleDir, { recursive: true });
  try {
    execFileSync('tar', ['xzf', tgz, '-C', moduleDir, '--strip-components=1'], { stdio: 'pipe' });
  } finally {
    // The build artifact is gitignore'd (companion/.gitignore: pkg/, *.tgz) but
    // don't leave it sitting in the tracked companion/ workspace dir across runs.
    execFileSync('rm', ['-f', tgz]);
    execFileSync('rm', ['-rf', join(companionWorkspaceDir, 'pkg')]);
  }

  // Historical note (see task-9-report.md / task-9_5-report.md): `npm run
  // package`'s manifest.runtime.apiVersion used to come out WRONG in this repo.
  // `companion-module-build` (from @companion-module/tools) resolves the
  // framework package via plain require.resolve('@companion-module/base') from
  // its own location — which is root node_modules (npm workspaces hoist
  // @companion-module/tools there). Root used to also carry its own hoisted,
  // *different-major* @companion-module/base (2.0.4, pulled in transitively by
  // tools' own deps), shadowing the workspace's explicitly pinned ~1.14.0
  // (companion/node_modules/@companion-module/base@1.14.1 — the version
  // companion/src/*.ts actually imports types from and is compiled against).
  // Symptom verified empirically: staging the as-built manifest (apiVersion
  // "2.0.4") made Companion pick the v2 nodejs-ipc host (ConnectionThread.js)
  // for a module whose bundled code still speaks the v1
  // runEntrypoint()/HostApiNodeJsIpc protocol, and Companion logged "Module
  // entrypoint did not return a valid constructor function" — i.e. the
  // manifest's declared API version, not the code, was stale/wrong.
  //
  // Root-caused via a root-level npm `overrides` entry (package.json) pinning
  // @companion-module/base to ~1.14.0 workspace-wide, so the hoisted copy
  // `companion-module-build` resolves now matches the pinned one — `npm run
  // package -w companion` alone now produces a correct manifest. This
  // post-build rewrite is kept as a defense-in-depth belt-and-suspenders (it's
  // a no-op once the override holds) in case the override is ever removed or a
  // future dependency bump re-introduces hoisting drift.
  //
  // Resolve via require.resolve (not a hardcoded companion/node_modules path)
  // because the override now fully dedupes @companion-module/base to a single
  // copy — hoisted to the workspace ROOT node_modules, same as what
  // `companion-module-build` itself resolves — so there is no
  // companion/node_modules/@companion-module/base directory to read anymore.
  const localBaseVersion = (
    JSON.parse(readFileSync(require.resolve('@companion-module/base/package.json'), 'utf-8')) as {
      version: string;
    }
  ).version;

  const manifestPath = join(moduleDir, 'companion', 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
    runtime: { apiVersion: string };
  };
  manifest.runtime.apiVersion = localBaseVersion;
  writeFileSync(manifestPath, JSON.stringify(manifest));

  const stubDir = join(moduleDir, 'node_modules', '@companion-module', 'base');
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(
    join(stubDir, 'package.json'),
    JSON.stringify({ name: '@companion-module/base', version: localBaseVersion }),
  );
}

/** Reserve an ephemeral loopback port (close before handing it to Companion). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export interface CompanionHandle {
  adminUrl: string;
  proc: ChildProcess;
  configDir: string;
  stageDir: string;
  stop(): Promise<void>;
}

/**
 * Launch Companion headless on an isolated config dir + per-run admin port,
 * loading a freshly-built, packaged copy of the repo's autologger module
 * (see stagePackagedModule() for why it must be packaged rather than raw
 * tsc output). `companionWorkspaceDir` is the `companion/` npm workspace
 * (contains package.json with a `package` script + companion/manifest.json).
 */
export async function launchCompanion(companionWorkspaceDir: string): Promise<CompanionHandle> {
  const adminPort = await freePort();
  const configDir = await mkdtemp(join(tmpdir(), 'companion-e2e-'));
  const stageDir = await mkdtemp(join(tmpdir(), 'companion-e2e-module-'));
  stagePackagedModule(companionWorkspaceDir, stageDir);

  const proc = spawn(
    COMPANION_LAUNCHER,
    [
      '--admin-address',
      '127.0.0.1',
      '--admin-port',
      String(adminPort),
      '--config-dir',
      configDir,
      '--extra-module-path',
      stageDir,
      '--disable-admin-password',
    ],
    // companion_headless.sh is a bash wrapper that execs a further `node
    // main.js` *without* `exec`, so SIGTERM to this process alone doesn't
    // reliably reach the real Companion process (verified empirically: two
    // node main.js processes outlived their supposedly-torn-down harness
    // runs — see task-9-report.md). `detached: true` puts the whole
    // wrapper+child tree in its own process group so stop() can signal the
    // group (negative PID) instead of just the wrapper PID.
    { stdio: 'pipe', cwd: COMPANION_DIR, detached: true },
  );

  let stdout = '';
  let stderr = '';
  proc.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const adminUrl = `http://127.0.0.1:${adminPort}`;

  // stop() is defined before the readiness wait so a failed launch can still
  // be torn down cleanly by the caller.
  const stop = async (): Promise<void> => {
    if (proc.exitCode === null && proc.signalCode === null && proc.pid !== undefined) {
      // Negative PID = signal the whole detached process group (wrapper
      // script + the real `node main.js` it spawns), not just the wrapper.
      try {
        process.kill(-proc.pid, 'SIGTERM');
      } catch {
        // Group may already be gone.
      }
      const died = await new Promise<boolean>((r) => {
        const t = setTimeout(() => r(false), 5000);
        proc.once('exit', () => {
          clearTimeout(t);
          r(true);
        });
      });
      if (!died) {
        try {
          process.kill(-proc.pid, 'SIGKILL'); // hard-kill fallback (see spec teardown)
        } catch {
          // Group may already be gone.
        }
      }
    }
    await Promise.all([
      rm(configDir, { recursive: true, force: true }),
      rm(stageDir, { recursive: true, force: true }),
    ]);
  };

  try {
    await waitForHttp(`${adminUrl}/`, 30000);
  } catch (err) {
    await stop();
    throw new Error(
      `${(err as Error).message}\n--- companion stdout ---\n${stdout}\n--- companion stderr ---\n${stderr}`,
    );
  }

  return { adminUrl, proc, configDir, stageDir, stop };
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Companion admin UI did not come up at ${url}`);
}

/** Seed a session on the hermetic server and simulate a visible browser presence for it. */
export async function seedActiveSession(serverBase: string): Promise<string> {
  // POST /api/sessions requires show_id + episode (not just title); pull the
  // active show off the profile endpoint rather than hardcoding a show id.
  const profileRes = await fetch(`${serverBase}/api/profile`);
  if (!profileRes.ok) throw new Error(`fetch profile failed: ${profileRes.status}`);
  const profile = (await profileRes.json()) as { active_show_id: string | null };
  if (!profile.active_show_id) throw new Error('seed session failed: no active_show_id on profile');

  const created = await fetch(`${serverBase}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'E2E Session', show_id: profile.active_show_id, episode: '1' }),
  });
  if (!created.ok) throw new Error(`seed session failed: ${created.status}`);
  const sid = ((await created.json()) as { id: string }).id;
  const presence = await fetch(`${serverBase}/api/companion/presence`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: 'e2e-browser', session_id: sid, visible: true }),
  });
  if (!presence.ok) throw new Error(`seed presence failed: ${presence.status}`);
  return sid;
}
