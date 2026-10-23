// commafeed-opds: publishes a CommaFeed account as an OPDS catalog.
//
// Routes (all under the optional "/k/<OPDS_TOKEN>" prefix, see auth below):
//   /                      navigation root (also /opds, /opds.xml)
//   /opds/unread           unread articles, newest first      (?page=N)
//   /opds/all              all recent articles                (?page=N)
//   /opds/starred          starred articles                   (?page=N)
//   /opds/categories       navigation: one entry per category
//   /opds/category/<id>    articles of a category  (?read=all to include read ones)
//   /opds/feeds            navigation: one entry per subscription
//   /opds/feed/<id>        articles of a subscription (?read=all)
//   /opds/search?q=...     keyword search
//   /opds/search.xml       OpenSearch description
//   /book/<entryId>/<slug>.epub   the article as an EPUB
//   /opds/yandex?path=/sub  EPUB files of a public Yandex Disk share (if YANDEX_PUBLIC_URL is set)
//   /yd/<encoded path>/<name>.epub  download of such a file, proxied
//   /health                unauthenticated liveness check
import { CommaFeed, CommaFeedError, normalizeRestEntry } from './commafeed.js';
import { acquisitionFeed, mixedFeed, navigationFeed, openSearchDescription } from './opds.js';
import * as yandex from './sources/yandex.js';
import { buildEpub, collectImageUrls, slugify } from './epub.js';
import { textExcerpt } from './html.js';
import { configuredChain, extractFullText } from './sanitizers.js';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (err) {
      const status = err instanceof CommaFeedError ? (err.status === 401 || err.status === 403 ? 502 : 502) : 500;
      const msg = err instanceof CommaFeedError && (err.status === 401 || err.status === 403)
        ? `CommaFeed rejected the credentials (HTTP ${err.status}). Check COMMAFEED_API_KEY (or COMMAFEED_USER/COMMAFEED_PASSWORD) and COMMAFEED_URL.`
        : `Error: ${err && err.message ? err.message : String(err)}`;
      console.error(msg, err && err.stack);
      return text(msg, status);
    }
  },
};

