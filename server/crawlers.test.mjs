// node --test server/*.test.mjs — port of JCYMA crawlers.test.ts (vitest → node:test).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express from 'express';
import {
  KNOWN_CRAWLERS, EXACT_UA, NO_UA, classifyCrawler, pageKind, isStaticAsset, shouldLogCrawlerPath, pathnameOf,
  makeHourlyCap, crawlerLogger, makeCapture, logLine, posthogBody, CRAWLER_HOURLY_CAP, UA_SAMPLE_MAX, PATH_MAX,
} from './crawlers.mjs';

// Real strings as the bots send them (docs of each operator), so a rename
// upstream shows up here first.
const NAMED = [
  ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'google', 'search'],
  ['Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.175 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'google', 'search'],
  ['Mozilla/5.0 (compatible; Google-InspectionTool/1.0;)', 'google_inspection', 'search'],
  ['Googlebot-Image/1.0', 'google_image', 'search'],
  ['Google-Extended', 'google_extended', 'ai'],
  ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36', 'bing', 'search'],
  ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot', 'openai_search', 'ai'],
  ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot', 'chatgpt_user', 'ai'],
  ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot', 'gptbot', 'ai'],
  ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)', 'perplexity', 'ai'],
  ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)', 'perplexity_user', 'ai'],
  ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)', 'claude', 'ai'],
  ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Claude-User/1.0; +Claude-User@anthropic.com', 'claude_user', 'ai'],
  ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Claude-SearchBot/1.0; +Claude-SearchBot@anthropic.com', 'claude_user', 'ai'],
  ['anthropic-ai', 'anthropic', 'ai'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)', 'apple', 'search'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot-Extended/0.1; +http://www.apple.com/go/applebot)', 'apple_extended', 'ai'],
  ['DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)', 'duckduckgo', 'search'],
  ['Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)', 'yandex', 'search'],
  ['Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)', 'baidu', 'search'],
  ['Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)', 'bytedance', 'ai'],
  ['CCBot/2.0 (https://commoncrawl.org/faq/)', 'commoncrawl', 'ai'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_10_1) AppleWebKit/600.2.5 (KHTML, like Gecko) Version/8.0.2 Safari/600.2.5 (Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot)', 'amazon', 'search'],
  ['meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)', 'meta', 'social'],
  ['facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', 'meta', 'social'],
  ['meta-webindexer/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)', 'meta_webindexer', 'search'],
  ['HatchFeed/1.0 (+https://agent.meta.ai; link preview)', 'meta_ai', 'ai'],
  ['Twitterbot/1.0', 'twitter', 'social'],
  ['LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)', 'linkedin', 'social'],
  ['Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)', 'slack', 'social'],
  ['Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)', 'discord', 'social'],
  ['Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)', 'ahrefs', 'seo'],
  ['Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)', 'semrush', 'seo'],
  ['Mozilla/5.0 (compatible; MJ12bot/v1.4.8; http://mj12bot.com/)', 'majestic', 'seo'],
  ['Mozilla/5.0 (compatible; DotBot/1.2; +https://opensiteexplorer.org/dotbot; help@moz.com)', 'moz', 'seo'],
  ['AwarioBot/1.0', 'awario', 'seo'],
  ['ProspectDB/1.0 (+https://resellers.yasin.nu/bot)', 'prospectdb', 'seo'],
  ['ShapBot/0.1.0', 'shapbot', 'other'],
  // Google Ads review agents, as seen on 2026-10-08 when the first campaign went live.
  ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; Mozilla/5.0, Google-AdWords-Express) Chrome/153.0.0.0 Safari/537.36', 'google_ads', 'ads'],
  ['Google-Ads-ULS-Service', 'google_ads', 'ads'],
  ['AdsBot-Google (+http://www.google.com/adsbot.html)', 'google_ads', 'ads'],
  ['Mediapartners-Google', 'google_adsense', 'ads'],
  // Scanners, as seen in the first week on Cloud Run.
  ['http://worthmyfee.com/wp-admin/install.php?step=1', 'wp_scanner', 'scanner'],
  ['Mozlila/5.0 (Linux; Android 7.0; SM-G892A Bulid/NRD90M; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/60.0.3112.107 Moblie Safari/537.36', 'typo_scanner', 'scanner'],
  ['Go-http-client/1.1', 'go_http', 'scanner'],
  ['python-requests/2.32.3', 'python', 'scanner'],
  ['curl/8.5.0', 'curl', 'scanner'],
];

