// Offline smoke test: HTML -> XHTML conversion, EPUB packaging, OPDS feed XML.
// Run: node test/smoke.mjs [outDir]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { htmlToXhtml, textExcerpt, decodeEntities } from '../src/html.js';
import { buildEpub, slugify } from '../src/epub.js';
import { acquisitionFeed, navigationFeed } from '../src/opds.js';
import { crc32 } from '../src/zip.js';

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) failures++;
};

// crc32 reference: "123456789" -> 0xCBF43926
check('crc32 reference', crc32(new TextEncoder().encode('123456789')) === 0xcbf43926);

const nasty = `<p>Hello <b>world<i>nested</b></i> &amp; &nbsp; &copy; &#8212; &unknown; 5 < 6
<img src="//cdn.example.com/a.jpg" alt="A picture"><br><script>alert(1)</script>
<div class=x onclick="evil()">block <p>para inside div<p>second para
<ul><li>one<li>two <a href="/rel/path">rel link</a><li>three</ul>
<h2>Heading</h2>text after heading<iframe src="x"></iframe>
<table><tr><td>a<td>b<tr><td>c</table>
<pre>  code   with   spaces </pre>
<font color=red>font text</font> <custom-tag>custom</custom-tag> <!-- comment --> <![CDATA[ junk ]]>
<a href="javascript:alert(1)">js link</a> <a href="https://ok.example/x?a=1&b=2">ok</a>
<p>unclosed at end`;

const x = htmlToXhtml(nasty, { baseUrl: 'https://site.example/post/1', image: (src) => (src.endsWith('.jpg') ? 'images/img1.jpg' : null) });
console.log('--- xhtml output ---\n' + x + '\n--------------------');
check('no script', !/script|alert/.test(x));
check('no iframe', !/iframe/.test(x));
check('no event handlers', !/onclick/.test(x));
check('javascript: href dropped', !/javascript:/.test(x));
check('relative link resolved', x.includes('href="https://site.example/rel/path"'));
check('ampersand escaped in href', x.includes('a=1&amp;b=2'));
check('image mapped', x.includes('<img src="images/img1.jpg" alt="A picture"/>'));
check('br self-closed', x.includes('<br/>'));
check('entities decoded', x.includes('© —') && x.includes('&amp;unknown;'));
check('lt escaped', x.includes('5 &lt; 6'));
check('font/custom tags dropped, text kept', x.includes('font text') && x.includes('custom') && !/<font|custom-tag/.test(x));
check('comment/cdata removed', !/comment|junk/.test(x));

// Well-formedness via a strict XML parse: use a tiny tag-balance checker here;
// the PowerShell step in the test runner does a real XML parse.
function balanced(s) {
  const stack = [];
  const re = /<(\/?)([a-zA-Z0-9]+)[^>]*?(\/?)>/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[3] === '/') continue;
    if (m[1] === '/') { if (stack.pop() !== m[2]) return `mismatch at </${m[2]}>`; }
    else stack.push(m[2]);
  }
  return stack.length ? `unclosed ${stack.join(',')}` : '';
}
const bal = balanced(x);
check('tags balanced', bal === '', bal);
check('no empty paragraphs', !/<p>\s*<\/p>/.test(x));

check('decodeEntities numeric', decodeEntities('&#x1F600;&#65;') === '😀A');
check('excerpt', textExcerpt('<p>Hello <b>there</b> &amp; friends</p><p>x</p>', 100) === 'Hello there & friends x');
check('slugify turkish', slugify('Şişli’de Çağrı: İğne ve Öğüt!') === 'Sisli-de-Cagri-Igne-ve-Ogut');

const epub = buildEpub({
  id: '123',
  title: 'Test Yazısı: "Türkçe" & <tags>',
  author: 'Yazar',
  feedName: 'Örnek Kaynak',
  url: 'https://site.example/post/1',
  date: new Date('2026-10-20T10:00:00Z'),
  html: nasty,
  lang: 'tr',
  images: [{ url: 'https://cdn.example.com/a.jpg', type: 'image/jpeg', data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) }],
});
check('epub starts with PK\\3\\4', epub[0] === 0x50 && epub[1] === 0x4b && epub[2] === 3 && epub[3] === 4);
const head = new TextDecoder().decode(epub.slice(0, 80));
check('mimetype first and stored', head.includes('mimetypeapplication/epub+zip'));

const outDir = process.argv[2] || join(process.cwd(), '.test-out');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'sample.epub'), epub);
writeFileSync(join(outDir, 'sample.zip'), epub);
writeFileSync(join(outDir, 'chapter.xhtml'), x);

const acq = acquisitionFeed(
  { id: 'https://x.example/opds/unread', title: 'Unread', self: 'https://x.example/opds/unread', start: 'https://x.example/opds', up: 'https://x.example/opds', next: 'https://x.example/opds/unread?page=2', search: { description: 'https://x.example/opds/search.xml', template: 'https://x.example/opds/search?q={searchTerms}' } },
  [{ id: 'urn:commafeed:entry:1', title: 'A & B', feedName: 'Feed <1>', date: new Date(), summary: 'Sum "x"', epubHref: 'https://x.example/book/1/a-b.epub' }],
);
const nav = navigationFeed({ id: 'https://x.example/opds', title: 'Root', self: 'https://x.example/opds', start: 'https://x.example/opds' }, [{ title: 'Unread', href: 'https://x.example/opds/unread' }]);
writeFileSync(join(outDir, 'acq.xml'), acq);
writeFileSync(join(outDir, 'nav.xml'), nav);
check('acq feed has epub link', acq.includes('type="application/epub+zip"') && acq.includes('rel="http://opds-spec.org/acquisition"'));
check('acq feed escapes', acq.includes('<title>A &amp; B</title>') && acq.includes('Feed &lt;1&gt;'));

console.log(`\nwrote ${outDir}; ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
