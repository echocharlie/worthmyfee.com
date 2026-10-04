// node --test server/*.test.mjs — the real server over a socket: Pages
// behaviour, headers, and crawler_hit delivery to a fake PostHog.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { createApp } from './server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, '..');
const GPTBOT = 'GPTBot/1.0';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

/** Raw HTTP so the request path is sent byte-for-byte (fetch would normalize `..`). */
function raw(port, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('server: GitHub Pages behaviour', () => {
  let server, port;
  const events = [];
  before(async () => {
    server = await listen(createApp({ siteDir: SITE, capture: (e) => events.push(e) }));
    port = server.address().port;
  });
  after(() => new Promise((r) => server.close(r)));

  it('/ is index.html, byte for byte, with Pages\' headers', async () => {
    const r = await raw(port, '/');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^text\/html/);
    assert.equal(r.body, readFileSync(join(SITE, 'index.html'), 'utf8'));
    assert.equal(r.headers['cache-control'], 'public, max-age=600');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.match(r.headers['strict-transport-security'], /^max-age=\d+/);
    assert.equal(r.headers['referrer-policy'], 'strict-origin-when-cross-origin');
    assert.ok(r.headers.etag);
    assert.ok(r.headers['last-modified']);
    assert.equal(r.headers['x-powered-by'], undefined);
  });
  it('conditional GET answers 304', async () => {
    const { headers } = await raw(port, '/cards/');
    const r = await raw(port, '/cards/', { headers: { 'if-none-match': headers.etag } });
    assert.equal(r.status, 304);
  });
  it('a slashless card path 301s to the slash, keeping the query', async () => {
    const r = await raw(port, '/cards/amex-platinum?utm_source=x');
    assert.equal(r.status, 301);
    assert.equal(r.headers.location, '/cards/amex-platinum/?utm_source=x');
    const ok = await raw(port, '/cards/amex-platinum/');
    assert.equal(ok.status, 200);
    assert.equal(ok.body, readFileSync(join(SITE, 'cards/amex-platinum/index.html'), 'utf8'));
  });
  it('the IndexNow key file is text/plain with the key; sitemap is XML', async () => {
    const key = await raw(port, '/f0290cd3888f72fc154819a874bea7b5.txt');
    assert.equal(key.status, 200);
    assert.match(key.headers['content-type'], /^text\/plain/);
    assert.equal(key.body.trim(), 'f0290cd3888f72fc154819a874bea7b5');
    const sm = await raw(port, '/sitemap.xml');
    assert.equal(sm.status, 200);
    assert.match(sm.headers['content-type'], /xml/);
  });
  it('unknown and non-served paths are 404 with the noindex 404 page', async () => {
    for (const p of ['/nope', '/server/package.json', '/docs/cloud-run.md', '/scripts/indexnow.mjs', '/Dockerfile', '/.git/config',
      '/../server/package.json', '/%2e%2e/%2e%2e/etc/passwd', '/cards/..%2f..%2fserver%2fpackage.json', '/.nojekyll']) {
      const r = await raw(port, p);
      assert.equal(r.status, 404, p);
      assert.match(r.body, /noindex/, p);
      assert.doesNotMatch(r.body, /"express"|root:x:0/, p);
    }
  });
  it('HEAD works wherever GET does, with no body', async () => {
    for (const [p, status] of [['/', 200], ['/robots.txt', 200], ['/cards/amex-platinum', 301], ['/nope', 404], ['/healthz', 200]]) {
      const r = await raw(port, p, { method: 'HEAD' });
      assert.equal(r.status, status, p);
      assert.equal(r.body, '', p);
    }
  });
  it('other methods are 405', async () => {
    const r = await raw(port, '/', { method: 'POST' });
    assert.equal(r.status, 405);
    assert.equal(r.headers.allow, 'GET, HEAD');
  });
  it('www redirects to the apex over https', async () => {
    const r = await raw(port, '/cards/?a=1', { headers: { host: 'www.worthmyfee.com' } });
    assert.equal(r.status, 301);
    assert.equal(r.headers.location, 'https://worthmyfee.com/cards/?a=1');
  });
  it('/healthz and /health answer ok', async () => {
    for (const p of ['/healthz', '/health']) {
      const r = await raw(port, p);
      assert.equal(r.status, 200);
      assert.equal(r.body, 'ok');
      assert.match(r.headers['content-type'], /^text\/plain/);
    }
  });
  it('crawler fetches are captured with the final status; browsers, assets and health checks are not', async () => {
    events.length = 0;
    await raw(port, '/cards/amex-platinum/', { headers: { 'user-agent': GPTBOT } });
    await raw(port, '/cards/amex-platinum', { headers: { 'user-agent': 'bingbot/2.0' } });
    await raw(port, '/f0290cd3888f72fc154819a874bea7b5.txt', { headers: { 'user-agent': 'bingbot/2.0' } });
    await raw(port, '/nope', { headers: { 'user-agent': 'ClaudeBot/1.0' } });
    await raw(port, '/cards/amex-platinum/', { headers: { 'user-agent': CHROME } });
    await raw(port, '/og-image.png', { headers: { 'user-agent': GPTBOT } });
    await raw(port, '/healthz', { headers: { 'user-agent': GPTBOT } });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(events.map((e) => [e.distinctId, e.properties.path, e.properties.status, e.properties.page_kind]), [
      ['crawler:gptbot', '/cards/amex-platinum/', 200, 'card'],
      ['crawler:bing', '/cards/amex-platinum', 301, 'card'],
      ['crawler:bing', '/f0290cd3888f72fc154819a874bea7b5.txt', 200, 'indexnow_key'],
      ['crawler:claude', '/nope', 404, 'other'],
    ]);
  });
});