const BROWSERS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21F90 Instagram 335.0.0.33.94 (iPhone15,3; iOS 17_5; en_US; en; scale=3.00; 1290x2796; 599905613)',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/480.0.0.0;]',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
];

describe('classifyCrawler', () => {
  for (const [ua, bot, family] of NAMED) {
    it(`${ua} → ${bot}/${family}`, () => {
      assert.deepEqual(classifyCrawler(ua), { bot, family });
    });
  }
  it('matches case-insensitively', () => {
    assert.deepEqual(classifyCrawler('GOOGLEBOT/2.1'), { bot: 'google', family: 'search' });
    assert.deepEqual(classifyCrawler('mozilla/5.0 (compatible; gptbot/1.0)'), { bot: 'gptbot', family: 'ai' });
  });
  it('prefers the more specific Google and Apple tokens', () => {
    assert.equal(classifyCrawler('Googlebot-Image/1.0')?.bot, 'google_image');
    assert.equal(classifyCrawler('Mozilla/5.0 (compatible; Google-InspectionTool/1.0; +http://www.google.com/bot.html)')?.bot, 'google_inspection');
    assert.equal(classifyCrawler('Applebot-Extended/0.1 (+http://www.apple.com/go/applebot)')?.bot, 'apple_extended');
  });
  it('keeps Meta\'s agents apart: the indexer and Meta AI are not the share-preview bot', () => {
    assert.deepEqual(classifyCrawler('meta-webindexer/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)'), { bot: 'meta_webindexer', family: 'search' });
    assert.deepEqual(classifyCrawler('SomethingNew/2.0 (+https://agent.meta.ai)'), { bot: 'meta_ai', family: 'ai' });
    assert.deepEqual(classifyCrawler('meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)'), { bot: 'meta', family: 'social' });
    assert.deepEqual(classifyCrawler('facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'), { bot: 'meta', family: 'social' });
  });
  it('a Chrome string that claims Googlebot is Googlebot (we log, we never trust)', () => {
    assert.deepEqual(classifyCrawler('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), { bot: 'google', family: 'search' });
  });
  it('falls back to other/other for anything that calls itself a bot, crawler or spider or carries +http', () => {
    assert.deepEqual(classifyCrawler('Mozilla/5.0 (compatible; SomeNewBot/1.0)'), { bot: 'other', family: 'other' });
    assert.deepEqual(classifyCrawler('acme-crawler/0.3'), { bot: 'other', family: 'other' });
    assert.deepEqual(classifyCrawler('Mozilla/5.0 (compatible; Sogou web spider/4.0)'), { bot: 'other', family: 'other' });
    assert.deepEqual(classifyCrawler('Mozilla/5.0 (compatible; Unknown/1.0; +http://example.com/about)'), { bot: 'other', family: 'other' });
  });
  for (const ua of BROWSERS) {
    it(`ordinary browser is null: ${ua}`, () => assert.equal(classifyCrawler(ua), null));
  }
  it('a missing or empty User-Agent is a scanner (browsers always send one)', () => {
    assert.deepEqual(classifyCrawler(undefined), { bot: 'none', family: 'scanner' });
    assert.deepEqual(classifyCrawler(''), { bot: 'none', family: 'scanner' });
    assert.deepEqual(classifyCrawler('   '), { bot: 'none', family: 'scanner' });
    assert.deepEqual(NO_UA, { bot: 'none', family: 'scanner' });
  });
  it('whole-string matches: bare "Google" and the stub browser strings', () => {
    assert.deepEqual(classifyCrawler('Google'), { bot: 'google_plain', family: 'ads' });
    assert.deepEqual(classifyCrawler(' google '), { bot: 'google_plain', family: 'ads' });
    assert.deepEqual(classifyCrawler('Mozilla/5.0 (compatible)'), { bot: 'compatible_only', family: 'scanner' });
    assert.deepEqual(classifyCrawler('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'), { bot: 'bare_webkit', family: 'scanner' });
    // Not whole-string: a real Chrome continues past the stub, and "Google" inside a longer UA is not the bare agent.
    assert.equal(classifyCrawler('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'), null);
    assert.equal(classifyCrawler('Mozilla/5.0 (compatible; MSIE 10.0; Windows NT 6.1; Trident/6.0)'), null);
    for (const [exact] of EXACT_UA) assert.equal(exact, exact.toLowerCase().trim(), `EXACT_UA entries are lower-cased and trimmed: ${exact}`);
  });
  it('the Ads agents and scanners never reach the generic other bucket, and carry no ua_sample', () => {
    assert.equal(classifyCrawler('AdsBot-Google (+http://www.google.com/adsbot.html)')?.bot, 'google_ads');
    assert.equal(classifyCrawler('Go-http-client/2.0')?.family, 'scanner');
  });
  it('the table orders every token before any shorter token it contains', () => {
    KNOWN_CRAWLERS.forEach(([needle], i) => {
      KNOWN_CRAWLERS.slice(0, i).forEach(([earlier]) => {
        assert.ok(!needle.includes(earlier) || needle === earlier, `${needle} is shadowed by ${earlier}`);
      });
    });
  });
});

describe('pageKind', () => {
  it('home, with or without index.html', () => {
    assert.equal(pageKind('/'), 'home');
    assert.equal(pageKind('/index.html'), 'home');
  });
  it('cards index and card pages, with and without a trailing slash or index.html', () => {
    assert.equal(pageKind('/cards/'), 'cards_index');
    assert.equal(pageKind('/cards'), 'cards_index');
    assert.equal(pageKind('/cards/index.html'), 'cards_index');
    assert.equal(pageKind('/cards/amex-platinum/'), 'card');
    assert.equal(pageKind('/cards/amex-platinum'), 'card');
    assert.equal(pageKind('/cards/amex-platinum/index.html'), 'card');
    assert.equal(pageKind('/Cards/Amex-Platinum/'), 'card');
    assert.equal(pageKind('/cards/no-such-card/'), 'card'); // the 404 status says so
    assert.equal(pageKind('/cards/a/b/'), 'other');
  });
  it('credit, methodology, about and legal pages', () => {
    assert.equal(pageKind('/credits/dining/'), 'credit');
    assert.equal(pageKind('/credits/airline-fee'), 'credit');
    assert.equal(pageKind('/methodology/'), 'methodology');
    assert.equal(pageKind('/about/index.html'), 'about');
    assert.equal(pageKind('/privacy.html'), 'legal');
    assert.equal(pageKind('/terms.html'), 'legal');
  });
  it('sitemap, robots and the IndexNow key file', () => {
    assert.equal(pageKind('/sitemap.xml'), 'sitemap');
    assert.equal(pageKind('/robots.txt'), 'robots');
    assert.equal(pageKind('/f0290cd3888f72fc154819a874bea7b5.txt'), 'indexnow_key');
    assert.equal(pageKind('/F0290CD3888F72FC154819A874BEA7B5.txt'), 'indexnow_key');
    assert.equal(pageKind('/cards/f0290cd3888f72fc154819a874bea7b5.txt'), 'card');
    assert.equal(pageKind('/abc.txt'), 'other');
  });
  it('anything else is other', () => {
    assert.equal(pageKind('/logo-generator.html'), 'other');
    assert.equal(pageKind('/wp-login.php'), 'other');
    assert.equal(pageKind('/about/team/'), 'other');
  });
});

describe('isStaticAsset / shouldLogCrawlerPath', () => {
  it('skips images, styles, scripts, fonts, manifests and source maps', () => {
    for (const p of ['/og-image.png', '/logo-512.png', '/wordmark.png', '/favicon.ico', '/logo.svg', '/photo.jpg', '/a.css', '/a.js', '/fonts/inter.woff2', '/a.js.map', '/manifest.webmanifest', '/assets/x']) {
      assert.equal(isStaticAsset(p), true, p);
      assert.equal(shouldLogCrawlerPath(p), false, p);
    }
  });
  it('keeps pages, the sitemap, robots.txt and the key file', () => {
    for (const p of ['/', '/cards/amex-platinum/', '/privacy.html', '/sitemap.xml', '/robots.txt', '/f0290cd3888f72fc154819a874bea7b5.txt', '/nowhere']) {
      assert.equal(isStaticAsset(p), false, p);
      assert.equal(shouldLogCrawlerPath(p), true, p);
    }
  });
  it('skips the health check', () => {
    assert.equal(shouldLogCrawlerPath('/healthz'), false);
    assert.equal(shouldLogCrawlerPath('/health'), false);
    assert.equal(shouldLogCrawlerPath('/healthy'), true);
  });
});

describe('pathnameOf', () => {
  it('drops the query string and fragment', () => {
    assert.equal(pathnameOf('/cards/amex-platinum/?utm_source=chatgpt.com&ref=X'), '/cards/amex-platinum/');
    assert.equal(pathnameOf('/methodology/#faq'), '/methodology/');
    assert.equal(pathnameOf('/'), '/');
    assert.equal(pathnameOf(''), '/');
  });
});

describe('makeHourlyCap', () => {
  it('records up to the limit, marks the first drop once, then drops silently — per bot', () => {
    const cap = makeHourlyCap(3, () => 0);
    assert.deepEqual([cap.take('google'), cap.take('google'), cap.take('google')], ['ok', 'ok', 'ok']);
    assert.equal(cap.take('google'), 'drop_first');
    assert.equal(cap.take('google'), 'drop');
    assert.equal(cap.take('google'), 'drop');
    assert.equal(cap.take('bing'), 'ok');
  });
  it('resets on the next clock hour', () => {
    let t = 0;
    const cap = makeHourlyCap(1, () => t);
    assert.equal(cap.take('google'), 'ok');
    assert.equal(cap.take('google'), 'drop_first');
    t = 3_600_000 - 1;
    assert.equal(cap.take('google'), 'drop');
    t = 3_600_000;
    assert.equal(cap.take('google'), 'ok');
    assert.equal(cap.take('google'), 'drop_first');
  });
  it('defaults to 2,000 an hour', () => {
    assert.equal(CRAWLER_HOURLY_CAP, 2000);
    const cap = makeHourlyCap();
    let ok = 0;
    for (let i = 0; i < 2001; i++) if (cap.take('x') === 'ok') ok++;
    assert.equal(ok, 2000);
  });
});

// ── Middleware with a fake req/res ──────────────────────────────────────────

const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const CHROME = BROWSERS[0];

function fakeReq(url, ua, method = 'GET') {
  return { method, url, originalUrl: url, headers: ua === undefined ? {} : { 'user-agent': ua } };
}
function fakeRes(status = 200) {
  const listeners = [];
  return {
    statusCode: status,
    on(_event, listener) { listeners.push(listener); return this; },
    finish() { for (const l of listeners) l(); },
  };
}
function harness(opts = {}) {
  const events = [];
  const mw = crawlerLogger({ capture: (e) => events.push(e), enabled: opts.enabled, cap: makeHourlyCap(opts.limit ?? 2000, () => 0) });
  const run = (url, ua, { method = 'GET', status = 200 } = {}) => {
    const req = fakeReq(url, ua, method);
    const res = fakeRes(status);
    let nexts = 0;
    mw(req, res, () => { nexts++; });
    return { res, nexts };
  };
  return { events, run };
}

describe('crawlerLogger', () => {
  it('captures one crawler_hit after the response finishes, with the real status', () => {
    const { events, run } = harness();
    const { res, nexts } = run('/cards/amex-platinum/?utm_source=x', GOOGLEBOT, { status: 404 });
    assert.equal(nexts, 1);
    assert.deepEqual(events, []);      // nothing until finish
    res.statusCode = 200;              // the handler decides the status later
    res.finish();
    assert.deepEqual(events, [{
      distinctId: 'crawler:google',
      event: 'crawler_hit',
      properties: {
        bot: 'google', family: 'search', path: '/cards/amex-platinum/', status: 200, method: 'GET',
        page_kind: 'card', render: 'server', $process_person_profile: false,
      },
    }]);
  });
  it('records HEAD too, and keeps the method', () => {
    const { events, run } = harness();
    run('/sitemap.xml', 'bingbot/2.0', { method: 'HEAD' }).res.finish();
    assert.equal(events[0].properties.bot, 'bing');
    assert.equal(events[0].properties.method, 'HEAD');
    assert.equal(events[0].properties.page_kind, 'sitemap');
  });
  it('ignores POST, browsers, the health check and static assets — and always calls next once', () => {
    const { events, run } = harness();
    for (const [url, ua, method] of [
      ['/cards/amex-platinum/', GOOGLEBOT, 'POST'],
      ['/cards/amex-platinum/', CHROME, 'GET'],
      ['/healthz', GOOGLEBOT, 'GET'],
      ['/og-image.png', GOOGLEBOT, 'GET'],
      ['/favicon.ico', GOOGLEBOT, 'GET'],
    ]) {
      const { res, nexts } = run(url, ua, { method });
      assert.equal(nexts, 1, `${method} ${url}`);
      res.finish();
    }
    assert.deepEqual(events, []);
  });
  it('a request with no User-Agent is one scanner hit (bot none), with no ua_sample', () => {
    const { events, run } = harness();
    const { res, nexts } = run('/cards/amex-platinum/', undefined, { method: 'GET' });
    assert.equal(nexts, 1);
    res.finish();
    assert.equal(events.length, 1);
    assert.equal(events[0].distinctId, 'crawler:none');
    assert.equal(events[0].properties.bot, 'none');
    assert.equal(events[0].properties.family, 'scanner');
    assert.equal(events[0].properties.ua_sample, undefined);
  });
  it('never stores the IP, the query string or a known bot\'s UA', () => {
    const { events, run } = harness();
    run('/cards/amex-platinum/?ref=ABC&utm_source=chatgpt.com', 'GPTBot/1.2 (+https://openai.com/gptbot)').res.finish();
    const props = events[0].properties;
    assert.equal(props.path, '/cards/amex-platinum/');
    assert.deepEqual(Object.keys(props).sort(), ['$process_person_profile', 'bot', 'family', 'method', 'page_kind', 'path', 'render', 'status']);
    assert.ok(!JSON.stringify(events[0]).includes('utm_source'));
    assert.ok(!JSON.stringify(events[0]).includes('openai.com'));
  });
  it('keeps an 80-character ua_sample only for an unknown bot', () => {
    const { events, run } = harness();
    const ua = 'Mozilla/5.0 (compatible; BrandNewCrawler/9.9; +https://example.com/' + 'x'.repeat(100) + ')';
    run('/', ua).res.finish();
    assert.equal(events[0].distinctId, 'crawler:other');
    assert.equal(events[0].properties.bot, 'other');
    assert.equal(events[0].properties.page_kind, 'home');
    assert.equal(events[0].properties.ua_sample, ua.slice(0, UA_SAMPLE_MAX));
    assert.equal(String(events[0].properties.ua_sample).length, 80);
  });
  it('a named bot in family other (ShapBot) gets its own id and cap bucket, and no ua_sample', () => {
    const { events, run } = harness();
    run('/cards/', 'ShapBot/0.1.0').res.finish();
    assert.equal(events[0].distinctId, 'crawler:shapbot');
    assert.equal(events[0].properties.family, 'other');
    assert.equal('ua_sample' in events[0].properties, false);
  });
  it('caps the path length', () => {
    const { events, run } = harness();
    run('/cards/' + 'a'.repeat(500) + '/', GOOGLEBOT).res.finish();
    assert.equal(String(events[0].properties.path).length, PATH_MAX);
  });
  it('drops beyond the hourly cap and says so once per bot', () => {
    const { events, run } = harness({ limit: 2 });
    for (let i = 0; i < 5; i++) run('/', GOOGLEBOT).res.finish();
    run('/', 'bingbot/2.0').res.finish();
    assert.deepEqual(events.map((e) => `${e.event}:${e.distinctId}`), [
      'crawler_hit:crawler:google', 'crawler_hit:crawler:google', 'crawler_hit_dropped:crawler:google', 'crawler_hit:crawler:bing',
    ]);
    assert.deepEqual(events[2].properties, { bot: 'google', family: 'search', cap: CRAWLER_HOURLY_CAP, $process_person_profile: false });
  });
  it('is a pure pass-through when disabled (no PostHog key)', () => {
    const { events, run } = harness({ enabled: false });
    const { res, nexts } = run('/', GOOGLEBOT);
    res.finish();
    assert.equal(nexts, 1);
    assert.deepEqual(events, []);
  });
  it('survives a throwing capture and a broken request object', () => {
    const mw = crawlerLogger({ capture: () => { throw new Error('posthog down'); } });
    const res = fakeRes();
    let nexts = 0;
    mw(fakeReq('/', GOOGLEBOT), res, () => { nexts++; });
    assert.doesNotThrow(() => res.finish());
    assert.equal(nexts, 1);
    mw({ method: 'GET', url: '/' }, fakeRes(), () => { nexts++; });
    assert.equal(nexts, 2);
  });
});

describe('makeCapture', () => {
  const ev = { distinctId: 'crawler:gptbot', event: 'crawler_hit', properties: { bot: 'gptbot', family: 'ai', path: '/', status: 200, method: 'GET', page_kind: 'home', render: 'server', $process_person_profile: false } };

  it('POSTs the PostHog capture body to <host>/i/v0/e/ and logs one line', () => {
    const calls = [];
    const lines = [];
    const capture = makeCapture({ apiKey: 'phc_test', host: 'http://127.0.0.1:9/', fetchImpl: (url, init) => { calls.push({ url, init }); return Promise.resolve({}); }, log: (l) => lines.push(l) });
    capture(ev);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:9/i/v0/e/');
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].init.body), posthogBody('phc_test', ev));
    assert.deepEqual(JSON.parse(calls[0].init.body), { api_key: 'phc_test', event: 'crawler_hit', distinct_id: 'crawler:gptbot', properties: ev.properties });
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), { severity: 'INFO', message: 'crawler', crawler: { event: 'crawler_hit', bot: 'gptbot', family: 'ai', path: '/', status: 200, method: 'GET', page_kind: 'home', render: 'server' } });
    assert.equal(logLine(ev), lines[0]);
  });
  it('swallows a throwing fetch, a rejected fetch and a throwing logger', async () => {
    const boom = () => { throw new Error('boom'); };
    assert.doesNotThrow(() => makeCapture({ apiKey: 'k', fetchImpl: boom, log: boom })(ev));
    assert.doesNotThrow(() => makeCapture({ apiKey: 'k', fetchImpl: () => Promise.reject(new Error('down')), log: () => {} })(ev));
    await new Promise((r) => setImmediate(r)); // an unhandled rejection would fail the run
  });
});

