// docker/verify-node-modules.mjs -- build-time assertion that an image ships the dependency tree
// `npm ci` installed from the lockfile, nested workspace node_modules included (job 019: an image
// that copied only the root node_modules lost packages/transcription/node_modules/undici and
// resolved the hoisted, older undici instead).
//
//   node verify-node-modules.mjs --root /app --lockfile <package-lock.json> [--omit dev,peer]
//
// --root is the image's app dir; its node_modules/.package-lock.json (npm's hidden lockfile)
// records what `npm ci` installed in the deps stage. The check fails when:
//   - an installed entry is missing from the image, or its package.json has another version;
//   - an installed entry's version or integrity differs from the committed lockfile's entry;
//   - a workspace link is missing or does not resolve to its workspace directory;
//   - for a workspace the image ships, the lockfile names a package nested in that workspace's
//     node_modules (and not excluded by --omit, the same flags given to `npm ci`) that the
//     install does not carry.
// Node built-ins only: it runs in every runtime stage, including the media-worker's ffmpeg base.
// The Dockerfiles bind-mount it (never COPY it), so it adds nothing to an image.
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Whether `npm ci --omit=<omit>` leaves a lockfile entry out. */
function omitted(entry, omit) {
  if (omit.has('dev') && entry.dev) return true;
  if (omit.has('optional') && entry.optional) return true;
  if (omit.has('peer') && entry.peer) return true;
  // Optional entries may be skipped for platform reasons (os/cpu); never require them.
  if (entry.optional || entry.devOptional) return true;
  return false;
}

/** Returns a list of problems; empty means the tree under `root` matches. */
export function verifyNodeModules({ root, lockfile, omit = [] }) {
  const problems = [];
  const omitSet = new Set(omit);
  const hiddenPath = join(root, 'node_modules', '.package-lock.json');
  if (!existsSync(hiddenPath)) return [`${hiddenPath} is missing: no npm ci tree to check`];
  const installed = readJson(hiddenPath).packages ?? {};
  const locked = readJson(lockfile).packages ?? {};

  const workspaces = new Set();
  for (const [path, entry] of Object.entries(installed)) {
    if (!path.includes('node_modules/') && !entry.link) workspaces.add(path);
  }

  for (const [path, entry] of Object.entries(installed)) {
    const abs = join(root, path);
    const lock = locked[path];
    if (!lock) {
      problems.push(`${path}: installed but absent from the lockfile`);
      continue;
    }
    if (entry.link) {
      const target = join(root, entry.resolved);
      let real;
      try {
        if (!lstatSync(abs).isSymbolicLink()) throw new Error('not a symlink');
        real = realpathSync(abs);
      } catch {
        problems.push(`${path}: workspace link missing or broken (expected -> ${entry.resolved})`);
        continue;
      }
      if (!existsSync(target) || real !== realpathSync(target)) {
        problems.push(`${path}: link resolves to ${real}, expected ${target}`);
      }
      continue;
    }
    const manifest = join(abs, 'package.json');
    if (!existsSync(manifest)) {
      problems.push(`${path}: missing from the image`);
      continue;
    }
    if (workspaces.has(path)) continue; // workspace dir: present is enough
    const version = readJson(manifest).version;
    if (version !== entry.version) {
      problems.push(`${path}: image has ${version}, npm ci installed ${entry.version}`);
    }
    if (lock.version !== entry.version || (lock.integrity && lock.integrity !== entry.integrity)) {
      problems.push(`${path}: installed ${entry.version} differs from the lockfile's ${lock.version}`);
    }
  }

  for (const ws of workspaces) {
    const prefix = ws === '' ? null : `${ws}/node_modules/`;
    if (!prefix || !existsSync(join(root, ws, 'package.json'))) continue;
    for (const [path, entry] of Object.entries(locked)) {
      if (!path.startsWith(prefix) || entry.link || omitted(entry, omitSet)) continue;
      if (!installed[path]) problems.push(`${path}: in the lockfile for workspace ${ws} but not installed`);
    }
  }
  return problems;
}

function parseArgs(argv) {
  const out = { omit: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') out.root = argv[++i];
    else if (a === '--lockfile') out.lockfile = argv[++i];
    else if (a === '--omit') out.omit = argv[++i].split(',').filter(Boolean);
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.root || !out.lockfile) throw new Error('usage: --root DIR --lockfile FILE [--omit dev,peer]');
  out.root = resolve(out.root);
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = parseArgs(process.argv.slice(2));
  const problems = verifyNodeModules(args);
  if (problems.length) {
    console.error(`node_modules under ${args.root} differs from the lockfile's npm ci tree:`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`node_modules under ${args.root} matches the lockfile's npm ci tree`);
}
