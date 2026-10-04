// node --test server/*.test.mjs — URL → file rules, against the real repo.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { NOT_SERVED, parsePathname, resolvePath, wwwRedirect } from './static.mjs';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (r) => (r.kind === 'file' ? r.file.slice(SITE.length + 1) : r);

describe('resolvePath — GitHub Pages rules', () => {
  it('serves index.html for / and for a directory with a trailing slash', () => {
    assert.equal(rel(resolvePath(SITE, '/')), 'index.html');
    assert.equal(rel(resolvePath(SITE, '/cards/')), 'cards/index.html');
    assert.equal(rel(resolvePath(SITE, '/cards/amex-platinum/')), 'cards/amex-platinum/index.html');
  });
  it('301s a directory without its slash, to a same-origin path', () => {
    assert.deepEqual(resolvePath(SITE, '/cards/amex-platinum'), { kind: 'redirect', location: '/cards/amex-platinum/' });
    assert.deepEqual(resolvePath(SITE, '/methodology'), { kind: 'redirect', location: '/methodology/' });
    // A doubled slash must not become a protocol-relative Location (//cards/ = host "cards").
    assert.deepEqual(resolvePath(SITE, '//cards'), { kind: 'redirect', location: '/cards/' });
  });
  it('serves files as named, including /about/index.html (no redirect)', () => {
    assert.equal(rel(resolvePath(SITE, '/about/index.html')), 'about/index.html');
    assert.equal(rel(resolvePath(SITE, '/privacy.html')), 'privacy.html');
    assert.equal(rel(resolvePath(SITE, '/robots.txt')), 'robots.txt');
    assert.equal(rel(resolvePath(SITE, '/sitemap.xml')), 'sitemap.xml');
    assert.equal(rel(resolvePath(SITE, '/f0290cd3888f72fc154819a874bea7b5.txt')), 'f0290cd3888f72fc154819a874bea7b5.txt');
    assert.equal(rel(resolvePath(SITE, '/og-image.png')), 'og-image.png');
  });
  it('resolves an extensionless path to its .html file, as Pages does', () => {
    assert.equal(rel(resolvePath(SITE, '/privacy')), 'privacy.html');
    assert.equal(rel(resolvePath(SITE, '/terms')), 'terms.html');
  });
  it('404s unknown paths and a file named as a directory', () => {
    for (const p of ['/nope', '/cards/no-such-card/', '/privacy.html/', '/cards/amex-platinum/nope.html', '/robots']) {
      assert.deepEqual(resolvePath(SITE, p), { kind: 'notfound' }, p);
    }
  });
  it('never serves the repo\'s own tooling, even from a checkout', () => {
    for (const p of ['/server/package.json', '/server/server.mjs', '/server/', '/server', '/docs/cloud-run.md', '/docs/',
      '/scripts/indexnow.mjs', '/Dockerfile', '/README.md', '/CNAME', '/.dockerignore', '/.nojekyll', '/.git/config', '/.github/workflows/deploy.yml']) {
      assert.deepEqual(resolvePath(SITE, p), { kind: 'notfound' }, p);
    }
  });
  it('rejects traversal, encoded separators, NULs and dotfiles', () => {
    for (const p of [
      '/../etc/passwd', '/cards/../../etc/passwd', '/%2e%2e/etc/passwd', '/%2E%2E/%2E%2E/etc/passwd', '/cards/%2e%2e/%2e%2e/etc/passwd',
      '/..%2fetc%2fpasswd', '/cards%2f..%2f..%2fetc%2fpasswd', '/..%5c..%5cetc', '/..\\..\\etc\\passwd', '/index.html%00.png',
      '/%252e%252e/etc/passwd', '/.', '/cards/./amex-platinum/', '/.well-known/x', '/%2egit/config', '/%E0%A4%A', 'relative', '',
    ]) {
      assert.deepEqual(resolvePath(SITE, p), { kind: 'notfound' }, p);
    }
  });
  it('a symlink that leads outside the site root is not followed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wmf-site-'));
    const outside = mkdtempSync(join(tmpdir(), 'wmf-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    writeFileSync(join(outside, 'index.html'), 'secret');
    writeFileSync(join(dir, 'index.html'), 'home');
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'leak.txt'));
    symlinkSync(outside, join(dir, 'leakdir'));
    assert.equal(resolvePath(dir, '/').kind, 'file');
    assert.deepEqual(resolvePath(dir, '/leak.txt'), { kind: 'notfound' });
    assert.deepEqual(resolvePath(dir, '/leakdir/'), { kind: 'notfound' });
    assert.deepEqual(resolvePath(dir, '/leakdir/secret.txt'), { kind: 'notfound' });
  });
  it('re-encodes the redirect target', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wmf-site-'));
    mkdirSync(join(dir, 'a b'));
    writeFileSync(join(dir, 'a b', 'index.html'), 'x');
    assert.deepEqual(resolvePath(dir, '/a%20b'), { kind: 'redirect', location: '/a%20b/' });
  });
});

