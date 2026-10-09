# worthmyfee.com on Cloud Run — runbook

The marketing site is served by the Cloud Run service **`worthmyfee-site`**
(project `worthmyfee`, region `us-central1`), a small Node 22 + Express 4
server in `server/` that serves this repo's files verbatim and records every
crawler fetch. GitHub Pages keeps building every push as the **rollback**:
pointing DNS back at Pages restores it with current content.

Why a server at all: GitHub Pages runs none of our code, so nothing recorded
which crawlers read the site. The old in-page PostHog beacon only fired for
crawlers that run JavaScript (Googlebot, Bingbot, Applebot); GPTBot,
ClaudeBot, PerplexityBot, CCBot and the SEO tools never ran it. Cloudflare was
ruled out because its free plan needs the nameservers moved off Porkbun
(Fastmail MX/DKIM live there).

## Architecture

```
Porkbun DNS: worthmyfee.com A/AAAA → Cloud Run domain mapping
             www.worthmyfee.com CNAME ghs.googlehosted.com (server 301s → apex)
             app.worthmyfee.com unchanged (the app, Cloud Run service `worthmyfee`)

Cloud Run service `worthmyfee-site` (separate from the app; min 1, max 3 instances, 256Mi):
  server/server.mjs   express app: www → apex, /healthz + /health, crawlerLogger, file handler
  server/static.mjs   URL → file rules (GitHub Pages' behaviour), traversal guards
  server/crawlers.mjs crawler classification + PostHog `crawler_hit` (port of heybooker.app's crawlers.ts)
  /site               the repo's served files (Dockerfile + .dockerignore pick them)

GitHub Actions (.github/workflows/deploy.yml), every push to main:
  test     node --test + boot the server and curl it (also on PRs)
  deploy   gcloud run deploy --source . (Workload Identity Federation, no key files)
  indexnow scripts/indexnow.mjs, after the deploy AND the Pages build are live
```

Cloud Run's request logs (automatic) are the raw access log; PostHog holds
the `crawler_hit` events; one structured `crawler` line per hit also lands in
Cloud Logging so the record survives a PostHog outage.

The app repo (CCBT) is untouched except docs; the app keeps its "no
third-party analytics" promise and PostHog stays marketing-only.

## What the server does

Same answers as GitHub Pages:

