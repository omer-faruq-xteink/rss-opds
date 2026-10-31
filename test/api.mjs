// Offline test of the JSON API: htmlToText and handleApi against a fake CommaFeed client.
// Run: node test/api.mjs
import { handleApi, htmlToText, listItem } from '../src/api.js';
import { CommaFeed, normalizeRestEntry } from '../src/commafeed.js';

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) failures++;
};

const html = `<h2>Başlık</h2><p>Birinci <b>paragraf</b> &amp; metin.<br>ikinci satır</p>
<script>alert(1)</script><ul><li>bir<li>iki</ul><p>Son &hellip;</p>`;
const text = htmlToText(html);
check('paragraphs separated', text.includes('# Başlık\n\nBirinci paragraf & metin.\nikinci satır'), JSON.stringify(text));
check('quote marker', htmlToText('<blockquote><p>Alıntı</p></blockquote><p>son</p>') === '> Alıntı\n\nson');
check('excerpt has no markers', !/[#>•] /.test(listItem({ id: '1', content: '<h2>H</h2><ul><li>a</li><li>b</li></ul>' }).excerpt));
check('list bullets', text.includes('• bir') && text.includes('• iki'));
check('script dropped', !text.includes('alert'));
check('entities decoded', text.endsWith('Son …'));
check('cap with ellipsis', htmlToText('<p>' + 'word '.repeat(100) + '</p>', 500).length <= 501);

const entries = Array.from({ length: 25 }, (_, i) => ({
  id: String(100 + i), title: `Yazı ${i}`, content: `<p>İçerik ${i} ` + 'x'.repeat(300) + '</p>',
  feedName: 'Kaynak', date: Date.UTC(2026, 9, 24, 8, 15), read: i % 2 === 0, starred: false, url: `https://e.example/${i}`,
}));
const calls = [];
const cf = {
  async entries(q) { calls.push(['entries', q]); const off = q.offset || 0; return { name: 'Mock', entries: entries.slice(off, off + q.limit), hasMore: off + q.limit < entries.length }; },
  async getRoot() { return { children: [{ id: 1, name: 'Tech', feeds: [{ id: 10, name: 'A', unread: 3 }, { id: 11, name: 'B', unread: 0 }], children: [] }], feeds: [] }; },
  async getEntry(id) { const e = entries.find((x) => x.id === id); return e ? { ...e, date: new Date(e.date) } : null; },
  async findEntryByScan() { return null; },
  async markRead(id, read) { calls.push(['mark', id, read]); },
  async star(id, on, feed) { calls.push(['star', id, on, feed]); },
  async tags() { return ['zeta', 'alpha']; },
  async setTags(id, tags) { calls.push(['tag', id, tags]); },
  canEditTags: true,
};
const c = { title: 'T', pageSize: 30, fullText: false, chain: [], markRead: false };
const ctx = { waitUntil(p) { p.catch(() => {}); } };
const call = (p, qs = '') => handleApi({ path: p, url: new URL('https://w.example' + p + qs), cf, c, env: {}, ctx, request: new Request('https://w.example' + p) });

check('non-api path ignored', (await call('/opds')) === null);
let r = await (await call('/api/list', '?kind=unread&n=10&page=2')).json();
check('list page 2', r.page === 2 && r.items.length === 10 && r.items[0].id === '110' && r.has_more === true, JSON.stringify(r).slice(0, 200));
check('list item shape', r.items[0].excerpt.length <= 401 && r.items[0].excerpt.length > 200 && r.items[0].date === '2026-10-24 08:15' && r.items[0].feed === 'Kaynak');
check('unread maps to category all/unread', calls[0][1].kind === 'category' && calls[0][1].id === 'all' && calls[0][1].readType === 'unread');
r = await (await call('/api/list', '?kind=feed&id=10')).json();
check('feed list', calls[1][1].kind === 'feed' && calls[1][1].id === '10' && calls[1][1].readType === 'unread');
check('bad kind', (await call('/api/list', '?kind=feed&id=x')).status === 400);
r = await (await call('/api/categories')).json();
check('categories', r.items[0].name === 'Tech' && r.items[0].unread === 3 && r.items[0].feeds === 2);
r = await (await call('/api/feeds')).json();
check('feeds sorted by unread', r.items[0].name === 'A' && r.items[1].name === 'B');
r = await (await call('/api/article/103', '?max=600')).json();
check('article text', r.title === 'Yazı 3' && r.text.startsWith('İçerik 3') && r.text.length <= 601 && r.source === 'feed');
check('article not marked by default', !calls.some((x) => x[0] === 'mark'));
await call('/api/article/103', '?mark=1');
await new Promise((res) => setTimeout(res, 10));
check('article ?mark=1 marks read', calls.some((x) => x[0] === 'mark' && x[1] === '103' && x[2] === undefined));
check('article 404', (await call('/api/article/999')).status === 404);
r = await (await call('/api/mark/105', '?read=0')).json();
check('mark unread', r.ok === true && calls.at(-1)[1] === '105' && calls.at(-1)[2] === false);
r = await (await call('/api/star/105', '?on=0&feed=11')).json();
check('unstar', r.ok === true && r.starred === false && calls.at(-1).join() === 'star,105,false,11');
await call('/api/star/106');
check('star without feed', calls.at(-1).join() === 'star,106,true,');
r = await (await call('/api/tags')).json();
check('tags sorted', r.items.map((x) => x.name).join() === 'alpha,zeta' && r.editable === true);
r = await (await call('/api/tag/107', '?tags=' + encodeURIComponent(' to read , work,to read,,'))).json();
check('set tags answers tag_line', r.tag_line === 'to read, work', r.tag_line);
check('set tags trimmed, no repeats', r.ok && JSON.stringify(calls.at(-1)) === '["tag","107",["to read","work"]]', JSON.stringify(calls.at(-1)));
await call('/api/list', '?kind=tag&id=' + encodeURIComponent('to read'));
const tq = calls.filter((x) => x[0] === 'entries').at(-1)[1];
check('tag list', tq.tag === 'to read' && tq.id === 'all' && tq.readType === 'all' && tq.title === 'to read');
check('tag list needs a name', (await call('/api/list', '?kind=tag')).status === 400);
cf.canEditTags = false;
const before = calls.length;
check('tags read-only with an API key', (await call('/api/tag/107', '?tags=a')).status === 501 && calls.length === before);
r = await (await call('/api')).json();
check('api root', r.page_size === 20 && r.kinds.includes('tag') && r.tag_edit === false);
cf.canEditTags = true;
const li = listItem(normalizeRestEntry({ id: 5, feedId: 11, tags: ['x'], content: '' }));
const li2 = listItem(normalizeRestEntry({ id: 6, content: '' }));
check('list item feed_id and tag_line, no array', li.feed_id === '11' && li.tag_line === 'x' && !('tags' in li) && li2.tag_line === '');
check('tag_line joins', listItem(normalizeRestEntry({ id: 7, tags: ['a b', 'c'], content: '' })).tag_line === 'a b, c');

// the CommaFeed client: which call star and tags make with an API key / with a password
{
  const realFetch0 = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (u, init = {}) => {
    sent.push([init.method || 'GET', String(u).replace(/^https:\/\/cf\.example\/rest/, ''), init.body ? String(init.body) : '']);
    if (String(u).includes('/token')) return new Response('tok');
    if (String(u).includes('/entry/tags')) return new Response('["a","b"]', { headers: { 'content-type': 'application/json' } });
    return new Response('OK');
  };
  const key = new CommaFeed({ baseUrl: 'https://cf.example', apiKey: 'k' });
  await key.star(9, true, '11');
  check('API key: star through the Reader API', sent.at(-1)[1].startsWith('/googlereader/reader/api/0/edit-tag') && sent.at(-1)[2] === 'i=9&a=user%2F-%2Fstate%2Fcom.google%2Fstarred&T=tok', JSON.stringify(sent.at(-1)));
  await key.star(9, false);
  check('API key: unstar', sent.at(-1)[2] === 'i=9&r=user%2F-%2Fstate%2Fcom.google%2Fstarred&T=tok');
  check('API key: tag names', (await key.tags()).join() === 'a,b' && sent.at(-1)[1].startsWith('/entry/tags?apiKey=k'));
  let threw = null;
  try { await key.setTags(9, ['a']); } catch (e) { threw = e; }
  check('API key: tags cannot be edited', !key.canEditTags && threw && threw.status === 501);
  const pw = new CommaFeed({ baseUrl: 'https://cf.example', username: 'u', password: 'p' });
  await pw.star(9, true, '11');
  check('password: star through REST', sent.at(-1)[1] === '/entry/star' && sent.at(-1)[2] === '{"id":"9","feedId":11,"starred":true}', JSON.stringify(sent.at(-1)));
  await pw.setTags(9, ['a', 'b']);
  check('password: set tags', pw.canEditTags && sent.at(-1)[0] === 'POST' && sent.at(-1)[1] === '/entry/tag' && sent.at(-1)[2] === '{"entryId":9,"tags":["a","b"]}');
  await key.markRead(9, false);
  check('markRead still uses edit-tag', sent.at(-1)[2] === 'i=9&r=user%2F-%2Fstate%2Fcom.google%2Fread&T=tok');
  globalThis.fetch = realFetch0;
}
check('listItem untitled', listItem({ id: '1', content: '' }).title === '(untitled)');

// /api/read: any page through the full-text chain
check('read needs a url', (await call('/api/read', '?url=ftp://x')).status === 400);
check('read without a chain', (await call('/api/read', '?url=https://e.example/a')).status === 501);
const realFetch = globalThis.fetch;
const asked = [];
globalThis.fetch = async (u, init) => {
  if (String(u).endsWith('/pic.png')) {                    // the image size sniff: a 1200x800 PNG
    const b = new Uint8Array(40);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(b.buffer).setUint32(16, 1200); new DataView(b.buffer).setUint32(20, 800);
    return new Response(b, { status: 206 });
  }
  const body = JSON.parse(init.body);
  asked.push(body.url);
  const html = body.url.endsWith('/empty') ? '' : '<h2>Story</h2><p>' + 'Full text here. '.repeat(30) + '</p><p><img src="/pic.png" alt="A chart"></p><p>After.</p>';
  return new Response(JSON.stringify({ html }), { headers: { 'content-type': 'application/json' } });
};
c.chain = ['instaparser'];
const readCall = (qs) => handleApi({ path: '/api/read', url: new URL('https://w.example/api/read' + qs), cf, c, env: { INSTAPARSER_TOKEN: 't' }, ctx, request: new Request('https://w.example/api/read') });
r = await (await readCall('?url=' + encodeURIComponent('https://news.example/a?b=1') + '&max=600')).json();
check('read gives text', r.source === 'instaparser' && r.text.startsWith('# Story\n\nFull text here.') && r.text.length <= 601 && asked[0] === 'https://news.example/a?b=1', JSON.stringify(r).slice(0, 200));
check('read without images: no markers', !r.text.includes('[[img') && r.images === undefined);
r = await (await readCall('?url=https://news.example/b&images=1')).json();
check('read with images', r.text.includes('[[img:1]]') && r.text.endsWith('After.') && r.images.length === 1 && r.images[0].w === 456 && r.images[0].h === 304
  && r.images[0].src.includes(encodeURIComponent('https://news.example/pic.png')) && r.images[0].alt === 'A chart', JSON.stringify(r).slice(-300));
check('read finds nothing', (await readCall('?url=https://news.example/empty')).status === 404);
globalThis.fetch = realFetch;
c.chain = [];

// /api/feed: a feed the reader cannot take, without CommaFeed
const bigItems = Array.from({ length: 50 }, (_, i) => `<item><title><![CDATA[Item <${i}>]]></title><link>/p/${i}</link><guid isPermaLink="false">g${i}</guid>`
  + `<pubDate>${new Date(Date.UTC(2026, 9, 1 + (i % 28), 12)).toUTCString()}</pubDate><description>Short &amp; sweet ${i}</description>`
  + `<content:encoded><![CDATA[<p>Body ${i} ${'y'.repeat(20000)}</p>]]></content:encoded></item>`).join('');
const rssBody = `<?xml version="1.0"?><rss version="2.0"><channel><title>Big &amp; Co</title><link>https://big.example/</link>${bigItems}</channel></rss>`;
const atomBody = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom One</title><link rel="self" href="https://a.example/feed"/><link href="https://a.example/"/>`
  + `<entry><title type="html">A <![CDATA[&]]> B &amp; C</title><link rel="alternate" href="https://a.example/1"/><id>tag:a,1</id><updated>2026-10-30T10:00:00Z</updated><summary>Sum</summary></entry></feed>`;
const fetched = [];
globalThis.fetch = async (u) => {
  fetched.push(String(u));
  if (String(u).includes('big.example')) return new Response(rssBody, { headers: { 'content-type': 'application/rss+xml' } });
  if (String(u).includes('a.example')) return new Response(atomBody);
  if (String(u).includes('page.example')) return new Response('<html>no feed</html>');
  return new Response('gone', { status: 410 });
};
const feedCall = (qs) => handleApi({ path: '/api/feed', url: new URL('https://w.example/api/feed' + qs), cf, c, env: {}, ctx, request: new Request('https://w.example/api/feed') });
check('feed needs a url', (await feedCall('?url=ftp://x')).status === 400);
r = await (await feedCall('?n=40&url=' + encodeURIComponent('https://big.example/feed'))).json();
check('feed: newest 40 of 50', r.title === 'Big & Co' && r.total === 50 && r.items.length === 40 && r.items.every((x, i) => i === 0 || x.date <= r.items[i - 1].date), JSON.stringify(r).slice(0, 200));
const i27 = r.items.find((x) => x.id === 'g27');
check('feed: item fields', i27 && i27.title === 'Item <27>' && i27.link === 'https://big.example/p/27' && i27.excerpt === 'Short & sweet 27' && i27.has_content === true
  && i27.date === Date.UTC(2026, 9, 28, 12) / 1000, JSON.stringify(i27));
check('feed: small answer', JSON.stringify(r).length < 20000, String(JSON.stringify(r).length));
r = await (await feedCall('?url=https://big.example/feed&id=g3&max=600')).json();
check('feed: one item as text', r.id === 'g3' && r.source === 'feed' && r.text.startsWith('Body 3 yyy') && r.text.length <= 601 && r.url === 'https://big.example/p/3', JSON.stringify(r).slice(0, 200));
check('feed: item gone', (await feedCall('?url=https://big.example/feed&id=nope')).status === 404);
r = await (await feedCall('?url=https://a.example/feed')).json();
check('feed: atom', r.title === 'Atom One' && r.link === 'https://a.example/' && r.items[0].id === 'tag:a,1' && r.items[0].title === 'A & B & C'
  && r.items[0].link === 'https://a.example/1' && r.items[0].has_content === false && r.items[0].excerpt === 'Sum', JSON.stringify(r));
check('feed: not a feed', (await feedCall('?url=https://page.example/')).status === 422);
check('feed: server error', (await feedCall('?url=https://x.example/')).status === 502);
globalThis.fetch = realFetch;
r = await (await handleApi({ path: '/api', url: new URL('https://w.example/api'), cf, c, env: {}, ctx, request: new Request('https://w.example/api'), accounts: [{ n: 1, label: 'Account 1' }], acct: { n: 1 } })).json();
check('api: no CommaFeed account', r.commafeed === false, JSON.stringify(r));
r = await (await handleApi({ path: '/api', url: new URL('https://w.example/api'), cf, c, env: {}, ctx, request: new Request('https://w.example/api'), accounts: [{ n: 1, label: 'A' }], acct: { n: 1, baseUrl: 'https://cf.example', apiKey: 'k' } })).json();
check('api: CommaFeed account', r.commafeed === true, JSON.stringify(r));

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
