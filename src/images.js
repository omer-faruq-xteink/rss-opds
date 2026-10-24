// Article images for small clients (the Xteink RSS mini app). The device can decode JPEG but not
// PNG (decoding a PNG runs it out of memory), and it has a 456-pixel-wide text column, so every
// image is turned into a greyscale JPEG at most 456 px wide by the free images.weserv.nl resizer.
// If the resizer fails (down, rate limited, slow), the original is used only when it already is
// a small JPEG that fits; anything else is skipped and the article shows "[image]" instead.
// Results are kept in the Cloudflare cache, so a device fetch right after the article is a hit.

export const MAX_W = 456;
export const MAX_H = 640;
const MAX_IMAGES = 8;
const MAX_BYTES = 120 * 1024;          // what the device is given
const MAX_ORIGINAL_BYTES = 80 * 1024;  // fallback: an original this small, already a JPEG
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL = 7 * 86400;
const RESIZER = 'https://images.weserv.nl/';

/** Width and height from a JPEG's SOF segment, or null when the bytes are not a usable JPEG. */
export function jpegSize(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const h = (b[i + 5] << 8) | b[i + 6];
      const w = (b[i + 7] << 8) | b[i + 8];
      return w > 0 && h > 0 ? { w, h } : null;
    }
    i += 2 + len;
  }
  return null;
}

export function resizerUrl(src) {
  const u = new URL(RESIZER);
  u.searchParams.set('url', src);
  u.searchParams.set('w', String(MAX_W));
  u.searchParams.set('h', String(MAX_H));
  u.searchParams.set('fit', 'inside');
  u.searchParams.set('we', '');           // never enlarge small images
  u.searchParams.set('output', 'jpg');
  u.searchParams.set('q', '70');
  u.searchParams.set('filt', 'greyscale');
  return u.toString();
}

// base64url of a UTF-8 string, and back (image ids in /api/img URLs)
export function b64url(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const x of bytes) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64url(s) {
  const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

async function fetchWithTimeout(url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function tryJpeg(url, maxBytes, maxW, maxH) {
  try {
    const res = await fetchWithTimeout(url, { headers: { accept: 'image/jpeg,image/*;q=0.5' }, cf: { cacheTtl: 86400 } });
    if (!res.ok) return null;
    const len = parseInt(res.headers.get('content-length') || '0', 10);
    if (len > maxBytes) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length || bytes.length > maxBytes) return null;
    const size = jpegSize(bytes);
    if (!size || size.w > maxW || size.h > maxH) return null;
    return { bytes, ...size };
  } catch {
    return null;
  }
}

/**
 * The device-ready JPEG for an image URL: { bytes, w, h }, or null when there is none.
 * @param {string} src absolute image URL
 * @param {{cache?: Cache, waitUntil?: (p: Promise<any>) => void}} opts
 */
export async function deviceImage(src, { cache, waitUntil } = {}) {
  const key = cache ? new Request('https://cache.commafeed-opds.invalid/img?u=' + encodeURIComponent(src)) : null;
  if (key) {
    const hit = await cache.match(key);
    if (hit) {
      const bytes = new Uint8Array(await hit.arrayBuffer());
      const size = jpegSize(bytes);
      if (size) return { bytes, ...size };
    }
  }
  let img = await tryJpeg(resizerUrl(src), MAX_BYTES, MAX_W, MAX_H);
  if (!img) img = await tryJpeg(src, MAX_ORIGINAL_BYTES, MAX_W, MAX_H);
  if (img && key) {
    const stored = new Response(img.bytes, { headers: { 'content-type': 'image/jpeg', 'cache-control': `max-age=${CACHE_TTL}` } });
    const p = cache.put(key, stored);
    if (waitUntil) waitUntil(p); else await p;
  }
  return img;
}

/**
 * Images of an article in reading order: [{ n, src, alt }], at most MAX_IMAGES. Relative URLs are
 * resolved against the article URL; data: URLs, SVG and 1-pixel trackers are left out.
 */
export function collectImages(html, baseUrl) {
  const out = [];
  const re = /<img\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(String(html || ''))) && out.length < MAX_IMAGES) {
    const attrs = m[1];
    const attr = (name) => {
      const a = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
      return a ? (a[2] ?? a[3] ?? a[4] ?? '') : '';
    };
    let src = attr('src') || attr('data-src');
    if (!src || /^data:/i.test(src)) continue;
    if (/\.svg(\?|$)/i.test(src)) continue;
    if (attr('width') === '1' || attr('height') === '1') continue;
    if (src.startsWith('//')) src = 'https:' + src;
    try { src = new URL(src, baseUrl || undefined).toString(); } catch { continue; }
    if (!/^https?:/i.test(src)) continue;
    out.push({ n: out.length + 1, src, alt: attr('alt').replace(/\s+/g, ' ').trim(), start: m.index, end: m.index + m[0].length });
  }
  return out;
}