describe('parsePathname', () => {
  it('decodes once and keeps the trailing-slash flag', () => {
    assert.deepEqual(parsePathname('/cards/amex-platinum/'), { segments: ['cards', 'amex-platinum'], trailingSlash: true });
    assert.deepEqual(parsePathname('/a%20b'), { segments: ['a b'], trailingSlash: false });
    assert.deepEqual(parsePathname('/'), { segments: [], trailingSlash: true });
  });
});

describe('wwwRedirect', () => {
  it('sends www to the apex with path and query, and leaves the apex alone', () => {
    assert.equal(wwwRedirect('www.worthmyfee.com', '/cards/?a=1'), 'https://worthmyfee.com/cards/?a=1');
    assert.equal(wwwRedirect('WWW.WorthMyFee.com:443', '/'), 'https://worthmyfee.com/');
    assert.equal(wwwRedirect('www.worthmyfee.com.', '/x'), 'https://worthmyfee.com/x');
    assert.equal(wwwRedirect('worthmyfee.com', '/'), null);
    assert.equal(wwwRedirect('worthmyfee-site-abc-uc.a.run.app', '/'), null);
    assert.equal(wwwRedirect(undefined, '/'), null);
  });
  it('never redirects off-site', () => {
    assert.equal(wwwRedirect('www.worthmyfee.com', '//evil.example/x'), 'https://worthmyfee.com/evil.example/x');
    assert.equal(wwwRedirect('www.worthmyfee.com', 'http://evil.example/'), 'https://worthmyfee.com/');
  });
});

// ── The image ships only served files ───────────────────────────────────────

function dockerignore() {
  return readFileSync(join(SITE, '.dockerignore'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

describe('Dockerfile / .dockerignore', () => {
  it('.dockerignore excludes every non-served top-level path except server/ (needed by the build)', () => {
    const ignored = new Set(dockerignore());
    for (const p of NOT_SERVED) {
      if (p === 'server') continue;
      if (p === 'node_modules') { assert.ok(ignored.has('**/node_modules'), '**/node_modules'); continue; }
      assert.ok(ignored.has(p), `${p} missing from .dockerignore`);
    }
    for (const p of ['.git', '.github', 'server/node_modules']) assert.ok(ignored.has(p), `${p} missing from .dockerignore`);
  });
  it('every dotfile and every top-level tooling entry in the repo is either ignored or refused', () => {
    const ignored = new Set(dockerignore());
    for (const name of readdirSync(SITE)) {
      if (name.startsWith('.')) {
        // Dotfiles are refused by the server anyway; the image should not carry them either.
        assert.ok(ignored.has(name) || name === '.git', `${name} not in .dockerignore`);
      }
    }
  });
  it('the Dockerfile drops server/ from the site stage and copies only server/ into the app', () => {
    const df = readFileSync(join(SITE, 'Dockerfile'), 'utf8');
    assert.match(df, /^FROM node:22\.12-slim AS site$/m);
    assert.match(df, /^COPY \. \/site$/m);
    assert.match(df, /^RUN rm -rf \/site\/server$/m);
    assert.match(df, /^COPY --from=site \/site \/site$/m);
    assert.match(df, /^COPY server\/package\.json server\/package-lock\.json \.\/$/m);
    assert.match(df, /^USER node$/m);
    assert.match(df, /SITE_DIR=\/site/);
  });
  it('nothing the sitemap lists, nor the key file, 404 page or images, is ignored', () => {
    const ignored = dockerignore().filter((p) => !p.includes('*'));
    const sitemap = readFileSync(join(SITE, 'sitemap.xml'), 'utf8');
    const paths = [...sitemap.matchAll(/<loc>https:\/\/worthmyfee\.com\/([^<]*)<\/loc>/g)].map((m) => m[1] || 'index.html');
    paths.push('f0290cd3888f72fc154819a874bea7b5.txt', '404.html', 'robots.txt', 'sitemap.xml', 'og-image.png', 'logo-512.png');
    for (const p of paths) {
      const top = p.split('/')[0];
      assert.ok(!ignored.includes(top) && !ignored.includes(p.replace(/\/$/, '')), `${p} would be left out of the image`);
      assert.equal(resolvePath(SITE, '/' + p).kind, 'file', `${p} does not resolve to a file`);
    }
  });
  it('the root has no package.json (Pages serves the root; indexnow.mjs stays dependency-free)', () => {
    assert.equal(existsSync(join(SITE, 'package.json')), false);
  });
  it('404.html is noindex', () => {
    assert.match(readFileSync(join(SITE, '404.html'), 'utf8'), /<meta name="robots" content="noindex">/);
  });
  it('robots.txt disallows the tooling directories Pages would serve', () => {
    const robots = readFileSync(join(SITE, 'robots.txt'), 'utf8');
    assert.match(robots, /^Disallow: \/server\/$/m);
    assert.match(robots, /^Disallow: \/docs\/$/m);
  });
});
