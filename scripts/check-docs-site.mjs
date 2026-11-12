#!/usr/bin/env node
// Checks the generated end-user docs site in docs-site/ (written by the docs-writer agent,
// see .claude/agents/docs-writer.md and .claude/skills/generate-docs/SKILL.md).
//
// Usage: node scripts/check-docs-site.mjs [--site <dir>] [--specs <dir>]
//   defaults: <repo>/docs-site and <repo>/openspec/specs
// Exits 0 when the site passes, 1 with one line per problem otherwise.
// Node built-ins only. Tests: scripts/check-docs-site.test.mjs (part of the root `npm test`).
//
// Rules:
//   a. every directory in the specs dir is in manifest.json, and the manifest names no other spec
//   b. every page named in the manifest exists and is linked from index.html
//   c. every relative link or asset reference in every page (and stylesheet) resolves to a file
//      inside the site
//   d. no page loads a script or references an external stylesheet, script, font or image
//   e. every feature page has a <title> and a heading containing "How to"
//   f. no page contains source paths (server/src, web/src, packages/) or KEY= config lines

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i; // http://, https://, //host
const SCHEME = /^[a-z][a-z0-9+.-]*:/i; // mailto:, tel:, data:, http:, ...
const SOURCE_PATH = /\b(?:server\/src|web\/src)\b|(?<![\w-])packages\//;
const ENV_ASSIGNMENT = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]*=/;

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else if (entry.isFile()) out.push(relative(base, full).split(sep).join('/'));
  }
  return out.sort();
}

function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

/** Every tag in the HTML as { name, attrs } with lower-cased names. */
function parseTags(html) {
  const tags = [];
  const tagRe = /<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g;
  const attrRe = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const m of html.matchAll(tagRe)) {
    const attrs = {};
    for (const a of m[2].matchAll(attrRe)) {
      attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
    }
    tags.push({ name: m[1].toLowerCase(), attrs });
  }
  return tags;
}

