// Fake Yandex Disk public-resources API for local tests.
// Run: node test/mock-yandex.mjs [port]   (default 8792)
// Serves a share with: /Kitaplar/ (3 epubs + 1 pdf), /Kitaplar/Alt/ (1 epub), and a root epub.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const port = parseInt(process.argv[2] || '8792', 10);
const sample = existsSync(join(process.cwd(), '.test-out', 'sample.epub'))
  ? readFileSync(join(process.cwd(), '.test-out', 'sample.epub'))
  : Buffer.from('PK\x03\x04mimetypeapplication/epub+zip-fake');

const tree = {
  '/': [
    { name: 'Kitaplar', type: 'dir', path: '/Kitaplar' },
    { name: 'Kök Kitap – örnek.epub', type: 'file', path: '/Kök Kitap – örnek.epub', size: sample.length, modified: '2026-10-20T10:00:00+00:00' },
  ],
  '/Kitaplar': [
    { name: 'Alt', type: 'dir', path: '/Kitaplar/Alt' },
    { name: 'Birinci Kitap.epub', type: 'file', path: '/Kitaplar/Birinci Kitap.epub', size: sample.length, modified: '2026-10-21T10:00:00+00:00' },
    { name: 'İkinci Kitap.epub', type: 'file', path: '/Kitaplar/İkinci Kitap.epub', size: sample.length, modified: '2026-10-22T10:00:00+00:00' },
    { name: 'Not kitap.pdf', type: 'file', path: '/Kitaplar/Not kitap.pdf', size: 10, modified: '2026-10-22T10:00:00+00:00' },
    { name: 'Üçüncü Kitap.epub', type: 'file', path: '/Kitaplar/Üçüncü Kitap.epub', size: sample.length, modified: '2026-10-23T10:00:00+00:00' },
  ],
  '/Kitaplar/Alt': [
    { name: 'Derin Kitap.epub', type: 'file', path: '/Kitaplar/Alt/Derin Kitap.epub', size: sample.length, modified: '2026-10-19T10:00:00+00:00' },
  ],
};
const json = (res, obj, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  console.log(req.method, url.pathname + url.search);
  if (url.pathname === '/public/resources') {
    if (url.searchParams.get('public_key') !== 'https://disk.yandex.ru/d/TESTSHARE') return json(res, { message: 'bad public_key' }, 404);
    const path = url.searchParams.get('path') || '/';
    const items = tree[path];
    if (!items) return json(res, { message: 'not found' }, 404);
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);
    return json(res, { name: path === '/' ? 'Paylaşım' : path.split('/').pop(), type: 'dir', path, _embedded: { items: items.slice(offset, offset + limit), total: items.length, limit, offset } });
  }
  if (url.pathname === '/public/resources/download') {
    const path = url.searchParams.get('path') || '';
    const found = Object.values(tree).flat().find((i) => i.type === 'file' && i.path === path);
    if (!found) return json(res, { message: 'not found' }, 404);
    return json(res, { href: `http://127.0.0.1:${port}/file?path=${encodeURIComponent(path)}`, method: 'GET', templated: false });
  }
  if (url.pathname === '/file') {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': sample.length });
    return res.end(sample);
  }
  json(res, { message: 'not found' }, 404);
}).listen(port, '127.0.0.1', () => console.log(`mock Yandex Disk on http://127.0.0.1:${port} (public_key https://disk.yandex.ru/d/TESTSHARE)`));
