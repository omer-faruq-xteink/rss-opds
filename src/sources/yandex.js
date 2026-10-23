// Yandex Disk source: EPUB files in a *publicly shared* folder.
// The public-resources API needs no OAuth token, so sharing a folder link is
// the whole setup. Docs: https://yandex.com/dev/disk-api/doc/en/reference/public
//
// Config: YANDEX_PUBLIC_URL = the share link (https://disk.yandex.ru/d/XXXX or
// https://disk.yandex.com/d/XXXX). Optional YANDEX_API_BASE for tests.

const DEFAULT_API = 'https://cloud-api.yandex.net/v1/disk';
const BOOK_EXT = /\.(epub)$/i;

export function yandexConfigured(env) {
  return !!(env.YANDEX_PUBLIC_URL && String(env.YANDEX_PUBLIC_URL).trim());
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
 * List one folder of the public share.
 * @returns {Promise<{name:string, folders:{name:string,path:string}[], books:{name:string,path:string,size:number,modified:Date}[], total:number, hasMore:boolean}>}
 */
export async function listFolder(env, { path = '/', offset = 0, limit = 30 } = {}) {
  const data = await getJson(api(env, '/public/resources', {
    public_key: env.YANDEX_PUBLIC_URL.trim(),
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
  return { name: data.name || 'Yandex Disk', folders, books, total, hasMore: offset + items.length < total };
}

/** Resolve the temporary download link of a file inside the share. */
export async function downloadLink(env, path) {
  const data = await getJson(api(env, '/public/resources/download', { public_key: env.YANDEX_PUBLIC_URL.trim(), path }));
  if (!data.href) throw new Error('Yandex Disk returned no download link');
  return data.href;
}

/** Fetch the file and stream it through unchanged (no CPU spent on the body). */
export async function fetchBook(env, path) {
  const href = await downloadLink(env, path);
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
