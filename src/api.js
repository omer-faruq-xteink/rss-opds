// JSON API for small clients that cannot read OPDS or EPUB, such as the Xteink X4 Pro
// "Mini Apps" (Lua, API 2.9: HTTPS + JSON, ~1 MB of heap). Same auth and switches as
// the catalog; every response is a compact JSON object, articles come as plain text.
//
//   /api/list?kind=unread|all|starred|category|feed&id=<id>&page=N&n=M   article list
//   /api/categories                                                      categories with unread counts
//   /api/feeds                                                           subscriptions with unread counts
//   /api/article/<id>?max=<chars>&mark=1&images=1                        one article as text (images: see below)
//   /api/mark/<id>?read=0|1                                              mark read / unread
//   /api                                                                 title, accounts [{id, label}], switches
// Every call takes ?acct=<id> to use another CommaFeed account (default: the first).
// Lists, categories and feeds also carry "accounts", so a client stays current without asking /api.
import { CommaFeedError, normalizeRestEntry } from './commafeed.js';
import { decodeEntities } from './html.js';
import { extractFullText } from './sanitizers.js';
import { collectImages, deviceImage, sniffSize } from './images.js';

const LIST_DEFAULT = 20;
const LIST_MAX = 40;
const EXCERPT_CHARS = 400;   // enough for a preview on the device; 12 items stay a few KB
const TEXT_DEFAULT = 20000;
const TEXT_MAX = 60000;
const TINY_IMAGE = 80;          // px; images no larger than this in both directions are left out

/**
 * HTML -> plain text with light markers a small renderer can style: paragraphs are separated
 * by a blank line, headings start with "# ", block quotes with "> ", list items with "• ".
 */
