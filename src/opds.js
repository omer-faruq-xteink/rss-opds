// OPDS 1.2 (Atom) feed builders. Kept deliberately plain: absolute hrefs,
// no redirects, standard rel/type values, so small embedded parsers
// (Xteink stock firmware, CrossPoint, KOReader) can read them.
import { escapeXml } from './html.js';

export const TYPE_NAV = 'application/atom+xml;profile=opds-catalog;kind=navigation';
export const TYPE_ACQ = 'application/atom+xml;profile=opds-catalog;kind=acquisition';
export const TYPE_OPENSEARCH = 'application/opensearchdescription+xml';
export const REL_ACQ = 'http://opds-spec.org/acquisition';

const NS = 'xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/" xmlns:opds="http://opds-spec.org/2010/catalog"';

function iso(d) {
  const date = d instanceof Date && !isNaN(d) ? d : new Date();
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function link(rel, href, type, extra = '') {
  return `<link rel="${escapeXml(rel)}" href="${escapeXml(href)}" type="${escapeXml(type)}"${extra}/>`;
}

function feedHead({ id, title, self, start, selfType, search, up, prev, next }) {
  const links = [
    link('self', self, selfType),
    link('start', start, TYPE_NAV),
    up ? link('up', up, TYPE_NAV) : '',
    prev ? link('previous', prev, TYPE_ACQ) : '',
    next ? link('next', next, TYPE_ACQ) : '',
    search ? link('search', search.description, TYPE_OPENSEARCH) : '',
    search ? link('search', search.template, TYPE_ACQ) : '',
  ].filter(Boolean);
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed ${NS}>
<id>${escapeXml(id)}</id>
<title>${escapeXml(title)}</title>
<updated>${iso(new Date())}</updated>
<author><name>commafeed-opds</name></author>
${links.join('\n')}`;
}

/**
 * Navigation feed: entries link to other catalogs.
 * @param {{title:string, href:string, summary?:string, kind?:'nav'|'acq', id?:string}[]} items
 */
export function navigationFeed(opts, items) {
  const entries = items.map((it) => `<entry>
<id>${escapeXml(it.id || it.href)}</id>
<title>${escapeXml(it.title)}</title>
<updated>${iso(new Date())}</updated>
${it.summary ? `<content type="text">${escapeXml(it.summary)}</content>` : ''}
${link('subsection', it.href, it.kind === 'nav' ? TYPE_NAV : TYPE_ACQ)}
</entry>`);
  return `${feedHead({ ...opts, selfType: TYPE_NAV })}
${entries.join('\n')}
</feed>
`;
}

/**
 * Acquisition feed: each entry is a downloadable EPUB.
 * @param {{id:string, title:string, author?:string, feedName?:string, date?:Date, summary?:string, epubHref:string, url?:string}[]} books
 */
export function acquisitionFeed(opts, books) {
  const entries = books.map((b) => `<entry>
<id>${escapeXml(b.id)}</id>
<title>${escapeXml(b.title || '(untitled)')}</title>
<updated>${iso(b.date)}</updated>
<published>${iso(b.date)}</published>
<author><name>${escapeXml(b.author || b.feedName || 'Unknown')}</name></author>
${b.feedName ? `<dc:publisher>${escapeXml(b.feedName)}</dc:publisher>` : ''}
${b.summary ? `<content type="text">${escapeXml(b.summary)}</content>` : ''}
${link(REL_ACQ, b.epubHref, 'application/epub+zip')}
</entry>`);
  return `${feedHead({ ...opts, selfType: TYPE_ACQ })}
${entries.join('\n')}
</feed>
`;
}

export function openSearchDescription({ shortName, template }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
<ShortName>${escapeXml(shortName)}</ShortName>
<Description>Search ${escapeXml(shortName)}</Description>
<InputEncoding>UTF-8</InputEncoding>
<OutputEncoding>UTF-8</OutputEncoding>
<Url type="${TYPE_ACQ}" template="${escapeXml(template)}"/>
</OpenSearchDescription>
`;
}