/** url(...) and @import targets inside CSS text. */
function cssRefs(css) {
  const refs = [];
  for (const m of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi)) {
    refs.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  for (const m of css.matchAll(/@import\s+(?:"([^"]*)"|'([^']*)')/gi)) refs.push(m[1] ?? m[2]);
  return refs.filter((r) => r !== '');
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/** Resolve a relative reference from a file in the site; null when it is not a local file ref. */
function localTarget(siteDir, fromFile, ref) {
  const clean = decodeEntities(ref.trim());
  if (clean === '' || clean.startsWith('#') || EXTERNAL.test(clean) || SCHEME.test(clean)) {
    return null;
  }
  const path = clean.replace(/[?#].*$/, '');
  if (path === '') return null;
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // keep the raw path; it will simply fail to resolve
  }
  const base = decoded.startsWith('/') ? siteDir : dirname(join(siteDir, fromFile));
  return resolve(base, decoded.startsWith('/') ? `.${decoded}` : decoded);
}

function isInside(siteDir, target) {
  const rel = relative(resolve(siteDir), target);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel);
}

function resolvesToFile(siteDir, target) {
  if (!isInside(siteDir, target) || !existsSync(target)) return false;
  const st = statSync(target);
  if (st.isFile()) return true;
  return st.isDirectory() && existsSync(join(target, 'index.html'));
}

function checkManifest(siteDir, specsDir, errors) {
  const manifestPath = join(siteDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    errors.push('manifest: docs-site/manifest.json is missing');
    return null;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    errors.push(`manifest: manifest.json is not valid JSON (${err.message})`);
    return null;
  }
  const specs = manifest?.specs;
  if (!specs || typeof specs !== 'object' || Array.isArray(specs)) {
    errors.push('manifest: manifest.json must have a "specs" object keyed by spec directory name');
    return null;
  }

  const specDirs = existsSync(specsDir)
    ? readdirSync(specsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    : [];
  if (specDirs.length === 0) errors.push(`manifest: no spec directories found in ${specsDir}`);

  for (const name of specDirs) {
    if (!Object.hasOwn(specs, name)) {
      errors.push(`rule a: spec "${name}" is missing from manifest.json`);
    }
  }
  const pages = new Set();
  for (const [name, entry] of Object.entries(specs)) {
    if (!specDirs.includes(name)) {
      errors.push(`rule a: manifest.json names spec "${name}", which does not exist in openspec/specs`);
    }
    const hasPages = Array.isArray(entry?.pages) && entry.pages.length > 0;
    const hasExcluded = typeof entry?.excluded === 'string' && entry.excluded.trim() !== '';
    if (hasPages === hasExcluded) {
      errors.push(
        `manifest: spec "${name}" must have either a non-empty "pages" list or an "excluded" reason`,
      );
      continue;
    }
    if (hasPages) {
      for (const page of entry.pages) {
        if (typeof page !== 'string' || !page.endsWith('.html')) {
          errors.push(`manifest: spec "${name}" lists ${JSON.stringify(page)}, not an .html page`);
        } else {
          pages.add(page);
        }
      }
    }
  }
  return [...pages].sort();
}

function checkIndexLinks(siteDir, featurePages, errors) {
  const indexPath = join(siteDir, 'index.html');
  if (!existsSync(indexPath)) {
    errors.push('rule b: index.html is missing');
    return;
  }
  const linked = new Set();
  for (const tag of parseTags(stripComments(readFileSync(indexPath, 'utf8')))) {
    if (tag.name !== 'a' || tag.attrs.href === undefined) continue;
    const target = localTarget(siteDir, 'index.html', tag.attrs.href);
    if (target) linked.add(target);
  }
  for (const page of featurePages) {
    const target = resolve(siteDir, page);
    if (!isInside(siteDir, target) || !existsSync(target)) {
      errors.push(`rule b: manifest page ${page} does not exist in docs-site/`);
    } else if (!linked.has(target)) {
      errors.push(`rule b: manifest page ${page} is not linked from index.html`);
    }
  }
}

function checkReferences(siteDir, file, refs, errors) {
  for (const { ref, kind } of refs) {
    const target = localTarget(siteDir, file, ref);
    if (target && !resolvesToFile(siteDir, target)) {
      errors.push(`rule c: ${file}: ${kind} "${ref}" does not resolve to a file in docs-site/`);
    }
  }
}

function checkHtmlPage(siteDir, file, errors) {
  const html = stripComments(readFileSync(join(siteDir, file), 'utf8'));
  const tags = parseTags(html);
  const refs = [];

  for (const { name, attrs } of tags) {
    if (name === 'script') {
      errors.push(`rule d: ${file}: loads a script (<script> is not allowed)`);
    }
    for (const attr of ['href', 'src', 'poster', 'data']) {
      if (attrs[attr] !== undefined) refs.push({ ref: attrs[attr], kind: `${name}[${attr}]` });
    }
    if (attrs.srcset !== undefined) {
      for (const candidate of attrs.srcset.split(',')) {
        const url = candidate.trim().split(/\s+/)[0];
        if (url) refs.push({ ref: url, kind: `${name}[srcset]` });
      }
    }
    if (attrs.style !== undefined) {
      for (const r of cssRefs(decodeEntities(attrs.style))) refs.push({ ref: r, kind: 'style url()' });
    }
    for (const [attr, value] of Object.entries(attrs)) {
      if (/^on[a-z]+$/.test(attr)) {
        errors.push(`rule d: ${file}: <${name} ${attr}> runs script (inline handlers not allowed)`);
      }
      if ((attr === 'href' || attr === 'src') && /^\s*javascript:/i.test(value)) {
        errors.push(`rule d: ${file}: <${name} ${attr}> uses a javascript: URL`);
      }
    }
    // External assets: anything but a plain navigation link (<a href>) must be local.
    const assetAttrs = name === 'a' || name === 'area' ? [] : ['href', 'src', 'poster', 'data'];
    for (const attr of assetAttrs) {
      if (attrs[attr] !== undefined && EXTERNAL.test(attrs[attr].trim())) {
        errors.push(`rule d: ${file}: <${name} ${attr}="${attrs[attr]}"> references an external resource`);
      }
    }
    if (attrs.srcset !== undefined && EXTERNAL.test(attrs.srcset.trim())) {
      errors.push(`rule d: ${file}: <${name} srcset> references an external image`);
    }
  }

  for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    for (const r of cssRefs(m[1])) refs.push({ ref: r, kind: 'style url()' });
  }
  for (const { ref, kind } of refs) {
    if (kind.includes('url()') && EXTERNAL.test(ref.trim())) {
      errors.push(`rule d: ${file}: ${kind} "${ref}" references an external resource`);
    }
  }

  checkReferences(siteDir, file, refs, errors);
  checkContent(file, html, errors);
  return html;
}

function checkCss(siteDir, file, errors) {
  const css = readFileSync(join(siteDir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const refs = cssRefs(css).map((ref) => ({ ref, kind: 'url()' }));
  for (const { ref } of refs) {
    if (EXTERNAL.test(ref.trim())) {
      errors.push(`rule d: ${file}: url()/@import "${ref}" references an external resource`);
    }
  }
  checkReferences(siteDir, file, refs, errors);
}

function checkContent(file, html, errors) {
  const source = html.match(SOURCE_PATH);
  if (source) {
    errors.push(`rule f: ${file}: contains a source path ("${source[0]}"); end-user docs must not`);
  }
  const env = html.match(ENV_ASSIGNMENT);
  if (env) {
    errors.push(`rule f: ${file}: contains a config assignment ("${env[0]}"); end-user docs must not`);
  }
}

function checkFeaturePage(file, html, errors) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!title || title[1].trim() === '') errors.push(`rule e: ${file}: has no <title>`);
  const headings = [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) =>
    m[2].replace(/<[^>]*>/g, ''),
  );
  if (!headings.some((h) => /how\s+to/i.test(h))) {
    errors.push(`rule e: ${file}: has no "How to" heading`);
  }
}

/**
 * Check a docs site. Returns a list of human-readable problems; empty means it passes.
 * @param {{ siteDir: string, specsDir: string }} opts
 * @returns {string[]}
 */
export function checkDocsSite({ siteDir, specsDir }) {
  const errors = [];
  if (!existsSync(siteDir) || !statSync(siteDir).isDirectory()) {
    return [`site directory ${siteDir} does not exist`];
  }
  const featurePages = checkManifest(siteDir, specsDir, errors) ?? [];
  checkIndexLinks(siteDir, featurePages, errors);

  const files = listFiles(siteDir);
  const htmlByFile = new Map();
  for (const file of files) {
    if (file.endsWith('.html')) htmlByFile.set(file, checkHtmlPage(siteDir, file, errors));
    else if (file.endsWith('.css')) checkCss(siteDir, file, errors);
    else if (file.endsWith('.js') || file.endsWith('.mjs')) {
      errors.push(`rule d: ${file}: the site must not ship scripts`);
    }
  }
  for (const page of featurePages) {
    const html = htmlByFile.get(page);
    if (html !== undefined) checkFeaturePage(page, html, errors);
  }
  return errors;
}

function parseArgs(argv, repoRoot) {
  const opts = {
    siteDir: join(repoRoot, 'docs-site'),
    specsDir: join(repoRoot, 'openspec', 'specs'),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--site' || arg === '--specs') && argv[i + 1]) {
      opts[arg === '--site' ? 'siteDir' : 'specsDir'] = resolve(argv[++i]);
    } else {
      throw new Error(`unknown argument: ${arg}\nusage: check-docs-site.mjs [--site <dir>] [--specs <dir>]`);
    }
  }
  return opts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2), repoRoot);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const errors = checkDocsSite(opts);
  if (errors.length > 0) {
    console.error(`docs-site check failed (${errors.length} problem(s)):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  const count = listFiles(opts.siteDir).filter((f) => f.endsWith('.html')).length;
  console.log(`docs-site check passed: ${count} page(s) in ${relative(process.cwd(), opts.siteDir) || '.'}`);
}
