/**
 * Which search engines and AI assistants read worthmyfee.com — a durable
 * record, because nothing else keeps one. GitHub Pages keeps no server logs,
 * Search Console covers Google alone, and the in-page beacon this replaces
 * only fired for crawlers that run JavaScript (GPTBot, ClaudeBot,
 * PerplexityBot and CCBot never do). Every crawler GET/HEAD of a public page
 * becomes one PostHog `crawler_hit` (CCBT docs/search-console.md "Crawlers").
 *
 * Ported from heybooker.app (JCYMA crawlers.ts): the KNOWN_CRAWLERS table,
 * the bot/family names, the event shape and the hourly cap are identical so
 * the same PostHog queries work for both sites. Differences: `page_kind`
 * knows this site's paths, there is no `lang_prefix` (no translated pages),
 * and every event carries `render: 'server'` (the old beacon's rows say
 * `render: 'js'`).
 *
 * What is deliberately NOT recorded: the IP, cookies, the query string and —
 * for named bots — the User-Agent string itself. Only an unnamed bot (`bot:
 * other`, the generic fallback) keeps an 80-character `ua_sample`, so it can
 * be named here later.
 *
 * Pure functions plus a middleware factory that takes its `capture` as an
 * argument, so the whole thing is unit-tested without a server.
 */

/**
 * `ads` and `scanner` are this site's additions to heybooker.app's families:
 * Google's ad-review agents arrived with the first campaign (2026-10-08,
 * 112 hits in a day, each with a fake `?gclid=<integer>`), and the scanner
 * fleets probing a new host (blank User-Agent, Go-http-client, a WordPress
 * installer URL as the UA) outnumbered people 30:1 in the first week. Both
 * are excluded from the "human page views" queries by family.
 * @typedef {'search' | 'ai' | 'social' | 'seo' | 'ads' | 'scanner' | 'other'} CrawlerFamily
 */
/** @typedef {{ bot: string, family: CrawlerFamily }} Crawler */

// Substring match, case-insensitive, first hit wins — so a token that
// contains another ("Googlebot-Image" ⊃ "Googlebot", "Applebot-Extended" ⊃
// "Applebot") must come before the shorter one.
/** @type {ReadonlyArray<readonly [needle: string, bot: string, family: CrawlerFamily]>} */
export const KNOWN_CRAWLERS = [
  // Google Ads: landing-page review and quality checks. They fetch the final
  // URL with a made-up `?gclid=<integer>` and no referer; a real click
  // carries a long opaque gclid, UTM tags and a google.com referer.
  ['google-adwords-express', 'google_ads', 'ads'],
  ['google-ads-uls-service', 'google_ads', 'ads'],
  ['adsbot-google', 'google_ads', 'ads'],
  ['mediapartners-google', 'google_adsense', 'ads'],
  ['google-inspectiontool', 'google_inspection', 'search'],
  ['googlebot-image', 'google_image', 'search'],
  ['google-extended', 'google_extended', 'ai'],
  ['googlebot', 'google', 'search'],
  ['bingbot', 'bing', 'search'],
  ['oai-searchbot', 'openai_search', 'ai'],
  ['chatgpt-user', 'chatgpt_user', 'ai'],
  ['gptbot', 'gptbot', 'ai'],
  ['perplexitybot', 'perplexity', 'ai'],
  ['perplexity-user', 'perplexity_user', 'ai'],
  ['claudebot', 'claude', 'ai'],
  ['claude-user', 'claude_user', 'ai'],
  ['claude-searchbot', 'claude_user', 'ai'],
  ['anthropic-ai', 'anthropic', 'ai'],
  ['applebot-extended', 'apple_extended', 'ai'],
  ['applebot', 'apple', 'search'],
  ['duckduckbot', 'duckduckgo', 'search'],
  ['yandexbot', 'yandex', 'search'],
  ['baiduspider', 'baidu', 'search'],
  ['bytespider', 'bytedance', 'ai'],
  ['ccbot', 'commoncrawl', 'ai'],
  ['amazonbot', 'amazon', 'search'],
  // Meta runs several agents. The search indexer and the Meta AI link
  // previewer are named apart from the share-preview fetchers below, and
  // sit above them so no broader Meta rule can claim them first.
  ['meta-webindexer', 'meta_webindexer', 'search'],
  ['hatchfeed', 'meta_ai', 'ai'],
  ['agent.meta.ai', 'meta_ai', 'ai'],
  ['meta-externalagent', 'meta', 'social'],
  ['facebookexternalhit', 'meta', 'social'],
  ['twitterbot', 'twitter', 'social'],
  ['linkedinbot', 'linkedin', 'social'],
  ['slackbot', 'slack', 'social'],
  ['discordbot', 'discord', 'social'],
  ['ahrefsbot', 'ahrefs', 'seo'],
  ['semrushbot', 'semrush', 'seo'],
  ['mj12bot', 'majestic', 'seo'],
  ['dotbot', 'moz', 'seo'],
  ['awario', 'awario', 'seo'],
  ['prospectdb', 'prospectdb', 'seo'],
  // Operator unknown; first seen scraping the whole of heybooker.app (707
  // hits on 283 pages in 7 minutes). Named so it can be charted, and capped,
  // on its own instead of sharing the `other` bucket with every unnamed bot.
  ['shapbot', 'shapbot', 'other'],
  // Scanners: scripts probing a new host for software it does not run.
  // Named by tool so the human count is clean; nothing is blocked on it.
  ['wp-admin', 'wp_scanner', 'scanner'],          // its "UA" is the URL it probes
  ['mozlila', 'typo_scanner', 'scanner'],         // sic — a known scanner signature
  ['go-http-client', 'go_http', 'scanner'],
  ['python-requests', 'python', 'scanner'],
  ['python-urllib', 'python', 'scanner'],
  ['libwww-perl', 'perl', 'scanner'],
  ['curl/', 'curl', 'scanner'],                   // includes our own deploy check
  ['wget/', 'wget', 'scanner'],
  ['zgrab', 'zgrab', 'scanner'],
  ['masscan', 'masscan', 'scanner'],
];

