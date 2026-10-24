// Offline test of article images for the JSON API: size sniffing of JPEG / PNG / GIF / WebP, the
// resizer URLs the device fetches (fitted when the size is known, a fixed box otherwise), markers
// in the text, left-out icons, and the cache of sniffed sizes.
// Run: node test/images.mjs
import { handleApi } from '../src/api.js';
import { collectImages, deviceImage, fittedSize, imageSize, jpegSize } from '../src/images.js';

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) failures++;
};

function jpeg(w, h) {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof = [0xff, 0xc2, 0x00, 0x11, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, ...new Array(100).fill(0), 0xff, 0xd9]);
}
function png(w, h) {
  const b = new Uint8Array(40);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w); new DataView(b.buffer).setUint32(20, h);
  return b;
}
const gif = (w, h) => new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, w & 255, w >> 8, h & 255, h >> 8, 0, 0]);
function webpVp8x(w, h) {
  const b = new Uint8Array(30);
  b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58]);
  const W = w - 1, H = h - 1;
  b.set([W & 255, (W >> 8) & 255, W >> 16, H & 255, (H >> 8) & 255, H >> 16], 24);
  return b;
}

check('jpeg size', JSON.stringify(jpegSize(jpeg(1200, 800))) === '{"w":1200,"h":800}');
check('png size', JSON.stringify(imageSize(png(800, 600))) === '{"w":800,"h":600}');
check('gif size', JSON.stringify(imageSize(gif(320, 200))) === '{"w":320,"h":200}');
check('webp size', JSON.stringify(imageSize(webpVp8x(1000, 500))) === '{"w":1000,"h":500}');
check('fit wide', JSON.stringify(fittedSize({ w: 1200, h: 800 })) === '{"w":456,"h":304}');
check('fit tall', JSON.stringify(fittedSize({ w: 600, h: 2000 })) === '{"w":192,"h":640}');
check('no enlarging', JSON.stringify(fittedSize({ w: 300, h: 169 })) === '{"w":300,"h":169}');
const d1 = deviceImage('https://a.example/p.png', { w: 1200, h: 800 });
check('resizer url, known size', d1.w === 456 && d1.h === 304 && d1.url.startsWith('https://images.weserv.nl/?url=https%3A%2F%2Fa.example%2Fp.png&w=456&h=304&fit=fill&output=jpg'), d1.url);
const d2 = deviceImage('https://a.example/p.png', null);
check('resizer url, unknown size = box', d2.w === 456 && d2.h === 342 && d2.url.includes('fit=contain') && d2.url.includes('cbg=white'), d2.url);

// ---- fake origins: the Worker only reads the first bytes of each image
const fetched = [];
const store = new Map();
globalThis.caches = { default: {
  match: async (req) => store.get(req.url),
  put: async (req, res) => { store.set(req.url, new Response(await res.arrayBuffer(), { headers: res.headers })); },
} };
const reply = (bytes) => new Response(bytes, { status: 206, headers: { 'content-type': 'application/octet-stream' } });
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(input instanceof Request ? input.url : String(input));
  fetched.push({ url: u.toString(), range: init.headers && init.headers.range, ua: init.headers && init.headers['user-agent'] });
  if (u.pathname === '/photo.jpg') return reply(jpeg(1200, 800));
  if (u.pathname === '/rel.png') return reply(png(800, 600));
  if (u.pathname === '/emoji.png') return reply(png(72, 72));
  if (u.pathname === '/blocked.jpg') return new Response('denied', { status: 403 });
  return new Response('nope', { status: 404 });
};

const html = `<p>Intro</p><img src="https://a.example/photo.jpg" alt="Photo">
<p>Middle <img src="https://s.example/emoji.png" alt="🙂"> text</p><img src='/rel.png'>
<img src="https://t.example/pixel.gif" width="1" height="1"><img src="data:image/png;base64,AAAA">
<figure><img src="https://a.example/blocked.jpg"></figure><p>End</p>`;
check('collectImages skips trackers and data:', collectImages(html, 'https://a.example/post/1').length === 4);

const cf = { getEntry: async () => ({ id: '1', title: 'T', content: html, url: 'https://a.example/post/1', feedName: 'F', date: new Date(0) }), findEntryByScan: async () => null, markRead: async () => {} };
const c = { title: 'X', pageSize: 30, fullText: false, chain: [], markRead: false };
const ctx = { waitUntil: (p) => p.catch(() => {}) };
const call = async (p, qs = '') => handleApi({ path: p, url: new URL('https://w.example' + p + qs), cf, c, env: {}, ctx, request: new Request('https://w.example' + p) });

let r = await (await call('/api/article/1')).json();
check('no images unless asked', !('images' in r) && !r.text.includes('[[img') && fetched.length === 0, r.text);

r = await (await call('/api/article/1', '?images=1')).json();
const byN = Object.fromEntries((r.images || []).map((i) => [i.n, i]));
check('markers in reading order', r.text.indexOf('Intro') < r.text.indexOf('[[img:1]]') && r.text.indexOf('[[img:1]]') < r.text.indexOf('Middle') && r.text.indexOf('[[img:3]]') < r.text.indexOf('[[img:4]]') && r.text.indexOf('[[img:4]]') < r.text.indexOf('End'), r.text);
check('known sizes are fitted', byN[1] && byN[1].w === 456 && byN[1].h === 304 && byN[3] && byN[3].w === 456 && byN[3].h === 342 && byN[3].src.includes('fit=fill'), JSON.stringify(r.images));
check('emoji left out', !byN[2] && !r.text.includes('[[img:2]]'), r.text);
check('unreadable size gets the box', byN[4] && byN[4].w === 456 && byN[4].h === 342 && byN[4].src.includes('fit=contain'), JSON.stringify(byN[4]));
check('alt is passed on', byN[1].alt === 'Photo');
check('only the first bytes are asked, with a User-Agent', fetched.every((f) => /^bytes=0-\d+$/.test(f.range) && /rss-opds/.test(f.ua)), JSON.stringify(fetched));
const before = fetched.length;
await call('/api/article/1', '?images=1');
check('sniffed sizes are cached', fetched.length === before, `${fetched.length - before} new fetches`);
check('/api/img is gone', (await call('/api/img', '?u=x')).status === 404);

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
