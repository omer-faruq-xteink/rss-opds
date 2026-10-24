// Offline test of article images for the JSON API: markers in the text, the resizer path, the
// fallback to a small original JPEG, rejection of everything else, the /api/img proxy and its cache.
// Run: node test/images.mjs
import { handleApi } from '../src/api.js';
import { b64url, collectImages, jpegSize, resizerUrl, unb64url } from '../src/images.js';

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) failures++;
};

// a minimal JPEG: SOI, APP0, SOF0 with the given size, padding, EOI
function jpeg(w, h, pad = 100) {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof = [0xff, 0xc0, 0x00, 0x11, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, ...new Array(pad).fill(0), 0xff, 0xd9]);
}
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

check('jpegSize', JSON.stringify(jpegSize(jpeg(456, 300))) === '{"w":456,"h":300}' && jpegSize(PNG) === null);
check('b64url round trip', unb64url(b64url('https://ä.example/x y.jpg?a=1&b=2')) === 'https://ä.example/x y.jpg?a=1&b=2');
check('resizer url', resizerUrl('https://a.example/p.jpg').startsWith('https://images.weserv.nl/?url=https%3A%2F%2Fa.example%2Fp.jpg&w=456&h=640&fit=inside&we=&output=jpg'));

// ---- fake network and cache
const fetched = [];
const store = new Map();
globalThis.caches = { default: {
  match: async (req) => store.get(req.url),
  put: async (req, res) => { store.set(req.url, new Response(await res.arrayBuffer(), { headers: res.headers })); },
} };
const reply = (bytes, type) => new Response(bytes, { status: 200, headers: { 'content-type': type, 'content-length': String(bytes.length) } });
globalThis.fetch = async (input) => {
  const u = new URL(input instanceof Request ? input.url : String(input));
  fetched.push(u.toString());
  if (u.host === 'images.weserv.nl') {
    const src = u.searchParams.get('url');
    if (src.endsWith('/ok.jpg') || src.endsWith('/rel.jpg')) return reply(jpeg(456, 300), 'image/jpeg');
    if (src.endsWith('/tall.jpg')) return reply(jpeg(456, 2000), 'image/jpeg');   // a resizer ignoring h: rejected
    return new Response('rate limited', { status: 429 });
  }
  if (u.pathname === '/down.jpg') return reply(jpeg(300, 200), 'image/jpeg');     // small original: fallback ok
  if (u.pathname === '/chart.png') return reply(PNG, 'image/png');                 // not a JPEG: rejected
  if (u.pathname === '/big.jpg') return reply(jpeg(1600, 1200, 200000), 'image/jpeg'); // too big: rejected
  return new Response('nope', { status: 404 });
};

const html = `<p>Intro</p><img src="https://a.example/ok.jpg" alt="Photo">
<p>Middle</p><img src='/rel.jpg'><img src="https://t.example/pixel.gif" width="1" height="1">
<img src="data:image/png;base64,AAAA"><figure><img src="https://a.example/down.jpg"></figure>
<img src="https://a.example/chart.png" alt="Chart"><img src="https://a.example/big.jpg"><p>End</p>`;
const imgs = collectImages(html, 'https://a.example/post/1');
check('collectImages skips trackers and data:', imgs.length === 5 && imgs[1].src === 'https://a.example/rel.jpg', JSON.stringify(imgs.map((i) => i.src)));

const cf = { getEntry: async () => ({ id: '1', title: 'T', content: html, url: 'https://a.example/post/1', feedName: 'F', date: new Date(0) }), findEntryByScan: async () => null, markRead: async () => {} };
const c = { title: 'X', pageSize: 30, fullText: false, chain: [], markRead: false };
const ctx = { waitUntil: (p) => p.catch(() => {}) };
const call = async (p, qs = '') => handleApi({ path: p, url: new URL('https://w.example' + p + qs), cf, c, env: {}, ctx, request: new Request('https://w.example' + p) });

let r = await (await call('/api/article/1')).json();
check('no images unless asked', !('images' in r) && !r.text.includes('[[img') && !r.text.includes('[image'), r.text);

r = await (await call('/api/article/1', '?images=1')).json();
check('markers for usable images', r.text.includes('[[img:1]]') && r.text.includes('[[img:2]]') && r.text.includes('[[img:3]]'), r.text);
check('rejected images become text', r.text.includes('[image: Chart]') && r.text.includes('[image]') && !r.text.includes('[[img:4]]') && !r.text.includes('[[img:5]]'), r.text);
check('marker order follows the article', r.text.indexOf('Intro') < r.text.indexOf('[[img:1]]') && r.text.indexOf('[[img:1]]') < r.text.indexOf('Middle') && r.text.indexOf('[[img:3]]') < r.text.indexOf('End'));
check('images list with sizes', JSON.stringify(r.images.map((i) => [i.n, i.w, i.h])) === '[[1,456,300],[2,456,300],[3,300,200]]', JSON.stringify(r.images));

const before = fetched.length;
const img = await call('/api/img', '?u=' + r.images[0].u);
const bytes = new Uint8Array(await img.arrayBuffer());
check('/api/img serves the JPEG from the cache', img.status === 200 && img.headers.get('content-type') === 'image/jpeg' && jpegSize(bytes).w === 456 && fetched.length === before, `${img.status} ${fetched.length - before}`);
check('/api/img fallback image', jpegSize(new Uint8Array(await (await call('/api/img', '?u=' + r.images[2].u)).arrayBuffer())).w === 300);
check('/api/img rejects a bad id', (await call('/api/img', '?u=%%%')).status === 400);
check('/api/img 404 when there is no usable image', (await call('/api/img', '?u=' + b64url('https://a.example/chart.png'))).status === 404);
check('/api/img rejects a too tall result', (await call('/api/img', '?u=' + b64url('https://a.example/tall.jpg'))).status === 404);

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
