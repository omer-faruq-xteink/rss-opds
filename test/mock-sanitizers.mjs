// Fake Instaparser / Diffbot / Instapaper endpoints for local tests.
// Run: node test/mock-sanitizers.mjs [port]   (default 8791)
// Behaviour is steered by the article URL:
//   .../post/N where N % 3 == 0  -> instaparser returns an error, diffbot answers
//   N % 3 == 1                   -> instaparser answers
//   N % 3 == 2                   -> instaparser and diffbot fail, instapaper answers
import { createServer } from 'node:http';

const port = parseInt(process.argv[2] || '8791', 10);
const log = [];
const json = (res, obj, status = 200, extra = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', date: new Date().toUTCString(), ...extra });
  res.end(JSON.stringify(obj));
};
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
const n = (u) => parseInt((/post\/(\d+)/.exec(u || '') || [])[1] || '0', 10);
const article = (who, u) => `<div><p>${who} full text for ${u}.</p>${'<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.</p>'.repeat(4)}<img src="https://httpbin.org/image/png" alt="full"></div>`;

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const auth = req.headers.authorization || '';
  log.push(`${req.method} ${url.pathname}`);
  console.log(req.method, url.pathname + url.search, auth ? `(auth: ${auth.slice(0, 12)}…)` : '');

  if (url.pathname === '/instaparser/api/1/article' && req.method === 'POST') {
    if (auth !== 'Bearer ip-token') return json(res, { error: 'unauthorized' }, 401);
    const body = JSON.parse(await readBody(req));
    if (n(body.url) % 3 !== 1) return json(res, { error: 'could not parse' }, 200);
    return json(res, { html: article('Instaparser', body.url), title: 'x' });
  }
  if (url.pathname === '/diffbot/v3/analyze') {
    if (url.searchParams.get('token') !== 'db-token') return json(res, { errorCode: 401, error: 'bad token' }, 401);
    const u = url.searchParams.get('url');
    if (n(u) % 3 === 2) return json(res, { objects: [{ type: 'other', text: 'short' }] });
    return json(res, { objects: [{ type: 'article', html: article('Diffbot', u), title: 'x' }] });
  }
  if (url.pathname === '/instapaper/api/2/bookmarks' && req.method === 'POST') {
    if (auth !== 'Bearer pp-token') return json(res, { error: { message: 'nope' } }, 401);
    const body = JSON.parse(await readBody(req));
    return json(res, { id: 4242, url: body.url, time: Math.floor(Date.now() / 1000) });
  }
  if (url.pathname === '/instapaper/api/2/bookmarks/4242/parse') {
    return json(res, { content: { body: article('Instapaper', 'bookmark 4242'), direction: 'ltr' } });
  }
  if (url.pathname === '/instapaper/api/2/bookmarks/4242' && req.method === 'DELETE') {
    res.writeHead(204); return res.end();
  }
  if (url.pathname === '/__log') return json(res, log);
  json(res, { error: 'not found' }, 404);
}).listen(port, '127.0.0.1', () => console.log(`mock sanitizers on http://127.0.0.1:${port}`));
