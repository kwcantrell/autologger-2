// Tests for scripts/check-docs-site.mjs.
// Run: node --test scripts/check-docs-site.test.mjs   (part of the root `npm test`)
//
// Each case builds a small fixture site and specs dir in a temp dir, mutates one thing, and checks
// that the matching rule fires. The last cases run the CLI against a fixture and against the
// committed docs-site/ with the real openspec/specs/.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkDocsSite } from './check-docs-site.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const script = join(here, 'check-docs-site.mjs');

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<nav><a href="index.html">Home</a></nav>
<main>
<h1>${title}</h1>
${body}
</main>
</body>
</html>
`;
}

const FEATURE_BODY = `<p>What this feature is for.</p>
<h2>How to use it</h2>
<ol><li>Open the session.</li><li>Press <kbd>1</kbd>.</li></ol>
<p><img src="img/icon.svg" alt=""> <a href="teams.html#roles">Roles</a></p>`;

let root;
let site;
let specs;

function write(rel, content) {
  const full = join(site, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function manifest(specsObj) {
  write('manifest.json', JSON.stringify({ specs: specsObj }, null, 2));
}

function run() {
  return checkDocsSite({ siteDir: site, specsDir: specs });
}

function assertRule(rule, pattern) {
  const errors = run();
  assert.ok(
    errors.some((e) => e.startsWith(`rule ${rule}:`) && pattern.test(e)),
    `expected a rule ${rule} error matching ${pattern}, got:\n${errors.join('\n')}`,
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'check-docs-site-'));
  site = join(root, 'docs-site');
  specs = join(root, 'specs');
  for (const name of ['team-management', 'session-console', 'package-architecture']) {
    mkdirSync(join(specs, name), { recursive: true });
    writeFileSync(join(specs, name, 'spec.md'), `# ${name}\n`);
  }
  write('style.css', 'body { font-family: system-ui, sans-serif; }\n.icon { background: url("img/icon.svg"); }\n');
  write('img/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>\n');
  write(
    'index.html',
    page(
      'AutoLogger help',
      '<ul><li><a href="teams.html">Teams</a></li><li><a href="./logging.html">Logging</a></li></ul>',
    ),
  );
  write('teams.html', page('Teams and roles', `<h2 id="roles">Roles</h2>${FEATURE_BODY}`));
  write('logging.html', page('Live logging', FEATURE_BODY));
  manifest({
    'team-management': { pages: ['teams.html'] },
    'session-console': { pages: ['logging.html', 'teams.html'] },
    'package-architecture': { excluded: 'Developer-only: how the code is split into packages.' },
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('passing fixture', () => {
  it('reports no problems', () => {
    assert.deepEqual(run(), []);
  });

  it('allows external navigation links in <a href>', () => {
    write(
      'logging.html',
      page('Live logging', `${FEATURE_BODY}<p><a href="https://bitfocus.io/companion">Companion</a></p>`),
    );
    assert.deepEqual(run(), []);
  });
});

describe('rule a: manifest covers exactly the spec directories', () => {
  it('fails when a spec directory is missing from the manifest', () => {
    mkdirSync(join(specs, 'show-wiki'));
    assertRule('a', /spec "show-wiki" is missing from manifest\.json/);
  });

  it('fails when the manifest names a spec that does not exist', () => {
    manifest({
      'team-management': { pages: ['teams.html'] },
      'session-console': { pages: ['logging.html'] },
      'package-architecture': { excluded: 'Developer-only.' },
      'no-such-spec': { pages: ['teams.html'] },
    });
    assertRule('a', /names spec "no-such-spec", which does not exist/);
  });

  it('fails when an entry has neither pages nor an excluded reason', () => {
    manifest({
      'team-management': { pages: ['teams.html'] },
      'session-console': { pages: ['logging.html'] },
      'package-architecture': { excluded: '' },
    });
    const errors = run();
    assert.ok(errors.some((e) => /"package-architecture" must have either/.test(e)), errors.join('\n'));
  });
});

describe('rule b: manifest pages exist and are linked from index.html', () => {
  it('fails when a manifest page is missing', () => {
    unlinkSync(join(site, 'logging.html'));
    assertRule('b', /manifest page logging\.html does not exist/);
  });

  it('fails when a manifest page is not linked from index.html', () => {
    write('index.html', page('AutoLogger help', '<ul><li><a href="teams.html">Teams</a></li></ul>'));
    assertRule('b', /manifest page logging\.html is not linked from index\.html/);
  });
});

describe('rule c: relative references resolve inside the site', () => {
  it('fails on a broken relative link', () => {
    write('logging.html', page('Live logging', `${FEATURE_BODY}<a href="exports.html">Exports</a>`));
    assertRule('c', /logging\.html: a\[href\] "exports\.html" does not resolve/);
  });

  it('fails on a missing image', () => {
    write('logging.html', page('Live logging', `${FEATURE_BODY}<img src="img/missing.png" alt="">`));
    assertRule('c', /img\[src\] "img\/missing\.png" does not resolve/);
  });

  it('fails on a missing stylesheet', () => {
    write('teams.html', page('Teams', FEATURE_BODY).replace('style.css', 'site.css'));
    assertRule('c', /link\[href\] "site\.css" does not resolve/);
  });

  it('fails on a reference that escapes the site directory', () => {
    writeFileSync(join(root, 'outside.html'), 'x');
    write('logging.html', page('Live logging', `${FEATURE_BODY}<a href="../outside.html">x</a>`));
    assertRule('c', /"\.\.\/outside\.html" does not resolve/);
  });

  it('fails on a broken url() in the stylesheet', () => {
    write('style.css', '.x { background: url(img/gone.png); }\n');
    assertRule('c', /style\.css: url\(\) "img\/gone\.png" does not resolve/);
  });
});

describe('rule d: no scripts and no external assets', () => {
  it('fails when a page loads a script', () => {
    write('logging.html', page('Live logging', `${FEATURE_BODY}<script>alert(1)</script>`));
    assertRule('d', /logging\.html: loads a script/);
  });

  it('fails on an inline event handler', () => {
    write('logging.html', page('Live logging', `${FEATURE_BODY}<button onclick="go()">Go</button>`));
    assertRule('d', /onclick/);
  });

  it('fails on an external stylesheet', () => {
    write(
      'teams.html',
      page('Teams', FEATURE_BODY).replace('href="style.css"', 'href="https://cdn.example.com/x.css"'),
    );
    assertRule('d', /teams\.html: <link href="https:\/\/cdn\.example\.com\/x\.css"> references an external/);
  });

  it('fails on a protocol-relative image', () => {
    write('teams.html', page('Teams', `${FEATURE_BODY}<img src="//img.example.com/a.png" alt="">`));
    assertRule('d', /<img src="\/\/img\.example\.com\/a\.png">/);
  });

  it('fails on an external font in the stylesheet', () => {
    write('style.css', '@font-face { font-family: X; src: url("http://fonts.example.com/x.woff2"); }\n');
    assertRule('d', /style\.css: url\(\)\/@import "http:\/\/fonts\.example\.com\/x\.woff2"/);
  });

  it('fails on an external @import in a <style> block', () => {
    write(
      'teams.html',
      page('Teams', FEATURE_BODY).replace('</head>', '<style>@import "https://fonts.example.com/a.css";</style></head>'),
    );
    assertRule('d', /style url\(\) "https:\/\/fonts\.example\.com\/a\.css"/);
  });

  it('fails when the site ships a .js file', () => {
    write('app.js', 'console.log(1)\n');
    assertRule('d', /app\.js: the site must not ship scripts/);
  });
});

describe('rule e: feature pages have a title and a How to heading', () => {
  it('fails when a feature page has no How to heading', () => {
    write('logging.html', page('Live logging', '<h2>Overview</h2><p>No steps here.</p>'));
    assertRule('e', /logging\.html: has no "How to" heading/);
  });

  it('matches How to case-insensitively and through inline markup', () => {
    write('logging.html', page('Live logging', '<h3><span>HOW TO</span> log an event</h3>'));
    assert.deepEqual(run(), []);
  });

  it('fails when a feature page has no <title>', () => {
    write('teams.html', page('Teams', FEATURE_BODY).replace(/<title>.*<\/title>/, ''));
    assertRule('e', /teams\.html: has no <title>/);
  });
});

describe('rule f: no source paths or config assignments', () => {
  it('fails on a source file path', () => {
    write('logging.html', page('Live logging', `${FEATURE_BODY}<p>See web/src/pages for details.</p>`));
    assertRule('f', /logging\.html: contains a source path \("web\/src"\)/);
  });

  it('fails on a packages/ path', () => {
    write('logging.html', page('Live logging', `${FEATURE_BODY}<p>packages/contract</p>`));
    assertRule('f', /source path \("packages\/"\)/);
  });

  it('fails on an environment variable assignment', () => {
    write('teams.html', page('Teams', `${FEATURE_BODY}<pre>DEEPGRAM_API_KEY=abc</pre>`));
    assertRule('f', /teams\.html: contains a config assignment \("DEEPGRAM_API_KEY="\)/);
  });
});

describe('CLI', () => {
  it('exits 0 on a passing fixture', () => {
    const res = spawnSync(process.execPath, [script, '--site', site, '--specs', specs], {
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /docs-site check passed: 3 page\(s\)/);
  });

  it('exits 1 with a clear message on a failing fixture', () => {
    unlinkSync(join(site, 'logging.html'));
    const res = spawnSync(process.execPath, [script, '--site', site, '--specs', specs], {
      encoding: 'utf8',
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /docs-site check failed/);
    assert.match(res.stderr, /rule b: manifest page logging\.html does not exist/);
  });

  it('exits 2 on an unknown argument', () => {
    const res = spawnSync(process.execPath, [script, '--nope'], { encoding: 'utf8' });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /unknown argument: --nope/);
  });

  it('passes on the committed docs-site against openspec/specs', () => {
    const res = spawnSync(process.execPath, [script], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
  });
});