describe('server: crawler logging off without a PostHog key', () => {
  it('serves pages and captures nothing', async () => {
    const server = await listen(createApp({ siteDir: SITE }));
    try {
      const r = await raw(server.address().port, '/', { headers: { 'user-agent': GPTBOT } });
      assert.equal(r.status, 200);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

// ── The entry point, as the image runs it, against a fake PostHog ──────────

describe('server.mjs process with POSTHOG_HOST pointed at a fake PostHog', () => {
  let fake, child, port;
  const received = [];
  const stdout = [];

  before(async () => {
    fake = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        received.push({ method: req.method, url: req.url, body: JSON.parse(body) });
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"Ok"}');
      });
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    port = 30000 + Math.floor(Math.random() * 20000);
    child = spawn(process.execPath, [join(HERE, 'server.mjs')], {
      env: { ...process.env, PORT: String(port), SITE_DIR: SITE, POSTHOG_API_KEY: 'phc_test', POSTHOG_HOST: `http://127.0.0.1:${fake.address().port}` },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    child.stdout.on('data', (c) => stdout.push(...String(c).split('\n').filter(Boolean)));
    for (let i = 0; i < 50; i++) {
      try { if ((await raw(port, '/healthz')).status === 200) return; } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('server.mjs did not start');
  });
  after(async () => {
    child?.kill();
    await new Promise((r) => fake.close(r));
  });

  const settle = async (n) => {
    for (let i = 0; i < 50 && received.length < n; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100)); // and nothing extra arrives
  };

  it('a GPTBot fetch of a card page sends exactly one crawler_hit', async () => {
    received.length = 0;
    const r = await raw(port, '/cards/amex-platinum/', { headers: { 'user-agent': GPTBOT } });
    assert.equal(r.status, 200);
    await settle(1);
    assert.equal(received.length, 1);
    const { method, url, body } = received[0];
    assert.equal(method, 'POST');
    assert.equal(url, '/i/v0/e/');
    assert.deepEqual(body, {
      api_key: 'phc_test', event: 'crawler_hit', distinct_id: 'crawler:gptbot',
      properties: { bot: 'gptbot', family: 'ai', path: '/cards/amex-platinum/', status: 200, method: 'GET', page_kind: 'card', render: 'server', $process_person_profile: false },
    });
    const line = stdout.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((l) => l?.message === 'crawler');
    assert.deepEqual(line, { severity: 'INFO', message: 'crawler', crawler: { event: 'crawler_hit', bot: 'gptbot', family: 'ai', path: '/cards/amex-platinum/', status: 200, method: 'GET', page_kind: 'card', render: 'server' } });
  });
  it('a browser, an asset and the health check send nothing', async () => {
    received.length = 0;
    await raw(port, '/cards/amex-platinum/', { headers: { 'user-agent': CHROME } });
    await raw(port, '/og-image.png', { headers: { 'user-agent': GPTBOT } });
    await raw(port, '/healthz', { headers: { 'user-agent': GPTBOT } });
    await settle(0);
    assert.equal(received.length, 0);
  });
  it('a dead PostHog never costs a page view', async () => {
    const dead = spawn(process.execPath, [join(HERE, 'server.mjs')], {
      env: { ...process.env, PORT: String(port + 1), SITE_DIR: SITE, POSTHOG_API_KEY: 'phc_test', POSTHOG_HOST: 'http://127.0.0.1:9' },
      stdio: 'ignore',
    });
    try {
      let r;
      for (let i = 0; i < 50 && !r; i++) {
        try { r = await raw(port + 1, '/cards/amex-platinum/', { headers: { 'user-agent': GPTBOT } }); } catch { await new Promise((s) => setTimeout(s, 100)); }
      }
      assert.equal(r.status, 200);
      const again = await raw(port + 1, '/', { headers: { 'user-agent': GPTBOT } });
      assert.equal(again.status, 200);
      assert.equal(dead.exitCode, null, 'the process is still up');
    } finally {
      dead.kill();
    }
  });
});