// ── The same middleware under real Express ──────────────────────────────────

describe('crawlerLogger on an Express app', () => {
  it('sees a Googlebot GET to a page and nothing from a browser or an asset', async () => {
    const events = [];
    const app = express();
    app.use(crawlerLogger({ capture: (e) => events.push(e) }));
    app.get('/cards/:slug/', (_req, res) => res.type('html').send('<h1>Card</h1>'));
    app.get('/og-image.png', (_req, res) => res.type('png').send('1'));
    app.get('/healthz', (_req, res) => res.send('ok'));
    const server = app.listen(0);
    try {
      const { port } = server.address();
      const get = (p, ua) => fetch(`http://127.0.0.1:${port}${p}`, { headers: { 'user-agent': ua } });
      assert.equal((await get('/cards/amex-platinum/?utm_source=test', GOOGLEBOT)).status, 200);
      assert.equal((await get('/cards/amex-platinum/', CHROME)).status, 200);
      assert.equal((await get('/og-image.png', GOOGLEBOT)).status, 200);
      assert.equal((await get('/healthz', GOOGLEBOT)).status, 200);
      assert.equal((await get('/nowhere', 'GPTBot/1.2')).status, 404);
      await new Promise((r) => setImmediate(r));
    } finally {
      await new Promise((resolve) => server.close(() => resolve()));
    }
    assert.deepEqual(events, [
      { distinctId: 'crawler:google', event: 'crawler_hit', properties: {
        bot: 'google', family: 'search', path: '/cards/amex-platinum/', status: 200, method: 'GET',
        page_kind: 'card', render: 'server', $process_person_profile: false,
      } },
      { distinctId: 'crawler:gptbot', event: 'crawler_hit', properties: {
        bot: 'gptbot', family: 'ai', path: '/nowhere', status: 404, method: 'GET',
        page_kind: 'other', render: 'server', $process_person_profile: false,
      } },
    ]);
  });
});