/**
 * Whole-string matches (lower-cased, trimmed) for agents whose string is too
 * generic for a substring rule: bare "Google" would otherwise need the token
 * `google`, which is in every Google crawler's UA. Checked before the table.
 * @type {ReadonlyArray<readonly [ua: string, bot: string, family: CrawlerFamily]>}
 */
export const EXACT_UA = [
  // Arrived alongside Google-AdWords-Express when the first campaign went
  // live (51 hits on 2026-10-08): Google's, campaign-shaped, not a browser.
  ['google', 'google_plain', 'ads'],
  ['mozilla/5.0 (compatible)', 'compatible_only', 'scanner'],
  ['mozilla/5.0 (windows nt 10.0; win64; x64) applewebkit/537.36', 'bare_webkit', 'scanner'],
];

/** A request with no User-Agent at all: scripts and probes; browsers always send one. */
export const NO_UA = Object.freeze({ bot: 'none', family: 'scanner' });

// Anything that announces itself as automated without being on the list.
// `+http` is the convention for a crawler's info URL ("+http://…/bot.html").
const GENERIC_BOT_RE = /bot|crawler|spider|\+http/i;

/** The crawler a User-Agent belongs to, or null for a browser / unknown client. */
export function classifyCrawler(userAgent) {
  if (typeof userAgent !== 'string' || !userAgent.trim()) return { ...NO_UA };
  const ua = userAgent.toLowerCase();
  const trimmed = ua.trim();
  for (const [exact, bot, family] of EXACT_UA) {
    if (trimmed === exact) return { bot, family };
  }
  for (const [needle, bot, family] of KNOWN_CRAWLERS) {
    if (ua.includes(needle)) return { bot, family };
  }
  if (GENERIC_BOT_RE.test(userAgent)) return { bot: 'other', family: 'other' };
  return null;
}

/** The IndexNow key file: `/<32 hex>.txt` at the root. */
const INDEXNOW_KEY_FILE_RE = /^[a-f0-9]{32}\.txt$/;

/**
 * @typedef {'home' | 'cards_index' | 'card' | 'credit' | 'methodology' | 'about' | 'legal'
 *   | 'sitemap' | 'robots' | 'indexnow_key' | 'other'} PageKind
 */