export function htmlToText(html, max = TEXT_DEFAULT) {
  let t = String(html || '')
    .replace(/<(script|style|svg|iframe|noscript|template)[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<h[1-6]\b[^>]*>/gi, '\n\n# ')
    .replace(/<blockquote\b[^>]*>/gi, '\n\n> ')
    .replace(/<hr\b[^>]*>/gi, '\n\n* * *\n\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr|figure|figcaption|dd|dt|section|article|header|footer|table)\s*>/gi, '\n\n')
    .replace(/<(li)\b[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, '');
  t = decodeEntities(t)
    .replace(/ /g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (t.length > max) {
    const cut = t.slice(0, max);
    const sp = cut.lastIndexOf(' ');
    t = (sp > max * 0.8 ? cut.slice(0, sp) : cut) + '…';
  }
  return t;
}

function excerpt(html, max = EXCERPT_CHARS) {
  const t = htmlToText(html, 4000).replace(/(^|\n)[#>•] /g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut) + '…';
}

/** "2026-10-24 08:15" in UTC; small clients render it as-is. */
function stamp(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

export function listItem(e) {
  return {
    id: e.id,
    title: e.title || '(untitled)',
    feed: e.feedName || e.author || '',
    date: stamp(e.date),
    read: !!e.read,
    starred: !!e.starred,
    excerpt: excerpt(e.content),
  };
}

// the accounts of this Worker as the API shows them
function accountList(accounts) {
  return (accounts || []).map((a) => ({ id: String(a.n), label: a.label }));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function clampInt(v, def, lo, hi) {
  const n = parseInt(v || '', 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Serve one /api request. Returns null when the path is not an API path.
 * @param {{path:string, url:URL, cf:object, c:object, env:object, ctx:object, request:Request}} a
 */
export async function handleApi({ path, url, cf, c, env, ctx, request, accounts, acct }) {
  if (path !== '/api' && !path.startsWith('/api/')) return null;
  let m;

  if (path === '/api' || path === '/api/') {
    return json({
      title: c.title,
      // CommaFeed accounts of this Worker; pass ?acct=<id> on every call (default: the first)
      accounts: accountList(accounts),
      account: acct ? String(acct.n) : '1',
      full_text: c.fullText,
      kinds: ['unread', 'starred', 'all', 'category', 'feed'],
      page_size: Math.min(c.pageSize, LIST_DEFAULT),
    });
  }

  if (path === '/api/list') {
    const kind = (url.searchParams.get('kind') || 'unread').toLowerCase();
    const id = url.searchParams.get('id') || '';
    const page = clampInt(url.searchParams.get('page'), 1, 1, 10000);
    const n = clampInt(url.searchParams.get('n'), Math.min(c.pageSize, LIST_DEFAULT), 1, LIST_MAX);
    const readAll = url.searchParams.get('read') === 'all';
    const keywords = (url.searchParams.get('q') || '').trim() || undefined;
    let listing;
    if (kind === 'unread') listing = { kind: 'category', id: 'all', readType: 'unread', title: 'Unread' };
    else if (kind === 'all') listing = { kind: 'category', id: 'all', readType: 'all', title: 'All' };
    else if (kind === 'starred') listing = { kind: 'category', id: 'starred', readType: 'all', title: 'Starred' };
    else if (kind === 'category' && /^\d+$/.test(id)) listing = { kind: 'category', id, readType: readAll ? 'all' : 'unread' };
    else if (kind === 'feed' && /^\d+$/.test(id)) listing = { kind: 'feed', id, readType: readAll ? 'all' : 'unread' };
    else if (kind === 'search') listing = { kind: 'category', id: 'all', readType: 'all', title: `Search: ${keywords || ''}` };
    else return json({ error: 'bad kind or id' }, 400);
    if (keywords) listing.keywords = keywords;
    const data = await cf.entries({ ...listing, offset: (page - 1) * n, limit: n });
    const entries = (data.entries || []).map(normalizeRestEntry);
    return json({
      title: listing.title || data.name || c.title,
      page,
      has_more: !!data.hasMore,
      items: entries.map(listItem),
      accounts: accountList(accounts),
    });
  }

  if (path === '/api/categories' || path === '/api/feeds') {
    const root = await cf.getRoot();
    const items = [];
    if (path === '/api/categories') {
      const walk = (cat, depth) => {
        for (const child of cat.children || []) {
          const feeds = child.feeds || [];
          items.push({
            id: String(child.id),
            name: child.name,
            depth,
            feeds: feeds.length,
            unread: feeds.reduce((s, f) => s + (f.unread || 0), 0),
          });
          walk(child, depth + 1);
        }
      };
      walk(root, 0);
    } else {
      const feeds = [];
      const walk = (cat) => { feeds.push(...(cat.feeds || [])); (cat.children || []).forEach(walk); };
      walk(root);
      feeds.sort((a, b) => (b.unread || 0) - (a.unread || 0) || String(a.name).localeCompare(String(b.name)));
      for (const f of feeds) items.push({ id: String(f.id), name: f.name, unread: f.unread || 0 });
    }
    return json({ items, accounts: accountList(accounts) });
  }

  if ((m = /^\/api\/article\/(\d+)$/.exec(path))) {
    const id = m[1];
    const max = clampInt(url.searchParams.get('max'), TEXT_DEFAULT, 500, TEXT_MAX);
    let entry = null;
    try {
      entry = await cf.getEntry(id);
    } catch (err) {
      if (!(err instanceof CommaFeedError) || err.status === 401 || err.status === 403) throw err;
    }
    if (!entry) entry = await cf.findEntryByScan(id);
    if (!entry) return json({ error: 'not found' }, 404);
    let html = entry.content;
    let source = 'feed';
    if (c.fullText && entry.url) {
      const full = await extractFullText(env, c.chain, { url: entry.url, title: entry.title }, { cache: caches.default, waitUntil: (p) => ctx.waitUntil(p) });
      if (full) { html = full.html; source = full.source; }
    }
    const wantMark = url.searchParams.get('mark') === '1' || (c.markRead && url.searchParams.get('mark') !== '0');
    if (wantMark && request.method === 'GET') {
      ctx.waitUntil(cf.markRead(id).catch((e) => console.error('markRead failed', e && e.message)));
    }
    // ?images=1: each image becomes a "[[img:N]]" paragraph in the text, described in images[]
    // ({n, w, h, src}): src is a resizer URL the device fetches itself (the resizer refuses
    // Workers), which returns a greyscale JPEG of exactly w x h (see images.js).
    let text;
    let images;
    if (url.searchParams.get('images') === '1') {
      const found = collectImages(html, entry.url);
      let marked = '';
      let last = 0;
      for (const im of found) { marked += html.slice(last, im.start) + `<p>[[img:${im.n}]]</p>`; last = im.end; }
      marked += html.slice(last);
      text = htmlToText(marked, max).replace(/\[\[img:\d*\]?$/, '');
      const present = found.filter((im) => text.includes(`[[img:${im.n}]]`));
      const sizes = await Promise.all(present.map((im) => sniffSize(im.src, { cache: caches.default, waitUntil: (p) => ctx.waitUntil(p) })));
      images = [];
      present.forEach((im, i) => {
        const size = sizes[i];
        // icons and emoji (WordPress serves them as 72x72 images) are left out
        if (size && size.w <= TINY_IMAGE && size.h <= TINY_IMAGE) {
          text = text.replace(`[[img:${im.n}]]`, '').replace(/\n{3,}/g, '\n\n');
          return;
        }
        const d = deviceImage(im.src, size);
        images.push({ n: im.n, w: d.w, h: d.h, src: d.url, ...(im.alt ? { alt: im.alt } : {}) });
      });
    } else {
      text = htmlToText(html, max);
    }
    return json({
      id: String(id),
      title: entry.title || '(untitled)',
      feed: entry.feedName || '',
      author: entry.author || '',
      date: stamp(entry.date),
      url: entry.url || '',
      source,
      text,
      ...(images ? { images } : {}),
    });
  }

  if ((m = /^\/api\/mark\/(\d+)$/.exec(path))) {
    const read = url.searchParams.get('read') !== '0';
    await cf.markRead(m[1], read);
    return json({ ok: true, id: m[1], read });
  }

  return json({ error: 'not found' }, 404);
}
