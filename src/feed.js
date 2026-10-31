// RSS 2.0, RSS 1.0 (RDF) and Atom, for /api/feed: feeds the reader fetches itself until they are
// too large for it (the X4 Pro keeps 128 KB of an answer). Item ids follow the RSS mini app's
// own parser (Atom id, RSS guid, else the link, else the title), so an article keeps its id
// whichever way the feed was read.
import { decodeEntities } from './html.js';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// the first <name ...>...</name> in xml (whole element, attributes included), or null
function element(xml, name) {
  const re = new RegExp(`<${esc(name)}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${esc(name)}\\s*>)`, 'i');
  const m = re.exec(xml);
  return m ? { attrs: m[0].slice(0, m[0].indexOf('>') + 1), body: m[1] || '' } : null;
}

// element text with CDATA unwrapped and entities decoded: HTML for content, summary
function inner(el) {
  if (!el) return '';
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(el.body);
  return cdata ? cdata[1] : decodeEntities(el.body.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
}

// plain text: titles, ids, links; tags are dropped before entities are decoded, and CDATA is
// kept as written (a title "<![CDATA[Item <3>]]>" stays "Item <3>"), as in the mini app
function plain(el) {
  if (!el) return '';
  const lit = [];
  let s = el.body.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c) => `\u0001${lit.push(c) - 1}\u0001`);
  s = decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\u0001(\d+)\u0001/g, (_, k) => lit[Number(k)]);
  return s.replace(/\s+/g, ' ').trim();
}

function attr(tag, name) {
  const m = new RegExp(`\\s${esc(name)}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? decodeEntities(m[2] ?? m[3]) : '';
}

function atomLink(xml) {
  let first = '';
  for (const m of xml.matchAll(/<link\b[^>]*>/gi)) {
    const rel = attr(m[0], 'rel');
    const href = attr(m[0], 'href');
    if (!href) continue;
    if (!rel || rel === 'alternate') return href;
    if (!first) first = href;
  }
  return first;
}

function absolute(link, base) {
  try { return new URL(link, base || undefined).toString(); } catch { return link; }
}

function date(s) {
  const t = Date.parse(String(s || '').trim());
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

export function isFeed(body) {
  return /<(rss|feed|rdf:RDF|channel)[\s>]/.test(String(body || '').slice(0, 2048));
}

/** @returns {{title:string, link:string, items:{id,title,link,date,summary,content}[]}|null} */
export function parseFeed(body, base) {
  if (!isFeed(body)) return null;
  const atom = /<feed[\s>]/.test(body.slice(0, 2048));
  const tag = atom ? 'entry' : 'item';
  const first = body.search(new RegExp(`<${tag}[\\s>]`));
  const head = first < 0 ? body : body.slice(0, first);
  const feed = { title: plain(element(head, 'title')), link: atom ? atomLink(head) : plain(element(head, 'link')), items: [] };
  const linkBase = feed.link || base;
  for (const m of body.matchAll(new RegExp(`<${tag}[\\s>][\\s\\S]*?</${tag}>`, 'g'))) {
    const block = m[0];
    const it = { title: plain(element(block, 'title')) };
    if (atom) {
      it.link = atomLink(block);
      it.id = plain(element(block, 'id'));
      it.date = date(plain(element(block, 'published')) || plain(element(block, 'updated')));
      it.summary = inner(element(block, 'summary'));
      it.content = inner(element(block, 'content'));
    } else {
      it.link = plain(element(block, 'link'));
      if (!it.link) {
        const g = /<guid[^>]*isPermaLink\s*=\s*["']true["'][^>]*>([\s\S]*?)<\/guid>/i.exec(block);
        if (g) it.link = plain({ body: g[1] });
      }
      it.id = plain(element(block, 'guid'));
      it.date = date(plain(element(block, 'pubDate')) || plain(element(block, 'dc:date')));
      it.summary = inner(element(block, 'description'));
      it.content = inner(element(block, 'content:encoded'));
    }
    if (it.link) it.link = absolute(it.link, linkBase);
    if (!it.id) it.id = it.link || it.title;
    if (it.id) feed.items.push(it);
  }
  return feed;
}
