#!/usr/bin/env node
// Stops any local AutoLogger dev processes by killing whatever is listening on
// the dev ports: the Node server (:8787, single-process dev — nextjs-frontend-
// migration, task 3.4) and the hermetic Playwright servers (:8791, :8792). Extra
// ports may be passed as arguments.
//
// SIGTERM first, then SIGKILL for anything that survives the grace period.
import { execFileSync } from 'node:child_process';

const DEFAULT_PORTS = [
  Number(process.env.PORT || '8787'), // server (server/src/main.ts) — dev is single-process
  8791, // e2e server (playwright.config.ts)
  8792, // e2e login-gate server (playwright.config.ts)
];

const extra = process.argv.slice(2).map(Number);
const badPort = extra.find((p) => !Number.isInteger(p) || p < 1 || p > 65535);
if (badPort !== undefined) {
  console.error(`teardown: not a valid port: ${badPort}`);
  process.exit(2);
}

const ports = [...new Set([...DEFAULT_PORTS, ...extra])];

/** Run a command, returning stdout; null when the command fails or is absent. */
function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/** PIDs listening on `port`. Uses lsof (macOS + Linux), falls back to ss. */
function listenersOn(port) {
  const pids = new Set();

  const lsof = run('lsof', ['-nP', '-tiTCP:' + port, '-sTCP:LISTEN']);
  if (lsof !== null) {
    for (const line of lsof.split('\n')) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
    return pids;
  }

  const ss = run('ss', ['-lptnH', `sport = :${port}`]);
  if (ss !== null) {
    for (const match of ss.matchAll(/pid=(\d+)/g)) pids.add(Number(match[1]));
    return pids;
  }

  console.error(`teardown: neither lsof nor ss available — cannot inspect :${port}`);
  return pids;
}

function signal(pid, sig) {
  try {
    process.kill(pid, sig);
    return true;
  } catch (err) {
    // ESRCH: already gone (often a child that died with its parent).
    if (err.code !== 'ESRCH') console.error(`teardown: ${sig} ${pid} failed: ${err.message}`);
    return false;
  }
}

const alive = (pid) => signal(pid, 0);

const targets = new Map(); // pid -> ports it was listening on
for (const port of ports) {
  for (const pid of listenersOn(port)) {
    if (pid === process.pid) continue;
    const seen = targets.get(pid) ?? [];
    seen.push(port);
    targets.set(pid, seen);
  }
}

if (targets.size === 0) {
  console.log(`teardown: nothing listening on ${ports.join(', ')}`);
  process.exit(0);
}

for (const [pid, on] of targets) {
  console.log(`teardown: SIGTERM ${pid} (:${on.join(', :')})`);
  signal(pid, 'SIGTERM');
}

// Give them a moment to shut down cleanly before escalating.
const deadline = Date.now() + 3000;
while (Date.now() < deadline && [...targets.keys()].some(alive)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
}

for (const pid of targets.keys()) {
  if (!alive(pid)) continue;
  console.log(`teardown: SIGKILL ${pid}`);
  signal(pid, 'SIGKILL');
}

const survivors = [...targets.keys()].filter(alive);
if (survivors.length > 0) {
  console.error(`teardown: still running after SIGKILL: ${survivors.join(', ')}`);
  process.exit(1);
}
console.log(`teardown: stopped ${targets.size} process(es)`);
