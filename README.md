# rss-opds

Read your RSS on an e-ink reader. **rss-opds** is a small [Cloudflare Worker](https://workers.cloudflare.com/) that publishes a [CommaFeed](https://www.commafeed.com) account as an **OPDS catalog** and serves every article as a generated **EPUB**. It runs entirely on Cloudflare's free plan: no server, no database, nothing to keep running.

Works with the Xteink X4 / X4 Pro stock firmware ("XT Licorice" and later), CrossPoint, KOReader and any other OPDS-capable reader.

*Türkçe kurulum rehberi: [README_TR.md](README_TR.md)*

```
e-reader  ──OPDS/HTTPS──▶  Cloudflare Worker  ──API key──▶  CommaFeed
(Xteink…)  ◀── EPUB ───────  (this project)     ◀── JSON ────  (commafeed.com or self-hosted)
```

## Features

- Catalog of unread, starred and all articles, by category and by feed, with search and pagination.
- One EPUB per article, generated on the fly (EPUB 3 package with an EPUB 2 table of contents for older readers).
- Optional **full text**: before building the EPUB the article URL can be sent to Instaparser, Diffbot or Instapaper, in a configurable order, with fallback to the feed text. Results are cached for a day.
- Optional **images** embedded in the EPUB.
- Both switchable **per catalog URL** (`?images=1`, `?full=1`), so one deployment can serve a fast text-only catalog and a rich one.
- Optional **mark as read** in CommaFeed when an article is downloaded.
- Catalog protected by HTTP Basic auth (what reader OPDS settings send), or by a secret path token for readers that cannot send credentials.

## Catalog layout

| Path | Content |
|---|---|
| `/opds` | Root menu |
| `/opds/unread` | Unread articles, newest first (paged) |
| `/opds/starred` | Starred articles |
| `/opds/all` | Recent articles including read ones |
| `/opds/categories` → `/opds/category/<id>` | By category |
| `/opds/feeds` → `/opds/feed/<id>` | By subscription |
| `/opds/search?q=word` | Search (OpenSearch description at `/opds/search.xml`) |
| `/book/<id>/<title>.epub` | The article as an EPUB |
| `/opds/yandex?path=/sub` | EPUB files of a public Yandex Disk share (optional) |

Category and feed listings show unread articles by default; add `?read=all` for everything. Readers with weak menu support can be pointed directly at `/opds/unread`.

Switches, carried into every generated link: `?images=1` / `?images=0` and `?full=1` / `?full=0`. They can be combined: `/opds?full=1&images=1`. Without the parameter the deployed defaults (`INCLUDE_IMAGES`, `FULLTEXT`) apply. The root menu also offers toggle entries.

## JSON API (for mini apps)

Small clients that cannot read OPDS or EPUB, such as the Xteink X4 Pro **Mini Apps** (Lua, XTOS Licorice API 2.9), get the same account as compact JSON under the same auth prefix (`/k/<token>/api/...` or HTTP Basic):

| Path | Content |
|---|---|
| `/api/list?kind=unread\|starred\|all&page=N&n=M` | Article list: `{title, page, has_more, items:[{id, title, feed, date, read, starred, excerpt}]}` (excerpt: up to 400 characters of plain text) |
| `/api/list?kind=category\|feed&id=<id>` | Same for one category or subscription (`&read=all` includes read ones) |
| `/api/list?kind=search&q=word` | Keyword search |
| `/api/categories`, `/api/feeds` | `{items:[{id, name, unread, ...}]}` |
| `/api/article/<id>?max=<chars>&mark=1` | One article as plain text: `{id, title, feed, author, date, url, source, text}`; `mark=1` marks it read |
| `/api/mark/<id>?read=0\|1` | Mark read / unread |

`?full=1` works here too: the text comes from the sanitizer chain when one is configured. The Xteink client lives in the [touch-licorice-apps](https://github.com/omer-faruq-xteink/touch-licorice-apps) repo.

## Setup (about 10 minutes)

### 1. CommaFeed API key

In the CommaFeed web app open **Settings → Profile**, generate an **API key** and copy it. Only the key is stored, never your password. CommaFeed regenerates the key when you change your password; update the secret then.

Alternative: set `COMMAFEED_USER` and `COMMAFEED_PASSWORD` instead (HTTP Basic, the same method the KOReader RSS plugin uses). It works, but the key is safer: if it leaks you just regenerate it.

### 2. Cloudflare account

Create a free account at [dash.cloudflare.com](https://dash.cloudflare.com) (no credit card). The Workers free plan is enough.

### 3A. Deploy from the command line (recommended)

Needs Node.js 18+.

```bash
git clone https://github.com/omer-faruq-xteink/rss-opds.git
cd rss-opds
npm install
npx wrangler login
npx wrangler secret put COMMAFEED_API_KEY
npx wrangler secret put OPDS_USER
npx wrangler secret put OPDS_PASS
```

Optional, in the same way (any subset; see the sections below for what they do):

```bash
npx wrangler secret put INSTAPARSER_TOKEN   # full text via Instaparser
npx wrangler secret put DIFFBOT_TOKEN       # full text via Diffbot
npx wrangler secret put INSTAPAPER_TOKEN    # full text via Instapaper
npx wrangler secret put YANDEX_PUBLIC_URL   # your EPUBs from a public Yandex Disk folder
```

Then:

```bash
npx wrangler deploy
```

Secrets take effect immediately and survive later deploys. `wrangler deploy` prints an address like `https://commafeed-opds.<account>.workers.dev`. Your catalog URL is **`https://commafeed-opds.<account>.workers.dev/opds`**.

Open `/health` in a browser: it should print `ok`. Opening `/opds` asks for the username and password and then shows the catalog XML.

### 3B. Deploy from the Cloudflare dashboard

1. Fork this repository on GitHub.
2. In the dashboard choose **Workers & Pages → Create → Import a repository** and pick the fork. The deploy command is `npx wrangler deploy` (the default).
3. After the Worker exists, add the **secrets** under **Settings → Variables and Secrets**: `COMMAFEED_API_KEY`, `OPDS_USER`, `OPDS_PASS`, plus any optional ones (`INSTAPARSER_TOKEN`, `DIFFBOT_TOKEN`, `INSTAPAPER_TOKEN`, `YANDEX_PUBLIC_URL`). Save and redeploy.

### 4. Add the catalog to your reader

**Xteink X4 / X4 Pro (stock firmware, XT Licorice and later):**
connect to Wi-Fi, open **OPDS catalog list → Add catalog**:

- Name: `CommaFeed`
- Catalog URL: `https://commafeed-opds.<account>.workers.dev/opds`
- Expand "Account and password": the `OPDS_USER` / `OPDS_PASS` values
- **Test**, then **Save**

**CrossPoint (1.3+):** Settings → Connectivity → OPDS Servers → Add Server; same URL, username and password (fill in both: with an empty password the username is not sent).

**KOReader:** Search → OPDS catalog → + ; URL, username, password.

Pick an article and download it; it appears in the library as `Feed-Title.epub`.

## Full text (sanitizers)

Feeds often carry only a summary. With one or more of these tokens configured the Worker fetches the complete, cleaned article before building the EPUB, the same way the KOReader rssreader plugin does. Services are tried in order; if all fail the feed text is used. Results are cached for 24 hours per article.

| Service | Secret | Where to get it |
|---|---|---|
| Instaparser | `INSTAPARSER_TOKEN` | [instaparser.com](https://www.instaparser.com) account, API token |
| Diffbot | `DIFFBOT_TOKEN` | [diffbot.com](https://www.diffbot.com) account, API token |
| Instapaper | `INSTAPAPER_TOKEN` | personal access token from [instapaper.com/developers/applications](https://www.instapaper.com/developers/applications). The article is saved to the account, its parsed text read back, then the bookmark is deleted; a separate Instapaper account for this is recommended |

- `SANITIZERS` sets the order (default `instaparser,diffbot,instapaper`); services without a token are skipped.
- `FULLTEXT=true` makes full text the default; `?full=1` / `?full=0` on the catalog URL overrides it per reader.
- Metered plans spend one call per download; the download cache prevents repeat spending for the same article.
- Advanced: `INSTAPARSER_ENDPOINT`, `DIFFBOT_ENDPOINT`, `DIFFBOT_TIMEOUT_MS`, `DIFFBOT_MODE`, `INSTAPAPER_API_BASE` override the endpoints (for tests or self-hosted setups).

Readability-style extraction inside the Worker itself is not offered: parsing a large page costs far more than the free plan's 10 ms of CPU per request. Waiting on an external service does not count toward that limit.

## Your own EPUBs from Yandex Disk

Besides CommaFeed, the catalog can list EPUB files kept in a **publicly shared Yandex Disk folder**. Yandex's public-resources API needs no token, so the setup is one variable:

1. In Yandex Disk, create a folder (for example `Books`), put your `.epub` files in it (subfolders are fine), right-click → **Share** → copy the link (`https://disk.yandex.ru/d/XXXX`).
2. Set `YANDEX_PUBLIC_URL` to that link, either as a var in `wrangler.toml` (or the dashboard) and redeploy, or as a secret with `npx wrangler secret put YANDEX_PUBLIC_URL` if you do not want the link in your repository. Not both: a var in `wrangler.toml` replaces the secret on every deploy.
3. The root menu gains a **Yandex Disk** entry; folders open as sub-catalogs, files download through the Worker (the device never talks to Yandex directly).

Several folders: separate the links with commas, optionally with a label before `|`, for example `Books|https://disk.yandex.ru/d/AAA, Magazines|https://disk.yandex.ru/d/BBB`. Each share becomes its own root-menu entry.

Only `.epub` files are listed. Anyone with the share link can read the folder, so keep it for books you are happy to share; the catalog itself is still behind your OPDS login.

## Configuration

Variables (`[vars]` in `wrangler.toml`, or the dashboard):

| Variable | Default | Meaning |
|---|---|---|
| `COMMAFEED_URL` | `https://www.commafeed.com` | Your CommaFeed instance, if self-hosted |
| `CATALOG_TITLE` | `CommaFeed` | Catalog name shown on the reader |
| `PAGE_SIZE` | `30` | Articles per page (max 60; some readers cap feeds at ~62 entries) |
| `INCLUDE_IMAGES` | `false` | Default image behaviour (`?images=1/0` overrides per URL) |
| `MAX_IMAGES` | `8` | Max images embedded per article |
| `MARK_READ_ON_DOWNLOAD` | `false` | Mark the article as read in CommaFeed after download |
| `LANG` | `tr` | Language tag written into the EPUBs (hyphenation) |
| `FULLTEXT` | `false` | Default full-text behaviour (`?full=1/0` overrides per URL) |
| `SANITIZERS` | `instaparser,diffbot,instapaper` | Order of full-text services |
| `YANDEX_PUBLIC_URL` | empty | Share link(s) of public Yandex Disk folders with EPUBs, comma-separated, optional `Label|` prefix (see above) |

Secrets (`npx wrangler secret put NAME`):

| Secret | Required | Meaning |
|---|---|---|
| `COMMAFEED_API_KEY` | one of** | CommaFeed API key (recommended) |
| `COMMAFEED_USER`, `COMMAFEED_PASSWORD` | one of** | Alternative: CommaFeed username and password |
| `OPDS_USER`, `OPDS_PASS` | one of* | Basic-auth username and password of the catalog |
| `OPDS_TOKEN` | one of* | Alternative: the catalog is served without a password at `https://…/k/<OPDS_TOKEN>/opds` |
| `INSTAPARSER_TOKEN`, `DIFFBOT_TOKEN`, `INSTAPAPER_TOKEN` | no | Full-text services (see above) |

\* At least one protection must be configured; both may be. The token form is for readers that cannot send credentials; do not share that URL.
\*\* API key or username + password; if both are set, username + password wins.

## Local development and tests

```bash
npm test                         # offline unit tests (HTML→XHTML, EPUB, OPDS XML)
cp .dev.vars.example .dev.vars   # fill in your real values
npm run dev                      # http://127.0.0.1:8787/opds
```

End-to-end without a real account, against a fake CommaFeed:

```bash
node test/mock-commafeed.mjs 8790
npx wrangler dev --var COMMAFEED_URL:http://127.0.0.1:8790   # .dev.vars: COMMAFEED_API_KEY="testkey"
```

The Yandex Disk source against a fake API: `node test/mock-yandex.mjs 8792` and `npx wrangler dev --var YANDEX_PUBLIC_URL:https://disk.yandex.ru/d/TESTSHARE --var YANDEX_API_BASE:http://127.0.0.1:8792`.

The sanitizer chain against fake services (`.dev.vars`: `INSTAPARSER_TOKEN="ip-token"`, `DIFFBOT_TOKEN="db-token"`, `INSTAPAPER_TOKEN="pp-token"`):

```bash
node test/mock-sanitizers.mjs 8791
npx wrangler dev --var COMMAFEED_URL:http://127.0.0.1:8790 --var INSTAPARSER_ENDPOINT:http://127.0.0.1:8791/instaparser/api/1/article --var DIFFBOT_ENDPOINT:http://127.0.0.1:8791/diffbot/v3/analyze --var INSTAPAPER_API_BASE:http://127.0.0.1:8791/instapaper/api/2
```

Notes for Windows: if `wrangler dev` fails with `SQLITE_CANTOPEN`, the project path is too long; add `--persist-to C:\Temp\wrangler-state`. Quote `.dev.vars` values that contain `#` (for example a password): `COMMAFEED_PASSWORD="ab#cd"`, otherwise everything after `#` is treated as a comment. `wrangler secret put` is not affected.

## How it works

- **Listing:** the CommaFeed REST API (`/rest/category/entries`, `/rest/feed/entries`, `?apiKey=`) is read page by page and converted to an OPDS 1.2 Atom acquisition feed. Entry ids are `urn:commafeed:entry:<id>`.
- **EPUB:** a single article is fetched through CommaFeed's Google Reader compatible API (`stream/items/contents`, `Authorization: GoogleLogin auth=<apiKey>`). The HTML is converted to valid XHTML by a small DOM-less tokenizer (scripts, iframes and event handlers removed, tags balanced). The EPUB is a stored (uncompressed) ZIP with `mimetype` as its first entry.
- **Mark as read:** `token` + `edit-tag` of the same API in API-key mode, `/rest/entry/mark` in username/password mode.
- **Cache:** generated EPUBs stay in Cloudflare's cache for 6 hours; authentication is checked on every request.

## Limits

- Cloudflare free plan: 100,000 requests per day and 10 ms CPU per request. One EPUB needs a fraction of that.
- Without a sanitizer the content is whatever the feed delivers; a summary-only feed gives a summary-only EPUB.
- If a reader's OPDS client does not handle navigation feeds, use `/opds/unread` directly.

## Roadmap

- Dropbox / Google Drive folders as further sources (Yandex Disk is done)
- Private (token-based) Yandex Disk folders
- CrossPoint plugin support
- FiveFilters sanitizer and a monthly call-quota counter

## License

MIT
