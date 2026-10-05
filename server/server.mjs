/**
 * worthmyfee.com on Cloud Run (service `worthmyfee-site`): serves the
 * marketing repo's static files verbatim, with GitHub Pages' URL rules, and
 * records every crawler fetch. No HTML rewriting, no injected scripts — the
 * site is the repo. docs/cloud-run.md is the runbook.
 *
 * Env:
 *   PORT              listen port (Cloud Run sets 8080)
 *   SITE_DIR          the site root (/site in the image; `..` from a checkout)
 *   POSTHOG_API_KEY   the public phc_ project key; unset = crawler logging off
 *   POSTHOG_HOST      override for tests (default https://us.i.posthog.com)
 *   GIT_SHA           the deployed commit, printed at boot
 */
import express from 'express';
import compression from 'compression';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crawlerLogger, makeCapture, pathnameOf, HEALTH_PATHS, POSTHOG_DEFAULT_HOST } from './crawlers.mjs';
import { CACHE_CONTROL, FALLBACK_404, SECURITY_HEADERS, resolvePath, wwwRedirect } from './static.mjs';

/**
 * The Express app. `capture` and `posthogKey` are injectable so tests can
 * watch events without a network.
 */
export function createApp({ siteDir, posthogKey = '', posthogHost = POSTHOG_DEFAULT_HOST, capture } = {}) {
  const root = resolve(siteDir);
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', 'strong');
  // Cloud Run's front end terminates TLS; req.protocol is never used for
  // redirects (they are absolute https:// or same-origin paths), so no trust proxy.

  app.use((_req, res, next) => {
    res.set(SECURITY_HEADERS);
    next();
  });

  // gzip/deflate for clients that ask (Cloud Run does not compress for us):
  // card pages are ~40KB of HTML and ~10KB gzipped. Responses under 1KB and
  // clients without Accept-Encoding get the bytes as stored.
  app.use(compression());

  // www → apex before anything else, as Pages does.
  app.use((req, res, next) => {
    const to = wwwRedirect(req.headers.host, req.originalUrl);
    if (to) return res.redirect(301, to);
    next();
  });

  // Liveness. Both spellings: Cloud Run's front end reserves some paths
  // ending in "z" (docs: "Known issues"), so remote checks use /health.
  for (const p of HEALTH_PATHS) {
    app.get(p, (_req, res) => res.set('Cache-Control', 'no-store').type('text/plain').send('ok'));
  }

  // Which search engines and AI assistants read the site: one `crawler_hit`
  // per crawler GET/HEAD of a page (crawlers.mjs; CCBT docs/search-console.md
  // "Crawlers"). Mounted before the file handler so every page it answers —
  // and every 404 and redirect — is seen; assets and the health check are
  // skipped inside. Inert without a PostHog key.
  app.use(crawlerLogger({
    enabled: !!(posthogKey || capture),
    capture: capture ?? makeCapture({ apiKey: posthogKey, host: posthogHost }),
  }));

  const notFoundFile = join(root, '404.html');
  const notFound = (req, res) => {
    res.status(404).set('Cache-Control', CACHE_CONTROL).type('html');
    let body = FALLBACK_404;
    try { if (existsSync(notFoundFile)) body = readFileSync(notFoundFile); } catch { /* fallback */ }
    res.send(body);
  };

  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.set('Allow', 'GET, HEAD');
      return res.status(405).type('text/plain').send('Method Not Allowed\n');
    }
    const url = req.originalUrl || '/';
    const pathname = pathnameOf(url);
    const r = resolvePath(root, pathname);
    if (r.kind === 'redirect') {
      const q = url.indexOf('?');
      return res.redirect(301, r.location + (q === -1 ? '' : url.slice(q)));
    }
    if (r.kind === 'notfound') return notFound(req, res);
    res.sendFile(r.file, {
      // Our own checks already refused dotfiles; `allow` stops `send` from
      // judging the absolute path (a SITE_DIR under a dot-directory).
      dotfiles: 'allow',
      etag: true,
      lastModified: true,
      cacheControl: false,
      headers: { 'Cache-Control': CACHE_CONTROL },
    }, (err) => {
      if (!err) return;
      if (res.headersSent) return;
      if (err.status === 404 || err.code === 'ENOENT') return notFound(req, res);
      next(err);
    });
  });

  // Last resort: never leak a stack trace.
  app.use((err, _req, res, _next) => {
    try { console.error(JSON.stringify({ severity: 'ERROR', message: 'site-error', error: String(err?.message || err) })); } catch { /* ignored */ }
    if (res.headersSent) return;
    const status = err?.status && err.status >= 400 && err.status < 500 ? err.status : 500;
    res.status(status).type('text/plain').send(status === 500 ? 'Internal Server Error\n' : 'Bad Request\n');
  });

  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const port = Number(process.env.PORT) || 8080;
  const siteDir = process.env.SITE_DIR || join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const posthogKey = (process.env.POSTHOG_API_KEY || '').trim();
  const app = createApp({ siteDir, posthogKey, posthogHost: process.env.POSTHOG_HOST || POSTHOG_DEFAULT_HOST });
  app.listen(port, () => {
    console.log(JSON.stringify({
      severity: 'INFO', message: 'site-listening', port, siteDir: resolve(siteDir),
      crawlerLogging: posthogKey ? 'on' : 'off', gitSha: process.env.GIT_SHA || null,
    }));
  });
}