| Request | Answer |
| --- | --- |
| `/`, `/cards/`, `/cards/amex-platinum/` | the directory's `index.html` |
| `/cards/amex-platinum` (directory, no slash) | **301** → `/cards/amex-platinum/` (query kept) |
| `/about/index.html`, `/privacy.html` | the file as named (no redirect) |
| `/privacy` | `privacy.html` (Pages' extensionless lookup) |
| `www.worthmyfee.com/<anything>` | **301** → `https://worthmyfee.com/<anything>` |
| unknown path | **404** with `404.html` (noindex; Pages uses the same file) |
| `/server/…`, `/docs/…`, `/scripts/…`, `Dockerfile`, `README.md`, `CNAME`, any dotfile | **404**, even from a checkout (`NOT_SERVED` in static.mjs) |
| `POST` and other methods | 405 |
| `/healthz`, `/health` | `ok` (text/plain), never a crawler hit |

Headers: `Cache-Control: public, max-age=600` (Pages' value), `ETag` and
`Last-Modified` with 304s, `X-Content-Type-Options: nosniff`,
`Strict-Transport-Security: max-age=31556952`, `Referrer-Policy:
strict-origin-when-cross-origin`; `.txt` is `text/plain`, `.xml` is
`application/xml`. HEAD works wherever GET does.

Security: the path is decoded once and refused if it holds an encoded `/` or
`\`, a NUL, a `.`/`..` segment or a segment starting with a dot; the resolved
file (after symlinks) must sit inside `SITE_DIR`. Files are sent verbatim —
no HTML rewriting, no injected scripts.

`/healthz` is reserved by Cloud Run's front end (paths ending in `z` may not
reach the container), so remote checks use `/health`; locally both answer.

## Crawler logging

`server/crawlers.mjs` is a port of heybooker.app's `crawlers.ts`: the same
`KNOWN_CRAWLERS` table, bot and family names, event shape and hourly cap, so
the PostHog queries in CCBT `docs/search-console.md` work for both sites.

- Event `crawler_hit`, `distinct_id` `crawler:<bot>`, `$process_person_profile: false`.
  Properties: `bot`, `family`, `path` (pathname only, ≤200 chars), `status`,
  `method`, `page_kind`, `render: 'server'`, and `ua_sample` (80 chars) for
  `bot = other` only. Rows from the old beacon say `render: 'js'`.
- `family`: heybooker.app's `search`, `ai`, `social`, `seo`, `other`, plus two
  of this site's own. `ads` = Google's ad-review agents
  (`Google-AdWords-Express`, `Google-Ads-ULS-Service`, `AdsBot-Google`, the
  bare `Google` UA), which fetch the landing page with a made-up
  `?gclid=<integer>` the day a campaign goes live. `scanner` = probes (a
  blank User-Agent → bot `none`, `Go-http-client`, `curl`, `python-requests`,
  a WordPress installer URL as the UA, the misspelt `Mozlila`, the stub
  `Mozilla/5.0 (compatible)`); in the first week they outnumbered people
  about 30:1. `EXACT_UA` holds the whole-string matches; nothing is blocked.
- `page_kind`: `home`, `cards_index`, `card`, `credit`, `methodology`,
  `about`, `legal` (privacy/terms), `sitemap`, `robots`, `indexnow_key`
  (`/<32 hex>.txt`), `other`.
- GET and HEAD only; images/CSS/JS (`isStaticAsset`) and the health check are
  skipped. 404s and 301s are recorded with their real status.
- Never recorded: IP, cookies, query string, a named bot's User-Agent.
- Hourly cap: 2,000 `crawler_hit` per bot per clock hour, then one
  `crawler_hit_dropped`. The cap lives in process memory, so it is per
  instance; with min-instances 1 one instance carries nearly all traffic, but
  a burst that scales out to N instances can record up to N × the cap.
- Delivery: recorded on the response's `finish`, a fire-and-forget `fetch` to
  `https://us.i.posthog.com/i/v0/e/` with a 5-second timeout; every error is
  swallowed, so logging can never cost a page view.
- Off unless `POSTHOG_API_KEY` is set (the public `phc_` key, a plain env var
  from the repo variable). `POSTHOG_HOST` overrides the endpoint (tests).

## Deploy

Automatic: every push to main runs `.github/workflows/deploy.yml`.

1. **test** — `node --test scripts/*.test.mjs server/*.test.mjs`, then boots
   `server.mjs` with `SITE_DIR=..` and curls `/healthz`, `/`, the slashless
   card 301, the key file, and 404s for `/server/`, `/docs/`, `/scripts/`.
2. **deploy** — authenticates with Workload Identity Federation
   (`vars.WIF_PROVIDER`, `vars.WIF_SERVICE_ACCOUNT`), runs
   `gcloud run deploy worthmyfee-site --source .` (Cloud Build builds the
   Dockerfile, as for the app's deploy.sh) with `GIT_SHA` and
   `POSTHOG_API_KEY` env vars and a `git-sha` label, waits until the revision
   carrying this commit serves 100% of traffic, then curls `/health`, a card
   page, the 301, a 404 and the key file on the `*.run.app` URL. Until the
   two WIF variables exist the job skips itself with a notice.
3. **indexnow** — waits for the Pages build of this commit (Pages is the
   rollback, so submitted URLs must exist there too), then
   `scripts/indexnow.mjs`. It also runs while the deploy is skipped. Manual
   run with **all** resubmits every sitemap URL.

Runs share the concurrency group `deploy`, so two pushes never deploy at once.

The image (`Dockerfile`): stage `site` copies the context (trimmed by
`.dockerignore`) to `/site` and drops `server/`; the final stage installs
`server/`'s production dependencies, copies the server to `/app` and the site
from stage `site`, and runs `node server.mjs` as `node`.
`server/static.test.mjs` checks the `.dockerignore` list against `NOT_SERVED`.

Manual deploy (same flags, from a clean checkout of main):

```bash
gcloud run deploy worthmyfee-site --source . --project worthmyfee --region us-central1 \
  --allow-unauthenticated --min-instances 1 --max-instances 3 --memory 256Mi --cpu 1 \
  --port 8080 --service-account wmf-site@worthmyfee.iam.gserviceaccount.com \
  --update-env-vars "GIT_SHA=$(git rev-parse HEAD)" --update-labels "git-sha=$(git rev-parse --short HEAD)"
```

## Run locally

```bash
cd server && npm ci
SITE_DIR=.. PORT=3200 node server.mjs                       # crawler logging off
SITE_DIR=.. PORT=3200 POSTHOG_API_KEY=phc_… node server.mjs # sends real crawler_hit events
curl -sI http://localhost:3200/cards/amex-platinum          # 301
curl -s -A 'GPTBot/1.0' http://localhost:3200/ >/dev/null   # one crawler line on stdout when the key is set
```

Tests: `node --test scripts/*.test.mjs server/*.test.mjs` from the repo root
(after `npm ci` in `server/`). No root `package.json`, ever: Pages serves the
root, and `scripts/indexnow.mjs` stays dependency-free.

## Reading the logs

AI crawler fetches from the raw request log:

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="worthmyfee-site" AND httpRequest.userAgent:("GPTBot" OR "ClaudeBot" OR "PerplexityBot")' --project worthmyfee --limit 50 --format='value(timestamp,httpRequest.userAgent,httpRequest.requestUrl,httpRequest.status)'
```

The server's own crawler lines (same fields as the PostHog event, no IP):

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="worthmyfee-site" AND jsonPayload.message="crawler"' --project worthmyfee --limit 100 --format='value(timestamp,jsonPayload.crawler.bot,jsonPayload.crawler.page_kind,jsonPayload.crawler.path,jsonPayload.crawler.status)'
```

Hits per bot over the last week:

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="worthmyfee-site" AND jsonPayload.message="crawler" AND timestamp>="'$(date -u -d '-7 days' +%Y-%m-%dT%H:%M:%SZ)'"' --project worthmyfee --limit 20000 --format=json | jq -r '.[].jsonPayload.crawler.bot' | sort | uniq -c | sort -rn
```

Human page views per day — the request log minus every crawler family. The
`Mozilla/5.0 (` requirement drops the blank, `curl`, Go and Python agents;
the exclusions drop the rest of the named families. Scanner fleets using
stale browser strings (Chrome/89, iPhone OS 13_2_3) still slip through, so
look at the user-agent breakdown before quoting a number:

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="worthmyfee-site" AND httpRequest.requestUrl:* AND httpRequest.userAgent:"Mozilla/5.0 (" AND NOT httpRequest.userAgent:("bot" OR "Bot" OR "crawler" OR "spider" OR "+http" OR "Google" OR "compatible)" OR "Mozlila" OR "wp-admin") AND timestamp>="'$(date -u -d '-7 days' +%Y-%m-%dT%H:%M:%SZ)'"' --project worthmyfee --limit 20000 --format='value(timestamp.date("%Y-%m-%d"),httpRequest.requestUrl)' | grep -vE '\.(png|ico|svg|css|js|webmanifest|txt|xml)(\?|$)' | cut -f1 | sort | uniq -c
```

A paid click: `httpRequest.requestUrl:"utm_medium=cpc"` (long `gclid`, UTM
tags, google.com referer); the fake-gclid rows without UTM tags are the `ads`
family checking the landing page.

(macOS: `date -u -v-7d +%Y-%m-%dT%H:%M:%SZ`.) Errors: `jsonPayload.message="site-error"`.
Boot line: `jsonPayload.message="site-listening"` (shows `gitSha` and whether
crawler logging is on). Request logs are kept 30 days (the `_Default` bucket).

## Owner steps (one-time setup)

Nothing here can be done from a coding session; run these with an account
that owns the project.

### 1. GCP: service accounts and Workload Identity Federation

```bash
PROJECT=worthmyfee
PROJECT_NUMBER=$(gcloud projects describe $PROJECT --format='value(projectNumber)')
REPO=echocharlielabs/worthmyfee.com
DEPLOYER=wmf-site-deployer@$PROJECT.iam.gserviceaccount.com
RUNTIME=wmf-site@$PROJECT.iam.gserviceaccount.com

gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com --project $PROJECT

# Runtime identity: no roles — the server reads no GCP APIs.
gcloud iam service-accounts create wmf-site --project $PROJECT --display-name "worthmyfee.com site (Cloud Run runtime)"
# Deploy identity for GitHub Actions.
gcloud iam service-accounts create wmf-site-deployer --project $PROJECT --display-name "worthmyfee.com deploy (GitHub Actions)"

for role in roles/run.admin roles/cloudbuild.builds.editor roles/artifactregistry.writer roles/storage.admin roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding $PROJECT --member "serviceAccount:$DEPLOYER" --role "$role" --condition=None
done
# Deploy as the runtime account…
gcloud iam service-accounts add-iam-policy-binding $RUNTIME --project $PROJECT \
  --member "serviceAccount:$DEPLOYER" --role roles/iam.serviceAccountUser
# …and let source builds run as Cloud Build's service account (the Compute
# default account in projects created since 2024; check Cloud Build →
# Settings if the deploy says it cannot act as another account).
gcloud iam service-accounts add-iam-policy-binding $PROJECT_NUMBER-compute@developer.gserviceaccount.com --project $PROJECT \
  --member "serviceAccount:$DEPLOYER" --role roles/iam.serviceAccountUser

# GitHub OIDC → the deployer, for this repo's main branch only.
gcloud iam workload-identity-pools create github --project $PROJECT --location global --display-name "GitHub Actions"
gcloud iam workload-identity-pools providers create-oidc worthmyfee-com --project $PROJECT --location global \
  --workload-identity-pool github --display-name "echocharlielabs/worthmyfee.com" \
  --issuer-uri https://token.actions.githubusercontent.com \
  --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
  --attribute-condition "assertion.repository == '$REPO' && assertion.ref == 'refs/heads/main'"
gcloud iam service-accounts add-iam-policy-binding $DEPLOYER --project $PROJECT --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/$REPO"

echo "WIF_PROVIDER=projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/worthmyfee-com"
echo "WIF_SERVICE_ACCOUNT=$DEPLOYER"
```

`roles/run.admin` + `roles/cloudbuild.builds.editor` +
`roles/artifactregistry.writer` + `roles/storage.admin` (the Cloud Build
source bucket) is the list; `roles/run.sourceDeveloper` is the broader
single-role alternative.

### 2. GitHub repo variables

Settings → Secrets and variables → Actions → **Variables** (none of these are
secret):

```bash
gh variable set WIF_PROVIDER --repo echocharlielabs/worthmyfee.com --body "projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/github/providers/worthmyfee-com"
gh variable set WIF_SERVICE_ACCOUNT --repo echocharlielabs/worthmyfee.com --body "wmf-site-deployer@worthmyfee.iam.gserviceaccount.com"
gh variable set POSTHOG_API_KEY --repo echocharlielabs/worthmyfee.com --body "$(grep -o "phc_[A-Za-z0-9]*" index.html | head -1)"
```

### 3. First deploy

Merge the PR (or re-run the Deploy workflow on main). Then:

```bash
URL=$(gcloud run services describe worthmyfee-site --project worthmyfee --region us-central1 --format='value(status.url)')
curl -s "$URL/health"                                  # ok
curl -sI "$URL/cards/amex-platinum" | head -3          # 301 → /cards/amex-platinum/
curl -s -o /dev/null -w '%{http_code}\n' "$URL/cards/amex-platinum/"   # 200
```

### 4. Domain mapping

```bash
gcloud domains list-user-verified        # worthmyfee.com should be listed (Search Console verified it)
gcloud beta run domain-mappings create --service worthmyfee-site --domain worthmyfee.com --region us-central1 --project worthmyfee
gcloud beta run domain-mappings create --service worthmyfee-site --domain www.worthmyfee.com --region us-central1 --project worthmyfee
gcloud beta run domain-mappings describe --domain worthmyfee.com --region us-central1 --project worthmyfee --format='yaml(status.resourceRecords)'
gcloud beta run domain-mappings describe --domain www.worthmyfee.com --region us-central1 --project worthmyfee --format='yaml(status.resourceRecords)'
```

If `create` says the domain is not verified: `gcloud domains verify
worthmyfee.com` and finish in Search Console with the same Google account.
The apex prints four A and four AAAA records; `www` prints a CNAME to
`ghs.googlehosted.com`.

### 5. Porkbun DNS

- Lower the TTL of the records you are about to change to 300 first, so a rollback is quick.
- Replace the four GitHub Pages **A** records (185.199.108.153, 185.199.109.153,
  185.199.110.153, 185.199.111.153) and the Pages **AAAA** records
  (2606:50c0:8000::153 … 2606:50c0:8003::153) with the ones step 4 printed.
- Change **www** CNAME `echocharlielabs.github.io` → `ghs.googlehosted.com`.
- Touch nothing else: Fastmail MX/DKIM/SPF, the `google-site-verification`
  TXT record, `app`.

Google provisions the certificate once DNS resolves (up to about an hour);
`gcloud beta run domain-mappings describe --domain worthmyfee.com …` shows
`CertificateProvisioned: True` when done.

### 6. Verify

```bash
curl -sI https://worthmyfee.com/ | grep -i '^server'                 # Google Frontend (not GitHub.com)
curl -sI https://worthmyfee.com/cards/amex-platinum | head -3        # 301 → /cards/amex-platinum/
curl -s https://worthmyfee.com/f0290cd3888f72fc154819a874bea7b5.txt  # the key
curl -sI https://www.worthmyfee.com/cards/ | grep -i '^location'     # https://worthmyfee.com/cards/
```

Then watch for the first crawler line (query under "Reading the logs") and
the first `crawler_hit` with `render = 'server'` in PostHog.

### 7. Rollback

- **Bad deploy**: send traffic back to the previous revision.
  ```bash
  gcloud run revisions list --service worthmyfee-site --region us-central1 --project worthmyfee --limit 5
  gcloud run services update-traffic worthmyfee-site --to-revisions <previous-revision>=100 --region us-central1 --project worthmyfee
  ```
  The next deploy routes traffic to the newest revision again.
- **Back to GitHub Pages**: restore the Pages A/AAAA records above and the
  `www` CNAME `echocharlielabs.github.io` at Porkbun. Pages builds every push,
  so content is current. Leave the custom domain configured in the repo's
  Pages settings. Its certificate for the custom domain stops renewing while
  DNS points elsewhere; after ~90 days a rollback may need about an hour for
  Pages to re-issue it. Crawler logging stops while Pages serves the site.
