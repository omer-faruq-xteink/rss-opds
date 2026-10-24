// Offline test of the JSON API: htmlToText and handleApi against a fake CommaFeed client.
// Run: node test/api.mjs
import { handleApi, htmlToText, listItem } from '../src/api.js';

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
r = await (await call('/api')).json();
check('api root', r.page_size === 20 && r.kinds.includes('unread'));
check('listItem untitled', listItem({ id: '1', content: '' }).title === '(untitled)');

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