/**
 * What kind of page a path is, from its shape alone. Trailing slash and a
 * trailing `index.html` are optional: `/cards/amex-platinum` (which 301s),
 * `/cards/amex-platinum/` and `/cards/amex-platinum/index.html` are all a
 * card. A slug that is not a real card still reads as `card`; the status
 * (404) says so.
 * @returns {PageKind}
 */
export function pageKind(pathname) {
  const segs = segmentsOf(pathname).map((s) => s.toLowerCase());
  if (segs.length > 0 && segs[segs.length - 1] === 'index.html') segs.pop();
  if (segs.length === 0) return 'home';
  const [head, ...rest] = segs;
  if (rest.length === 0) {
    if (head === 'sitemap.xml') return 'sitemap';
    if (head === 'robots.txt') return 'robots';
    if (INDEXNOW_KEY_FILE_RE.test(head)) return 'indexnow_key';
    if (head === 'privacy.html' || head === 'terms.html') return 'legal';
  }
  if (head === 'cards') {
    if (rest.length === 0) return 'cards_index';
    if (rest.length === 1) return 'card';
  }
  if (head === 'credits') return 'credit';
  if ((head === 'methodology' || head === 'about') && rest.length === 0) return head;
  return 'other';
}

const ASSET_EXT_RE = /\.(m?js|css|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|json|webmanifest)$/i;

/** Images, styles, scripts — a crawler fetching them is not reading a page. */
export function isStaticAsset(pathname) {
  return pathname.startsWith('/assets/') || ASSET_EXT_RE.test(pathname);
}

/** Paths answered by the server itself, never a page. */
export const HEALTH_PATHS = new Set(['/healthz', '/health']);

/** Pages worth a `crawler_hit`: not the health check, not an asset. */
export function shouldLogCrawlerPath(pathname) {
  if (HEALTH_PATHS.has(pathname)) return false;
  return !isStaticAsset(pathname);
}