function text(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}
function xml(body, type) {
  return new Response(body, { status: 200, headers: { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' } });
}
function unauthorized() {
  return new Response(null, {
    status: 401,
    headers: { 'www-authenticate': 'Basic realm="CommaFeed OPDS", charset="UTF-8"', 'cache-control': 'no-store' },
  });
}

function timingSafeEqual(a, b) {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

/**
 * Authentication. Two schemes, both optional but at least one must be configured:
 *  - HTTP Basic (OPDS_USER / OPDS_PASS): what the "account / password" fields of
 *    e-reader OPDS settings send.
 *  - Path token (OPDS_TOKEN): the catalog lives under /k/<token>/... for readers
 *    that cannot send credentials. Generated links keep the prefix.
 * Returns {ok, prefix} or a Response.
 */
function authenticate(request, env, pathname) {
  const hasBasic = !!(env.OPDS_USER && env.OPDS_PASS);
  const hasToken = !!env.OPDS_TOKEN;
  if (!hasBasic && !hasToken) {
    return text('Not configured: set the OPDS_USER and OPDS_PASS secrets (or OPDS_TOKEN). See README.', 500);
  }
  if (hasToken) {
    const m = /^\/k\/([^/]+)(\/.*)?$/.exec(pathname);
    if (m && timingSafeEqual(decodeURIComponent(m[1]), env.OPDS_TOKEN)) {
      return { ok: true, prefix: `/k/${m[1]}`, path: m[2] || '/' };
    }
  }
  if (hasBasic) {
    const h = request.headers.get('authorization') || '';
    if (/^basic /i.test(h)) {
      let decoded = '';
      try { decoded = atob(h.slice(6).trim()); } catch { decoded = ''; }
      // atob gives latin1; re-decode as UTF-8 for non-ASCII passwords
      try { decoded = new TextDecoder().decode(Uint8Array.from(decoded, (c) => c.charCodeAt(0))); } catch { /* keep */ }
      const idx = decoded.indexOf(':');
      const user = idx === -1 ? decoded : decoded.slice(0, idx);
      const pass = idx === -1 ? '' : decoded.slice(idx + 1);
      if (timingSafeEqual(user, env.OPDS_USER) && timingSafeEqual(pass, env.OPDS_PASS)) {
        return { ok: true, prefix: '', path: pathname };
      }
    }
    return unauthorized();
  }
  return new Response('Not found', { status: 404 });
}

function cfg(env) {
  const pageSize = Math.max(1, Math.min(60, parseInt(env.PAGE_SIZE || '30', 10) || 30));
  return {
    title: env.CATALOG_TITLE || 'CommaFeed',
    pageSize,
    includeImages: String(env.INCLUDE_IMAGES || '').toLowerCase() === 'true',
    maxImages: Math.max(0, Math.min(30, parseInt(env.MAX_IMAGES || '8', 10) || 8)),
    markRead: String(env.MARK_READ_ON_DOWNLOAD || '').toLowerCase() === 'true',
    lang: env.LANG || 'en',
    fullText: String(env.FULLTEXT || '').toLowerCase() === 'true',
    chain: configuredChain(env),
    shares: yandex.shares(env),
  };
}

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname === '/health') return text('ok');
  if (request.method !== 'GET' && request.method !== 'HEAD') return text('Method not allowed', 405);

  const auth = authenticate(request, env, url.pathname);
  if (auth instanceof Response) return auth;

  const c = cfg(env);
  // Per-request image switch: ?images=1 / ?images=0 overrides INCLUDE_IMAGES and is
  // carried into every generated link, so one deployment can serve a fast text-only
  // catalog (e.g. .../opds?images=0) and an illustrated one (.../opds?images=1).
  const imagesParam = url.searchParams.get('images');
  if (imagesParam !== null) c.includeImages = /^(1|true|yes|on)$/i.test(imagesParam);
  // Same idea for full-text extraction: ?full=1 / ?full=0 overrides FULLTEXT.
  const fullParam = url.searchParams.get('full');
  if (fullParam !== null) c.fullText = /^(1|true|yes|on)$/i.test(fullParam);
  if (!c.chain.length) c.fullText = false;
  const base = url.origin + auth.prefix;
  const href = (p, params) => {
    const u = new URL(base + p);
    const carried = {};
    if (imagesParam !== null) carried.images = c.includeImages ? '1' : '0';
    if (fullParam !== null) carried.full = c.fullText ? '1' : '0';
    const all = { ...carried, ...(params || {}) };
    for (const [k, v] of Object.entries(all)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    return u.toString();
  };
  const searchBase = href('/opds/search');
  const common = {
    start: href('/opds'),
    search: {
      description: href('/opds/search.xml'),
      template: searchBase + (searchBase.includes('?') ? '&' : '?') + 'q={searchTerms}',
    },
  };
  const cf = new CommaFeed({
    baseUrl: env.COMMAFEED_URL,
    apiKey: env.COMMAFEED_API_KEY,
    username: env.COMMAFEED_USER,
    password: env.COMMAFEED_PASSWORD,
  });

  const path = auth.path.replace(/\/+$/, '') || '/';
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const readAll = url.searchParams.get('read') === 'all';

  // ---- navigation root
  if (path === '/' || path === '/opds' || path === '/opds.xml' || path === '/catalog') {
    const items = [
      { title: 'Unread', href: href('/opds/unread'), summary: 'Unread articles, newest first' },
      { title: 'Starred', href: href('/opds/starred'), summary: 'Starred articles' },
      { title: 'All', href: href('/opds/all'), summary: 'All recent articles' },
      { title: 'Categories', href: href('/opds/categories'), kind: 'nav', summary: 'Browse by category' },
      { title: 'Feeds', href: href('/opds/feeds'), kind: 'nav', summary: 'Browse by subscription' },
      c.includeImages
        ? { title: 'Text only', href: href('/opds', { images: '0' }), kind: 'nav', summary: 'Same catalog, articles without images (faster)' }
        : { title: 'With images', href: href('/opds', { images: '1' }), kind: 'nav', summary: 'Same catalog, article images embedded (slower)' },
    ];
    c.shares.forEach((s, i) => {
      items.push({ title: s.label, href: href('/opds/yandex', { share: i || undefined }), kind: 'nav', summary: 'EPUB files in a shared Yandex Disk folder' });
    });
    if (c.chain.length) {
      items.push(c.fullText
        ? { title: 'Feed text', href: href('/opds', { full: '0' }), kind: 'nav', summary: 'Same catalog, article text as delivered by the feed' }
        : { title: 'Full text', href: href('/opds', { full: '1' }), kind: 'nav', summary: `Same catalog, full articles via ${c.chain.join(', ')}` });
    }
    return xml(navigationFeed({ ...common, id: href('/opds'), title: c.title, self: href('/opds') }, items), 'application/atom+xml;profile=opds-catalog;kind=navigation');
  }

  // ---- Yandex Disk public share
  if (path === '/opds/yandex') {
    if (!c.shares.length) return text('Yandex Disk is not configured (YANDEX_PUBLIC_URL)', 404);
    const shareIdx = Math.max(0, parseInt(url.searchParams.get('share') || '0', 10) || 0);
    const share = c.shares[shareIdx];
    if (!share) return text('Unknown Yandex share', 404);
    const shareParam = shareIdx || undefined; // omitted for the first share: keeps old links valid
    const folder = url.searchParams.get('path') || '/';
    const offset = (page - 1) * c.pageSize;
    const data = await yandex.listFolder(env, share, { path: folder, offset, limit: c.pageSize });
    const q = (extra) => ({ share: shareParam, ...extra });
    const self = href(path, q({ path: folder === '/' ? undefined : folder, page: page > 1 ? page : undefined }));
    const items = [
      ...data.folders.map((f) => ({ kind: 'nav', title: f.name, href: href('/opds/yandex', q({ path: f.path })) })),
      ...data.books.map((b) => ({
        kind: 'book',
        id: `urn:yandex:${shareIdx}:${encodeURIComponent(b.path)}`,
        title: b.name.replace(/\.epub$/i, ''),
        author: share.label,
        date: b.modified,
        summary: b.size ? `${Math.round(b.size / 1024)} KB` : '',
        epubHref: href(`/yd/${shareIdx ? `${shareIdx}/` : ''}${yandex.encodePath(b.path)}/${slugify(b.name.replace(/\.epub$/i, ''))}.epub`),
        length: b.size,
      })),
    ];
    const parent = folder === '/' ? null : folder.replace(/\/[^/]*$/, '') || '/';
    return xml(mixedFeed({
      ...common,
      id: self,
      title: folder === '/' ? share.label : data.name,
      self,
      up: parent === null ? href('/opds') : href('/opds/yandex', q({ path: parent === '/' ? undefined : parent })),
      prev: page > 1 ? href(path, q({ path: folder === '/' ? undefined : folder, page: page > 2 ? page - 1 : undefined })) : null,
      next: data.hasMore ? href(path, q({ path: folder === '/' ? undefined : folder, page: page + 1 })) : null,
    }, items), 'application/atom+xml;profile=opds-catalog;kind=acquisition');
  }
  // /yd/<encoded path>/<name>.epub (first share) or /yd/<share index>/<encoded path>/<name>.epub
  const ym = /^\/yd\/(?:(\d+)\/)?([A-Za-z0-9_-]+)\/[^/]+\.epub$/.exec(path);
  if (ym) {
    if (!c.shares.length) return text('Yandex Disk is not configured (YANDEX_PUBLIC_URL)', 404);
    const share = c.shares[parseInt(ym[1] || '0', 10)];
    if (!share) return text('Unknown Yandex share', 404);
    let filePath;
    try { filePath = yandex.decodePath(ym[2]); } catch { return text('Bad path', 400); }
    let upstream;
    try {
      upstream = await yandex.fetchBook(env, share, filePath);
    } catch (err) {
      if (err && err.status === 404) return text('File not found on Yandex Disk', 404);
      throw err;
    }
    const name = filePath.split('/').pop() || 'book.epub';
    const headers = {
      'content-type': 'application/epub+zip',
      'content-disposition': `attachment; filename="${slugify(name.replace(/\.epub$/i, ''))}.epub"`,
      'cache-control': 'private, max-age=3600',
    };
    const len = upstream.headers.get('content-length');
    if (len) headers['content-length'] = len;
    return new Response(request.method === 'HEAD' ? null : upstream.body, { status: 200, headers });
  }

  // ---- category / feed navigation
  if (path === '/opds/categories' || path === '/opds/feeds') {
    const root = await cf.getRoot();
    const items = [];
    if (path === '/opds/categories') {
      const walk = (cat, depth) => {
        for (const child of cat.children || []) {
          const unread = (child.feeds || []).reduce((n, f) => n + (f.unread || 0), 0);
          items.push({
            title: `${'  '.repeat(depth)}${child.name}`,
            href: href(`/opds/category/${child.id}`),
            summary: `${(child.feeds || []).length} feeds, ${unread} unread`,
          });
          walk(child, depth + 1);
        }
      };
      walk(root, 0);
      if (!items.length) items.push({ title: 'All', href: href('/opds/all') });
    } else {
      const feeds = [];
      const walk = (cat) => { feeds.push(...(cat.feeds || [])); (cat.children || []).forEach(walk); };
      walk(root);
      feeds.sort((a, b) => (b.unread || 0) - (a.unread || 0) || String(a.name).localeCompare(String(b.name)));
      for (const f of feeds) {
        items.push({ title: f.unread ? `${f.name} (${f.unread})` : f.name, href: href(`/opds/feed/${f.id}`), summary: f.feedLink || '' });
      }
    }
    return xml(
      navigationFeed({ ...common, id: href(path), title: path.endsWith('categories') ? 'Categories' : 'Feeds', self: href(path), up: href('/opds') }, items),
      'application/atom+xml;profile=opds-catalog;kind=navigation',
    );
  }

  // ---- acquisition feeds
  let listing = null;
  let m;
  if (path === '/opds/unread') listing = { kind: 'category', id: 'all', readType: 'unread', title: 'Unread' };
  else if (path === '/opds/all') listing = { kind: 'category', id: 'all', readType: 'all', title: 'All' };
  else if (path === '/opds/starred') listing = { kind: 'category', id: 'starred', readType: 'all', title: 'Starred' };
  else if ((m = /^\/opds\/category\/(\d+)$/.exec(path))) listing = { kind: 'category', id: m[1], readType: readAll ? 'all' : 'unread' };
  else if ((m = /^\/opds\/feed\/(\d+)$/.exec(path))) listing = { kind: 'feed', id: m[1], readType: readAll ? 'all' : 'unread' };
  else if (path === '/opds/search') {
    const q = (url.searchParams.get('q') || url.searchParams.get('query') || '').trim();
    if (!q) return xml(acquisitionFeed({ ...common, id: href(path), title: 'Search', self: href(path), up: href('/opds') }, []), 'application/atom+xml;profile=opds-catalog;kind=acquisition');
    listing = { kind: 'category', id: 'all', readType: 'all', keywords: q, title: `Search: ${q}` };
  }

  if (listing) {
    const offset = (page - 1) * c.pageSize;
    const data = await cf.entries({ ...listing, offset, limit: c.pageSize });
    const entries = (data.entries || []).map(normalizeRestEntry);
    const query = { read: readAll ? 'all' : undefined, q: listing.keywords };
    const self = href(path, { ...query, page: page > 1 ? page : undefined });
    const title0 = listing.title || data.name || c.title;
    const books = entries.map((e) => ({
      id: `urn:commafeed:entry:${e.id}`,
      title: e.title,
      author: e.feedName || e.author,
      feedName: e.feedName,
      date: e.date,
      summary: textExcerpt(e.content, 300),
      epubHref: href(`/book/${e.id}/${slugify(e.title)}.epub`),
      url: e.url,
    }));
    let title = title0 + (imagesParam !== null ? (c.includeImages ? ' [img]' : ' [txt]') : '') + (fullParam !== null ? (c.fullText ? ' [full]' : ' [feed]') : '');
    if (page > 1) title += ` (page ${page})`;
    return xml(
      acquisitionFeed({
        ...common,
        id: self,
        title,
        self,
        up: href('/opds'),
        prev: page > 1 ? href(path, { ...query, page: page > 2 ? page - 1 : undefined }) : null,
        next: data.hasMore ? href(path, { ...query, page: page + 1 }) : null,
      }, books),
      'application/atom+xml;profile=opds-catalog;kind=acquisition',
    );
  }

  if (path === '/opds/search.xml') {
    return xml(openSearchDescription({ shortName: c.title, template: common.search.template }), 'application/opensearchdescription+xml');
  }

  // ---- EPUB download
  if ((m = /^\/book\/(\d+)(?:\/[^/]*)?\.epub$/.exec(path)) || (m = /^\/book\/(\d+)\/[^/]+\.epub$/.exec(path))) {
    const id = m[1];
    return serveEpub({ id, cf, c, env, ctx, request });
  }

  return text('Not found', 404);
}

async function serveEpub({ id, cf, c, env, ctx, request }) {
  const cache = caches.default;
  const fullKey = c.fullText ? c.chain.join('-') : '0';
  const cacheKey = new Request(`https://cache.commafeed-opds.invalid/book/${id}?images=${c.includeImages ? c.maxImages : 0}&full=${fullKey}&lang=${encodeURIComponent(c.lang)}`);
  let res = await cache.match(cacheKey);

  if (!res) {
    let entry = null;
    try {
      entry = await cf.getEntry(id);
    } catch (err) {
      if (!(err instanceof CommaFeedError) || err.status === 401 || err.status === 403) throw err;
    }
    if (!entry) entry = await cf.findEntryByScan(id);
    if (!entry) return text('Article not found in CommaFeed', 404);

    let html = entry.content;
    let source = 'feed';
    if (c.fullText && entry.url) {
      const full = await extractFullText(env, c.chain, { url: entry.url, title: entry.title }, { cache, waitUntil: (p) => ctx.waitUntil(p) });
      if (full) { html = full.html; source = full.source; }
    }

    const images = [];
    if (c.includeImages && c.maxImages > 0) {
      const urls = collectImageUrls(html, entry.url, c.maxImages);
      const results = await Promise.all(urls.map((u) => fetchImage(u)));
      for (const r of results) if (r) images.push(r);
    }
    const bytes = buildEpub({
      id: entry.id,
      title: entry.title,
      author: entry.author,
      feedName: entry.feedName,
      url: entry.url,
      date: entry.date,
      html,
      lang: c.lang,
      images,
    });
    const filename = `${slugify(entry.feedName || 'feed', 30)}-${slugify(entry.title, 60)}.epub`;
    res = new Response(bytes, {
      status: 200,
      headers: {
        'content-type': 'application/epub+zip',
        'content-length': String(bytes.length),
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'private, max-age=21600',
        'x-commafeed-entry': id,
        'x-content-source': source,
      },
    });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
  }

  if (c.markRead && request.method === 'GET') {
    ctx.waitUntil(cf.markRead(id).catch((e) => console.error('markRead failed', e && e.message)));
  }
  return res;
}

async function fetchImage(url) {
  try {
    const res = await fetch(url, { headers: { accept: 'image/jpeg,image/png,image/gif,image/webp,*/*;q=0.5' }, cf: { cacheTtl: 86400 } });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^image\/(jpeg|png|gif|webp)$/.test(type)) return null;
    const len = parseInt(res.headers.get('content-length') || '0', 10);
    if (len > MAX_IMAGE_BYTES) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES || buf.length === 0) return null;
    return { url, type, data: buf };
  } catch {
    return null;
  }
}
