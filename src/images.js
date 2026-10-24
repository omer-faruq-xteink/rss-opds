// Article images for small clients (the Xteink RSS mini app). The device decodes JPEG but not PNG
// (a PNG runs it out of memory) and has a 456-pixel-wide text column, so it fetches every image
// from the free images.weserv.nl resizer as a greyscale JPEG at most 456 px wide.
//
// The device fetches the resizer itself: the resizer refuses requests coming from Cloudflare
// Workers (HTTP 403, error 1106). The Worker only reads the first bytes of each original to learn
// its size, so the device knows the JPEG's size before it arrives and can lay the page out. When
// the size cannot be read (the host refuses Workers too, or an unknown format), the resizer is
// asked to fit the image into a fixed 456x342 box on white, which has a known size as well.
// If the resizer fails on the device, the app shows "[image]" there; the text never waits.

export const MAX_W = 456;
export const MAX_H = 640;
export const BOX_W = 456;
export const BOX_H = 342;
const MAX_IMAGES = 8;
const SNIFF_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 6000;
const CACHE_TTL = 7 * 86400;
const RESIZER = 'https://images.weserv.nl/';
// image hosts refuse requests without a descriptive User-Agent (Wikimedia rejects generic ones)
const USER_AGENT = 'rss-opds/1.0 (+https://github.com/omer-faruq-xteink/rss-opds)';

/** Width and height from the first bytes of a JPEG, PNG, GIF or WebP file, or null. */
export function imageSize(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const u32 = (i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const ok = (w, h) => (w > 0 && h > 0 ? { w, h } : null);
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return ok(u32(16), u32(20));                                      // PNG IHDR
  }
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return ok(b[6] | (b[7] << 8), b[8] | (b[9] << 8));                // GIF
  }
  if (b.length >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) {
    const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);    // WebP
    if (kind === 'VP8 ') return ok((b[26] | (b[27] << 8)) & 0x3fff, (b[28] | (b[29] << 8)) & 0x3fff);
    if (kind === 'VP8L') {
      const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return ok((v & 0x3fff) + 1, ((v >> 14) & 0x3fff) + 1);
    }
    if (kind === 'VP8X') return ok(1 + (b[24] | (b[25] << 8) | (b[26] << 16)), 1 + (b[27] | (b[28] << 8) | (b[29] << 16)));
    return null;
  }
  return jpegSize(b);
}

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

/** The size the resizer will produce for an original of this size (fit inside, never enlarge). */
export function fittedSize(size) {
  const scale = Math.min(MAX_W / size.w, MAX_H / size.h, 1);
  return { w: Math.max(1, Math.round(size.w * scale)), h: Math.max(1, Math.round(size.h * scale)) };
}

/**
 * The resizer URL the device fetches, and the JPEG size it will get: fitted to the original's
 * size when that is known, else the whole image contained in a fixed BOX_W x BOX_H on white.
 */
export function deviceImage(src, size) {
  const u = new URL(RESIZER);
  u.searchParams.set('url', src);
  let out;
  if (size) {
    out = fittedSize(size);
    u.searchParams.set('w', String(out.w));
    u.searchParams.set('h', String(out.h));
    u.searchParams.set('fit', 'fill');               // the computed size exactly
  } else {
    out = { w: BOX_W, h: BOX_H };
    u.searchParams.set('w', String(BOX_W));
    u.searchParams.set('h', String(BOX_H));
    u.searchParams.set('fit', 'contain');
    u.searchParams.set('cbg', 'white');
  }
  u.searchParams.set('output', 'jpg');
  u.searchParams.set('q', '70');
  u.searchParams.set('filt', 'greyscale');
  return { url: u.toString(), w: out.w, h: out.h };
}

/** The original's size from its first bytes (cached), or null when it cannot be read. */
export async function sniffSize(src, { cache, waitUntil } = {}) {
  const key = cache ? new Request('https://cache.commafeed-opds.invalid/imgsize?u=' + encodeURIComponent(src)) : null;
  if (key) {
    const hit = await cache.match(key);
    if (hit) { try { const v = await hit.json(); return v && v.w ? v : null; } catch { /* refetch */ } }
  }
  let size = null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(src, { headers: { range: `bytes=0-${SNIFF_BYTES - 1}`, 'user-agent': USER_AGENT, accept: 'image/*' }, signal: ctrl.signal });
    if (res.ok && res.body) {
      const reader = res.body.getReader();
      const parts = [];
      let got = 0;
      while (got < SNIFF_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        const all = new Uint8Array(got);
        let o = 0;
        for (const p of parts) { all.set(p, o); o += p.length; }
        size = imageSize(all);
        if (size) break;
      }
      try { await reader.cancel(); } catch { /* done */ }
    } else {
      console.log(`image size unknown (HTTP ${res.status}): ${src.slice(0, 160)}`);
    }
  } catch (err) {
    console.log(`image size unknown (${err && err.name === 'AbortError' ? 'timeout' : err && err.message}): ${src.slice(0, 160)}`);
  } finally {
    clearTimeout(timer);
  }
  if (key) {
    const stored = new Response(JSON.stringify(size || {}), { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${size ? CACHE_TTL : 3600}` } });
    const p = cache.put(key, stored);
    if (waitUntil) waitUntil(p); else await p;
  }
  return size;
}

/**
 * Images of an article in reading order: [{ n, src, alt, start, end }], at most MAX_IMAGES.
 * Relative URLs are resolved against the article URL; data: URLs, SVG and 1-pixel trackers are
 * left out. start / end locate the <img> tag in the HTML.
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