/** The pathname of a request URL — query string and fragment dropped. */
export function pathnameOf(url) {
  const cut = url.search(/[?#]/);
  const p = cut === -1 ? url : url.slice(0, cut);
  return p.startsWith('/') ? p : '/' + p;
}

// ── Hourly cap ──────────────────────────────────────────────────────────────
// A misbehaving bot (or an SEO tool crawling the whole sitemap in a loop) must
// not turn into tens of thousands of billable events. Per bot, per clock hour:
// the first CRAWLER_HOURLY_CAP hits are recorded, the rest are dropped, and a
// single `crawler_hit_dropped` marks that the hour was capped.
//
// The buckets live in the process, so the cap is per Cloud Run instance. With
// min-instances 1 and a static site one instance carries nearly everything;
// a burst that scales out to N instances can record up to N × the cap.

export const CRAWLER_HOURLY_CAP = 2000;
export const UA_SAMPLE_MAX = 80;
export const PATH_MAX = 200;

/** @typedef {'ok' | 'drop_first' | 'drop'} CapVerdict */

export function makeHourlyCap(limit = CRAWLER_HOURLY_CAP, now = Date.now) {
  /** @type {Map<string, { hour: number, count: number, dropped: boolean }>} */
  const buckets = new Map();
  return {
    /** @returns {CapVerdict} */
    take(bot) {
      const hour = Math.floor(now() / 3_600_000);
      let b = buckets.get(bot);
      if (!b || b.hour !== hour) {
        // New hour: forget last hour's buckets (bot names are a short fixed
        // set plus 'other', so this is tidiness, not a leak fix).
        for (const [k, v] of buckets) if (v.hour !== hour) buckets.delete(k);
        b = { hour, count: 0, dropped: false };
        buckets.set(bot, b);
      }
      if (b.count < limit) { b.count += 1; return 'ok'; }
      if (!b.dropped) { b.dropped = true; return 'drop_first'; }
      return 'drop';
    },
  };
}

// ── Middleware ──────────────────────────────────────────────────────────────

/**
 * @typedef {{ distinctId: string, event: 'crawler_hit' | 'crawler_hit_dropped',
 *   properties: Record<string, unknown> }} CrawlerEvent
 */

/**
 * Express middleware: for a GET/HEAD from a known crawler to a public page,
 * capture one `crawler_hit` once the response has finished (so the status is
 * the real one). Never throws and never blocks the request — a logging
 * failure must not cost a page view, least of all a crawler's.
 *
 * @param {{ capture: (event: CrawlerEvent) => void, enabled?: boolean,
 *   cap?: { take(bot: string): CapVerdict } }} opts
 *   `enabled: false` (no PostHog key) makes it a pure pass-through.
 */
export function crawlerLogger(opts) {
  if (opts.enabled === false) return (_req, _res, next) => next();
  const cap = opts.cap ?? makeHourlyCap();
  return (req, res, next) => {
    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const rawUa = req.headers['user-agent'];
        const ua = Array.isArray(rawUa) ? rawUa[0] : rawUa;
        const crawler = classifyCrawler(ua);
        if (crawler) {
          const path = pathnameOf(req.originalUrl || req.url || '/');
          if (shouldLogCrawlerPath(path)) {
            const method = req.method;
            res.on('finish', () => {
              try { record(crawler, path, method, res.statusCode, ua); } catch { /* never surfaces */ }
            });
          }
        }
      }
    } catch { /* never surfaces */ }
    next();
  };

  function record(crawler, path, method, status, ua) {
    const distinctId = 'crawler:' + crawler.bot;
    const verdict = cap.take(crawler.bot);
    if (verdict === 'drop') return;
    if (verdict === 'drop_first') {
      opts.capture({ distinctId, event: 'crawler_hit_dropped', properties: {
        bot: crawler.bot, family: crawler.family, cap: CRAWLER_HOURLY_CAP, $process_person_profile: false,
      } });
      return;
    }
    /** @type {Record<string, unknown>} */
    const properties = {
      bot: crawler.bot,
      family: crawler.family,
      path: path.slice(0, PATH_MAX),
      status,
      method,
      page_kind: pageKind(path),
      render: 'server',
      $process_person_profile: false,
    };
    // The sample is for naming an unnamed bot, so it keys on the bot, not the
    // family: a named bot filed under family `other` (shapbot) carries none.
    if (crawler.bot === 'other' && ua) properties.ua_sample = ua.slice(0, UA_SAMPLE_MAX);
    opts.capture({ distinctId, event: 'crawler_hit', properties });
  }
}

// ── Capture: PostHog + one log line ────────────────────────────────────────

export const POSTHOG_DEFAULT_HOST = 'https://us.i.posthog.com';
const POSTHOG_TIMEOUT_MS = 5_000;

/**
 * The PostHog capture body for one event — the same shape posthog-node and
 * scripts/indexnow.mjs send to `/i/v0/e/`.
 */
export function posthogBody(apiKey, { distinctId, event, properties }) {
  return { api_key: apiKey, event, distinct_id: distinctId, properties };
}

/** One structured stdout line per event; Cloud Logging files it as jsonPayload. */
export function logLine({ event, properties }) {
  const { $process_person_profile: _omit, ...rest } = properties;
  return JSON.stringify({ severity: 'INFO', message: 'crawler', crawler: { event, ...rest } });
}

/**
 * The `capture` the server passes to crawlerLogger: writes the log line, then
 * fires the PostHog request without awaiting it. Every failure (PostHog down,
 * timeout, a throwing fetch, a broken stdout) is swallowed.
 */
export function makeCapture({ apiKey, host = POSTHOG_DEFAULT_HOST, fetchImpl = globalThis.fetch, log = (line) => console.log(line) }) {
  const url = host.replace(/\/+$/, '') + '/i/v0/e/';
  return (ev) => {
    try { log(logLine(ev)); } catch { /* ignored */ }
    try {
      Promise.resolve(fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(posthogBody(apiKey, ev)),
        signal: AbortSignal.timeout(POSTHOG_TIMEOUT_MS),
      })).then((r) => r?.body?.cancel?.(), () => {}).catch(() => {});
    } catch { /* ignored */ }
  };
}

function segmentsOf(pathname) {
  return pathname.split('/').filter(Boolean);
}
