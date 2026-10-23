// Builds a single-chapter EPUB (EPUB 3 package with an EPUB 2 NCX for older
// readers) from one article. Output is a stored ZIP as Uint8Array.
import { buildStoredZip } from './zip.js';
import { escapeXml, htmlToXhtml } from './html.js';

const CSS = `
body { font-family: serif; line-height: 1.4; margin: 0 0.5em; }
h1 { font-size: 1.4em; line-height: 1.2; margin: 0.6em 0 0.3em; }
h2, h3, h4 { font-size: 1.15em; margin: 1em 0 0.3em; }
p { margin: 0 0 0.7em; text-align: left; }
p.meta { font-size: 0.85em; color: #444; margin-bottom: 1.2em; }
p.source { font-size: 0.8em; margin-top: 1.5em; word-wrap: break-word; }
img { max-width: 100%; height: auto; }
span.img-alt { font-style: italic; }
pre, code { font-family: monospace; font-size: 0.9em; white-space: pre-wrap; word-wrap: break-word; }
blockquote { margin: 0.5em 1em; padding-left: 0.6em; border-left: 2px solid #999; }
table { border-collapse: collapse; } td, th { border: 1px solid #999; padding: 0.2em 0.4em; }
figcaption { font-size: 0.85em; font-style: italic; }
hr { border: 0; border-top: 1px solid #999; margin: 1em 0; }
`.trim();

const EXT_BY_TYPE = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };

/**
 * @param {object} a
 * @param {string} a.id            stable id (CommaFeed entry id)
 * @param {string} a.title
 * @param {string} [a.author]
 * @param {string} [a.feedName]
 * @param {string} [a.url]         original article URL
 * @param {Date}   [a.date]
 * @param {string} a.html          article body HTML
 * @param {string} [a.lang]
 * @param {{url: string, type: string, data: Uint8Array}[]} [a.images] fetched images, in order
 * @returns {Uint8Array}
 */
export function buildEpub(a) {
  const enc = new TextEncoder();
  const lang = a.lang || 'en';
  const date = a.date instanceof Date && !isNaN(a.date) ? a.date : new Date();
  const title = (a.title || '').trim() || '(untitled)';
  const author = (a.author || '').trim();
  const feedName = (a.feedName || '').trim();
  const creator = author || feedName || 'CommaFeed';
  const uid = `urn:commafeed:entry:${a.id}`;

  // Map image URLs -> files inside the EPUB.
  const imageFiles = [];
  const srcMap = new Map();
  for (const img of a.images || []) {
    const ext = EXT_BY_TYPE[img.type];
    if (!ext || srcMap.has(img.url)) continue;
    const name = `images/img${imageFiles.length + 1}.${ext}`;
    imageFiles.push({ name, type: img.type, data: img.data });
    srcMap.set(img.url, name);
  }
  const body = htmlToXhtml(a.html, {
    baseUrl: a.url,
    image: (src) => srcMap.get(src) || null,
  });

  const metaParts = [feedName, author, date.toISOString().slice(0, 10)].filter(Boolean);
  const chapter = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(lang)}" lang="${escapeXml(lang)}">
<head>
<meta charset="utf-8"/>
<title>${escapeXml(title)}</title>
<link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
<h1>${escapeXml(title)}</h1>
<p class="meta">${escapeXml(metaParts.join(' · '))}</p>
${body || '<p>(no content)</p>'}
${a.url ? `<hr/>\n<p class="source">Kaynak / Source: <a href="${escapeXml(a.url)}">${escapeXml(a.url)}</a></p>` : ''}
</body>
</html>`;

  const nav = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(lang)}">
<head><meta charset="utf-8"/><title>${escapeXml(title)}</title></head>
<body>
<nav epub:type="toc" id="toc"><h1>${escapeXml(title)}</h1>
<ol><li><a href="chapter.xhtml">${escapeXml(title)}</a></li></ol>
</nav>
</body>
</html>`;

  const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head>
<meta name="dtb:uid" content="${escapeXml(uid)}"/>
<meta name="dtb:depth" content="1"/>
<meta name="dtb:totalPageCount" content="0"/>
<meta name="dtb:maxPageNumber" content="0"/>
</head>
<docTitle><text>${escapeXml(title)}</text></docTitle>
<navMap>
<navPoint id="np1" playOrder="1"><navLabel><text>${escapeXml(title)}</text></navLabel><content src="chapter.xhtml"/></navPoint>
</navMap>
</ncx>`;

  const modified = date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const imageManifest = imageFiles
    .map((f, i) => `<item id="img${i + 1}" href="${f.name}" media-type="${f.type}"/>`)
    .join('\n');
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="${escapeXml(lang)}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">${escapeXml(uid)}</dc:identifier>
<dc:title>${escapeXml(title)}</dc:title>
<dc:creator>${escapeXml(creator)}</dc:creator>
<dc:language>${escapeXml(lang)}</dc:language>
<dc:date>${modified}</dc:date>
${feedName ? `<dc:publisher>${escapeXml(feedName)}</dc:publisher>` : ''}
${a.url ? `<dc:source>${escapeXml(a.url)}</dc:source>` : ''}
<meta property="dcterms:modified">${modified}</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="css" href="style.css" media-type="text/css"/>
<item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
${imageManifest}
</manifest>
<spine toc="ncx">
<itemref idref="chapter"/>
</spine>
</package>`;

  const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

  const files = [
    { name: 'mimetype', data: enc.encode('application/epub+zip') },
    { name: 'META-INF/container.xml', data: enc.encode(container) },
    { name: 'OEBPS/content.opf', data: enc.encode(opf) },
    { name: 'OEBPS/toc.ncx', data: enc.encode(ncx) },
    { name: 'OEBPS/nav.xhtml', data: enc.encode(nav) },
    { name: 'OEBPS/style.css', data: enc.encode(CSS) },
    { name: 'OEBPS/chapter.xhtml', data: enc.encode(chapter) },
    ...imageFiles.map((f) => ({ name: `OEBPS/${f.name}`, data: f.data })),
  ];
  return buildStoredZip(files, date);
}

/** Collect candidate image URLs from article HTML (in document order). */
export function collectImageUrls(html, baseUrl, max) {
  const urls = [];
  htmlToXhtml(html, {
    baseUrl,
    image: (src) => {
      if (urls.length < max && !urls.includes(src)) urls.push(src);
      return null;
    },
  });
  return urls;
}

/** ASCII-only, filesystem-safe slug for download file names. */
export function slugify(s, max = 60) {
  const tr = { ç: 'c', Ç: 'C', ğ: 'g', Ğ: 'G', ı: 'i', İ: 'I', ö: 'o', Ö: 'O', ş: 's', Ş: 'S', ü: 'u', Ü: 'U' };
  const ascii = String(s || '')
    .replace(/[çÇğĞıİöÖşŞüÜ]/g, (c) => tr[c])
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (ascii.slice(0, max).replace(/-+$/g, '') || 'article');
}
