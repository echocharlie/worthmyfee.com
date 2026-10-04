// node --test scripts/*.test.mjs   (run by .github/workflows/deploy.yml before every deploy and submit)
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  INDEXNOW_KEY, SITE, buildPayload, extractLocs, fileToUrl, isAccepted, isDisallowed,
  parseRobotsDisallow, posthogEvent, posthogKeyFrom, selectUrls, verdict,
} from './indexnow.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(join(ROOT, f), 'utf8');

const SITEMAP = `<?xml version="1.0"?><urlset>
  <url><loc>https://worthmyfee.com/</loc></url>
  <url><loc>https://worthmyfee.com/cards/amex-platinum/</loc></url>
  <url><loc> https://worthmyfee.com/privacy.html </loc></url>
  <url><loc>https://worthmyfee.com/?a=1&amp;b=2</loc></url>
  <url><loc>https://worthmyfee.com/</loc></url>
</urlset>`;

test('extractLocs trims, unescapes and dedupes', () => {
  assert.deepEqual(extractLocs(SITEMAP), [
    'https://worthmyfee.com/',
    'https://worthmyfee.com/cards/amex-platinum/',
    'https://worthmyfee.com/privacy.html',
    'https://worthmyfee.com/?a=1&b=2',
  ]);
});

test('parseRobotsDisallow reads only the User-agent: * group', () => {
  const robots = 'User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\nDisallow: /logo-generator.html # tool\nDisallow:\n';
  assert.deepEqual(parseRobotsDisallow(robots), ['/logo-generator.html']);
});

test('isDisallowed uses robots prefix semantics', () => {
  assert.equal(isDisallowed('https://worthmyfee.com/logo-generator.html', ['/logo-generator.html']), true);
  assert.equal(isDisallowed('https://worthmyfee.com/cards/', ['/logo-generator.html']), false);
  assert.equal(isDisallowed('not a url', []), true);
});

test('fileToUrl maps GitHub Pages paths', () => {
  assert.equal(fileToUrl('index.html'), `${SITE}/`);
  assert.equal(fileToUrl('cards/amex-platinum/index.html'), `${SITE}/cards/amex-platinum/`);
  assert.equal(fileToUrl('privacy.html'), `${SITE}/privacy.html`);
  assert.equal(fileToUrl('sitemap.xml'), null);
  assert.equal(fileToUrl('og-image.png'), null);
  assert.equal(fileToUrl(`${INDEXNOW_KEY}.txt`), null);
});

test('selectUrls keeps only sitemap pages robots allows', () => {
  const robots = 'User-agent: *\nDisallow: /privacy';
  const changed = [`${SITE}/`, `${SITE}/cards/amex-platinum/`, `${SITE}/cards/amex-platinum/`, `${SITE}/privacy.html`, `${SITE}/logo-generator.html`];
  assert.deepEqual(selectUrls(changed, SITEMAP, robots), [`${SITE}/`, `${SITE}/cards/amex-platinum/`]);
  assert.equal(selectUrls(null, SITEMAP, robots).length, 3);
  assert.equal(selectUrls(null, SITEMAP, '', 2).length, 2);
  assert.deepEqual(selectUrls([], SITEMAP, ''), []);
});

test('buildPayload points at the key file on the host', () => {
  assert.deepEqual(buildPayload([`${SITE}/`]), {
    host: 'worthmyfee.com', key: INDEXNOW_KEY, keyLocation: `${SITE}/${INDEXNOW_KEY}.txt`, urlList: [`${SITE}/`],
  });
});

test('verdict / isAccepted', () => {
  assert.equal(isAccepted(200), true);
  assert.equal(isAccepted(202), true);
  assert.equal(isAccepted(403), false);
  assert.match(verdict(403), /key/);
  assert.match(verdict(500), /unexpected/);
});

test('the key file ships at the repo root with the key as its content', () => {
  const f = join(ROOT, `${INDEXNOW_KEY}.txt`);
  assert.ok(existsSync(f), `${INDEXNOW_KEY}.txt missing`);
  assert.equal(readFileSync(f, 'utf8').trim(), INDEXNOW_KEY);
  assert.match(INDEXNOW_KEY, /^[a-f0-9]{32}$/);
});

test('the real sitemap and robots.txt yield submittable URLs on this host', () => {
  const urls = selectUrls(null, read('sitemap.xml'), read('robots.txt'));
  assert.ok(urls.length > 10);
  for (const u of urls) assert.equal(new URL(u).host, 'worthmyfee.com');
});

test('PostHog key is read from the index.html snippet, event has no person profile', () => {
  const key = posthogKeyFrom(read('index.html'));
  assert.match(key, /^phc_/);
  const ev = posthogEvent(key, { mode: 'changed', submitted: 3, status: 202, verdict: 'accepted' });
  assert.equal(ev.event, 'indexnow_submit');
  assert.equal(ev.distinct_id, 'indexnow');
  assert.equal(ev.properties.$process_person_profile, false);
});

// ── The PostHog snippet every page carries ──────────────────────────────────

function posthogSnippet(html) {
  const start = html.indexOf('<!-- Marketing-site-only product analytics');
  assert.ok(start >= 0, 'PostHog snippet missing');
  const end = html.indexOf('</script>', start);
  assert.ok(end > start, 'PostHog snippet not closed');
  return html.slice(start, end);
}

test('every hand-written page carries the same snippet bytes as index.html', () => {
  const home = posthogSnippet(read('index.html'));
  for (const f of ['privacy.html', 'terms.html']) assert.equal(posthogSnippet(read(f)), home, f);
});

test('no page carries the old in-page crawler beacon (the Cloud Run server logs crawlers now)', () => {
  const pages = ['index.html', 'privacy.html', 'terms.html', 'cards/index.html', 'cards/amex-platinum/index.html', 'methodology/index.html', 'about/index.html'];
  for (const f of pages) {
    const html = read(f);
    assert.ok(!html.includes('crawler_hit'), `${f} still carries the crawler beacon`);
    assert.equal(posthogSnippet(html), posthogSnippet(read('index.html')), `${f} snippet differs from index.html`);
  }
});
