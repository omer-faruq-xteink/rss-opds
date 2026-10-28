// Tiny fake CommaFeed server for local end-to-end tests of the Worker.
// Run: node test/mock-commafeed.mjs [port]   (default 8790)
import { createServer } from 'node:http';

const port = parseInt(process.argv[2] || '8790', 10);
const API_KEY = 'testkey';
const entries = Array.from({ length: 45 }, (_, i) => ({
  id: String(1000 + i),
  guid: `g${i}`,
  title: `Yazı ${i} – başlık & test`,
  // httpbin serves a real JPEG so INCLUDE_IMAGES / ?images=1 can be exercised end to end.
  content: `<p>Paragraf <b>${i}</b> &amp; içerik.</p><img src="https://httpbin.org/image/jpeg?n=${i}" alt="resim"><p>İkinci paragraf.</p>`,
  author: i % 3 ? 'Yazar' : '',
  date: Date.now() - i * 3600_000,
  insertedDate: Date.now() - i * 3600_000,
  feedId: String(10 + (i % 2)),
  feedName: i % 2 ? 'Kaynak B' : 'Kaynak A',
  url: `https://example.com/post/${i}`,
  read: i % 5 === 0,
  starred: i % 7 === 0,
  markable: true,
  tags: i % 4 === 0 ? ['later'] : [],
}));
let marked = [];

const json = (res, obj, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const authHeader = req.headers.authorization || '';
  const basicOk = authHeader === 'Basic ' + Buffer.from('user:pass').toString('base64');
  const authed = url.searchParams.get('apiKey') === API_KEY || authHeader === `GoogleLogin auth=${API_KEY}` || basicOk;
  console.log(req.method, url.pathname + url.search, authed ? '' : '(unauthenticated)');
  if (!authed) return json(res, { message: 'unauthorized' }, 401);

  if (url.pathname === '/rest/category/get') {
    return json(res, {
      id: 'all', name: 'All', expanded: true, position: 0,
      children: [{ id: '5', name: 'Teknoloji', children: [], feeds: [{ id: 10, name: 'Kaynak A', unread: 20, feedLink: 'https://a.example' }], expanded: true, position: 0 }],
      feeds: [{ id: 11, name: 'Kaynak B', unread: 16, feedLink: 'https://b.example' }],
    });
  }
  if (url.pathname === '/rest/category/entries' || url.pathname === '/rest/feed/entries') {
    const id = url.searchParams.get('id');
    const readType = url.searchParams.get('readType') || 'unread';
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);
    const kw = (url.searchParams.get('keywords') || '').toLowerCase();
    let list = entries;
    if (url.pathname.includes('/feed/')) list = list.filter((e) => e.feedId === id);
    else if (id === 'starred') list = list.filter((e) => e.starred);
    else if (id !== 'all') list = list.filter((e) => e.feedId === '10');
    if (readType === 'unread' && id !== 'starred' && !kw) list = list.filter((e) => !e.read);
    if (kw) list = list.filter((e) => e.title.toLowerCase().includes(kw));
    const tag = url.searchParams.get('tag');
    if (tag) list = entries.filter((e) => e.tags.includes(tag));
    const pageItems = list.slice(offset, offset + limit);
    return json(res, { name: id, timestamp: Date.now(), hasMore: offset + limit < list.length, offset, limit, entries: pageItems, ignoredReadStatus: false });
  }
  if (url.pathname === '/rest/googlereader/reader/api/0/stream/items/contents') {
    const ids = url.searchParams.getAll('i');
    const items = entries.filter((e) => ids.includes(e.id)).map((e) => ({
      id: `tag:google.com,2005:reader/item/${Number(e.id).toString(16).padStart(16, '0')}`,
      title: e.title, author: e.author, published: Math.floor(e.date / 1000), updated: Math.floor(e.date / 1000),
      canonical: [{ href: e.url }], alternate: [{ href: e.url, type: 'text/html' }],
      summary: { content: e.content, direction: 'ltr' }, origin: { streamId: `feed/${e.feedId}`, title: e.feedName, htmlUrl: 'https://x' },
    }));
    return json(res, { id: 'user/-/state/com.google/reading-list', title: 'x', updated: 0, items });
  }
  if (url.pathname === '/rest/googlereader/reader/api/0/token') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('tok123');
  }
  if (url.pathname === '/rest/googlereader/reader/api/0/edit-tag' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const p = new URLSearchParams(body);
      console.log('  edit-tag', body);
      if (p.get('T') !== 'tok123') return json(res, {}, 401);
      marked.push(p.get('i'));
      const e = entries.find((x) => x.id === p.get('i'));
      const st = 'user/-/state/com.google/starred';
      if (e && (p.get('a') === st || p.get('r') === st)) e.starred = p.get('a') === st;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('OK');
    });
    return;
  }
  if (url.pathname === '/rest/entry/mark' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const p = JSON.parse(body || '{}');
      console.log('  entry/mark', body);
      marked.push(`basic:${p.id}`);
      res.writeHead(200);
      res.end();
    });
    return;
  }
  if (url.pathname === '/rest/entry/tags') return json(res, [...new Set(entries.flatMap((e) => e.tags))]);
  if ((url.pathname === '/rest/entry/star' || url.pathname === '/rest/entry/tag') && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const p = JSON.parse(body || '{}');
      console.log(' ', url.pathname, body);
      const e = entries.find((x) => x.id === String(p.id || p.entryId));
      if (e && 'starred' in p) e.starred = !!p.starred;
      if (e && p.tags) e.tags = p.tags;
      res.writeHead(200);
      res.end();
    });
    return;
  }
  if (url.pathname === '/__marked') return json(res, marked);
  json(res, { message: 'not found' }, 404);
}).listen(port, '127.0.0.1', () => console.log(`mock CommaFeed on http://127.0.0.1:${port} (apiKey=${API_KEY})`));
