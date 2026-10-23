// Yandex Disk source: EPUB files in one or more *publicly shared* folders.
// The public-resources API needs no OAuth token, so sharing a folder link is
// the whole setup. Docs: https://yandex.com/dev/disk-api/doc/en/reference/public
//
// Config: YANDEX_PUBLIC_URL = one share link, or a comma-separated list, each
// optionally labelled:  Books|https://disk.yandex.ru/d/AAA, Magazines|https://disk.yandex.ru/d/BBB
// Optional YANDEX_API_BASE for tests.

const DEFAULT_API = 'https://cloud-api.yandex.net/v1/disk';
const BOOK_EXT = /\.(epub)$/i;

/** @returns {{label:string, url:string}[]} */
export function shares(env) {
  const raw = String(env.YANDEX_PUBLIC_URL || '').trim();
  if (!raw) return [];
  return raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean).map((item, i) => {
    const bar = item.indexOf('|');
    const label = bar === -1 ? '' : item.slice(0, bar).trim();
    const url = (bar === -1 ? item : item.slice(bar + 1)).trim();
    return { label: label || (i === 0 ? 'Yandex Disk' : `Yandex Disk ${i + 1}`), url };
  }).filter((s) => /^https?:\/\//i.test(s.url));
}

export function yandexConfigured(env) {
  return shares(env).length > 0;
}

function api(env, path, params) {
  const u = new URL((env.YANDEX_API_BASE || DEFAULT_API).replace(/\/+$/, '') + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  return u;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json()).message || ''; } catch { /* ignore */ }
    const err = new Error(`Yandex Disk HTTP ${res.status}${msg ? `: ${msg}` : ''}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * List one folder of a public share.
 * @returns {Promise<{name:string, folders:{name:string,path:string}[], books:{name:string,path:string,size:number,modified:Date}[], total:number, hasMore:boolean}>}
 */
export async function listFolder(env, share, { path = '/', offset = 0, limit = 30 } = {}) {
  const data = await getJson(api(env, '/public/resources', {
    public_key: share.url,
    path: path === '/' ? undefined : path,
    limit,
    offset,
    sort: 'name',
    fields: 'name,type,path,_embedded.items.name,_embedded.items.type,_embedded.items.path,_embedded.items.size,_embedded.items.modified,_embedded.total,_embedded.limit,_embedded.offset',
  }));
  const items = (data._embedded && data._embedded.items) || [];
  const folders = [];
  const books = [];
  for (const it of items) {
    if (it.type === 'dir') folders.push({ name: it.name, path: it.path });
    else if (it.type === 'file' && BOOK_EXT.test(it.name)) {
      books.push({ name: it.name, path: it.path, size: it.size || 0, modified: it.modified ? new Date(it.modified) : null });
    }
  }
  const total = (data._embedded && data._embedded.total) || items.length;
  return { name: data.name || share.label, folders, books, total, hasMore: offset + items.length < total };
}

/** Resolve the temporary download link of a file inside a share. */
export async function downloadLink(env, share, path) {
  const data = await getJson(api(env, '/public/resources/download', { public_key: share.url, path }));
  if (!data.href) throw new Error('Yandex Disk returned no download link');
  return data.href;
}

/** Fetch the file and stream it through unchanged (no CPU spent on the body). */
export async function fetchBook(env, share, path) {
  const href = await downloadLink(env, share, path);
  const res = await fetch(href, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Yandex Disk download HTTP ${res.status}`);
  return res;
}

// Yandex paths inside a public share look like "disk:/Books/x.epub" or "/Books/x.epub".
// They are carried in download URLs as base64url so slashes and Unicode survive.
export function encodePath(p) {
  return btoa(unescape(encodeURIComponent(p))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decodePath(s) {
  const b = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return decodeURIComponent(escape(atob(b)));
}
