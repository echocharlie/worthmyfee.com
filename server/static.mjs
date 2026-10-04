/**
 * How a request path maps onto the site's files — GitHub Pages' rules, so the
 * Cloud Run service and the Pages fallback answer every URL the same way.
 * No socket needed: `resolvePath` reads the filesystem only through `stat`,
 * and the tests run it against the real repo.
 *
 *   /                          → index.html
 *   /cards/                    → cards/index.html
 *   /cards/amex-platinum       → 301 /cards/amex-platinum/  (a directory)
 *   /about/index.html          → served as is (no redirect, like Pages)
 *   /privacy                   → privacy.html               (Pages' extensionless lookup)
 *   anything else              → 404
 *
 * Security: the path is decoded once, then rejected if it holds an encoded
 * slash or backslash, a NUL, a `.`/`..` segment or any segment starting with
 * a dot (.git, .github, .nojekyll); the joined path must stay inside the
 * site root after symlinks are resolved; and NOT_SERVED (the repo's own
 * tooling: server/, docs/, scripts/, Dockerfile…) answers 404 even when the
 * files are on disk, as they are when running from a checkout.
 */
import { realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

export const CANONICAL_HOST = 'worthmyfee.com';
export const WWW_HOST = 'www.worthmyfee.com';

/**
 * Top-level repo entries that are not part of the site. The .dockerignore
 * keeps them out of the image (server/ is removed in the Dockerfile's site
 * stage instead, since the app stage needs it); the server also refuses them
 * so a local run from the checkout behaves like production. A test keeps
 * this list and .dockerignore in sync.
 */
export const NOT_SERVED = Object.freeze([
  'server', 'docs', 'scripts', 'node_modules',
  'Dockerfile', 'README.md', 'CNAME', 'package.json', 'package-lock.json',
]);

/** Pages' Cache-Control for every file. */
export const CACHE_CONTROL = 'public, max-age=600';

/** Headers on every response, page or error. */
export const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Strict-Transport-Security': 'max-age=31556952',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
});

/** www → apex, keeping path and query (Pages does the same). null = no redirect. */
export function wwwRedirect(hostHeader, originalUrl) {
  const host = String(hostHeader || '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  if (host !== WWW_HOST) return null;
  const rest = String(originalUrl || '/');
  // Only a path may follow the host: `//evil.example` must not become a new authority.
  const path = rest.startsWith('/') ? '/' + rest.replace(/^\/+/, '') : '/';
  return `https://${CANONICAL_HOST}${path}`;
}

/**
 * The decoded, validated segments of a URL pathname, or null when the path
 * must not be served. `trailingSlash` records whether the request named a
 * directory.
 */
export function parsePathname(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return null;
  // Encoded separators and NULs never name a file of ours.
  if (/%2f|%5c|%00/i.test(pathname) || pathname.includes('\\') || pathname.includes('\0')) return null;
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes('\\') || decoded.includes('\0')) return null;
  const segments = decoded.split('/').filter(Boolean);
  for (const s of segments) {
    if (s.startsWith('.')) return null; // ., .., dotfiles and dot-directories
  }
  if (segments.length > 0 && NOT_SERVED.includes(segments[0])) return null;
  return { segments, trailingSlash: decoded.endsWith('/') };
}

/** `/a b/c` from segments, each re-encoded: a safe same-origin Location. */
function toPath(segments, trailingSlash) {
  const p = '/' + segments.map(encodeURIComponent).join('/');
  return trailingSlash && segments.length > 0 ? p + '/' : p;
}

function statOrNull(p) {
  try { return statSync(p); } catch { return null; }
}

function inside(root, p) {
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * What to do with a GET/HEAD for `pathname` (no query string) under `siteDir`:
 *   { kind: 'file', file }               serve this absolute path
 *   { kind: 'redirect', location }       301 (append the query string yourself)
 *   { kind: 'notfound' }
 */
export function resolvePath(siteDir, pathname) {
  const parsed = parsePathname(pathname);
  if (!parsed) return { kind: 'notfound' };
  const { segments, trailingSlash } = parsed;
  let root;
  try { root = realpathSync(siteDir); } catch { return { kind: 'notfound' }; }

  const file = (p) => {
    // Symlinks inside the checkout must not lead outside it.
    let real;
    try { real = realpathSync(p); } catch { return null; }
    if (!inside(root, real)) return null;
    const st = statOrNull(real);
    return st && st.isFile() ? real : null;
  };

  const target = join(root, ...segments);
  if (!inside(root, target)) return { kind: 'notfound' };
  const st = statOrNull(target);

  if (st && st.isDirectory()) {
    if (!trailingSlash && segments.length > 0) {
      return { kind: 'redirect', location: toPath(segments, true) };
    }
    const index = file(join(target, 'index.html'));
    return index ? { kind: 'file', file: index } : { kind: 'notfound' };
  }
  if (st && st.isFile()) {
    // `/privacy.html/` names a directory that does not exist.
    if (trailingSlash) return { kind: 'notfound' };
    const f = file(target);
    return f ? { kind: 'file', file: f } : { kind: 'notfound' };
  }
  // Pages serves `/privacy` from privacy.html.
  if (!trailingSlash && segments.length > 0 && !/\.[^/]*$/.test(segments[segments.length - 1])) {
    const f = file(target + '.html');
    if (f) return { kind: 'file', file: f };
  }
  return { kind: 'notfound' };
}

/** A minimal 404 body for when the site has no 404.html. */
export const FALLBACK_404 = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
  + '<meta name="robots" content="noindex"><title>Page not found — Worth My Fee</title></head>'
  + '<body><h1>Page not found</h1><p><a href="/">Worth My Fee</a></p></body></html>\n';
